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
	"log"
	"net/http"
	"strconv"
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

// argon2id costs 64 MiB *per call* — that expense is the point against
// guessing, but it is paid by the server on unauthenticated input, which makes
// an unbounded number of concurrent calls a memory-exhaustion primitive: a few
// dozen simultaneous POSTs to /api/login is a gigabyte on a box that does not
// have many. The answer is not a cheaper hash, it is a bound on how many run
// at once; past it, callers wait briefly and then get a 503.
//
// Sized so the worst case is a few hundred MiB. A rate limiter does not
// replace this — a burst arriving inside one window allocates before any
// limiter has counted it.
const maxConcurrentHashes = 4
const hashWaitTimeout = 5 * time.Second

var hashSlots = make(chan struct{}, maxConcurrentHashes)

// withHashSlot runs fn holding one of the permits, or reports that the server
// is too busy rather than queueing without limit.
func withHashSlot(fn func()) bool {
	timer := time.NewTimer(hashWaitTimeout)
	defer timer.Stop()
	select {
	case hashSlots <- struct{}{}:
		defer func() { <-hashSlots }()
		fn()
		return true
	case <-timer.C:
		return false
	}
}

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

func handleSignup(db *sql.DB, open bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Email    string `json:"email"`
			Name     string `json:"name"`
			Password string `json:"password"`
			Invite   string `json:"invite"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		// Closed signup is how a publicly reachable instance runs, so an
		// invite is then the only way in. Checked here rather than at the
		// route, because the same endpoint serves both modes.
		if !open && in.Invite == "" {
			jsonError(w, http.StatusForbidden, "signup is closed on this instance — you need an invite link")
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
		// One transaction for consuming the invite and creating the account, so
		// a failed signup does not burn the link and two simultaneous signups
		// on one link cannot both succeed.
		tx, err := db.Begin()
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer tx.Rollback()

		var inviteID int64
		if in.Invite != "" {
			inviteID, err = claimInvite(tx, in.Invite)
			if err != nil {
				jsonError(w, http.StatusForbidden, errInviteUnusable.Error())
				return
			}
		}
		var pass string
		if !withHashSlot(func() { pass = hashPassword(in.Password) }) {
			jsonError(w, http.StatusServiceUnavailable, "too busy, try again shortly")
			return
		}
		res, err := tx.Exec("INSERT INTO users (email, name, pass_hash, created_at) VALUES (?,?,?,?)",
			in.Email, in.Name, pass, time.Now().Unix())
		if err != nil {
			// UNIQUE violation is the only expected failure here.
			jsonError(w, http.StatusConflict, "email already registered")
			return
		}
		id, _ := res.LastInsertId()
		if inviteID != 0 {
			if _, err := tx.Exec("UPDATE invites SET used_by = ? WHERE id = ?", id, inviteID); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
		}
		if err := tx.Commit(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
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
	// One limiter per registration, which is once. Kept in the closure rather
	// than threaded through routes(): nothing else has any business touching
	// it, and a package-level var would be shared by two servers in one test
	// binary.
	limiter := newLoginLimiter()
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		in.Email = strings.ToLower(strings.TrimSpace(in.Email))
		source := clientIP(r)
		// Checked before the lookup and before any hashing, so a locked-out
		// attacker consumes neither a database read nor one of the 64 MiB hash
		// permits. Retry-After is in seconds and rounded up, since rounding
		// down would invite a retry that is still refused.
		if wait := limiter.retryAfter(in.Email, source); wait > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
			log.Printf("rate-limited login for %q from %s", in.Email, source)
			jsonError(w, http.StatusTooManyRequests, "too many sign-in attempts, try again shortly")
			return
		}
		var u user
		var hash string
		err := db.QueryRow("SELECT id, email, name, pass_hash FROM users WHERE email = ?", in.Email).
			Scan(&u.ID, &u.Email, &u.Name, &hash)
		if errors.Is(err, sql.ErrNoRows) {
			// The dummy verify keeps the response time of an unknown account
			// indistinguishable from a wrong password — and costs the same
			// 64 MiB, so it takes a permit like any other.
			withHashSlot(func() { verifyPassword(in.Password, dummyHash) })
			limiter.fail(in.Email, source)
			log.Printf("failed login for unknown %q from %s", in.Email, source)
			jsonError(w, http.StatusUnauthorized, "wrong email or password")
			return
		}
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "lookup failed")
			return
		}
		var okPass bool
		if !withHashSlot(func() { okPass = verifyPassword(in.Password, hash) }) {
			jsonError(w, http.StatusServiceUnavailable, "too many sign-in attempts at once, try again shortly")
			return
		}
		if !okPass {
			// Logged so an attack against a publicly reachable login is visible
			// at all. Never the password, and never a distinction between a
			// wrong password and an unknown account beyond what the response
			// already reveals.
			limiter.fail(in.Email, source)
			log.Printf("failed login for %q from %s", in.Email, source)
			jsonError(w, http.StatusUnauthorized, "wrong email or password")
			return
		}
		limiter.succeed(in.Email)
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
