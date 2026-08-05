// Command runner executes a document's scripts headlessly — the half of
// scripting a browser cannot do: scheduled and unattended runs.
//
// It is "just another client", the same shape as the git exporter: it logs
// in with an ordinary account and speaks the ordinary WebSocket protocol.
// The server is unchanged and still cannot read a document.
//
// The interesting decision is that the document model is NOT reimplemented
// in Go. The server treats Yjs updates as opaque blobs, so anything that
// wants to read a document needs a CRDT — and there is no Go one worth
// betting on (the alternatives were cgo to Rust's yrs, or writing a
// Yjs-compatible implementation, either of which could corrupt documents
// in ways the browser would not). Instead this binary embeds Sobek, a pure
// Go JavaScript engine, and runs the SAME bundled model the browser runs.
// Go owns the socket, the clock and the loop; JavaScript owns the CRDT.
// Neither half can drift from the browser, because one of them is it.
//
// Usage:
//
//	DOCS_EMAIL=… DOCS_PASSWORD=… runner -url http://host -doc <id> -script "Name"
package main

import (
	"context"
	crand "crypto/rand"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/grafana/sobek"
)

// Built by `make runner-js` from web/src/runner.js.
//
//go:embed runtime.js
var runtimeJS string

// The browser globals lib0 and yjs reach for. Sobek is a language engine,
// not a browser, so the host supplies them — the same arrangement as the
// iframe sandbox, which also has to be given everything it may use.
const shims = `
globalThis.self = globalThis
globalThis.window = undefined
globalThis.crypto = {
  getRandomValues: function (a) {
    for (var i = 0; i < a.length; i++) a[i] = __randU32()
    return a
  }
}
globalThis.performance = { now: function () { return __nowMillis() } }
globalThis.console = {
  log: function () {}, warn: function () {}, error: function () {},
}
`

func main() {
	base := flag.String("url", "http://127.0.0.1:8484", "server base URL")
	docID := flag.String("doc", "", "document id (required)")
	scriptName := flag.String("script", "", "script to run; default: every script marked run-on-edit")
	list := flag.Bool("list", false, "list the document's scripts and exit")
	timeout := flag.Duration("timeout", 30*time.Second, "overall time limit")
	flag.Parse()

	email, password := os.Getenv("DOCS_EMAIL"), os.Getenv("DOCS_PASSWORD")
	if *docID == "" || email == "" || password == "" {
		fmt.Fprintln(os.Stderr, "usage: DOCS_EMAIL=… DOCS_PASSWORD=… runner -doc <id> [-script Name] [-list]")
		os.Exit(2)
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	if err := run(ctx, *base, *docID, *scriptName, *list); err != nil {
		log.Fatalf("runner: %v", err)
	}
}

func run(ctx context.Context, base, docID, scriptName string, listOnly bool) error {
	client, err := login(ctx, base, os.Getenv("DOCS_EMAIL"), os.Getenv("DOCS_PASSWORD"))
	if err != nil {
		return err
	}

	vm, err := newVM()
	if err != nil {
		return err
	}

	wsURL := strings.Replace(base, "http", "ws", 1) + "/ws/" + docID + "?v=2"
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPClient: client,
		// The server's own limit; a replay of a large document arrives as
		// one message and must not be truncated.
		HTTPHeader: http.Header{},
	})
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	conn.SetReadLimit(16 << 20)
	defer conn.CloseNow()

	// Read until the server says it has sent everything it has. Its replay
	// arrives as doc messages; "synced" is a text frame.
	if err := readUntilSynced(ctx, conn, vm); err != nil {
		return err
	}

	if listOnly {
		out, err := callJS(vm, "docsScripts")
		if err != nil {
			return err
		}
		fmt.Println(out)
		return nil
	}

	scripts, err := pickScripts(vm, scriptName)
	if err != nil {
		return err
	}
	if len(scripts) == 0 {
		return errors.New("no matching script (try -list)")
	}

	for _, s := range scripts {
		res, err := runScript(vm, s.Code, "")
		if err != nil {
			return err
		}
		for _, line := range res.Logs {
			fmt.Printf("[%s] %s\n", s.Name, line)
		}
		if res.Error != "" {
			return fmt.Errorf("script %q: %s", s.Name, res.Error)
		}
		fmt.Printf("[%s] ok\n", s.Name)
	}

	// Hand anything the scripts wrote to the server, then wait for it to be
	// flushed. The server batches roughly once a second, so a runner that
	// exits immediately can lose the write it just made.
	if err := sendPending(ctx, conn, vm); err != nil {
		return err
	}
	time.Sleep(1500 * time.Millisecond)
	if err := sendPending(ctx, conn, vm); err != nil {
		return err
	}
	return conn.Close(websocket.StatusNormalClosure, "")
}

func login(ctx context.Context, base, email, password string) (*http.Client, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Jar: jar, Timeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	req, err := http.NewRequestWithContext(ctx, "POST", base+"/api/login", strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("login: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("login: %s: %s", res.Status, strings.TrimSpace(string(msg)))
	}
	return client, nil
}

func newVM() (*sobek.Runtime, error) {
	vm := sobek.New()
	if err := vm.Set("__randU32", func() uint32 {
		var b [4]byte
		if _, err := crand.Read(b[:]); err != nil {
			panic(err)
		}
		return binary.LittleEndian.Uint32(b[:])
	}); err != nil {
		return nil, err
	}
	start := time.Now()
	if err := vm.Set("__nowMillis", func() float64 {
		return float64(time.Since(start).Microseconds()) / 1000
	}); err != nil {
		return nil, err
	}
	if _, err := vm.RunString(shims); err != nil {
		return nil, fmt.Errorf("shims: %w", err)
	}
	if _, err := vm.RunString(intlShim); err != nil {
		return nil, fmt.Errorf("intl shim: %w", err)
	}
	if _, err := vm.RunString(runtimeJS); err != nil {
		return nil, fmt.Errorf("runtime: %w", err)
	}
	if _, err := callJS(vm, "docsInit"); err != nil {
		return nil, err
	}
	return vm, nil
}

func callJS(vm *sobek.Runtime, name string, args ...sobek.Value) (string, error) {
	fn, ok := sobek.AssertFunction(vm.Get(name))
	if !ok {
		return "", fmt.Errorf("runtime is missing %s()", name)
	}
	v, err := fn(sobek.Undefined(), args...)
	if err != nil {
		return "", fmt.Errorf("%s: %w", name, err)
	}
	if v == nil || sobek.IsUndefined(v) || sobek.IsNull(v) {
		return "", nil
	}
	return v.String(), nil
}

// callJSBytes runs a JS function returning an ArrayBuffer (or null).
func callJSBytes(vm *sobek.Runtime, name string, args ...sobek.Value) ([]byte, error) {
	fn, ok := sobek.AssertFunction(vm.Get(name))
	if !ok {
		return nil, fmt.Errorf("runtime is missing %s()", name)
	}
	v, err := fn(sobek.Undefined(), args...)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	if v == nil || sobek.IsUndefined(v) || sobek.IsNull(v) {
		return nil, nil
	}
	buf, ok := v.Export().(sobek.ArrayBuffer)
	if !ok {
		return nil, fmt.Errorf("%s did not return an ArrayBuffer", name)
	}
	return buf.Bytes(), nil
}

type script struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Trigger string `json:"trigger"`
	Code    string `json:"code"`
}

func pickScripts(vm *sobek.Runtime, name string) ([]script, error) {
	raw, err := callJS(vm, "docsScripts")
	if err != nil {
		return nil, err
	}
	var all []script
	if err := json.Unmarshal([]byte(raw), &all); err != nil {
		return nil, fmt.Errorf("script list: %w", err)
	}
	var out []script
	for _, s := range all {
		if name != "" {
			if strings.EqualFold(s.Name, name) || s.ID == name {
				out = append(out, s)
			}
			continue
		}
		if s.Trigger != "" {
			out = append(out, s)
		}
	}
	// Pull the bodies for whatever survived the filter.
	for i, s := range out {
		body, err := callJS(vm, "docsScriptCode", vm.ToValue(s.ID))
		if err != nil {
			return nil, err
		}
		out[i].Code = body
	}
	return out, nil
}

type runResult struct {
	Logs  []string `json:"logs"`
	Error string   `json:"error"`
	Done  bool     `json:"done"`
}

// Two calls, not one: a promise callback is a microtask and cannot run
// until the JavaScript job that queued it returns here. Collecting the
// result inside docsRun always found an unsettled promise.
func runScript(vm *sobek.Runtime, code, eventJSON string) (runResult, error) {
	if _, err := callJS(vm, "docsRun", vm.ToValue(code), vm.ToValue(eventJSON)); err != nil {
		return runResult{}, err
	}
	var res runResult
	// A long chain of awaits may need more than one turn to unwind.
	for range 1000 {
		raw, err := callJS(vm, "docsRunResult")
		if err != nil {
			return runResult{}, err
		}
		if err := json.Unmarshal([]byte(raw), &res); err != nil {
			return runResult{}, fmt.Errorf("run result: %w", err)
		}
		if res.Done {
			return res, nil
		}
	}
	res.Error = "script did not finish: the runner resolves API calls immediately, " +
		"so awaiting anything else (a timer, a fetch) never completes here"
	return res, nil
}

func readUntilSynced(ctx context.Context, conn *websocket.Conn, vm *sobek.Runtime) error {
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		if typ == websocket.MessageText {
			var msg struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(data, &msg); err == nil && msg.Type == "synced" {
				return nil
			}
			continue
		}
		if len(data) == 0 || data[0] != msgDoc {
			continue // awareness; a headless client has no presence to track
		}
		bad, err := callJS(vm, "docsApplyBatch", vm.ToValue(vm.NewArrayBuffer(data[1:])))
		if err != nil {
			return err
		}
		if bad != "" && bad != "0" {
			return fmt.Errorf("%s undecodable frame(s) in this document; refusing to write into it", bad)
		}
	}
}

const msgDoc = 0

func sendPending(ctx context.Context, conn *websocket.Conn, vm *sobek.Runtime) error {
	update, err := callJSBytes(vm, "docsPending")
	if err != nil || update == nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageBinary, append([]byte{msgDoc}, update...))
}
