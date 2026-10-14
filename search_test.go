package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func searchAll(t *testing.T, srv *httptest.Server, c *http.Client, q string) searchResults {
	t.Helper()
	res, err := c.Get(srv.URL + "/api/search?q=" + url.QueryEscape(q))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("search %q: status %d", q, res.StatusCode)
	}
	var out searchResults
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

// searchAs returns just the comment hits, which is what the stage-1 tests are
// about.
func searchAs(t *testing.T, srv *httptest.Server, c *http.Client, q string) []searchHit {
	t.Helper()
	return searchAll(t, srv, c, q).Comments
}

// indexDoc posts extracted text the way a client that has the document open
// would.
func indexDoc(t *testing.T, srv *httptest.Server, c *http.Client, docID, body string) *http.Response {
	t.Helper()
	return postJSON(t, c, srv.URL+"/api/docs/"+docID+"/index", map[string]string{"body": body})
}

// The property the whole design rests on: the index is content-keyed, so what
// somebody may see is decided by `permissions` at query time and nowhere else.
// If this ever fails, search has become a way to read documents you were not
// shared on.
func TestSearchIsFilteredByPermission(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	openThread(t, srv, alice, docID, "the quarterly revenue forecast is wrong")

	if got := searchAs(t, srv, alice, "revenue"); len(got) != 1 {
		t.Fatalf("owner should find her own comment, got %d hits", len(got))
	}
	if got := searchAs(t, srv, bob, "revenue"); len(got) != 0 {
		t.Fatalf("stranger found %d hits in a document not shared with him", len(got))
	}
}

// The corollary, and the reason permissions are not baked into the index:
// sharing and unsharing take effect on the next search, with no reindexing.
func TestSearchFollowsSharesWithoutReindexing(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	openThread(t, srv, alice, docID, "the quarterly revenue forecast is wrong")

	share(t, srv, alice, docID, "bob@example.com", "viewer")
	if got := searchAs(t, srv, bob, "revenue"); len(got) != 1 {
		t.Fatalf("viewer should find the comment once shared, got %d", len(got))
	}

	// Revoke. Nothing touches the index; only the join changes.
	var bobID int64
	var shares []shareEntry
	res, _ := alice.Get(srv.URL + "/api/docs/" + docID + "/shares")
	json.NewDecoder(res.Body).Decode(&shares)
	res.Body.Close()
	for _, s := range shares {
		if s.Email == "bob@example.com" {
			bobID = s.UserID
		}
	}
	req, _ := http.NewRequest("DELETE", srv.URL+"/api/docs/"+docID+"/shares/"+itoa(bobID), nil)
	res, err := alice.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("revoke: %v %d", err, res.StatusCode)
	}
	res.Body.Close()

	if got := searchAs(t, srv, bob, "revenue"); len(got) != 0 {
		t.Fatalf("revoked user still found %d hits", len(got))
	}
}

// The triggers are the whole correctness story for an external-content FTS5
// table: without them the index drifts from `comments` and search quietly
// starts lying. Editing must retract the old text as well as add the new —
// getting the 'delete' command wrong leaves a row that matches and then
// resolves to nothing.
func TestIndexTracksEditsAndDeletes(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)
	tid := openThread(t, srv, alice, docID, "aardvark")

	hits := searchAs(t, srv, alice, "aardvark")
	if len(hits) != 1 {
		t.Fatalf("new comment not indexed: %d hits", len(hits))
	}
	cid := hits[0].CommentID

	res := sendJSON(t, alice, "PATCH",
		srv.URL+"/api/docs/"+docID+"/comments/"+itoa(tid)+"/"+itoa(cid),
		map[string]string{"body": "buffalo"})
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("edit comment: status %d", res.StatusCode)
	}
	if got := searchAs(t, srv, alice, "aardvark"); len(got) != 0 {
		t.Fatalf("edited-away text still matches: %d hits", len(got))
	}
	if got := searchAs(t, srv, alice, "buffalo"); len(got) != 1 {
		t.Fatalf("edited-in text does not match: %d hits", len(got))
	}

	req, _ := http.NewRequest("DELETE",
		srv.URL+"/api/docs/"+docID+"/comments/"+itoa(tid)+"/"+itoa(cid), nil)
	if r, err := alice.Do(req); err == nil {
		r.Body.Close()
	}
	if got := searchAs(t, srv, alice, "buffalo"); len(got) != 0 {
		t.Fatalf("deleted comment still matches: %d hits", len(got))
	}
}

// A search box is a place people type punctuation. MATCH is a query language,
// so an unsanitised box turns an apostrophe into a 500 — these are the inputs
// that used to do it.
func TestSearchSurvivesQuerySyntax(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)
	openThread(t, srv, alice, docID, "don't ship it")

	for _, q := range []string{`don't`, `"`, `AND`, `*`, `foo OR`, `a:b`, `(`, `^x`, `   `, `""""`} {
		if got := searchAs(t, srv, alice, q); got == nil {
			t.Fatalf("query %q returned null rather than a list", q)
		}
	}
	// And the apostrophe case still finds the thing, rather than merely not
	// crashing: the tokenizer drops it, so the terms are what remain.
	if got := searchAs(t, srv, alice, "don ship"); len(got) != 1 {
		t.Fatalf("apostrophe query found %d hits", len(got))
	}
}

func TestFTSQuery(t *testing.T) {
	cases := []struct{ in, want string }{
		{"budget", `"budget"*`},
		{"quarterly revenue", `"quarterly"* "revenue"*`},
		{"don't", `"dont"*`},
		{"  spaced   out  ", `"spaced"* "out"*`},
		{`"quoted"`, `"quoted"*`},
		{"AND", `"AND"*`}, // an operator only if unquoted; quoting neuters it
		{"", ""},
		{"   ", ""},
		{"!!! ???", ""},
		{"café", `"café"*`},
	}
	for _, c := range cases {
		if got := ftsQuery(searchTerms(c.in)); got != c.want {
			t.Errorf("ftsQuery(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// Prefix matching, because a search box that needs the whole word is one people
// stop using. This is the reason the terms carry `*` rather than being plain
// quoted phrases.
func TestSearchMatchesPrefixes(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)
	openThread(t, srv, alice, docID, "the budget spreadsheet")

	if got := searchAs(t, srv, alice, "budg"); len(got) != 1 {
		t.Fatalf("prefix search found %d hits", len(got))
	}
}

// The snippet carries user-written text, so it must never carry markup: the
// client renders elements itself from these markers, through normal escaping.
// If this ever becomes `<mark>`, a comment body becomes an XSS payload.
func TestSnippetMarkersAreNotMarkup(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)
	openThread(t, srv, alice, docID, "the budget is fine")

	hits := searchAs(t, srv, alice, "budget")
	if len(hits) != 1 {
		t.Fatalf("got %d hits", len(hits))
	}
	if strings.ContainsAny(hits[0].Snippet, "<>") {
		t.Fatalf("snippet contains markup: %q", hits[0].Snippet)
	}
	if !strings.Contains(hits[0].Snippet, hlStart) || !strings.Contains(hits[0].Snippet, hlEnd) {
		t.Fatalf("snippet carries no highlight markers: %q", hits[0].Snippet)
	}
}

// Stage 2. The authorisation is the point: indexing is gated by the same role
// check as reading, so nobody gains a way to put text into the index for a
// document they cannot open.
func TestIndexingRequiresAccess(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	mallory := apiClient(t, srv, "mallory@example.com")
	docID := createDoc(t, srv, alice)

	res := indexDoc(t, srv, mallory, docID, "text I should not be able to inject")
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("stranger indexed a document: status %d", res.StatusCode)
	}
	if got := searchAll(t, srv, alice, "inject").Documents; len(got) != 0 {
		t.Fatalf("stranger's text reached the index: %d hits", len(got))
	}
}

// A viewer may index, because a viewer may read. The index can only ever
// contain what its poster was already allowed to see.
func TestViewerMayIndex(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	share(t, srv, alice, docID, "bob@example.com", "viewer")

	res := indexDoc(t, srv, bob, docID, "the annual maintenance schedule")
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("viewer could not index: status %d", res.StatusCode)
	}
	if got := searchAll(t, srv, alice, "maintenance").Documents; len(got) != 1 {
		t.Fatalf("owner found %d document hits", len(got))
	}
}

// Document hits are filtered by the same join as comment hits.
func TestDocumentSearchIsFilteredByPermission(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	res := indexDoc(t, srv, alice, docID, "the confidential acquisition memo")
	res.Body.Close()

	if got := searchAll(t, srv, alice, "acquisition").Documents; len(got) != 1 {
		t.Fatalf("owner found %d hits in her own document", len(got))
	}
	if got := searchAll(t, srv, bob, "acquisition").Documents; len(got) != 0 {
		t.Fatalf("stranger found %d hits in a document not shared with him", len(got))
	}
}

// Re-indexing replaces rather than accumulates. Without this a deleted
// paragraph stays findable forever, which is worse than not indexing at all —
// search would be quoting text the document no longer contains.
func TestReindexingReplaces(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)

	res := indexDoc(t, srv, alice, docID, "aardvark paragraph")
	res.Body.Close()
	if got := searchAll(t, srv, alice, "aardvark").Documents; len(got) != 1 {
		t.Fatalf("first index: %d hits", len(got))
	}

	res = indexDoc(t, srv, alice, docID, "buffalo paragraph")
	res.Body.Close()
	if got := searchAll(t, srv, alice, "aardvark").Documents; len(got) != 0 {
		t.Fatalf("removed text still findable: %d hits", len(got))
	}
	if got := searchAll(t, srv, alice, "buffalo").Documents; len(got) != 1 {
		t.Fatalf("new text not findable: %d hits", len(got))
	}

	// Emptying a document removes it from the index rather than leaving the
	// last version behind.
	res = indexDoc(t, srv, alice, docID, "   ")
	res.Body.Close()
	if got := searchAll(t, srv, alice, "buffalo").Documents; len(got) != 0 {
		t.Fatalf("emptied document still findable: %d hits", len(got))
	}
}

// One row per document, however many clients have it open. Two people editing
// together must not produce two hits for one document.
func TestConcurrentIndexersLeaveOneRow(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	docID := createDoc(t, srv, alice)
	share(t, srv, alice, docID, "bob@example.com", "editor")

	for i := 0; i < 3; i++ {
		indexDoc(t, srv, alice, docID, "shared planning document").Body.Close()
		indexDoc(t, srv, bob, docID, "shared planning document").Body.Close()
	}
	if got := searchAll(t, srv, alice, "planning").Documents; len(got) != 1 {
		t.Fatalf("want exactly one hit for one document, got %d", len(got))
	}
}

// indexed_at is what makes the staleness of a client-driven index measurable,
// which is the thing stages 1 and 2 exist to find out before a headless
// indexer is justified.
func TestIndexedAtIsReported(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	docID := createDoc(t, srv, alice)
	indexDoc(t, srv, alice, docID, "the budget").Body.Close()

	hits := searchAll(t, srv, alice, "budget").Documents
	if len(hits) != 1 {
		t.Fatalf("got %d hits", len(hits))
	}
	if hits[0].IndexedAt == 0 {
		t.Fatal("indexed_at not recorded")
	}
}

// Folders are found by name, carrying the path above them as far as the
// viewer can see, and only the viewer's own folders are searched.
func TestSearchFindsFoldersByName(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	eng := createFolder(t, srv, alice, "Engineering", nil)
	runbooks := createFolder(t, srv, alice, "Runbooks", &eng)
	createFolder(t, srv, alice, "Deploy notes", &runbooks)

	got := searchAll(t, srv, alice, "run").Folders
	if len(got) != 1 || got[0].ID != runbooks {
		t.Fatalf("alice searching 'run' got %+v", got)
	}
	if strings.Join(got[0].Path, "/") != "Engineering" {
		t.Fatalf("path above Runbooks = %v, want [Engineering]", got[0].Path)
	}
	// Every term has to match, case-insensitively.
	if got := searchAll(t, srv, alice, "DEPLOY notes").Folders; len(got) != 1 || got[0].Name != "Deploy notes" {
		t.Fatalf("two-term search got %+v", got)
	}
	if got := searchAll(t, srv, alice, "deploy runbooks").Folders; len(got) != 0 {
		t.Fatalf("a term matching only the parent should not match the child, got %+v", got)
	}

	// A stranger sees nothing; somebody granted only the child sees the child
	// with no path above it, because the parent's name is not theirs to know.
	if got := searchAll(t, srv, bob, "run").Folders; len(got) != 0 {
		t.Fatalf("stranger found folders: %+v", got)
	}
	shareFolder(t, srv, alice, runbooks, "bob@example.com", "viewer").Body.Close()
	got = searchAll(t, srv, bob, "run").Folders
	if len(got) != 1 || len(got[0].Path) != 0 {
		t.Fatalf("bob, granted only Runbooks, got %+v", got)
	}
	if got := searchAll(t, srv, bob, "notes").Folders; len(got) != 1 || strings.Join(got[0].Path, "/") != "Runbooks" {
		t.Fatalf("bob's path to the grandchild should start at his grant, got %+v", got)
	}
}
