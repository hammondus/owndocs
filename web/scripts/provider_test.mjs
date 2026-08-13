// The provider's size guard. Worth its own test because the failure it
// prevents is the quiet kind: an update too large for the server's read limit
// leaves the change on screen and absent from the server, which looks exactly
// like a save until somebody reloads.
//
// It also asserts a leak, by exiting: Awareness starts a repeating timer that
// only its own destroy() clears, so if Provider.destroy() stops calling it this
// file hangs instead of failing. That is how the leak was found.
//
// Run from web/: node scripts/provider_test.mjs
import * as Y from 'yjs'

// A stand-in socket, installed before provider.js is imported so the module
// sees it. Nothing here talks to a server: what is under test is the decision
// to send or refuse, which happens before the socket is touched.
const sent = []
class FakeSocket {
  static OPEN = 1
  constructor() {
    this.readyState = 1
    this.binaryType = ''
  }
  send(msg) { sent.push(msg) }
  close() {}
}
globalThis.WebSocket = FakeSocket

const { Provider } = await import('../src/provider.js')

let failures = 0
const ok = (what) => console.log('ok:', what)
const fail = (what, detail) => {
  failures++
  console.error(`FAIL: ${what}${detail ? '\n  ' + detail : ''}`)
}
const check = (cond, what, detail) => (cond ? ok(what) : fail(what, detail))

function newProvider() {
  sent.length = 0
  const problems = []
  const doc = new Y.Doc()
  const p = new Provider(doc, 'testdoc', {
    wsUrl: 'ws://example.invalid/ws/testdoc',
    onProblem: (m) => problems.push(m),
  })
  return { doc, p, problems }
}

// ---- the ordinary case -----------------------------------------------------

{
  const { doc, p, problems } = newProvider()
  doc.getText('t').insert(0, 'hello')
  check(sent.length === 1, 'an ordinary edit is sent')
  check(problems.length === 0, 'and reports no problem')
  p.destroy()
}

// ---- the guard -------------------------------------------------------------

{
  const { doc, p, problems } = newProvider()
  // One cell holding 16 MiB is the cheapest way to make one oversized update;
  // a 350k-cell paste is the realistic way and produces the same thing.
  doc.getText('t').insert(0, 'x'.repeat(16 * 1024 * 1024))

  check(sent.length === 0, 'an oversized update is not sent')
  check(problems.length === 1, 'and is reported exactly once')

  const msg = problems[0] || ''
  // The message has to say three things, because each one is a decision the
  // reader has to make: how big, that it is unsaved, and what to do.
  check(/16\.0 MB/.test(msg), 'the message says how large the change was', msg)
  check(/NOT reached the server/.test(msg), 'and that it is unsaved', msg)
  check(/[Uu]ndo/.test(msg), 'and what to do about it', msg)
  p.destroy()
}

// While disconnected an ordinary update is dropped and the reconnect diff
// carries it — but an oversized one will be just as oversized in that diff, so
// the report must not wait for a connection that will not help.
{
  const { doc, p, problems } = newProvider()
  p.ws.readyState = 3 // CLOSED
  doc.getText('t').insert(0, 'x'.repeat(16 * 1024 * 1024))
  check(problems.length === 1, 'an oversized update is reported even while disconnected')
  p.destroy()
}

// A close with 1009 means the server's read limit tripped, so something got
// past the guard. That must be said too, not looped over quietly.
{
  const { p, problems } = newProvider()
  p.ws.onclose({ code: 1009 })
  check(problems.length === 1, 'a 1009 close is reported as a problem')
  check(/NOT been saved/.test(problems[0] || ''), 'and says the change is unsaved', problems[0])
  p.stopped = true
  p.destroy()
}

// An ordinary disconnect is not a problem — it is a status, and the provider
// reconnects. Reporting it here would train people to ignore the banner.
{
  const { p, problems } = newProvider()
  p.ws.onclose({ code: 1006 })
  check(problems.length === 0, 'an ordinary disconnect is not reported as unsaved work')
  p.stopped = true
  p.destroy()
}

if (failures > 0) {
  console.error(`\n${failures} FAILURES`)
  process.exit(1)
}
console.log('\nALL PASS')
