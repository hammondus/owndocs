package main

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Mentions: `@Craig Hammond` in a comment body.
//
// **Resolved against the document's own collaborators, not against all users.**
// That is what makes this work without adding a handle column to `users`:
// names are not unique across an instance and they contain spaces, so `@Craig`
// has no answer in general — but the people who can open one document are a
// short, known list, and matching against it is exact.
//
// It also means a mention only ever names someone who could already read the
// comment. Nothing here can be used to discover that an account exists.
//
// The match is **longest-first**, which is the only rule that makes a name with
// spaces parseable: given "Craig" and "Craig Hammond" on the same document,
// `@Craig Hammond` has to resolve to the second, and nothing but preferring the
// longer candidate gets there.
//
// Bodies are stored in the clear precisely so this can happen server-side — see
// DESIGN-DECISIONS.md, *Comment threads live in SQLite*.

// A person who could be mentioned on a document.
type mentionable struct {
	ID   int64
	Name string
}

// Whether a rune can be part of a name for boundary purposes. A mention has to
// end at one of these, or `@Craig` would match a candidate named "Cr".
func nameRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

// mentionsIn returns the ids named in `body`, in the order they first appear,
// without duplicates.
//
// An `@` preceded by a name character is not a mention, which is what keeps an
// email address in a comment from naming somebody: `craig@example.com` has a
// letter before the `@`, so it is never even considered.
func mentionsIn(body string, people []mentionable) []int64 {
	if len(people) == 0 {
		return nil
	}
	lower := strings.ToLower(body)
	seen := map[int64]bool{}
	var out []int64

	for i := 0; i < len(lower); i++ {
		if lower[i] != '@' {
			continue
		}
		if i > 0 {
			prev, size := utf8.DecodeLastRuneInString(lower[:i])
			if size > 0 && nameRune(prev) {
				continue
			}
		}
		rest := lower[i+1:]
		best := int64(0)
		bestLen := 0
		for _, p := range people {
			name := strings.ToLower(strings.TrimSpace(p.Name))
			if name == "" || len(name) <= bestLen || !strings.HasPrefix(rest, name) {
				continue
			}
			// The character after the match has to end the name, or `@Craigson`
			// resolves to Craig.
			if next, size := utf8.DecodeRuneInString(rest[len(name):]); size > 0 && nameRune(next) {
				continue
			}
			best, bestLen = p.ID, len(name)
		}
		if bestLen == 0 {
			continue
		}
		if !seen[best] {
			seen[best] = true
			out = append(out, best)
		}
		// Skip past what was matched: a name cannot contain a second mention.
		i += bestLen
	}
	return out
}
