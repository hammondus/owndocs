package main

import (
	"database/sql"
	"fmt"
	"log"
	"mime"
	"net/smtp"
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
// Exactly two events get an email, because they are the only two where the
// recipient is by definition *not* in the app to see a badge:
//
//   - You were mentioned. Somebody named you and is waiting.
//   - A document was shared with you. Otherwise it silently appears in a list
//     that person may never open, which is the one event with no in-app place
//     to discover it.
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

// Bounded on purpose. If the relay is down or slow, the right behaviour is to
// drop notifications with a log line rather than grow memory on a path that
// unauthenticated users can trigger.
const mailQueueSize = 256

type mailJob struct {
	to      string
	subject string
	body    string
}

type mailer struct {
	cfg mailConfig
	db  *sql.DB
	hub *hub
	q   chan mailJob

	mu     sync.Mutex
	recent map[string]time.Time // "<uid>:<docID>" -> last send

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
	key := fmt.Sprintf("%d:%s", uid, docID)
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if last, ok := m.recent[key]; ok && now.Sub(last) < mailDebounce {
		return false
	}
	// Swept here rather than on a timer, for the reason the login limiter
	// gives: there is no lifecycle to own and the work happens only when
	// something is happening anyway.
	for k, t := range m.recent {
		if now.Sub(t) > mailDebounce {
			delete(m.recent, k)
		}
	}
	m.recent[key] = now
	return true
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

// The link every message carries. Never a share-link token: those are bearer
// capabilities stored only as SHA-256, and mail is archived, forwarded and
// indexed. This points at the document and lets ordinary auth do its job.
func (m *mailer) docURL(docID string) string {
	return strings.TrimRight(m.cfg.BaseURL, "/") + "/#doc=" + docID
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

func roleVerb(role string) string {
	switch role {
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
