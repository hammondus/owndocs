package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// reqJSON is postJSON for the verbs that have no helper. PATCH and DELETE both
// appear often enough here that writing http.NewRequest inline five times would
// bury what each test is actually asserting.
func reqJSON(t *testing.T, c *http.Client, method, url string, body any) *http.Response {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func createFolder(t *testing.T, srv *httptest.Server, c *http.Client, name string, parent *string) string {
	t.Helper()
	body := map[string]any{"name": name}
	if parent != nil {
		body["parent_id"] = *parent
	}
	res := postJSON(t, c, srv.URL+"/api/folders", body)
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("create folder %q: %d %s", name, res.StatusCode, b)
	}
	var f folder
	if err := json.NewDecoder(res.Body).Decode(&f); err != nil {
		t.Fatal(err)
	}
	return f.ID
}

func listDocs(t *testing.T, srv *httptest.Server, c *http.Client) []document {
	t.Helper()
	res, err := c.Get(srv.URL + "/api/docs")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var docs []document
	if err := json.NewDecoder(res.Body).Decode(&docs); err != nil {
		t.Fatal(err)
	}
	return docs
}

func listFolders(t *testing.T, srv *httptest.Server, c *http.Client) []folder {
	t.Helper()
	res, err := c.Get(srv.URL + "/api/folders")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var fs []folder
	if err := json.NewDecoder(res.Body).Decode(&fs); err != nil {
		t.Fatal(err)
	}
	return fs
}

// docIn creates a document straight into a folder.
func docIn(t *testing.T, srv *httptest.Server, c *http.Client, folderID string) string {
	t.Helper()
	res := postJSON(t, c, srv.URL+"/api/docs", map[string]any{"title": "t", "folder_id": folderID})
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("create doc in folder: %d %s", res.StatusCode, b)
	}
	var d document
	if err := json.NewDecoder(res.Body).Decode(&d); err != nil {
		t.Fatal(err)
	}
	return d.ID
}

func shareFolder(t *testing.T, srv *httptest.Server, c *http.Client, folderID, email, role string) *http.Response {
	t.Helper()
	return postJSON(t, c, srv.URL+"/api/folders/"+folderID+"/shares",
		map[string]string{"email": email, "role": role})
}

// The headline property: a grant on a folder reaches the documents inside it,
// and nothing has to be shared per document.
func TestFolderGrantReachesDocumentsInside(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")

	eng := createFolder(t, srv, alice, "Engineering", nil)
	docID := docIn(t, srv, alice, eng)

	if docs := listDocs(t, srv, bob); len(docs) != 0 {
		t.Fatalf("bob sees %d documents before the folder is shared", len(docs))
	}

	res := shareFolder(t, srv, alice, eng, "bob@example.com", "editor")
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("share folder: %d %s", res.StatusCode, b)
	}
	res.Body.Close()

	docs := listDocs(t, srv, bob)
	if len(docs) != 1 || docs[0].ID != docID {
		t.Fatalf("bob sees %v, want the one document in the folder", docs)
	}
	if docs[0].Role != "editor" {
		t.Fatalf("inherited role = %q, want editor", docs[0].Role)
	}
	if docs[0].FolderID == nil || *docs[0].FolderID != eng {
		t.Fatalf("folder_id = %v, want %s", docs[0].FolderID, eng)
	}
	// Not a UI-only grant: the socket must accept the write too.
	conn := dialWS(t, srv, bob, docID)
	readUntilSynced(t, conn)
	sendTyped(t, conn, msgDoc, []byte{1, 2})
	conn.Close(1000, "")
}

// Inheritance runs the whole way down, and the nearest grant does not override
// a better one further up — the best grant wins, wherever it is.
func TestFolderGrantsCombineByRank(t *testing.T) {
	srv, db, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	apiClient(t, srv, "bob@example.com")

	top := createFolder(t, srv, alice, "Top", nil)
	sub := createFolder(t, srv, alice, "Sub", &top)
	docID := docIn(t, srv, alice, sub)

	res := shareFolder(t, srv, alice, top, "bob@example.com", "editor")
	res.Body.Close()
	res = shareFolder(t, srv, alice, sub, "bob@example.com", "viewer")
	res.Body.Close()

	var bobID int64
	if err := db.QueryRow("SELECT id FROM users WHERE email = 'bob@example.com'").Scan(&bobID); err != nil {
		t.Fatal(err)
	}
	role, err := roleFor(db, docID, bobID)
	if err != nil {
		t.Fatal(err)
	}
	// The nearer grant is the weaker one. A "closest wins" rule would demote
	// bob to viewer here; the rule is that access adds and never subtracts.
	if role != "editor" {
		t.Fatalf("role = %q, want editor — a grant further up must not be taken away by a weaker one nearer", role)
	}

	// The same rule across the two kinds of grant: a direct commenter grant
	// does not pull a folder editor down.
	res = postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares",
		map[string]string{"email": "bob@example.com", "role": "commenter"})
	res.Body.Close()
	role, _ = roleFor(db, docID, bobID)
	if role != "editor" {
		t.Fatalf("role after a weaker direct grant = %q, want editor", role)
	}
}

// A folder you hold no grant on is not named to you, even when you can see
// what is inside it. The parent id comes back null instead, so the folder you
// were given is a root as far as you are concerned.
func TestFolderParentIsHiddenFromSomebodyGrantedOnlyTheChild(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")

	acq := createFolder(t, srv, alice, "Acquisitions", nil)
	falcon := createFolder(t, srv, alice, "Falcon", &acq)
	res := shareFolder(t, srv, alice, falcon, "bob@example.com", "viewer")
	res.Body.Close()

	fs := listFolders(t, srv, bob)
	if len(fs) != 1 {
		t.Fatalf("bob sees %d folders, want 1", len(fs))
	}
	if fs[0].ID != falcon {
		t.Fatalf("bob sees folder %s, want %s", fs[0].ID, falcon)
	}
	if fs[0].ParentID != nil {
		t.Fatalf("parent_id = %v, want null — the parent's name is not bob's to learn", *fs[0].ParentID)
	}
	// Alice, who holds the grant above, sees the real shape.
	for _, f := range listFolders(t, srv, alice) {
		if f.ID == falcon && (f.ParentID == nil || *f.ParentID != acq) {
			t.Fatalf("alice sees Falcon's parent as %v, want %s", f.ParentID, acq)
		}
	}
}

// A document whose folder you cannot see is not filed anywhere as far as you
// are concerned — the id is withheld too, since it would still tell you which
// documents are kept together.
func TestDocumentInAnInvisibleFolderReportsNoFolder(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")

	eng := createFolder(t, srv, alice, "Engineering", nil)
	docID := docIn(t, srv, alice, eng)
	res := postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/shares",
		map[string]string{"email": "bob@example.com", "role": "viewer"})
	res.Body.Close()

	docs := listDocs(t, srv, bob)
	if len(docs) != 1 {
		t.Fatalf("bob sees %d documents, want 1", len(docs))
	}
	if docs[0].FolderID != nil {
		t.Fatalf("folder_id = %v, want null", *docs[0].FolderID)
	}
}

// The share panel has to name everyone who can read the document, including
// the people a folder let in, or it states something false in the one place
// people go to check it.
func TestDocumentSharesListIncludesFolderMembers(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	apiClient(t, srv, "bob@example.com")

	eng := createFolder(t, srv, alice, "Engineering", nil)
	docID := docIn(t, srv, alice, eng)
	res := shareFolder(t, srv, alice, eng, "bob@example.com", "editor")
	res.Body.Close()

	res, err := alice.Get(srv.URL + "/api/docs/" + docID + "/shares")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var shares []shareEntry
	if err := json.NewDecoder(res.Body).Decode(&shares); err != nil {
		t.Fatal(err)
	}
	var bob *shareEntry
	for i := range shares {
		if shares[i].Email == "bob@example.com" {
			bob = &shares[i]
		}
	}
	if bob == nil {
		t.Fatalf("bob missing from the share list: %+v", shares)
	}
	if bob.Role != "editor" {
		t.Fatalf("bob's role = %q, want editor", bob.Role)
	}
	if bob.ViaFolderName != "Engineering" {
		t.Fatalf("via_folder_name = %q, want Engineering", bob.ViaFolderName)
	}
}

// Withdrawing a grant that was never made here must refuse rather than report
// success and change nothing.
func TestRemovingAnInheritedShareRefusesAndNamesTheFolder(t *testing.T) {
	srv, db, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	apiClient(t, srv, "bob@example.com")

	eng := createFolder(t, srv, alice, "Engineering", nil)
	docID := docIn(t, srv, alice, eng)
	res := shareFolder(t, srv, alice, eng, "bob@example.com", "editor")
	res.Body.Close()

	var bobID int64
	if err := db.QueryRow("SELECT id FROM users WHERE email = 'bob@example.com'").Scan(&bobID); err != nil {
		t.Fatal(err)
	}
	res = reqJSON(t, alice, "DELETE", srv.URL+"/api/docs/"+docID+"/shares/"+strconv.FormatInt(bobID, 10), nil)
	defer res.Body.Close()
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", res.StatusCode)
	}
	var body map[string]string
	json.NewDecoder(res.Body).Decode(&body)
	if !bytes.Contains([]byte(body["error"]), []byte("Engineering")) {
		t.Fatalf("error %q does not name the folder to go to", body["error"])
	}
	// And the access really is untouched.
	if role, _ := roleFor(db, docID, bobID); role != "editor" {
		t.Fatalf("role = %q after a refused removal, want editor", role)
	}
}

// Deleting a folder never deletes documents, because a folder's managers are
// not its documents' owners.
func TestDeletingANonEmptyFolderIsRefused(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")

	eng := createFolder(t, srv, alice, "Engineering", nil)
	docID := docIn(t, srv, alice, eng)

	res := reqJSON(t, alice, "DELETE", srv.URL+"/api/folders/"+eng, nil)
	res.Body.Close()
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("delete non-empty folder: %d, want 409", res.StatusCode)
	}

	// A subfolder counts as "inside" too.
	sub := createFolder(t, srv, alice, "Sub", &eng)
	res = reqJSON(t, alice, "POST", srv.URL+"/api/docs/"+docID+"/move", map[string]any{"folder_id": nil})
	res.Body.Close()
	res = reqJSON(t, alice, "DELETE", srv.URL+"/api/folders/"+eng, nil)
	res.Body.Close()
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("delete folder with a subfolder: %d, want 409", res.StatusCode)
	}

	// Emptied, it goes.
	res = reqJSON(t, alice, "DELETE", srv.URL+"/api/folders/"+sub, nil)
	res.Body.Close()
	res = reqJSON(t, alice, "DELETE", srv.URL+"/api/folders/"+eng, nil)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("delete empty folder: %d", res.StatusCode)
	}
}

// Moving a document out of a shared folder withdraws the access that folder
// was granting, and does it to a live socket rather than at the next reload.
func TestMovingADocumentOutOfAFolderEvictsTheReadersItLetIn(t *testing.T) {
	srv, db, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")

	eng := createFolder(t, srv, alice, "Engineering", nil)
	docID := docIn(t, srv, alice, eng)
	res := shareFolder(t, srv, alice, eng, "bob@example.com", "editor")
	res.Body.Close()

	conn := dialWS(t, srv, bob, docID)
	readUntilSynced(t, conn)

	res = reqJSON(t, alice, "POST", srv.URL+"/api/docs/"+docID+"/move", map[string]any{"folder_id": nil})
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("move out: %d %s", res.StatusCode, b)
	}
	res.Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := conn.Read(ctx); err != nil {
			break // evicted, which is the point
		}
	}
	var bobID int64
	db.QueryRow("SELECT id FROM users WHERE email = 'bob@example.com'").Scan(&bobID)
	if role, _ := roleFor(db, docID, bobID); role != "" {
		t.Fatalf("role after the move = %q, want none", role)
	}
	if docs := listDocs(t, srv, bob); len(docs) != 0 {
		t.Fatalf("bob still lists %d documents", len(docs))
	}
}

// A move that would leave the mover unable to reach the thing they moved is
// refused, and leaves it where it was. Without this a folder's manager could
// move somebody else's document into a folder only they can see.
func TestAMoveThatWouldRemoveYourOwnAccessIsRefused(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")

	eng := createFolder(t, srv, alice, "Engineering", nil)
	docID := docIn(t, srv, alice, eng)
	res := shareFolder(t, srv, alice, eng, "bob@example.com", "manager")
	res.Body.Close()

	// Bob's manager rank on the document comes entirely from Engineering, so
	// unfiling it would lock him out of it.
	res = reqJSON(t, bob, "POST", srv.URL+"/api/docs/"+docID+"/move", map[string]any{"folder_id": nil})
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
	docs := listDocs(t, srv, bob)
	if len(docs) != 1 || docs[0].FolderID == nil || *docs[0].FolderID != eng {
		t.Fatalf("the refused move did not leave the document where it was: %+v", docs)
	}
	// Alice owns it outright, so the same move is hers to make.
	res = reqJSON(t, alice, "POST", srv.URL+"/api/docs/"+docID+"/move", map[string]any{"folder_id": nil})
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("owner move out: %d", res.StatusCode)
	}
}

// A folder moved inside its own subtree would be unreachable from any root.
func TestAFolderCannotBeMovedIntoItself(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")

	top := createFolder(t, srv, alice, "Top", nil)
	sub := createFolder(t, srv, alice, "Sub", &top)
	deep := createFolder(t, srv, alice, "Deep", &sub)

	for _, dest := range []string{top, sub, deep} {
		res := reqJSON(t, alice, "POST", srv.URL+"/api/folders/"+top+"/move", map[string]any{"parent_id": dest})
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("move Top into %s: %d, want 400", dest, res.StatusCode)
		}
	}
	// Its parent is unchanged, and the tree is still walkable.
	if fs := listFolders(t, srv, alice); len(fs) != 3 {
		t.Fatalf("folders = %d, want 3", len(fs))
	}
}

// Shaping the tree is administration. An editor of a folder may put documents
// in it and may not carve it up.
func TestEditorOfAFolderCannotCreateSubfoldersOrShareIt(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	apiClient(t, srv, "carol@example.com")

	eng := createFolder(t, srv, alice, "Engineering", nil)
	res := shareFolder(t, srv, alice, eng, "bob@example.com", "editor")
	res.Body.Close()

	res = postJSON(t, bob, srv.URL+"/api/folders", map[string]any{"name": "Sub", "parent_id": eng})
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("editor creating a subfolder: %d, want 404", res.StatusCode)
	}
	res = shareFolder(t, srv, bob, eng, "carol@example.com", "viewer")
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("editor sharing the folder: %d, want 404", res.StatusCode)
	}
	res = reqJSON(t, bob, "PATCH", srv.URL+"/api/folders/"+eng, map[string]string{"name": "Bob's"})
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("editor renaming the folder: %d, want 404", res.StatusCode)
	}
	// But filling it is exactly what an editor is for.
	docIn(t, srv, bob, eng)
}

// There is no folder owner. A folder that could grant it would hand everyone
// inside the power to delete documents they did not create.
func TestAFolderCannotGrantOwner(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	apiClient(t, srv, "bob@example.com")

	eng := createFolder(t, srv, alice, "Engineering", nil)
	res := shareFolder(t, srv, alice, eng, "bob@example.com", "owner")
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("granting owner on a folder: %d, want 400", res.StatusCode)
	}
}

// Search and the inbox apply the same rule as the document list, so a folder
// grant reaches both without anything being reindexed.
func TestSearchFindsDocumentsReachedThroughAFolder(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")

	eng := createFolder(t, srv, alice, "Engineering", nil)
	docID := docIn(t, srv, alice, eng)
	res := postJSON(t, alice, srv.URL+"/api/docs/"+docID+"/index",
		map[string]string{"body": "the migration plan for kestrel"})
	res.Body.Close()

	if hits := searchDocs(t, srv, bob, "kestrel"); len(hits) != 0 {
		t.Fatalf("bob finds %d hits before the folder is shared", len(hits))
	}
	res = shareFolder(t, srv, alice, eng, "bob@example.com", "viewer")
	res.Body.Close()
	if hits := searchDocs(t, srv, bob, "kestrel"); len(hits) != 1 {
		t.Fatalf("bob finds %d hits after the folder is shared, want 1", len(hits))
	}
}

func searchDocs(t *testing.T, srv *httptest.Server, c *http.Client, q string) []docHit {
	t.Helper()
	res, err := c.Get(srv.URL + "/api/search?q=" + q)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out searchResults
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out.Documents
}

// Withdrawing a folder grant takes the access away from every document below
// it, live sockets included.
func TestWithdrawingAFolderGrantEvictsBelowIt(t *testing.T) {
	srv, db, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")

	top := createFolder(t, srv, alice, "Top", nil)
	sub := createFolder(t, srv, alice, "Sub", &top)
	docID := docIn(t, srv, alice, sub)
	res := shareFolder(t, srv, alice, top, "bob@example.com", "editor")
	res.Body.Close()

	conn := dialWS(t, srv, bob, docID)
	readUntilSynced(t, conn)

	var bobID int64
	db.QueryRow("SELECT id FROM users WHERE email = 'bob@example.com'").Scan(&bobID)
	res = reqJSON(t, alice, "DELETE", srv.URL+"/api/folders/"+top+"/shares/"+strconv.FormatInt(bobID, 10), nil)
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("withdraw folder grant: %d %s", res.StatusCode, b)
	}
	res.Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := conn.Read(ctx); err != nil {
			break
		}
	}
	if role, _ := roleFor(db, docID, bobID); role != "" {
		t.Fatalf("role after withdrawal = %q, want none", role)
	}
}

// Every other test starts from an empty database, where v12 runs against
// nothing. This one starts from a populated v11 — the shape a real instance
// upgrades from — because `ALTER TABLE ... ADD COLUMN` carrying a REFERENCES
// clause is the one statement in that migration SQLite can refuse outright.
func TestMigrateV11ToV12KeepsDocumentsAndFilesThemNowhere(t *testing.T) {
	path := t.TempDir() + "/v11.db"
	raw, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	for i, s := range []string{
		schemaV1, schemaV2, schemaV3, schemaV4, schemaV5, schemaV6,
		schemaV7, schemaV8, schemaV9, schemaV10, schemaV11,
	} {
		if _, err := raw.Exec(s); err != nil {
			t.Fatalf("apply v%d: %v", i+1, err)
		}
	}
	if _, err := raw.Exec("PRAGMA user_version = 11"); err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		`INSERT INTO users (id, email, name, pass_hash, created_at) VALUES (1,'a@e','A','x',0)`,
		`INSERT INTO documents (id, kind, title, created_at, updated_at) VALUES ('d1','doc','T',0,0)`,
		`INSERT INTO permissions (doc_id, user_id, role) VALUES ('d1',1,'owner')`,
	} {
		if _, err := raw.Exec(stmt); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	raw.Close()

	db, err := openDB(path) // applies v12
	if err != nil {
		t.Fatalf("migrate: %v", err)
	}
	defer db.Close()

	// The document survives, and lands in no folder — which is what "unfiled"
	// means, and the only sensible answer for anything that predates folders.
	var folderID sql.NullString
	if err := db.QueryRow("SELECT folder_id FROM documents WHERE id = 'd1'").Scan(&folderID); err != nil {
		t.Fatal(err)
	}
	if folderID.Valid {
		t.Fatalf("folder_id = %q, want NULL", folderID.String)
	}
	// And the grant it already had still resolves, now through the inherited
	// path rather than the single row roleFor used to read.
	if role, err := roleFor(db, "d1", 1); err != nil || role != "owner" {
		t.Fatalf("roleFor after migration = %q, %v", role, err)
	}
}
