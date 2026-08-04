package main

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

// Schema v1. The `updates` table is the source of truth for document content:
// an append-only log of opaque, length-prefixed Yjs update batches. The server
// never parses them. `snapshots` and `history_segments` arrive in phase 2.
const schemaV1 = `
CREATE TABLE users (
	id         INTEGER PRIMARY KEY,
	email      TEXT NOT NULL UNIQUE,
	name       TEXT NOT NULL,
	pass_hash  TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
	token_hash BLOB PRIMARY KEY,
	user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE TABLE documents (
	id         TEXT PRIMARY KEY,
	kind       TEXT NOT NULL CHECK (kind IN ('doc','sheet')),
	title      TEXT NOT NULL,
	owner_id   INTEGER NOT NULL REFERENCES users(id),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE permissions (
	doc_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role    TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
	PRIMARY KEY (doc_id, user_id)
);

CREATE TABLE updates (
	doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	seq        INTEGER NOT NULL,
	data       BLOB NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (doc_id, seq)
);
`

func openDB(path string) (*sql.DB, error) {
	// _pragma values apply per-connection; busy_timeout is belt-and-braces
	// since MaxOpenConns(1) already serializes everything through one
	// connection — the simplest way to never see SQLITE_BUSY at our scale.
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func migrate(db *sql.DB) error {
	var v int
	if err := db.QueryRow("PRAGMA user_version").Scan(&v); err != nil {
		return err
	}
	if v >= 1 {
		return nil
	}
	if _, err := db.Exec(schemaV1); err != nil {
		return fmt.Errorf("apply schema v1: %w", err)
	}
	_, err := db.Exec("PRAGMA user_version = 1")
	return err
}
