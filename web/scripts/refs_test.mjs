// Point mode and reference highlighting. Both decide things a click has to get
// right the first time: acceptsRef governs whether a click writes into
// somebody's formula instead of selecting a cell, which is the one way this
// feature can be actively annoying.
// Run from web/: node scripts/refs_test.mjs
import {
  acceptsRef, refText, insertRef, formulaRefs, refColor, REF_COLORS,
  cycleAbsolute, nextPoint, pointRect,
} from '../src/sheet/refs.js'

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

const at = (s) => [s.replace('|', ''), s.indexOf('|')] // "|" marks the caret

// ---- when a click means "insert a reference" -------------------------------

for (const [caretText, want, why] of [
  ['=|', true, 'a bare = is ready for one'],
  ['=SUM(|', true, 'after an opening bracket'],
  ['=SUM(A1,|', true, 'after an argument separator'],
  ['=SUM(A1, |', true, 'and trailing space does not stop it'],
  ['=A1+|', true, 'after an operator'],
  ['=A1:|', true, 'after a range colon'],
  ['=-|', true, 'after a unary minus'],

  // The case that matters most: typing `=A1` then clicking elsewhere means
  // "stop, and select that cell" — not "append a reference".
  ['=A1|', false, 'not straight after a complete reference'],
  ['=SUM(A1:B9)|', false, 'nor after a closing bracket'],
  ['=42|', false, 'nor after a number'],
  ['="text"|', false, 'nor after a string'],
  ['|', false, 'not in an empty cell'],
  ['hello|', false, 'not in a plain value'],
  ['12.5|', false, 'not in a number'],
]) {
  const [text, caret] = at(caretText)
  eq(acceptsRef(text, caret), want, why)
}

// The caret is respected, not just the end of the text: editing the middle of
// a formula points from where the caret actually is.
{
  const [text, caret] = at('=SUM(|)+A9')
  eq(acceptsRef(text, caret), true, 'the caret decides, not the end of the line')
  eq(acceptsRef(text, text.length), false, 'and the end of that same formula does not accept one')
}

// ---- what gets written -----------------------------------------------------

eq(refText({ r1: 0, c1: 0, r2: 0, c2: 0 }), 'A1', 'one cell is a single reference')
eq(refText({ r1: 1, c1: 1, r2: 8, c2: 2 }), 'B2:C9', 'a block is a range')
eq(refText({ r1: 0, c1: 26, r2: 0, c2: 26 }), 'AA1', 'past column Z')

{
  const [text, caret] = at('=SUM(|')
  const r = insertRef(text, caret, { r1: 1, c1: 1, r2: 8, c2: 1 })
  eq(r.text, '=SUM(B2:B9', 'the reference lands at the caret')
  eq(r.caret, r.text.length, 'and the caret follows it')
  eq(r.span, { start: 5, end: 10 }, 'and the span it wrote is reported back')
}

// Dragging fires one of these per mouse-move. Without replacing the previous
// span, a drag across five rows would append five references.
{
  let r = insertRef('=SUM(', 5, { r1: 1, c1: 1, r2: 1, c2: 1 })
  eq(r.text, '=SUM(B2', 'the drag starts with one cell')
  r = insertRef(r.text, r.caret, { r1: 1, c1: 1, r2: 4, c2: 1 }, r.span)
  eq(r.text, '=SUM(B2:B5', 'and grows in place rather than appending')
  r = insertRef(r.text, r.caret, { r1: 1, c1: 1, r2: 8, c2: 1 }, r.span)
  eq(r.text, '=SUM(B2:B9', 'however far it goes')
}

// Mid-formula insertion keeps what was after the caret.
{
  const [text, caret] = at('=SUM(|)*2')
  const r = insertRef(text, caret, { r1: 0, c1: 0, r2: 0, c2: 0 })
  eq(r.text, '=SUM(A1)*2', 'text after the caret survives')
  eq(r.caret, 7, 'and the caret sits after what was inserted')
}

// ---- what a formula refers to ----------------------------------------------

eq(formulaRefs('=A1'), [{ r1: 0, c1: 0, r2: 0, c2: 0 }], 'a single reference')
eq(formulaRefs('=SUM(B2:B9)'), [{ r1: 1, c1: 1, r2: 8, c2: 1 }], 'a range')
eq(formulaRefs('=A1+B2').length, 2, 'several references')
// Legal, and means the same block — so it has to normalise or the outline is
// drawn with negative width.
eq(formulaRefs('=SUM(B9:B2)'), [{ r1: 1, c1: 1, r2: 8, c2: 1 }], 'a reversed range is normalised')

// Not a formula, or not a finished one. This is handed the live edit text on
// every keystroke, so half-typed input must be an empty answer rather than a
// throw.
eq(formulaRefs('hello'), [], 'a plain value refers to nothing')
eq(formulaRefs(''), [], 'nor does an empty cell')
// A half-typed formula still says what it refers to *so far*, which is what
// puts the outline on screen while a range is being dragged. Without it the
// highlight would appear only once the closing bracket is typed — exactly when
// it has stopped being useful.
eq(formulaRefs('=SUM(B2:'), [{ r1: 1, c1: 1, r2: 1, c2: 1 }], 'a half-typed range shows what it has')
eq(formulaRefs('=SUM(A1:A3'), [{ r1: 0, c1: 0, r2: 2, c2: 0 }], 'an unclosed bracket is closed to read it')
eq(formulaRefs('=A1+'), [{ r1: 0, c1: 0, r2: 0, c2: 0 }], 'and a trailing operator is dropped')
eq(formulaRefs('=SUM(A1, B2'), [{ r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 1, c1: 1, r2: 1, c2: 1 }], 'several, mid-typing')
// A `(` inside a string must not be counted as unclosed.
eq(formulaRefs('=CONCAT("a(b", A1)'), [{ r1: 0, c1: 0, r2: 0, c2: 0 }], 'brackets inside strings are not counted')
eq(formulaRefs('=SUM('), [], 'nothing pointed at yet is still nothing')
eq(formulaRefs('=)('), [], 'and nonsense does not throw')
eq(formulaRefs(null), [], 'nor does a missing value')

// A formula may reach into another tab, and an outline drawn on the wrong grid
// is worse than no outline.
eq(formulaRefs("=Sheet2!A1"), [], 'a reference to another sheet is not outlined here')
eq(formulaRefs("=A1+Sheet2!B2"), [{ r1: 0, c1: 0, r2: 0, c2: 0 }], 'but its local neighbour still is')

// ---- F4: absolute forms ----------------------------------------------------

// Excel's order, and worth matching exactly because it is muscle memory.
{
  let t = '=A1', c = 3
  const steps = []
  for (let i = 0; i < 5; i++) {
    const r = cycleAbsolute(t, c)
    t = r.text; c = r.caret
    steps.push(t)
  }
  eq(steps, ['=$A$1', '=A$1', '=$A1', '=A1', '=$A$1'], 'F4 cycles relative, both, row, column, and back')
}

// A range moves as a unit: cycling one end of a range somebody just pointed at
// is never what they meant.
eq(cycleAbsolute('=SUM(A1:A3)', 8).text, '=SUM($A$1:$A$3)', 'a range cycles as one')
eq(cycleAbsolute('=SUM(A1:A3)', 6).text, '=SUM($A$1:$A$3)', 'from either end of it')
eq(cycleAbsolute('=SUM($A$1:$A$3)', 8).text, '=SUM(A$1:A$3)', 'and keeps cycling as one')

// The caret has to count as "on" a reference when it sits at the end of one,
// because that is exactly where it lands after typing or pointing.
eq(cycleAbsolute('=A1', 1).text, '=$A$1', 'at the start of the reference')
eq(cycleAbsolute('=A1', 2).text, '=$A$1', 'inside it')
eq(cycleAbsolute('=A1', 3).text, '=$A$1', 'and at its end')

// Not a reference, so the key falls through to whatever it would otherwise do.
eq(cycleAbsolute('=LOG10(2)', 6), null, 'a function name is not a reference')
eq(cycleAbsolute('=SUM(A1)', 3), null, 'nor is the caret inside SUM')
eq(cycleAbsolute('=1+2', 3), null, 'nor a number')
eq(cycleAbsolute('hello', 3), null, 'nor anything in a plain value')

// Sheet-qualified references cycle their cell and leave the sheet name alone.
eq(cycleAbsolute('=Sheet2!A1', 10).text, '=Sheet2!$A$1', 'a sheet-qualified reference cycles its cell')

// The span comes back so the caller can keep tracking a pointed reference
// across an F4.
eq(cycleAbsolute('=SUM(A1', 7).span, { start: 5, end: 9 }, 'the new span is reported')

// ---- pointing with the keyboard --------------------------------------------

{
  const a = { r: 4, c: 4 }
  eq(nextPoint(a, a, -1, 0, false), { anchor: { r: 3, c: 4 }, head: { r: 3, c: 4 } }, 'a bare arrow walks the reference')
  eq(nextPoint(a, a, 1, 0, true), { anchor: { r: 4, c: 4 }, head: { r: 5, c: 4 } }, 'shift extends from the anchor')
  // A sheet grows down and right on demand, so only the top and left edges
  // are walls.
  eq(nextPoint({ r: 0, c: 0 }, { r: 0, c: 0 }, -1, -1, false).head, { r: 0, c: 0 }, 'it stops at the top left')
  eq(pointRect({ r: 5, c: 1 }, { r: 2, c: 3 }), { r1: 2, c1: 1, r2: 5, c2: 3 }, 'and the rect is normalised either way')
}

// ---- colours ---------------------------------------------------------------

eq(refColor(0), REF_COLORS[0], 'the first reference takes the first colour')
eq(refColor(REF_COLORS.length), REF_COLORS[0], 'and they cycle')

if (failures > 0) {
  console.error(`\n${failures} FAILURES`)
  process.exit(1)
}
console.log('\nALL PASS')
