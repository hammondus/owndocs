// Sync provider: connects a Y.Doc + Awareness to the Go relay.
// Wire protocol v2 (matches ws.go): every binary message starts with a type
// byte — 0 doc, 1 awareness, 2 comments. Client->server doc messages carry one
// raw update; server->client doc messages are length-prefixed batches.
// Type 2 is server->client only and carries no payload: comments are written
// over HTTP, and it only means "refetch them".
import * as Y from 'yjs'
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'

import { iterFrames } from './frames.js'

const MSG_DOC = 0
const MSG_AWARENESS = 1
const MSG_COMMENTS = 2

// Client-side guard just under the server's 16 MiB per-message read limit.
// Sending anything bigger gets the connection closed (1009) — and must
// never be retried blindly, or the reconnect loop becomes self-sustaining.
const MAX_WS_UPDATE = 15 * 1024 * 1024

export class Provider {
  constructor(doc, docId, {
    onStatus = () => {}, onSynced = () => {}, onComments = () => {}, onProblem = () => {}, wsUrl,
  } = {}) {
    this.doc = doc
    this.docId = docId
    this.wsUrl = wsUrl // override for non-browser use (tests); default from location
    this.awareness = new Awareness(doc)
    this.onStatus = onStatus
    this.onSynced = onSynced
    // Fired when the server says a comment changed. Nobody drives a UI from
    // it yet; it completes the transport so the comment views can just listen.
    this.onComments = onComments
    // Something the person at the keyboard has to know about and act on, as
    // opposed to a status the connection reports about itself. Today there is
    // one: a change too large to send. It has to reach the screen rather than
    // the console, because the local document keeps the change while the
    // server never gets it — which looks exactly like a save until a reload.
    this.onProblem = onProblem
    this.stopped = false
    this.backoff = 500
    this.resyncNeeded = false
    this.corrupted = false // saw an undecodable doc frame; blocks compaction

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
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', this._unload)

    this.connect()
  }

  _send(type, payload) {
    // Size before readyState, deliberately. While disconnected an ordinary
    // update is dropped and the reconnect diff carries it — but an oversized
    // one will be just as oversized in that diff, so the person needs telling
    // now rather than on reconnect.
    if (payload.length > MAX_WS_UPDATE) {
      const mb = (n) => (n / (1024 * 1024)).toFixed(1)
      console.error(
        `docs: refusing to send a ${payload.length}-byte update (limit ${MAX_WS_UPDATE}). ` +
        'This edit is too large for one message; it will sync via the next reconnect diff or not at all.'
      )
      this.onProblem(
        `That change is too large to save — ${mb(payload.length)} MB, and the limit is ` +
        `${mb(MAX_WS_UPDATE)} MB per change. It is still on your screen but has NOT reached the server. ` +
        'Undo it and make the change in smaller pieces.'
      )
      return
    }
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const msg = new Uint8Array(1 + payload.length)
    msg[0] = type
    msg.set(payload, 1)
    this.ws.send(msg)
  }

  connect() {
    if (this.stopped) return
    let url = this.wsUrl
    if (!url) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      url = `${proto}://${location.host}/ws/${this.docId}`
    }
    // Protocol version: the server rejects mismatches at upgrade, so a
    // stale tab running an old bundle can never write misframed messages
    // into the log (which is how one corrupt row got stored).
    const ws = new WebSocket(url + '?v=2')
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.onStatus('connecting…')
    // When resyncing, collect the replay frames so we can reconstruct the
    // server's state vector and send only the diff (see synced handler).
    let replayFrames = this.resyncNeeded ? [] : null

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'synced') {
          // A dropped connection may have swallowed local updates the server
          // never received — there's no per-update ack to know which. The
          // replay we just received is exactly what the server has, so diff
          // against it and push only what's missing. (An earlier version
          // sent the full state here; combined with the message size limit
          // that turned one oversized doc into an infinite reconnect loop.)
          if (this.resyncNeeded) {
            this.resyncNeeded = false
            const scratch = new Y.Doc()
            for (const f of replayFrames) Y.applyUpdate(scratch, f)
            const diff = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(scratch))
            scratch.destroy()
            if (diff.length > 2) this._send(MSG_DOC, diff) // 2 bytes = empty update
          }
          replayFrames = null
          this.onStatus('synced')
          this.onSynced(msg)
        }
        return
      }
      const u8 = new Uint8Array(ev.data)
      const body = u8.subarray(1)
      if (u8[0] === MSG_DOC) {
        for (const update of iterFrames(body)) {
          // One undecodable frame must not abort the rest of the replay —
          // and a client that hit one must never upload a snapshot, since
          // its doc may be missing that frame's content (`corrupted` is
          // checked before compaction is scheduled).
          try {
            Y.applyUpdate(this.doc, update, this)
          } catch (e) {
            this.corrupted = true
            console.error(`docs: undecodable ${update.length}-byte frame in doc ${this.docId} — skipped; compaction disabled this session. Run tools/inspect on the server db.`, e)
            continue
          }
          if (replayFrames) replayFrames.push(update)
        }
      } else if (u8[0] === MSG_AWARENESS) {
        try {
          applyAwarenessUpdate(this.awareness, body, this)
        } catch (e) {
          console.warn('docs: undecodable awareness update — skipped', e)
        }
      } else if (u8[0] === MSG_COMMENTS) {
        this.onComments()
      }
    }
    ws.onopen = () => {
      this.backoff = 500
      // Re-announce presence after (re)connect.
      if (this.awareness.getLocalState() !== null) {
        this._send(MSG_AWARENESS, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]))
      }
    }
    ws.onclose = (ev) => {
      if (this.stopped) return
      this.resyncNeeded = true
      // Surface the close code: 1009 = a message exceeded the server limit,
      // 1008 = policy violation (write from viewer), 1006 = abnormal.
      // 1009 means the server read limit tripped, so something got past the
      // guard above — a message built somewhere that does not go through
      // `_send`, or a limit that moved. Say so rather than looping quietly.
      if (ev.code === 1009) {
        this.onProblem(
          'The server rejected the last change for being too large. It is still on your screen but ' +
          'has NOT been saved. Undo it and make the change in smaller pieces.'
        )
      }
      this.onStatus(`disconnected (${ev.code || '?'}), retrying…`)
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 10000)
    }
  }

  destroy() {
    this.stopped = true
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this._unload)
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy')
    this.awareness.off('update', this._onAwareness)
    // Awareness starts a repeating timer in its constructor to expire peers
    // that went quiet, and only its own destroy() clears it. Without this call
    // every document opened leaves a live interval behind, and the closure
    // pins the Awareness, which pins the Y.Doc — so a session that visits
    // twenty documents holds twenty of them. This app recreates the provider
    // on every navigation (`#key route.doc.id`), which makes that the normal
    // case rather than an edge one.
    this.awareness.destroy()
    this.doc.off('update', this._onUpdate)
    this.ws?.close()
  }
}
