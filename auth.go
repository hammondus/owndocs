package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters. 64 MiB is fine on the arm64 deploy target and only
// paid at login/signup, not per request.
const (
	argonTime    = 1
	argonMemory  = 64 * 1024 // KiB
	argonThreads = 4
	argonKeyLen  = 32
	argonSaltLen = 16
)

const sessionCookie = "session"
const sessionTTL = 90 * 24 * time.Hour

func hashPassword(pw string) string {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		panic(err) // crypto/rand failure is not a recoverable state
	}
	key := argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	b64 := base64.RawStdEncoding.EncodeToString
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads, b64(salt), b64(key))
}

func verifyPassword(pw, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var mem, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &mem, &t, &p); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(pw), salt, t, mem, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// dummyHash is verified against on login for unknown emails so response time
// doesn't reveal whether an account exists.
var dummyHash = hashPassword("dummy-password-for-timing")

type user struct {
	ID    int64  `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

func createSession(db *sql.DB, userID int64) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	h := sha256.Sum256([]byte(token))
	now := time.Now()
	_, err := db.Exec("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
		h[:], userID, now.Unix(), now.Add(sessionTTL).Unix())
	return token, err
}

func userForSession(db *sql.DB, token string) (*user, error) {
	h := sha256.Sum256([]byte(token))
	var u user
	err := db.QueryRow(`
		SELECT u.id, u.email, u.name FROM sessions s
		JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = ? AND s.expires_at > ?`,
		h[:], time.Now().Unix()).Scan(&u.ID, &u.Email, &u.Name)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func deleteSession(db *sql.DB, token string) {
	h := sha256.Sum256([]byte(token))
	_, _ = db.Exec("DELETE FROM sessions WHERE token_hash = ?", h[:])
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		// Secure when the client reached us over TLS, directly or via the
		// nginx proxy. Local dev over plain http stays working.
		Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
	})
}

type ctxKey int

const userKey ctxKey = 0

// requireAuth resolves the session cookie to a user and stores it in the
// request context; 401 without one.
func requireAuth(db *sql.DB, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			jsonError(w, http.StatusUnauthorized, "not signed in")
			return
		}
		u, err := userForSession(db, c.Value)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "session lookup failed")
			return
		}
		if u == nil {
			jsonError(w, http.StatusUnauthorized, "not signed in")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userKey, u)))
	}
}

func currentUser(r *http.Request) *user {
	u, _ := r.Context().Value(userKey).(*user)
	return u
}

func handleSignup(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Email    string `json:"email"`
			Name     string `json:"name"`
			Password string `json:"password"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		in.Email = strings.ToLower(strings.TrimSpace(in.Email))
		in.Name = strings.TrimSpace(in.Name)
		if in.Email == "" || !strings.Contains(in.Email, "@") || in.Name == "" {
			jsonError(w, http.StatusBadRequest, "email and name required")
			return
		}
		if len(in.Password) < 8 {
			jsonError(w, http.StatusBadRequest, "password must be at least 8 characters")
			return
		}
		res, err := db.Exec("INSERT INTO users (email, name, pass_hash, created_at) VALUES (?,?,?,?)",
			in.Email, in.Name, hashPassword(in.Password), time.Now().Unix())
		if err != nil {
			// UNIQUE violation is the only expected failure here.
			jsonError(w, http.StatusConflict, "email already registered")
			return
		}
		id, _ := res.LastInsertId()
		token, err := createSession(db, id)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "session create failed")
			return
		}
		setSessionCookie(w, r, token, int(sessionTTL.Seconds()))
		writeJSON(w, http.StatusOK, user{ID: id, Email: in.Email, Name: in.Name})
	}
}

func handleLogin(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		in.Email = strings.ToLower(strings.TrimSpace(in.Email))
		var u user
		var hash string
		err := db.QueryRow("SELECT id, email, name, pass_hash FROM users WHERE email = ?", in.Email).
			Scan(&u.ID, &u.Email, &u.Name, &hash)
		if errors.Is(err, sql.ErrNoRows) {
			verifyPassword(in.Password, dummyHash)
			jsonError(w, http.StatusUnauthorized, "wrong email or password")
			return
		}
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "lookup failed")
			return
		}
		if !verifyPassword(in.Password, hash) {
			jsonError(w, http.StatusUnauthorized, "wrong email or password")
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

func handleLogout(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c, err := r.Cookie(sessionCookie); err == nil {
			deleteSession(db, c.Value)
		}
		setSessionCookie(w, r, "", -1)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func handleMe() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, currentUser(r))
	}
}
