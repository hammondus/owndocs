// Phase 1 demo: prove Yjs sync over the Go relay with a plain textarea.
// The provider here is the permanent client-side sync core; the textarea
// binding is throwaway (CodeMirror replaces it in phase 2).
import * as Y from 'yjs'

// ---- wire protocol helpers (matches ws.go) --------------------------------

// Server->client binary messages are batches: repeated [uvarint len][bytes].
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

// ---- provider -------------------------------------------------------------

// Connects a Y.Doc to /ws/{docId}. Client->server messages are single raw
// updates. Reconnects with backoff; on reconnect the server replays the full
// log, which Yjs applies idempotently.
class Provider {
  constructor(doc, docId, onStatus) {
    this.doc = doc
    this.docId = docId
    this.onStatus = onStatus
    this.stopped = false
    this.backoff = 500
    this.updateHandler = (update, origin) => {
      if (origin !== this && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(update)
      }
    }
    doc.on('update', this.updateHandler)
    this.connect()
  }

  connect() {
    if (this.stopped) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/${this.docId}`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.onStatus('connecting…')
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'synced') this.onStatus('synced')
        return
      }
      for (const update of iterFrames(new Uint8Array(ev.data))) {
        Y.applyUpdate(this.doc, update, this)
      }
    }
    ws.onopen = () => { this.backoff = 500 }
    ws.onclose = () => {
      if (this.stopped) return
      this.onStatus('disconnected, retrying…')
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 10000)
    }
  }

  destroy() {
    this.stopped = true
    this.doc.off('update', this.updateHandler)
    this.ws?.close()
  }
}

// ---- textarea <-> Y.Text binding ------------------------------------------

// Minimal diff-based binding: good enough to demonstrate convergence, not a
// real editor. Computes the common prefix/suffix of old vs new value and
// turns the middle into a delete+insert at the right position.
function bindTextarea(ta, ytext, doc) {
  let prev = ytext.toString()
  ta.value = prev

  const onInput = () => {
    const next = ta.value
    let start = 0
    while (start < prev.length && start < next.length && prev[start] === next[start]) start++
    let endPrev = prev.length, endNext = next.length
    while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) { endPrev--; endNext-- }
    doc.transact(() => {
      if (endPrev > start) ytext.delete(start, endPrev - start)
      if (endNext > start) ytext.insert(start, next.slice(start, endNext))
    }, 'local')
    prev = next
  }
  ta.addEventListener('input', onInput)

  const observer = (_ev, tr) => {
    if (tr.origin === 'local') return
    const pos = ta.selectionStart
    const before = ta.value
    prev = ytext.toString()
    ta.value = prev
    // Crude cursor preservation: keep the offset, nudged by the length delta
    // if the change was before the cursor. Fine for a demo.
    ta.selectionStart = ta.selectionEnd = Math.min(prev.length, Math.max(0, pos + (prev.length - before.length)))
  }
  ytext.observe(observer)

  return () => {
    ta.removeEventListener('input', onInput)
    ytext.unobserve(observer)
  }
}

// ---- tiny app shell -------------------------------------------------------

const $ = (id) => document.getElementById(id)

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

let session = null   // current editor session: {provider, unbind, doc}

function show(view) {
  $('authview').classList.toggle('hidden', view !== 'auth')
  $('listview').classList.toggle('hidden', view !== 'list')
  $('editor').style.display = view === 'editor' ? 'block' : 'none'
}

async function showList(me) {
  closeEditor()
  $('who').textContent = `${me.name} <${me.email}>`
  const docs = await api('/api/docs')
  const ul = $('doclist')
  ul.replaceChildren()
  for (const d of docs) {
    const li = document.createElement('li')
    const a = document.createElement('a')
    a.href = '#'
    a.textContent = d.title
    a.onclick = (e) => { e.preventDefault(); openDoc(d) }
    const del = document.createElement('button')
    del.textContent = 'delete'
    del.onclick = async () => { await api(`/api/docs/${d.id}`, { method: 'DELETE' }); showList(me) }
    li.append(a, document.createTextNode(d.role), del)
    ul.append(li)
  }
  show('list')
}

function openDoc(d) {
  const doc = new Y.Doc()
  const ytext = doc.getText('text')
  const provider = new Provider(doc, d.id, (s) => { $('status').textContent = s })
  const unbind = bindTextarea($('ta'), ytext, doc)
  // Repaint once the initial replay lands.
  ytext.observe(() => { if ($('ta').value !== ytext.toString() && document.activeElement !== $('ta')) $('ta').value = ytext.toString() })
  session = { provider, unbind, doc }
  $('doctitle').textContent = d.title
  show('editor')
}

function closeEditor() {
  if (!session) return
  session.unbind()
  session.provider.destroy()
  session.doc.destroy()
  session = null
}

async function boot() {
  $('loginform').onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    try {
      const me = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(f)) })
      showList(me)
    } catch (err) { $('autherr').textContent = err.message }
  }
  $('signupform').onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    try {
      const me = await api('/api/signup', { method: 'POST', body: JSON.stringify(Object.fromEntries(f)) })
      showList(me)
    } catch (err) { $('autherr').textContent = err.message }
  }
  $('logout').onclick = async (e) => {
    e.preventDefault()
    await api('/api/logout', { method: 'POST' })
    show('auth')
  }
  $('createform').onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: f.get('title') }) })
    e.target.reset()
    showList(await api('/api/me'))
  }
  $('back').onclick = async (e) => {
    e.preventDefault()
    showList(await api('/api/me'))
  }

  try {
    showList(await api('/api/me'))
  } catch {
    show('auth')
  }
}

boot()
