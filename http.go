package main

import (
	"database/sql"
	"encoding/json"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

func routes(db *sql.DB, h *hub, staticFS fs.FS) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/signup", handleSignup(db))
	mux.HandleFunc("POST /api/login", handleLogin(db))
	mux.HandleFunc("POST /api/logout", handleLogout(db))
	mux.HandleFunc("GET /api/me", requireAuth(db, handleMe()))

	mux.HandleFunc("GET /api/docs", requireAuth(db, handleListDocs(db)))
	mux.HandleFunc("POST /api/docs", requireAuth(db, handleCreateDoc(db)))
	mux.HandleFunc("PATCH /api/docs/{id}", requireAuth(db, handleRenameDoc(db)))
	mux.HandleFunc("DELETE /api/docs/{id}", requireAuth(db, handleDeleteDoc(db, h)))

	mux.HandleFunc("POST /api/docs/{id}/snapshot", requireAuth(db, handleSnapshotUpload(db)))
	mux.HandleFunc("GET /api/docs/{id}/verify-bundle", requireAuth(db, handleVerifyBundle(db)))
	mux.HandleFunc("POST /api/docs/{id}/verify", requireAuth(db, handleSnapshotVerdict(db)))

	mux.HandleFunc("GET /ws/{id}", requireAuth(db, h.handleWS()))

	mux.Handle("GET /", staticHandler(staticFS))

	return mux
}

// staticHandler serves the UI. Cache policy is set here, at the chokepoint:
// HTML is no-cache (store but always revalidate); everything else gets a
// short max-age since none of it is content-hashed yet. Revisit when the
// Svelte build introduces hashed asset names.
func staticHandler(staticFS fs.FS) http.Handler {
	fileServer := http.FileServerFS(staticFS)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := path.Clean(r.URL.Path)
		if p == "/" {
			p = "/index.html"
		}
		if strings.HasSuffix(p, ".html") || mime.TypeByExtension(path.Ext(p)) == "" {
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			w.Header().Set("Cache-Control", "max-age=3600")
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
