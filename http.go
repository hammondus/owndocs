package main

import (
	"database/sql"
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"strings"
)

func routes(db *sql.DB, h *hub, staticFS fs.FS, signupOpen, dev bool) http.Handler {
	mux := http.NewServeMux()

	if dev {
		mux.HandleFunc("GET /api/dev/users", handleDevUsers())
		mux.HandleFunc("POST /api/dev/login", handleDevLogin(db))
	}

	mux.HandleFunc("POST /api/signup", handleSignup(db, signupOpen))
	mux.HandleFunc("POST /api/login", handleLogin(db))
	mux.HandleFunc("POST /api/logout", handleLogout(db))
	mux.HandleFunc("GET /api/me", requireAuth(db, handleMe()))

	mux.HandleFunc("GET /api/docs", requireAuth(db, handleListDocs(db)))
	mux.HandleFunc("POST /api/docs", requireAuth(db, handleCreateDoc(db)))
	mux.HandleFunc("PATCH /api/docs/{id}", requireAuth(db, handleUpdateDoc(db)))
	mux.HandleFunc("DELETE /api/docs/{id}", requireAuth(db, handleDeleteDoc(db, h)))

	mux.HandleFunc("GET /api/docs/{id}/shares", requireAuth(db, handleListShares(db)))
	mux.HandleFunc("POST /api/docs/{id}/shares", requireAuth(db, handleAddShare(db, h)))
	mux.HandleFunc("DELETE /api/docs/{id}/shares/{uid}", requireAuth(db, handleRemoveShare(db, h)))
	mux.HandleFunc("POST /api/docs/{id}/links", requireAuth(db, handleCreateLink(db)))
	mux.HandleFunc("GET /api/docs/{id}/links", requireAuth(db, handleListLinks(db)))
	mux.HandleFunc("DELETE /api/docs/{id}/links/{lid}", requireAuth(db, handleDeleteLink(db)))
	mux.HandleFunc("POST /api/share/redeem", requireAuth(db, handleRedeemLink(db)))

	// Invites are how accounts come into existence once signup is closed.
	// Any signed-in user may mint one — see invites.go for why there is no
	// admin role gating this.
	mux.HandleFunc("GET /api/invites", requireAuth(db, handleListInvites(db)))
	mux.HandleFunc("POST /api/invites", requireAuth(db, handleCreateInvite(db)))
	mux.HandleFunc("DELETE /api/invites/{id}", requireAuth(db, handleDeleteInvite(db)))

	mux.HandleFunc("GET /api/docs/{id}/history", requireAuth(db, handleListHistory(db)))
	mux.HandleFunc("GET /api/docs/{id}/replay", requireAuth(db, handleReplay(db)))
	mux.HandleFunc("POST /api/docs/{id}/versions", requireAuth(db, handleCreateVersion(db, h)))
	mux.HandleFunc("DELETE /api/docs/{id}/versions/{vid}", requireAuth(db, handleDeleteVersion(db)))

	mux.HandleFunc("GET /api/docs/{id}/comments", requireAuth(db, handleListComments(db)))
	mux.HandleFunc("POST /api/docs/{id}/comments", requireAuth(db, handleCreateThread(db, h)))
	mux.HandleFunc("POST /api/docs/{id}/comments/{tid}", requireAuth(db, handleReply(db, h)))
	mux.HandleFunc("PATCH /api/docs/{id}/comments/{tid}", requireAuth(db, handleResolveThread(db, h)))
	mux.HandleFunc("DELETE /api/docs/{id}/comments/{tid}", requireAuth(db, handleDeleteThread(db, h)))
	mux.HandleFunc("PATCH /api/docs/{id}/comments/{tid}/{cid}", requireAuth(db, handleEditComment(db, h)))
	mux.HandleFunc("DELETE /api/docs/{id}/comments/{tid}/{cid}", requireAuth(db, handleDeleteComment(db, h)))

	mux.HandleFunc("POST /api/docs/{id}/snapshot", requireAuth(db, handleSnapshotUpload(db)))
	mux.HandleFunc("GET /api/docs/{id}/verify-bundle", requireAuth(db, handleVerifyBundle(db)))
	mux.HandleFunc("POST /api/docs/{id}/verify", requireAuth(db, handleSnapshotVerdict(db)))

	mux.HandleFunc("GET /ws/{id}", requireAuth(db, h.handleWS()))

	mux.Handle("GET /", staticHandler(staticFS))

	return mux
}

// staticHandler serves the UI. Cache policy is set here, at the chokepoint:
// vite writes content-hashed files under /assets/, so those URLs name their
// bytes and are immutable; everything else (index.html) is no-cache — store
// but always revalidate, since the HTML carries the hashed asset URLs and
// serving it stale would defeat the hashing.
func staticHandler(staticFS fs.FS) http.Handler {
	fileServer := http.FileServerFS(staticFS)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		fileServer.ServeHTTP(w, r)
	})
}

// readJSON decodes a JSON body of at most 1 MiB, requiring the right
// Content-Type. The Content-Type check doubles as CSRF protection: a
// cross-origin form can't send application/json without a CORS preflight.
func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	ct := r.Header.Get("Content-Type")
	if ct != "application/json" && !strings.HasPrefix(ct, "application/json;") {
		jsonError(w, http.StatusUnsupportedMediaType, "expected application/json")
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return false
	}
	return true
}

// clientIP is who to blame in a log line — and, later, who to rate-limit.
//
// Behind nginx proxy manager every request arrives from the proxy, so the peer
// address is useless on its own and `X-Forwarded-For` is the real source. But
// that header is client-supplied: trusting it unconditionally lets anyone
// reaching the app directly claim any address they like. So it is honoured
// only when the immediate peer is loopback or private — which is exactly the
// case where the request came through the proxy — and the *last* entry is
// taken, since a proxy appends and only the entry it wrote is trustworthy.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer := net.ParseIP(host)
	if peer == nil || !(peer.IsLoopback() || peer.IsPrivate() || peer.IsLinkLocalUnicast()) {
		return host
	}
	fwd := r.Header.Get("X-Forwarded-For")
	if fwd == "" {
		return host
	}
	parts := strings.Split(fwd, ",")
	return strings.TrimSpace(parts[len(parts)-1])
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
