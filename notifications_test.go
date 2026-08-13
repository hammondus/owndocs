package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The inbox as its owner sees it. Everything here asserts through the endpoint
// rather than the table, because the endpoint carries a boundary the table does
// not: a notification quotes a comment body, so it must stop being readable the
// moment access to its document is revoked.
func inbox(t *testing.T, srv *httptest.Server, c *http.Client) []notification {
	t.Helper()
	res, err := c.Get(srv.URL + "/api/notifications")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out []notification
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

// Alice owns a document, Bob has a role on it, and both are named so mentions
// can resolve. apiClient signs up as "Test <email>", which is the name a
// mention has to match.
func twoPeople(t *testing.T, role string) (*httptest.Server, *http.Client, *http.Client, string) {
	t.Helper()
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares",
		map[string]string{"email": "bob@example.com", "role": role}).Body.Close()
	return srv, alice, bob, docID
}

func TestMentionNotifiesTheNamedPersonOnly(t *testing.T) {
	srv, alice, bob, docID := twoPeople(t, "commenter")

	openThread(t, srv, alice, docID, "@Test bob@example.com please look at this")

	got := inbox(t, srv, bob)
	if len(got) != 1 {
		t.Fatalf("bob has %d notifications, want 1", len(got))
	}
	if got[0].Kind != "mention" {
		t.Fatalf("kind = %q, want mention", got[0].Kind)
	}
	if got[0].Actor != "Test alice@example.com" {
		t.Fatalf("actor = %q", got[0].Actor)
	}
	if got[0].ReadAt != nil {
		t.Fatal("a new notification is already read")
	}

	// Writing a comment is not news to its author, mention or no mention.
	if n := inbox(t, srv, alice); len(n) != 0 {
		t.Fatalf("alice notified herself: %d rows", len(n))
	}
}

func TestSelfMentionNotifiesNobody(t *testing.T) {
	srv, alice, _, docID := twoPeople(t, "commenter")
	openThread(t, srv, alice, docID, "note to self, @Test alice@example.com")
	if n := inbox(t, srv, alice); len(n) != 0 {
		t.Fatalf("self-mention produced %d rows", len(n))
	}
}

func TestReplyNotifiesTheEarlierParticipants(t *testing.T) {
	srv, alice, bob, docID := twoPeople(t, "commenter")

	// Alice opens, naming nobody: no notification yet, since nobody else has
	// spoken in the thread.
	tid := openThread(t, srv, alice, docID, "does this look right?")
	if n := inbox(t, srv, bob); len(n) != 0 {
		t.Fatalf("a thread with no mention notified bob: %d rows", len(n))
	}

	// Bob replies. Alice is in the thread, so she hears about it.
	postJSON(t, bob, srv.URL+"/api/docs/"+docID+"/comments/"+itoa(tid),
		map[string]any{"body": "no, the second column is wrong"}).Body.Close()

	got := inbox(t, srv, alice)
	if len(got) != 1 || got[0].Kind != "reply" {
		t.Fatalf("alice's inbox = %+v, want one reply", got)
	}
	if got[0].ThreadID != tid {
		t.Fatalf("thread_id = %d, want %d", got[0].ThreadID, tid)
	}
}

// Somebody both named and already in the thread gets one row, and it is the
// mention — that is the one saying they are being waited on.
func TestMentionBeatsReplyForTheSamePerson(t *testing.T) {
	srv, alice, bob, docID := twoPeople(t, "commenter")
	tid := openThread(t, srv, alice, docID, "does this look right?")
	postJSON(t, bob, srv.URL+"/api/docs/"+docID+"/comments/"+itoa(tid),
		map[string]any{"body": "@Test alice@example.com yes, but see the second column"}).Body.Close()

	got := inbox(t, srv, alice)
	if len(got) != 1 {
		t.Fatalf("alice has %d notifications, want 1", len(got))
	}
	if got[0].Kind != "mention" {
		t.Fatalf("kind = %q, want mention to win over reply", got[0].Kind)
	}
}

// The boundary. A notification quotes a comment body, so losing access to the
// document has to take the inbox entry with it — otherwise revocation leaves a
// readable copy of every comment behind.
func TestRevokedAccessHidesTheInbox(t *testing.T) {
	srv, alice, bob, docID := twoPeople(t, "commenter")
	openThread(t, srv, alice, docID, "@Test bob@example.com have a look")
	if n := inbox(t, srv, bob); len(n) != 1 {
		t.Fatalf("setup: bob has %d notifications, want 1", len(n))
	}

	var uid int64
	res, _ := alice.Get(srv.URL + "/api/docs/" + docID + "/shares")
	var shares []shareEntry
	json.NewDecoder(res.Body).Decode(&shares)
	res.Body.Close()
	for _, s := range shares {
		if s.Email == "bob@example.com" {
			uid = s.UserID
		}
	}
	req, _ := http.NewRequest(http.MethodDelete,
		srv.URL+"/api/docs/"+docID+"/shares/"+itoa(uid), nil)
	if r, err := alice.Do(req); err == nil {
		r.Body.Close()
	}

	if n := inbox(t, srv, bob); len(n) != 0 {
		t.Fatalf("revoked bob can still read %d notifications", len(n))
	}
}

// Deleting the document must take the notifications with it, or the inbox goes
// on offering to open something that is gone.
func TestDeletingTheDocumentClearsTheInbox(t *testing.T) {
	srv, alice, bob, docID := twoPeople(t, "commenter")
	openThread(t, srv, alice, docID, "@Test bob@example.com have a look")

	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/docs/"+docID, nil)
	if r, err := alice.Do(req); err == nil {
		r.Body.Close()
	}
	if n := inbox(t, srv, bob); len(n) != 0 {
		t.Fatalf("%d notifications survived the document", len(n))
	}
}

func TestMarkingRead(t *testing.T) {
	srv, alice, bob, docID := twoPeople(t, "commenter")
	openThread(t, srv, alice, docID, "@Test bob@example.com one")
	openThread(t, srv, alice, docID, "@Test bob@example.com two")

	got := inbox(t, srv, bob)
	if len(got) != 2 {
		t.Fatalf("bob has %d notifications, want 2", len(got))
	}

	// One at a time, which a high-water mark could not express.
	postJSON(t, bob, srv.URL+"/api/notifications/read",
		map[string]any{"ids": []int64{got[0].ID}}).Body.Close()
	after := inbox(t, srv, bob)
	if after[0].ReadAt == nil || after[1].ReadAt != nil {
		t.Fatalf("marking one read did not leave the other unread: %+v", after)
	}

	// And the rest.
	postJSON(t, bob, srv.URL+"/api/notifications/read", map[string]any{}).Body.Close()
	for _, n := range inbox(t, srv, bob) {
		if n.ReadAt == nil {
			t.Fatalf("notification %d still unread", n.ID)
		}
	}
}

// Somebody else's notification id is not an object the caller may touch.
func TestCannotMarkAnotherPersonsNotificationRead(t *testing.T) {
	srv, alice, bob, docID := twoPeople(t, "commenter")
	openThread(t, srv, alice, docID, "@Test bob@example.com look")
	got := inbox(t, srv, bob)

	postJSON(t, alice, srv.URL+"/api/notifications/read",
		map[string]any{"ids": []int64{got[0].ID}}).Body.Close()
	if after := inbox(t, srv, bob); after[0].ReadAt != nil {
		t.Fatal("alice marked bob's notification read")
	}
}

// The document list carries the unresolved count, so the list does not need one
// request per row to show it.
func TestOpenCommentCountInTheDocumentList(t *testing.T) {
	srv, alice, _, docID := twoPeople(t, "commenter")
	if d := docByID(t, srv, alice, docID); d.OpenComments != 0 {
		t.Fatalf("a new document has %d open comments", d.OpenComments)
	}

	tid := openThread(t, srv, alice, docID, "one")
	openThread(t, srv, alice, docID, "two")
	if d := docByID(t, srv, alice, docID); d.OpenComments != 2 {
		t.Fatalf("open comments = %d, want 2", d.OpenComments)
	}

	patchDoc(t, alice, srv.URL+"/api/docs/"+docID+"/comments/"+itoa(tid),
		map[string]any{"resolved": true}).Body.Close()
	if d := docByID(t, srv, alice, docID); d.OpenComments != 1 {
		t.Fatalf("open comments after resolving = %d, want 1", d.OpenComments)
	}
}
