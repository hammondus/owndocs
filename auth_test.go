package main

import "testing"

func TestPasswordHashRoundtrip(t *testing.T) {
	h := hashPassword("correct horse battery staple")
	if !verifyPassword("correct horse battery staple", h) {
		t.Error("correct password rejected")
	}
	if verifyPassword("wrong password", h) {
		t.Error("wrong password accepted")
	}
	if verifyPassword("correct horse battery staple", "$argon2id$garbage") {
		t.Error("malformed hash accepted")
	}
}

func TestFrameUpdatesRoundtrip(t *testing.T) {
	updates := [][]byte{{1, 2, 3}, {}, make([]byte, 300)}
	framed := frameUpdates(updates)
	var got [][]byte
	for i := 0; i < len(framed); {
		n, w := uvarint(framed[i:])
		i += w
		got = append(got, framed[i:i+n])
		i += n
	}
	if len(got) != len(updates) {
		t.Fatalf("got %d frames, want %d", len(got), len(updates))
	}
	for i := range updates {
		if string(got[i]) != string(updates[i]) {
			t.Errorf("frame %d mismatch", i)
		}
	}
}

// uvarint is a test-local decoder mirroring encoding/binary.Uvarint but
// returning int sizes for convenience.
func uvarint(b []byte) (int, int) {
	var x uint64
	var s uint
	for i, c := range b {
		if c < 0x80 {
			return int(x | uint64(c)<<s), i + 1
		}
		x |= uint64(c&0x7f) << s
		s += 7
	}
	panic("truncated uvarint")
}
