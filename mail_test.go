package main

import (
	"encoding/json"
	"net/smtp"
	"strings"
	"testing"
	"time"
)

// A mailer whose transport is captured rather than dialled. Everything that
// matters about this feature is decided before a socket would be opened —
// who gets a message, whether one is sent at all, and what it says — so the
// relay itself is the one part not worth a test.
func testMailer(t *testing.T) (*mailer, chan string) {
	t.Helper()
	sent := make(chan string, 16)
	m := &mailer{
		cfg:    mailConfig{Addr: "relay.invalid:587", From: "docs@example.com", BaseURL: "https://docs.example.com"},
		q:      make(chan mailJob, mailQueueSize),
		recent: map[string]time.Time{},
	}
	m.send = func(addr string, a smtp.Auth, from string, to []string, msg []byte) error {
		sent <- string(msg)
		return nil
	}
	go m.run()
	return m, sent
}

func waitMail(t *testing.T, sent chan string) string {
	t.Helper()
	select {
	case msg := <-sent:
		return msg
	case <-time.After(3 * time.Second):
		t.Fatal("no message was sent")
		return ""
	}
}

func noMail(t *testing.T, sent chan string) {
	t.Helper()
	select {
	case msg := <-sent:
		t.Fatalf("a message was sent that should not have been:\n%s", msg)
	case <-time.After(300 * time.Millisecond):
	}
}

// ---- the message itself ----------------------------------------------------

func TestMessageHeaders(t *testing.T) {
	m := &mailer{cfg: mailConfig{From: "docs@example.com", BaseURL: "https://docs.example.com"}}
	msg := m.message(mailJob{to: "bob@example.com", subject: "Alice mentioned you", body: "hello\n"})

	for _, want := range []string{
		"From: docs@example.com\r\n",
		"To: bob@example.com\r\n",
		"MIME-Version: 1.0\r\n",
		"Content-Type: text/plain; charset=utf-8\r\n",
		// Tells well-behaved autoresponders not to argue with a robot.
		"Auto-Submitted: auto-generated\r\n",
	} {
		if !strings.Contains(msg, want) {
			t.Fatalf("missing header %q in:\n%s", want, msg)
		}
	}
	// Headers end, body begins. A message without the blank line is malformed.
	if !strings.Contains(msg, "\r\n\r\nhello\n") {
		t.Fatalf("body is not separated from the headers:\n%s", msg)
	}
	if !strings.Contains(msg, "Message-ID: <") || !strings.Contains(msg, "example.com>") {
		t.Fatalf("no usable Message-ID:\n%s", msg)
	}
}

// A document title can hold anything, and a raw non-ASCII byte in a header is
// a malformed message — some relays reject it, others mangle it.
func TestNonASCIISubjectIsEncoded(t *testing.T) {
	m := &mailer{cfg: mailConfig{From: "docs@example.com"}}
	msg := m.message(mailJob{to: "b@e.com", subject: `Zoë shared "Prévisions"`, body: "x"})
	line := ""
	for _, l := range strings.Split(msg, "\r\n") {
		if strings.HasPrefix(l, "Subject:") {
			line = l
		}
	}
	if strings.Contains(line, "ë") || strings.Contains(line, "é") {
		t.Fatalf("raw non-ASCII in a header: %q", line)
	}
	if !strings.Contains(line, "=?utf-8?q?") {
		t.Fatalf("subject was not encoded: %q", line)
	}
}

// ---- who gets one, and when ------------------------------------------------

func TestDebouncePerUserAndDocument(t *testing.T) {
	m := &mailer{recent: map[string]time.Time{}}
	if !m.shouldSend(1, "docA") {
		t.Fatal("the first message was refused")
	}
	if m.shouldSend(1, "docA") {
		t.Fatal("a second message for the same person and document was allowed")
	}
	// A different document is a different conversation, and so is a different
	// person on the same one.
	if !m.shouldSend(1, "docB") {
		t.Fatal("another document was debounced against the first")
	}
	if !m.shouldSend(2, "docA") {
		t.Fatal("another person was debounced against the first")
	}
}

// Somebody with the document open can watch it happen; a mail about what is
// already on their screen is noise.
func TestPresentUsersAreSkipped(t *testing.T) {
	_, db, h := testServer(t)
	m := &mailer{db: db, hub: h, recent: map[string]time.Time{}}

	if !m.shouldSend(7, "doc1") {
		t.Fatal("an absent person was skipped")
	}
	// Put user 7 in the room, as a live socket would.
	rm := h.room("doc1")
	c := &client{userID: 7, send: make(chan []byte, 1)}
	rm.mu.Lock()
	rm.clients[c] = struct{}{}
	rm.mu.Unlock()

	if m.shouldSend(7, "doc1") {
		t.Fatal("a person watching the document was mailed anyway")
	}
	if !m.shouldSend(8, "doc1") {
		t.Fatal("somebody else in the same room was skipped")
	}
}

// A nil mailer is what an instance with no relay has, and every call site
// leans on it rather than testing for it.
func TestNilMailerIsSilentlyOff(t *testing.T) {
	var m *mailer
	m.mentioned("doc", []int64{1, 2}, 3, "body")
	m.shared("doc", 1, 2, "editor")
}

// ---- end to end, through the real handlers ---------------------------------

func TestSharedWithYouSendsMail(t *testing.T) {
	m, sent := testMailer(t)
	srv, _, _ := testServerWithMail(t, m)

	alice := apiClient(t, srv, "alice@example.com")
	apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares",
		map[string]string{"email": "bob@example.com", "role": "commenter"}).Body.Close()

	msg := waitMail(t, sent)
	if !strings.Contains(msg, "To: bob@example.com") {
		t.Fatalf("wrong recipient:\n%s", msg)
	}
	if !strings.Contains(msg, "comment on it") {
		t.Fatalf("the message does not say what the role grants:\n%s", msg)
	}
	if !strings.Contains(msg, "https://docs.example.com/#doc="+docID) {
		t.Fatalf("no link to the document:\n%s", msg)
	}
}

func TestMentionSendsMail(t *testing.T) {
	m, sent := testMailer(t)
	srv, _, _ := testServerWithMail(t, m)

	alice := apiClient(t, srv, "alice@example.com")
	apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares",
		map[string]string{"email": "bob@example.com", "role": "commenter"}).Body.Close()
	waitMail(t, sent) // the share notice, asserted above

	// Step past the debounce. Sharing and then mentioning inside five minutes
	// is deliberately one message — asserted below — but what is under test
	// here is what a mention *says*, so the window is cleared rather than
	// waited out.
	m.mu.Lock()
	m.recent = map[string]time.Time{}
	m.mu.Unlock()

	openThread(t, srv, alice, docID, "@Test bob@example.com the second column looks wrong")
	msg := waitMail(t, sent)

	if !strings.Contains(msg, "To: bob@example.com") {
		t.Fatalf("wrong recipient:\n%s", msg)
	}
	// The body can be quoted — comment bodies are stored in the clear so that
	// mentions can be resolved at all. What it is *about* cannot be said: the
	// quoted text lives inside the opaque anchor.
	if !strings.Contains(msg, "the second column looks wrong") {
		t.Fatalf("the comment was not quoted:\n%s", msg)
	}
	// The link is the document's own URL. Never a share-link token: those are
	// bearer capabilities stored only as SHA-256, and mail is archived,
	// forwarded and indexed.
	if !strings.Contains(msg, "https://docs.example.com/#doc="+docID) {
		t.Fatalf("no link to the document:\n%s", msg)
	}
	if strings.Contains(msg, "#share=") {
		t.Fatalf("a share token reached an email:\n%s", msg)
	}
}

// Two events on one document inside the window are one message. A share
// followed immediately by a mention is exactly the shape this exists for: it
// is one act by one person, and the inbox has both regardless.
func TestSecondEventInTheWindowIsCollapsed(t *testing.T) {
	m, sent := testMailer(t)
	srv, _, _ := testServerWithMail(t, m)

	alice := apiClient(t, srv, "alice@example.com")
	apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares",
		map[string]string{"email": "bob@example.com", "role": "commenter"}).Body.Close()
	waitMail(t, sent)

	openThread(t, srv, alice, docID, "@Test bob@example.com and one more thing")
	noMail(t, sent)
}

// Writing a comment is not news to its author, mention or no mention.
func TestSelfMentionSendsNothing(t *testing.T) {
	m, sent := testMailer(t)
	srv, _, _ := testServerWithMail(t, m)

	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)
	openThread(t, srv, alice, docID, "note to self, @Test alice@example.com")
	noMail(t, sent)
}

// A reply to a thread you are in is in the inbox and nothing more: it is not
// one of the two events, because nothing about a reply says you are being
// waited on.
func TestPlainReplySendsNothing(t *testing.T) {
	m, sent := testMailer(t)
	srv, _, _ := testServerWithMail(t, m)

	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares",
		map[string]string{"email": "bob@example.com", "role": "commenter"}).Body.Close()
	waitMail(t, sent) // the share notice

	tid := openThread(t, srv, alice, docID, "does this look right?")
	postJSON(t, bob, srv.URL+"/api/docs/"+docID+"/comments/"+itoa(tid),
		map[string]any{"body": "no, the second column is wrong"}).Body.Close()
	noMail(t, sent)
}

// Changing somebody's role on a document they already have is bookkeeping.
// Mailing it would train people to ignore the ones that matter.
func TestRoleChangeSendsNothing(t *testing.T) {
	m, sent := testMailer(t)
	srv, _, _ := testServerWithMail(t, m)

	alice := apiClient(t, srv, "alice@example.com")
	apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares",
		map[string]string{"email": "bob@example.com", "role": "viewer"}).Body.Close()
	waitMail(t, sent) // the first grant is news

	postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares",
		map[string]string{"email": "bob@example.com", "role": "editor"}).Body.Close()
	noMail(t, sent)
}

// ---- folders: every way of gaining access mails, by the same rules ---------

// A folder shared with you is one message naming the folder, however many
// documents are inside it.
func TestFolderSharedWithYouSendsOneMail(t *testing.T) {
	m, sent := testMailer(t)
	srv, _, _ := testServerWithMail(t, m)

	alice := apiClient(t, srv, "alice@example.com")
	apiClient(t, srv, "bob@example.com")
	fid := createFolder(t, srv, alice, "Runbooks", nil)
	docIn(t, srv, alice, fid)
	docIn(t, srv, alice, fid)
	shareFolder(t, srv, alice, fid, "bob@example.com", "editor").Body.Close()

	msg := waitMail(t, sent)
	if !strings.Contains(msg, "To: bob@example.com") {
		t.Fatalf("wrong recipient:\n%s", msg)
	}
	if !strings.Contains(msg, `the folder "Runbooks" with you. You can edit everything in it.`) {
		t.Fatalf("the message does not name the folder and the role:\n%s", msg)
	}
	if !strings.Contains(msg, "https://docs.example.com/#folder="+fid) {
		t.Fatalf("no link to the folder:\n%s", msg)
	}
	noMail(t, sent)

	// A role change on a folder somebody already reaches is bookkeeping.
	shareFolder(t, srv, alice, fid, "bob@example.com", "viewer").Body.Close()
	noMail(t, sent)
}

// Documents created in or moved into a folder reach everyone in it as one
// message per person per folder, listing the titles — a tidy-up that files
// several documents is one message, not one per document.
func TestFilingDocumentsIsOneDigestPerFolder(t *testing.T) {
	m, sent := testMailer(t)
	m.digestDelay = 50 * time.Millisecond
	srv, _, _ := testServerWithMail(t, m)

	alice := apiClient(t, srv, "alice@example.com")
	apiClient(t, srv, "bob@example.com")
	fid := createFolder(t, srv, alice, "Runbooks", nil)
	shareFolder(t, srv, alice, fid, "bob@example.com", "commenter").Body.Close()
	waitMail(t, sent) // the folder share

	// One created in the folder, two moved in.
	postJSON(t, alice, srv.URL+"/api/docs", map[string]any{"title": "Deploy guide", "folder_id": fid}).Body.Close()
	for _, title := range []string{"Rollback", "On call"} {
		res := postJSON(t, alice, srv.URL+"/api/docs", map[string]string{"title": title})
		var d document
		json.NewDecoder(res.Body).Decode(&d)
		res.Body.Close()
		postJSON(t, alice, srv.URL+"/api/docs/"+d.ID+"/move", map[string]string{"folder_id": fid}).Body.Close()
	}

	msg := waitMail(t, sent)
	if !strings.Contains(msg, "To: bob@example.com") {
		t.Fatalf("wrong recipient:\n%s", msg)
	}
	if !strings.Contains(msg, `added 3 documents to the folder "Runbooks"`) {
		t.Fatalf("three filings were not one message:\n%s", msg)
	}
	for _, title := range []string{"Deploy guide", "Rollback", "On call"} {
		if !strings.Contains(msg, "  - "+title+"\n") {
			t.Fatalf("the digest does not list %q:\n%s", title, msg)
		}
	}
	if !strings.Contains(msg, "which you can comment on") {
		t.Fatalf("the message does not say what the folder grants:\n%s", msg)
	}
	if !strings.Contains(msg, "https://docs.example.com/#folder="+fid) {
		t.Fatalf("no link to the folder:\n%s", msg)
	}
	// Alice filed them; the owner is never told about their own filing.
	noMail(t, sent)
}

// Somebody who could already see the document is not told it moved. A direct
// share and the folder move are, for them, the same document twice.
func TestFilingSkipsPeopleWhoAlreadyHadTheDocument(t *testing.T) {
	m, sent := testMailer(t)
	m.digestDelay = 50 * time.Millisecond
	srv, _, _ := testServerWithMail(t, m)

	alice := apiClient(t, srv, "alice@example.com")
	apiClient(t, srv, "bob@example.com")
	fid := createFolder(t, srv, alice, "Runbooks", nil)
	shareFolder(t, srv, alice, fid, "bob@example.com", "viewer").Body.Close()
	waitMail(t, sent)

	docID := createDoc(t, srv, alice)
	postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares",
		map[string]string{"email": "bob@example.com", "role": "editor"}).Body.Close()
	waitMail(t, sent) // the direct share

	postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/move", map[string]string{"folder_id": fid}).Body.Close()
	noMail(t, sent)
}

// Moving a folder into another is a share of everything under it with the
// destination's people — one message each, naming both folders.
func TestMovingAFolderMailsTheDestinationsPeople(t *testing.T) {
	m, sent := testMailer(t)
	srv, _, _ := testServerWithMail(t, m)

	alice := apiClient(t, srv, "alice@example.com")
	apiClient(t, srv, "bob@example.com")
	eng := createFolder(t, srv, alice, "Engineering", nil)
	runbooks := createFolder(t, srv, alice, "Runbooks", nil)
	shareFolder(t, srv, alice, eng, "bob@example.com", "editor").Body.Close()
	waitMail(t, sent)

	reqJSON(t, alice, "POST", srv.URL+"/api/folders/"+runbooks+"/move", map[string]string{"parent_id": eng}).Body.Close()
	msg := waitMail(t, sent)
	if !strings.Contains(msg, "To: bob@example.com") {
		t.Fatalf("wrong recipient:\n%s", msg)
	}
	if !strings.Contains(msg, `moved the folder "Runbooks" into "Engineering", so you can now edit everything in it`) {
		t.Fatalf("the message does not say what moved where:\n%s", msg)
	}
	if !strings.Contains(msg, "https://docs.example.com/#folder="+runbooks) {
		t.Fatalf("no link to the moved folder:\n%s", msg)
	}

	// Moving it back out to the top tells nobody: access was withdrawn, not
	// granted, and only a grant is news.
	reqJSON(t, alice, "POST", srv.URL+"/api/folders/"+runbooks+"/move", map[string]any{"parent_id": nil}).Body.Close()
	noMail(t, sent)
}

func TestNilMailerIsOffForFolderEventsToo(t *testing.T) {
	var m *mailer
	m.folderShared("f", 1, 2, "editor")
	m.folderMoved("f", "g", []int64{1}, 2)
	m.filed("d", "f", []int64{1}, 2)
}
