package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"net/http"
	"strings"
	"time"
)

type document struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Title string `json:"title"`
	// Whether this document's appearance constructs are turned on. A property
	// of the document, like its title, rather than content inside it — which is
	// why it rides here and is written over HTTP, not through the Yjs log. See
	// DESIGN-DECISIONS.md, *Rich documents*.
	Rich bool   `json:"rich"`
	Role string `json:"role"`
	// Unresolved comment threads. Counted per row in the list query rather
	// than fetched per document by the client, which would be one request per
	// row — see DESIGN-DECISIONS.md, *Notifications*.
	OpenComments int   `json:"open_comments"`
	UpdatedAt    int64 `json:"updated_at"`
}

var docIDEnc = base32.StdEncoding.WithPadding(base32.NoPadding)

func newDocID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return strings.ToLower(docIDEnc.EncodeToString(b))
}

// roleRank orders access levels, least to most. `commenter` sits above viewer
// because it grants a write — to the comment tables, over HTTP, never into the
// Yjs log — and below editor, which is the first role allowed to change
// document content. Anything comparing roles must go through this map rather
// than test for a role by name, or adding a level silently widens access.
var roleRank = map[string]int{"viewer": 0, "commenter": 1, "editor": 2, "owner": 3}

// roleFor returns the caller's role on a document, or "" for no access.
func roleFor(db *sql.DB, docID string, userID int64) (string, error) {
	var role string
	err := db.QueryRow("SELECT role FROM permissions WHERE doc_id = ? AND user_id = ?", docID, userID).Scan(&role)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return role, err
}

func handleCreateDoc(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		var in struct {
			Title string `json:"title"`
			Kind  string `json:"kind"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		if in.Kind == "" {
			in.Kind = "doc"
		}
		if in.Kind != "doc" && in.Kind != "sheet" {
			jsonError(w, http.StatusBadRequest, "kind must be doc or sheet")
			return
		}
		in.Title = strings.TrimSpace(in.Title)
		if in.Title == "" {
			in.Title = "Untitled"
		}
		id := newDocID()
		now := time.Now().Unix()
		tx, err := db.Begin()
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer tx.Rollback()
		if _, err := tx.Exec("INSERT INTO documents (id, kind, title, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?)",
			id, in.Kind, in.Title, u.ID, now, now); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if _, err := tx.Exec("INSERT INTO permissions (doc_id, user_id, role) VALUES (?,?,'owner')", id, u.ID); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if err := tx.Commit(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, document{ID: id, Kind: in.Kind, Title: in.Title, Role: "owner", UpdatedAt: now})
	}
}

func handleListDocs(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		rows, err := db.Query(`
			SELECT d.id, d.kind, d.title, d.rich, p.role,
			       (SELECT COUNT(*) FROM comment_threads t
			         WHERE t.doc_id = d.id AND t.resolved_at IS NULL) AS open_comments,
			       d.updated_at
			FROM documents d JOIN permissions p ON p.doc_id = d.id
			WHERE p.user_id = ? ORDER BY d.updated_at DESC`, u.ID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer rows.Close()
		docs := []document{}
		for rows.Next() {
			var d document
			if err := rows.Scan(&d.ID, &d.Kind, &d.Title, &d.Rich, &d.Role, &d.OpenComments, &d.UpdatedAt); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			docs = append(docs, d)
		}
		writeJSON(w, http.StatusOK, docs)
	}
}

// PATCH /api/docs/{id} — the document's own properties, as opposed to its
// content. Two of them so far, and both are here rather than in the Yjs log
// for the same reason: they describe the document rather than living inside
// it, so they are an ordinary HTTP write. See DESIGN-DECISIONS.md, *Renaming*
// and *Rich documents*.
//
// Pointers, so "absent" and "empty" are different questions. A rename sends
// only `title`; flipping the flag sends only `rich`; neither has to know the
// other exists, and sending an empty title stays the error it always was
// rather than silently becoming a no-op.
func handleUpdateDoc(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		id := r.PathValue("id")
		var in struct {
			Title *string `json:"title"`
			Rich  *bool   `json:"rich"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		if in.Title == nil && in.Rich == nil {
			jsonError(w, http.StatusBadRequest, "nothing to update")
			return
		}
		if in.Title != nil {
			t := strings.TrimSpace(*in.Title)
			if t == "" {
				jsonError(w, http.StatusBadRequest, "title required")
				return
			}
			in.Title = &t
		}
		role, err := roleFor(db, id, u.ID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		// Rank-compared, not name-tested: a title is document content in every
		// sense that matters, so the bar is "may edit". Adding `commenter`
		// broke three equality tests written like this one — see roleRank.
		//
		// The rich flag sits at the same bar, and deliberately not at owner's.
		// It changes what an editor may insert, and anyone who may write the
		// document's text may already type the syntax by hand — the flag
		// governs which buttons are offered, not what the format permits.
		if roleRank[role] < roleRank["editor"] {
			jsonError(w, http.StatusNotFound, "not found")
			return
		}
		// Built rather than branched, so adding a third property does not
		// multiply the statements.
		sets, args := []string{}, []any{}
		if in.Title != nil {
			sets = append(sets, "title = ?")
			args = append(args, *in.Title)
		}
		if in.Rich != nil {
			sets = append(sets, "rich = ?")
			args = append(args, *in.Rich)
		}
		sets = append(sets, "updated_at = ?")
		args = append(args, time.Now().Unix(), id)
		if _, err := db.Exec("UPDATE documents SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func handleDeleteDoc(db *sql.DB, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		id := r.PathValue("id")
		role, err := roleFor(db, id, u.ID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if role != "owner" {
			jsonError(w, http.StatusNotFound, "not found")
			return
		}
		h.closeRoom(id) // disconnect live editors before their doc vanishes
		if _, err := db.Exec("DELETE FROM documents WHERE id = ?", id); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}
