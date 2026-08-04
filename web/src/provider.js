// Sync provider: connects a Y.Doc + Awareness to the Go relay.
// Wire protocol v2 (matches ws.go): every binary message starts with a type
// byte — 0 doc, 1 awareness. Client->server doc messages carry one raw
// update; server->client doc messages are length-prefixed batches.
import * as Y from 'yjs'
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'

const MSG_DOC = 0
const MSG_AWARENESS = 1

// Server->client batches: repeated [uvarint len][bytes].
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

export class Provider {
  constructor(doc, docId, { onStatus = () => {}, onSynced = () => {} } = {}) {
    this.doc = doc
    this.docId = docId
    this.awareness = new Awareness(doc)
    this.onStatus = onStatus
    this.onSynced = onSynced
    this.stopped = false
    this.backoff = 500

    this._onUpdate = (update, origin) => {
      if (origin !== this) this._send(MSG_DOC, update)
    }
    doc.on('update', this._onUpdate)

    this._onAwareness = ({ added, updated, removed }, origin) => {
      if (origin === this) return
      const changed = added.concat(updated, removed)
      this._send(MSG_AWARENESS, encodeAwarenessUpdate(this.awareness, changed))
    }
    this.awareness.on('update', this._onAwareness)

    // Tell peers we're gone on tab close; hard crashes fall back to the
    // awareness protocol's 30s timeout (known wart, see design doc).
    this._unload = () => removeAwarenessStates(this.awareness, [doc.clientID], 'unload')
    window.addEventListener('beforeunload', this._unload)

    this.connect()
  }

  _send(type, payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const msg = new Uint8Array(1 + payload.length)
    msg[0] = type
    msg.set(payload, 1)
    this.ws.send(msg)
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
        if (msg.type === 'synced') {
          this.onStatus('synced')
          this.onSynced(msg)
        }
        return
      }
      const u8 = new Uint8Array(ev.data)
      const body = u8.subarray(1)
      if (u8[0] === MSG_DOC) {
        for (const update of iterFrames(body)) Y.applyUpdate(this.doc, update, this)
      } else if (u8[0] === MSG_AWARENESS) {
        applyAwarenessUpdate(this.awareness, body, this)
      }
    }
    ws.onopen = () => {
      this.backoff = 500
      // Re-announce presence after (re)connect.
      if (this.awareness.getLocalState() !== null) {
        this._send(MSG_AWARENESS, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]))
      }
    }
    ws.onclose = () => {
      if (this.stopped) return
      this.onStatus('disconnected, retrying…')
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 10000)
    }
  }

  destroy() {
    this.stopped = true
    window.removeEventListener('beforeunload', this._unload)
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy')
    this.awareness.off('update', this._onAwareness)
    this.doc.off('update', this._onUpdate)
    this.ws?.close()
  }
}
