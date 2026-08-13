// Cell formatting: the terse record stored per cell (and per row/column as
// a default), and the number formatter that turns a computed value into
// display text. Pure — no Yjs, no DOM.
//
// Keys are short on purpose: every formatted cell stores one of these and
// they all cross the wire.
//   b   bold            1
//   i   italic          1
//   a   align           'l' | 'c' | 'r'
//   n   number format   see NUMBER_FORMATS
//   c   text colour     '#rrggbb'
//   bg  background      '#rrggbb'
//   cur currency symbol '$' (only meaningful with n:'cur')

import { formatDate, parseDate, isDateFormat } from './dates.js'
import {
  Dec, DEC_ZERO, isDec, decToString, decToNumber, decIsZero,
  decAbs, decCmp, decMul, decDiv, decRound, fromNumber,
} from './exact.js'

export const NUMBER_FORMATS = [
  { id: 'auto', label: 'Automatic' },
  { id: 'int', label: 'Number (1,235)' },
  { id: 'dec2', label: 'Number (1,234.57)' },
  { id: 'plain', label: 'Plain (1234.57)' },
  { id: 'sci', label: 'Scientific (1.23×10³)' },
  { id: 'pct', label: 'Percent (12.34%)' },
  { id: 'cur', label: 'Currency ($1,234.57)' },
  { id: 'date', label: 'Date (05/08/2026)' },
  { id: 'isodate', label: 'Date (2026-08-05)' },
  { id: 'datelong', label: 'Date (5 August 2026)' },
  { id: 'datetime', label: 'Date and time' },
  { id: 'time', label: 'Time' },
]

export { isDateFormat }

// Intl.NumberFormat is built into the browser and node: correct grouping
// and rounding for the viewer's locale, with no dependency and no
// hand-rolled digit juggling. Instances are cached because display() runs
// for every visible cell on every frame and constructing one is not cheap.
const formatters = new Map()
function formatter(min, max) {
  const key = min + ':' + max
  let f = formatters.get(key)
  if (!f) {
    f = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: min,
      maximumFractionDigits: max,
      useGrouping: true,
    })
    formatters.set(key, f)
  }
  return f
}

// Scientific notation is written the way print maths writes it (1.23×10³)
// rather than the way a calculator display has to (1.23E+03). These are
// ordinary characters, so the canvas draws them with no font work, and the
// same mapping run backwards lets a displayed cell be typed back in.
const SUPERS = '⁰¹²³⁴⁵⁶⁷⁸⁹'
const toSuper = (exp) => String(exp).replace(/-/g, '⁻').replace(/\d/g, (d) => SUPERS[d])

function formatScientific(n) {
  // ∞ and NaN have no mantissa; let Intl name them as it does elsewhere.
  if (!Number.isFinite(n)) return formatter(0, 2).format(n)
  // toExponential does the part that is easy to get wrong by hand: it
  // rounds the mantissa and carries the overflow into the exponent, so
  // 9999 reads 1.00×10⁴ and not 10.00×10³. The mantissa still goes
  // through Intl, for the viewer's decimal separator.
  const [mantissa, exp] = n.toExponential(2).split('e')
  return formatter(2, 2).format(Number(mantissa)) + '×10' + toSuper(Number(exp))
}

const HUNDRED = fromNumber(100)
const TEN = fromNumber(10)

// Scientific notation for an exact value, without going through a double
// — which would defeat the point for anything past 2^53, and is simply
// impossible past ~1e308.
//
// Shifting the scale so exactly one digit sits before the point gives the
// mantissa for free: the digits never move, only the point does.
function decScientific(n) {
  if (decIsZero(n)) return formatter(2, 2).format(0) + '×10⁰'
  const neg = decCmp(n, DEC_ZERO) < 0
  const a = decAbs(n)
  const len = a.d.toString().length
  let exp = len - 1 - a.s
  let mant = decRound(new Dec(a.d, len - 1), 2)
  // Rounding 9.999 gives 10.00, which is not a mantissa — carry it.
  if (decCmp(mant, TEN) >= 0) { mant = decDiv(mant, TEN); exp++ }
  return (neg ? '-' : '') + formatter(2, 2).format(decToString(mant)) + '×10' + toSuper(exp)
}

// How a number should read given a format. Non-numbers are never touched:
// a number format on a text cell is inert, not an error.
//
// `n` is a double or an exact decimal. Intl.NumberFormat accepts a decimal
// STRING and rounds it losslessly, so most formats need nothing more than
// handing it the digits instead of a coerced Number — the display side of
// exactness is very nearly free.
export function formatNumber(n, fmt) {
  const spec = fmt?.n
  // A date is a number with a date format on it — see dates.js. Serials
  // are small and never exact, so this is one place demotion costs nothing.
  if (isDateFormat(spec)) return formatDate(isDec(n) ? decToNumber(n) : n, spec)
  const v = isDec(n) ? decToString(n) : n
  switch (spec) {
    case 'int': return formatter(0, 0).format(v)
    case 'dec2': return formatter(2, 2).format(v)
    case 'plain': return String(v)
    case 'sci': return isDec(n) ? decScientific(n) : formatScientific(n)
    case 'pct': {
      // ×100 is a shift of the decimal point, so an exact percentage
      // stays exact rather than picking up binary noise on the way.
      const scaled = isDec(n) ? decToString(decMul(n, HUNDRED)) : n * 100
      return formatter(0, 2).format(scaled) + '%'
    }
    case 'cur': {
      const sym = fmt.cur || '$'
      const negative = isDec(n) ? decCmp(n, DEC_ZERO) < 0 : n < 0
      const abs = isDec(n) ? decToString(decAbs(n)) : Math.abs(n)
      // The sign goes outside the symbol: -$5.00, not $-5.00.
      return (negative ? '-' : '') + sym + formatter(2, 2).format(abs)
    }
    default: return null // 'auto': the caller's own default applies
  }
}

// A format record as CSS. Shared by the clipboard's HTML flavour and the
// history preview, so a cell looks the same wherever it is rendered
// outside the grid's canvas.
export function formatCss(f) {
  if (!f) return ''
  const css = []
  if (f.b) css.push('font-weight:bold')
  if (f.i) css.push('font-style:italic')
  if (f.a) css.push(`text-align:${f.a === 'l' ? 'left' : f.a === 'c' ? 'center' : 'right'}`)
  if (f.c) css.push(`color:${f.c}`)
  if (f.bg) css.push(`background-color:${f.bg}`)
  return css.join(';')
}

// Cell over row over column, so a currency column can be overridden one
// cell at a time. Absent keys fall through; an explicit null does not
// occur (removing a key deletes it — see the model's setFormat).
export function resolveFormat(colFmt, rowFmt, cellFmt) {
  if (!colFmt && !rowFmt && !cellFmt) return null
  return { ...colFmt, ...rowFmt, ...cellFmt }
}

// Apply a patch: a key set to null is removed, anything else overwrites.
// Returns null when nothing is left, so the model can delete the entry
// instead of storing an empty object.
export function mergeFormat(current, patch) {
  const out = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === false) delete out[k]
    else out[k] = v
  }
  return Object.keys(out).length ? out : null
}

// What the user typed, when it is really a number wearing punctuation:
// "$1,234.50", "12%", "1,000". Returns the numeric value plus the format
// that punctuation implies, or null when the text is not a number at all.
// Every spreadsheet does this — typing 12% and getting the string "12%"
// would be surprising.
const TRAILING_PCT = /^(.*?)\s*%$/
const CURRENCY_SYMBOLS = ['$', '£', '€', '¥', 'A$', 'NZ$', 'R$', '₹']

// Two ways an exponent arrives: 1.5e10 as anyone types it, and 1.23×10³ as
// this app displays it. The second matters because otherwise the format is
// a one-way door — copy a scientific cell out as text, type it back, and it
// would land as a label instead of the number it just was.
const EXPONENT = /^(\d*\.?\d+)[eE]([+-]?\d+)$/
const fromSuper = (s) =>
  s.replace(/×10([⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+)$/, (_, sup) =>
    'e' + [...sup].map((c) => (c === '⁻' ? '-' : SUPERS.indexOf(c))).join(''))

export function parseTypedNumber(text) {
  let s = String(text).trim()
  if (s === '') return null

  // A typed date is a number too: store the serial, let the format carry
  // the fact that it should read as a date.
  const date = parseDate(s)
  if (date) return { value: date.serial, fmt: { n: date.kind } }

  let negative = false
  if (s.startsWith('-')) { negative = true; s = s.slice(1).trim() }

  let fmt = null
  const pct = TRAILING_PCT.exec(s)
  if (pct) {
    s = pct[1].trim()
    fmt = { n: 'pct' }
  } else {
    // Longest symbol first, so A$ is not read as a bare A.
    const sym = [...CURRENCY_SYMBOLS].sort((a, b) => b.length - a.length)
      .find((x) => s.startsWith(x))
    if (sym) {
      s = s.slice(sym.length).trim()
      fmt = { n: 'cur', cur: sym }
    }
  }

  let n
  const exp = EXPONENT.exec(fromSuper(s))
  if (exp) {
    n = Number(exp[1] + 'e' + exp[2])
    // An exponent the user typed is a format request like any other
    // punctuation here — but a currency or percent sign already said more.
    if (!fmt) fmt = { n: 'sci' }
  } else {
    if (!/^\d{1,3}(,\d{3})*(\.\d+)?$|^\d*\.?\d+$/.test(s)) return null
    n = Number(s.replace(/,/g, ''))
    // Grouping separators the user typed are themselves a format request.
    if (!fmt && s.includes(',')) fmt = { n: s.includes('.') ? 'dec2' : 'int' }
  }
  // Rejects 1e999, which overflows to Infinity: that is text, not a number.
  if (!Number.isFinite(n)) return null

  let value = negative ? -n : n
  if (fmt?.n === 'pct') value = value / 100
  return { value, fmt }
}
