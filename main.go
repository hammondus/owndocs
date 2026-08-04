// docs is a self-hosted collaborative docs+sheets server.
//
// The server is deliberately dumb about document content: it relays and
// persists opaque Yjs updates (see DESIGN-DECISIONS.md). Everything lives in
// one binary: HTTP API, WebSocket sync hub, SQLite persistence, static UI.
package main

import (
	"context"
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

// all: includes dotfiles, so the tracked .gitkeep keeps the embed path
// valid on a fresh clone before the first `make js`.
//
//go:embed all:web/static
var embeddedStatic embed.FS

func main() {
	addr := flag.String("addr", "127.0.0.1:8484", "listen address")
	dbPath := flag.String("db", "data/docs.db", "sqlite database path")
	staticDir := flag.String("static", "", "serve UI from this directory instead of the embedded copy (dev)")
	signup := flag.String("signup", "open", "account creation: open or closed (close before exposing to the internet)")
	allowOrigin := flag.String("allow-origin", "", "extra websocket origin to accept, e.g. http://localhost:5173 for the vite dev server")
	flag.Parse()
	if *signup != "open" && *signup != "closed" {
		log.Fatalf("-signup must be open or closed, got %q", *signup)
	}

	if dir := filepath.Dir(*dbPath); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			log.Fatalf("create data dir: %v", err)
		}
	}
	db, err := openDB(*dbPath)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}

	var staticFS fs.FS
	if *staticDir != "" {
		staticFS = os.DirFS(*staticDir)
	} else {
		staticFS, err = fs.Sub(embeddedStatic, "web/static")
		if err != nil {
			log.Fatalf("embedded static: %v", err)
		}
	}

	var origins []string
	if *allowOrigin != "" {
		origins = append(origins, *allowOrigin)
	}
	hub := newHub(db, origins)
	srv := &http.Server{
		Addr:              *addr,
		Handler:           routes(db, hub, staticFS, *signup == "open"),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("listening on http://%s", *addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Print("shutting down")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	hub.shutdown() // flush unpersisted updates before the db closes
	_ = db.Close()
}
