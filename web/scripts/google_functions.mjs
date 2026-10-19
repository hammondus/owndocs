// The Google Sheets function list, as a dated snapshot, and the section of
// site/formulas.html built from it. See DESIGN-DECISIONS.md, *One comparison,
// and how it is kept true*.
//
// Two commands, run from web/:
//
//   node scripts/google_functions.mjs fetch [saved.html]
//     Fetches Google's function table once and writes the category and name
//     of each function to google-sheets-functions.tsv. Given a saved copy of
//     the page, parses that instead and sends no request. Names only: the
//     descriptions are Google's text and stay on Google's page.
//
//   node scripts/google_functions.mjs render
//     Rewrites the section of site/formulas.html between the
//     google-functions markers from the .tsv and the engine's CALLABLE list.
//
// Neither runs in `make test`. site_test.mjs reads the .tsv and checks the
// page against it, so a render that was not rerun after the engine gained a
// function fails the test.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CALLABLE } from '../src/sheet/engine.js'

const SOURCE = 'https://support.google.com/docs/table/25273?hl=en'
const TSV = fileURLToPath(new URL('./google-sheets-functions.tsv', import.meta.url))
const PAGE = fileURLToPath(new URL('../../site/formulas.html', import.meta.url))

// Google's "Operator" functions that are a named form of an operator the
// engine parses. Checked against parseFormula on 2026-10-19. The page lists
// these as present under another spelling, not as missing.
export const OPERATORS = {
  ADD: '+', MINUS: '-', MULTIPLY: '*', DIVIDE: '/', POW: '^',
  UMINUS: '-x', UPLUS: '+x', UNARY_PERCENT: 'x%', CONCAT: '&',
  EQ: '=', NE: '<>', GT: '>', GTE: '>=', LT: '<', LTE: '<=',
}

// Functions that fetch from the network or call a Google service. A script
// here runs with no network on purpose, so these are a difference by design
// rather than a gap, and the page groups them on their own.
const NETWORK = [
  'AI', 'DETECTLANGUAGE', 'GOOGLEFINANCE', 'GOOGLETRANSLATE', 'IMAGE',
  'IMPORTDATA', 'IMPORTFEED', 'IMPORTHTML', 'IMPORTRANGE', 'IMPORTXML',
]

// Each line is "category<TAB>name". A name Google lists under two categories
// appears twice; readers take the first non-Operator one.
export function readSnapshot() {
  const lines = readFileSync(TSV, 'utf8').split('\n')
  const date = lines.find((l) => l.startsWith('# Fetched '))?.slice(10, 20)
  const rows = lines.filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'))
  const category = new Map()
  for (const [cat, name] of rows) {
    if (!category.has(name) || category.get(name) === 'Operator') category.set(name, cat)
  }
  return { date, category }
}

function parse(html) {
  const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
  const rows = [...html.matchAll(/<tr data-category="([^"]*)"><td class="cc">[^<]*<\/td><td class="cc">([^<]*)<\/td>/g)]
  return rows.map(([, cat, name]) => [unescape(cat), unescape(name)])
}

async function fetchCommand(saved) {
  let html
  if (saved) html = readFileSync(saved, 'utf8')
  else {
    const res = await fetch(SOURCE, { headers: { 'User-Agent': 'owndocs-site (https://github.com/hammondus/owndocs)' } })
    if (!res.ok) throw new Error(`${SOURCE}: ${res.status} ${res.statusText}`)
    html = await res.text()
  }
  const rows = parse(html)
  // The table held 516 rows on 2026-10-19. Far fewer means the page's markup
  // changed and the parser missed it, and writing that would empty the list.
  if (rows.length < 400) throw new Error(`parsed ${rows.length} rows; the page format has probably changed`)
  rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  const today = new Date().toISOString().slice(0, 10)
  writeFileSync(TSV, [
    '# The Google Sheets function list: category, a tab, then the name.',
    '# Names only; the descriptions stay on Google\'s page.',
    `# Fetched ${today} from ${SOURCE}`,
    '# by scripts/google_functions.mjs. Refresh with that script, not by hand.',
    ...rows.map((r) => r.join('\t')),
  ].join('\n') + '\n')
  console.log(`wrote ${rows.length} rows to ${TSV}`)
}

function renderCommand() {
  const { date, category } = readSnapshot()
  const have = new Set(CALLABLE)
  const names = [...category.keys()]
  const shared = names.filter((n) => have.has(n)).length
  const missing = names.filter((n) => !have.has(n) && !(n in OPERATORS))
  const network = missing.filter((n) => NETWORK.includes(n)).sort()
  const byCat = new Map()
  for (const n of missing.filter((n) => !NETWORK.includes(n)).sort()) {
    const c = category.get(n)
    if (!byCat.has(c)) byCat.set(c, [])
    byCat.get(c).push(n)
  }
  const cats = [...byCat].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  const codes = (ns, attr) => ns.map((n) => `<code data-${attr}="${n}">${n}</code>`).join('\n    ')
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const section = `
  <h2 id="google-sheets">In Google Sheets, not in Own Docs</h2>
  <p>Google Sheets listed ${names.length} functions on
  <time datetime="${date}">${date}</time>, and Own Docs has ${shared} of them
  by name. Each of the ${shared} does the same job as the Google function of
  that name. Nobody has tested them against Google Sheets, so an edge case can
  differ.</p>
  <p>Google also lists ${Object.keys(OPERATORS).length} operators as
  functions. Own Docs has the operators and not the names:
    ${Object.entries(OPERATORS).map(([n, op]) => `<code data-operator="${n}">${n}</code> is <code>${esc(op)}</code>`).join(',\n    ')}.</p>
  <p>These ${network.length} need the network or a Google service. Own Docs
  sheets have neither, on purpose:
    ${codes(network, 'absent-fn')}</p>
  <p>The other ${missing.length - network.length}, by Google's category:</p>
${cats.map(([c, ns]) => `  <details class="fnset">
    <summary>${c} <span class="count">${ns.length}</span></summary>
    <p>${codes(ns, 'absent-fn')}</p>
  </details>`).join('\n')}
  `
  const page = readFileSync(PAGE, 'utf8')
  const start = '<!-- google-functions:start -->'
  const end = '<!-- google-functions:end -->'
  const i = page.indexOf(start)
  const j = page.indexOf(end)
  if (i < 0 || j < i) throw new Error(`${PAGE} has no ${start} … ${end} markers`)
  writeFileSync(PAGE, page.slice(0, i + start.length) + section + page.slice(j))
  console.log(`rendered ${missing.length} missing functions in ${cats.length} categories into ${PAGE}`)
}

// Commands run only when this file is the script; site_test.mjs imports
// readSnapshot and OPERATORS from it.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'fetch') await fetchCommand(arg)
  else if (cmd === 'render') renderCommand()
  else {
    console.error('usage: node scripts/google_functions.mjs fetch [saved.html] | render')
    process.exit(2)
  }
}
