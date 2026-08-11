// mdtext.js is the part of the markdown toolbar that can be wrong quietly: a
// list that renumbers across a nesting boundary, a Tab that indents two spaces
// where CommonMark needs three, a delimiter row that loses a pipe. None of it
// needs an editor, so none of it is left to the browser tests.
// Run from web/: node scripts/mdtext_test.mjs
import {
  listMarker,
  toggleList,
  indentLines,
  outdentLines,
  rowCells,
  columnAt,
  alignAt,
  nextAlign,
  setAlign,
} from '../src/mdtext.js'

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

// Apply the returned prefix edits, so a test reads as before/after text rather
// than as offsets. This is exactly what editor.js does with them.
const applyEdits = (lines, edits) =>
  lines.map((text, i) => (edits[i] ? edits[i].insert + text.slice(edits[i].to) : text))

const rewrite = (lines, kind) => applyEdits(lines, toggleList(lines, kind))

// ---- listMarker ------------------------------------------------------------

eq(listMarker('plain text'), null, 'a paragraph is not a list item')
eq(listMarker('- a').contentCol, 2, 'a bullet puts its children at column 2')
eq(listMarker('1. a').contentCol, 3, 'a number puts its children at column 3')
eq(listMarker('10. a').contentCol, 4, 'a two-digit number puts them at column 4')
eq(listMarker('- [x] a').task, '[x]', 'a checked task box is read')
eq(listMarker('- [x] a').contentCol, 2, 'the task box is content, not marker')
eq(listMarker('***'), null, 'a horizontal rule is not a bullet')
eq(listMarker('1) a').ordered, true, 'a paren-delimited number is an ordered marker')

// ---- toggleList ------------------------------------------------------------

eq(rewrite(['a', 'b'], 'bullet'), ['- a', '- b'], 'bullets are applied')
eq(rewrite(['- a', '- b'], 'bullet'), ['a', 'b'], 'bullets toggle back off')
eq(rewrite(['a', 'b', 'c'], 'ordered'), ['1. a', '2. b', '3. c'], 'numbers count from one')
eq(rewrite(['- a', '- b'], 'ordered'), ['1. a', '2. b'], 'bullets convert to numbers')
eq(rewrite(['1. a'], 'task'), ['- [ ] a'], 'a number converts to a task')
eq(rewrite(['- [x] a'], 'bullet'), ['- a', ], 'a task converts to a plain bullet')
eq(rewrite(['- [x] a'], 'task'), ['a'], 'a task toggles off, box and all')
eq(rewrite(['- [x] a', '- [ ] b'], 'task'), ['a', 'b'], 'a mixed-state task list still toggles off')
eq(rewrite(['- a', '- [ ] b'], 'task'), ['- [ ] a', '- [ ] b'], 'a partly-task list is completed, not cleared')
eq(rewrite(['- [x] a', '- b'], 'task'), ['- [x] a', '- [ ] b'], 'converting on preserves a ticked box')
eq(rewrite([''], 'bullet'), ['- '], 'an empty line starts a list')
eq(rewrite(['a', '', 'b'], 'ordered'), ['1. a', '', '2. b'], 'a blank line inside a selection is skipped, not numbered')
eq(rewrite(['  a'], 'bullet'), ['  - a'], 'indentation survives')

// The case a straight 1..n counter gets wrong.
eq(
  rewrite(['- a', '  - b', '  - c', '- d'], 'ordered'),
  ['1. a', '  1. b', '  2. c', '2. d'],
  'numbering restarts per nesting level and resumes on the way out',
)

// ---- indent / outdent ------------------------------------------------------

eq(applyEdits(['- b'], indentLines(['- b'], ['- a'])), ['  - b'], 'a bullet nests two spaces under a bullet')
eq(applyEdits(['2. b'], indentLines(['2. b'], ['1. a'])), ['   2. b'], 'a number nests three spaces under a number')
eq(indentLines(['- a'], []), [null], 'the first item of a list has nothing to nest under')
eq(indentLines(['plain'], ['- a']), [null], 'a paragraph is not indented by the list command')
eq(
  applyEdits(['- c'], indentLines(['- c'], ['- a', '  - b'])),
  ['  - c'],
  'indenting never skips a level: `c` joins `b` rather than nesting under it',
)
eq(
  applyEdits(['- b', '  - c'], indentLines(['- b', '  - c'], ['- a'])),
  ['  - b', '    - c'],
  'a multi-line selection shifts by one delta, keeping its own nesting',
)
eq(applyEdits(['  - b'], outdentLines(['  - b'], ['- a'])), ['- b'], 'outdent returns to the parent indent')
eq(outdentLines(['- a'], []), [null], 'a top-level item cannot be outdented')
eq(
  applyEdits(['    - c'], outdentLines(['    - c'], ['- a', '  - b'])),
  ['  - c'],
  'outdent lands on the nearest enclosing indent, not on zero',
)
eq(
  applyEdits(['  - b', '- a'], outdentLines(['  - b', '- a'], ['- z'])),
  ['  - b', '- a'],
  'a selection is not outdented past column 0 by its shallowest line',
)

// ---- table rows ------------------------------------------------------------

eq(rowCells('| a | b |').length, 2, 'outer pipes do not make extra cells')
eq(rowCells('a | b').length, 2, 'a row without outer pipes has the same cells')
eq(rowCells('| a \\| b |').length, 1, 'an escaped pipe is content, not a separator')
eq(columnAt('| a | b | c |', 0), 0, 'the leading pipe belongs to the first column')
eq(columnAt('| a | b | c |', 6), 1, 'an offset inside the second cell reports column 1')
eq(columnAt('| a | b | c |', 99), 2, 'past the end clamps to the last column')

eq(alignAt('| :-- | :-: | --: |', 0), 'left', 'a leading colon is left')
eq(alignAt('| :-- | :-: | --: |', 1), 'center', 'colons both ends are centre')
eq(alignAt('| :-- | :-: | --: |', 2), 'right', 'a trailing colon is right')
eq(alignAt('| --- |', 0), 'left', 'no colon is left')
eq([nextAlign('left'), nextAlign('center'), nextAlign('right')], ['center', 'right', 'left'], 'the cycle is three-state')

const setCell = (row, col, align) => {
  const e = setAlign(row, col, align)
  return row.slice(0, e.from) + e.insert + row.slice(e.to)
}
eq(setCell('| ---- | ---- |', 1, 'center'), '| ---- | :--: |', 'centring keeps the cell width')
eq(setCell('| ---- | ---- |', 0, 'right'), '| ---: | ---- |', 'right-aligning keeps the cell width')
eq(setCell('| :--: | ---- |', 0, 'left'), '| ---- | ---- |', 'left-aligning removes the colons')
eq(setCell('|---|', 0, 'center'), '|:-:|', 'an unpadded delimiter row stays unpadded')
eq(setAlign('| --- |', 5, 'center'), null, 'a column that is not there is not edited')

if (failures > 0) process.exit(1)
console.log('\nALL PASS')
