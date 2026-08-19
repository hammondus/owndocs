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

// Schema v6: invite links. With signup closed — which is how a publicly
// reachable instance must run — an invite is the only way an account comes
// into existence, so it is a capability exactly like a share link: the token
// is stored as SHA-256, the plaintext is returned once at creation, and a lost
// one is revoked and reissued rather than recovered.
//
// Single-use and short-lived, unlike a share link. A share link grants access
// to one document and revoking it is cheap; an invite creates an *account*, so
// an old one sitting in a mailbox is a standing offer to join the instance.
const schemaV6 = `
CREATE TABLE invites (
	id         INTEGER PRIMARY KEY,
	token_hash BLOB NOT NULL UNIQUE,
	note       TEXT NOT NULL,
	created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at    INTEGER,
	used_by    INTEGER REFERENCES users(id)
);
`

// Schema v7: rich documents. A per-document flag turning on the appearance
// constructs — colour, size, highlight colour, alignment — see
// DESIGN-DECISIONS.md, *Rich documents*.
//
// A flag rather than a third `kind`, and this migration is the cheapest
// evidence for why. A rich document renders in the same view, restores through
// the same text patcher and serializes to the same markdown, so it differs in
// none of the three things `kind` decides. Widening the `kind` CHECK would have
// meant rebuilding the documents table through the create/copy/drop/rename
// dance v5 needed — and every foreign key that points at it. This is one
// ALTER, and an existing document is plain because 0 is the default.
const schemaV7 = `
ALTER TABLE documents ADD COLUMN rich INTEGER NOT NULL DEFAULT 0;
`

// Schema v8: in-app notifications. One row per person per event, which is what
// makes an inbox a *record* rather than a computation — "have I seen this" is
// per person and cannot be derived from the comment itself.
//
// Every foreign key cascades, and that is load-bearing rather than tidy:
// deleting a comment, a thread or a whole document must take its notifications
// with it, or the inbox keeps offering to open things that are gone. The
// alternative — filtering dead rows at read time — is a join that has to be
// remembered in every query, and it would be forgotten exactly once.
//
// No `read_all` flag or per-user cursor: `read_at` per row is what lets one
// item be dismissed without dismissing the rest, and a cursor cannot express
// that. See DESIGN-DECISIONS.md, *Notifications*.
const schemaV8 = `
CREATE TABLE notifications (
	id         INTEGER PRIMARY KEY,
	user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	kind       TEXT NOT NULL CHECK (kind IN ('mention','reply')),
	doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	thread_id  INTEGER NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
	comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
	actor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	read_at    INTEGER
);
CREATE INDEX notifications_user ON notifications(user_id, id);
`

// Schema v9: search over comment bodies. FTS5 is available in
// modernc.org/sqlite, so this needs no new dependency and no cgo — see
// DESIGN-DECISIONS.md, *Search*.
//
// Comments are searchable and document content is not, and that asymmetry is
// not an oversight: comment bodies have always been plain TEXT here, because
// *Comments* put them in SQLite so viewers could comment and authorship could
// be stamped server-side. Document content is inside an opaque blob the server
// never parses. So this stage costs nothing in content-blindness — it indexes
// data the server already held in the clear.
//
// `content=comments` makes this an EXTERNAL CONTENT table: FTS5 stores only the
// index and reads the text back from `comments` by rowid, so a body is not
// duplicated. The price is that FTS5 cannot see writes by itself, which is what
// the three triggers are for. They are the whole correctness story — without
// them the index silently drifts from the table, which is the failure mode that
// makes people distrust search and stop using it.
//
// The delete/update triggers use the 'delete' command with the OLD text, which
// is how an external-content table is told to retract a row. Getting that wrong
// leaves tombstones that match queries and then resolve to nothing.
const schemaV9 = `
CREATE VIRTUAL TABLE comment_search USING fts5(
	body,
	content=comments,
	content_rowid=id,
	tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER comments_ai AFTER INSERT ON comments BEGIN
	INSERT INTO comment_search(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER comments_ad AFTER DELETE ON comments BEGIN
	INSERT INTO comment_search(comment_search, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER comments_au AFTER UPDATE ON comments BEGIN
	INSERT INTO comment_search(comment_search, rowid, body) VALUES ('delete', old.id, old.body);
	INSERT INTO comment_search(rowid, body) VALUES (new.id, new.body);
END;

INSERT INTO comment_search(rowid, body) SELECT id, body FROM comments;
`

// Schema v10: search over document bodies, supplied by the client.
//
// Unlike comment_search this is NOT an external-content table, because there is
// no source table to point at — the extracted text *is* the stored thing. The
// server still never parses a Yjs update; a client that already decoded the
// document posts what it read, authorised by the same role check that let it
// read. See DESIGN-DECISIONS.md, *Search*, stage 2.
//
// One row per document, replaced wholesale on each index. FTS5 has no usable
// UPSERT, so `doc_search.go` deletes then inserts inside a transaction — which
// is also why doc_id must be queryable rather than UNINDEXED.
//
// indexed_at is UNINDEXED and is not decoration: the whole point of shipping
// stages 1 and 2 before a headless indexer is to find out how stale a
// client-driven index actually gets, and that cannot be measured without it.
const schemaV10 = `
CREATE VIRTUAL TABLE doc_search USING fts5(
	doc_id,
	body,
	indexed_at UNINDEXED,
	tokenize='unicode61 remove_diacritics 2'
);
`

// Schema v11: the `manager` rank, and one source of truth for ownership. See
// DESIGN-DECISIONS.md, *Ownership: one owner, one deputy rank*.
//
// `manager` sits between `editor` and `owner` and holds every owner power
// except the two that cannot be undone — deleting the document and
// transferring it. Widening the CHECK needs the same create/copy/drop/rename
// dance v5 needed; no foreign key points *at* `permissions`, so the drop needs
// no `foreign_keys` toggle around it.
//
// `share_links` is deliberately NOT rebuilt alongside it. A link is a bearer
// token — whoever holds the URL gets the role, and by design nobody knows who
// that is — so a manager link would let anyone who saw it revoke the owner's
// collaborators. Leaving the v5 CHECK in place makes the database the backstop
// for the cap the handlers enforce, which is worth having precisely because the
// handlers got it wrong once: they rejected `owner` by *name*, so adding a rank
// above editor would have made `manager` mintable as a link by default.
//
// `documents.owner_id` goes. It was written by `handleCreateDoc` and read by
// nothing — every ownership check went through `permissions` — so transfer
// would have had to keep two copies of one fact in step for the benefit of no
// reader, and the copy that drifted would have been the silent one. SQLite
// allows DROP COLUMN here despite the outgoing foreign key, since nothing
// indexes the column.
const schemaV11 = `
CREATE TABLE permissions_v11 (
	doc_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role    TEXT NOT NULL CHECK (role IN ('owner','manager','editor','commenter','viewer')),
	PRIMARY KEY (doc_id, user_id)
);
INSERT INTO permissions_v11 SELECT doc_id, user_id, role FROM permissions;
DROP TABLE permissions;
ALTER TABLE permissions_v11 RENAME TO permissions;

ALTER TABLE documents DROP COLUMN owner_id;
`

// Schema v12: folders. A document lives in at most one folder, and a folder
// grants access to everything beneath it. See DESIGN-DECISIONS.md, *Folders*.
//
// Single-parent on purpose. Drive allowed a file in several folders and
// withdrew it in 2020, because "where is this?" stops having an answer and so
// does "who can see it". One parent makes both questions a walk up a chain.
//
// `folder_permissions` mirrors `permissions` and stops one rank short: there is
// no folder `owner`. Ownership is per-document and singular — the one row
// `handleCreateDoc` writes, moved only by transfer — so a folder that granted
// `owner` would hand everyone in it the power to delete documents they did not
// create. `manager` is the top of the folder ladder, and it is enough: it is
// already the bar for administering a document.
//
// A folder therefore has no owner, which is why it needs none: the only
// destructive thing you can do to a folder is delete it, and deleting is
// refused while anything is inside. `mayModify` then keeps two managers of the
// same folder from removing each other, exactly as it does on a document.
//
// documents.folder_id is nullable and ON DELETE RESTRICT by omission — SQLite
// defaults to NO ACTION, which refuses the delete. That is the backstop for the
// handler rule that a folder must be emptied before it goes, and it is worth
// having in the database because the alternative failure is silent: a cascade
// here would delete other people's documents.
const schemaV12 = `
CREATE TABLE folders (
	id         TEXT PRIMARY KEY,
	parent_id  TEXT REFERENCES folders(id),
	name       TEXT NOT NULL,
	created_by INTEGER NOT NULL REFERENCES users(id),
	created_at INTEGER NOT NULL
);
CREATE INDEX folders_parent ON folders(parent_id);

CREATE TABLE folder_permissions (
	folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
	user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role      TEXT NOT NULL CHECK (role IN ('manager','editor','commenter','viewer')),
	PRIMARY KEY (folder_id, user_id)
);
CREATE INDEX folder_permissions_user ON folder_permissions(user_id);

ALTER TABLE documents ADD COLUMN folder_id TEXT REFERENCES folders(id);
CREATE INDEX documents_folder ON documents(folder_id);
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
	for ver, schema := range []string{schemaV1, schemaV2, schemaV3, schemaV4, schemaV5, schemaV6, schemaV7, schemaV8, schemaV9, schemaV10, schemaV11, schemaV12} {
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
