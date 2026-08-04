package main

import (
	"database/sql"
	"net/http"
	"time"
)

// Dev-mode conveniences, enabled only by the -dev flag: three seeded users
// and a passwordless quick login for exactly those users. The endpoints are
// not registered at all without the flag, and the login is whitelisted to
// the seeded accounts — it must never be a bypass for real ones.

var devUsers = []user{
	{Email: "alice@dev.local", Name: "Alice"},
	{Email: "bob@dev.local", Name: "Bob"},
	{Email: "carol@dev.local", Name: "Carol"},
}

// devPassword also works through the normal login form.
const devPassword = "devdevdev"

func seedDevUsers(db *sql.DB) error {
	for _, u := range devUsers {
		_, err := db.Exec("INSERT OR IGNORE INTO users (email, name, pass_hash, created_at) VALUES (?,?,?,?)",
			u.Email, u.Name, hashPassword(devPassword), time.Now().Unix())
		if err != nil {
			return err
		}
	}
	return nil
}

// GET /api/dev/users — the quick-login roster for the sign-in screen.
func handleDevUsers() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, devUsers)
	}
}

// POST /api/dev/login {email} — passwordless session for a seeded dev user.
func handleDevLogin(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Email string `json:"email"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		allowed := false
		for _, u := range devUsers {
			if u.Email == in.Email {
				allowed = true
			}
		}
		if !allowed {
			jsonError(w, http.StatusForbidden, "not a dev user")
			return
		}
		var u user
		err := db.QueryRow("SELECT id, email, name FROM users WHERE email = ?", in.Email).
			Scan(&u.ID, &u.Email, &u.Name)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "dev user missing — restart with -dev to seed")
			return
		}
		token, err := createSession(db, u.ID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "session create failed")
			return
		}
		setSessionCookie(w, r, token, int(sessionTTL.Seconds()))
		writeJSON(w, http.StatusOK, u)
	}
}
