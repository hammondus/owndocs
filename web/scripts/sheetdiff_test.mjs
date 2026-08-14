// Tests for the sheet diff. Run from web/: node scripts/sheetdiff_test.mjs
//
// The load-bearing case is row insertion. Comparing two sheets by A1 position
// is the obvious implementation and it is wrong: insert a row at the top and
// every cell below appears to have changed. Comparing by stable id is the
// whole reason the grid stores cells under ids, and the assertions here are
// what stop that being quietly undone later.
import * as Y from 'yjs'
import { Workbook } from '../src/sheet/model.js'
import { sheetChanges } from '../src/sheetdiff.js'

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

// A workbook with `rows` x `cols` materialized and the given cells filled.
function makeDoc(fill, rows = 6, cols = 4) {
  const doc = new Y.Doc()
  const wb = new Workbook(doc)
  const sheet = wb.sheet()
  sheet.ensureSize(rows - 1, cols - 1)
  for (const [r, c, v] of fill) sheet.setCell(r, c, v)
  return doc
}

// Clone through the wire format, which is how a history preview actually
// arrives — not a structural copy that could hide an id problem.
function clone(doc) {
  const out = new Y.Doc()
  Y.applyUpdate(out, Y.encodeStateAsUpdate(doc))
  return out
}

{
  const a = makeDoc([[0, 0, 'one'], [1, 0, 'two']])
  const b = clone(a)
  const r = sheetChanges(a, b)
  eq(r.cellsChanged, 0, 'an untouched copy reports nothing')
  eq(r.identical, true, 'and says so')
}

{
  const a = makeDoc([[0, 0, 'one'], [1, 0, 'two']])
  const b = clone(a)
  new Workbook(b).sheet().setCell(1, 0, 'TWO')
  const r = sheetChanges(a, b)
  eq(r.cellsChanged, 1, 'one edited cell is one change')
  const cell = r.sheets[0].cells[0]
  eq([cell.at, cell.from, cell.to, cell.kind], ['A2', 'two', 'TWO', 'changed'],
     'reported at its A1 position, with both sides')
}

{
  const a = makeDoc([[0, 0, 'one']])
  const b = clone(a)
  new Workbook(b).sheet().setCell(2, 1, 'new')
  const r = sheetChanges(a, b)
  eq(r.cellsChanged, 1, 'filling an empty cell is one change')
  eq(r.sheets[0].cells[0].kind, 'added', 'and it is an addition')
}

{
  const a = makeDoc([[0, 0, 'one'], [1, 0, 'two']])
  const b = clone(a)
  new Workbook(b).sheet().setCell(1, 0, '')
  const r = sheetChanges(a, b)
  eq(r.cellsChanged, 1, 'clearing a cell is one change')
  eq(r.sheets[0].cells[0].from, 'two', 'and remembers what was there')
}

// ---- the case the whole design exists for -----------------------------------
{
  const a = makeDoc([[0, 0, 'top'], [1, 0, 'middle'], [2, 0, 'bottom']])
  const b = clone(a)
  const sheet = new Workbook(b).sheet()
  sheet.insertRows(0, 1) // a new row above everything
  sheet.setCell(0, 0, 'inserted')

  const r = sheetChanges(a, b)
  // Every original cell moved down one position and none of them changed.
  // By position this would be four changes; by id it is one.
  eq(r.cellsChanged, 1, 'inserting a row changes exactly the cell that was typed into')
  const cell = r.sheets[0].cells[0]
  eq([cell.at, cell.to, cell.kind], ['A1', 'inserted', 'added'],
     'and it is reported where it now sits')
}

{
  // The mirror image: deleting a row must report that row's cells and nothing
  // from the rows that shifted up into its place.
  const a = makeDoc([[0, 0, 'top'], [1, 0, 'middle'], [2, 0, 'bottom']])
  const b = clone(a)
  new Workbook(b).sheet().deleteRows(1, 1)
  const r = sheetChanges(a, b)
  eq(r.cellsChanged, 1, 'deleting a row changes only the cells it held')
  eq(r.sheets[0].cells[0].from, 'middle', 'named by what it contained')
  eq(r.sheets[0].cells[0].kind, 'removed', 'and reported as removed')
}

// ---- formulas ---------------------------------------------------------------
{
  // A formula is stored with ids in it and rendered back to A1. Inserting a row
  // above one changes what it renders as while leaving the formula untouched —
  // so a diff that compared rendered text would invent an edit here.
  const a = makeDoc([[0, 0, '1'], [1, 0, '2'], [3, 0, '=SUM(A1:A2)']])
  const b = clone(a)
  new Workbook(b).sheet().insertRows(0, 1)
  const r = sheetChanges(a, b)
  eq(r.cellsChanged, 0, 'a formula whose references shifted is not an edit')
}

{
  // And a formula that really was retyped is reported, in readable A1 form
  // rather than its stored id form.
  const a = makeDoc([[0, 0, '1'], [1, 0, '2'], [3, 0, '=SUM(A1:A2)']])
  const b = clone(a)
  new Workbook(b).sheet().setCell(3, 0, '=SUM(A1:A2)*2')
  const r = sheetChanges(a, b)
  eq(r.cellsChanged, 1, 'an edited formula is one change')
  const cell = r.sheets[0].cells[0]
  eq(cell.to, '=SUM(A1:A2)*2', 'shown as A1, not as stored ids')
  eq(cell.from, '=SUM(A1:A2)', 'on both sides')
}

// ---- ordering ---------------------------------------------------------------
{
  const a = makeDoc([], 20, 3)
  const b = clone(a)
  const sheet = new Workbook(b).sheet()
  sheet.setCell(11, 0, 'twelve')
  sheet.setCell(8, 0, 'nine')
  sheet.setCell(0, 1, 'b-one')
  const r = sheetChanges(a, b)
  // A9 before A12 before B1: down the column first, and 12 after 9 rather than
  // in string order, which would put A12 first.
  eq(r.sheets[0].cells.map((c) => c.at), ['A9', 'A12', 'B1'],
     'changes are listed in grid order, numerically by row')
}

if (failures > 0) {
  console.error(`\n${failures} FAILURES`)
  process.exit(1)
}
console.log('\nALL PASS')
