package main

import (
	"reflect"
	"testing"
)

// The candidate set a real document has: names of differing lengths, one a
// prefix of another, and one with an accent.
var people = []mentionable{
	{ID: 1, Name: "Craig"},
	{ID: 2, Name: "Craig Hammond"},
	{ID: 3, Name: "Bo"},
	{ID: 4, Name: "Zoë Nguyen"},
}

func TestMentionsIn(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []int64
	}{
		{"nothing at all", "just a comment", nil},
		{"one name", "@Craig can you look", []int64{1}},
		{"case is ignored", "@craig can you look", []int64{1}},

		// The rule that makes a name with spaces parseable at all. Without
		// longest-first this resolves to Craig and silently names the wrong
		// person — who is, worse, also on the document.
		{"longest wins", "@Craig Hammond can you look", []int64{2}},
		{"and not the other way round", "hey @Craig, and @Craig Hammond", []int64{1, 2}},

		// The boundary check. Without it every longer word starting with a
		// candidate name resolves to that candidate.
		{"a longer word is not a name", "@Craigson is not here", nil},
		{"punctuation ends a name", "@Craig, please", []int64{1}},
		{"end of body ends a name", "ping @Bo", []int64{3}},
		{"a non-ascii name still matches", "thanks @Zoë Nguyen", []int64{4}},

		// The one that would otherwise notify someone every time an address is
		// pasted into a thread.
		{"an email address is not a mention", "write to craig@example.com", nil},
		{"but an @ after a space is", "write to @Craig", []int64{1}},

		{"duplicates collapse", "@Craig @Craig @Craig", []int64{1}},
		{"order is first appearance", "@Bo and @Craig", []int64{3, 1}},
		{"an unknown name resolves to nobody", "@Nobody here", nil},
		{"a bare @ is not a mention", "email @ me", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := mentionsIn(c.body, people); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("mentionsIn(%q) = %v, want %v", c.body, got, c.want)
			}
		})
	}
}

// A document with nobody on it cannot produce a mention, and must not panic
// trying — an empty candidate set is what a brand-new unshared document has.
func TestMentionsWithNoCandidates(t *testing.T) {
	if got := mentionsIn("@Craig", nil); got != nil {
		t.Fatalf("got %v, want nil", got)
	}
}

// A user whose name is blank or whitespace must never match: an empty prefix
// matches everything, so this would name them in every comment ever written.
func TestBlankNameNeverMatches(t *testing.T) {
	got := mentionsIn("@Craig said something", []mentionable{{ID: 9, Name: "   "}, {ID: 1, Name: "Craig"}})
	if !reflect.DeepEqual(got, []int64{1}) {
		t.Fatalf("got %v, want [1]", got)
	}
}
