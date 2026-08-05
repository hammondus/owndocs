package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// awaitCommentNudge reads until the server says comments changed.
func awaitCommentNudge(t *testing.T, conn *websocket.Conn, who string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("%s never heard about the comment: %v", who, err)
		}
		if typ == websocket.MessageBinary && len(data) > 0 && data[0] == msgComments {
			return
		}
	}
}

func sendJSON(t *testing.T, c *http.Client, method, url string, body any) *http.Response {
	t.Helper()
	b, _ := json.Marshal(body)
	req, err := http.NewRequest(method, url, bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func share(t *testing.T, srv *httptest.Server, owner *http.Client, docID, email, role string) {
	t.Helper()
	res := postJSON(t, owner, srv.URL+"/api/docs/"+docID+"/shares",
		map[string]string{"email": email, "role": role})
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("share as %s: status %d", role, res.StatusCode)
	}
}

func listThreads(t *testing.T, srv *httptest.Server, c *http.Client, docID string) []commentThread {
	t.Helper()
	res, err := c.Get(srv.URL + "/api/docs/" + docID + "/comments")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("list comments: status %d", res.StatusCode)
	}
	var got []commentThread
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	return got
}

// openThread posts a new thread and returns its id.
func openThread(t *testing.T, srv *httptest.Server, c *http.Client, docID, body string) int64 {
	t.Helper()
	res := postJSON(t, c, srv.URL+"/api/docs/"+docID+"/comments",
		map[string]any{"anchor": []byte("anchor-bytes"), "body": body})
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("open thread: status %d", res.StatusCode)
	}
	var th commentThread
	if err := json.NewDecoder(res.Body).Decode(&th); err != nil {
		t.Fatal(err)
	}
	return th.ID
}

// The decision this whole design exists for: a commenter can write a comment
// and still cannot write a byte into the document.
func TestCommenterCannotWriteDocument(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	share(t, srv, alice, docID, "bob@example.com", "commenter")

	openThread(t, srv, bob, docID, "looks wrong to me")

	// Same user, same document, over the socket: rejected like a viewer.
	conn := dialWS(t, srv, bob, docID)
	readUntilSynced(t, conn)
	sendTyped(t, conn, msgDoc, []byte{1, 2})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := conn.Read(ctx); err != nil {
			return // closed, as it must be
		}
	}
}

// A viewer reads the conversation but cannot join it.
func TestViewerCannotComment(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	share(t, srv, alice, docID, "bob@example.com", "viewer")
	openThread(t, srv, alice, docID, "first")

	res := postJSON(t, bob, srv.URL+"/api/docs/"+docID+"/comments",
		map[string]any{"anchor": []byte("a"), "body": "me too"})
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("viewer could comment: status %d", res.StatusCode)
	}
	if got := listThreads(t, srv, bob, docID); len(got) != 1 {
		t.Fatalf("viewer should read %d threads, got %d", 1, len(got))
	}
}

// Authorship comes from the session, and there is no request field that could
// say otherwise — the property that in-doc storage could not provide.
func TestAuthorIsTheSessionUser(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	share(t, srv, alice, docID, "bob@example.com", "commenter")
	tid := openThread(t, srv, bob, docID, "bob's words")

	// An author_id in the body is not a field the decoder accepts at all.
	res := postJSON(t, bob, srv.URL+"/api/docs/"+docID+"/comments/"+strconv.FormatInt(tid, 10),
		map[string]any{"body": "again", "author_id": 1})
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("forged author field accepted: status %d", res.StatusCode)
	}

	threads := listThreads(t, srv, alice, docID)
	if len(threads) != 1 || len(threads[0].Comments) != 1 {
		t.Fatalf("want 1 thread with 1 comment, got %+v", threads)
	}
	if threads[0].Comments[0].AuthorName != "Test bob@example.com" {
		t.Fatalf("author is %q, want bob", threads[0].Comments[0].AuthorName)
	}
	if !bytes.Equal(threads[0].Anchor, []byte("anchor-bytes")) {
		t.Fatalf("anchor did not round-trip: %q", threads[0].Anchor)
	}
}

// A thread id is only meaningful inside its own document.
func TestThreadIDsDoNotCrossDocuments(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	a := createDoc(t, srv, alice)
	b := createDoc(t, srv, alice)
	tid := openThread(t, srv, alice, a, "in doc a")

	res := postJSON(t, alice, srv.URL+"/api/docs/"+b+"/comments/"+strconv.FormatInt(tid, 10),
		map[string]any{"body": "reply via the wrong document"})
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-document reply accepted: status %d", res.StatusCode)
	}
}

func TestResolveAndReopen(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)
	tid := openThread(t, srv, alice, docID, "question")
	path := srv.URL + "/api/docs/" + docID + "/comments/" + strconv.FormatInt(tid, 10)

	res := sendJSON(t, alice, http.MethodPatch, path, map[string]bool{"resolved": true})
	res.Body.Close()
	got := listThreads(t, srv, alice, docID)
	if got[0].ResolvedAt == nil || got[0].ResolvedBy == nil {
		t.Fatal("thread did not resolve")
	}

	res = sendJSON(t, alice, http.MethodPatch, path, map[string]bool{"resolved": false})
	res.Body.Close()
	got = listThreads(t, srv, alice, docID)
	if got[0].ResolvedAt != nil || got[0].ResolvedBy != nil {
		t.Fatal("thread did not reopen")
	}
}

// Moderation is deletion, never rewriting: an owner can remove another user's
// comment but cannot edit it into different words under their name.
func TestOwnerMayDeleteButNotEdit(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	share(t, srv, alice, docID, "bob@example.com", "commenter")
	tid := openThread(t, srv, bob, docID, "bob's words")

	cid := listThreads(t, srv, alice, docID)[0].Comments[0].ID
	base := srv.URL + "/api/docs/" + docID + "/comments/" +
		strconv.FormatInt(tid, 10) + "/" + strconv.FormatInt(cid, 10)

	res := sendJSON(t, alice, http.MethodPatch, base, map[string]string{"body": "words alice prefers"})
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("owner edited another user's comment: status %d", res.StatusCode)
	}

	res = sendJSON(t, alice, http.MethodDelete, base, nil)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("owner could not delete: status %d", res.StatusCode)
	}
	// Last comment gone, so the thread goes with it.
	if got := listThreads(t, srv, alice, docID); len(got) != 0 {
		t.Fatalf("empty thread survived: %+v", got)
	}
}

// A share link can raise access but never lower it.
func TestCommenterLinkNeverDemotes(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	share(t, srv, alice, docID, "bob@example.com", "editor")

	res := postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/links", map[string]string{"role": "commenter"})
	var link shareLink
	if err := json.NewDecoder(res.Body).Decode(&link); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	res = postJSON(t, bob, srv.URL+"/api/share/redeem", map[string]string{"token": link.Token})
	defer res.Body.Close()
	var d document
	if err := json.NewDecoder(res.Body).Decode(&d); err != nil {
		t.Fatal(err)
	}
	if d.Role != "editor" {
		t.Fatalf("editor demoted to %q by a commenter link", d.Role)
	}
}

// A comment written over HTTP reaches everyone watching the document, the
// author's own socket included — the room cannot tell which connection made
// the request, and a redundant refetch is cheaper than finding out.
func TestCommentChangeNotifiesWatchers(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	share(t, srv, alice, docID, "bob@example.com", "commenter")

	aConn, bConn := dialWS(t, srv, alice, docID), dialWS(t, srv, bob, docID)
	readUntilSynced(t, aConn)
	readUntilSynced(t, bConn)

	tid := openThread(t, srv, alice, docID, "first")
	awaitCommentNudge(t, aConn, "alice")
	awaitCommentNudge(t, bConn, "bob")

	// Every mutation nudges, not just thread creation.
	res := sendJSON(t, alice, http.MethodPatch,
		srv.URL+"/api/docs/"+docID+"/comments/"+strconv.FormatInt(tid, 10),
		map[string]bool{"resolved": true})
	res.Body.Close()
	awaitCommentNudge(t, bConn, "bob (resolve)")
}

// msgComments is server->client only. A peer sending one must not have it
// relayed, or anyone with write access could fabricate comment activity.
func TestForgedCommentNudgeIsNotRelayed(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	share(t, srv, alice, docID, "bob@example.com", "editor")

	aConn, bConn := dialWS(t, srv, alice, docID), dialWS(t, srv, bob, docID)
	readUntilSynced(t, aConn)
	readUntilSynced(t, bConn)

	// Forge, then send a legitimate update as a barrier: if the forgery were
	// relayed at all it would arrive at alice ahead of the update.
	sendTyped(t, bConn, msgComments, []byte{9, 9})
	sendTyped(t, bConn, msgDoc, []byte{1, 2})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		typ, data, err := aConn.Read(ctx)
		if err != nil {
			t.Fatalf("barrier update never arrived: %v", err)
		}
		if typ != websocket.MessageBinary {
			continue
		}
		if data[0] == msgComments {
			t.Fatal("a client's forged comment notification was relayed to peers")
		}
		if data[0] == msgDoc {
			return // barrier reached, nothing forged got through
		}
	}
}
