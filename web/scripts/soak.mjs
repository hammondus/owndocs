// Soak test: reproduce the reconnect loop. Two real Providers on a doc with
// a verified snapshot + tail, one typing periodically, then idle. Logs every
// websocket close with code/reason.
import * as Y from 'yjs'
import WS from 'ws'
import { Provider } from '../src/provider.js'

const BASE = process.argv[2]
const WS_BASE = BASE.replace(/^http/, 'ws')
let cookie = ''
let wsCount = 0

globalThis.WebSocket = class extends WS {
  constructor(url) {
    super(url, { headers: { cookie } })
    const id = ++wsCount
    const t0 = Date.now()
    this.on('open', () => console.log(`[ws${id}] open`))
    this.on('close', (code, reason) =>
      console.log(`[ws${id}] CLOSE after ${((Date.now() - t0) / 1000).toFixed(1)}s code=${code} reason=${reason.toString() || '(none)'}`))
    this.on('error', (e) => console.log(`[ws${id}] ERROR ${e.message}`))
  }
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, { ...opts, headers: { ...(opts.headers || {}), cookie } })
  const sc = res.headers.get('set-cookie')
  if (sc) cookie = sc.split(';')[0]
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await api('/api/signup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `soak-${Date.now()}@t.io`, name: 'Soak', password: 'password123' }),
})
const d = await (await api('/api/docs', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'soak' }),
})).json()

// Build initial state + verified snapshot, mirroring the user's doc.
const seed = new Y.Doc()
const pSeed = new Provider(seed, d.id, { wsUrl: `${WS_BASE}/ws/${d.id}`, onSynced: (m) => (pSeed.synced = m) })
while (!pSeed.synced) await sleep(50)
seed.getText('text').insert(0, 'seed text. '.repeat(200))
await sleep(1500) // flush
pSeed.destroy()
await sleep(300)

const probe = new Y.Doc()
const pProbe = new Provider(probe, d.id, { wsUrl: `${WS_BASE}/ws/${d.id}`, onSynced: (m) => (pProbe.synced = m) })
while (!pProbe.synced) await sleep(50)
await api(`/api/docs/${d.id}/snapshot?last_seq=${pProbe.synced.last_seq}`, {
  method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
  body: Y.encodeStateAsUpdate(probe),
})
await api(`/api/docs/${d.id}/verify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ last_seq: pProbe.synced.last_seq, ok: true }),
})
pProbe.destroy()
console.log('seeded: verified snapshot at seq', pProbe.synced.last_seq)
await sleep(300)

// The actual soak: two clients, typing burst, then idle past ping interval.
const docA = new Y.Doc(), docB = new Y.Doc()
const mk = (doc, name) => {
  const p = new Provider(doc, d.id, {
    wsUrl: `${WS_BASE}/ws/${d.id}`,
    onStatus: (s) => console.log(`[${name}] status: ${s}`),
    onSynced: (m) => console.log(`[${name}] synced: tail ${m.tail_rows} rows / ${m.tail_bytes} bytes; snap ${m.snapshot_seq} ${m.snapshot_state}`),
  })
  p.awareness.setLocalStateField('user', { name, color: '#123456', colorLight: '#abcdef' })
  return p
}
const pA = mk(docA, 'A')
const pB = mk(docB, 'B')
await sleep(1000)

console.log('--- typing burst ---')
for (let i = 0; i < 50; i++) {
  docA.getText('text').insert(0, `edit${i} `)
  await sleep(200)
}
console.log('--- idle 100s (crosses 30s ping interval x3) ---')
await sleep(100_000)

console.log('--- done; connections that survived: A open=%s B open=%s ---',
  pA.ws.readyState === 1, pB.ws.readyState === 1)
pA.destroy()
pB.destroy()
process.exit(0)
