package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestSessionize(t *testing.T) {
	gap := int64(sessionGap.Seconds())
	base := int64(1_700_000_000)
	points := []seqPoint{
		{seq: 1, at: base},
		{seq: 2, at: base + 30},           // same session
		{seq: 3, at: base + 30 + gap + 1}, // gap exceeded: new session
		{seq: 4, at: base + 30 + gap + 40},
	}
	s := sessionize(points)
	if len(s) != 2 {
		t.Fatalf("got %d sessions, want 2: %+v", len(s), s)
	}
	if s[0].EndSeq != 2 || s[0].Rows != 2 || s[1].EndSeq != 4 || s[1].Rows != 2 {
		t.Fatalf("bad bucketing: %+v", s)
	}

	// A coarse point stands alone and breaks the surrounding session.
	s = sessionize([]seqPoint{
		{seq: 5, at: base, coarse: true},
		{seq: 6, at: base + 10},
	})
	if len(s) != 2 || !s[0].Coarse || s[1].Coarse {
		t.Fatalf("coarse handling wrong: %+v", s)
	}
}

// seedRow inserts one update row with a chosen timestamp and keeps the
// documents.last_seq counter consistent.
func seedRow(t *testing.T, db *sql.DB, docID string, seq int64, update []byte, at int64) {
	t.Helper()
	_, err := db.Exec("INSERT INTO updates (doc_id, seq, data, created_at) VALUES (?,?,?,?)",
		docID, seq, frameUpdates([][]byte{update}), at)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE documents SET last_seq = ? WHERE id = ? AND last_seq < ?", seq, docID, seq); err != nil {
		t.Fatal(err)
	}
}

func TestHistoryAndReplay(t *testing.T) {
	srv, db, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)

	gap := int64(sessionGap.Seconds())
	base := time.Now().Unix() - 10*gap
	// Session one: rows 1-2. Session two: row 3.
	seedRow(t, db, docID, 1, []byte{1}, base)
	seedRow(t, db, docID, 2, []byte{2}, base+20)
	seedRow(t, db, docID, 3, []byte{3}, base+20+gap+5)

	res, err := alice.Get(srv.URL + "/api/docs/" + docID + "/history")
	if err != nil {
		t.Fatal(err)
	}
	var hist struct {
		Sessions []historySession `json:"sessions"`
		Versions []namedVersion   `json:"versions"`
	}
	json.NewDecoder(res.Body).Decode(&hist)
	res.Body.Close()
	if len(hist.Sessions) != 2 || hist.Sessions[0].EndSeq != 2 || hist.Sessions[1].EndSeq != 3 {
		t.Fatalf("sessions = %+v", hist.Sessions)
	}

	// Replay to seq 2 returns exactly updates 1 and 2.
	res, _ = alice.Get(srv.URL + "/api/docs/" + docID + "/replay?to_seq=2")
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	got := decodeBatch(t, body)
	if len(got) != 2 || !bytes.Equal(got[0], []byte{1}) || !bytes.Equal(got[1], []byte{2}) {
		t.Fatalf("replay to 2 = %x", got)
	}

	// Archive rows 1-3 via the snapshot flow, then check mid-segment cuts.
	res, err = alice.Post(srv.URL+"/api/docs/"+docID+"/snapshot?last_seq=3", "application/octet-stream", bytes.NewReader([]byte{9}))
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("snapshot: %v %d", err, res.StatusCode)
	}
	res.Body.Close()
	vbody, _ := json.Marshal(map[string]any{"last_seq": 3, "ok": true})
	res, _ = alice.Post(srv.URL+"/api/docs/"+docID+"/verify", "application/json", bytes.NewReader(vbody))
	res.Body.Close()
	var live int
	db.QueryRow("SELECT COUNT(*) FROM updates WHERE doc_id = ?", docID).Scan(&live)
	if live != 0 {
		t.Fatalf("%d live rows after archive", live)
	}

	// History still shows both sessions from the archived index.
	res, _ = alice.Get(srv.URL + "/api/docs/" + docID + "/history")
	json.NewDecoder(res.Body).Decode(&hist)
	res.Body.Close()
	if len(hist.Sessions) != 2 || hist.Sessions[0].EndSeq != 2 {
		t.Fatalf("post-archive sessions = %+v", hist.Sessions)
	}

	// Mid-segment replay: to_seq=2 must cut inside the archived segment.
	res, _ = alice.Get(srv.URL + "/api/docs/" + docID + "/replay?to_seq=2")
	body, _ = io.ReadAll(res.Body)
	res.Body.Close()
	got = decodeBatch(t, body)
	if len(got) != 2 || !bytes.Equal(got[1], []byte{2}) {
		t.Fatalf("post-archive replay to 2 = %x", got)
	}
}

func TestNamedVersions(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)

	// Naming with no history yet is refused.
	res := postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/versions", map[string]string{"name": "v1"})
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("empty-doc version: %d, want 409", res.StatusCode)
	}
	res.Body.Close()

	// Write something (through the real pipeline), then pin it. The pin
	// flushes the room, but the disconnect flush may race it — retry.
	conn := dialWS(t, srv, alice, docID)
	readUntilSynced(t, conn)
	sendTyped(t, conn, msgDoc, []byte{7})
	conn.Close(1000, "")

	deadline := time.Now().Add(5 * time.Second)
	for {
		res = postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/versions", map[string]string{"name": "first draft"})
		if res.StatusCode == 200 {
			break
		}
		res.Body.Close()
		if time.Now().After(deadline) {
			t.Fatal("version pin never succeeded")
		}
		time.Sleep(50 * time.Millisecond)
	}
	var v namedVersion
	json.NewDecoder(res.Body).Decode(&v)
	res.Body.Close()
	if v.Seq < 1 || v.Name != "first draft" {
		t.Fatalf("version = %+v", v)
	}

	res, _ = alice.Get(srv.URL + "/api/docs/" + docID + "/history")
	var hist struct {
		Versions []namedVersion `json:"versions"`
	}
	json.NewDecoder(res.Body).Decode(&hist)
	res.Body.Close()
	if len(hist.Versions) != 1 || hist.Versions[0].Name != "first draft" {
		t.Fatalf("versions = %+v", hist.Versions)
	}

	req, _ := http.NewRequest("DELETE", srv.URL+"/api/docs/"+docID+"/versions/"+itoa(v.ID), nil)
	res, _ = alice.Do(req)
	res.Body.Close()
	res, _ = alice.Get(srv.URL + "/api/docs/" + docID + "/history")
	json.NewDecoder(res.Body).Decode(&hist)
	res.Body.Close()
	if len(hist.Versions) != 0 {
		t.Fatalf("versions after delete = %+v", hist.Versions)
	}
}
