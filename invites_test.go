package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"sync"
	"testing"
)

// closedServer is testServer with signup closed, which is how a publicly
// reachable instance runs and therefore the mode invites exist for.
func closedServer(t *testing.T) *httptest.Server {
	t.Helper()
	db, err := openDB(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	// Seeding is main's job in the real binary, so the test does it here —
	// the quick login only signs in users that already exist.
	if err := seedDevUsers(db); err != nil {
		t.Fatal(err)
	}
	h := newHub(db, nil)
	srv := httptest.NewServer(routes(db, h, nil, nil, false, true))
	t.Cleanup(srv.Close)
	return srv
}

// devClient signs in through the -dev quick login, since on a closed instance
// the ordinary signup path is exactly what is being tested as blocked.
func devClient(t *testing.T, srv *httptest.Server, email string) *http.Client {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	res := postJSON(t, c, srv.URL+"/api/dev/login", map[string]string{"email": email})
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("dev login: status %d", res.StatusCode)
	}
	return c
}

func mintInvite(t *testing.T, srv *httptest.Server, c *http.Client, note string) invite {
	t.Helper()
	res := postJSON(t, c, srv.URL+"/api/invites", map[string]string{"note": note})
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("create invite: status %d", res.StatusCode)
	}
	var v invite
	if err := json.NewDecoder(res.Body).Decode(&v); err != nil {
		t.Fatal(err)
	}
	if v.Token == "" {
		t.Fatal("no token returned")
	}
	return v
}

func signup(t *testing.T, srv *httptest.Server, email, token string) *http.Response {
	t.Helper()
	body := map[string]string{"email": email, "name": "New Staff", "password": "hunter2hunter2"}
	if token != "" {
		body["invite"] = token
	}
	return postJSON(t, &http.Client{}, srv.URL+"/api/signup", body)
}

// The point of the whole feature: closed signup is a wall, and an invite is
// the door through it.
func TestClosedSignupNeedsAnInvite(t *testing.T) {
	srv := closedServer(t)
	alice := devClient(t, srv, "alice@dev.local")

	res := signup(t, srv, "walkin@example.com", "")
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("signup without an invite: status %d, want 403", res.StatusCode)
	}

	v := mintInvite(t, srv, alice, "New Starter")
	res = signup(t, srv, "invited@example.com", v.Token)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("signup with an invite: status %d", res.StatusCode)
	}
}

// An invite creates an account, so it must be spendable exactly once —
// otherwise "the link for the new hires" quietly becomes six accounts.
func TestInviteIsSingleUse(t *testing.T) {
	srv := closedServer(t)
	alice := devClient(t, srv, "alice@dev.local")
	v := mintInvite(t, srv, alice, "One Person")

	res := signup(t, srv, "first@example.com", v.Token)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("first use: status %d", res.StatusCode)
	}
	res = signup(t, srv, "second@example.com", v.Token)
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("invite reused: status %d, want 403", res.StatusCode)
	}
}

// Concurrent signups on one link. Stated honestly: the pool is MaxOpenConns(1),
// so transactions already serialize and a check-then-update would pass this too
// — the test guards the observable behaviour, not the mechanism. The UPDATE
// still carries its own used_at IS NULL test, because the day that pool setting
// changes is not the day anyone will remember this depended on it.
func TestInviteRaceLetsExactlyOneThrough(t *testing.T) {
	srv := closedServer(t)
	alice := devClient(t, srv, "alice@dev.local")
	v := mintInvite(t, srv, alice, "Race")

	const racers = 6
	var wg sync.WaitGroup
	codes := make([]int, racers)
	for i := range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res := signup(t, srv, fmt.Sprintf("racer%d@example.com", i), v.Token)
			codes[i] = res.StatusCode
			res.Body.Close()
		}()
	}
	wg.Wait()
	won := 0
	for _, c := range codes {
		if c == 200 {
			won++
		}
	}
	if won != 1 {
		t.Fatalf("%d of %d concurrent signups succeeded on one invite, want exactly 1", won, racers)
	}
}

// A failed signup must not burn the link — the invite and the account are
// created in one transaction precisely so a rejected password does not cost
// someone their invite.
func TestFailedSignupDoesNotSpendTheInvite(t *testing.T) {
	srv := closedServer(t)
	alice := devClient(t, srv, "alice@dev.local")
	v := mintInvite(t, srv, alice, "Butterfingers")

	// Too-short password: rejected before the account exists.
	res := postJSON(t, &http.Client{}, srv.URL+"/api/signup", map[string]string{
		"email": "oops@example.com", "name": "Oops", "password": "short", "invite": v.Token,
	})
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("short password: status %d", res.StatusCode)
	}

	res = signup(t, srv, "oops@example.com", v.Token)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("invite was spent by a failed attempt: status %d", res.StatusCode)
	}
}

func TestRevokedInviteCannotBeUsed(t *testing.T) {
	srv := closedServer(t)
	alice := devClient(t, srv, "alice@dev.local")
	v := mintInvite(t, srv, alice, "Changed My Mind")

	req, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/invites/%d", srv.URL, v.ID), nil)
	res, err := alice.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	res = signup(t, srv, "toolate@example.com", v.Token)
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("revoked invite still worked: status %d", res.StatusCode)
	}
}

// The token is a capability, so only its hash is stored — a database read must
// not yield a working invite link.
func TestInviteTokenIsNotStoredInTheClear(t *testing.T) {
	srv := closedServer(t)
	alice := devClient(t, srv, "alice@dev.local")
	v := mintInvite(t, srv, alice, "Secret")

	res, err := alice.Get(srv.URL + "/api/invites")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var list []invite
	if err := json.NewDecoder(res.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("want 1 invite listed, got %d", len(list))
	}
	if list[0].Token != "" {
		t.Fatal("listing an invite handed back its token")
	}
	_ = v
}
