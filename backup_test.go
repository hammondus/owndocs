package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// seedForBackup builds a small but *complete* database: a backup that captures
// documents without the update log restores a list of empty files, so the
// fixture has to contain both for the assertions below to mean anything.
func seedForBackup(t *testing.T) string {
	t.Helper()
	path := t.TempDir() + "/src.db"
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, stmt := range []string{
		`INSERT INTO users (id, email, name, pass_hash, created_at) VALUES (1,'a@e','A','x',0)`,
		`INSERT INTO documents (id, kind, title, owner_id, created_at, updated_at) VALUES ('d1','doc','T',1,0,0)`,
		`INSERT INTO updates (doc_id, seq, data, created_at) VALUES ('d1',1,x'0001',0)`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	return path
}

func TestBackupCapturesUncheckpointedWrites(t *testing.T) {
	src := seedForBackup(t)

	// The whole point of VACUUM INTO rather than a file copy. The source is
	// left OPEN with a write that has committed but very likely not been
	// checkpointed into the main database file yet, which is the state a live
	// server is in essentially all the time.
	db, err := openDB(src)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(
		`INSERT INTO documents (id, kind, title, owner_id, created_at, updated_at) VALUES ('d2','doc','In the WAL',1,0,0)`,
	); err != nil {
		t.Fatal(err)
	}

	out := filepath.Join(t.TempDir(), "backup.db")
	if err := runBackup(src, out); err != nil {
		t.Fatalf("backup: %v", err)
	}

	got, err := openReadOnly(out)
	if err != nil {
		t.Fatal(err)
	}
	defer got.Close()
	var title string
	if err := got.QueryRow(`SELECT title FROM documents WHERE id = 'd2'`).Scan(&title); err != nil {
		t.Fatalf("the write still in the WAL did not make it into the backup: %v", err)
	}
	if title != "In the WAL" {
		t.Fatalf("title = %q", title)
	}
}

// A backup must never be the thing that upgrades a schema — see openSource.
func TestBackupDoesNotMigrateTheSource(t *testing.T) {
	src := seedForBackup(t)

	// Wind the recorded schema version back. openDB would migrate it forward
	// again; a backup must leave it exactly as found.
	db, err := openDB(src)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("PRAGMA user_version = 1"); err != nil {
		t.Fatal(err)
	}
	db.Close()

	if err := runBackup(src, filepath.Join(t.TempDir(), "b.db")); err != nil {
		t.Fatalf("backup: %v", err)
	}

	after, err := openReadOnly(src)
	if err != nil {
		t.Fatal(err)
	}
	defer after.Close()
	var v int
	if err := after.QueryRow("PRAGMA user_version").Scan(&v); err != nil {
		t.Fatal(err)
	}
	if v != 1 {
		t.Fatalf("backup migrated the source: user_version = %d, want 1", v)
	}
}

func TestBackupIsNotWorldReadable(t *testing.T) {
	src := seedForBackup(t)
	out := filepath.Join(t.TempDir(), "b.db")
	if err := runBackup(src, out); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(out)
	if err != nil {
		t.Fatal(err)
	}
	// It holds password hashes and live session tokens.
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("backup mode = %o, want 600", perm)
	}
}

func TestBackupRefusesToOverwrite(t *testing.T) {
	src := seedForBackup(t)
	out := filepath.Join(t.TempDir(), "b.db")
	if err := runBackup(src, out); err != nil {
		t.Fatal(err)
	}
	// Second run to the same name must fail loudly. Silently doing nothing is
	// how a scheduled backup goes a month without producing anything.
	err := runBackup(src, out)
	if err == nil {
		t.Fatal("second backup to the same path succeeded; it must refuse")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("unhelpful error: %v", err)
	}
}

func TestBackupToDirectoryGetsATimestampedName(t *testing.T) {
	src := seedForBackup(t)
	dir := t.TempDir()
	if err := runBackup(src, dir); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want one backup, got %d", len(entries))
	}
	name := entries[0].Name()
	if !strings.HasPrefix(name, "docs-") || !strings.HasSuffix(name, ".db") {
		t.Fatalf("unexpected name %q", name)
	}
	// Repeatable: a directory destination must never collide with itself the
	// way a fixed filename does. This runs within the same second as the first,
	// which is exactly the case that used to fail.
	if err := runBackup(src, dir); err != nil {
		t.Fatalf("second backup into the same directory failed: %v", err)
	}
	entries, err = os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("want two backups after two runs, got %d", len(entries))
	}
}

// An empty database passes an integrity check perfectly well. That is exactly
// the backup nobody notices is worthless until they need it.
func TestVerifyRejectsAnEmptyDatabase(t *testing.T) {
	empty := t.TempDir() + "/empty.db"
	db, err := openDB(empty) // schema, no rows
	if err != nil {
		t.Fatal(err)
	}
	db.Close()

	if _, err := verifyBackup(empty); err == nil {
		t.Fatal("verification passed a database with no users")
	}
}
