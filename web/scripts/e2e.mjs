// End-to-end check of the sync + compaction flow against a running server,
// using real Yjs documents over the real wire protocol. Covers everything
// the Go tests can't: actual CRDT convergence and the snapshot/verify cycle
// with genuine Yjs payloads. Run: node scripts/e2e.mjs [base-url]
//
// Not wired into `make test` because it needs a running server; it's a dev
// tool for validating protocol changes.
import * as Y from 'yjs'
import WebSocket from 'ws'

const BASE = process.argv[2] || 'http://127.0.0.1:8484'
const MSG_DOC = 0
const MSG_AWARENESS = 1

let cookie = ''

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

// Minimal node-side provider speaking protocol v2.
function connect(docId, doc) {
  const url = BASE.replace(/^http/, 'ws') + '/ws/' + docId
  const ws = new WebSocket(url, { headers: { cookie } })
  ws.binaryType = 'arraybuffer'
  const synced = new Promise((resolve) => {
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'synced') resolve(msg)
        return
      }
      const u8 = new Uint8Array(data)
      if (u8[0] === MSG_DOC) {
        for (const update of iterFrames(u8.subarray(1))) Y.applyUpdate(doc, update, 'remote')
      }
    })
  })
  const onUpdate = (update, origin) => {
    if (origin === 'remote' || ws.readyState !== WebSocket.OPEN) return
    const msg = new Uint8Array(1 + update.length)
    msg[0] = MSG_DOC
    msg.set(update, 1)
    ws.send(msg)
  }
  doc.on('update', onUpdate)
  const open = new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  return {
    ws,
    open,
    synced,
    close: () => new Promise((resolve) => { ws.on('close', resolve); doc.off('update', onUpdate); ws.close() }),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond, what, timeoutMs = 5000) {
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
const a = connect(docId, docA)
await a.open
await a.synced
const b = connect(docId, docB)
await b.open
await b.synced

docA.getText('text').insert(0, 'hello from A. ')
await waitFor(() => docB.getText('text').toString().includes('hello from A'), 'A -> B sync')
docB.getText('text').insert(docB.getText('text').length, 'and B was here.')
await waitFor(() => docA.getText('text').toString().includes('B was here'), 'B -> A sync')
const finalText = docA.getText('text').toString()
assert(finalText === docB.getText('text').toString(), 'A and B converged')

// Disconnect; the room flushes; a fresh client replays from the log.
await a.close()
await b.close()
await sleep(1200)

const docC = new Y.Doc()
const c = connect(docId, docC)
await c.open
const syncedC = await c.synced
assert(docC.getText('text').toString() === finalText, 'replay from log matches')
assert(syncedC.last_seq >= 1, 'log advanced to seq ' + syncedC.last_seq)

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
const fromLog = replayDoc(parts[0])
const fromSnap = replayDoc(parts[1])
assert(fromLog.getText('text').toString() === finalText, 'bundle A (log) replays correctly')
assert(fromSnap.getText('text').toString() === finalText, 'bundle B (snapshot) replays correctly')

await api(`/api/docs/${docId}/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ last_seq: syncedC.last_seq, ok: true }),
})
console.log('ok: snapshot verified + rows archived')
await c.close()

// A fresh client now loads snapshot-first and still sees the right text,
// and new edits keep flowing on top of it.
const docD = new Y.Doc()
const d = connect(docId, docD)
await d.open
const syncedD = await d.synced
assert(syncedD.snapshot_state === 'verified', 'joins report verified snapshot')
assert(docD.getText('text').toString() === finalText, 'post-compaction replay matches')
docD.getText('text').insert(0, 'post-compaction edit. ')
await sleep(1200) // let it flush
await d.close()

const docE = new Y.Doc()
const e = connect(docId, docE)
await e.open
await e.synced
assert(docE.getText('text').toString().startsWith('post-compaction edit. '), 'edits after compaction persist')
await e.close()

console.log('\nALL PASS')
