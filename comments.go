package main

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"
)

// Comment threads. Bodies, authorship and resolved-state live in SQLite rather
// than in the Yjs document — see DESIGN-DECISIONS.md "Comments". Two properties
// this file exists to hold, both of which the in-doc design could not:
//
//   - The author is always the session user. No request body carries an author
//     field, so a client cannot claim to be someone else — and neither can a
//     script running inside a shared document.
//   - `anchor` is opaque. It round-trips as base64 and is never interpreted
//     here, so the server still stores no document text.

const (
	maxCommentBody = 8 << 10 // 8 KiB of prose is already a long comment
	maxAnchor      = 4 << 10 // positions plus a quoted snippet, not a payload
)

type comment struct {
	ID         int64  `json:"id"`
	ThreadID   int64  `json:"thread_id"`
	AuthorID   int64  `json:"author_id"`
	AuthorName string `json:"author_name"`
	Body       string `json:"body"`
	CreatedAt  int64  `json:"created_at"`
	EditedAt   *int64 `json:"edited_at"`
}

type commentThread struct {
	ID         int64     `json:"id"`
	Anchor     []byte    `json:"anchor"` // opaque here; base64 on the wire
	CreatedBy  int64     `json:"created_by"`
	CreatedAt  int64     `json:"created_at"`
	ResolvedBy *int64    `json:"resolved_by"`
	ResolvedAt *int64    `json:"resolved_at"`
	Comments   []comment `json:"comments"`
}

// threadIn resolves a thread id *within* a document. Every handler below goes
// through it, so a thread id belonging to another document reads as absent
// rather than as something to write to.
func threadIn(db *sql.DB, docID, raw string) (int64, string, bool) {
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, "", false
	}
	var got string
	err = db.QueryRow("SELECT doc_id FROM comment_threads WHERE id = ?", id).Scan(&got)
	if err != nil || got != docID {
		return 0, "", false
	}
	return id, got, true
}

func nullInt(n sql.NullInt64) *int64 {
	if !n.Valid {
		return nil
	}
	return &n.Int64
}

// GET /api/docs/{id}/comments — every thread on a document with its replies,
// oldest first. Readable by anyone who can open the document; resolving the
// anchors to positions is the client's job, since only it has the Y.Doc.
func handleListComments(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "viewer"); !ok {
			return
		}
		docID := r.PathValue("id")
		rows, err := db.Query(`
			SELECT id, anchor, created_by, created_at, resolved_by, resolved_at
			FROM comment_threads WHERE doc_id = ? ORDER BY id`, docID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer rows.Close()
		threads := []*commentThread{}
		byID := map[int64]*commentThread{}
		for rows.Next() {
			t := &commentThread{Comments: []comment{}}
			var rby, rat sql.NullInt64
			if err := rows.Scan(&t.ID, &t.Anchor, &t.CreatedBy, &t.CreatedAt, &rby, &rat); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			t.ResolvedBy, t.ResolvedAt = nullInt(rby), nullInt(rat)
			threads = append(threads, t)
			byID[t.ID] = t
		}
		// One query for every comment on the document rather than one per
		// thread — a busy document has many threads and the join is the same
		// index either way.
		crows, err := db.Query(`
			SELECT c.id, c.thread_id, c.author_id, u.name, c.body, c.created_at, c.edited_at
			FROM comments c
			JOIN comment_threads t ON t.id = c.thread_id
			JOIN users u ON u.id = c.author_id
			WHERE t.doc_id = ? ORDER BY c.id`, docID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer crows.Close()
		for crows.Next() {
			var c comment
			var edited sql.NullInt64
			if err := crows.Scan(&c.ID, &c.ThreadID, &c.AuthorID, &c.AuthorName, &c.Body, &c.CreatedAt, &edited); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			c.EditedAt = nullInt(edited)
			if t := byID[c.ThreadID]; t != nil {
				t.Comments = append(t.Comments, c)
			}
		}
		writeJSON(w, http.StatusOK, threads)
	}
}

// POST /api/docs/{id}/comments {anchor, body} — opens a thread with its first
// comment. Both rows go in one transaction: a thread with nothing in it is not
// a state any reader should have to handle.
func handleCreateThread(db *sql.DB, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "commenter"); !ok {
			return
		}
		var in struct {
			Anchor []byte `json:"anchor"`
			Body   string `json:"body"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		if len(in.Anchor) == 0 || len(in.Anchor) > maxAnchor {
			jsonError(w, http.StatusBadRequest, "anchor required, and at most 4 KiB")
			return
		}
		if !validBody(w, in.Body) {
			return
		}
		now := time.Now().Unix()
		uid := currentUser(r).ID
		tx, err := db.Begin()
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer tx.Rollback()
		res, err := tx.Exec("INSERT INTO comment_threads (doc_id, anchor, created_by, created_at) VALUES (?,?,?,?)",
			r.PathValue("id"), in.Anchor, uid, now)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		tid, _ := res.LastInsertId()
		if _, err := tx.Exec("INSERT INTO comments (thread_id, author_id, body, created_at) VALUES (?,?,?,?)",
			tid, uid, in.Body, now); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if err := tx.Commit(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		h.notifyComments(r.PathValue("id"))
		writeJSON(w, http.StatusOK, commentThread{ID: tid, Anchor: in.Anchor, CreatedBy: uid, CreatedAt: now})
	}
}

// POST /api/docs/{id}/comments/{tid} {body} — reply to a thread.
func handleReply(db *sql.DB, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "commenter"); !ok {
			return
		}
		tid, _, ok := threadIn(db, r.PathValue("id"), r.PathValue("tid"))
		if !ok {
			jsonError(w, http.StatusNotFound, "not found")
			return
		}
		var in struct {
			Body string `json:"body"`
		}
		if !readJSON(w, r, &in) || !validBody(w, in.Body) {
			return
		}
		u, now := currentUser(r), time.Now().Unix()
		res, err := db.Exec("INSERT INTO comments (thread_id, author_id, body, created_at) VALUES (?,?,?,?)",
			tid, u.ID, in.Body, now)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		id, _ := res.LastInsertId()
		h.notifyComments(r.PathValue("id"))
		writeJSON(w, http.StatusOK, comment{
			ID: id, ThreadID: tid, AuthorID: u.ID, AuthorName: u.Name, Body: in.Body, CreatedAt: now,
		})
	}
}

// PATCH /api/docs/{id}/comments/{tid} {resolved} — resolve or reopen. Anyone
// who may comment may resolve, as in Google Docs: resolution is part of the
// conversation, not an ownership claim over it.
func handleResolveThread(db *sql.DB, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "commenter"); !ok {
			return
		}
		tid, _, ok := threadIn(db, r.PathValue("id"), r.PathValue("tid"))
		if !ok {
			jsonError(w, http.StatusNotFound, "not found")
			return
		}
		var in struct {
			Resolved bool `json:"resolved"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		var by, at any
		if in.Resolved {
			by, at = currentUser(r).ID, time.Now().Unix()
		}
		if _, err := db.Exec("UPDATE comment_threads SET resolved_by = ?, resolved_at = ? WHERE id = ?",
			by, at, tid); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		h.notifyComments(r.PathValue("id"))
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// PATCH /api/docs/{id}/comments/{tid}/{cid} {body} — edit a comment. The
// author and nobody else: an owner moderating a thread may delete it, but
// rewriting someone's words under their name is forgery, not moderation.
func handleEditComment(db *sql.DB, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "commenter"); !ok {
			return
		}
		tid, _, ok := threadIn(db, r.PathValue("id"), r.PathValue("tid"))
		if !ok {
			jsonError(w, http.StatusNotFound, "not found")
			return
		}
		var in struct {
			Body string `json:"body"`
		}
		if !readJSON(w, r, &in) || !validBody(w, in.Body) {
			return
		}
		author, err := commentAuthor(db, tid, r.PathValue("cid"))
		if err != nil {
			jsonError(w, http.StatusNotFound, "not found")
			return
		}
		if author != currentUser(r).ID {
			jsonError(w, http.StatusForbidden, "only the author can edit a comment")
			return
		}
		if _, err := db.Exec("UPDATE comments SET body = ?, edited_at = ? WHERE id = ?",
			in.Body, time.Now().Unix(), r.PathValue("cid")); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		h.notifyComments(r.PathValue("id"))
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// DELETE /api/docs/{id}/comments/{tid}/{cid} — the author, or the document
// owner as moderator. Removing the last comment removes the thread with it,
// since an anchor with nothing attached is invisible to every reader anyway.
func handleDeleteComment(db *sql.DB, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		role, ok := requireRole(db, w, r, "commenter")
		if !ok {
			return
		}
		tid, _, ok := threadIn(db, r.PathValue("id"), r.PathValue("tid"))
		if !ok {
			jsonError(w, http.StatusNotFound, "not found")
			return
		}
		author, err := commentAuthor(db, tid, r.PathValue("cid"))
		if err != nil {
			jsonError(w, http.StatusNotFound, "not found")
			return
		}
		if author != currentUser(r).ID && role != "owner" {
			jsonError(w, http.StatusForbidden, "only the author or the document owner can delete a comment")
			return
		}
		tx, err := db.Begin()
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer tx.Rollback()
		if _, err := tx.Exec("DELETE FROM comments WHERE id = ?", r.PathValue("cid")); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		var left int
		if err := tx.QueryRow("SELECT COUNT(*) FROM comments WHERE thread_id = ?", tid).Scan(&left); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if left == 0 {
			if _, err := tx.Exec("DELETE FROM comment_threads WHERE id = ?", tid); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
		}
		if err := tx.Commit(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		h.notifyComments(r.PathValue("id"))
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// DELETE /api/docs/{id}/comments/{tid} — whoever opened the thread, or the
// document owner. Comments cascade.
func handleDeleteThread(db *sql.DB, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		role, ok := requireRole(db, w, r, "commenter")
		if !ok {
			return
		}
		tid, _, ok := threadIn(db, r.PathValue("id"), r.PathValue("tid"))
		if !ok {
			jsonError(w, http.StatusNotFound, "not found")
			return
		}
		var opener int64
		if err := db.QueryRow("SELECT created_by FROM comment_threads WHERE id = ?", tid).Scan(&opener); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if opener != currentUser(r).ID && role != "owner" {
			jsonError(w, http.StatusForbidden, "only the thread's author or the document owner can delete it")
			return
		}
		if _, err := db.Exec("DELETE FROM comment_threads WHERE id = ?", tid); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		h.notifyComments(r.PathValue("id"))
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// commentAuthor reads a comment's author, scoped to its thread so a comment id
// from elsewhere cannot be reached by pairing it with a thread you can see.
func commentAuthor(db *sql.DB, tid int64, rawCID string) (int64, error) {
	cid, err := strconv.ParseInt(rawCID, 10, 64)
	if err != nil {
		return 0, errors.New("bad comment id")
	}
	var author int64
	err = db.QueryRow("SELECT author_id FROM comments WHERE id = ? AND thread_id = ?", cid, tid).Scan(&author)
	return author, err
}

func validBody(w http.ResponseWriter, body string) bool {
	if body == "" {
		jsonError(w, http.StatusBadRequest, "comment body required")
		return false
	}
	if len(body) > maxCommentBody {
		jsonError(w, http.StatusBadRequest, "comment is too long")
		return false
	}
	return true
}
