package main

import (
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
