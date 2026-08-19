package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"errors"
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
	Rich bool `json:"rich"`
	// The folder this document sits in, or null — either because it sits in
	// none, or because it sits in one you hold no grant on. The list nulls the
	// second case out rather than reporting an id you cannot resolve: an
	// opaque id you cannot look up still tells you which documents are filed
	// together, and that is a fact about somebody else's filing.
	FolderID *string `json:"folder_id"`
	Role     string  `json:"role"`
	// Unresolved comment threads. Counted per row in the list query rather
	// than fetched per document by the client, which would be one request per
	// row — see DESIGN-DECISIONS.md, *Notifications*.
	OpenComments int   `json:"open_comments"`
	UpdatedAt    int64 `json:"updated_at"`
}

var docIDEnc = base32.StdEncoding.WithPadding(base32.NoPadding)

// newID mints an opaque identifier for anything the URL space names: documents
// and, since folders arrived, folders. One generator rather than two, because
// two would differ only in the name of the function and in which one somebody
// forgot to seed properly.
func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return strings.ToLower(docIDEnc.EncodeToString(b))
}

// roleRank orders access levels, least to most. `commenter` sits above viewer
// because it grants a write — to the comment tables, over HTTP, never into the
// Yjs log — and below editor, which is the first role allowed to change
// document content. `manager` sits above editor and below owner: it holds every
// owner power except the two that cannot be undone, deleting the document and
// transferring it. See DESIGN-DECISIONS.md, *Ownership: one owner, one deputy
// rank*.
//
// Anything comparing roles must go through this map rather than test for a role
// by name, or adding a level silently widens access. That is not a caution, it
// is a bug report: `manager` went in above `editor` and the two share-link
// endpoints, which rejected `owner` by name, would have started minting manager
// links — the one role a bearer token must never carry.
var roleRank = map[string]int{"viewer": 0, "commenter": 1, "editor": 2, "manager": 3, "owner": 4}

// The two rules deciding who may hand out what, both rank comparisons so that
// the next level added needs no edit here. See DESIGN-DECISIONS.md, *Grant up
// to your own rank; modify strictly below it*.
//
// mayGrant cannot fire today: the highest grantable role is `manager` and only
// managers and owners reach the endpoints that call it. It is here so that a
// level added above `manager` is refused by default rather than granted by
// default, which is the failure this codebase has now had twice.
func mayGrant(actor, role string) bool { return roleRank[role] <= roleRank[actor] }

// mayModify is the half that does real work: a manager can create peers but
// cannot demote or remove one, and nobody but the owner can touch the owner.
// Creating a peer is recoverable by the owner, so it is the safe half to allow;
// removing one is not, so it is the half withheld. `target` is "" for somebody
// with no access yet, which every caller handles before asking.
func mayModify(actor, target string) bool { return roleRank[target] < roleRank[actor] }

// roleFor returns the caller's role on a document, or "" for no access.
//
// Since folders, a role can arrive two ways: granted on the document, or
// granted on a folder above it. The best of them wins — access adds, never
// subtracts — so this is one query returning every candidate and one reduction
// through bestRole. Ranking in SQL would be a second copy of roleRank.
//
// Almost every access check in the codebase reaches this function, which is
// why inheritance could be added at all without auditing thirty call sites.
// The four queries that join `permissions` directly rather than coming through
// here are listed in DESIGN-DECISIONS.md, *Folders*, and all four now use
// visibleDocsSQL instead.
func roleFor(db *sql.DB, docID string, userID int64) (string, error) {
	rows, err := db.Query(`
		WITH RECURSIVE anc(id) AS (
			SELECT folder_id FROM documents WHERE id = ?
			UNION
			SELECT f.parent_id FROM folders f JOIN anc ON f.id = anc.id
			WHERE f.parent_id IS NOT NULL
		)
		SELECT role FROM permissions WHERE doc_id = ? AND user_id = ?
		UNION ALL
		SELECT fp.role FROM folder_permissions fp
		JOIN anc ON anc.id = fp.folder_id
		WHERE fp.user_id = ?`, docID, docID, userID, userID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	best := ""
	for rows.Next() {
		var role string
		if err := rows.Scan(&role); err != nil {
			return "", err
		}
		best = bestRole(best, role)
	}
	return best, rows.Err()
}

// directRoleFor is the grant on the document itself, ignoring folders. Used
// only where a *grant* is being administered rather than access being checked:
// withdrawing a share has to know whether there is a row here to withdraw, or
// it reports success and changes nothing.
func directRoleFor(db *sql.DB, docID string, userID int64) (string, error) {
	var role string
	err := db.QueryRow("SELECT role FROM permissions WHERE doc_id = ? AND user_id = ?", docID, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
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
			// Optional. Creating straight into a folder needs `editor` on it,
			// the same bar as moving one in: putting a document where a
			// folder's members can read it is filling the folder, not shaping
			// it. See folders.go.
			FolderID *string `json:"folder_id"`
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
		folderID := ""
		if in.FolderID != nil {
			folderID = *in.FolderID
		}
		if folderID != "" {
			role, err := folderRoleFor(db, folderID, u.ID)
			if err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			if role == "" || roleRank[role] < roleRank["editor"] {
				jsonError(w, http.StatusNotFound, "not found")
				return
			}
		}
		id := newID()
		now := time.Now().Unix()
		tx, err := db.Begin()
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer tx.Rollback()
		// No owner column: the owner is the `permissions` row below, and that is
		// the only place it is recorded. See schema v11.
		var folderArg any
		if folderID != "" {
			folderArg = folderID
		}
		if _, err := tx.Exec("INSERT INTO documents (id, kind, title, folder_id, created_at, updated_at) VALUES (?,?,?,?,?,?)",
			id, in.Kind, in.Title, folderArg, now, now); err != nil {
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
		out := document{ID: id, Kind: in.Kind, Title: in.Title, Role: "owner", UpdatedAt: now}
		if folderID != "" {
			out.FolderID = &folderID
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func handleListDocs(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		// Access descends from the folders this user holds a grant on, and is
		// unioned with the grants made on documents directly. A document
		// reached both ways arrives twice, at two roles, and is reduced below —
		// the ordering lives in roleRank and is not restated in SQL.
		rows, err := db.Query(grantedFoldersSQL+`, access(doc_id, role) AS (
				SELECT doc_id, role FROM permissions WHERE user_id = ?
				UNION ALL
				SELECT d.id, g.role FROM documents d JOIN granted g ON g.id = d.folder_id
			)
			SELECT d.id, d.kind, d.title, d.rich,
			       CASE WHEN d.folder_id IN (SELECT id FROM granted) THEN d.folder_id END,
			       a.role,
			       (SELECT COUNT(*) FROM comment_threads t
			         WHERE t.doc_id = d.id AND t.resolved_at IS NULL) AS open_comments,
			       d.updated_at
			FROM access a JOIN documents d ON d.id = a.doc_id
			ORDER BY d.updated_at DESC`, u.ID, u.ID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer rows.Close()
		docs := []document{}
		at := map[string]int{}
		for rows.Next() {
			var d document
			var folderID sql.NullString
			if err := rows.Scan(&d.ID, &d.Kind, &d.Title, &d.Rich, &folderID, &d.Role, &d.OpenComments, &d.UpdatedAt); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			if folderID.Valid {
				f := folderID.String
				d.FolderID = &f
			}
			if i, seen := at[d.ID]; seen {
				docs[i].Role = bestRole(docs[i].Role, d.Role)
				continue
			}
			at[d.ID] = len(docs)
			docs = append(docs, d)
		}
		if err := rows.Err(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
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

// DELETE /api/docs/{id} — owner only, and one of exactly two things a manager
// may not do. Deleting destroys the document and its whole history for
// everyone, which is the criterion: the owner keeps what is irreversible and
// total. Written as a rank check rather than the `role != "owner"` it used to
// be, so that no ownership test in the codebase is a name comparison.
func handleDeleteDoc(db *sql.DB, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if _, ok := requireRole(db, w, r, "owner"); !ok {
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
