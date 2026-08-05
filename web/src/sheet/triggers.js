// on-edit triggers: deciding whether a document may run code automatically,
// and describing what changed. Both pure, so the interesting parts are
// tested without a browser.
//
// Why this is safe enough to exist at all, having first said it wasn't:
// the sandbox has no network and no ambient authority, and the script API
// reaches exactly one document. To put a script in a document you must
// already be an editor of it, and an editor can already destroy it
// directly — so an automatic script grants its author no capability they
// lack. What it changes is attribution and timing, not power.
//
// The narrow case that IS a real escalation, and the reason for the gate
// below: a script outlives its author's access. Someone writes a script,
// their sharing is later revoked, and the script keeps running as you. So
// documents you own run their triggers freely, and a document shared with
// you asks once and remembers the answer on this machine.
//
// `onOpen` is deliberately absent. On-edit at least requires you to do
// something; a trigger that fires merely because you looked at a document
// is a materially worse bargain.

const KEY_PREFIX = 'docs.triggers.'

// storage is the Storage interface (localStorage in the browser); ask is
// called only when there is no remembered answer, and its result is
// remembered. Kept as parameters so this is testable and so the decision
// is never silently made somewhere else.
export function allowTriggers(storage, docId, role, ask) {
  if (role !== 'owner') {
    const key = KEY_PREFIX + docId
    let remembered = null
    try {
      remembered = storage?.getItem(key) ?? null
    } catch {
      remembered = null // private mode, storage disabled: fall through to asking
    }
    if (remembered === 'allow') return true
    if (remembered === 'deny') return false
    const answer = !!ask()
    try {
      storage?.setItem(key, answer ? 'allow' : 'deny')
    } catch {
      // Not remembering is survivable; running without consent is not.
    }
    return answer
  }
  return true
}

export function forgetTriggerChoice(storage, docId) {
  try {
    storage?.removeItem(KEY_PREFIX + docId)
  } catch {
    // nothing to do
  }
}

// Turn the raw changed cell keys ("rowId.colId") into something a script
// can act on: the bounding range of the edit, in the A1 notation the rest
// of the API speaks. Keys whose row or column has since been deleted are
// skipped rather than guessed at.
export function summariseEdit(model, keys, colName) {
  model._index()
  let r1 = Infinity, c1 = Infinity, r2 = -1, c2 = -1
  let n = 0
  for (const key of keys) {
    const dot = key.indexOf('.')
    if (dot < 0) continue
    const r = model.rowPos.get(key.slice(0, dot))
    const c = model.colPos.get(key.slice(dot + 1))
    if (r === undefined || c === undefined) continue
    n++
    if (r < r1) r1 = r
    if (r > r2) r2 = r
    if (c < c1) c1 = c
    if (c > c2) c2 = c
  }
  if (!n) return null
  const a1 = (r, c) => colName(c) + (r + 1)
  return {
    range: r1 === r2 && c1 === c2 ? a1(r1, c1) : `${a1(r1, c1)}:${a1(r2, c2)}`,
    cells: n,
  }
}
