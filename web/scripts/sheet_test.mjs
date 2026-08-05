// Tests for the sheet formula engine and the Yjs-backed model, including
// the CRDT cases the whole design exists for (concurrent structural edits).
// Run from web/: node scripts/sheet_test.mjs
import * as Y from 'yjs'
import { parseFormula, serialize, evaluate, isErr, fmtNum, colName, parseColName, setClock } from '../src/sheet/engine.js'
import { Workbook, SheetModel, FIRST_SHEET } from '../src/sheet/model.js'
import { toTSV, parseTSV, toHTML, readHTMLPayload } from '../src/sheet/clipboard.js'
import { parseTypedNumber, formatNumber, mergeFormat, resolveFormat } from '../src/sheet/format.js'
import { serialFromParts, partsFromSerial, parseDate, formatDate, setDayFirst } from '../src/sheet/dates.js'
import { niceScale, extractChartData, drawChart, chartDragPatch } from '../src/sheet/chart.js'

let failures = 0

// Key order is not meaningful, so compare with it normalised — otherwise
// {r1,r2,c1,c2} and {r1,c1,r2,c2} read as a failure while being identical.
function stable(v) {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val)
}

function eq(got, want, what) {
  const g = stable(got), w = stable(want)
  if (g === w) console.log('ok:', what)
  else { failures++; console.error(`FAIL: ${what}\n  got  ${g}\n  want ${w}`) }
}

// ---- engine: pure formulas (no refs) --------------------------------------

const noCtx = {
  refValue: () => null,
  rangeValues: () => [],
}
const calc = (src) => {
  const v = evaluate(parseFormula(src), noCtx)
  return isErr(v) ? v.error : v
}

eq(calc('1+2*3'), 7, 'precedence * over +')
eq(calc('-2^2'), 4, 'unary minus binds tighter than ^ (Excel quirk)')
eq(calc('2^3^2'), 64, '^ is left-associative (Excel quirk)')
eq(calc('50%'), 0.5, 'postfix percent')
eq(calc('(1+2)*3'), 9, 'parens')
eq(calc('"a"&"b"&1'), 'ab1', 'concat coerces numbers')
eq(calc('1<2'), true, 'comparison')
eq(calc('"A"="a"'), true, 'string equality is case-insensitive')
eq(calc('1="1"'), false, 'number never equals text')
eq(calc('0.1+0.2'), 0.30000000000000004, 'raw float math')
eq(fmtNum(0.1 + 0.2), '0.3', 'display formatting hides float noise')
eq(calc('1/0'), '#DIV/0!', 'divide by zero')
eq(calc('"x"*2'), '#VALUE!', 'text in arithmetic')
eq(calc('FOO(1)'), '#NAME?', 'unknown function')
eq(calc('IF(TRUE,1,1/0)'), 1, 'IF is lazy: untaken branch not evaluated')
eq(calc('IF(1>2,"y","n")'), 'n', 'IF else branch')
eq(calc('SUM(1,2,"3",TRUE)'), 7, 'SUM coerces direct args')
eq(calc('ROUND(2.5)'), 3, 'ROUND half away from zero')
eq(calc('ROUND(-2.5)'), -3, 'ROUND half away from zero, negative')
eq(calc('ROUND(1.005,2)'), 1.01, 'ROUND to decimals')
eq(calc('MOD(-3,2)'), 1, 'MOD takes divisor sign')
eq(calc('LEFT("hello",2)&RIGHT("hello",2)'), 'helo', 'LEFT/RIGHT')
eq(calc('MID("hello",2,3)'), 'ell', 'MID is 1-based')
eq(calc('TRIM("  a   b  ")'), 'a b', 'TRIM collapses internal runs')
eq(calc('AND(TRUE,1)'), true, 'AND over bools and numbers')
eq(calc('NOT(0)'), true, 'NOT coerces')

// Serializer round-trips without inventing or losing parentheses.
for (const src of ['A1+B1*2', '(A1+B1)*2', '-A1^2', 'SUM(A1:B2,3)', 'IF(A1>1,"y","n")', '$A$1+A2', '1&2&3', '-(1+2)']) {
  eq(serialize(parseFormula(src)), src, `round-trip: ${src}`)
}

// ---- model: single doc ----------------------------------------------------

function newModel(ydoc = new Y.Doc()) {
  return new Workbook(ydoc).sheet(FIRST_SHEET)
}
const val = (m, r, c) => {
  const v = m.getValue(r, c)
  return isErr(v) ? v.error : v
}

{
  const m = newModel()
  eq(m.rowCount(), 0, 'fresh sheet has no materialized rows')
  m.setCell(5, 3, 'x')
  eq([m.rowCount(), m.colCount()], [6, 4], 'setCell materializes up to its position')
  eq(val(m, 5, 3), 'x', 'literal string')
  eq(val(m, 0, 0), null, 'untouched cell is empty')
}

// Regression (2026-08-05, user-reported "first edit into a cell doesn't
// take"): the canvas redraws constantly and each draw refreshes the id
// index, so the index was fresh-but-not-flagged-stale when setCell
// materialized new rows. Yjs defers observers to the end of a transaction,
// so the index rebuild never happened and the write landed under
// "undefined.undefined" — invisible, and the edit appeared to vanish.
{
  const m = newModel()
  m.colWidth(0) // what a redraw does: refreshes the index
  m.setCell(3, 2, 'x')
  eq(val(m, 3, 2), 'x', 'first edit into an unmaterialized cell sticks')
  eq([...m.cells.keys()].some((k) => k.includes('undefined')), false, 'no undefined-keyed orphan written')
}

{
  const m = newModel()
  m.setCell(0, 0, '2')
  m.display(0, 0) // refreshes the index
  m.setCell(1, 0, '=A1*3') // materializes row 1 inside the same transaction
  eq(val(m, 1, 0), 6, 'first formula into a new row resolves and sticks')
}

{
  const m = newModel()
  m.setCell(0, 0, '1')
  m.colWidth(0) // refresh, then widen a column past the materialized area
  m.setColWidth(4, 150)
  eq(m.colWidth(4), 150, 'resizing an unmaterialized column sticks')
  eq([...m.dims.keys()].some((k) => k.includes('undefined')), false, 'no undefined-keyed dimension')
}

{
  const m = newModel()
  m.setCell(0, 0, '42')
  m.setCell(1, 0, "'123")
  m.setCell(2, 0, 'TRUE')
  eq(val(m, 0, 0), 42, 'numeric literal becomes a number')
  eq(val(m, 1, 0), '123', "apostrophe forces text, apostrophe not shown")
  eq(m.display(1, 0).text, '123', 'forced text displays without apostrophe')
  eq(val(m, 2, 0), true, 'TRUE literal becomes boolean')
  eq(m.display(0, 0).align, 'right', 'numbers align right')
}

{
  const m = newModel()
  m.setCell(0, 0, '1')
  m.setCell(1, 0, '2')
  m.setCell(2, 0, '=SUM(A1:A2)*2')
  eq(val(m, 2, 0), 6, 'formula over range')
  eq(m.getInput(2, 0), '=SUM(A1:A2)*2', 'formula displays back as typed')
  const raw = m.getRaw(2, 0)
  eq(raw.includes('@'), true, 'stored form uses id refs, not A1')

  // The design's whole point: inserting a row shifts the DISPLAYED refs
  // without touching the stored formula.
  m.insertRows(0)
  eq(m.getInput(3, 0), '=SUM(A2:A3)*2', 'insert above: displayed refs shift')
  eq(m.getRaw(3, 0), raw, 'stored formula is byte-identical after insert')
  eq(val(m, 3, 0), 6, 'value unchanged after insert')

  // A row inserted BETWEEN range endpoints joins the range.
  m.setCell(2, 0, '10') // new row inside A2:A3... wait, A2 is now row index 1
}

{
  const m = newModel()
  m.setCell(0, 0, '1')
  m.setCell(1, 0, '2')
  m.setCell(2, 0, '=SUM(A1:A2)')
  m.insertRows(1) // between the endpoints
  m.setCell(1, 0, '10')
  eq(m.getInput(3, 0), '=SUM(A1:A3)', 'range endpoints stretch over inserted row')
  eq(val(m, 3, 0), 13, 'inserted row joins the range sum')
}

{
  const m = newModel()
  m.setCell(0, 0, '5')
  m.setCell(1, 0, '=A1+1')
  m.deleteRows(0)
  eq(val(m, 0, 0), '#REF!', 'reference to deleted row evaluates #REF!')
  eq(m.getInput(0, 0), '=#REF!+1', 'and displays #REF!')
}

{
  const m = newModel()
  m.setCell(0, 0, '=B1')
  m.setCell(0, 1, '=A1')
  eq(val(m, 0, 0), '#CYCLE!', 'circular reference detected')
  m.setCell(0, 1, '7')
  eq(val(m, 0, 0), 7, 'cycle heals when broken')
}

{
  const m = newModel()
  m.setCell(0, 0, '=1+')
  eq(val(m, 0, 0), '#ERROR!', 'unparseable formula evaluates #ERROR!')
  eq(m.getInput(0, 0), '=1+', 'and survives verbatim for re-editing')
}

{
  const m = newModel()
  m.setCell(0, 0, 'x')
  m.setCell(1, 1, 'y')
  m.deleteRows(0)
  const keys = [...m.cells.keys()]
  eq(keys.length, 1, 'deleting a row deletes its cells (no orphans)')
  eq(val(m, 0, 1), 'y', 'remaining row shifted up intact')
}

{
  const m = newModel()
  m.setCell(0, 0, 'a')
  m.undo.undo()
  eq(val(m, 0, 0), null, 'undo rewinds local edit')
  m.undo.redo()
  eq(val(m, 0, 0), 'a', 'redo restores it')
}

// ---- model: two docs, concurrent edits ------------------------------------

function syncBoth(d1, d2) {
  Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)))
  Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)))
}

{
  const dA = new Y.Doc(), dB = new Y.Doc()
  const a = newModel(dA), b = newModel(dB)
  a.setCell(0, 0, '1')
  a.setCell(1, 0, '2')
  a.setCell(2, 0, '=SUM(A1:A2)')
  syncBoth(dA, dB)
  eq(val(b, 2, 0), 3, 'formula syncs and evaluates on the other client')

  // Concurrent: A inserts a row at the top while B edits a cell. Both must
  // converge with B's edit in the row it edited, not the shifted position.
  a.insertRows(0)
  b.setCell(0, 0, '100')
  syncBoth(dA, dB)
  eq(val(a, 1, 0), 100, "B's edit lands in the cell B edited (now shifted down)")
  eq(val(a, 3, 0), 102, 'formula sees the concurrent edit')
  eq(val(b, 3, 0), 102, 'both sides agree')

  // Concurrent structural edits: both insert rows; both inserts survive.
  const before = a.rowCount()
  a.insertRows(0)
  b.insertRows(b.rowCount())
  syncBoth(dA, dB)
  eq(a.rowCount(), before + 2, 'concurrent row inserts both kept')
  eq(b.rowCount(), a.rowCount(), 'row order converged')
  eq(a.rows.toArray().join(), b.rows.toArray().join(), 'identical row id order')
}

// ---- clipboard serialization ----------------------------------------------

{
  const grid = [['a', 'b'], ['with\ttab', 'with\nnewline'], ['say "hi"', '']]
  eq(parseTSV(toTSV(grid)), grid, 'TSV round-trips tabs, newlines and quotes')
  eq(parseTSV('1\t2\n3\t4'), [['1', '2'], ['3', '4']], 'plain TSV parses')
  eq(parseTSV('1\t2\n'), [['1', '2']], 'trailing newline adds no phantom row')
  eq(parseTSV('a'), [['a']], 'single field')

  const payload = { inputs: [['=A1+1', "it's"]], origin: { r: 2, c: 3 } }
  const html = toHTML([['2', "it's"]], payload)
  eq(readHTMLPayload(html), payload, 'HTML payload round-trips')
  eq(readHTMLPayload('<table><tr><td>1</td></tr></table>'), null, 'foreign HTML yields no payload')
  eq(readHTMLPayload(''), null, 'empty HTML yields no payload')
  // Chrome wraps pasted HTML in a document with fragment markers.
  eq(readHTMLPayload(`<html><body><!--StartFragment-->${html}<!--EndFragment--></body></html>`),
    payload, 'payload survives the browser wrapping it')
}

// ---- absolute references ---------------------------------------------------

{
  const m = newModel()
  m.setCell(0, 0, '5')
  m.setCell(1, 0, '3')
  m.setCell(2, 2, '=$A$1+A2')
  eq(m.getInput(2, 2), '=$A$1+A2', 'absolute markers round-trip through storage')
  eq(val(m, 2, 2), 8, 'mixed absolute/relative evaluates')
  m.insertRows(0)
  eq(m.getInput(3, 2), '=$A$2+A3', 'absolute refs still track identity on insert')
  eq(val(m, 3, 2), 8, 'and the value is unchanged by the insert')
}

{
  // A dead reference must survive being re-committed, not decay to #ERROR!.
  const m = newModel()
  m.setCell(0, 0, '1')
  m.setCell(1, 0, '=A1+1')
  m.deleteRows(0)
  const shown = m.getInput(0, 0)
  eq(shown, '=#REF!+1', 'dead ref displays')
  m.setCell(0, 0, shown)
  eq(val(m, 0, 0), '#REF!', 're-committing a #REF! formula keeps it a #REF!')
}

// ---- copy / paste ----------------------------------------------------------

{
  const m = newModel()
  m.setCell(0, 0, '1')
  m.setCell(1, 0, '2')
  m.setCell(2, 0, '=SUM(A1:A2)')
  const { inputs, values } = m.readRect(0, 0, 2, 0)
  eq(values, [['1'], ['2'], ['3']], 'copy takes displayed values for other apps')
  eq(inputs, [['1'], ['2'], ['=SUM(A1:A2)']], 'copy takes A1-form inputs for ourselves')

  // Paste one column right: relative refs follow.
  m.writeRect(0, 1, inputs, { origin: { r: 0, c: 0 } })
  eq(m.getInput(2, 1), '=SUM(B1:B2)', 'pasted formula shifts relative refs')
  eq(val(m, 2, 1), 3, 'pasted formula computes from its new column')
}

{
  const m = newModel()
  m.setCell(0, 0, '10')
  m.setCell(1, 0, '=$A$1*2')
  const { inputs } = m.readRect(1, 0, 1, 0)
  m.writeRect(5, 3, inputs, { origin: { r: 1, c: 0 } })
  eq(m.getInput(5, 3), '=$A$1*2', 'absolute refs survive a paste unmoved')
  eq(val(m, 5, 3), 20, 'and still point at the original cell')
}

{
  // A relative ref pushed off the sheet becomes #REF!, as in Excel.
  const m = newModel()
  m.setCell(5, 5, '=A1')
  const { inputs } = m.readRect(5, 5, 5, 5)
  m.writeRect(0, 0, inputs, { origin: { r: 5, c: 5 } })
  eq(val(m, 0, 0), '#REF!', 'reference shifted off the top-left is #REF!')
}

{
  // Pasting a single cell into a larger selection tiles it.
  const m = newModel()
  m.setCell(0, 0, 'x')
  const { inputs } = m.readRect(0, 0, 0, 0)
  m.writeRect(2, 2, inputs, { rows: 2, cols: 3, origin: { r: 0, c: 0 } })
  eq([val(m, 2, 2), val(m, 3, 4), val(m, 2, 4)], ['x', 'x', 'x'], 'paste tiles across a bigger selection')
}

{
  // Foreign data (no origin) pastes as literals, no translation attempted.
  const m = newModel()
  m.writeRect(0, 0, parseTSV('1\t2\nhello\t=A1+1'))
  eq([val(m, 0, 0), val(m, 1, 0)], [1, 'hello'], 'external TSV pastes as literals')
  eq(val(m, 1, 1), 2, 'a formula in external data still parses at its landing spot')
}

{
  // Cut: the source clears, and an overlapping destination is not damaged.
  const m = newModel()
  m.setCell(0, 0, 'a')
  m.setCell(1, 0, 'b')
  const { inputs } = m.readRect(0, 0, 1, 0)
  m.writeRect(1, 0, inputs, { origin: { r: 0, c: 0 }, clear: { r1: 0, c1: 0, r2: 1, c2: 0 } })
  eq([val(m, 0, 0), val(m, 1, 0), val(m, 2, 0)], [null, 'a', 'b'], 'cut clears the source but not the overlap')
}

// ---- fill handle -----------------------------------------------------------

{
  const m = newModel()
  m.setCell(0, 0, '1')
  m.setCell(1, 0, '3')
  m.fill({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 4, c2: 0 })
  eq([val(m, 2, 0), val(m, 3, 0), val(m, 4, 0)], [5, 7, 9], 'two numbers extrapolate the step')
}

{
  const m = newModel()
  m.setCell(0, 0, '7')
  m.fill({ r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 0, c1: 0, r2: 3, c2: 0 })
  eq([val(m, 1, 0), val(m, 3, 0)], [7, 7], 'a single number copies rather than counting')
}

{
  const m = newModel()
  m.setCell(0, 0, 'Mon')
  m.setCell(1, 0, 'Tue')
  m.fill({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 5, c2: 0 })
  eq([val(m, 2, 0), val(m, 3, 0), val(m, 4, 0)], ['Mon', 'Tue', 'Mon'], 'text repeats cyclically')
}

{
  const m = newModel()
  m.setCell(0, 0, '2')
  m.setCell(1, 0, '4')
  m.setCell(0, 1, '=A1*10')
  m.fill({ r1: 0, c1: 1, r2: 0, c2: 1 }, { r1: 0, c1: 1, r2: 1, c2: 1 })
  eq(m.getInput(1, 1), '=A2*10', 'filled formula shifts down')
  eq(val(m, 1, 1), 40, 'and recomputes from its own row')
}

{
  // Filling upward runs the series backwards.
  const m = newModel()
  m.setCell(3, 0, '10')
  m.setCell(4, 0, '20')
  m.fill({ r1: 3, c1: 0, r2: 4, c2: 0 }, { r1: 1, c1: 0, r2: 4, c2: 0 })
  eq([val(m, 2, 0), val(m, 1, 0)], [0, -10], 'fill up extrapolates backwards')
}

{
  // Filling right across columns.
  const m = newModel()
  m.setCell(0, 0, '5')
  m.setCell(0, 1, '10')
  m.fill({ r1: 0, c1: 0, r2: 0, c2: 1 }, { r1: 0, c1: 0, r2: 0, c2: 3 })
  eq([val(m, 0, 2), val(m, 0, 3)], [15, 20], 'fill right extrapolates')
}

{
  // A column of formula results must not be mistaken for a typed series.
  const m = newModel()
  m.setCell(0, 0, '1')
  m.setCell(1, 0, '2')
  m.setCell(0, 1, '=A1')
  m.setCell(1, 1, '=A2')
  m.fill({ r1: 0, c1: 1, r2: 1, c2: 1 }, { r1: 0, c1: 1, r2: 2, c2: 1 })
  eq(m.getInput(2, 1), '=A3', 'formulas fill as formulas, not as an extrapolated series')
}

{
  // Empty source cells clear their targets rather than writing "undefined".
  const m = newModel()
  m.setCell(0, 0, 'keep')
  m.setCell(2, 0, 'gone')
  m.fill({ r1: 1, c1: 0, r2: 1, c2: 0 }, { r1: 1, c1: 0, r2: 2, c2: 0 })
  eq([val(m, 0, 0), val(m, 2, 0)], ['keep', null], 'filling from an empty cell clears targets')
}

{
  // Bulk edits must land as ONE Yjs transaction: one update on the wire and
  // one step for undo. Per-cell transactions would flood the log and make
  // undoing a paste a 40-press exercise.
  const d = new Y.Doc()
  const m = newModel(d)
  let updates = 0
  d.on('update', () => updates++)

  const grid = Array.from({ length: 20 }, (_, i) => [String(i), `=A${i + 1}*2`])
  m.writeRect(0, 0, grid)
  eq(updates, 1, 'a 40-cell paste is a single update')

  updates = 0
  m.fill({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 30, c2: 0 })
  eq(updates, 1, 'a fill is a single update')

  m.undo.undo()
  eq(val(m, 25, 0), null, 'undo reverts the whole fill at once')
  eq(val(m, 19, 1), 38, 'and leaves the earlier paste alone')
  m.undo.undo()
  eq(val(m, 19, 1), null, 'a second undo reverts the whole paste')
}

// ---- workbook: multiple sheets ---------------------------------------------

for (const src of ['Sheet2!A1', "'My Sheet'!A1+1", 'SUM(Data!A1:B2)', 'Sheet2!$A$1', "'it''s'!A1"]) {
  eq(serialize(parseFormula(src)), src, `round-trip: ${src}`)
}

{
  // A document written before tabs existed keeps the bare container names,
  // so it opens as sheet one with no migration and no data movement.
  const d = new Y.Doc()
  const legacy = newModel(d)
  legacy.setCell(0, 0, 'old data')
  eq(d.getArray('rows').length, 1, 'the first sheet IS the legacy top-level container')
  eq(d.getArray('sheets').length, 0, 'and no sheet list is written until a second tab exists')

  const reopened = new Workbook(d) // as a later client would see it
  eq(reopened.list().map((s) => s.name), ['Sheet1'], 'legacy doc shows one implicit tab')
  eq(val(reopened.sheet(FIRST_SHEET), 0, 0), 'old data', 'its data is there untouched')

  reopened.addSheet('Second')
  eq(reopened.list().map((s) => s.name), ['Sheet1', 'Second'], 'adding a tab materializes the first')
  eq(val(reopened.sheet(FIRST_SHEET), 0, 0), 'old data', 'and still does not move the old data')
}

{
  const wb = new Workbook(new Y.Doc())
  const s1 = wb.sheet(FIRST_SHEET)
  const id2 = wb.addSheet('Data')
  const s2 = wb.sheet(id2)
  s2.setCell(0, 0, '10')
  s2.setCell(1, 0, '20')
  s1.setCell(0, 0, '=SUM(Data!A1:A2)')
  eq(val(s1, 0, 0), 30, 'cross-sheet range sums')
  eq(s1.getInput(0, 0), '=SUM(Data!A1:A2)', 'cross-sheet formula round-trips')

  const stored = s1.getRaw(0, 0)
  wb.renameSheet(id2, 'Numbers')
  eq(s1.getInput(0, 0), '=SUM(Numbers!A1:A2)', 'renaming a tab updates what formulas display')
  eq(s1.getRaw(0, 0), stored, 'but does not rewrite a single stored formula')
  eq(val(s1, 0, 0), 30, 'and does not disturb the value')

  s2.insertRows(1)
  s2.setCell(1, 0, '5')
  eq(val(s1, 0, 0), 35, 'a row inserted in the other sheet joins the cross-sheet range')
  eq(s1.getInput(0, 0), '=SUM(Numbers!A1:A3)', 'and the displayed range stretches')

  wb.removeSheet(id2)
  eq(val(s1, 0, 0), '#REF!', 'removing a tab kills references into it')
  eq(s1.getInput(0, 0), '=SUM(#REF!)', 'and shows why')
  wb.undo.undo()
  eq(val(s1, 0, 0), 35, 'undo restores the tab with its data intact')
}

{
  // Referring into a sheet that has no cells yet must materialize it, or
  // the reference would be born dead.
  const wb = new Workbook(new Y.Doc())
  const s1 = wb.sheet(FIRST_SHEET)
  const id = wb.addSheet('Empty')
  s1.setCell(0, 0, '=Empty!C5')
  eq(val(s1, 0, 0), null, 'a reference into an empty sheet is empty, not #REF!')
  wb.sheet(id).setCell(4, 2, '42')
  eq(val(s1, 0, 0), 42, 'and starts working once that cell is filled')
}

{
  const wb = new Workbook(new Y.Doc())
  const s1 = wb.sheet(FIRST_SHEET)
  const id = wb.addSheet('My Data')
  wb.sheet(id).setCell(0, 0, '7')
  s1.setCell(0, 0, "='My Data'!A1")
  eq(val(s1, 0, 0), 7, 'a quoted sheet name resolves')
  eq(s1.getInput(0, 0), "='My Data'!A1", 'and round-trips quoted')
  wb.renameSheet(id, 'A1')
  eq(s1.getInput(0, 0), "='A1'!A1", 'a sheet named like a cell reference gets quoted')
  eq(val(s1, 0, 0), 7, 'and still resolves')

  s1.setCell(1, 0, '=Nope!A1')
  eq(val(s1, 1, 0), '#REF!', 'a reference to a nonexistent tab is #REF!')
}

{
  const wb = new Workbook(new Y.Doc())
  const a = wb.sheet(FIRST_SHEET)
  const b = wb.sheet(wb.addSheet('B'))
  a.setCell(0, 0, '=B!A1')
  b.setCell(0, 0, '=Sheet1!A1')
  eq(val(a, 0, 0), '#CYCLE!', 'a cycle that runs through another sheet is caught')
}

{
  const wb = new Workbook(new Y.Doc())
  const s1 = wb.sheet(FIRST_SHEET)
  const s2 = wb.sheet(wb.addSheet('Two'))
  s1.setCell(0, 0, 'a')
  s2.setCell(0, 0, 'b')
  wb.undo.undo()
  eq(val(s2, 0, 0), null, 'one undo stack: it rewinds the edit on the other sheet')
  eq(val(s1, 0, 0), 'a', 'and leaves the first sheet alone')
}

{
  // Two clients adding a second tab at once each materialize the implicit
  // first one, so the raw array legitimately contains it twice.
  const dA = new Y.Doc(), dB = new Y.Doc()
  const wa = new Workbook(dA), wbb = new Workbook(dB)
  wa.sheet(FIRST_SHEET).setCell(0, 0, 'x')
  syncBoth(dA, dB)
  wa.addSheet('FromA')
  wbb.addSheet('FromB')
  syncBoth(dA, dB)
  eq(wa.list().length, 3, 'concurrent tab adds converge to three tabs, not four')
  eq(wa.list().map((s) => s.id).join(), wbb.list().map((s) => s.id).join(), 'tab order agrees on both')
  eq(val(wa.sheet(FIRST_SHEET), 0, 0), 'x', 'the first sheet keeps its data through all of it')
}

{
  const wb = new Workbook(new Y.Doc())
  eq(wb.removeSheet(FIRST_SHEET), false, 'the last remaining sheet cannot be removed')
}

// ---- formatting ------------------------------------------------------------

{
  // parseTypedNumber: punctuation the user types is a format request.
  eq(parseTypedNumber('1234'), { value: 1234, fmt: null }, 'a plain number implies no format')
  eq(parseTypedNumber('1,234'), { value: 1234, fmt: { n: 'int' } }, 'grouping separators imply a grouped format')
  eq(parseTypedNumber('1,234.5'), { value: 1234.5, fmt: { n: 'dec2' } }, 'grouped with decimals implies 2dp')
  eq(parseTypedNumber('12%'), { value: 0.12, fmt: { n: 'pct' } }, 'percent stores the fraction')
  eq(parseTypedNumber('-12%'), { value: -0.12, fmt: { n: 'pct' } }, 'negative percent')
  eq(parseTypedNumber('$1,234.50'), { value: 1234.5, fmt: { n: 'cur', cur: '$' } }, 'currency stores the number')
  eq(parseTypedNumber('-$5'), { value: -5, fmt: { n: 'cur', cur: '$' } }, 'negative currency')
  eq(parseTypedNumber('€9.99'), { value: 9.99, fmt: { n: 'cur', cur: '€' } }, 'other currency symbols')
  eq(parseTypedNumber('hello'), null, 'text is not a number')
  eq(parseTypedNumber(''), null, 'empty is not a number')
  eq(parseTypedNumber('1,23'), null, 'malformed grouping is text, not a number')
  eq(parseTypedNumber('12%%'), null, 'nonsense is text')

  eq(formatNumber(1234.567, { n: 'int' }), '1,235', 'int format rounds and groups')
  eq(formatNumber(1234.567, { n: 'dec2' }), '1,234.57', 'dec2 rounds to 2dp')
  eq(formatNumber(1234.5, { n: 'plain' }), '1234.5', 'plain does not group')
  eq(formatNumber(0.1234, { n: 'pct' }), '12.34%', 'percent scales by 100')
  eq(formatNumber(1234.5, { n: 'cur', cur: '$' }), '$1,234.50', 'currency pads to 2dp')
  eq(formatNumber(-5, { n: 'cur', cur: '$' }), '-$5.00', 'the sign goes outside the currency symbol')
  eq(formatNumber(5, null), null, 'no format means the caller decides')

  eq(mergeFormat({ b: 1, i: 1 }, { b: null }), { i: 1 }, 'a null patch value removes the key')
  eq(mergeFormat({ b: 1 }, { b: null }), null, 'emptying a record yields null so it can be deleted')
  eq(resolveFormat({ n: 'cur' }, null, { b: 1 }), { n: 'cur', b: 1 }, 'cell format layers over the column')
  eq(resolveFormat({ n: 'cur' }, null, { n: 'pct' }), { n: 'pct' }, 'the cell wins over its column')
}

{
  const m = newModel()
  m.setCell(0, 0, '1234.5')
  eq(m.display(0, 0).text, '1234.5', 'unformatted numbers display as typed')
  m.setFormat({ r1: 0, c1: 0, r2: 0, c2: 0 }, { n: 'cur', cur: '$' })
  eq(m.display(0, 0).text, '$1,234.50', 'currency format applies')
  eq(m.getInput(0, 0), '1234.5', 'but the underlying input is untouched')
  eq(val(m, 0, 0), 1234.5, 'and so is the value, so formulas are unaffected')

  m.setCell(1, 0, '=A1*2')
  eq(val(m, 1, 0), 2469, 'a formula reads the number, not the formatted text')
}

{
  // Typing punctuation sets both the value and the format.
  const m = newModel()
  m.setCell(0, 0, '$1,500')
  eq(val(m, 0, 0), 1500, 'typed currency stores a number')
  eq(m.display(0, 0).text, '$1,500.00', 'and displays as currency')
  m.setCell(0, 1, '15%')
  eq(val(m, 0, 1), 0.15, 'typed percent stores the fraction')
  eq(m.display(0, 1).text, '15%', 'and displays as a percent')
  m.setCell(0, 2, '=B1*2')
  eq(val(m, 0, 2), 0.3, 'percent cells compute as fractions')
}

{
  // Column defaults cover cells that do not exist yet.
  const m = newModel()
  m.setCell(0, 0, '5')
  m.setColFormat(0, 0, { n: 'cur', cur: '$' })
  eq(m.display(0, 0).text, '$5.00', 'a column format reaches existing cells')
  m.setCell(9, 0, '7')
  eq(m.display(9, 0).text, '$7.00', 'and cells created afterwards')
  m.setFormat({ r1: 9, c1: 0, r2: 9, c2: 0 }, { n: 'pct' })
  eq(m.display(9, 0).text, '700%', 'a cell format overrides its column')
  eq(m.display(0, 0).text, '$5.00', 'without disturbing its neighbours')
}

{
  const m = newModel()
  m.setCell(0, 0, 'x')
  m.setFormat({ r1: 0, c1: 0, r2: 0, c2: 0 }, { b: 1, c: '#ff0000' })
  eq(m.formatOf(0, 0), { b: 1, c: '#ff0000' }, 'bold and colour are stored')
  m.setFormat({ r1: 0, c1: 0, r2: 0, c2: 0 }, { b: null })
  eq(m.formatOf(0, 0), { c: '#ff0000' }, 'toggling bold off leaves the colour')
  m.clearFormat({ r1: 0, c1: 0, r2: 0, c2: 0 })
  eq(m.formatOf(0, 0), null, 'clear removes everything')
}

{
  // Alignment overrides the type default in both directions.
  const m = newModel()
  m.setCell(0, 0, '5')
  eq(m.display(0, 0).align, 'right', 'numbers default right')
  m.setFormat({ r1: 0, c1: 0, r2: 0, c2: 0 }, { a: 'l' })
  eq(m.display(0, 0).align, 'left', 'an explicit alignment wins')
}

{
  // Formatting rides along with copy/paste and with fill.
  const m = newModel()
  m.setCell(0, 0, '10')
  m.setFormat({ r1: 0, c1: 0, r2: 0, c2: 0 }, { n: 'cur', cur: '$', b: 1 })
  const { inputs, formats } = m.readRect(0, 0, 0, 0)
  m.writeRect(5, 5, inputs, { origin: { r: 0, c: 0 }, formats })
  eq(m.display(5, 5).text, '$10.00', 'paste carries the format')
  eq(m.formatOf(5, 5).b, 1, 'including bold')

  m.setCell(1, 0, '20')
  m.setFormat({ r1: 1, c1: 0, r2: 1, c2: 0 }, { n: 'cur', cur: '$' })
  m.fill({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 3, c2: 0 })
  eq(val(m, 3, 0), 40, 'the series still extrapolates')
  eq(m.display(3, 0).text, '$40.00', 'and filled cells keep the source formatting')
}

{
  // Deleting a row must not leave its formats behind to be inherited by
  // whatever id later occupies that position.
  const m = newModel()
  m.setCell(0, 0, 'a')
  m.setCell(1, 0, 'b')
  m.setFormat({ r1: 0, c1: 0, r2: 0, c2: 0 }, { b: 1 })
  m.setRowFormat(0, 0, { i: 1 })
  m.deleteRows(0)
  eq([...m.fmt.keys()].length, 0, 'deleting a row removes its cell and row formats')
  eq(m.formatOf(0, 0), null, 'the row that shifted up is unformatted')
}

{
  // Formatting and typing the same cell concurrently must both survive —
  // the reason formats live in their own map.
  const dA = new Y.Doc(), dB = new Y.Doc()
  const a = newModel(dA), b = newModel(dB)
  a.setCell(0, 0, 'hello')
  syncBoth(dA, dB)
  a.setFormat({ r1: 0, c1: 0, r2: 0, c2: 0 }, { b: 1 })
  b.setCell(0, 0, 'goodbye')
  syncBoth(dA, dB)
  eq(val(a, 0, 0), 'goodbye', "the other client's edit lands")
  eq(a.formatOf(0, 0), { b: 1 }, 'and the concurrent formatting is not lost')
  eq(val(b, 0, 0), 'goodbye', 'both sides agree on content')
  eq(b.formatOf(0, 0), { b: 1 }, 'and on format')
}

// ---- dates ------------------------------------------------------------------

// Pin the locale ordering and the clock so these assertions don't depend on
// the machine they run on.
setDayFirst(true) // day/month/year, as in Australia and most of the world
setClock(() => new Date(2026, 7, 5, 14, 30, 0)) // 5 Aug 2026, 14:30 local

const SER_2026_08_05 = serialFromParts(2026, 8, 5)

{
  eq(serialFromParts(2026, 8, 5), 46239, 'modern dates carry the same serial as Excel')
  // The deliberate deviation: Excel believes 1900-02-29 existed, so every
  // date before 1900-03-01 is one higher there (1900-01-01 is Excel's 1).
  // We keep the correct calendar; see dates.js.
  eq(serialFromParts(1900, 1, 1), 2, 'pre-March-1900 differs from Excel by one day, on purpose')
  eq(serialFromParts(1900, 3, 1), 61, 'and from March 1900 onward the two agree')
  const p = partsFromSerial(46239.5)
  eq([p.y, p.mo, p.d, p.hh], [2026, 8, 5, 12], 'the fraction is time of day: .5 is noon')

  // Serials are civil, not instants: no timezone can shift the day.
  eq(partsFromSerial(serialFromParts(2026, 4, 5)).d, 5, 'a date survives a DST boundary')
  eq(partsFromSerial(serialFromParts(2026, 10, 4)).d, 4, 'and the other one')
}

{
  const p = (s) => { const r = parseDate(s); return r && [Math.round(r.serial * 1e6) / 1e6, r.kind] }
  eq(p('2026-08-05'), [SER_2026_08_05, 'isodate'], 'ISO dates parse')
  eq(p('5/8/2026'), [SER_2026_08_05, 'date'], 'day-first locale reads 5/8 as 5 August')
  eq(p('05-08-2026'), [SER_2026_08_05, 'date'], 'dashes with a year parse')
  eq(p('5 Aug 2026'), [SER_2026_08_05, 'date'], 'day month-name year')
  eq(p('August 5, 2026'), [SER_2026_08_05, 'date'], 'month-name day, year')
  eq(p('5/8/26'), [SER_2026_08_05, 'date'], 'a two-digit year under 30 is this century')
  eq(p('2026-08-05 14:30'), [SER_2026_08_05 + 0.604167, 'datetime'], 'date with a time')
  eq(p('2:30 pm'), [0.604167, 'time'], 'a bare time is a fraction of a day')
  eq(p('14:30'), [0.604167, 'time'], '24-hour time')

  eq(parseDate('2026-02-30'), null, 'an impossible date is rejected, not rolled over')
  eq(parseDate('32/1/2026'), null, 'day 32 is rejected')
  eq(parseDate('1-2'), null, 'a dashed pair without a year stays text — it is usually a range')
  eq(parseDate('hello'), null, 'text is not a date')
  eq(parseDate('25:00'), null, 'hour 25 is not a time')

  setDayFirst(false)
  eq(p('5/8/2026'), [serialFromParts(2026, 5, 8), 'date'], 'a month-first locale reads the same text as May 8')
  setDayFirst(true)
}

{
  eq(formatDate(SER_2026_08_05, 'isodate'), '2026-08-05', 'ISO display')
  eq(formatDate(SER_2026_08_05 + 0.604167, 'datetime').includes('2026'), true, 'datetime includes the year')
  // Whatever a date format renders must parse back, or editing destroys it.
  for (const kind of ['date', 'isodate', 'datelong', 'datetime', 'time']) {
    const text = formatDate(SER_2026_08_05 + 0.604167, kind)
    const back = parseDate(text)
    eq(back !== null, true, `${kind} renders to something re-parseable ("${text}")`)
  }
}

{
  // Typed dates become serials with a date format, so arithmetic works.
  const m = newModel()
  m.setCell(0, 0, '2026-08-05')
  eq(val(m, 0, 0), SER_2026_08_05, 'a typed date stores its serial')
  eq(m.display(0, 0).text, '2026-08-05', 'and displays as a date')
  eq(m.getInput(0, 0), '2026-08-05', 'and the formula bar shows the date, not the serial')

  m.setCell(1, 0, '=A1+7')
  eq(m.display(1, 0).text, '2026-08-12', 'adding 7 to a date gives a week later')

  m.setCell(2, 0, '2026-08-20')
  m.setCell(3, 0, '=A3-A1')
  eq(val(m, 3, 0), 15, 'subtracting two dates gives days between')
  eq(m.display(3, 0).text, '15', 'and reads as a number, not a date in 1900')
}

{
  const m = newModel()
  m.setCell(0, 0, '=TODAY()')
  eq(m.display(0, 0).text, '05/08/2026', 'TODAY is auto-formatted as a date')
  m.setCell(1, 0, '=NOW()')
  eq(m.display(1, 0).text.startsWith('05/08/2026'), true, 'NOW carries the time too')
  m.setCell(2, 0, '=TODAY()+1')
  eq(m.display(2, 0).text, '06/08/2026', 'arithmetic on a date function stays a date')
  m.setCell(3, 0, '=A1')
  eq(m.display(3, 0).text, '05/08/2026', 'a bare reference inherits the date format')
}

{
  const m = newModel()
  m.setCell(0, 0, '=DATE(2026,8,5)')
  eq(m.display(0, 0).text, '05/08/2026', 'DATE builds a date')
  m.setCell(1, 0, '=DATE(2026,13,1)')
  eq(m.display(1, 0).text, '01/01/2027', 'DATE rolls over on purpose, unlike typed input')
  m.setCell(2, 0, '=YEAR(A1)&"-"&MONTH(A1)&"-"&DAY(A1)')
  eq(val(m, 2, 0), '2026-8-5', 'YEAR/MONTH/DAY pull components out')
  m.setCell(3, 0, '=WEEKDAY(A1)')
  eq(val(m, 3, 0), 4, 'WEEKDAY: 5 Aug 2026 is a Wednesday (Sunday = 1)')
  m.setCell(4, 0, '=WEEKDAY(A1,2)')
  eq(val(m, 4, 0), 3, 'and Monday = 1 in mode 2')
  m.setCell(5, 0, '=DAYS(DATE(2026,8,20),DATE(2026,8,5))')
  eq(val(m, 5, 0), 15, 'DAYS counts between two dates')
  m.setCell(6, 0, '=EDATE(DATE(2026,1,31),1)')
  eq(m.display(6, 0).text, '28/02/2026', 'EDATE clamps to a shorter month')
  m.setCell(7, 0, '=HOUR(0.75)&":"&MINUTE(0.5)')
  eq(val(m, 7, 0), '18:0', 'HOUR and MINUTE read the fractional part')
}

{
  // Dragging two consecutive dates continues the run — this works only
  // because the SERIAL extrapolates, not the displayed text.
  const m = newModel()
  m.setCell(0, 0, '2026-08-05')
  m.setCell(1, 0, '2026-08-06')
  m.fill({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 4, c2: 0 })
  eq([m.display(2, 0).text, m.display(4, 0).text], ['2026-08-07', '2026-08-09'],
    'a date series fills daily and keeps its format')

  // A weekly step is just a step of 7.
  const w = newModel()
  w.setCell(0, 0, '2026-08-05')
  w.setCell(1, 0, '2026-08-12')
  w.fill({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 3, c2: 0 })
  eq(w.display(3, 0).text, '2026-08-26', 'a weekly date series continues weekly')
}

{
  // Dates survive the clipboard round-trip as dates.
  const m = newModel()
  m.setCell(0, 0, '2026-08-05')
  const { inputs, values, formats } = m.readRect(0, 0, 0, 0)
  eq(values[0][0], '2026-08-05', 'copied text is the date, not the serial')
  m.writeRect(3, 3, inputs, { origin: { r: 0, c: 0 }, formats })
  eq(val(m, 3, 3), SER_2026_08_05, 'pasting reproduces the serial')
  eq(m.display(3, 3).text, '2026-08-05', 'and the date format')
}

{
  // Formatting a plain number as a date, and back.
  const m = newModel()
  m.setCell(0, 0, '46239')
  eq(m.display(0, 0).text, '46239', 'a bare serial reads as a number')
  m.setFormat({ r1: 0, c1: 0, r2: 0, c2: 0 }, { n: 'isodate' })
  eq(m.display(0, 0).text, '2026-08-05', 'formatting it as a date reveals the date')
  m.setFormat({ r1: 0, c1: 0, r2: 0, c2: 0 }, { n: null })
  eq(m.display(0, 0).text, '46239', 'and removing the format shows the number again')
}

// ---- charts -----------------------------------------------------------------

{
  eq(niceScale(0, 10).ticks, [0, 2, 4, 6, 8, 10], 'a round range gets round ticks')
  eq(niceScale(0, 97).max, 100, 'the top is rounded up past the data')
  eq(niceScale(3, 7).ticks.includes(3) || niceScale(3, 7).min <= 3, true, 'the bottom covers the data')
  eq(niceScale(5, 5).min < 5 && niceScale(5, 5).max > 5, true, 'flat data still gets a range')
  eq([niceScale(0, 0).min, niceScale(0, 0).max], [0, 1], 'all-zero data gets a unit range')
  // Ticks are rebuilt from the step rather than accumulated, so the last
  // one lands exactly on the axis top instead of drifting past it.
  eq(niceScale(0, 1).ticks.length, 6, 'a unit range gets six ticks')
  eq(niceScale(0, 1).ticks[5], 1, 'and the last tick is exactly the maximum')
}

{
  // Chart drag (2026-08-05: the user could not move a chart at all — the
  // selected chart's controls filled the only draggable strip, and each
  // one swallows mousedown to stay clickable. The body is now the drag
  // surface, with a threshold so a plain click doesn't nudge it.)
  const orig = { x: 100, y: 50, w: 400, h: 250 }
  eq(chartDragPatch('move', orig, 2, -1, false), null, 'a small wobble is a click, not a drag')
  eq(chartDragPatch('move', orig, 20, 10, false), { x: 120, y: 60 }, 'a real drag moves the chart')
  // Once dragging, small deltas must keep applying or the chart would
  // stick whenever the pointer came back near where it started.
  eq(chartDragPatch('move', orig, 1, 1, true), { x: 101, y: 51 }, 'a drag in progress keeps tracking')
  eq(chartDragPatch('move', orig, -500, -500, true), { x: 0, y: 0 }, 'a chart cannot be dragged off the top-left')
  eq(chartDragPatch('resize', orig, 50, 30, true), { w: 450, h: 280 }, 'resize grows the chart')
  eq(chartDragPatch('resize', orig, -900, -900, true), { w: 160, h: 120 }, 'resize stops at a usable minimum')
}

function chartModel() {
  const m = newModel()
  m.setCell(0, 0, 'Month'); m.setCell(0, 1, 'Sales'); m.setCell(0, 2, 'Costs')
  m.setCell(1, 0, '2026-01-01'); m.setCell(1, 1, '100'); m.setCell(1, 2, '60')
  m.setCell(2, 0, '2026-02-01'); m.setCell(2, 1, '150'); m.setCell(2, 2, '70')
  m.setCell(3, 0, '2026-03-01'); m.setCell(3, 1, '120'); m.setCell(3, 2, '90')
  return m
}

{
  const m = chartModel()
  const data = extractChartData(m, { r1: 0, c1: 0, r2: 3, c2: 2 }, { headers: true })
  eq(data.series.map((s) => s.name), ['Sales', 'Costs'], 'header row names the series')
  eq(data.series[0].values, [100, 150, 120], 'series values come out in order')
  eq(data.categories, ['2026-01-01', '2026-02-01', '2026-03-01'],
    'category labels use the DISPLAYED text, so charted dates read as dates')

  const noHead = extractChartData(m, { r1: 1, c1: 0, r2: 3, c2: 1 }, { headers: false })
  eq(noHead.series[0].values, [100, 150, 120], 'without headers every row is data')
  eq(noHead.series[0].name, 'Series 1', 'and series get generated names')

  const single = extractChartData(m, { r1: 0, c1: 1, r2: 3, c2: 1 }, { headers: true })
  eq(single.series.length, 1, 'a single column is one series')
  eq(single.categories, ['1', '2', '3'], 'with row numbers for categories')
}

{
  // Non-numeric cells become gaps rather than zeros, so a line chart
  // breaks instead of diving to the axis.
  const m = chartModel()
  m.setCell(2, 1, 'n/a')
  const data = extractChartData(m, { r1: 0, c1: 0, r2: 3, c2: 1 }, { headers: true })
  eq(data.series[0].values, [100, null, 120], 'text in a data cell is a gap, not a zero')
}

{
  // A chart's range is stored by id, so structural edits move with it.
  const m = chartModel()
  const chart = m.addChart({ r1: 0, c1: 0, r2: 3, c2: 1 })
  eq(m.chartRect(chart), { r1: 0, c1: 0, r2: 3, c2: 1 }, 'the range resolves to where it was made')

  m.insertRows(0)
  eq(m.chartRect(m.charts()[0]), { r1: 1, c1: 0, r2: 4, c2: 1 },
    'inserting above shifts the whole range down')

  m.insertRows(3)
  m.setCell(3, 0, '2026-02-15'); m.setCell(3, 1, '130')
  const grown = m.chartRect(m.charts()[0])
  eq(grown, { r1: 1, c1: 0, r2: 5, c2: 1 }, 'a row inserted inside the range extends the chart')
  eq(extractChartData(m, grown, m.charts()[0]).series[0].values, [100, 130, 150, 120],
    'and its data appears in the chart')
}

{
  // Deleting an endpoint row re-anchors rather than stranding the chart.
  const m = chartModel()
  m.addChart({ r1: 0, c1: 0, r2: 3, c2: 1 })
  m.deleteRows(3) // the last row of the range
  eq(m.chartRect(m.charts()[0]), { r1: 0, c1: 0, r2: 2, c2: 1 }, 'the range re-anchors to a survivor')

  m.deleteRows(0, 3) // everything the chart pointed at
  eq(m.chartRect(m.charts()[0]), null, 'and a chart whose range is entirely gone reports it')
}

{
  const m = chartModel()
  const chart = m.addChart({ r1: 0, c1: 0, r2: 3, c2: 2 }, { type: 'line', title: 'Q1' })
  eq([chart.type, chart.title, chart.headers], ['line', 'Q1', true], 'chart spec round-trips')
  m.updateChart(chart.id, { type: 'pie', w: 500 })
  eq([m.charts()[0].type, m.charts()[0].w, m.charts()[0].title], ['pie', 500, 'Q1'],
    'a patch changes only what it names')
  m.removeChart(chart.id)
  eq(m.charts().length, 0, 'charts can be deleted')
}

{
  // Charts sync like everything else.
  const dA = new Y.Doc(), dB = new Y.Doc()
  const a = newModel(dA), b = newModel(dB)
  a.setCell(0, 0, 'x'); a.setCell(1, 0, '5'); a.setCell(1, 1, '6')
  a.addChart({ r1: 0, c1: 0, r2: 1, c2: 1 }, { title: 'Shared' })
  syncBoth(dA, dB)
  eq(b.charts().map((c) => c.title), ['Shared'], 'a chart reaches the other client')
  eq(b.chartRect(b.charts()[0]), { r1: 0, c1: 0, r2: 1, c2: 1 }, 'pointing at the same cells')
}

{
  // drawChart needs a real canvas to produce pixels, but a recording stub
  // still catches the failure that matters here: a mistyped or missing
  // context call, which in a browser shows up only as a blank chart.
  function stubCtx() {
    const calls = []
    const rec = (name) => (...args) => { calls.push([name, ...args]) }
    const ctx = { calls, measureText: (t) => ({ width: String(t).length * 6 }) }
    for (const fn of ['clearRect', 'fillRect', 'strokeRect', 'beginPath', 'moveTo',
      'lineTo', 'arc', 'closePath', 'fill', 'stroke', 'fillText', 'save', 'restore',
      'setLineDash', 'clip', 'rect']) ctx[fn] = rec(fn)
    return ctx
  }

  const m = chartModel()
  const rect = { r1: 0, c1: 0, r2: 3, c2: 2 }
  const data = extractChartData(m, rect, { headers: true })
  const tick = (v) => String(v)

  for (const type of ['column', 'line', 'pie']) {
    const ctx = stubCtx()
    drawChart(ctx, 400, 240, { type, title: 'T', headers: true }, data, tick)
    const names = ctx.calls.map((c) => c[0])
    eq(names.includes('fillText'), true, `${type}: draws text`)
    if (type === 'pie') eq(names.includes('arc'), true, 'pie: draws slices')
    if (type === 'line') eq(names.includes('lineTo'), true, 'line: draws segments')
    if (type === 'column') {
      // More than just the background and legend swatches.
      eq(ctx.calls.filter((c) => c[0] === 'fillRect').length > 6, true, 'column: draws bars')
    }
  }

  // Degenerate inputs must not throw — an empty range is a normal state
  // while a user is still selecting data.
  const empty = { categories: [], series: [] }
  for (const type of ['column', 'line', 'pie']) {
    const ctx = stubCtx()
    drawChart(ctx, 300, 200, { type }, empty, tick)
    eq(ctx.calls.some((c) => c[0] === 'fillText' && String(c[1]).includes('No data')), true,
      `${type}: says so when the range is empty`)
  }

  // A chart squeezed smaller than its own axes must bail, not draw garbage.
  const ctx = stubCtx()
  drawChart(ctx, 40, 30, { type: 'column' }, data, tick)
  eq(true, true, 'a tiny chart does not throw')

  // All-null series (a range of text) must not throw either.
  const textOnly = { categories: ['a', 'b'], series: [{ name: 's', values: [null, null] }] }
  for (const type of ['column', 'line', 'pie']) {
    const c2 = stubCtx()
    drawChart(c2, 300, 200, { type }, textOnly, tick)
  }
  eq(true, true, 'a series with no numbers does not throw')
}

// ---- A1 helpers -----------------------------------------------------------

eq(colName(0), 'A', 'colName A')
eq(colName(25), 'Z', 'colName Z')
eq(colName(26), 'AA', 'colName AA')
eq(colName(701), 'ZZ', 'colName ZZ')
eq(parseColName('AA'), 26, 'parseColName AA')

if (failures > 0) {
  console.error(`\n${failures} FAILURES`)
  process.exit(1)
}
console.log('\nALL PASS')
