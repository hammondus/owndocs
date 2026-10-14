package main

import (
	"cmp"
	"database/sql"
	"fmt"
	"log"
	"maps"
	"mime"
	"net/smtp"
	"slices"
	"strings"
	"sync"
	"time"
)

// Email notifications. The second half of *Notifications* in
// DESIGN-DECISIONS.md; the in-app inbox is the first and shipped without it.
//
// **Submission only, to a relay that already exists.** This app never touches
// SPF, DKIM, DMARC, reputation or bounces, and it must not grow a queue
// pretending otherwise: one worker, a bounded channel, and a log line when a
// send fails. If mail matters more than that, the relay is where to fix it.
//
// **Unset config means off, not broken.** A nil *mailer answers every method,
// so call sites stay unconditional and an instance with no relay behaves
// exactly as it did before this file existed.
//
// Two kinds of event get an email, because they are the only ones where the
// recipient is by definition *not* in the app to see a badge:
//
//   - You were mentioned. Somebody named you and is waiting.
//   - You gained access to something. Otherwise it silently appears in a list
//     that person may never open, which is the one event with no in-app place
//     to discover it.
//
// The second kind arrives five ways, and every one of them mails, by the same
// rules — a document shared with you directly, a folder shared with you, a
// document created in or moved into a folder you are in, and a folder moved
// into one you are in. The unit is the thing that was shared: a folder share
// is one message naming the folder, not one per document inside it, and
// documents filed into a folder are held for a couple of minutes and sent as
// one message per person per folder. See DESIGN-DECISIONS.md, *Notifying the
// destination*.
//
// Never emailed: comments on a document you merely own (ownership is not
// interest, and an active document is a firehose), a thread being resolved
// (that is closure — nothing waits on you), and anything you did yourself.

type mailConfig struct {
	Addr    string // host:port of the submission relay; empty disables mail
	From    string // envelope and header From
	BaseURL string // public origin, for the one link each message carries
	User    string // PLAIN credentials; empty means an unauthenticated relay
	Pass    string
}

// How long one (person, document) pair stays quiet after a send. A thread
// during a live session is one conversation, not N events — and the inbox has
// every one of them regardless, so nothing is lost by not mailing each.
const mailDebounce = 5 * time.Minute

// How long documents filed into one folder are held before one message per
// (person, folder) goes out listing them. Long enough that a tidy-up filing
// twenty documents is one message; short enough that a single document does
// not look lost. The hold is in memory, so a restart drops it — the same
// trade the bounded queue below makes, for the same reason.
const mailDigestDelay = 2 * time.Minute

// Bounded on purpose. If the relay is down or slow, the right behaviour is to
// drop notifications with a log line rather than grow memory on a path that
// unauthenticated users can trigger.
const mailQueueSize = 256

type mailJob struct {
	to      string
	subject string
	body    string
}

// folderDigest is one person's pending "documents were added to a folder"
// message. Keyed by (person, folder) in mailer.pending, and flushed once by
// the timer started when it was created.
type folderDigest struct {
	uid      int64
	folderID string
	actors   []string // in first-seen order; a tidy-up is usually one person
	titles   []string
}

type mailer struct {
	cfg mailConfig
	db  *sql.DB
	hub *hub
	q   chan mailJob

	mu      sync.Mutex
	recent  map[string]time.Time     // debounce key -> last send
	pending map[string]*folderDigest // "<uid>:folder:<folderID>" -> held digest

	// Zero means mailDigestDelay. A field so tests can shorten the hold.
	digestDelay time.Duration

	// Injected so tests can capture messages without a relay. Defaults to
	// smtp.SendMail, which negotiates STARTTLS when the server advertises it.
	send func(addr string, a smtp.Auth, from string, to []string, msg []byte) error
}

func newMailer(cfg mailConfig, db *sql.DB, h *hub) *mailer {
	if cfg.Addr == "" {
		return nil
	}
	m := &mailer{
		cfg: cfg, db: db, hub: h,
		q:      make(chan mailJob, mailQueueSize),
		recent: map[string]time.Time{},
		send:   smtp.SendMail,
	}
	go m.run()
	return m
}

func (m *mailer) run() {
	for job := range m.q {
		if err := m.deliver(job); err != nil {
			// A failed send is not a failed anything else. The inbox already
			// has the notification; this is the copy that goes to a mailbox.
			log.Printf("mail: sending to %s failed: %v", job.to, err)
		}
	}
}

func (m *mailer) deliver(job mailJob) error {
	var auth smtp.Auth
	if m.cfg.User != "" {
		host := m.cfg.Addr
		if i := strings.LastIndex(host, ":"); i > 0 {
			host = host[:i]
		}
		auth = smtp.PlainAuth("", m.cfg.User, m.cfg.Pass, host)
	}
	return m.send(m.cfg.Addr, auth, m.cfg.From, []string{job.to}, []byte(m.message(job)))
}

// A message, headers and all. Hand-built rather than templated: it is six
// headers and a paragraph, and a dependency for that would be silly.
func (m *mailer) message(job mailJob) string {
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", m.cfg.From)
	fmt.Fprintf(&b, "To: %s\r\n", job.to)
	// Q-encoded, because a document title can hold anything and a raw
	// non-ASCII byte in a header is a malformed message.
	fmt.Fprintf(&b, "Subject: %s\r\n", mime.QEncoding.Encode("utf-8", job.subject))
	fmt.Fprintf(&b, "Date: %s\r\n", time.Now().Format(time.RFC1123Z))
	fmt.Fprintf(&b, "Message-ID: <%d.%s>\r\n", time.Now().UnixNano(), domainOf(m.cfg.From))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	// Tells well-behaved autoresponders not to reply to this.
	b.WriteString("Auto-Submitted: auto-generated\r\n")
	b.WriteString("\r\n")
	b.WriteString(job.body)
	return b.String()
}

func domainOf(addr string) string {
	if i := strings.LastIndex(addr, "@"); i >= 0 {
		return strings.Trim(addr[i+1:], "<> ")
	}
	return "owndocs.invalid"
}

// queue drops the job rather than blocking when the relay is behind. The
// alternative is an unbounded buffer on a path a signed-in user can drive.
func (m *mailer) queue(job mailJob) {
	select {
	case m.q <- job:
	default:
		log.Printf("mail: queue full, dropping notification to %s", job.to)
	}
}

// shouldSend applies the two rules that keep this signal, both of which are
// email-only — the inbox deliberately records everything.
//
//   - **Skip anyone connected to that document right now.** They can watch it
//     happen; a mail about something on their screen is noise.
//   - **Debounce per (person, document).** One conversation, not N events.
func (m *mailer) shouldSend(uid int64, docID string) bool {
	if m.hub != nil && m.hub.hasUser(docID, uid) {
		return false
	}
	return m.allow(fmt.Sprintf("%d:%s", uid, docID))
}

// allow is the debounce on its own, for the folder events: a folder has no
// room, so there is nobody "connected to" it to skip. Each key is a (person,
// thing) pair and the window is the same one documents use.
func (m *mailer) allow(key string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if last, ok := m.recent[key]; ok && now.Sub(last) < mailDebounce {
		return false
	}
	// Swept here rather than on a timer, for the reason the login limiter
	// gives: there is no lifecycle to own and the work happens only when
	// something is happening anyway.
	maps.DeleteFunc(m.recent, func(_ string, t time.Time) bool { return now.Sub(t) > mailDebounce })
	m.recent[key] = now
	return true
}

func folderKey(uid int64, folderID string) string {
	return fmt.Sprintf("%d:folder:%s", uid, folderID)
}

// A person's name and address, or ok=false if they have gone.
func (m *mailer) person(uid int64) (name, email string, ok bool) {
	err := m.db.QueryRow("SELECT name, email FROM users WHERE id = ?", uid).Scan(&name, &email)
	return name, email, err == nil
}

func (m *mailer) docTitle(docID string) string {
	var t string
	if err := m.db.QueryRow("SELECT title FROM documents WHERE id = ?", docID).Scan(&t); err != nil {
		return "a document"
	}
	return t
}

func (m *mailer) folderName(folderID string) string {
	var n string
	if err := m.db.QueryRow("SELECT name FROM folders WHERE id = ?", folderID).Scan(&n); err != nil {
		return "a folder"
	}
	return n
}

// The link every message carries. Never a share-link token: those are bearer
// capabilities stored only as SHA-256, and mail is archived, forwarded and
// indexed. This points at the document and lets ordinary auth do its job.
func (m *mailer) docURL(docID string) string {
	return strings.TrimRight(m.cfg.BaseURL, "/") + "/#doc=" + docID
}

// A folder's link opens the document list with that folder in view — the
// same route the breadcrumb and a folder search hit use.
func (m *mailer) folderURL(folderID string) string {
	return strings.TrimRight(m.cfg.BaseURL, "/") + "/#folder=" + folderID
}

// mentioned emails the people a comment named. Called after the comment is
// committed, off the request path.
//
// The comment *body* can be included — bodies are stored in the clear so that
// mentions can be resolved at all — but never what the comment is about, since
// the quoted text lives inside the opaque anchor. So this says what was said
// and cannot say what it was said about. That is the content-blind design
// working, and it is why these are pointers into the app rather than
// substitutes for opening it.
func (m *mailer) mentioned(docID string, recipients []int64, actorID int64, body string) {
	if m == nil || len(recipients) == 0 {
		return
	}
	go func() {
		actor, _, ok := m.person(actorID)
		if !ok {
			return
		}
		title := m.docTitle(docID)
		for _, uid := range recipients {
			if uid == actorID || !m.shouldSend(uid, docID) {
				continue
			}
			name, email, ok := m.person(uid)
			if !ok || email == "" {
				continue
			}
			m.queue(mailJob{
				to:      email,
				subject: fmt.Sprintf("%s mentioned you in %q", actor, title),
				body: fmt.Sprintf(
					"Hello %s,\n\n%s mentioned you in a comment on %q:\n\n  %s\n\nOpen it: %s\n",
					name, actor, title, oneLine(body, 500), m.docURL(docID)),
			})
		}
	}()
}

// shared emails somebody a document was just given to. The only one of the two
// events that is not a comment feature at all: without it a document appears
// in a list the recipient may never open again.
func (m *mailer) shared(docID string, recipient, actorID int64, role string) {
	if m == nil || recipient == actorID {
		return
	}
	go func() {
		if !m.shouldSend(recipient, docID) {
			return
		}
		actor, _, ok := m.person(actorID)
		if !ok {
			return
		}
		name, email, ok := m.person(recipient)
		if !ok || email == "" {
			return
		}
		title := m.docTitle(docID)
		m.queue(mailJob{
			to:      email,
			subject: fmt.Sprintf("%s shared %q with you", actor, title),
			body: fmt.Sprintf(
				"Hello %s,\n\n%s shared %q with you. You can %s it.\n\nOpen it: %s\n",
				name, actor, title, roleVerb(role), m.docURL(docID)),
		})
	}()
}

// folderShared emails somebody a folder was just given to. One message naming
// the folder, however many documents are inside: the folder is what was
// shared, and a message per document would bury that under its own contents.
func (m *mailer) folderShared(folderID string, recipient, actorID int64, role string) {
	if m == nil || recipient == actorID {
		return
	}
	go func() {
		if !m.allow(folderKey(recipient, folderID)) {
			return
		}
		actor, _, ok := m.person(actorID)
		if !ok {
			return
		}
		name, email, ok := m.person(recipient)
		if !ok || email == "" {
			return
		}
		folder := m.folderName(folderID)
		m.queue(mailJob{
			to:      email,
			subject: fmt.Sprintf("%s shared the folder %q with you", actor, folder),
			body: fmt.Sprintf(
				"Hello %s,\n\n%s shared the folder %q with you. You can %s everything in it.\n\nOpen it: %s\n",
				name, actor, folder, roleVerb(role), m.folderURL(folderID)),
		})
	}()
}

// folderMoved emails the people who can now see a folder because it was moved
// into one they are in. The recipients are worked out by the handler before
// the move, since afterwards everyone in the destination has access and the
// newcomers are no longer tellable from the rest.
func (m *mailer) folderMoved(folderID, destID string, recipients []int64, actorID int64) {
	if m == nil || len(recipients) == 0 {
		return
	}
	go func() {
		actor, _, ok := m.person(actorID)
		if !ok {
			return
		}
		folder, dest := m.folderName(folderID), m.folderName(destID)
		for _, uid := range recipients {
			if uid == actorID || !m.allow(folderKey(uid, folderID)) {
				continue
			}
			name, email, ok := m.person(uid)
			if !ok || email == "" {
				continue
			}
			role, _ := folderRoleFor(m.db, folderID, uid)
			m.queue(mailJob{
				to:      email,
				subject: fmt.Sprintf("%s moved the folder %q into %q", actor, folder, dest),
				body: fmt.Sprintf(
					"Hello %s,\n\n%s moved the folder %q into %q, so you can now %s everything in it.\n\nOpen it: %s\n",
					name, actor, folder, dest, roleVerb(role), m.folderURL(folderID)),
			})
		}
	}()
}

// filed records that a document was created in or moved into a folder, for
// the people in that folder who could not see the document before. Nothing
// is sent yet: each recipient's pending digest for this folder gains a title,
// and the first title starts the timer that sends it. See mailDigestDelay.
//
// Two rules documents already follow apply per document, at the moment it is
// filed: somebody with it open right now is not told about it, and a document
// they were mailed about in the last few minutes — a direct share, say — is
// not listed again.
func (m *mailer) filed(docID, folderID string, recipients []int64, actorID int64) {
	if m == nil || len(recipients) == 0 {
		return
	}
	go func() {
		actor, _, ok := m.person(actorID)
		if !ok {
			return
		}
		title := m.docTitle(docID)
		for _, uid := range recipients {
			if uid == actorID || !m.shouldSend(uid, docID) {
				continue
			}
			key := folderKey(uid, folderID)
			m.mu.Lock()
			d := m.pending[key]
			if d == nil {
				if m.pending == nil {
					m.pending = map[string]*folderDigest{}
				}
				d = &folderDigest{uid: uid, folderID: folderID}
				m.pending[key] = d
				time.AfterFunc(cmp.Or(m.digestDelay, mailDigestDelay), func() { m.flush(key) })
			}
			if !slices.Contains(d.actors, actor) {
				d.actors = append(d.actors, actor)
			}
			d.titles = append(d.titles, title)
			m.mu.Unlock()
		}
	}()
}

// flush sends one held digest. Called by its timer, once.
func (m *mailer) flush(key string) {
	m.mu.Lock()
	d := m.pending[key]
	delete(m.pending, key)
	m.mu.Unlock()
	if d == nil {
		return
	}
	name, email, ok := m.person(d.uid)
	if !ok || email == "" {
		return
	}
	folder := m.folderName(d.folderID)
	role, _ := folderRoleFor(m.db, d.folderID, d.uid)
	who := d.actors[0]
	if len(d.actors) > 1 {
		who += " and others"
	}
	var subject string
	if len(d.titles) == 1 {
		subject = fmt.Sprintf("%s added %q to the folder %q", who, d.titles[0], folder)
	} else {
		subject = fmt.Sprintf("%s added %d documents to the folder %q", who, len(d.titles), folder)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Hello %s,\n\n%s added to the folder %q, which you can %s:\n\n", name, who, folder, roleVerb(role))
	for _, t := range d.titles {
		fmt.Fprintf(&b, "  - %s\n", t)
	}
	fmt.Fprintf(&b, "\nOpen the folder: %s\n", m.folderURL(d.folderID))
	m.queue(mailJob{to: email, subject: subject, body: b.String()})
}

func roleVerb(role string) string {
	switch role {
	// A manager's mail must not say "read": the default arm is a floor for
	// roles that grant less, and a new level lands above editor, not below it.
	case "manager":
		return "edit and share"
	case "editor":
		return "edit"
	case "commenter":
		return "comment on"
	default:
		return "read"
	}
}

// A comment body flattened for a mail. Newlines would break the indent and a
// long comment belongs in the app, which the link goes to.
func oneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}
