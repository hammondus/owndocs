// roles.js decides what the UI offers, and one of its two rules is a real
// boundary: a commenter who keeps the editing buttons can write to a document
// through them, because EditorState.readOnly stops user input and a toolbar
// button is a programmatic dispatch. The other rule — the rich flag — is not a
// boundary and must not be mistaken for one.
// Run from web/: node scripts/roles_test.mjs
import { canEdit, canComment, visibleToolbar } from '../src/roles.js'

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

// ---- ranks -----------------------------------------------------------------

eq([canEdit('owner'), canEdit('editor')], [true, true], 'owners and editors may edit')
eq([canEdit('commenter'), canEdit('viewer')], [false, false], 'commenters and viewers may not')
eq(canComment('commenter'), true, 'a commenter may comment')
eq(canComment('viewer'), false, 'a viewer may not')
// An unknown role ranks below everything rather than above it: a role this
// build has not heard of must not be handed the editing controls.
eq([canEdit('admin'), canComment('admin')], [false, false], 'an unrecognised role gets nothing')
eq([canEdit(undefined), canComment(null)], [false, false], 'a missing role gets nothing')

// ---- visibleToolbar --------------------------------------------------------

// A stand-in for the real bar: one editing command, one separator, one entry
// that survives read-only access, and one that only a rich document offers.
const BAR = [
  { label: 'B' },
  { sep: true },
  { label: 'Colour', rich: true },
  { label: 'Aa', display: true },
]
const labels = (opts) => visibleToolbar(BAR, opts).map((c) => c.label ?? 'sep')

eq(labels({ canEdit: true, rich: true }), ['B', 'sep', 'Colour', 'Aa'], 'an editor on a rich document sees everything')
eq(labels({ canEdit: true, rich: false }), ['B', 'sep', 'Aa'], 'a plain document withholds the appearance commands')

// The boundary. A commenter keeps only what changes nothing in the document,
// and the separator goes with the commands it was dividing.
eq(labels({ canEdit: false, rich: false }), ['Aa'], 'a commenter gets reading controls only')
// The rich flag must not smuggle an editing command past the role gate: a
// commenter on a rich document is still a commenter.
eq(labels({ canEdit: false, rich: true }), ['Aa'], 'rich does not widen what a commenter may reach')

// Not a mutation: the toolbar is module-level data shared by every document,
// and a filter that edited it in place would leak one document's flag into the
// next one opened.
visibleToolbar(BAR, { canEdit: false, rich: false })
eq(BAR.length, 4, 'filtering leaves the source list alone')

if (failures > 0) process.exit(1)
console.log('\nALL PASS')
