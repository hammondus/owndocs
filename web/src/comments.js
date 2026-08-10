// Client side of the comments API. Threads live in SQLite rather than in the
// Yjs document — see DESIGN-DECISIONS.md "Comments" — so this is ordinary HTTP,
// and the socket only ever says "they changed" (provider.js, onComments).
//
// The anchor is a blob the server stores and never parses. Its shape is
// therefore entirely ours: an envelope with a `k` kind, so a sheet anchor and
// a document anchor can travel through the same column.
//
//   { k: 'cell', sheet, row, col, quote }   stable ids, as formulas use
//   { k: 'text', start, end, quote }        encoded Yjs RelativePositions
//
// `quote` is what the anchor pointed at when it was written. It is the
// fallback for an anchor that no longer resolves — the document's own content
// is garbage-collected once deleted, so without this a comment on deleted text
// would have nothing to show at all.
import * as Y from 'yjs'
import { api } from './lib/api.js'

function toBase64(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function fromBase64(b64) {
  const bin = atob(b64)
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))
}

export function encodeAnchor(anchor) {
  return toBase64(JSON.stringify(anchor))
}

// Returns null rather than throwing: an anchor written by a newer client is a
// thread we cannot place, not a reason to fail the whole panel.
export function decodeAnchor(b64) {
  try {
    return JSON.parse(fromBase64(b64))
  } catch {
    return null
  }
}

export const cellAnchor = (sheet, row, col, quote) => ({ k: 'cell', sheet, row, col, quote })

// ---- text anchors ----------------------------------------------------------
// A Yjs RelativePosition survives arbitrary concurrent editing: it names a
// position by the *item* it sits beside, not by an offset. Encoded to bytes it
// travels in the anchor blob, and only a client holding the Y.Doc can turn it
// back into an index — which is why the server can store these and still know
// nothing about the document.

const b64FromBytes = (u8) => {
  let s = ''
  for (const b of u8) s += String.fromCharCode(b)
  return btoa(s)
}
const bytesFromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

// The two ends associate in opposite directions so that typing at either
// boundary lands *outside* the comment rather than silently extending it:
// start sticks to the character after it, end to the character before.
export function textAnchor(ytext, from, to, quote) {
  const rel = (index, assoc) =>
    b64FromBytes(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, index, assoc)))
  return { k: 'text', start: rel(from, 0), end: rel(to, -1), quote }
}

// Returns {from, to} in the document as it is now, or null when the anchor no
// longer resolves — the text it named has been deleted and garbage-collected.
// Null is an ordinary outcome, not an error: it is what the quoted snippet in
// the anchor exists to cover.
export function resolveTextAnchor(anchor, ydoc) {
  if (!anchor || anchor.k !== 'text') return null
  try {
    const at = (b64) =>
      Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(bytesFromB64(b64)),
        ydoc,
      )
    const s = at(anchor.start)
    const e = at(anchor.end)
    if (!s || !e || e.index < s.index) return null
    return { from: s.index, to: e.index }
  } catch {
    return null
  }
}

// anchorKey indexes threads by the cell they sit on, for marker drawing.
export const cellKey = (sheet, row, col) => `${sheet}.${row}.${col}`

export function anchorKey(anchor) {
  return anchor && anchor.k === 'cell' ? cellKey(anchor.sheet, anchor.row, anchor.col) : null
}

// listThreads returns threads with their anchors already decoded, so no caller
// has to remember to do it. `anchor` becomes the object; the raw base64 is not
// kept, since nothing needs to send it back.
export async function listThreads(docId) {
  const raw = await api(`/api/docs/${docId}/comments`)
  return raw.map((t) => ({ ...t, anchor: decodeAnchor(t.anchor) }))
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })
const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) })
const del = (path) => api(path, { method: 'DELETE' })

export const openThread = (docId, anchor, body) =>
  post(`/api/docs/${docId}/comments`, { anchor: encodeAnchor(anchor), body })

export const replyTo = (docId, tid, body) => post(`/api/docs/${docId}/comments/${tid}`, { body })

export const setResolved = (docId, tid, resolved) =>
  patch(`/api/docs/${docId}/comments/${tid}`, { resolved })

export const editComment = (docId, tid, cid, body) =>
  patch(`/api/docs/${docId}/comments/${tid}/${cid}`, { body })

export const deleteComment = (docId, tid, cid) => del(`/api/docs/${docId}/comments/${tid}/${cid}`)

export const deleteThread = (docId, tid) => del(`/api/docs/${docId}/comments/${tid}`)
