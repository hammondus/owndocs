package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
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

// readUntilSynced consumes messages until the synced control message,
// returning all updates decoded from binary batches along the way.
func readUntilSynced(t *testing.T, conn *websocket.Conn) [][]byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var updates [][]byte
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if typ == websocket.MessageText {
			var msg struct{ Type string }
			json.Unmarshal(data, &msg)
			if msg.Type == "synced" {
				return updates
			}
			continue
		}
		updates = append(updates, decodeBatch(t, data)...)
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

func readOneUpdate(t *testing.T, conn *websocket.Conn) []byte {
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
		got := decodeBatch(t, data)
		if len(got) != 1 {
			t.Fatalf("expected batch of 1, got %d", len(got))
		}
		return got[0]
	}
}

func TestRelayAndReplay(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)

	a := dialWS(t, srv, alice, docID)
	defer a.Close(websocket.StatusNormalClosure, "")
	if got := readUntilSynced(t, a); len(got) != 0 {
		t.Fatalf("fresh doc replayed %d updates, want 0", len(got))
	}

	b := dialWS(t, srv, alice, docID)
	defer b.Close(websocket.StatusNormalClosure, "")
	readUntilSynced(t, b)

	// A's update reaches B (payload is opaque to the server, any bytes do).
	update := []byte{0xde, 0xad, 0xbe, 0xef}
	ctx := context.Background()
	if err := a.Write(ctx, websocket.MessageBinary, update); err != nil {
		t.Fatal(err)
	}
	if got := readOneUpdate(t, b); !bytes.Equal(got, update) {
		t.Fatalf("B got %x, want %x", got, update)
	}

	// Disconnect both; the room flushes. A fresh client replays the update.
	a.Close(websocket.StatusNormalClosure, "")
	b.Close(websocket.StatusNormalClosure, "")

	deadline := time.Now().Add(5 * time.Second)
	for {
		c := dialWS(t, srv, alice, docID)
		got := readUntilSynced(t, c)
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

	ctx := context.Background()
	if err := conn.Write(ctx, websocket.MessageBinary, []byte{1}); err != nil {
		t.Fatal(err)
	}
	// Server must close the connection with a policy violation.
	ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
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
