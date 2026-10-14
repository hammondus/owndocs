package main

import (
	"database/sql"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Folders. A document lives in at most one folder, and a folder grants access
// to everything beneath it: your role on a document is the best of the grant on
// the document itself and the grants on every folder above it. See
// DESIGN-DECISIONS.md, *Folders*.
//
// Two rules run through this file and are worth having in mind before reading
// any single handler:
//
//   - **Best grant wins, and nothing subtracts.** There is no way to hold less
//     access to a subfolder than to its parent. Access only ever increases as
//     grants are added, so no grant can silently take something away, and there
//     is one rule to hold rather than two. The cost is real and stated in the
//     design notes: you cannot carve a more private folder inside a shared one.
//     Put it elsewhere instead.
//   - **Shaping the tree is administration; filling it is editing.** Creating,
//     renaming, moving and deleting folders needs `manager`; putting a document
//     into one needs `editor`. That split is why creating a subfolder mints no
//     new permission row — see handleCreateFolder.

const maxFolderName = 200

type folder struct {
	ID string `json:"id"`
	// Null when the parent is a folder you hold no grant on, which makes this
	// folder a root *for you*. Two people can therefore see the same folder at
	// different depths, and that is the point: a grant on `Falcon` must not
	// disclose that its parent is called `Acquisitions`.
	ParentID *string `json:"parent_id"`
	Name     string  `json:"name"`
	Role     string  `json:"role"`
}

// grantedFoldersSQL is the recursive descent from every folder you hold a grant
// on into everything below it, carrying the granting role down with it. One
// parameter: the user id.
//
// `UNION`, never `UNION ALL`. The recursion is over a structure a bug could
// make cyclic, and UNION drops rows already produced, so a cycle ends the
// walk instead of hanging the request. Cycles are also refused at the one
// place they could be created — see handleMoveFolder — but a hang is the kind
// of failure worth having two defences against.
//
// A folder reachable under two different roles yields two rows. Callers reduce
// with bestRole rather than ranking in SQL: `ORDER BY CASE role ...` would be
// a second copy of the ordering that lives in roleRank, and the copy furthest
// from anything that would notice it going stale.
const grantedFoldersSQL = `
	WITH RECURSIVE granted(id, role) AS (
		SELECT folder_id, role FROM folder_permissions WHERE user_id = ?
		UNION
		SELECT f.id, g.role FROM folders f JOIN granted g ON f.parent_id = g.id
	)`

// visibleDocsSQL answers "which documents may this user see at all", ignoring
// what they may do with them. Two parameters, both the user id. Prefixed to a
// query, it replaces the `JOIN permissions p ON p.doc_id = d.id AND p.user_id =
// ?` that every list used before folders existed.
//
// Being a prefix matters for the callers: a `WITH` clause comes first in the
// statement, so its two parameters come first in the argument list, ahead of
// anything the SELECT binds.
const visibleDocsSQL = `
	WITH RECURSIVE granted(id) AS (
		SELECT folder_id FROM folder_permissions WHERE user_id = ?
		UNION
		SELECT f.id FROM folders f JOIN granted g ON f.parent_id = g.id
	), visible(doc_id) AS (
		SELECT doc_id FROM permissions WHERE user_id = ?
		UNION
		SELECT d.id FROM documents d JOIN granted g ON g.id = d.folder_id
	)`

// ancestorsSQL walks up from one folder to the root, inclusive of the folder
// itself. One parameter: the folder id.
const ancestorsSQL = `
	WITH RECURSIVE anc(id) AS (
		SELECT ?
		UNION
		SELECT f.parent_id FROM folders f JOIN anc ON f.id = anc.id
		WHERE f.parent_id IS NOT NULL
	)`

// subtreeSQL walks down from one folder, inclusive. One parameter: the folder id.
const subtreeSQL = `
	WITH RECURSIVE sub(id) AS (
		SELECT ?
		UNION
		SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
	)`

// bestRole returns the higher-ranked of two roles, treating "" as no access.
// "" cannot be compared through roleRank — it ranks 0, the same as viewer — so
// it is tested for rather than ranked.
func bestRole(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	if roleRank[b] > roleRank[a] {
		return b
	}
	return a
}

// folderRoleFor is the folder equivalent of roleFor: the best grant the user
// holds on this folder or any folder above it, or "" for no access.
func folderRoleFor(db *sql.DB, folderID string, userID int64) (string, error) {
	if folderID == "" {
		return "", nil
	}
	rows, err := db.Query(ancestorsSQL+`
		SELECT fp.role FROM folder_permissions fp
		JOIN anc ON anc.id = fp.folder_id
		WHERE fp.user_id = ?`, folderID, userID)
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

// requireFolderRole is requireRole for folders: resolve the caller's role on
// {id} and 404 below the minimum. 404 rather than 403 for the same reason as
// documents — a folder you cannot reach should not be distinguishable from one
// that does not exist.
func requireFolderRole(db *sql.DB, w http.ResponseWriter, r *http.Request, min string) (string, bool) {
	role, err := folderRoleFor(db, r.PathValue("id"), currentUser(r).ID)
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

// docFolder returns the folder a document sits in, "" for none. A missing
// document comes back as sql.ErrNoRows rather than as "no folder"; every
// caller here has already passed a role check, so that error is a fault
// rather than an access answer.
func docFolder(db *sql.DB, docID string) (string, error) {
	var f sql.NullString
	err := db.QueryRow("SELECT folder_id FROM documents WHERE id = ?", docID).Scan(&f)
	if err != nil {
		return "", err
	}
	return f.String, nil
}

// docsUnder lists every document in a folder's subtree, whoever owns it. Used
// to re-check live sockets after a grant changes, and to refuse deleting a
// folder that still holds something.
func docsUnder(db *sql.DB, folderID string) ([]string, error) {
	rows, err := db.Query(subtreeSQL+`
		SELECT d.id FROM documents d JOIN sub ON sub.id = d.folder_id`, folderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// recheckUnder re-reads every live socket's role on every document beneath a
// folder. Called after anything that changes what a folder grants: an editor
// downgraded through a folder must lose write access now, not at their next
// reload, which is the rule sharing has always followed on documents.
func recheckUnder(db *sql.DB, h *hub, folderID string) {
	ids, err := docsUnder(db, folderID)
	if err != nil {
		return
	}
	for _, id := range ids {
		h.recheckAccess(id)
	}
}

// folderGrant is one folder handing one person a role — the answer to "why can
// they see this?", which the share panel has to give once access can arrive
// from somewhere other than the document.
type folderGrant struct {
	FolderID string
	Name     string
	Role     string
}

// chainGrants lists the grants one user holds on a folder and its ancestors,
// nearest first. Empty folderID (a document filed nowhere) yields nothing.
func chainGrants(db *sql.DB, folderID string, userID int64) ([]folderGrant, error) {
	if folderID == "" {
		return nil, nil
	}
	rows, err := db.Query(ancestorsSQL+`
		SELECT f.id, f.name, fp.role
		FROM folder_permissions fp
		JOIN anc ON anc.id = fp.folder_id
		JOIN folders f ON f.id = fp.folder_id
		WHERE fp.user_id = ?`, folderID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []folderGrant{}
	for rows.Next() {
		var g folderGrant
		if err := rows.Scan(&g.FolderID, &g.Name, &g.Role); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// bestGrant picks the folder grant that actually decides someone's access.
func bestGrant(gs []folderGrant) (folderGrant, bool) {
	var best folderGrant
	found := false
	for _, g := range gs {
		if !found || roleRank[g.Role] > roleRank[best.Role] {
			best, found = g, true
		}
	}
	return best, found
}

// ---- who gains access -----------------------------------------------------
//
// Filing a document and moving a folder both widen who can read something,
// and the people widened to are told by mail — see mail.go. Both helpers are
// called *before* the write: afterwards everyone in the destination has
// access, and the newcomers can no longer be told from the rest.

// chainUserIDs is everyone reaching a folder through a grant on it or on any
// folder above it, each once, never the actor.
func chainUserIDs(db *sql.DB, folderID string, actorID int64) ([]int64, error) {
	members, err := chainMembers(db, folderID)
	if err != nil {
		return nil, err
	}
	var ids []int64
	for _, s := range members {
		if s.UserID != actorID && !slices.Contains(ids, s.UserID) {
			ids = append(ids, s.UserID)
		}
	}
	return ids, nil
}

// newToDoc lists the people in a folder who cannot see a document yet. For a
// document being created it is everyone in the folder; for one being moved
// in, everyone who had no grant on it or on its old folder.
func newToDoc(db *sql.DB, folderID, docID string, actorID int64) ([]int64, error) {
	ids, err := chainUserIDs(db, folderID, actorID)
	if err != nil {
		return nil, err
	}
	var out []int64
	for _, uid := range ids {
		role, err := roleFor(db, docID, uid)
		if err != nil {
			return nil, err
		}
		if role == "" {
			out = append(out, uid)
		}
	}
	return out, nil
}

// newToFolder lists the people in a destination folder who cannot see the
// folder about to be moved into it.
func newToFolder(db *sql.DB, destID, folderID string, actorID int64) ([]int64, error) {
	ids, err := chainUserIDs(db, destID, actorID)
	if err != nil {
		return nil, err
	}
	var out []int64
	for _, uid := range ids {
		role, err := folderRoleFor(db, folderID, uid)
		if err != nil {
			return nil, err
		}
		if role == "" {
			out = append(out, uid)
		}
	}
	return out, nil
}

// ---- handlers -------------------------------------------------------------

// visibleFolders is every folder a user holds a grant on, plus everything
// below it. Flat; the client builds the tree from ParentID, which is nil for
// parents the user cannot see so that the forest is rooted at their own
// grants rather than at somebody else's. Shared by the list and by search.
func visibleFolders(db *sql.DB, userID int64) ([]folder, error) {
	rows, err := db.Query(grantedFoldersSQL+`
		SELECT f.id,
		       CASE WHEN f.parent_id IN (SELECT id FROM granted) THEN f.parent_id END,
		       f.name, g.role
		FROM granted g JOIN folders f ON f.id = g.id
		ORDER BY f.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// One row per (folder, granting role), so a folder reachable two ways
	// arrives twice. Reduced here, keeping first-seen order.
	byID := map[string]int{}
	out := []folder{}
	for rows.Next() {
		var f folder
		var parent sql.NullString
		if err := rows.Scan(&f.ID, &parent, &f.Name, &f.Role); err != nil {
			return nil, err
		}
		if parent.Valid {
			f.ParentID = new(parent.String)
		}
		if i, seen := byID[f.ID]; seen {
			out[i].Role = bestRole(out[i].Role, f.Role)
			continue
		}
		byID[f.ID] = len(out)
		out = append(out, f)
	}
	return out, rows.Err()
}

// folderPath names the folders above one, outermost first, as far up as the
// viewer can see. Walks the list visibleFolders returned, so a parent the
// viewer holds no grant on is simply not there and the path starts below it.
func folderPath(folders []folder, id string) []string {
	byID := map[string]folder{}
	for _, f := range folders {
		byID[f.ID] = f
	}
	var names []string
	for f, ok := byID[id]; ok && f.ParentID != nil; f, ok = byID[*f.ParentID] {
		p, ok := byID[*f.ParentID]
		if !ok {
			break
		}
		names = append(names, p.Name)
	}
	slices.Reverse(names)
	return names
}

// GET /api/folders — see visibleFolders.
func handleListFolders(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out, err := visibleFolders(db, currentUser(r).ID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// POST /api/folders {name, parent_id} — create a folder.
//
// A root folder is anyone's to make, and its maker gets `manager` on it. A
// subfolder needs `manager` on the parent and mints *no* permission row:
// whoever administers the parent administers the child, by inheritance.
//
// That asymmetry is deliberate and is the reason the bar for a subfolder is
// manager rather than editor. Writing a manager row for the creator of every
// subfolder would let an editor of a shared folder mint themselves an
// administrable corner inside it, and then share that corner outward. Silently
// widening access by adding a level is the mistake this codebase has already
// made twice — see roleRank — so the default here is to grant nothing.
func handleCreateFolder(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		var in struct {
			Name     string  `json:"name"`
			ParentID *string `json:"parent_id"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		name, ok := checkFolderName(w, in.Name)
		if !ok {
			return
		}
		parent := ""
		if in.ParentID != nil {
			parent = *in.ParentID
		}
		if parent != "" {
			role, err := folderRoleFor(db, parent, u.ID)
			if err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			if role == "" || roleRank[role] < roleRank["manager"] {
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
		if _, err := tx.Exec("INSERT INTO folders (id, parent_id, name, created_by, created_at) VALUES (?,?,?,?,?)",
			id, nilIfEmpty(parent), name, u.ID, now); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if parent == "" {
			if _, err := tx.Exec("INSERT INTO folder_permissions (folder_id, user_id, role) VALUES (?,?,'manager')", id, u.ID); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
		}
		if err := tx.Commit(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		f := folder{ID: id, Name: name, Role: "manager"}
		if parent != "" {
			f.ParentID = &parent
		}
		writeJSON(w, http.StatusOK, f)
	}
}

// PATCH /api/folders/{id} {name} — rename. Shaping the tree is administration,
// so the bar is manager, not the editor bar a document title sits at.
func handleUpdateFolder(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireFolderRole(db, w, r, "manager"); !ok {
			return
		}
		var in struct {
			Name string `json:"name"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		name, ok := checkFolderName(w, in.Name)
		if !ok {
			return
		}
		if _, err := db.Exec("UPDATE folders SET name = ? WHERE id = ?", name, r.PathValue("id")); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// POST /api/folders/{id}/move {parent_id} — re-parent a folder, or send it to
// the top with a null parent.
//
// Its own endpoint rather than a field on PATCH, because it is not a property
// edit: moving a folder changes who can read everything inside it. A rename and
// a re-parent sitting behind one verb would also sit behind one permission bar,
// and these two do not deserve the same one for long.
func handleMoveFolder(db *sql.DB, h *hub, mail *mailer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		id := r.PathValue("id")
		if _, ok := requireFolderRole(db, w, r, "manager"); !ok {
			return
		}
		var in struct {
			ParentID *string `json:"parent_id"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		parent := ""
		if in.ParentID != nil {
			parent = *in.ParentID
		}
		if parent == id {
			jsonError(w, http.StatusBadRequest, "a folder cannot contain itself")
			return
		}
		// Who gains access, read before the write for the reason newToFolder
		// gives. Read whether or not mail is configured: it is a handful of
		// queries on a rare action, and the alternative is a nil test at the
		// call site that the mailer's design exists to avoid.
		var newcomers []int64
		if parent != "" {
			role, err := folderRoleFor(db, parent, u.ID)
			if err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			if role == "" || roleRank[role] < roleRank["manager"] {
				jsonError(w, http.StatusNotFound, "not found")
				return
			}
			// A folder moved inside its own subtree detaches that subtree from
			// every root: nothing above it can reach it, so nobody can see it
			// and nobody can move it back. The recursive walks survive it —
			// they all use UNION — but survival is not the same as correctness.
			inside, err := isDescendant(db, id, parent)
			if err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			if inside {
				jsonError(w, http.StatusBadRequest, "cannot move a folder into itself")
				return
			}
			if newcomers, err = newToFolder(db, parent, id, u.ID); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
		}
		// Read before writing: the undo below needs where it came from, and
		// after the UPDATE that answer is gone.
		from, err := parentOf(db, id)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if _, err := db.Exec("UPDATE folders SET parent_id = ? WHERE id = ?", nilIfEmpty(parent), id); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		// Re-read the caller's own access at the new position and undo the move
		// if they just lost it. Access here is inherited, so a folder moved out
		// from under the grant that reached it becomes invisible to the person
		// who moved it — and to everyone else who reached it the same way.
		// Nobody could then move it back, which makes this the one refusal in
		// the folder model that exists to stop an irreversible accident.
		//
		// Done as a write-then-check rather than inside a transaction because
		// the check is folderRoleFor, which walks the tree as it now stands.
		// Asking it what the tree *would* look like would mean a second copy of
		// the walk that only the preview uses.
		after, err := folderRoleFor(db, id, u.ID)
		if err != nil || after == "" || roleRank[after] < roleRank["manager"] {
			db.Exec("UPDATE folders SET parent_id = ? WHERE id = ?", nilIfEmpty(from), id)
			jsonError(w, http.StatusForbidden, "moving it there would take away your own access to it")
			return
		}
		recheckUnder(db, h, id)
		mail.folderMoved(id, parent, newcomers, u.ID)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// DELETE /api/folders/{id} — only when nothing is inside.
//
// Never a cascade, and this is the one rule in the folder model that exists to
// protect somebody other than the caller. A folder's managers are not its
// documents' owners, and deleting a document is reserved for its owner because
// it is irreversible and total. A cascade here would hand that power to anyone
// administering a folder the document happens to sit in.
func handleDeleteFolder(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if _, ok := requireFolderRole(db, w, r, "manager"); !ok {
			return
		}
		// Counted over every row, not the ones the caller can see: "empty for
		// you" is not empty, and a delete that succeeded on that basis would
		// orphan documents belonging to people you cannot enumerate.
		var docs, subs int
		if err := db.QueryRow("SELECT COUNT(*) FROM documents WHERE folder_id = ?", id).Scan(&docs); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if err := db.QueryRow("SELECT COUNT(*) FROM folders WHERE parent_id = ?", id).Scan(&subs); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if docs > 0 || subs > 0 {
			jsonError(w, http.StatusConflict, "move what is inside it out first — deleting a folder never deletes documents")
			return
		}
		if _, err := db.Exec("DELETE FROM folders WHERE id = ?", id); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// POST /api/docs/{id}/move {folder_id} — file a document, or unfile it with a
// null folder.
//
// Two bars, because two different things are being asked for: `manager` on the
// document, since the move changes who may read it, and `editor` on the
// destination, since dropping a document into a folder is filling the folder
// rather than shaping it.
func handleMoveDoc(db *sql.DB, h *hub, mail *mailer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		docID := r.PathValue("id")
		if _, ok := requireRole(db, w, r, "manager"); !ok {
			return
		}
		var in struct {
			FolderID *string `json:"folder_id"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		dest := ""
		if in.FolderID != nil {
			dest = *in.FolderID
		}
		var newcomers []int64
		if dest != "" {
			role, err := folderRoleFor(db, dest, u.ID)
			if err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			if role == "" || roleRank[role] < roleRank["editor"] {
				jsonError(w, http.StatusNotFound, "not found")
				return
			}
			// Before the write, as handleMoveFolder does and for the same
			// reason. A direct share mails the person it reaches; filing a
			// document where people can read it is the same event for them,
			// so it mails too.
			if newcomers, err = newToDoc(db, dest, docID, u.ID); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
		}
		from, err := docFolder(db, docID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if _, err := db.Exec("UPDATE documents SET folder_id = ? WHERE id = ?", nilIfEmpty(dest), docID); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		// The same guard as moving a folder, and it has a second job here: a
		// folder's manager holds `manager` on every document inside it, so
		// without this they could move somebody else's document out of the
		// shared folder and into one only they can see. The owner's own row
		// survives any move, so an owner filing their own document is never
		// caught by this.
		if after, err := roleFor(db, docID, u.ID); err != nil || after == "" || roleRank[after] < roleRank["manager"] {
			db.Exec("UPDATE documents SET folder_id = ? WHERE id = ?", nilIfEmpty(from), docID)
			jsonError(w, http.StatusForbidden, "moving it there would take away your own access to it")
			return
		}
		// Everyone whose access came from the old folder has lost it, and
		// everyone in the new one has gained it at whatever rank it grants.
		h.recheckAccess(docID)
		mail.filed(docID, dest, newcomers, u.ID)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// ---- folder sharing -------------------------------------------------------

// GET /api/folders/{id}/shares — who reaches this folder, and from where.
func handleListFolderShares(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireFolderRole(db, w, r, "viewer"); !ok {
			return
		}
		id := r.PathValue("id")
		direct, err := directFolderShares(db, id)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		parent, err := parentOf(db, id)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		inherited, err := chainMembers(db, parent)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, mergeShares(direct, inherited))
	}
}

// POST /api/folders/{id}/shares {email, role} — grant on a folder.
func handleAddFolderShare(db *sql.DB, h *hub, mail *mailer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := requireFolderRole(db, w, r, "manager")
		if !ok {
			return
		}
		id := r.PathValue("id")
		var in struct {
			Email string `json:"email"`
			Role  string `json:"role"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		// No folder owner to hand out, by the schema's CHECK and for the reason
		// recorded there: ownership is per-document and singular.
		if _, known := roleRank[in.Role]; !known || in.Role == "owner" {
			jsonError(w, http.StatusBadRequest, "role must be manager, editor, commenter or viewer")
			return
		}
		if !mayGrant(actor, in.Role) {
			jsonError(w, http.StatusForbidden, "you cannot grant a role above your own")
			return
		}
		uid, ok := userByEmail(db, w, in.Email)
		if !ok {
			return
		}
		existing, err := folderRoleFor(db, id, uid)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if existing != "" && !mayModify(actor, existing) {
			jsonError(w, http.StatusForbidden, "you cannot change access for somebody at or above your own level")
			return
		}
		if _, err := db.Exec("INSERT OR REPLACE INTO folder_permissions (folder_id, user_id, role) VALUES (?,?,?)",
			id, uid, in.Role); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		recheckUnder(db, h, id)
		// Only a first grant is news, by the rule handleAddShare follows: a
		// role change on a folder somebody already reaches is bookkeeping.
		if existing == "" {
			mail.folderShared(id, uid, currentUser(r).ID, in.Role)
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// DELETE /api/folders/{id}/shares/{uid} — withdraw a grant on a folder.
func handleRemoveFolderShare(db *sql.DB, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := requireFolderRole(db, w, r, "manager")
		if !ok {
			return
		}
		id := r.PathValue("id")
		uid, err := strconv.ParseInt(r.PathValue("uid"), 10, 64)
		if err != nil {
			jsonError(w, http.StatusBadRequest, "bad user id")
			return
		}
		role, err := folderRoleFor(db, id, uid)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if !mayModify(actor, role) {
			jsonError(w, http.StatusForbidden, "you cannot remove somebody at or above your own level")
			return
		}
		var direct string
		err = db.QueryRow("SELECT role FROM folder_permissions WHERE folder_id = ? AND user_id = ?", id, uid).Scan(&direct)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if errors.Is(err, sql.ErrNoRows) {
			// Their access is somebody else's grant, further up. Deleting here
			// would report success and change nothing, which is the worst of
			// the available answers.
			if msg, ok := inheritedRefusal(db, parentOfOrEmpty(db, id), uid); ok {
				jsonError(w, http.StatusConflict, msg)
				return
			}
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}
		if _, err := db.Exec("DELETE FROM folder_permissions WHERE folder_id = ? AND user_id = ?", id, uid); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		recheckUnder(db, h, id)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// ---- shared helpers -------------------------------------------------------

// nilIfEmpty is how "no folder" reaches SQLite. An empty string is a perfectly
// good TEXT value and would satisfy the foreign key against nothing, so the
// distinction has to survive all the way to the driver as a real NULL.
func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func checkFolderName(w http.ResponseWriter, name string) (string, bool) {
	name = strings.TrimSpace(name)
	if name == "" {
		jsonError(w, http.StatusBadRequest, "name required")
		return "", false
	}
	if len(name) > maxFolderName {
		jsonError(w, http.StatusBadRequest, "name is too long")
		return "", false
	}
	return name, true
}

func userByEmail(db *sql.DB, w http.ResponseWriter, email string) (int64, bool) {
	var uid int64
	err := db.QueryRow("SELECT id FROM users WHERE email = ?", strings.ToLower(strings.TrimSpace(email))).Scan(&uid)
	if errors.Is(err, sql.ErrNoRows) {
		jsonError(w, http.StatusNotFound, "no account with that email — they need to sign up first")
		return 0, false
	}
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "db error")
		return 0, false
	}
	return uid, true
}

func parentOf(db *sql.DB, folderID string) (string, error) {
	var p sql.NullString
	err := db.QueryRow("SELECT parent_id FROM folders WHERE id = ?", folderID).Scan(&p)
	if err != nil {
		return "", err
	}
	return p.String, nil
}

func parentOfOrEmpty(db *sql.DB, folderID string) string {
	p, err := parentOf(db, folderID)
	if err != nil {
		return ""
	}
	return p
}

// isDescendant reports whether `candidate` sits anywhere below `root`.
func isDescendant(db *sql.DB, root, candidate string) (bool, error) {
	var n int
	err := db.QueryRow(subtreeSQL+`SELECT COUNT(*) FROM sub WHERE sub.id = ?`, root, candidate).Scan(&n)
	return n > 0, err
}

// inheritedRefusal builds the message for a grant that cannot be withdrawn
// here because it was made further up. Returns false when there is nothing
// inherited, which makes the delete a harmless no-op instead.
func inheritedRefusal(db *sql.DB, chainFrom string, uid int64) (string, bool) {
	gs, err := chainGrants(db, chainFrom, uid)
	if err != nil || len(gs) == 0 {
		return "", false
	}
	g, _ := bestGrant(gs)
	return "their access comes from the folder \"" + g.Name + "\" — remove them there", true
}

// directFolderShares reads the grants made on one folder itself.
func directFolderShares(db *sql.DB, folderID string) ([]shareEntry, error) {
	rows, err := db.Query(`
		SELECT u.id, u.email, u.name, fp.role
		FROM folder_permissions fp JOIN users u ON u.id = fp.user_id
		WHERE fp.folder_id = ? ORDER BY u.name`, folderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []shareEntry{}
	for rows.Next() {
		var s shareEntry
		if err := rows.Scan(&s.UserID, &s.Email, &s.Name, &s.Role); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// chainMembers lists everyone reaching a folder chain through a folder grant,
// carrying the folder that granted it. This is what makes a share panel honest
// once access can arrive from above: without it the panel lists three people
// and the document is readable by thirty.
func chainMembers(db *sql.DB, folderID string) ([]shareEntry, error) {
	if folderID == "" {
		return nil, nil
	}
	rows, err := db.Query(ancestorsSQL+`
		SELECT u.id, u.email, u.name, fp.role, f.id, f.name
		FROM folder_permissions fp
		JOIN anc ON anc.id = fp.folder_id
		JOIN users u ON u.id = fp.user_id
		JOIN folders f ON f.id = fp.folder_id`, folderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []shareEntry{}
	for rows.Next() {
		var s shareEntry
		if err := rows.Scan(&s.UserID, &s.Email, &s.Name, &s.Role, &s.ViaFolder, &s.ViaFolderName); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// mergeShares folds direct grants and inherited ones into the list a share
// panel shows: one line per person, carrying the role that actually applies and
// — when that role came from a folder — which folder to go to in order to
// change it.
//
// Sorted by rank, most to least, through roleRank rather than a CASE in SQL.
// Same reason as handleListShares: the ordering lives in one map, and a copy in
// a query is the copy nothing would notice going stale.
func mergeShares(direct, inherited []shareEntry) []shareEntry {
	byUser := map[int64]int{}
	out := []shareEntry{}
	for _, s := range direct {
		byUser[s.UserID] = len(out)
		out = append(out, s)
	}
	for _, s := range inherited {
		i, seen := byUser[s.UserID]
		if !seen {
			byUser[s.UserID] = len(out)
			out = append(out, s)
			continue
		}
		// A direct grant already exists. It wins only if it ranks higher; when
		// the folder grant is the one in force, the panel must point at the
		// folder, because withdrawing the direct grant would change nothing.
		if roleRank[s.Role] > roleRank[out[i].Role] {
			out[i].Role = s.Role
			out[i].ViaFolder, out[i].ViaFolderName = s.ViaFolder, s.ViaFolderName
		}
	}
	slices.SortStableFunc(out, func(a, b shareEntry) int {
		if d := roleRank[b.Role] - roleRank[a.Role]; d != 0 {
			return d
		}
		return strings.Compare(a.Name, b.Name)
	})
	return out
}
