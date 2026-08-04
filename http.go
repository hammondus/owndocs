package main

import (
	"database/sql"
	"encoding/json"
	"io/fs"
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
	mux.HandleFunc("PATCH /api/docs/{id}", requireAuth(db, handleRenameDoc(db)))
	mux.HandleFunc("DELETE /api/docs/{id}", requireAuth(db, handleDeleteDoc(db, h)))

	mux.HandleFunc("GET /api/docs/{id}/shares", requireAuth(db, handleListShares(db)))
	mux.HandleFunc("POST /api/docs/{id}/shares", requireAuth(db, handleAddShare(db, h)))
	mux.HandleFunc("DELETE /api/docs/{id}/shares/{uid}", requireAuth(db, handleRemoveShare(db, h)))
	mux.HandleFunc("POST /api/docs/{id}/links", requireAuth(db, handleCreateLink(db)))
	mux.HandleFunc("GET /api/docs/{id}/links", requireAuth(db, handleListLinks(db)))
	mux.HandleFunc("DELETE /api/docs/{id}/links/{lid}", requireAuth(db, handleDeleteLink(db)))
	mux.HandleFunc("POST /api/share/redeem", requireAuth(db, handleRedeemLink(db)))

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

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
