// The formula reference has one job beyond listing things: not lying. This is
// the test that makes "kept in sync" a fact rather than an intention — it
// fails when a function is added to the engine and not documented, and when
// something is documented that the engine cannot actually call.
// Run from web/: node scripts/functions_test.mjs
import { CALLABLE, FUNCTIONS, parseFormula, evaluate, isErr } from '../src/sheet/engine.js'
import { FUNCTION_DOCS, documented, documentedNames, docsMatchEngine, SYNTAX_NOTES } from '../src/sheet/functions.js'

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

// ---- the sync guarantee ----------------------------------------------------

const { missing, extra } = docsMatchEngine()
eq(missing, [], 'every function the engine can call is documented')
eq(extra, [], 'and nothing is documented that it cannot')

// The registry is only half of what is callable: IF is a special form, handled
// by `call` itself so its branches stay unevaluated. A reference derived from
// FUNCTIONS alone would silently omit it.
if (CALLABLE.includes('IF') && !Object.keys(FUNCTIONS).includes('IF')) {
  ok('special forms are in CALLABLE even though they are not in the registry')
} else {
  fail('special forms are in CALLABLE even though they are not in the registry')
}

// ---- the rows themselves ---------------------------------------------------

const all = documented()
eq(all.length, CALLABLE.length, 'one row per callable name')
eq(new Set(documentedNames()).size, all.length, 'no name is documented twice')

for (const f of all) {
  if (!f.args || !f.args.startsWith('(')) fail(`${f.name} has no signature`)
  if (!f.help || f.help.length < 10) fail(`${f.name} has no useful description`)
  if (!f.eg || !f.eg.startsWith('=')) fail(`${f.name} has no example formula`)
}
ok('every row has a signature, a description and an example')

for (const g of FUNCTION_DOCS) {
  if (!g.group || !g.items.length) fail(`empty group ${JSON.stringify(g.group)}`)
}
ok('every group has a name and something in it')

// ---- the examples actually parse -------------------------------------------
// An example that does not parse is worse than none: it is on screen being
// copied. Evaluation is not asserted — most need cells that do not exist here —
// but a parse failure or #NAME? is a broken row.

// Enough of a context to evaluate: every reference reads as empty, which is
// all this needs — the assertion is about names and parsing, not arithmetic.
const ctx = {
  refValue: () => null,
  rangeValues: () => ({ values: [], cols: 1 }),
}
for (const f of all) {
  let ast
  try {
    ast = parseFormula(f.eg.slice(1))
  } catch (e) {
    fail(`${f.name}: the example does not parse`, `${f.eg} — ${e.message}`)
    continue
  }
  const v = evaluate(ast, ctx)
  if (isErr(v) && v.error === '#NAME?') fail(`${f.name}: the example calls something unknown`, f.eg)
}
ok('every example parses, and names something the engine has')

for (const n of SYNTAX_NOTES) {
  try {
    parseFormula(n.eg.slice(1))
  } catch (e) {
    // `=SUM(` is deliberately half-typed — it is the pointing example.
    if (n.eg !== '=SUM(') fail(`syntax note ${JSON.stringify(n.what)} does not parse`, `${n.eg} — ${e.message}`)
  }
}
ok('the syntax notes parse too')

if (failures > 0) {
  console.error(`\n${failures} FAILURES`)
  process.exit(1)
}
console.log('\nALL PASS')
