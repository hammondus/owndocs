package main

import (
	"net/http"
	"testing"
	"time"
)

// A limiter whose clock the test drives, so a fifteen-minute window costs no
// wall time.
func testLimiter() (*loginLimiter, func(time.Duration)) {
	l := newLoginLimiter()
	now := time.Unix(1_700_000_000, 0)
	l.now = func() time.Time { return now }
	return l, func(d time.Duration) { now = now.Add(d) }
}

func TestAccountLocksOutAfterRepeatedFailures(t *testing.T) {
	l, advance := testLimiter()

	for i := 0; i < accountFails-1; i++ {
		l.fail("a@example.com", "10.0.0.1")
		if w := l.retryAfter("a@example.com", "10.0.0.1"); w != 0 {
			t.Fatalf("locked after %d failures, want %d", i+1, accountFails)
		}
	}
	l.fail("a@example.com", "10.0.0.1")
	if w := l.retryAfter("a@example.com", "10.0.0.1"); w != lockBase {
		t.Fatalf("wait = %v, want %v", w, lockBase)
	}

	// The lock expires on its own.
	advance(lockBase)
	if w := l.retryAfter("a@example.com", "10.0.0.1"); w != 0 {
		t.Fatalf("still locked %v after the wait", w)
	}
}

func TestLockGrowsAndIsCapped(t *testing.T) {
	l, advance := testLimiter()
	for i := 0; i < accountFails; i++ {
		l.fail("a@example.com", "10.0.0.1")
	}
	prev := l.retryAfter("a@example.com", "10.0.0.1")

	// Each further failure past the threshold doubles the wait, to a cap.
	for i := 0; i < 10; i++ {
		l.fail("a@example.com", "10.0.0.1")
		got := l.retryAfter("a@example.com", "10.0.0.1")
		if got < prev {
			t.Fatalf("wait shrank from %v to %v", prev, got)
		}
		if got > lockMax {
			t.Fatalf("wait %v exceeds the cap %v", got, lockMax)
		}
		prev = got
	}
	if prev != lockMax {
		t.Fatalf("never reached the cap: %v", prev)
	}
	advance(lockMax)
	if w := l.retryAfter("a@example.com", "10.0.0.1"); w != 0 {
		t.Fatalf("locked forever: %v", w)
	}
}

// One account being ground down must not lock out everybody else, which is
// what a source-only limiter would do.
func TestOneAccountLockDoesNotAffectAnother(t *testing.T) {
	l, _ := testLimiter()
	for i := 0; i < accountFails; i++ {
		l.fail("victim@example.com", "10.0.0.1")
	}
	if l.retryAfter("victim@example.com", "10.0.0.1") == 0 {
		t.Fatal("the account is not locked")
	}
	if w := l.retryAfter("other@example.com", "10.0.0.1"); w != 0 {
		t.Fatalf("an unrelated account is locked for %v", w)
	}
}

// And one host working through a list of accounts is caught by the source
// counter, which the per-account one never sees.
func TestSourceLocksOutAcrossManyAccounts(t *testing.T) {
	l, _ := testLimiter()
	for i := 0; i < sourceFails; i++ {
		// A different account each time, so no account counter ever reaches
		// its own threshold.
		l.fail(string(rune('a'+i%26))+"@example.com", "10.0.0.9")
	}
	if w := l.retryAfter("fresh@example.com", "10.0.0.9"); w == 0 {
		t.Fatal("the source is not limited")
	}
	// A different address is unaffected.
	if w := l.retryAfter("fresh@example.com", "10.0.0.10"); w != 0 {
		t.Fatalf("an unrelated source is locked for %v", w)
	}
}

// The rule that is easy to get wrong: signing in successfully clears the
// account's counter but must NOT clear the source's, or one account an
// attacker legitimately holds becomes a reset button for the address limit.
func TestSuccessClearsTheAccountButNotTheSource(t *testing.T) {
	l, _ := testLimiter()
	for i := 0; i < sourceFails; i++ {
		l.fail(string(rune('a'+i%26))+"@example.com", "10.0.0.9")
	}
	l.succeed("mine@example.com")
	if w := l.retryAfter("mine@example.com", "10.0.0.9"); w == 0 {
		t.Fatal("a successful sign-in reset the source counter")
	}

	// But a locked account really is cleared by getting it right.
	l2, _ := testLimiter()
	for i := 0; i < accountFails; i++ {
		l2.fail("a@example.com", "10.0.0.1")
	}
	l2.succeed("a@example.com")
	if w := l2.retryAfter("a@example.com", "10.0.0.1"); w != 0 {
		t.Fatalf("account still locked after a success: %v", w)
	}
}

// Yesterday's typo must not count towards today's.
func TestCountersDecayWhenIdle(t *testing.T) {
	l, advance := testLimiter()
	for i := 0; i < accountFails-1; i++ {
		l.fail("a@example.com", "10.0.0.1")
	}
	advance(idleWindow + time.Second)
	// The next failure starts a fresh count, so it must not trip the lock.
	l.fail("a@example.com", "10.0.0.1")
	if w := l.retryAfter("a@example.com", "10.0.0.1"); w != 0 {
		t.Fatalf("stale failures still counted: locked for %v", w)
	}
}

// The map must not grow without bound on a login page anyone can reach.
func TestSweepDropsStaleEntries(t *testing.T) {
	l, advance := testLimiter()
	for i := 0; i < 200; i++ {
		l.fail(string(rune(i))+"@example.com", "10.0.0.1")
	}
	if len(l.entries) < 100 {
		t.Fatalf("setup: only %d entries", len(l.entries))
	}
	advance(idleWindow + sweepEvery + time.Second)
	l.retryAfter("nobody@example.com", "10.0.0.2") // any call sweeps
	// The source entry is still locked, so it stays; the account entries go.
	if len(l.entries) > 5 {
		t.Fatalf("%d entries survived the sweep", len(l.entries))
	}
}

// End to end, through the real handler: the limiter has to sit in front of the
// password check, not behind it.
func TestLoginEndpointRateLimits(t *testing.T) {
	srv, _, _ := testServer(t)
	apiClient(t, srv, "alice@example.com") // creates the account

	var last *http.Response
	for i := 0; i < accountFails+1; i++ {
		last = postJSON(t, srv.Client(), srv.URL+"/api/login",
			map[string]string{"email": "alice@example.com", "password": "wrong-password"})
		if i < accountFails-1 && last.StatusCode != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status %d, want 401", i+1, last.StatusCode)
		}
		last.Body.Close()
	}

	res := postJSON(t, srv.Client(), srv.URL+"/api/login",
		map[string]string{"email": "alice@example.com", "password": "wrong-password"})
	defer res.Body.Close()
	if res.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status %d, want 429", res.StatusCode)
	}
	if res.Header.Get("Retry-After") == "" {
		t.Fatal("no Retry-After header")
	}

	// And the correct password is refused too — a lockout that the right
	// password walks through is not a lockout.
	res2 := postJSON(t, srv.Client(), srv.URL+"/api/login",
		map[string]string{"email": "alice@example.com", "password": "hunter2hunter2"})
	defer res2.Body.Close()
	if res2.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("correct password during lockout: status %d, want 429", res2.StatusCode)
	}
}

// An unknown account is counted like any other. A limiter that skipped them
// would answer "locked" for a real address and "invalid" for a made-up one,
// which is an account-existence oracle built out of the defence.
func TestUnknownAccountsAreCountedToo(t *testing.T) {
	l, _ := testLimiter()
	for i := 0; i < accountFails; i++ {
		l.fail("nobody@example.com", "10.0.0.1")
	}
	if w := l.retryAfter("nobody@example.com", "10.0.0.1"); w == 0 {
		t.Fatal("an unknown account is never locked, which distinguishes it from a real one")
	}
}
