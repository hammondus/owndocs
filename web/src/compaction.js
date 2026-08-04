// Client side of the compaction flow (see DESIGN-DECISIONS.md).
// The snapshot is a cache; the log is the source of truth. An editor client
// either uploads a snapshot (tail too long) or verifies a pending one by
// replaying two independent reconstructions and comparing state vectors.
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'

const TAIL_ROWS_LIMIT = 100
const TAIL_BYTES_LIMIT = 128 * 1024

export function scheduleCompaction({ docId, doc, role, synced }) {
  if (role !== 'owner' && role !== 'editor') return
  if (synced.snapshot_state === 'pending') {
    setTimeout(() => verifyPending(docId).catch((e) => console.warn('verify failed:', e)), 2000)
  } else if (synced.tail_rows > TAIL_ROWS_LIMIT || synced.tail_bytes > TAIL_BYTES_LIMIT) {
    setTimeout(() => uploadSnapshot(docId, doc, synced.last_seq).catch((e) => console.warn('snapshot failed:', e)), 3000)
  }
}

async function uploadSnapshot(docId, doc, lastSeq) {
  // Encode and self-check synchronously: decode into a fresh doc and require
  // identical state vectors. Encode and decode are different code paths, so
  // this catches most serialization bugs before the bytes leave the client.
  const snap = Y.encodeStateAsUpdate(doc)
  const sv = Y.encodeStateVector(doc)
  const check = new Y.Doc()
  Y.applyUpdate(check, snap)
  if (!bytesEqual(Y.encodeStateVector(check), sv)) {
    console.warn('snapshot self-check failed; not uploading')
    return
  }
  await fetch(`/api/docs/${docId}/snapshot?last_seq=${lastSeq}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: snap,
  })
}

// Verify-bundle layout: [uvarint len][A][uvarint len][B][uvarint 8][seq be64]
// where A = verified snapshot + full live log, B = pending snapshot + tail.
async function verifyPending(docId) {
  const res = await fetch(`/api/docs/${docId}/verify-bundle`)
  if (!res.ok) return // pending vanished (another client verified it) — fine
  const parts = splitParts(new Uint8Array(await res.arrayBuffer()))
  if (parts.length !== 3) return
  const [a, b, seqBytes] = parts
  const lastSeq = Number(new DataView(seqBytes.buffer, seqBytes.byteOffset, 8).getBigUint64(0))

  let svB
  try {
    svB = decodeSV(Y.encodeStateVector(replay(b)))
  } catch (e) {
    // The pending snapshot doesn't even decode: reject it. The server falls
    // back to serving the log, so nothing is lost.
    console.warn('pending snapshot failed to decode, rejecting:', e)
    await verdict(docId, lastSeq, false)
    return
  }
  let svA
  try {
    svA = decodeSV(Y.encodeStateVector(replay(a)))
  } catch (e) {
    // The log-side replay failing is NOT the snapshot's fault; leave the
    // pending snapshot alone and complain loudly.
    console.error('log replay failed during verify — investigate:', e)
    return
  }
  if (dominates(svB, svA)) {
    await verdict(docId, lastSeq, true)
  } else {
    // B is missing content that the log has. The bundle is read in one
    // transaction and sequence numbers are monotonic, so this cannot be a
    // flush race: the snapshot is genuinely incomplete.
    console.warn('pending snapshot missing log content, rejecting')
    await verdict(docId, lastSeq, false)
  }
}

function verdict(docId, lastSeq, ok) {
  return fetch(`/api/docs/${docId}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ last_seq: lastSeq, ok }),
  })
}

function replay(bundle) {
  const doc = new Y.Doc()
  for (const update of iterFrames(bundle)) Y.applyUpdate(doc, update)
  return doc
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

function splitParts(buf) {
  return [...iterFrames(buf)]
}

// A Yjs state vector is [varUint count] then count × (varUint client,
// varUint clock). Decoded with lib0 (already a yjs dependency).
function decodeSV(sv) {
  const dec = decoding.createDecoder(sv)
  const n = decoding.readVarUint(dec)
  const m = new Map()
  for (let i = 0; i < n; i++) {
    const client = decoding.readVarUint(dec)
    const clock = decoding.readVarUint(dec)
    m.set(client, clock)
  }
  return m
}

// b dominates a: for every client in a, b has seen at least as much.
// (Dominance, not equality: the snapshot legitimately contains the
// uploader's not-yet-flushed edits. Deletions live in delete sets, not
// state vectors — a known gap recorded in the design doc.)
function dominates(b, a) {
  for (const [client, clock] of a) {
    if ((b.get(client) || 0) < clock) return false
  }
  return true
}

function bytesEqual(x, y) {
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}
