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

func TestShareRequiresManager(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	mallory := apiClient(t, srv, "mallory@example.com")
	docID := createDoc(t, srv, alice)

	res := postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": "bob@example.com", "role": "editor"})
	res.Body.Close()

	// An editor cannot grant; an outsider cannot either. Editor is the rank
	// immediately below the bar, so this is the test that the bar did not slip
	// down a level when `manager` was inserted above it.
	for name, c := range map[string]*http.Client{"editor": bob, "outsider": mallory} {
		res := postJSON(t, c, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": "mallory@example.com", "role": "editor"})
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("%s could share: %d", name, res.StatusCode)
		}
		res.Body.Close()
	}

	// Nobody can change the owner's role — not even the owner. 403 rather than
	// the 409 this used to return: it is an authorisation refusal now, decided
	// by rank, not a conflict with some particular state.
	res = postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": "alice@example.com", "role": "viewer"})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("owner role change: %d, want 403", res.StatusCode)
	}
	res.Body.Close()

	// `owner` is not grantable at all: it moves only through /transfer, which
	// demotes the outgoing owner in the same transaction. Granting it here
	// would leave the document with two.
	res = postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": "bob@example.com", "role": "owner"})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("granting owner: %d, want 400", res.StatusCode)
	}
	res.Body.Close()
}

// The manager rank: what it may do, and the two things it may not. See
// DESIGN-DECISIONS.md, *Ownership: one owner, one deputy rank*.
func TestManagerPowersAndLimits(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com") // owner
	bob := apiClient(t, srv, "bob@example.com")     // manager
	carol := apiClient(t, srv, "carol@example.com") // second manager
	dave := apiClient(t, srv, "dave@example.com")   // editor
	docID := createDoc(t, srv, alice)

	res := postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": "bob@example.com", "role": "manager"})
	if res.StatusCode != 200 {
		t.Fatalf("grant manager: %d", res.StatusCode)
	}
	res.Body.Close()

	// A manager shares — the whole point of the rank. Granting a peer is
	// allowed: if it were not, only the owner could ever mint a manager and the
	// away-owner problem would be back the moment it mattered.
	for _, g := range []struct{ email, role string }{
		{"dave@example.com", "editor"},
		{"carol@example.com", "manager"},
	} {
		res = postJSON(t, bob, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": g.email, "role": g.role})
		if res.StatusCode != 200 {
			t.Fatalf("manager granting %s: %d", g.role, res.StatusCode)
		}
		res.Body.Close()
	}

	// ...and mints links, lists them, and deletes a version label.
	res = postJSON(t, bob, srv.URL+"/api/docs/"+docID+"/links", map[string]string{"role": "viewer"})
	if res.StatusCode != 200 {
		t.Fatalf("manager minting link: %d", res.StatusCode)
	}
	res.Body.Close()
	res, _ = bob.Get(srv.URL + "/api/docs/" + docID + "/links")
	if res.StatusCode != 200 {
		t.Fatalf("manager listing links: %d", res.StatusCode)
	}
	res.Body.Close()

	ids := shareIDs(t, srv, alice, docID)

	// But a manager cannot demote a peer, cannot touch the owner, and cannot
	// remove themselves. Creating a peer is recoverable by the owner; removing
	// one is not, which is why only that half is withheld.
	for name, target := range map[string]string{"peer": "carol@example.com", "owner": "alice@example.com", "self": "bob@example.com"} {
		res = postJSON(t, bob, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": target, "role": "viewer"})
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("manager demoting %s: %d, want 403", name, res.StatusCode)
		}
		res.Body.Close()

		req, _ := http.NewRequest("DELETE", srv.URL+"/api/docs/"+docID+"/shares/"+itoa(ids[target]), nil)
		res, err := bob.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("manager removing %s: %d, want 403", name, res.StatusCode)
		}
		res.Body.Close()
	}

	// A manager can remove somebody strictly below them.
	req, _ := http.NewRequest("DELETE", srv.URL+"/api/docs/"+docID+"/shares/"+itoa(ids["dave@example.com"]), nil)
	res, err := bob.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("manager removing editor: %v %d", err, res.StatusCode)
	}
	res.Body.Close()
	_ = dave

	// The two withheld powers. Delete is checked by rank now rather than by
	// name, so a manager gets the same 404 an outsider does.
	req, _ = http.NewRequest("DELETE", srv.URL+"/api/docs/"+docID, nil)
	res, err = bob.Do(req)
	if err != nil || res.StatusCode != http.StatusNotFound {
		t.Fatalf("manager deleting doc: %v %d, want 404", err, res.StatusCode)
	}
	res.Body.Close()

	res = postJSON(t, bob, srv.URL+"/api/docs/"+docID+"/transfer", map[string]int64{"user_id": ids["bob@example.com"]})
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("manager transferring: %d, want 404", res.StatusCode)
	}
	res.Body.Close()
	_ = carol
}

// A share link is a bearer token, so it must never carry `manager`. This is the
// hole that adding a rank above `editor` would have opened by itself: both link
// endpoints rejected `owner` by *name*.
func TestShareLinkCannotCarryManager(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)

	for _, role := range []string{"manager", "owner"} {
		res := postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/links", map[string]string{"role": role})
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("minting a %s link: %d, want 400", role, res.StatusCode)
		}
		res.Body.Close()
	}
}

func TestTransferOwnership(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	mallory := apiClient(t, srv, "mallory@example.com")
	docID := createDoc(t, srv, alice)

	ids := shareIDs(t, srv, alice, docID)

	// The target must already have access: transfer is a change of rank, not a
	// grant and a transfer at once.
	res := postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/transfer", map[string]int64{"user_id": 9999})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("transfer to a stranger: %d, want 400", res.StatusCode)
	}
	res.Body.Close()

	res = postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": "bob@example.com", "role": "viewer"})
	res.Body.Close()
	ids = shareIDs(t, srv, alice, docID)

	res = postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/transfer", map[string]int64{"user_id": ids["bob@example.com"]})
	if res.StatusCode != 200 {
		t.Fatalf("transfer: %d", res.StatusCode)
	}
	res.Body.Close()

	// Exactly one owner, and the outgoing one lands on manager rather than
	// editor — transfer means "you run this now", not "I am locked out".
	roles := map[string]string{}
	var shares []shareEntry
	res, _ = bob.Get(srv.URL + "/api/docs/" + docID + "/shares")
	json.NewDecoder(res.Body).Decode(&shares)
	res.Body.Close()
	for _, s := range shares {
		roles[s.Email] = s.Role
	}
	if roles["bob@example.com"] != "owner" || roles["alice@example.com"] != "manager" {
		t.Fatalf("after transfer: %v", roles)
	}

	// Alice can still manage, but the two owner powers are gone.
	req, _ := http.NewRequest("DELETE", srv.URL+"/api/docs/"+docID, nil)
	res, err := alice.Do(req)
	if err != nil || res.StatusCode != http.StatusNotFound {
		t.Fatalf("old owner deleting: %v %d, want 404", err, res.StatusCode)
	}
	res.Body.Close()

	res = postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": "mallory@example.com", "role": "viewer"})
	if res.StatusCode != 200 {
		t.Fatalf("old owner sharing as manager: %d", res.StatusCode)
	}
	res.Body.Close()
	_ = mallory

	// Transferring to yourself is refused rather than silently demoting you.
	res = postJSON(t, bob, srv.URL+"/api/docs/"+docID+"/transfer", map[string]int64{"user_id": ids["bob@example.com"]})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("self-transfer: %d, want 400", res.StatusCode)
	}
	res.Body.Close()
}

// The collaborator list comes back by rank, most to least, with people of the
// same rank by name. It used to be `ORDER BY p.role`, which was alphabetical
// and only looked deliberate — owner landed third of four by luck, and adding
// `manager` moved it.
func TestShareListIsRankOrdered(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)

	// Granted in an order that is neither the wanted one nor alphabetical, so
	// passing cannot be an accident of insertion order.
	for _, g := range []struct{ email, role string }{
		{"zoe@example.com", "viewer"},
		{"bob@example.com", "manager"},
		{"carol@example.com", "commenter"},
		{"dave@example.com", "editor"},
		{"adam@example.com", "manager"},
	} {
		apiClient(t, srv, g.email) // the account must exist to be shared with
		res := postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares", map[string]string{"email": g.email, "role": g.role})
		if res.StatusCode != 200 {
			t.Fatalf("grant %s: %d", g.role, res.StatusCode)
		}
		res.Body.Close()
	}

	res, _ := alice.Get(srv.URL + "/api/docs/" + docID + "/shares")
	var shares []shareEntry
	json.NewDecoder(res.Body).Decode(&shares)
	res.Body.Close()

	got := make([]string, len(shares))
	for i, s := range shares {
		got[i] = s.Role
	}
	want := []string{"owner", "manager", "manager", "editor", "commenter", "viewer"}
	if len(got) != len(want) {
		t.Fatalf("roles: %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("roles: %v, want %v", got, want)
		}
	}
	// The sort is stable, so equal ranks keep the query's name order.
	if shares[1].Email != "adam@example.com" || shares[2].Email != "bob@example.com" {
		t.Fatalf("equal ranks not left in name order: %s, %s", shares[1].Email, shares[2].Email)
	}
}

// email → user id for a document's collaborators.
func shareIDs(t *testing.T, srv *httptest.Server, c *http.Client, docID string) map[string]int64 {
	t.Helper()
	res, err := c.Get(srv.URL + "/api/docs/" + docID + "/shares")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var shares []shareEntry
	if err := json.NewDecoder(res.Body).Decode(&shares); err != nil {
		t.Fatal(err)
	}
	ids := map[string]int64{}
	for _, s := range shares {
		ids[s.Email] = s.UserID
	}
	return ids
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
	srv := httptest.NewServer(routes(db, newHub(db, nil), nil, nil, false, false))
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
// Renaming is an edit, so the bar is "may edit" — checked by rank rather than
// by naming the two roles that pass, which is what let `commenter` slip
// through three similar tests elsewhere.
func TestRenameNeedsEditAccess(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)

	rename := func(c *http.Client, title string) int {
		req, _ := http.NewRequest(http.MethodPatch, srv.URL+"/api/docs/"+docID,
			bytes.NewReader([]byte(`{"title":`+strconv.Quote(title)+`}`)))
		req.Header.Set("Content-Type", "application/json")
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}

	for _, tc := range []struct {
		role string
		want int
	}{
		{"viewer", http.StatusNotFound},
		{"commenter", http.StatusNotFound},
		{"editor", http.StatusOK},
	} {
		res := postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares",
			map[string]string{"email": "bob@example.com", "role": tc.role})
		res.Body.Close()
		if got := rename(bob, "renamed by a "+tc.role); got != tc.want {
			t.Fatalf("rename as %s: status %d, want %d", tc.role, got, tc.want)
		}
	}
	if got := rename(alice, "renamed by the owner"); got != http.StatusOK {
		t.Fatalf("owner could not rename: status %d", got)
	}
}
