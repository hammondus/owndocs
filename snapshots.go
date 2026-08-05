package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"
)

// rowIndexEntry locates one archived update row inside a segment's
// decompressed bytes. Serialized as JSON in history_segments.row_index.
type rowIndexEntry struct {
	Seq int64 `json:"s"`
	At  int64 `json:"t"`
	Off int   `json:"o"`
}

// Compaction endpoints (see DESIGN-DECISIONS.md). The snapshot is a cache;
// the update log is the source of truth. Clients post merged snapshots,
// a later load verifies one against an independent replay of the log, and
// only then are the covered rows archived (gzipped, never deleted).

const maxSnapshotSize = 64 << 20

func gunzip(data []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(zr)
}

func gzipBytes(data []byte) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write(data)
	zw.Close()
	return buf.Bytes()
}

// requireRole resolves the caller's role on the doc and 404s below the
// minimum. Ordering: viewer < editor < owner.
func requireRole(db *sql.DB, w http.ResponseWriter, r *http.Request, min string) (string, bool) {
	role, err := roleFor(db, r.PathValue("id"), currentUser(r).ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "db error")
		return "", false
	}
	if role == "" || roleRank[role] < roleRank[min] {
		jsonError(w, http.StatusNotFound, "not found")
		return "", false
	}
	return role, true
}

// POST /api/docs/{id}/snapshot?last_seq=N — body is the raw Yjs merged
// state (application/octet-stream; not a form-postable type, so no CSRF
// exposure). The snapshot claims to cover the log up to and including N.
func handleSnapshotUpload(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "editor"); !ok {
			return
		}
		docID := r.PathValue("id")
		lastSeq, err := strconv.ParseInt(r.URL.Query().Get("last_seq"), 10, 64)
		if err != nil || lastSeq <= 0 {
			jsonError(w, http.StatusBadRequest, "last_seq required")
			return
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/octet-stream" {
			jsonError(w, http.StatusUnsupportedMediaType, "expected application/octet-stream")
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSnapshotSize))
		if err != nil || len(data) == 0 {
			jsonError(w, http.StatusBadRequest, "snapshot body required")
			return
		}
		sum := sha256.Sum256(data)

		tx, err := db.Begin()
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer tx.Rollback()
		var docLast int64
		if err := tx.QueryRow("SELECT last_seq FROM documents WHERE id = ?", docID).Scan(&docLast); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if lastSeq > docLast {
			jsonError(w, http.StatusConflict, "last_seq beyond current log")
			return
		}
		var verifiedSeq int64
		_ = tx.QueryRow("SELECT COALESCE(MAX(last_seq),0) FROM snapshots WHERE doc_id = ? AND state='verified'", docID).Scan(&verifiedSeq)
		if lastSeq < verifiedSeq {
			jsonError(w, http.StatusConflict, "older than current verified snapshot")
			return
		}
		// One pending at a time: newest claim wins.
		if _, err := tx.Exec("DELETE FROM snapshots WHERE doc_id = ? AND state='pending'", docID); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if _, err := tx.Exec(`INSERT OR REPLACE INTO snapshots (doc_id, last_seq, data, sha256, state, created_at)
			VALUES (?,?,?,?,'pending',?)`, docID, lastSeq, data, sum[:], time.Now().Unix()); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if err := tx.Commit(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "last_seq": lastSeq})
	}
}

// GET /api/docs/{id}/verify-bundle — two independent reconstructions of the
// current document state, read in one transaction so they describe the same
// log instant:
//
//	bundle A: verified snapshot (if any) + every live update row
//	bundle B: pending snapshot + live rows past its last_seq
//
// Response body: [uvarint lenA][A][uvarint lenB][B][uvarint 8][last_seq be64].
// Each bundle is a frame sequence ([uvarint len][update]...). The client
// replays both and checks that B's state vector dominates A's.
func handleVerifyBundle(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "viewer"); !ok {
			return
		}
		docID := r.PathValue("id")

		tx, err := db.Begin()
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer tx.Rollback()

		var pendSeq int64
		var pendData []byte
		err = tx.QueryRow("SELECT last_seq, data FROM snapshots WHERE doc_id = ? AND state='pending' ORDER BY last_seq DESC LIMIT 1", docID).
			Scan(&pendSeq, &pendData)
		if err == sql.ErrNoRows {
			jsonError(w, http.StatusNotFound, "no pending snapshot")
			return
		}
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}

		var a, b []byte
		var verData []byte
		err = tx.QueryRow("SELECT data FROM snapshots WHERE doc_id = ? AND state='verified' ORDER BY last_seq DESC LIMIT 1", docID).Scan(&verData)
		if err != nil && err != sql.ErrNoRows {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if verData != nil {
			a = frameUpdates([][]byte{verData})
		}
		b = frameUpdates([][]byte{pendData})

		rows, err := tx.Query("SELECT seq, data FROM updates WHERE doc_id = ? ORDER BY seq", docID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer rows.Close()
		for rows.Next() {
			var seq int64
			var data []byte
			if err := rows.Scan(&seq, &data); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			a = append(a, data...) // row payloads are frame sequences; concatenation stays one
			if seq > pendSeq {
				b = append(b, data...)
			}
		}
		if err := rows.Err(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}

		var out []byte
		out = binary.AppendUvarint(out, uint64(len(a)))
		out = append(out, a...)
		out = binary.AppendUvarint(out, uint64(len(b)))
		out = append(out, b...)
		var seqBE [8]byte
		binary.BigEndian.PutUint64(seqBE[:], uint64(pendSeq))
		out = binary.AppendUvarint(out, 8)
		out = append(out, seqBE[:]...)

		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(out)
	}
}

// POST /api/docs/{id}/verify {"last_seq":N,"ok":bool} — the verdict from a
// client that ran the bundle comparison. ok=true promotes the pending
// snapshot and archives the rows it covers; ok=false (decode failure or
// state-vector regression) deletes it, loudly. Rows are archived, never
// discarded: real history deletion is an explicit user action, later.
func handleSnapshotVerdict(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "editor"); !ok {
			return
		}
		docID := r.PathValue("id")
		var in struct {
			LastSeq int64 `json:"last_seq"`
			OK      bool  `json:"ok"`
		}
		if !readJSON(w, r, &in) {
			return
		}

		if !in.OK {
			res, err := db.Exec("DELETE FROM snapshots WHERE doc_id = ? AND last_seq = ? AND state='pending'", docID, in.LastSeq)
			if err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			if n, _ := res.RowsAffected(); n > 0 {
				log.Printf("doc %s: pending snapshot seq %d REJECTED by verifier %q — serving from log",
					docID, in.LastSeq, currentUser(r).Email)
			}
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}

		tx, err := db.Begin()
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer tx.Rollback()
		res, err := tx.Exec("UPDATE snapshots SET state='verified' WHERE doc_id = ? AND last_seq = ? AND state='pending'", docID, in.LastSeq)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			jsonError(w, http.StatusConflict, "no matching pending snapshot")
			return
		}

		// Archive the covered rows as one gzipped segment, with a row index
		// (seq, timestamp, byte offset) so version history can still find
		// session boundaries and cut mid-segment after archiving.
		rows, err := tx.Query("SELECT seq, data, created_at FROM updates WHERE doc_id = ? AND seq <= ? ORDER BY seq", docID, in.LastSeq)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		var startSeq, endSeq int64
		var raw []byte
		var index []rowIndexEntry
		for rows.Next() {
			var seq, at int64
			var data []byte
			if err := rows.Scan(&seq, &data, &at); err != nil {
				rows.Close()
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			if startSeq == 0 {
				startSeq = seq
			}
			endSeq = seq
			index = append(index, rowIndexEntry{Seq: seq, At: at, Off: len(raw)})
			raw = append(raw, data...)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if startSeq > 0 {
			indexJSON, err := json.Marshal(index)
			if err != nil {
				jsonError(w, http.StatusInternalServerError, "encode error")
				return
			}
			if _, err := tx.Exec("INSERT INTO history_segments (doc_id, start_seq, end_seq, data, created_at, row_index) VALUES (?,?,?,?,?,?)",
				docID, startSeq, endSeq, gzipBytes(raw), time.Now().Unix(), string(indexJSON)); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			if _, err := tx.Exec("DELETE FROM updates WHERE doc_id = ? AND seq <= ?", docID, in.LastSeq); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
		}
		// Superseded snapshots (the old verified one) are no longer needed.
		if _, err := tx.Exec("DELETE FROM snapshots WHERE doc_id = ? AND last_seq < ?", docID, in.LastSeq); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if err := tx.Commit(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}
