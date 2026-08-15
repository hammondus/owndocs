package main

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Sharing: per-user roles granted by the owner, plus capability share links.
// Revoking or downgrading access evicts live connections — enforcement is
// server-side, not just hidden UI.

type shareEntry struct {
	UserID int64  `json:"user_id"`
	Email  string `json:"email"`
	Name   string `json:"name"`
	Role   string `json:"role"`
}

// GET /api/docs/{id}/shares — collaborator list; visible to any member.
func handleListShares(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "viewer"); !ok {
			return
		}
		rows, err := db.Query(`
			SELECT u.id, u.email, u.name, p.role
			FROM permissions p JOIN users u ON u.id = p.user_id
			WHERE p.doc_id = ? ORDER BY u.name`, r.PathValue("id"))
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer rows.Close()
		shares := []shareEntry{}
		for rows.Next() {
			var s shareEntry
			if err := rows.Scan(&s.UserID, &s.Email, &s.Name, &s.Role); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			shares = append(shares, s)
		}
		// Ordered by rank, most to least, which is the order the share panel
		// reads in and the order the roles were designed in. `ORDER BY p.role`
		// was alphabetical, so the list ran commenter, editor, owner, viewer —
		// coincidence, not meaning, and adding `manager` put it fourth.
		//
		// Sorted here rather than with a CASE in the SQL on purpose: a CASE
		// would be a *third* hand-written copy of the rank order, after
		// docs_api.go and roles.js, and the one furthest from anything that
		// would notice it going stale. The query orders by name; this reorders
		// the small result by the one map that already exists.
		slices.SortStableFunc(shares, func(a, b shareEntry) int {
			return roleRank[b.Role] - roleRank[a.Role]
		})
		writeJSON(w, http.StatusOK, shares)
	}
}

// POST /api/docs/{id}/shares {email, role} — a manager or owner grants or
// changes a role.
func handleAddShare(db *sql.DB, h *hub, mail *mailer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := requireRole(db, w, r, "manager")
		if !ok {
			return
		}
		docID := r.PathValue("id")
		var in struct {
			Email string `json:"email"`
			Role  string `json:"role"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		// `owner` is not a thing to hand out — there is exactly one and it moves
		// only through POST /transfer, which also demotes the outgoing owner in
		// the same transaction. Granting it here would produce two.
		if _, known := roleRank[in.Role]; !known || in.Role == "owner" {
			jsonError(w, http.StatusBadRequest, "role must be manager, editor, commenter or viewer")
			return
		}
		if !mayGrant(actor, in.Role) {
			jsonError(w, http.StatusForbidden, "you cannot grant a role above your own")
			return
		}
		var uid int64
		err := db.QueryRow("SELECT id FROM users WHERE email = ?", strings.ToLower(strings.TrimSpace(in.Email))).Scan(&uid)
		if errors.Is(err, sql.ErrNoRows) {
			jsonError(w, http.StatusNotFound, "no account with that email — they need to sign up first")
			return
		}
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		existing, err := roleFor(db, docID, uid)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		// An existing grant may only be changed by somebody ranked strictly
		// above its holder, which is what keeps two managers from being one
		// coup apart and keeps everybody off the owner. A *new* grant has no
		// holder to outrank, so it falls through.
		if existing != "" && !mayModify(actor, existing) {
			jsonError(w, http.StatusForbidden, "you cannot change access for somebody at or above your own level")
			return
		}
		if _, err := db.Exec("INSERT OR REPLACE INTO permissions (doc_id, user_id, role) VALUES (?,?,?)",
			docID, uid, in.Role); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		// Role changed: evict live connections so the new role applies on
		// reconnect (an editor downgraded to viewer must lose write NOW).
		if existing != "" && existing != in.Role {
			h.evictUser(docID, uid)
		}
		// Only a *new* grant is news. Changing somebody's role on a document
		// they already have is bookkeeping, and mailing it would train people
		// to ignore the ones that matter.
		if existing == "" {
			mail.shared(docID, uid, currentUser(r).ID, in.Role)
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// DELETE /api/docs/{id}/shares/{uid} — a manager or owner revokes access.
func handleRemoveShare(db *sql.DB, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := requireRole(db, w, r, "manager")
		if !ok {
			return
		}
		docID := r.PathValue("id")
		uid, err := strconv.ParseInt(r.PathValue("uid"), 10, 64)
		if err != nil {
			jsonError(w, http.StatusBadRequest, "bad user id")
			return
		}
		role, err := roleFor(db, docID, uid)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		// One rule where there used to be a name test, and it now covers three
		// cases instead of one: the owner is untouchable, a manager cannot
		// remove a peer, and neither can remove themselves.
		if !mayModify(actor, role) {
			jsonError(w, http.StatusForbidden, "you cannot remove somebody at or above your own level")
			return
		}
		if _, err := db.Exec("DELETE FROM permissions WHERE doc_id = ? AND user_id = ?", docID, uid); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		h.evictUser(docID, uid)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// POST /api/docs/{id}/transfer {user_id} — the owner hands the document over
// and becomes a manager. Owner-only, and the second of the two things a manager
// may not do: transferring surrenders the power to undo anything, which is the
// criterion for what stays with the owner.
//
// The target must already hold a permission on the document. That keeps this a
// change of rank rather than a grant and a transfer at once, and it means the
// owner has already deliberately shared with the person, which is a natural
// confirmation step rather than an invented one.
//
// The outgoing owner lands on `manager`, not `editor`: transfer usually means
// "you run this now", not "I am locked out of the thing I built". No acceptance
// handshake — see DESIGN-DECISIONS.md for why, and for the sharp edge that
// comes with it: this is the one action its own actor cannot undo.
func handleTransferOwnership(db *sql.DB, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "owner"); !ok {
			return
		}
		docID := r.PathValue("id")
		me := currentUser(r).ID
		var in struct {
			UserID int64 `json:"user_id"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		if in.UserID == me {
			jsonError(w, http.StatusBadRequest, "you already own this document")
			return
		}
		target, err := roleFor(db, docID, in.UserID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if target == "" {
			jsonError(w, http.StatusBadRequest, "share the document with them first, then transfer it")
			return
		}
		// Both writes or neither: a half-applied transfer leaves a document with
		// two owners or none, and neither has a repair path short of SQL.
		tx, err := db.Begin()
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer tx.Rollback()
		if _, err := tx.Exec("UPDATE permissions SET role = 'owner' WHERE doc_id = ? AND user_id = ?", docID, in.UserID); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if _, err := tx.Exec("UPDATE permissions SET role = 'manager' WHERE doc_id = ? AND user_id = ?", docID, me); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if err := tx.Commit(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		// Both parties are evicted, for a reason the other role changes do not
		// have: neither person's *write* access changed, so nothing would force
		// a reconnect, and both clients would keep showing a stale role — one
		// still offering delete, the other not offering it yet. The role is read
		// on reconnect, so closing the socket is what refreshes it.
		h.evictUser(docID, in.UserID)
		h.evictUser(docID, me)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

type shareLink struct {
	ID        int64  `json:"id"`
	Role      string `json:"role"`
	CreatedAt int64  `json:"created_at"`
	Token     string `json:"token,omitempty"` // present only on creation
}

// POST /api/docs/{id}/links {role} — a manager or owner mints a share link. The
// token is returned exactly once; only its hash is stored.
func handleCreateLink(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "manager"); !ok {
			return
		}
		var in struct {
			Role string `json:"role"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		// Capped at editor, and expressed as a rank rather than the "not owner"
		// name test this used to be. A link is a bearer token: whoever holds the
		// URL gets the role, and by design nobody knows who that is — so a
		// manager link would hand anyone who saw it the power to revoke the
		// owner's collaborators. The `share_links` CHECK constraint says the
		// same thing one layer down.
		if _, known := roleRank[in.Role]; !known || roleRank[in.Role] > roleRank["editor"] {
			jsonError(w, http.StatusBadRequest, "a link may grant editor, commenter or viewer")
			return
		}
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			jsonError(w, http.StatusInternalServerError, "entropy failure")
			return
		}
		token := base64.RawURLEncoding.EncodeToString(raw)
		hash := sha256.Sum256([]byte(token))
		now := time.Now().Unix()
		res, err := db.Exec("INSERT INTO share_links (doc_id, token_hash, role, created_by, created_at) VALUES (?,?,?,?,?)",
			r.PathValue("id"), hash[:], in.Role, currentUser(r).ID, now)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		id, _ := res.LastInsertId()
		writeJSON(w, http.StatusOK, shareLink{ID: id, Role: in.Role, CreatedAt: now, Token: token})
	}
}

// GET /api/docs/{id}/links — a manager or owner lists active links (no tokens).
func handleListLinks(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "manager"); !ok {
			return
		}
		rows, err := db.Query("SELECT id, role, created_at FROM share_links WHERE doc_id = ? ORDER BY id", r.PathValue("id"))
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer rows.Close()
		links := []shareLink{}
		for rows.Next() {
			var l shareLink
			if err := rows.Scan(&l.ID, &l.Role, &l.CreatedAt); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			links = append(links, l)
		}
		writeJSON(w, http.StatusOK, links)
	}
}

// DELETE /api/docs/{id}/links/{lid} — a manager or owner revokes a link. Roles
// already redeemed through it survive; revocation stops future redemptions.
func handleDeleteLink(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "manager"); !ok {
			return
		}
		if _, err := db.Exec("DELETE FROM share_links WHERE doc_id = ? AND id = ?",
			r.PathValue("id"), r.PathValue("lid")); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// POST /api/share/redeem {token} — a signed-in user redeems a share link.
// Grants the link's role, upgrading viewer→editor but never touching an
// owner and never downgrading. Returns the document for the client to open.
func handleRedeemLink(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		var in struct {
			Token string `json:"token"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		hash := sha256.Sum256([]byte(in.Token))
		var docID, linkRole string
		err := db.QueryRow("SELECT doc_id, role FROM share_links WHERE token_hash = ?", hash[:]).Scan(&docID, &linkRole)
		if errors.Is(err, sql.ErrNoRows) {
			jsonError(w, http.StatusNotFound, "link is invalid or has been revoked")
			return
		}
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		existing, err := roleFor(db, docID, u.ID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		// A link only ever raises access. Rank-compared rather than
		// enumerated, so redeeming a commenter link as an editor cannot
		// demote you, and no link can touch an owner.
		grant := existing == "" || roleRank[linkRole] > roleRank[existing]
		if grant {
			if _, err := db.Exec("INSERT OR REPLACE INTO permissions (doc_id, user_id, role) VALUES (?,?,?)",
				docID, u.ID, linkRole); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			existing = linkRole
		}
		var d document
		err = db.QueryRow("SELECT id, kind, title, rich, updated_at FROM documents WHERE id = ?", docID).
			Scan(&d.ID, &d.Kind, &d.Title, &d.Rich, &d.UpdatedAt)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		d.Role = existing
		writeJSON(w, http.StatusOK, d)
	}
}
