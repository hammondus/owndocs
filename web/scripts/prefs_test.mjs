// Reading preferences: pure enough to test without a browser, apart from the
// two DOM shims below. Run from web/: node scripts/prefs_test.mjs
import { load, save, apply, DEFAULTS, FONTS } from '../src/prefs.js'

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

if (failures > 0) {
  console.error(`\n${failures} FAILURES`)
  process.exit(1)
}
console.log('\nALL PASS')
