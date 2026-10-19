// The site's enforced tier. A claim in site/ that carries a data- attribute
// is compared against the registry it names, so the site cannot say something
// the code does not do — and, where the registry is a complete list, cannot
// fall silent about something it does. See DESIGN-DECISIONS.md, *The enforced
// tier is data attributes, not prose*, for why attributes rather than prose
// or generation.
//
// One more check of the same shape guards the app rather than the site: no
// raw `fetch(` outside lib/api.js. Once a demo session lives under a path
// prefix, a stray absolute call works everywhere but there.
//
// Run from web/: node scripts/site_test.mjs
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CALLABLE } from '../src/sheet/engine.js'
import { CHART_TYPES } from '../src/sheet/chart.js'
import { readSnapshot, OPERATORS } from './google_functions.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
const ok = (what) => console.log('ok:', what)
const fail = (what, detail) => {
  failures++
  console.error(`FAIL: ${what}${detail ? '\n  ' + detail : ''}`)
}
const sorted = (xs) => [...new Set(xs)].sort()
// Both directions, named so a failure says which side is short.
const same = (site, code, what) => {
  const missing = sorted(code).filter((x) => !site.includes(x))
  const extra = sorted(site).filter((x) => !code.includes(x))
  if (missing.length) fail(`${what}: the site never mentions`, missing.join(', '))
  if (extra.length) fail(`${what}: the site claims something the code lacks`, extra.join(', '))
  if (!missing.length && !extra.length) ok(`${what}: the site and the code agree, both ways`)
}

// ---- the pages -------------------------------------------------------------

const siteDir = join(root, 'site')
const pages = readdirSync(siteDir).filter((f) => f.endsWith('.html'))
if (!pages.length) fail('site/ has no pages')

// Comments are stripped first: a page explains its own attributes in one, and
// the explanation must not count as a claim.
const html = Object.fromEntries(
  pages.map((p) => [p, read(join('site', p)).replace(/<!--[\s\S]*?-->/g, '')]),
)
const all = Object.values(html).join('\n')

const attrs = (name) => sorted([...all.matchAll(new RegExp(`data-${name}="([^"]*)"`, 'g'))].map((m) => m[1]))

// ---- data-make → the Makefile, and the README ------------------------------
// One direction only, on purpose: the Makefile has plumbing targets (`js`,
// `runner-js`) that nobody types, and a page listing them would be a page
// about the build rather than about running the app. The README check is the
// other half of the decision to duplicate the commands rather than link them.

const phony = sorted(
  [...read('Makefile').matchAll(/^\.PHONY:\s*(.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/)),
)
const readme = read('README.md')
const makes = [...all.matchAll(/<code data-make="([^"]+)">([^<]*)<\/code>/g)]
for (const [, target, text] of makes) {
  if (!phony.includes(target)) fail(`data-make="${target}" is not a .PHONY target`)
  if (!readme.includes(text.trim())) fail(`the site shows "${text.trim()}" and the README does not`)
}
if (makes.length) ok(`every make command on the site is a real target and is in the README (${makes.length})`)
else fail('the site shows no make commands')

// ---- data-fn → CALLABLE ----------------------------------------------------

same(attrs('fn'), CALLABLE, 'formulas')

// ---- data-absent-fn → not in CALLABLE --------------------------------------
// The comparison page names functions the engine lacks. One direction only:
// the claim is that each named function is absent, not that the list is every
// absent function. When one ships, this fails until the page stops calling it
// missing.

const absent = attrs('absent-fn')
const shipped = absent.filter((fn) => CALLABLE.includes(fn))
if (shipped.length) fail('the site calls these functions missing, and the engine has them', shipped.join(', '))
else if (absent.length) ok(`every function the site calls missing is missing (${absent.length})`)

// ---- data-absent-fn and data-operator → the Google Sheets snapshot ---------
// Both ways against google-sheets-functions.tsv: every function in the
// snapshot that the engine lacks is on the site, as missing or as an operator,
// and nothing else is. When the engine gains a function, this fails until
// `node scripts/google_functions.mjs render` drops it from the page. The
// snapshot itself changes only when someone refreshes it, so Google adding a
// function never fails this test.

const snapshot = readSnapshot()
const lacks = [...snapshot.category.keys()].filter((n) => !CALLABLE.includes(n))
same([...absent, ...attrs('operator')], lacks, `Google Sheets functions the engine lacks, as of ${snapshot.date}`)
same(attrs('operator'), Object.keys(OPERATORS), 'operators listed under their Google names')

// ---- data-chart → CHART_TYPES ----------------------------------------------
// Both ways: the comparison page says "charts other than these", so a new
// chart type makes the sentence wrong.

same(attrs('chart'), CHART_TYPES.map((t) => t.id), 'chart types')

// ---- data-role → roles.js and docs_api.go ----------------------------------
// The two rank maps are hand-mirrored with a comment on each saying so. This
// is the first thing that reads both, so it checks them against each other
// before checking the site against either.

const jsRank = Object.fromEntries(
  [...read('web/src/roles.js').match(/const RANK = \{([^}]*)\}/)[1].matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], +m[2]]),
)
const goRank = Object.fromEntries(
  [...read('docs_api.go').match(/var roleRank = map\[string\]int\{([^}]*)\}/)[1].matchAll(/"(\w+)":\s*(\d+)/g)].map((m) => [m[1], +m[2]]),
)
if (JSON.stringify(jsRank) === JSON.stringify(goRank)) ok('RANK in roles.js and roleRank in docs_api.go agree')
else fail('RANK in roles.js and roleRank in docs_api.go disagree', `js ${JSON.stringify(jsRank)}\n  go ${JSON.stringify(goRank)}`)
same(attrs('role'), Object.keys(goRank), 'roles')

// ---- data-key → formatKeymap -----------------------------------------------
// The editor's bindings only. The sheet's shortcuts are not a registry, so
// the site's list is editor-only until the sheet grows one.

const keymap = read('web/src/editor.js').match(/const formatKeymap = \[([\s\S]*?)\n\]/)[1]
same(attrs('key'), [...keymap.matchAll(/key: '([^']+)'/g)].map((m) => m[1]), 'editor shortcuts')

// ---- data-shot → site/shots ------------------------------------------------
// Both ways: a shot the site uses that nothing produces, and a shot produced
// that nothing uses, both fail. Empty on both sides until `make site-shots`
// exists, which is a pass.

const shotsDir = join(siteDir, 'shots')
const shots = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, '')) : []
same(attrs('shot'), shots, 'screenshots')

// ---- hygiene the pages share -----------------------------------------------

for (const [p, src] of Object.entries(html)) {
  for (const [, href] of src.matchAll(/href="([^"#?]+)/g)) {
    if (/^[a-z]+:/.test(href)) continue
    // A directory link (./) is served as its index.html, so that file must exist.
    const target = href.endsWith('/') ? join(siteDir, href, 'index.html') : join(siteDir, href)
    if (!existsSync(target)) fail(`${p} links to ${href}, which does not exist`)
  }
  if (!/<meta name="color-scheme" content="light dark">/.test(src)) fail(`${p} does not declare its colour schemes`)
}
ok('every internal link resolves, and every page declares light and dark')

if (read('site/favicon.svg') === read('web/public/favicon.svg')) ok('the site serves the same favicon as the app')
else fail('site/favicon.svg differs from web/public/favicon.svg')

// ---- no raw fetch( outside lib/api.js --------------------------------------

const strays = []
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(js|svelte)$/.test(f) && relative(root, p) !== 'web/src/lib/api.js') {
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (/\bfetch\(/.test(line)) strays.push(`${relative(root, p)}:${i + 1}`)
      })
    }
  }
}
walk(join(root, 'web/src'))
if (strays.length) fail('raw fetch( outside lib/api.js', strays.join('\n  '))
else ok('every request to the server goes through lib/api.js')

if (failures > 0) {
  console.error(`\n${failures} FAILURES`)
  process.exit(1)
}
console.log('\nALL PASS')
