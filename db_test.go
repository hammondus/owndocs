package main

import (
	"database/sql"
	"testing"
)

// Schema v5 rebuilds `permissions` and `share_links` to widen a CHECK
// constraint, which SQLite cannot do in place — so the rows are copied through
// a new table and the old one dropped. Every other test starts from an empty
// database and would pass even if that copy dropped every row on the floor.
// This one starts from a populated v4.
func TestMigrateV4ToV5PreservesGrants(t *testing.T) {
	path := t.TempDir() + "/v4.db"
	raw, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	for i, s := range []string{schemaV1, schemaV2, schemaV3, schemaV4} {
		if _, err := raw.Exec(s); err != nil {
			t.Fatalf("apply v%d: %v", i+1, err)
		}
	}
	if _, err := raw.Exec("PRAGMA user_version = 4"); err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		`INSERT INTO users (id, email, name, pass_hash, created_at) VALUES (1,'a@e','A','x',0), (2,'b@e','B','x',0)`,
		`INSERT INTO documents (id, kind, title, owner_id, created_at, updated_at) VALUES ('d1','doc','T',1,0,0)`,
		`INSERT INTO permissions (doc_id, user_id, role) VALUES ('d1',1,'owner'), ('d1',2,'editor')`,
		`INSERT INTO share_links (id, doc_id, token_hash, role, created_by, created_at) VALUES (7,'d1',x'00','viewer',1,0)`,
	} {
		if _, err := raw.Exec(stmt); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	raw.Close()

	db, err := openDB(path) // applies v5
	if err != nil {
		t.Fatalf("migrate to v5: %v", err)
	}
	defer db.Close()

	var role string
	if err := db.QueryRow("SELECT role FROM permissions WHERE doc_id='d1' AND user_id=2").Scan(&role); err != nil {
		t.Fatalf("grant lost in the rebuild: %v", err)
	}
	if role != "editor" {
		t.Fatalf("role changed to %q", role)
	}
	var links int
	if err := db.QueryRow("SELECT COUNT(*) FROM share_links WHERE id=7").Scan(&links); err != nil || links != 1 {
		t.Fatalf("share link lost in the rebuild (count %d): %v", links, err)
	}

	// The point of the rebuild: the new role is accepted...
	if _, err := db.Exec("INSERT INTO permissions (doc_id, user_id, role) VALUES ('d1',1,'commenter') ON CONFLICT DO UPDATE SET role='commenter'"); err != nil {
		t.Fatalf("commenter rejected after migration: %v", err)
	}
	// ...and the constraint itself survived rather than being dropped.
	if _, err := db.Exec("INSERT INTO permissions (doc_id, user_id, role) VALUES ('d1',2,'superuser') ON CONFLICT DO UPDATE SET role='superuser'"); err == nil {
		t.Fatal("CHECK constraint did not survive the rebuild: bogus role accepted")
	}
}
