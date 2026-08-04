// Tests for the sheet formula engine and the Yjs-backed model, including
// the CRDT cases the whole design exists for (concurrent structural edits).
// Run from web/: node scripts/sheet_test.mjs
import * as Y from 'yjs'
import { parseFormula, serialize, evaluate, isErr, fmtNum, colName, parseColName } from '../src/sheet/engine.js'
import { SheetModel } from '../src/sheet/model.js'
import { toTSV, parseTSV, toHTML, readHTMLPayload } from '../src/sheet/clipboard.js'

let failures = 0
function eq(got, want, what) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
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

function newModel() {
  return new SheetModel(new Y.Doc())
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
  const a = new SheetModel(dA), b = new SheetModel(dB)
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
  const m = new SheetModel(d)
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
