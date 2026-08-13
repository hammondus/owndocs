package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestDevLogin(t *testing.T) {
	db, err := openDB(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := seedDevUsers(db); err != nil {
		t.Fatal(err)
	}

	static := fstest.MapFS{}

	// Dev mode off: the endpoints must not exist. (An unmatched /api path
	// falls through to the static handler, hence 404 via the file server.)
	off := httptest.NewServer(routes(db, newHub(db, nil), nil, static, true, false))
	defer off.Close()
	res, _ := http.Get(off.URL + "/api/dev/users")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("dev endpoint present without -dev: %d", res.StatusCode)
	}
	res.Body.Close()

	// Dev mode on: quick login works for seeded users only.
	on := httptest.NewServer(routes(db, newHub(db, nil), nil, static, true, true))
	defer on.Close()

	body, _ := json.Marshal(map[string]string{"email": "alice@dev.local"})
	res, err = http.Post(on.URL+"/api/dev/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var u user
	json.NewDecoder(res.Body).Decode(&u)
	res.Body.Close()
	if res.StatusCode != 200 || u.Email != "alice@dev.local" {
		t.Fatalf("dev login: status %d user %+v", res.StatusCode, u)
	}
	if len(res.Cookies()) == 0 {
		t.Fatal("dev login set no session cookie")
	}

	// A real (non-seeded) account must be refused — this endpoint cannot be
	// a bypass for arbitrary users.
	body, _ = json.Marshal(map[string]string{"email": "victim@example.com"})
	res, _ = http.Post(on.URL+"/api/dev/login", "application/json", bytes.NewReader(body))
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-dev email accepted: %d", res.StatusCode)
	}
	res.Body.Close()
}
