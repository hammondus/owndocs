// Reading preferences: pure enough to test without a browser, apart from the
// two DOM shims below. Run from web/: node scripts/prefs_test.mjs
import { load, save, apply, familyStack, listLocalFonts, DEFAULTS, FONTS } from '../src/prefs.js'

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

// Minimal stand-ins: a Storage and an element that records custom properties.
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
  }
}
const fakeRoot = () => ({ props: {}, style: { setProperty(k, v) { this.props ??= {}; this.props[k] = v } } })
const propsOf = (root) => root.style.props

globalThis.window = { localStorage: fakeStorage() }
globalThis.document = { documentElement: fakeRoot() }

eq(load(), DEFAULTS, 'no stored preferences yields the defaults')

// The case that bites on the second release: a blob saved by an older version
// is missing whatever has been added since, and must not erase it.
globalThis.window.localStorage = fakeStorage({ 'docs:reading': JSON.stringify({ font: 'serif' }) })
eq(load(), { ...DEFAULTS, font: 'serif' }, 'a partial stored blob merges over the defaults')

globalThis.window.localStorage = fakeStorage({ 'docs:reading': 'not json{' })
eq(load(), DEFAULTS, 'unreadable storage falls back rather than throwing')

// Privacy modes make even *touching* localStorage throw, and a preference
// failing to save must never take the editor down with it.
globalThis.window = {
  get localStorage() {
    throw new Error('access denied')
  },
}
eq(load(), DEFAULTS, 'storage that throws on access still yields defaults')
try {
  save({ ...DEFAULTS, size: 20 })
  ok('saving into throwing storage does not throw')
} catch (e) {
  fail('saving into throwing storage does not throw', e.message)
}

// apply() is what the whole feature actually does.
{
  const root = fakeRoot()
  apply({ font: 'serif', size: 20, lineHeight: 1.8, measure: 60 }, root)
  const p = propsOf(root)
  eq(p['--reading-font'], FONTS.find((f) => f.id === 'serif').stack, 'font id resolves to a stack')
  eq(p['--reading-size'], '20px', 'size carries its unit')
  eq(p['--reading-line-height'], '1.8', 'line height is unitless, as CSS wants')
  eq(p['--reading-measure'], '60ch', 'measure is in ch, so it tracks the character count')
}

{
  // Zero means full width, and must become `none` rather than `0ch` — which
  // would collapse the text column to nothing.
  const root = fakeRoot()
  apply({ ...DEFAULTS, measure: 0 }, root)
  eq(propsOf(root)['--reading-measure'], 'none', 'a zero measure means no limit, not zero width')
}

{
  // An unknown font id from a hand-edited or downgraded store must not leave
  // the property unset, which would inherit whatever the page had.
  const root = fakeRoot()
  apply({ ...DEFAULTS, font: 'comic-sans-9000' }, root)
  eq(propsOf(root)['--reading-font'], FONTS[0].stack, 'an unknown font falls back to the first')
}

// ---- named families --------------------------------------------------------
// A family the reader typed or picked from their installed fonts. It ends up
// in a CSS declaration, where one stray character invalidates the whole thing
// silently — the same failure `Helvetica Neue` unquoted already caused once.

eq(familyStack('Georgia'), '"Georgia", system-ui, sans-serif', 'a family is quoted and given a fallback')
eq(familyStack('Iowan Old Style'), '"Iowan Old Style", system-ui, sans-serif', 'multi-word families survive')
eq(familyStack('  Charter  '), '"Charter", system-ui, sans-serif', 'surrounding space is trimmed')
eq(familyStack(''), '', 'an empty family yields nothing to apply')
eq(familyStack('   '), '', 'a whitespace-only family yields nothing')
eq(familyStack('Noto Sans CJK'), '"Noto Sans CJK", system-ui, sans-serif', 'digits and caps are kept')
eq(familyStack('Bad"; } body {'), '"Bad  body", system-ui, sans-serif', 'quotes and braces are stripped')
eq(familyStack('a'.repeat(200)).length < 100, true, 'an absurd name is truncated')

{
  // A named family beats the built-in stack; clearing it hands control back.
  const root = fakeRoot()
  apply({ ...DEFAULTS, font: 'mono', family: 'Georgia' }, root)
  eq(propsOf(root)['--reading-font'], '"Georgia", system-ui, sans-serif', 'a named family wins over the built-in')

  apply({ ...DEFAULTS, font: 'mono', family: '' }, root)
  eq(propsOf(root)['--reading-font'], FONTS.find((f) => f.id === 'mono').stack, 'clearing it restores the built-in')

  // A family that sanitises to nothing must not blank the property.
  apply({ ...DEFAULTS, font: 'serif', family: '!!!' }, root)
  eq(propsOf(root)['--reading-font'], FONTS.find((f) => f.id === 'serif').stack,
     'an unusable family falls back rather than unsetting the font')
}

// Enumeration is Chromium-only, prompts for permission, and needs a secure
// context. Every one of those is a normal outcome, not an error.
eq(await listLocalFonts(), null, 'no queryLocalFonts yields null, not a throw')
globalThis.window = { queryLocalFonts: async () => { throw new Error('denied') } }
eq(await listLocalFonts(), null, 'a refused permission yields null')
globalThis.window = {
  queryLocalFonts: async () => [{ family: 'Zapfino' }, { family: 'Charter' }, { family: 'Charter' }],
}
eq(await listLocalFonts(), ['Charter', 'Zapfino'], 'families are de-duplicated and sorted')

if (failures > 0) {
  console.error(`\n${failures} FAILURES`)
  process.exit(1)
}
console.log('\nALL PASS')
