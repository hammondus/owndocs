package main

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

// Schema v1. The `updates` table is the source of truth for document content:
// an append-only log of opaque, length-prefixed Yjs update batches. The server
// never parses them.
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

// Schema v2: snapshot-as-cache compaction (see DESIGN-DECISIONS.md).
// documents.last_seq becomes the authoritative sequence counter — MAX(seq)
// on `updates` stops working once verified rows are archived away.
// `snapshots` holds client-produced merged states (pending until a later
// load verifies them); `history_segments` holds gzipped, archived ranges of
// the update log — never auto-deleted.
const schemaV2 = `
ALTER TABLE documents ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;
UPDATE documents SET last_seq = COALESCE((SELECT MAX(seq) FROM updates WHERE doc_id = documents.id), 0);

CREATE TABLE snapshots (
	doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	last_seq   INTEGER NOT NULL,
	data       BLOB NOT NULL,
	sha256     BLOB NOT NULL,
	state      TEXT NOT NULL CHECK (state IN ('pending','verified')),
	created_at INTEGER NOT NULL,
	PRIMARY KEY (doc_id, last_seq)
);

CREATE TABLE history_segments (
	doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	start_seq  INTEGER NOT NULL,
	end_seq    INTEGER NOT NULL,
	data       BLOB NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (doc_id, start_seq)
);
`

// Schema v4: version history. `versions` pins user-chosen names to sequence
// numbers. history_segments.row_index preserves per-row (seq, time, byte
// offset) through archiving as JSON — without it, archived history loses
// the boundaries needed for browseable points and mid-segment replay.
// Segments archived before v4 have NULL and degrade to one coarse point.
const schemaV4 = `
CREATE TABLE versions (
	id         INTEGER PRIMARY KEY,
	doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	seq        INTEGER NOT NULL,
	name       TEXT NOT NULL,
	created_by INTEGER NOT NULL REFERENCES users(id),
	created_at INTEGER NOT NULL
);
ALTER TABLE history_segments ADD COLUMN row_index TEXT;
`

// Schema v3: share links. Tokens are capability bearer secrets, stored as
// SHA-256 like session tokens — a leaked db must not grant access. The
// plaintext token is returned once at creation; lost links are revoked and
// regenerated, never retrieved.
const schemaV3 = `
CREATE TABLE share_links (
	id         INTEGER PRIMARY KEY,
	doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	token_hash BLOB NOT NULL UNIQUE,
	role       TEXT NOT NULL CHECK (role IN ('editor','viewer')),
	created_by INTEGER NOT NULL REFERENCES users(id),
	created_at INTEGER NOT NULL
);
`

// Schema v5: comment threads (see DESIGN-DECISIONS.md "Comments"). Bodies and
// authorship live here rather than in the Yjs doc, so the server can attribute
// a comment to a session, and so "may comment but may not edit" becomes a role
// the socket can enforce.
//
// `anchor` is written and read by the client and never parsed here: encoded
// Yjs RelativePositions for a doc, row/col ids for a sheet, plus the quoted
// snippet shown when an anchor no longer resolves. The quote lives inside the
// blob on purpose — comment bodies are stored in the clear because mentions
// will need to read them, but the server still holds no document text.
//
// The `commenter` role needs a new CHECK constraint on two existing tables and
// SQLite cannot alter one in place, so both are rebuilt by the standard
// create/copy/drop/rename dance. No foreign key points *at* either table, so
// the drop needs no `foreign_keys` toggle around it.
const schemaV5 = `
CREATE TABLE permissions_v5 (
	doc_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role    TEXT NOT NULL CHECK (role IN ('owner','editor','commenter','viewer')),
	PRIMARY KEY (doc_id, user_id)
);
INSERT INTO permissions_v5 SELECT doc_id, user_id, role FROM permissions;
DROP TABLE permissions;
ALTER TABLE permissions_v5 RENAME TO permissions;

CREATE TABLE share_links_v5 (
	id         INTEGER PRIMARY KEY,
	doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	token_hash BLOB NOT NULL UNIQUE,
	role       TEXT NOT NULL CHECK (role IN ('editor','commenter','viewer')),
	created_by INTEGER NOT NULL REFERENCES users(id),
	created_at INTEGER NOT NULL
);
INSERT INTO share_links_v5 SELECT id, doc_id, token_hash, role, created_by, created_at FROM share_links;
DROP TABLE share_links;
ALTER TABLE share_links_v5 RENAME TO share_links;

CREATE TABLE comment_threads (
	id          INTEGER PRIMARY KEY,
	doc_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	anchor      BLOB NOT NULL,
	created_by  INTEGER NOT NULL REFERENCES users(id),
	created_at  INTEGER NOT NULL,
	resolved_by INTEGER REFERENCES users(id),
	resolved_at INTEGER
);
CREATE INDEX comment_threads_doc ON comment_threads(doc_id, id);

CREATE TABLE comments (
	id         INTEGER PRIMARY KEY,
	thread_id  INTEGER NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
	author_id  INTEGER NOT NULL REFERENCES users(id),
	body       TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	edited_at  INTEGER
);
CREATE INDEX comments_thread ON comments(thread_id, id);
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
	for ver, schema := range []string{schemaV1, schemaV2, schemaV3, schemaV4, schemaV5} {
		if v > ver {
			continue
		}
		if _, err := db.Exec(schema); err != nil {
			return fmt.Errorf("apply schema v%d: %w", ver+1, err)
		}
		if _, err := db.Exec(fmt.Sprintf("PRAGMA user_version = %d", ver+1)); err != nil {
			return err
		}
	}
	return nil
}
