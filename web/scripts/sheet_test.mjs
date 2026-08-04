// Tests for the sheet formula engine and the Yjs-backed model, including
// the CRDT cases the whole design exists for (concurrent structural edits).
// Run from web/: node scripts/sheet_test.mjs
import * as Y from 'yjs'
import { parseFormula, serialize, evaluate, isErr, fmtNum, colName, parseColName } from '../src/sheet/engine.js'
import { SheetModel } from '../src/sheet/model.js'

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
