package main

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
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
			WHERE p.doc_id = ? ORDER BY p.role, u.name`, r.PathValue("id"))
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
		writeJSON(w, http.StatusOK, shares)
	}
}

// POST /api/docs/{id}/shares {email, role} — owner grants or changes a role.
func handleAddShare(db *sql.DB, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "owner"); !ok {
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
		if in.Role != "editor" && in.Role != "viewer" {
			jsonError(w, http.StatusBadRequest, "role must be editor or viewer")
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
		if existing == "owner" {
			jsonError(w, http.StatusConflict, "cannot change the owner's role")
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
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// DELETE /api/docs/{id}/shares/{uid} — owner revokes access.
func handleRemoveShare(db *sql.DB, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "owner"); !ok {
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
		if role == "owner" {
			jsonError(w, http.StatusConflict, "cannot remove the owner")
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

type shareLink struct {
	ID        int64  `json:"id"`
	Role      string `json:"role"`
	CreatedAt int64  `json:"created_at"`
	Token     string `json:"token,omitempty"` // present only on creation
}

// POST /api/docs/{id}/links {role} — owner mints a share link. The token is
// returned exactly once; only its hash is stored.
func handleCreateLink(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "owner"); !ok {
			return
		}
		var in struct {
			Role string `json:"role"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		if in.Role != "editor" && in.Role != "viewer" {
			jsonError(w, http.StatusBadRequest, "role must be editor or viewer")
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

// GET /api/docs/{id}/links — owner lists active links (no tokens).
func handleListLinks(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "owner"); !ok {
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

// DELETE /api/docs/{id}/links/{lid} — owner revokes a link. Roles already
// redeemed through it survive; revocation stops future redemptions.
func handleDeleteLink(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requireRole(db, w, r, "owner"); !ok {
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
		grant := existing == "" ||
			(existing == "viewer" && linkRole == "editor")
		if grant {
			if _, err := db.Exec("INSERT OR REPLACE INTO permissions (doc_id, user_id, role) VALUES (?,?,?)",
				docID, u.ID, linkRole); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			existing = linkRole
		}
		var d document
		err = db.QueryRow("SELECT id, kind, title, updated_at FROM documents WHERE id = ?", docID).
			Scan(&d.ID, &d.Kind, &d.Title, &d.UpdatedAt)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		d.Role = existing
		writeJSON(w, http.StatusOK, d)
	}
}
