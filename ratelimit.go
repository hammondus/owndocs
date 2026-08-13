package main

import (
	"sync"
	"time"
)

// Rate limiting for the login surface. The audience is trusted staff; the login
// page is on the public internet, so this defends the perimeter — see
// DESIGN-DECISIONS.md, *Threat model* and *Harden the login surface*.
//
// **In memory, not in SQLite.** A restart clears every counter, and that is an
// accepted cost rather than an oversight: an attacker cannot cause a restart,
// and the alternative is a disk write per failed attempt, which turns a
// password-guessing flood into a write amplifier and leaves a table to prune.
// One process, one map, no schema.
//
// Counted on **two keys at once**, because they fail differently. A per-account
// counter stops one account being ground down from a botnet; a per-source
// counter stops one host working through a list of accounts. Neither catches
// the other's case.
const (
	// Per account. Low, because a person who has typed their own password
	// wrong five times is not about to get it right on the sixth.
	accountFails = 5
	// Per source address, and deliberately far looser: an office behind one
	// NAT is a single address to this app, so a strict source limit locks out
	// a whole floor because one person is having a bad morning.
	sourceFails = 50

	// Lock length doubles per failure past the threshold, from one minute up
	// to a quarter of an hour. Progressive rather than fixed, so an honest
	// mistake costs a minute while a sustained attack costs real time.
	lockBase = time.Minute
	lockMax  = 15 * time.Minute

	// A counter with no failures for this long is forgotten, so yesterday's
	// typo does not count towards today's.
	idleWindow = 15 * time.Minute
	sweepEvery = 5 * time.Minute
)

type attemptRecord struct {
	fails    int
	lockedTo time.Time
	seen     time.Time
}

type loginLimiter struct {
	mu      sync.Mutex
	entries map[string]*attemptRecord
	swept   time.Time
	// Injected so the tests can move time without sleeping through a
	// fifteen-minute window.
	now func() time.Time
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{entries: map[string]*attemptRecord{}, now: time.Now}
}

// Prefixed, so an address can never collide with an email that looks like one.
func accountKey(email string) string { return "a:" + email }
func sourceKey(addr string) string   { return "s:" + addr }

// retryAfter reports how long the caller must wait before another attempt is
// worth making, or zero if they may try now. The longer of the two locks wins.
func (l *loginLimiter) retryAfter(email, source string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.sweepLocked(now)

	var wait time.Duration
	for _, key := range []string{accountKey(email), sourceKey(source)} {
		if e := l.entries[key]; e != nil {
			if d := e.lockedTo.Sub(now); d > wait {
				wait = d
			}
		}
	}
	return wait
}

// fail records one failed attempt against both keys.
//
// Called for an unknown account as well as a wrong password, and on purpose: a
// limiter that only counted real accounts would answer "locked" for one and
// "invalid" for the other, which is an account-existence oracle built out of
// the thing meant to protect them.
func (l *loginLimiter) fail(email, source string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.sweepLocked(now)
	l.bumpLocked(accountKey(email), accountFails, now)
	l.bumpLocked(sourceKey(source), sourceFails, now)
}

func (l *loginLimiter) bumpLocked(key string, threshold int, now time.Time) {
	e := l.entries[key]
	if e == nil || now.Sub(e.seen) > idleWindow {
		e = &attemptRecord{}
		l.entries[key] = e
	}
	e.fails++
	e.seen = now
	if e.fails < threshold {
		return
	}
	lock := lockBase << min(e.fails-threshold, 16)
	if lock > lockMax || lock <= 0 {
		lock = lockMax
	}
	e.lockedTo = now.Add(lock)
}

// succeed clears the account's counter after a real sign-in.
//
// **Only the account's.** Clearing the source counter too would hand an
// attacker a reset button: one account they legitimately hold, signed into
// between bursts, would wipe the address limit every time.
func (l *loginLimiter) succeed(email string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, accountKey(email))
}

// sweepLocked drops entries nobody has touched for a while, so the map cannot
// grow without bound on a login page anyone can reach.
//
// Lazy, inside the lock the caller already holds, rather than a goroutine with
// a ticker: there is no lifecycle to own, nothing to shut down, and the work
// happens only when something is happening anyway.
func (l *loginLimiter) sweepLocked(now time.Time) {
	if now.Sub(l.swept) < sweepEvery {
		return
	}
	l.swept = now
	for key, e := range l.entries {
		if now.Sub(e.seen) > idleWindow && now.After(e.lockedTo) {
			delete(l.entries, key)
		}
	}
}
