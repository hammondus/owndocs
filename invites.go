package main

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"
)

// Invite links: how an account comes into existence once signup is closed,
// which is how a publicly reachable instance has to run (see Threat model).
// Modelled on share links deliberately — same capability shape, same storage
// rules — but with two differences that follow from what they grant:
//
//   - **Single use.** A share link grants access to one document and is
//     naturally reusable; an invite creates an account, and "the link for the
//     new hires" is how one invite becomes six accounts nobody meant.
//   - **Short-lived.** An old invite in a mailbox is a standing offer to join
//     the instance, long after the person it was for did or didn't take it up.
//
// Any signed-in user may invite. There is no global admin in this app — roles
// are per-document — and inventing one for this is out of proportion to a
// company where everyone with an account is staff. The upgrade path, if it is
// ever wanted, is a flag on `users` checked here and nowhere else.
const inviteTTL = 7 * 24 * time.Hour

type invite struct {
	ID        int64  `json:"id"`
	Note      string `json:"note"`
	CreatedAt int64  `json:"created_at"`
	ExpiresAt int64  `json:"expires_at"`
	UsedAt    *int64 `json:"used_at"`
	Token     string `json:"token,omitempty"` // present only on creation
}

// POST /api/invites {note} — mint one. The token is returned exactly once;
// only its hash is stored, so a lost link is revoked and reissued, never
// retrieved.
func handleCreateInvite(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Note string `json:"note"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		in.Note = strings.TrimSpace(in.Note)
		if in.Note == "" {
			jsonError(w, http.StatusBadRequest, "say who this invite is for")
			return
		}
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			jsonError(w, http.StatusInternalServerError, "entropy failure")
			return
		}
		token := base64.RawURLEncoding.EncodeToString(raw)
		hash := sha256.Sum256([]byte(token))
		now := time.Now()
		expires := now.Add(inviteTTL).Unix()
		res, err := db.Exec(
			"INSERT INTO invites (token_hash, note, created_by, created_at, expires_at) VALUES (?,?,?,?,?)",
			hash[:], in.Note, currentUser(r).ID, now.Unix(), expires)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		id, _ := res.LastInsertId()
		writeJSON(w, http.StatusOK, invite{
			ID: id, Note: in.Note, CreatedAt: now.Unix(), ExpiresAt: expires, Token: token,
		})
	}
}

// GET /api/invites — outstanding and recently used invites, without tokens.
// Everyone sees the whole list: an invite is an instance-level act, and hiding
// who else has one from the colleagues who can also mint them buys nothing.
func handleListInvites(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.Query(
			"SELECT id, note, created_at, expires_at, used_at FROM invites ORDER BY id DESC LIMIT 100")
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer rows.Close()
		out := []invite{}
		for rows.Next() {
			var v invite
			var used sql.NullInt64
			if err := rows.Scan(&v.ID, &v.Note, &v.CreatedAt, &v.ExpiresAt, &used); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			v.UsedAt = nullInt(used)
			out = append(out, v)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// DELETE /api/invites/{id} — revoke one that has not been taken up.
func handleDeleteInvite(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, err := db.Exec("DELETE FROM invites WHERE id = ?", r.PathValue("id")); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// claimInvite consumes a token inside the signup transaction, returning the
// invite's row id. Consuming and creating the account must be atomic: two
// simultaneous signups on one link would otherwise both find it unused.
//
// The UPDATE carries the used_at IS NULL test, so SQLite decides the race —
// checking first and updating second is the version of this that has a window
// in it.
func claimInvite(tx *sql.Tx, token string) (int64, error) {
	hash := sha256.Sum256([]byte(token))
	res, err := tx.Exec(
		"UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
		time.Now().Unix(), hash[:], time.Now().Unix())
	if err != nil {
		return 0, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return 0, errInviteUnusable
	}
	var id int64
	err = tx.QueryRow("SELECT id FROM invites WHERE token_hash = ?", hash[:]).Scan(&id)
	return id, err
}

var errInviteUnusable = errors.New("that invite link is invalid, already used, or expired")
