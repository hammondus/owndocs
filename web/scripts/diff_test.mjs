// Tests for the restore patcher. Run from web/: node scripts/diff_test.mjs
//
// The round-trip property carries most of the weight: for any pair of texts,
// applying the splices must produce exactly the target. Hand-picked cases
// cannot cover the trailing-newline reasoning, so it is checked against a few
// thousand random pairs instead of trusted.
import * as Y from 'yjs'
import { splices, apply } from '../src/diff.js'

let failures = 0
const ok = (what) => console.log('ok:', what)
const fail = (what, detail) => {
  failures++
  console.error(`FAIL: ${what}${detail ? '\n  ' + detail : ''}`)
}
const eq = (got, want, what) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(what)
    : fail(what, `got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`)

// ---- round trip ------------------------------------------------------------

function roundTrip(from, to, what) {
  const ops = splices(from, to)
  const got = apply(from, ops)
  got === to ? ok(what) : fail(what, `got  ${JSON.stringify(got)}\n  want ${JSON.stringify(to)}`)
  return ops
}

roundTrip('', '', 'empty to empty')
roundTrip('', 'hello', 'empty to text')
roundTrip('hello', '', 'text to empty')
roundTrip('same', 'same', 'identical')
roundTrip('a\nb\nc', 'a\nB\nc', 'change a middle line')
roundTrip('a\nb\nc', 'a\nc', 'delete a middle line')
roundTrip('a\nc', 'a\nb\nc', 'insert a middle line')
roundTrip('a\nb\nc', 'a\nb', 'delete the last line')
roundTrip('a\nb', 'a\nb\nc', 'append a line')
roundTrip('a\nb\nc', 'b\nc', 'delete the first line')
roundTrip('one\n\ntwo\n', 'one\n\nTWO\n', 'blank lines and trailing newline')
roundTrip('x', 'y', 'single line replaced')
roundTrip('a\nb\nc\nd\ne', 'a\nB\nc\nD\ne', 'two scattered changes')

// A seeded generator, so a failure reproduces instead of vanishing.
let seed = 12345
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]

let bad = 0
for (let n = 0; n < 3000; n++) {
  const src = Array.from({ length: Math.floor(rand() * 8) }, () => pick(['a', 'b', 'c', '', 'dd']))
  const dst = src.slice()
  const edits = Math.floor(rand() * 3)
  for (let e = 0; e < edits; e++) {
    const op = pick(['ins', 'del', 'set'])
    const i = Math.floor(rand() * (dst.length + 1))
    if (op === 'ins') dst.splice(i, 0, pick(['x', 'y', '']))
    else if (dst.length) dst.splice(i % dst.length, op === 'del' ? 1 : 1, ...(op === 'set' ? ['z'] : []))
  }
  const from = src.join('\n')
  const to = dst.join('\n')
  if (apply(from, splices(from, to)) !== to) {
    if (bad++ === 0) fail('random round trip', `from ${JSON.stringify(from)} to ${JSON.stringify(to)}`)
  }
}
if (bad === 0) ok('3000 random round trips')

// ---- minimality ------------------------------------------------------------
// The reason this file exists: untouched regions must stay untouched, or every
// anchor in them is orphaned by a restore that did not concern them.

{
  const from = 'keep me\nchange me\nkeep me too'
  const ops = splices(from, 'keep me\nCHANGED\nkeep me too')
  eq(ops.length, 1, 'one contiguous change is one splice')
  eq(ops[0].at > 0, true, 'the untouched head is not rewritten')
  eq(ops[0].at + ops[0].remove < from.length, true, 'the untouched tail is not rewritten')
}

{
  const from = 'a\nb\nc\nd\ne'
  const ops = splices(from, 'a\nB\nc\nD\ne')
  eq(ops.length, 2, 'two scattered changes stay two splices, not one big one')
}

{
  // The pathological case the budget exists for: nothing in common, so it
  // degrades to a single replacement rather than a 4M-cell table.
  const from = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n')
  const to = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n')
  const started = Date.now()
  const ops = splices(from, to)
  eq(apply(from, ops) === to, true, 'over-budget diff still round-trips')
  eq(ops.length, 1, 'over-budget diff falls back to one replacement')
  eq(Date.now() - started < 2000, true, 'over-budget diff returns promptly')
}

// ---- the actual point: anchors survive a restore ---------------------------
// A Yjs RelativePosition is what a comment anchor will be. Under the old
// delete-everything restore, every one of these would be orphaned.

{
  const doc = new Y.Doc()
  const text = doc.getText('text')
  text.insert(0, 'intro paragraph\nthe commented line\ntrailing paragraph')

  const idx = text.toString().indexOf('commented')
  const anchor = Y.createRelativePositionFromTypeIndex(text, idx)

  // Restore a version whose only difference is the last paragraph.
  const target = 'intro paragraph\nthe commented line\nDIFFERENT trailing paragraph'
  doc.transact(() => {
    const ops = splices(text.toString(), target)
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i].remove) text.delete(ops[i].at, ops[i].remove)
      if (ops[i].insert) text.insert(ops[i].at, ops[i].insert)
    }
  })

  eq(text.toString(), target, 'restore produced the target text')
  const resolved = Y.createAbsolutePositionFromRelativePosition(anchor, doc)
  eq(resolved !== null, true, 'the anchor still resolves after a restore')
  eq(resolved && text.toString().slice(resolved.index, resolved.index + 9), 'commented',
     'the anchor still points at the same word')
}

{
  // And the honest half: an anchor INSIDE the restored region is legitimately
  // gone. It must fail to point at its old word rather than silently sliding
  // to unrelated text — which is what the quoted snippet fallback is for.
  const doc = new Y.Doc()
  const text = doc.getText('text')
  text.insert(0, 'stable start\nDOOMED middle line\nstable end')
  const idx = text.toString().indexOf('DOOMED')
  const anchor = Y.createRelativePositionFromTypeIndex(text, idx)

  const target = 'stable start\nreplaced entirely\nstable end'
  doc.transact(() => {
    const ops = splices(text.toString(), target)
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i].remove) text.delete(ops[i].at, ops[i].remove)
      if (ops[i].insert) text.insert(ops[i].at, ops[i].insert)
    }
  })
  const resolved = Y.createAbsolutePositionFromRelativePosition(anchor, doc)
  eq(text.toString().slice(resolved?.index ?? 0, (resolved?.index ?? 0) + 6) !== 'DOOMED', true,
     'an anchor inside the replaced region does not resolve to its old word')
}

if (failures > 0) {
  console.error(`\n${failures} FAILURES`)
  process.exit(1)
}
console.log('\nALL PASS')
