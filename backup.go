package main

// Backups: one consistent file, taken while the server keeps running.
//
// ── Why VACUUM INTO and not a file copy ─────────────────────────────────────
// The database runs in WAL mode, so `cp data/docs.db somewhere` is wrong, and
// wrong *silently*: committed writes live in docs.db-wal until a checkpoint
// folds them back, so the copy is a valid, openable database that is missing
// everything since the last checkpoint. Measured on this project's own dev
// database with five fresh documents in the WAL: the copy opened cleanly, it
// passed `PRAGMA integrity_check`, and all five were gone. Copying the -wal
// and -shm files alongside it is no better — that is a torn read across three
// files that are changing while they are read.
//
// VACUUM INTO runs as an ordinary read transaction and writes a fresh, fully
// checkpointed, compacted database. In WAL mode readers do not block writers,
// so people keep editing while it runs. It is one SQL statement, needs no cgo
// and no second process, which is what makes it a fit for a single static
// binary — see DESIGN-DECISIONS, *Backups*.
//
// The cost is on the other side of the ledger and worth stating: this is a
// point-in-time copy, so the exposure is everything written since the last
// one. Continuous replication is a different tool; the design doc records why
// it is deferred rather than rejected.

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// openSource opens the database being backed up, WITHOUT running migrations.
//
// That omission is the point. openDB migrates, and a migration is a write, so
// reusing it would mean an older or newer binary's `-backup` could upgrade a
// live schema as a side effect of trying to read it. A backup must never be
// the thing that changes what it is copying.
//
// `query_only(1)` would state that intent to SQLite as well, and cannot be
// used: SQLite classes VACUUM INTO as a write statement — it writes a file,
// even though it changes nothing in the source — so the pragma fails the
// backup with "attempt to write a readonly database". The guarantee here is
// therefore "this code path issues no writes", not one the engine enforces,
// which is why the statement list below is exactly one line long.
func openSource(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(10000)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

// openReadOnly opens a finished backup for inspection. Nothing here has any
// business writing, and unlike the source connection it can say so.
func openReadOnly(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=query_only(1)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

// resolveBackupDest turns the -backup value into a filename.
//
// VACUUM INTO refuses to overwrite, which is the right default and an easy way
// to end up with a cron job that has silently done nothing for a month. So a
// directory is accepted and a timestamped name generated inside it, which is
// what a scheduled backup actually wants; a plain path is used as given and
// the clash is reported as an error rather than left to SQLite's wording.
func resolveBackupDest(dest string) (string, error) {
	if fi, err := os.Stat(dest); err == nil && fi.IsDir() {
		// UTC and sortable: backups get read by `ls` far more often than by a
		// person who knows which timezone the server was in.
		stamp := time.Now().UTC().Format("20060102T150405Z")
		base := filepath.Join(dest, "docs-"+stamp)
		// Two backups inside the same second would otherwise generate the same
		// name and the second would fail — which a test caught, and which is
		// reachable by running this twice by hand. A suffix keeps the common
		// case a clean timestamp and makes the collision a non-event.
		if _, err := os.Stat(base + ".db"); err != nil {
			return base + ".db", nil
		}
		for n := 2; n < 1000; n++ {
			candidate := fmt.Sprintf("%s-%d.db", base, n)
			if _, err := os.Stat(candidate); err != nil {
				return candidate, nil
			}
		}
		return "", fmt.Errorf("cannot find an unused name in %s for %s", dest, stamp)
	}
	if _, err := os.Stat(dest); err == nil {
		return "", fmt.Errorf("%s already exists; backups never overwrite (pass a directory to get a timestamped name)", dest)
	}
	return dest, nil
}

// runBackup writes a consistent copy of srcPath and then proves it is usable.
//
// The verification is not ceremony. Every failure mode this guards against is
// silent by nature — a truncated write, a full disk, a copy taken of a
// database that was already damaged — and a backup nobody has opened is a
// belief rather than a backup. Doing it here means the belief is checked at
// the moment the backup is made, when there is still something to fall back
// on, rather than during a restore.
func runBackup(srcPath, dest string) error {
	out, err := resolveBackupDest(dest)
	if err != nil {
		return err
	}

	src, err := openSource(srcPath)
	if err != nil {
		return fmt.Errorf("open %s: %w", srcPath, err)
	}
	defer src.Close()

	start := time.Now()
	if _, err := src.Exec("VACUUM INTO ?", out); err != nil {
		return fmt.Errorf("vacuum into %s: %w", out, err)
	}

	// A backup holds password hashes and live session tokens, so it is
	// credential material and gets credential permissions. VACUUM INTO creates
	// the file with the process umask, which on most hosts is world-readable.
	if err := os.Chmod(out, 0o600); err != nil {
		return fmt.Errorf("secure %s: %w", out, err)
	}

	summary, err := verifyBackup(out)
	if err != nil {
		// Left on disk deliberately: a backup that failed verification is
		// evidence, and deleting it would destroy the only copy of whatever
		// went wrong. It is named in the error so it can be looked at.
		return fmt.Errorf("backup written to %s but failed verification: %w", out, err)
	}

	fi, err := os.Stat(out)
	if err != nil {
		return err
	}
	fmt.Printf("backup ok: %s (%.1f MiB, %s) %s\n",
		out, float64(fi.Size())/(1<<20), time.Since(start).Round(time.Millisecond), summary)
	return nil
}

// verifyBackup opens the copy as an independent database and checks it holds
// what a restore would need. The row counts are part of the check rather than
// decoration: an empty-but-valid database passes an integrity check perfectly
// well, and is exactly the backup nobody notices until it is needed.
func verifyBackup(path string) (string, error) {
	db, err := openReadOnly(path)
	if err != nil {
		return "", err
	}
	defer db.Close()

	var integrity string
	if err := db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil {
		return "", fmt.Errorf("integrity check: %w", err)
	}
	if integrity != "ok" {
		return "", fmt.Errorf("integrity check: %s", integrity)
	}

	// Counted, not just opened: `updates` is the append-only log that document
	// content is actually reconstructed from, so a backup with documents and
	// no updates would restore a list of empty files.
	counts := map[string]int{}
	for _, t := range []string{"users", "documents", "updates", "snapshots", "comments"} {
		var n int
		if err := db.QueryRow("SELECT COUNT(*) FROM " + t).Scan(&n); err != nil {
			return "", fmt.Errorf("read %s: %w", t, err)
		}
		counts[t] = n
	}
	if counts["users"] == 0 {
		return "", fmt.Errorf("no users in the backup — refusing to call this good")
	}
	return fmt.Sprintf("users=%d documents=%d updates=%d snapshots=%d comments=%d",
		counts["users"], counts["documents"], counts["updates"], counts["snapshots"], counts["comments"]), nil
}
