package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Version history. Browseable points are DERIVED from row timestamps at
// query time, not stored, so both rules below re-bucket all history
// retroactively when tuned. A session closes when either fires:
//   - sessionGap: a pause this long is a natural boundary ("they stopped")
//   - sessionMax: nonstop editing gets a forced boundary anyway, so a
//     marathon never collapses into one giant unbrowsable point
// The server only reads timestamps and sequence numbers; document content
// stays opaque (replay assembly is byte concatenation, applied client-side).
const (
	sessionGap = 5 * time.Minute
	sessionMax = 30 * time.Minute
)

type historySession struct {
	EndSeq  int64 `json:"end_seq"`
	Started int64 `json:"started_at"`
	Ended   int64 `json:"ended_at"`
	Rows    int   `json:"rows"`
	Coarse  bool  `json:"coarse"` // pre-v4 segment: only its end is addressable
}

type namedVersion struct {
	ID        int64  `json:"id"`
	Seq       int64  `json:"seq"`
	Name      string `json:"name"`
	CreatedBy string `json:"created_by"`
	CreatedAt int64  `json:"created_at"`
}

type seqPoint struct {
	seq    int64
	at     int64
	coarse bool
}

// collectPoints gathers every addressable (seq, time) for a doc: archived
// rows via each segment's row index, then live rows. Pre-v4 segments
// without an index contribute one coarse point at their end.
func collectPoints(db *sql.DB, docID string) ([]seqPoint, error) {
	var points []seqPoint

	segs, err := db.Query("SELECT end_seq, created_at, row_index FROM history_segments WHERE doc_id = ? ORDER BY start_seq", docID)
	if err != nil {
		return nil, err
	}
	type seg struct {
		endSeq, at int64
		index      sql.NullString
	}
	var segList []seg
	for segs.Next() {
		var s seg
		if err := segs.Scan(&s.endSeq, &s.at, &s.index); err != nil {
			segs.Close()
			return nil, err
		}
		segList = append(segList, s)
	}
	segs.Close()
	if err := segs.Err(); err != nil {
		return nil, err
	}
	for _, s := range segList {
		if !s.index.Valid || s.index.String == "" {
			points = append(points, seqPoint{seq: s.endSeq, at: s.at, coarse: true})
			continue
		}
		var entries []rowIndexEntry
		if err := json.Unmarshal([]byte(s.index.String), &entries); err != nil {
			points = append(points, seqPoint{seq: s.endSeq, at: s.at, coarse: true})
			continue
		}
		for _, e := range entries {
			points = append(points, seqPoint{seq: e.Seq, at: e.At})
		}
	}

	rows, err := db.Query("SELECT seq, created_at FROM updates WHERE doc_id = ? ORDER BY seq", docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p seqPoint
		if err := rows.Scan(&p.seq, &p.at); err != nil {
			return nil, err
		}
		points = append(points, p)
	}
	return points, rows.Err()
}

// sessionize buckets points into sessions. A session closes on a pause
// longer than sessionGap, on total duration passing sessionMax, or at a
// coarse point (which stands alone).
func sessionize(points []seqPoint) []historySession {
	sessions := []historySession{}
	var cur *historySession
	for _, p := range points {
		if p.coarse {
			sessions = append(sessions, historySession{EndSeq: p.seq, Started: p.at, Ended: p.at, Rows: 1, Coarse: true})
			cur = nil
			continue
		}
		paused := cur != nil && p.at-cur.Ended > int64(sessionGap.Seconds())
		overlong := cur != nil && p.at-cur.Started > int64(sessionMax.Seconds())
		if cur == nil || paused || overlong {
			sessions = append(sessions, historySession{EndSeq: p.seq, Started: p.at, Ended: p.at, Rows: 1})
			cur = &sessions[len(sessions)-1]
			continue
		}
		cur.EndSeq = p.seq
		cur.Ended = p.at
		cur.Rows++
	}
	return sessions
}

// GET /api/docs/{id}/history — sessions plus named versions, for the panel.
func handleListHistory(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "viewer"); !ok {
			return
		}
		docID := r.PathValue("id")
		points, err := collectPoints(db, docID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		versions := []namedVersion{}
		rows, err := db.Query(`
			SELECT v.id, v.seq, v.name, u.name, v.created_at
			FROM versions v JOIN users u ON u.id = v.created_by
			WHERE v.doc_id = ? ORDER BY v.seq DESC`, docID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer rows.Close()
		for rows.Next() {
			var v namedVersion
			if err := rows.Scan(&v.ID, &v.Seq, &v.Name, &v.CreatedBy, &v.CreatedAt); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			versions = append(versions, v)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"sessions": sessionize(points),
			"versions": versions,
		})
	}
}

// GET /api/docs/{id}/replay?to_seq=N — the document's update frames up to
// and including seq N, as one frame sequence the client replays into a
// fresh Y.Doc. Archived segments are cut at row boundaries via their index;
// a pre-v4 segment that N falls inside is included only up to the nearest
// addressable boundary below it (clamping down, never over).
func handleReplay(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "viewer"); !ok {
			return
		}
		docID := r.PathValue("id")
		toSeq, err := strconv.ParseInt(r.URL.Query().Get("to_seq"), 10, 64)
		if err != nil || toSeq <= 0 {
			jsonError(w, http.StatusBadRequest, "to_seq required")
			return
		}

		var out []byte
		segs, err := db.Query("SELECT start_seq, end_seq, data, row_index FROM history_segments WHERE doc_id = ? ORDER BY start_seq", docID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		type seg struct {
			start, end int64
			gz         []byte
			index      sql.NullString
		}
		var segList []seg
		for segs.Next() {
			var s seg
			if err := segs.Scan(&s.start, &s.end, &s.gz, &s.index); err != nil {
				segs.Close()
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			segList = append(segList, s)
		}
		segs.Close()
		if err := segs.Err(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		for _, s := range segList {
			if s.start > toSeq {
				continue
			}
			raw, err := gunzip(s.gz)
			if err != nil {
				jsonError(w, http.StatusInternalServerError, "corrupt segment")
				return
			}
			if s.end <= toSeq {
				out = append(out, raw...)
				continue
			}
			// N falls inside this segment: cut at the first row past it.
			if !s.index.Valid {
				continue // unindexed: clamp down to the previous boundary
			}
			var entries []rowIndexEntry
			if err := json.Unmarshal([]byte(s.index.String), &entries); err != nil {
				continue
			}
			cut := len(raw)
			for _, e := range entries {
				if e.Seq > toSeq {
					cut = e.Off
					break
				}
			}
			out = append(out, raw[:cut]...)
		}

		rows, err := db.Query("SELECT data FROM updates WHERE doc_id = ? AND seq <= ? ORDER BY seq", docID, toSeq)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer rows.Close()
		for rows.Next() {
			var data []byte
			if err := rows.Scan(&data); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			out = append(out, data...)
		}
		if err := rows.Err(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(out)
	}
}

// POST /api/docs/{id}/versions {name} — pin a name to the current state.
// The room is flushed first so the pin lands on the very latest edit.
func handleCreateVersion(db *sql.DB, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "editor"); !ok {
			return
		}
		docID := r.PathValue("id")
		var in struct {
			Name string `json:"name"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		in.Name = strings.TrimSpace(in.Name)
		if in.Name == "" {
			jsonError(w, http.StatusBadRequest, "name required")
			return
		}
		h.flushDoc(docID)
		var seq int64
		if err := db.QueryRow("SELECT last_seq FROM documents WHERE id = ?", docID).Scan(&seq); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if seq == 0 {
			jsonError(w, http.StatusConflict, "document has no history yet")
			return
		}
		res, err := db.Exec("INSERT INTO versions (doc_id, seq, name, created_by, created_at) VALUES (?,?,?,?,?)",
			docID, seq, in.Name, currentUser(r).ID, time.Now().Unix())
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		id, _ := res.LastInsertId()
		writeJSON(w, http.StatusOK, namedVersion{ID: id, Seq: seq, Name: in.Name, CreatedBy: currentUser(r).Name, CreatedAt: time.Now().Unix()})
	}
}

// DELETE /api/docs/{id}/versions/{vid} — owner removes a name. Only the
// label goes; the underlying history is untouched.
func handleDeleteVersion(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "owner"); !ok {
			return
		}
		if _, err := db.Exec("DELETE FROM versions WHERE doc_id = ? AND id = ?",
			r.PathValue("id"), r.PathValue("vid")); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}
