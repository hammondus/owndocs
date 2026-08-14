// Tests for the restore patcher. Run from web/: node scripts/diff_test.mjs
//
// The round-trip property carries most of the weight: for any pair of texts,
// applying the splices must produce exactly the target. Hand-picked cases
// cannot cover the trailing-newline reasoning, so it is checked against a few
// thousand random pairs instead of trusted.
import * as Y from 'yjs'
import { splices, apply, hunks } from '../src/diff.js'
import { textAnchor, resolveTextAnchor, encodeAnchor, decodeAnchor } from '../src/comments.js'

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

// ---- text anchors ----------------------------------------------------------
// What the docs comment UI anchors with. These travel through the same opaque
// blob as a sheet anchor, so they must survive the JSON/base64 round trip too.

{
  const doc = new Y.Doc()
  const text = doc.getText('text')
  text.insert(0, 'alpha beta gamma')
  const at = text.toString().indexOf('beta')
  const anchor = textAnchor(text, at, at + 4, 'beta')

  eq(decodeAnchor(encodeAnchor(anchor)), anchor, 'a text anchor round-trips through the blob')
  eq(resolveTextAnchor(anchor, doc), { from: 6, to: 10 }, 'resolves to where it was made')

  text.insert(0, 'PREFIX ')
  const moved = resolveTextAnchor(anchor, doc)
  eq(text.toString().slice(moved.from, moved.to), 'beta', 'still names the same word after an insert before it')

  text.insert(text.length, ' trailing words')
  const after = resolveTextAnchor(anchor, doc)
  eq(text.toString().slice(after.from, after.to), 'beta', 'unaffected by an insert after it')
}

{
  // Typing at either boundary must not silently swallow the new text into the
  // comment: start associates right, end associates left.
  const doc = new Y.Doc()
  const text = doc.getText('text')
  text.insert(0, 'one two three')
  const at = text.toString().indexOf('two')
  const anchor = textAnchor(text, at, at + 3, 'two')
  text.insert(at + 3, 'XX')
  const r = resolveTextAnchor(anchor, doc)
  eq(text.toString().slice(r.from, r.to), 'two', 'text typed at the end boundary stays outside')
}

{
  // Deleting the anchored text: the anchor must not silently point at whatever
  // moved into its place. Failing to resolve, or collapsing to empty, are both
  // honest — the quoted snippet covers the display.
  const doc = new Y.Doc()
  const text = doc.getText('text')
  text.insert(0, 'keep DELETEME keep')
  const at = text.toString().indexOf('DELETEME')
  const anchor = textAnchor(text, at, at + 8, 'DELETEME')
  text.delete(at, 8)
  const r = resolveTextAnchor(anchor, doc)
  eq(r === null || text.toString().slice(r.from, r.to) !== 'DELETEME', true,
     'a deleted anchor does not resolve to its old text')
}

{
  eq(resolveTextAnchor(null, new Y.Doc()), null, 'a missing anchor resolves to null')
  eq(resolveTextAnchor({ k: 'cell' }, new Y.Doc()), null, 'a cell anchor is not a text anchor')
  eq(resolveTextAnchor({ k: 'text', start: 'garbage', end: 'garbage' }, new Y.Doc()), null,
     'an undecodable anchor is null, not a throw')
}


// ---- the reading diff -------------------------------------------------------
//
// Same LCS, different question. These check the properties a *reader* depends
// on, which the splice tests above cannot: that line numbers point at the right
// lines, that unchanged text is collapsed rather than dropped, and that the two
// entry points never disagree about what changed.

{
  const r = hunks('same\ntext', 'same\ntext')
  eq(r.identical, true, 'identical texts produce no hunks')
  eq(r.hunks.length, 0, 'and nothing to render')
}

{
  const from = 'a\nb\nc'
  const to = 'a\nB\nc'
  const r = hunks(from, to)
  eq(r.added, 1, 'a changed line counts as one insertion')
  eq(r.removed, 1, 'and one deletion')
  eq(r.hunks.length, 1, 'adjacent to nothing else, it is one hunk')
  const rows = r.hunks[0].rows
  eq(rows.map((x) => x.op), ['keep', 'del', 'ins', 'keep'], 'the change sits between its context')
  eq(rows.map((x) => x.text), ['a', 'b', 'B', 'c'], 'and carries the text of both sides')
  // The line numbers are the whole reason this is a separate entry point.
  eq(rows.map((x) => x.a), [1, 2, null, 3], 'old line numbers, null where the line is new')
  eq(rows.map((x) => x.b), [1, null, 2, 3], 'new line numbers, null where the line is gone')
}

{
  // Context, and what is left out. A change in a long unchanged document must
  // not render the whole document.
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
  const from = lines.join('\n')
  const edited = [...lines]
  edited[19] = 'CHANGED'
  const r = hunks(from, edited.join('\n'))
  eq(r.hunks.length, 1, 'one edit is one hunk')
  eq(r.hunks[0].rows.length, 8, 'three lines of context either side, plus the del and the ins')
  eq(r.hunks[0].skipped, 16, 'and it says how many unchanged lines it skipped to get there')
}

{
  // Two edits far apart stay separate; two close together merge, because their
  // context windows overlap. No special case does this — it falls out of the
  // grouping — so it is worth asserting it actually happens.
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`)
  const far = [...lines]
  far[5] = 'X'
  far[45] = 'Y'
  eq(hunks(from2(lines), far.join('\n')).hunks.length, 2, 'distant edits are separate hunks')

  const near = [...lines]
  near[20] = 'X'
  near[23] = 'Y'
  eq(hunks(from2(lines), near.join('\n')).hunks.length, 1, 'nearby edits merge into one hunk')
}
function from2(lines) { return lines.join('\n') }

{
  // Pure insertion at the end, and pure deletion at the start: the two cases
  // where the head/tail trim does all the work and the LCS never runs.
  const r1 = hunks('a\nb', 'a\nb\nc')
  eq(r1.added, 1, 'an appended line is one insertion')
  eq(r1.removed, 0, 'and nothing removed')
  const r2 = hunks('a\nb\nc', 'b\nc')
  eq(r2.removed, 1, 'a removed first line is one deletion')
  eq(r2.added, 0, 'and nothing added')
}

{
  // The two entry points must never disagree. splices() says how to turn A into
  // B; hunks() says what changed. If one sees a difference the other does not,
  // the history view and the restore button are describing different things.
  // Reuses the seeded generator above, so a failure here reproduces too.
  const pick = () => Array.from({ length: 1 + Math.floor(rand() * 12) },
    () => 'abcde'[Math.floor(rand() * 5)]).join('\n')
  let agreed = 0
  for (let i = 0; i < 500; i++) {
    const a = pick()
    const b = pick()
    const h = hunks(a, b)
    const s = splices(a, b)
    if (h.identical !== (s.length === 0)) {
      fail('hunks and splices agree on whether anything changed',
           `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`)
      break
    }
    // And the rows must reconstruct both sides exactly.
    const all = h.hunks.flatMap((x) => x.rows)
    if (!h.identical && h.hunks.length === 1 && h.hunks[0].skipped === 0) {
      const backA = all.filter((r) => r.op !== 'ins').map((r) => r.text).join('\n')
      const backB = all.filter((r) => r.op !== 'del').map((r) => r.text).join('\n')
      if (backA !== a || backB !== b) {
        fail('a single full hunk reconstructs both sides',
             `a=${JSON.stringify(a)} got=${JSON.stringify(backA)}`)
        break
      }
    }
    agreed++
  }
  eq(agreed, 500, 'hunks and splices agree across 500 random pairs')
}

if (failures > 0) {
  console.error(`\n${failures} FAILURES`)
  process.exit(1)
}
console.log('\nALL PASS')
