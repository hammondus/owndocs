package main

import (
	"encoding/json"
	"strings"
	"testing"

)

// A full round trip with no server: one VM writes, the update it produces
// is applied to a second VM, and a script reads it back. That covers the
// whole Go/JavaScript bridge — the shims, the bundled model, the byte
// handoff in both directions, and the two-call run protocol.
func TestRunnerRoundTrip(t *testing.T) {
	author, err := newVM()
	if err != nil {
		t.Fatalf("author vm: %v", err)
	}
	res, err := runScript(author, `
		await docs.set('A1', [['Item', 'Price'], ['bolt', '$10'], ['nut', '$5.50']])
		await docs.set('B4', [['=SUM(B2:B3)']])
		log('wrote', (await docs.usedRange()).range)
	`, "")
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.Error != "" {
		t.Fatalf("script failed: %s", res.Error)
	}
	if len(res.Logs) != 1 || !strings.Contains(res.Logs[0], "A1:B4") {
		t.Fatalf("logs = %v", res.Logs)
	}

	update, err := callJSBytes(author, "docsPending")
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if len(update) == 0 {
		t.Fatal("no update produced for the server")
	}
	// Nothing more should be pending once it has been taken.
	again, err := callJSBytes(author, "docsPending")
	if err != nil || again != nil {
		t.Fatalf("pending drained wrong: %v %v", again, err)
	}

	// A second runner receives that update the way the server sends it.
	reader, err := newVM()
	if err != nil {
		t.Fatalf("reader vm: %v", err)
	}
	bad, err := callJS(reader, "docsApplyBatch", reader.ToValue(reader.NewArrayBuffer(frame(update))))
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if bad != "0" {
		t.Fatalf("%s undecodable frames", bad)
	}

	res, err = runScript(reader, `
		const rows = await docs.getText('A1:B4')
		log(JSON.stringify(rows))
		log('total is a number: ' + (typeof (await docs.get('B4'))[0][0]))
	`, "")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if res.Error != "" {
		t.Fatalf("read-back script failed: %s", res.Error)
	}
	// The currency inherited by the total proves format propagation — and
	// therefore the Intl shim — works inside Sobek exactly as in a browser.
	if !strings.Contains(res.Logs[0], `"$15.50"`) {
		t.Fatalf("total did not come back as currency: %v", res.Logs)
	}
	if !strings.Contains(res.Logs[1], "number") {
		t.Fatalf("value was not numeric: %v", res.Logs)
	}
}

// Length-prefix an update the way ws.go does, so the reader sees exactly
// what arrives over the wire.
func frame(update []byte) []byte {
	out := make([]byte, 0, len(update)+4)
	n := uint64(len(update))
	for n >= 0x80 {
		out = append(out, byte(n)|0x80)
		n >>= 7
	}
	return append(append(out, byte(n)), update...)
}

func TestRunnerReportsScriptErrors(t *testing.T) {
	vm, err := newVM()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, code, want string }{
		{"syntax", "this is not javascript", "SyntaxError"},
		{"thrown", "throw new Error('deliberate')", "deliberate"},
		{"bad range", "await docs.get('rubbish')", "A1 notation"},
		{"missing sheet", "await docs.get('A1', 'Nope')", "no sheet"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res, err := runScript(vm, tc.code, "")
			if err != nil {
				t.Fatalf("run: %v", err)
			}
			if !strings.Contains(res.Error, tc.want) {
				t.Fatalf("error = %q, want it to mention %q", res.Error, tc.want)
			}
		})
	}
}

// A script written for an on-edit trigger gets its event here too, so the
// same script can be run by hand, by the browser, or on a schedule.
func TestRunnerPassesEvent(t *testing.T) {
	vm, err := newVM()
	if err != nil {
		t.Fatal(err)
	}
	event, _ := json.Marshal(map[string]any{"sheet": "Sheet1", "range": "C2:C4", "cells": 3})
	res, err := runScript(vm, `log(event ? event.range : 'none')`, string(event))
	if err != nil {
		t.Fatal(err)
	}
	if res.Error != "" || len(res.Logs) != 1 || res.Logs[0] != "C2:C4" {
		t.Fatalf("logs=%v err=%q", res.Logs, res.Error)
	}

	res, err = runScript(vm, `log(event === null ? 'manual' : 'triggered')`, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Logs[0] != "manual" {
		t.Fatalf("a manual run should see a null event, got %v", res.Logs)
	}
}

// The state vector and diff path the reconnect logic depends on.
func TestRunnerDiff(t *testing.T) {
	a, err := newVM()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runScript(a, `await docs.set('A1', [['only here']])`, ""); err != nil {
		t.Fatal(err)
	}
	update, _ := callJSBytes(a, "docsPending")

	b, err := newVM()
	if err != nil {
		t.Fatal(err)
	}
	// B has seen nothing, so a diff against B's replay must carry A's write.
	diff, err := callJSBytes(a, "docsDiffFrom", a.ToValue(a.NewArrayBuffer(nil)))
	if err != nil {
		t.Fatalf("diff: %v", err)
	}
	if len(diff) == 0 {
		t.Fatal("diff against an empty peer should not be empty")
	}
	if _, err := callJS(b, "docsApplyBatch", b.ToValue(b.NewArrayBuffer(frame(update)))); err != nil {
		t.Fatal(err)
	}
	// Now that B has it, a diff against B's state should be nothing.
	same, err := callJSBytes(a, "docsDiffFrom", a.ToValue(a.NewArrayBuffer(frame(update))))
	if err != nil {
		t.Fatalf("diff: %v", err)
	}
	if same != nil {
		t.Fatalf("diff against a peer that is up to date should be empty, got %d bytes", len(same))
	}

}
