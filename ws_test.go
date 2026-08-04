package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
)

// testServer wires the full stack (routes + hub + sqlite) onto httptest.
func testServer(t *testing.T) (*httptest.Server, *sql.DB, *hub) {
	t.Helper()
	db, err := openDB(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	h := newHub(db)
	static := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<!doctype html>test")}}
	srv := httptest.NewServer(routes(db, h, static))
	t.Cleanup(srv.Close)
	return srv, db, h
}

// apiClient is an http client with a cookie jar, signed up as a fresh user.
func apiClient(t *testing.T, srv *httptest.Server, email string) *http.Client {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	body, _ := json.Marshal(map[string]string{"email": email, "name": "Test " + email, "password": "hunter2hunter2"})
	res, err := c.Post(srv.URL+"/api/signup", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("signup: status %d", res.StatusCode)
	}
	return c
}

func createDoc(t *testing.T, srv *httptest.Server, c *http.Client) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"title": "t"})
	res, err := c.Post(srv.URL+"/api/docs", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var d document
	if err := json.NewDecoder(res.Body).Decode(&d); err != nil {
		t.Fatal(err)
	}
	return d.ID
}

// dialWS opens a websocket to /ws/{id} carrying the client's session cookie.
func dialWS(t *testing.T, srv *httptest.Server, c *http.Client, docID string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, srv.URL+"/ws/"+docID, &websocket.DialOptions{HTTPClient: c})
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

type syncedMsg struct {
	Type          string `json:"type"`
	LastSeq       int64  `json:"last_seq"`
	SnapshotSeq   int64  `json:"snapshot_seq"`
	SnapshotState string `json:"snapshot_state"`
	TailRows      int    `json:"tail_rows"`
	TailBytes     int    `json:"tail_bytes"`
}

// readUntilSynced consumes messages until the synced control message,
// returning doc updates and awareness payloads seen along the way.
func readUntilSynced(t *testing.T, conn *websocket.Conn) (updates, awareness [][]byte, synced syncedMsg) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if typ == websocket.MessageText {
			json.Unmarshal(data, &synced)
			if synced.Type == "synced" {
				return updates, awareness, synced
			}
			continue
		}
		switch data[0] {
		case msgDoc:
			updates = append(updates, decodeBatch(t, data[1:])...)
		case msgAwareness:
			awareness = append(awareness, data[1:])
		}
	}
}

func decodeBatch(t *testing.T, data []byte) [][]byte {
	t.Helper()
	var out [][]byte
	for i := 0; i < len(data); {
		n, w := binary.Uvarint(data[i:])
		if w <= 0 {
			t.Fatal("bad frame")
		}
		i += w
		out = append(out, data[i:i+int(n)])
		i += int(n)
	}
	return out
}

// readOneMessage returns the next binary message's type byte and payload.
func readOneMessage(t *testing.T, conn *websocket.Conn) (byte, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if typ != websocket.MessageBinary {
			continue
		}
		return data[0], data[1:]
	}
}

func readOneUpdate(t *testing.T, conn *websocket.Conn) []byte {
	t.Helper()
	mt, payload := readOneMessage(t, conn)
	if mt != msgDoc {
		t.Fatalf("message type = %d, want msgDoc", mt)
	}
	got := decodeBatch(t, payload)
	if len(got) != 1 {
		t.Fatalf("expected batch of 1, got %d", len(got))
	}
	return got[0]
}

func sendTyped(t *testing.T, conn *websocket.Conn, msgType byte, payload []byte) {
	t.Helper()
	if err := conn.Write(context.Background(), websocket.MessageBinary, typed(msgType, payload)); err != nil {
		t.Fatal(err)
	}
}

func TestRelayAndReplay(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)

	a := dialWS(t, srv, alice, docID)
	defer a.Close(websocket.StatusNormalClosure, "")
	if got, _, _ := readUntilSynced(t, a); len(got) != 0 {
		t.Fatalf("fresh doc replayed %d updates, want 0", len(got))
	}

	b := dialWS(t, srv, alice, docID)
	defer b.Close(websocket.StatusNormalClosure, "")
	readUntilSynced(t, b)

	// A's update reaches B (payload is opaque to the server, any bytes do).
	update := []byte{0xde, 0xad, 0xbe, 0xef}
	sendTyped(t, a, msgDoc, update)
	if got := readOneUpdate(t, b); !bytes.Equal(got, update) {
		t.Fatalf("B got %x, want %x", got, update)
	}

	// Disconnect both; the room flushes. A fresh client replays the update.
	a.Close(websocket.StatusNormalClosure, "")
	b.Close(websocket.StatusNormalClosure, "")

	deadline := time.Now().Add(5 * time.Second)
	for {
		c := dialWS(t, srv, alice, docID)
		got, _, _ := readUntilSynced(t, c)
		c.Close(websocket.StatusNormalClosure, "")
		if len(got) == 1 && bytes.Equal(got[0], update) {
			break
		}
		// The flush races the reconnect; poll until it lands.
		if time.Now().After(deadline) {
			t.Fatalf("replay never delivered the update, last got %d updates", len(got))
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestAwarenessRelayAndJoinReplay(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)

	a := dialWS(t, srv, alice, docID)
	defer a.Close(websocket.StatusNormalClosure, "")
	readUntilSynced(t, a)

	b := dialWS(t, srv, alice, docID)
	defer b.Close(websocket.StatusNormalClosure, "")
	readUntilSynced(t, b)

	// Live relay: A's presence reaches B.
	presence := []byte{0x42, 0x43}
	sendTyped(t, a, msgAwareness, presence)
	mt, payload := readOneMessage(t, b)
	if mt != msgAwareness || !bytes.Equal(payload, presence) {
		t.Fatalf("B got type %d payload %x, want awareness %x", mt, payload, presence)
	}

	// Join replay: a newcomer sees A's remembered presence immediately.
	c := dialWS(t, srv, alice, docID)
	defer c.Close(websocket.StatusNormalClosure, "")
	_, aw, _ := readUntilSynced(t, c)
	found := false
	for _, p := range aw {
		if bytes.Equal(p, presence) {
			found = true
		}
	}
	if !found {
		t.Fatalf("join replayed %d awareness payloads, none matched", len(aw))
	}
}

func TestSnapshotLifecycle(t *testing.T) {
	srv, db, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)

	// Write an update and disconnect so it flushes as row seq 1.
	a := dialWS(t, srv, alice, docID)
	readUntilSynced(t, a)
	update := []byte{1, 2, 3}
	sendTyped(t, a, msgDoc, update)
	a.Close(websocket.StatusNormalClosure, "")
	waitForRow(t, db, docID, 1)

	// Upload a (fake) snapshot claiming coverage of seq 1.
	snap := []byte{9, 9, 9}
	res, err := alice.Post(srv.URL+"/api/docs/"+docID+"/snapshot?last_seq=1", "application/octet-stream", bytes.NewReader(snap))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("snapshot upload: status %d", res.StatusCode)
	}

	// A joining client now replays the snapshot first and reports pending.
	c := dialWS(t, srv, alice, docID)
	got, _, synced := readUntilSynced(t, c)
	c.Close(websocket.StatusNormalClosure, "")
	if len(got) < 1 || !bytes.Equal(got[0], snap) {
		t.Fatalf("replay did not start with snapshot: %x", got)
	}
	if synced.SnapshotSeq != 1 || synced.SnapshotState != "pending" {
		t.Fatalf("synced = %+v, want snapshot 1 pending", synced)
	}

	// The verify bundle carries both reconstructions and the pending seq.
	res, err = alice.Get(srv.URL + "/api/docs/" + docID + "/verify-bundle")
	if err != nil {
		t.Fatal(err)
	}
	bundle, _ := io.ReadAll(res.Body)
	res.Body.Close()
	parts := splitBundle(t, bundle)
	if len(parts) != 3 {
		t.Fatalf("bundle has %d parts, want 3", len(parts))
	}
	if a := decodeBatch(t, parts[0]); len(a) != 1 || !bytes.Equal(a[0], update) {
		t.Fatalf("bundle A = %x, want the logged update", parts[0])
	}
	if b := decodeBatch(t, parts[1]); len(b) != 1 || !bytes.Equal(b[0], snap) {
		t.Fatalf("bundle B = %x, want the snapshot", parts[1])
	}

	// Positive verdict: snapshot verified, rows archived (gzipped), log empty.
	body, _ := json.Marshal(map[string]any{"last_seq": 1, "ok": true})
	res, err = alice.Post(srv.URL+"/api/docs/"+docID+"/verify", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("verify: status %d", res.StatusCode)
	}
	var liveRows int
	db.QueryRow("SELECT COUNT(*) FROM updates WHERE doc_id = ?", docID).Scan(&liveRows)
	if liveRows != 0 {
		t.Fatalf("%d live rows after archive, want 0", liveRows)
	}
	var gz []byte
	if err := db.QueryRow("SELECT data FROM history_segments WHERE doc_id = ?", docID).Scan(&gz); err != nil {
		t.Fatal("no history segment written:", err)
	}
	raw, err := gunzip(gz)
	if err != nil {
		t.Fatal(err)
	}
	if seg := decodeBatch(t, raw); len(seg) != 1 || !bytes.Equal(seg[0], update) {
		t.Fatalf("archived segment = %x, want the original update", raw)
	}

	// New edits after archival must get fresh sequence numbers (> 1).
	d := dialWS(t, srv, alice, docID)
	readUntilSynced(t, d)
	sendTyped(t, d, msgDoc, []byte{7})
	d.Close(websocket.StatusNormalClosure, "")
	waitForRow(t, db, docID, 2)
}

func TestSnapshotReject(t *testing.T) {
	srv, db, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)

	a := dialWS(t, srv, alice, docID)
	readUntilSynced(t, a)
	sendTyped(t, a, msgDoc, []byte{1})
	a.Close(websocket.StatusNormalClosure, "")
	waitForRow(t, db, docID, 1)

	res, _ := alice.Post(srv.URL+"/api/docs/"+docID+"/snapshot?last_seq=1", "application/octet-stream", bytes.NewReader([]byte{9}))
	res.Body.Close()

	body, _ := json.Marshal(map[string]any{"last_seq": 1, "ok": false})
	res, err := alice.Post(srv.URL+"/api/docs/"+docID+"/verify", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	var snaps, rows int
	db.QueryRow("SELECT COUNT(*) FROM snapshots WHERE doc_id = ?", docID).Scan(&snaps)
	db.QueryRow("SELECT COUNT(*) FROM updates WHERE doc_id = ?", docID).Scan(&rows)
	if snaps != 0 || rows != 1 {
		t.Fatalf("after reject: %d snapshots (want 0), %d rows (want 1)", snaps, rows)
	}
}

// waitForRow polls until the doc's log contains a row with the given seq.
func waitForRow(t *testing.T, db *sql.DB, docID string, seq int64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var n int
		db.QueryRow("SELECT COUNT(*) FROM updates WHERE doc_id = ? AND seq = ?", docID, seq).Scan(&n)
		if n == 1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("row seq %d never appeared", seq)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// splitBundle parses [uvarint len][part]... into parts.
func splitBundle(t *testing.T, data []byte) [][]byte {
	t.Helper()
	var parts [][]byte
	for i := 0; i < len(data); {
		n, w := binary.Uvarint(data[i:])
		if w <= 0 {
			t.Fatal("bad bundle framing")
		}
		i += w
		parts = append(parts, data[i:i+int(n)])
		i += int(n)
	}
	return parts
}

func TestViewerCannotWrite(t *testing.T) {
	srv, db, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)

	// No sharing API yet: grant bob viewer directly in the db.
	var bobID int64
	if err := db.QueryRow("SELECT id FROM users WHERE email = 'bob@example.com'").Scan(&bobID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO permissions (doc_id, user_id, role) VALUES (?,?,'viewer')", docID, bobID); err != nil {
		t.Fatal(err)
	}

	conn := dialWS(t, srv, bob, docID)
	defer conn.Close(websocket.StatusNormalClosure, "")
	readUntilSynced(t, conn)

	// Presence from a viewer is fine; a doc write must close the connection.
	sendTyped(t, conn, msgAwareness, []byte{5})
	sendTyped(t, conn, msgDoc, []byte{1})
	ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := conn.Read(ctx2)
	if err == nil {
		t.Fatal("expected close, got a message")
	}
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("close status = %v, want policy violation", err)
	}
}

func TestNoAccessNoWS(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	mallory := apiClient(t, srv, "mallory@example.com")
	docID := createDoc(t, srv, alice)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, res, err := websocket.Dial(ctx, srv.URL+"/ws/"+docID, &websocket.DialOptions{HTTPClient: mallory})
	if err == nil {
		t.Fatal("expected dial to fail for user without permission")
	}
	if res != nil && res.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", res.StatusCode)
	}
}
