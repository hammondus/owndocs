// End-to-end check of the sync + compaction flow against a running server,
// using the REAL client Provider (src/provider.js) over the real wire
// protocol. Covers what the Go tests can't: actual CRDT convergence, the
// large-paste path, reconnect resync, and the snapshot/verify cycle with
// genuine Yjs payloads. Run: node scripts/e2e.mjs [base-url]
//
// Not wired into `make test` because it needs a running server; it's a dev
// tool for validating protocol changes.
import * as Y from 'yjs'
import WS from 'ws'
import { Provider } from '../src/provider.js'

const BASE = process.argv[2] || 'http://127.0.0.1:8484'
const WS_BASE = BASE.replace(/^http/, 'ws')

let cookie = ''

// The browser sends the session cookie implicitly; in node we inject it by
// shimming the WebSocket global the Provider constructs.
globalThis.WebSocket = class extends WS {
  constructor(url) {
    super(url, { headers: { cookie } })
  }
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { ...(opts.headers || {}), cookie },
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res
}

function* iterFrames(buf) {
  let i = 0
  while (i < buf.length) {
    let len = 0, shift = 0
    for (;;) {
      const b = buf[i++]
      len |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) break
      shift += 7
    }
    yield buf.subarray(i, i + len)
    i += len
  }
}

function mkProvider(doc, docId) {
  const p = new Provider(doc, docId, {
    wsUrl: `${WS_BASE}/ws/${docId}`,
    onSynced: (msg) => {
      p.lastSynced = msg
      p.syncCount = (p.syncCount || 0) + 1
    },
  })
  return p
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for ' + what)
    await sleep(50)
  }
}

function assert(ok, what) {
  if (!ok) throw new Error('FAIL: ' + what)
  console.log('ok:', what)
}

// ---- scenario -------------------------------------------------------------

const email = `e2e-${Date.now()}@test.local`
await api('/api/signup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, name: 'E2E', password: 'password123' }),
})
const docMeta = await (await api('/api/docs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'e2e' }),
})).json()
const docId = docMeta.id
console.log('doc:', docId)

// Two live clients converge in both directions.
const docA = new Y.Doc(), docB = new Y.Doc()
const pA = mkProvider(docA, docId)
await waitFor(() => pA.syncCount >= 1, 'A initial sync')
const pB = mkProvider(docB, docId)
await waitFor(() => pB.syncCount >= 1, 'B initial sync')

docA.getText('text').insert(0, 'hello from A. ')
await waitFor(() => docB.getText('text').toString().includes('hello from A'), 'A -> B sync')
docB.getText('text').insert(docB.getText('text').length, 'and B was here. ')
await waitFor(() => docA.getText('text').toString().includes('B was here'), 'B -> A sync')
assert(docA.getText('text').toString() === docB.getText('text').toString(), 'A and B converged')

// Large paste: thousands of lines land as ONE update; must survive the trip.
const paste = ('lorem ipsum dolor sit amet, consectetur adipiscing elit\n').repeat(40000) // ~2.2 MB
docA.getText('text').insert(0, paste)
await waitFor(() => docB.getText('text').length >= paste.length, 'large paste A -> B', 15000)
assert(docA.getText('text').toString() === docB.getText('text').toString(), '2MB paste converged')

// Reconnect resync: kill A's socket, edit while disconnected, reconnect.
// The offline edit must reach B via the full-state resync — before this
// existed, updates sent into a dead socket were silently lost.
pA.ws.close()
docA.getText('text').insert(0, 'OFFLINE-EDIT. ')
await waitFor(() => docB.getText('text').toString().includes('OFFLINE-EDIT'), 'offline edit resynced to B', 15000)
assert(true, 'reconnect resync delivers offline edits')

const finalText = docA.getText('text').toString()
await waitFor(() => docB.getText('text').toString() === finalText, 'final convergence')

// Disconnect; the room flushes; a fresh client replays from the log.
pA.destroy()
pB.destroy()
await sleep(1500)

const docC = new Y.Doc()
const pC = mkProvider(docC, docId)
await waitFor(() => pC.syncCount >= 1, 'C sync')
assert(docC.getText('text').toString() === finalText, 'replay from log matches')
const syncedC = pC.lastSynced
assert(syncedC.tail_bytes > 128 * 1024, `tail is over the byte threshold (${syncedC.tail_bytes})`)

// Compaction: upload a real snapshot, verify via the bundle, confirm archive.
const snap = Y.encodeStateAsUpdate(docC)
await api(`/api/docs/${docId}/snapshot?last_seq=${syncedC.last_seq}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: snap,
})
console.log('ok: snapshot uploaded at seq', syncedC.last_seq)

const bundle = new Uint8Array(await (await api(`/api/docs/${docId}/verify-bundle`)).arrayBuffer())
const parts = [...iterFrames(bundle)]
assert(parts.length === 3, 'bundle has 3 parts')
const replayDoc = (part) => {
  const d = new Y.Doc()
  for (const u of iterFrames(part)) Y.applyUpdate(d, u)
  return d
}
assert(replayDoc(parts[0]).getText('text').toString() === finalText, 'bundle A (log) replays correctly')
assert(replayDoc(parts[1]).getText('text').toString() === finalText, 'bundle B (snapshot) replays correctly')

await api(`/api/docs/${docId}/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ last_seq: syncedC.last_seq, ok: true }),
})
console.log('ok: snapshot verified + rows archived')
pC.destroy()

// A fresh client now loads snapshot-first, still sees the right text, and
// new edits keep flowing on top of it.
const docD = new Y.Doc()
const pD = mkProvider(docD, docId)
await waitFor(() => pD.syncCount >= 1, 'D sync')
assert(pD.lastSynced.snapshot_state === 'verified', 'joins report verified snapshot')
assert(docD.getText('text').toString() === finalText, 'post-compaction replay matches')
docD.getText('text').insert(0, 'post-compaction edit. ')
await sleep(1500) // let it flush
pD.destroy()

const docE = new Y.Doc()
const pE = mkProvider(docE, docId)
await waitFor(() => pE.syncCount >= 1, 'E sync')
assert(docE.getText('text').toString().startsWith('post-compaction edit. '), 'edits after compaction persist')
pE.destroy()

console.log('\nALL PASS')
process.exit(0)
