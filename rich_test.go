package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// PATCH /api/docs/{id} now carries two properties instead of one. Until schema
// v7 it took a title and nothing else, and required it to be non-empty; making
// room for the rich flag turned both fields into pointers so that "absent" and
// "empty" stay different questions.
//
// That rewrite could fail three ways without any existing test noticing, since
// there was no HTTP-level test of renaming at all: an empty title could become
// a silent no-op, a rename could clear the flag it never mentioned, and
// flipping the flag could blank the title. All three are asserted here.

func patchDoc(t *testing.T, c *http.Client, url string, body any) *http.Response {
	t.Helper()
	b, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPatch, url, bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

// The document as the owner's list reports it — which is the only way a client
// ever sees these fields, so it is the right place to assert them.
func docByID(t *testing.T, srv *httptest.Server, c *http.Client, id string) document {
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
	for _, d := range docs {
		if d.ID == id {
			return d
		}
	}
	t.Fatalf("document %s is not in the list", id)
	return document{}
}

func TestRichFlagDefaultsOffAndFlipsBothWays(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	id := createDoc(t, srv, alice)

	if d := docByID(t, srv, alice, id); d.Rich {
		t.Fatal("a new document is rich; the column default is wrong")
	}

	res := patchDoc(t, alice, srv.URL+"/api/docs/"+id, map[string]any{"rich": true})
	if res.StatusCode != 200 {
		t.Fatalf("turning the flag on: %d", res.StatusCode)
	}
	res.Body.Close()
	if d := docByID(t, srv, alice, id); !d.Rich {
		t.Fatal("the flag did not stick")
	}

	// Off again. Un-flagging is a bit-flip and not a migration — which is the
	// property that made this a column rather than a third `kind`.
	res = patchDoc(t, alice, srv.URL+"/api/docs/"+id, map[string]any{"rich": false})
	if res.StatusCode != 200 {
		t.Fatalf("turning the flag off: %d", res.StatusCode)
	}
	res.Body.Close()
	if d := docByID(t, srv, alice, id); d.Rich {
		t.Fatal("the flag would not turn off")
	}
}

func TestRenameAndFlagDoNotClobberEachOther(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	id := createDoc(t, srv, alice)

	patchDoc(t, alice, srv.URL+"/api/docs/"+id, map[string]any{"rich": true}).Body.Close()
	patchDoc(t, alice, srv.URL+"/api/docs/"+id, map[string]any{"title": "Renamed"}).Body.Close()

	d := docByID(t, srv, alice, id)
	if d.Title != "Renamed" {
		t.Fatalf("title = %q, want Renamed", d.Title)
	}
	if !d.Rich {
		t.Fatal("a rename that never mentioned the flag cleared it")
	}

	// And the other direction: flipping the flag must not blank the title.
	patchDoc(t, alice, srv.URL+"/api/docs/"+id, map[string]any{"rich": false}).Body.Close()
	if d := docByID(t, srv, alice, id); d.Title != "Renamed" {
		t.Fatalf("title after a flag write = %q, want Renamed", d.Title)
	}
}

func TestUpdateDocRejectsEmptyAndAbsentFields(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	id := createDoc(t, srv, alice)

	// A present-but-empty title is still the error it always was, rather than
	// quietly doing nothing now that the field is optional.
	res := patchDoc(t, alice, srv.URL+"/api/docs/"+id, map[string]any{"title": "   "})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty title: %d, want 400", res.StatusCode)
	}
	res.Body.Close()

	res = patchDoc(t, alice, srv.URL+"/api/docs/"+id, map[string]any{})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("no fields at all: %d, want 400", res.StatusCode)
	}
	res.Body.Close()
}

// The flag governs which buttons are offered, not what the format permits —
// but it is still a write to the document row, so it sits at the same bar as
// a rename. A viewer gets the same 404 that hides everything else.
func TestViewerCannotFlipTheRichFlag(t *testing.T) {
	srv, _, _ := testServer(t)
	alice := apiClient(t, srv, "alice@example.com")
	bob := apiClient(t, srv, "bob@example.com")
	id := createDoc(t, srv, alice)

	postJSON(t, alice, srv.URL+"/api/docs/"+id+"/shares",
		map[string]string{"email": "bob@example.com", "role": "viewer"}).Body.Close()

	res := patchDoc(t, bob, srv.URL+"/api/docs/"+id, map[string]any{"rich": true})
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("viewer flipping the flag: %d, want 404", res.StatusCode)
	}
	res.Body.Close()

	if d := docByID(t, srv, alice, id); d.Rich {
		t.Fatal("a viewer's rejected write still landed")
	}
}
