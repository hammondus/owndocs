package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func postJSON(t *testing.T, c *http.Client, url string, body any) *http.Response {
	t.Helper()
	b, _ := json.Marshal(body)
	res, err := c.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestShareGrantChangeRevoke(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)

	// Bob has no access yet.
	res, _ := bob.Get(srv.URL + "/api/docs/" + docID + "/shares")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("unshared doc visible to bob: %d", res.StatusCode)
	}
	res.Body.Close()

	// Alice grants editor; bob can now connect and write.
	res = postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": "bob@example.com", "role": "editor"})
	if res.StatusCode != 200 {
		t.Fatalf("share grant: %d", res.StatusCode)
	}
	res.Body.Close()

	conn := dialWS(t, srv, bob, docID)
	readUntilSynced(t, conn)
	sendTyped(t, conn, msgDoc, []byte{1, 2})

	// Downgrade to viewer: bob's live connection must be evicted.
	res = postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": "bob@example.com", "role": "viewer"})
	res.Body.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := conn.Read(ctx); err != nil {
			break // evicted
		}
	}

	// Reconnect as viewer: writes now refused.
	conn2 := dialWS(t, srv, bob, docID)
	readUntilSynced(t, conn2)
	sendTyped(t, conn2, msgDoc, []byte{3})
	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	_, _, err := conn2.Read(ctx2)
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("viewer write close status = %v, want policy violation", err)
	}

	// Revoke entirely: no dial at all.
	var bobID int64
	var shares []shareEntry
	res, _ = alice.Get(srv.URL + "/api/docs/" + docID + "/shares")
	json.NewDecoder(res.Body).Decode(&shares)
	res.Body.Close()
	for _, s := range shares {
		if s.Email == "bob@example.com" {
			bobID = s.UserID
		}
	}
	req, _ := http.NewRequest("DELETE", srv.URL+"/api/docs/"+docID+"/shares/"+itoa(bobID), nil)
	res, err = alice.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("revoke: %v %d", err, res.StatusCode)
	}
	res.Body.Close()
	ctx3, cancel3 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel3()
	if _, _, err := websocket.Dial(ctx3, srv.URL+"/ws/"+docID+"?v=2", &websocket.DialOptions{HTTPClient: bob}); err == nil {
		t.Fatal("revoked user could still dial")
	}
}

func TestShareRequiresOwner(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	mallory := apiClient(t, srv, "mallory@example.com")
	docID := createDoc(t, srv, alice)

	res := postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": "bob@example.com", "role": "editor"})
	res.Body.Close()

	// An editor cannot grant; an outsider cannot either.
	for name, c := range map[string]*http.Client{"editor": bob, "outsider": mallory} {
		res := postJSON(t, c, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": "mallory@example.com", "role": "editor"})
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("%s could share: %d", name, res.StatusCode)
		}
		res.Body.Close()
	}

	// Nobody can change the owner's role.
	res = postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": "alice@example.com", "role": "viewer"})
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("owner role change: %d, want 409", res.StatusCode)
	}
	res.Body.Close()
}

func TestShareLinkLifecycle(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)

	// Mint an editor link.
	res := postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/links", map[string]string{"role": "editor"})
	var link shareLink
	json.NewDecoder(res.Body).Decode(&link)
	res.Body.Close()
	if link.Token == "" {
		t.Fatal("no token returned at creation")
	}

	// Listing does not leak tokens.
	res, _ = alice.Get(srv.URL + "/api/docs/" + docID + "/links")
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if bytes.Contains(body, []byte(link.Token)) {
		t.Fatal("token leaked in link listing")
	}

	// Bob redeems and gets editor access.
	res = postJSON(t, bob, srv.URL+"/api/share/redeem", map[string]string{"token": link.Token})
	var d document
	json.NewDecoder(res.Body).Decode(&d)
	res.Body.Close()
	if d.ID != docID || d.Role != "editor" {
		t.Fatalf("redeem = %+v, want editor on %s", d, docID)
	}
	conn := dialWS(t, srv, bob, docID)
	readUntilSynced(t, conn)
	conn.Close(websocket.StatusNormalClosure, "")

	// Redeeming again as the owner must not downgrade.
	res = postJSON(t, alice, srv.URL+"/api/share/redeem", map[string]string{"token": link.Token})
	json.NewDecoder(res.Body).Decode(&d)
	res.Body.Close()
	if d.Role != "owner" {
		t.Fatalf("owner redeemed to role %q", d.Role)
	}

	// Revoke: future redemptions fail, bob's existing role survives.
	req, _ := http.NewRequest("DELETE", srv.URL+"/api/docs/"+docID+"/links/"+itoa(link.ID), nil)
	res, _ = alice.Do(req)
	res.Body.Close()
	carol := apiClient(t, srv, "carol@example.com")
	res = postJSON(t, carol, srv.URL+"/api/share/redeem", map[string]string{"token": link.Token})
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("revoked link redeemed: %d", res.StatusCode)
	}
	res.Body.Close()
	if role := mustRole(t, srv, bob, docID); role != "editor" {
		t.Fatalf("bob's role after link revoke = %q, want editor", role)
	}
}

func TestSignupClosed(t *testing.T) {
	db, err := openDB(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	srv := httptest.NewServer(routes(db, newHub(db, nil), nil, false))
	defer srv.Close()

	body, _ := json.Marshal(map[string]string{"email": "a@b.c", "name": "A", "password": "password123"})
	res, err := http.Post(srv.URL+"/api/signup", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("closed signup returned %d, want 403", res.StatusCode)
	}
}

// mustRole fetches the caller's role on a doc via the doc list.
func mustRole(t *testing.T, srv *httptest.Server, c *http.Client, docID string) string {
	t.Helper()
	res, err := c.Get(srv.URL + "/api/docs")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var docs []document
	json.NewDecoder(res.Body).Decode(&docs)
	for _, d := range docs {
		if d.ID == docID {
			return d.Role
		}
	}
	return ""
}

func itoa(n int64) string {
	return strconv.FormatInt(n, 10)
}