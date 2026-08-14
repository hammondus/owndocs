// Extraction for the search index: what text a document contributes.
// Run from web/: node scripts/searchindex_test.mjs
import * as Y from 'yjs'
import { Workbook } from '../src/sheet/model.js'
import { extractText, clamp, MAX_INDEX_CHARS } from '../src/searchindex.js'

let failures = 0
const ok = (what) => console.log('ok:', what)
const fail = (what, detail) => {
  failures++
  console.error(`FAIL: ${what}${detail ? '\n  ' + detail : ''}`)
}
const eq = (got, want, what) =>
  got === want ? ok(what) : fail(what, `got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`)
const has = (hay, needle, what) =>
  String(hay).includes(needle) ? ok(what) : fail(what, `${JSON.stringify(needle)} not in ${JSON.stringify(hay)}`)
const hasNot = (hay, needle, what) =>
  !String(hay).includes(needle) ? ok(what) : fail(what, `${JSON.stringify(needle)} unexpectedly in ${JSON.stringify(hay)}`)

// ---- documents ------------------------------------------------------------

const doc = new Y.Doc()
doc.getText('text').insert(0, '# Heading\n\nThe quarterly revenue forecast.\n')
eq(extractText(doc, 'doc'), '# Heading\n\nThe quarterly revenue forecast.\n',
  'a document indexes its markdown, exactly as the exporter writes it')

// The markdown markers stay in. They tokenize away, and stripping them would
// mean a second renderer that could disagree with the exporter's.
has(extractText(doc, 'doc'), '# Heading', 'markup is left alone rather than half-rendered')

const empty = new Y.Doc()
eq(extractText(empty, 'doc'), '', 'an empty document contributes nothing')

// ---- sheets ---------------------------------------------------------------

const sheetDoc = new Y.Doc()
const wb = new Workbook(sheetDoc)
const first = wb.list()[0]
const sheet = wb.sheet(first.id)
sheet.setCell(0, 0, 'Region')
sheet.setCell(0, 1, 'Revenue')
sheet.setCell(1, 0, 'Tasmania')
sheet.setCell(1, 1, '42')
const sheetText = extractText(sheetDoc, 'sheet')
has(sheetText, 'Tasmania', 'a sheet indexes its cell values')
has(sheetText, 'Revenue', 'including the header row, which is just another row')

// Tab names are searchable: "the Q3 tab" is a thing people remember, and it is
// nowhere in the cells.
wb.renameSheet(first.id, 'Q3 Actuals')
has(extractText(sheetDoc, 'sheet'), 'Q3 Actuals', 'tab names are indexed too')

// ---- clamping -------------------------------------------------------------

eq(clamp('short'), 'short', 'text under the cap is untouched')
eq(clamp('abcdef', 3), 'abc', 'text over the cap is cut, not rejected')
eq(clamp('abc', 3), 'abc', 'exactly at the cap is untouched')
eq(clamp('x'.repeat(MAX_INDEX_CHARS + 10)).length, MAX_INDEX_CHARS,
  'the default cap is what the server will accept')

// A cut must not split a codepoint — a lone surrogate serializes as U+FFFD and
// gets indexed as a term matching nothing, which is worse than a missing tail
// because it is still in the index. `slice` counts UTF-16 units, so this is a
// real hazard rather than a theoretical one.
const astral = '\u{1F600}'.repeat(10)
eq(clamp(astral, 5), '\u{1F600}\u{1F600}', 'a cut mid-codepoint steps back rather than halving it')
eq(clamp(astral, 6), '\u{1F600}\u{1F600}\u{1F600}', 'a cut on a boundary keeps everything up to it')
eq(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clamp(astral, 7)), false,
  'no unpaired surrogate survives clamping')

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
process.exit(failures ? 1 : 0)
