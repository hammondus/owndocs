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
	dev := flag.Bool("dev", false, "seed dev users with passwordless quick login — NEVER on a real instance")
	// Mail is submission-only to a relay that already exists — see
	// DESIGN-DECISIONS.md, *Notifications*. Unset means the feature is off,
	// not broken. Credentials come from the environment rather than argv,
	// which is visible in `ps`, exactly as the git exporter's do.
	smtpAddr := flag.String("smtp", "", "submission relay host:port for notification email; empty disables it")
	mailFrom := flag.String("mail-from", "", "From address for notification email")
	baseURL := flag.String("base-url", "", "public origin of this instance, e.g. https://docs.example.com — used for links in email")
	flag.Parse()
	if *signup != "open" && *signup != "closed" {
		log.Fatalf("-signup must be open or closed, got %q", *signup)
	}
	// Refused at startup rather than discovered as a broken link in somebody's
	// mailbox: the server has no other way to know its own public URL.
	if *smtpAddr != "" && (*mailFrom == "" || *baseURL == "") {
		log.Fatal("-smtp needs -mail-from and -base-url as well")
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
	if *dev {
		log.Print("DEV MODE: passwordless quick login enabled for seeded dev users")
		if err := seedDevUsers(db); err != nil {
			log.Fatalf("seed dev users: %v", err)
		}
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
	mail := newMailer(mailConfig{
		Addr:    *smtpAddr,
		From:    *mailFrom,
		BaseURL: *baseURL,
		User:    os.Getenv("SMTP_USERNAME"),
		Pass:    os.Getenv("SMTP_PASSWORD"),
	}, db, hub)
	if mail == nil {
		log.Print("notification email is off (-smtp unset); the in-app inbox is unaffected")
	} else {
		log.Printf("notification email via %s as %s", *smtpAddr, *mailFrom)
	}
	srv := &http.Server{
		Addr:              *addr,
		Handler:           routes(db, hub, mail, staticFS, *signup == "open", *dev),
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
