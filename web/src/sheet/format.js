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

export const NUMBER_FORMATS = [
  { id: 'auto', label: 'Automatic' },
  { id: 'int', label: 'Number (1,235)' },
  { id: 'dec2', label: 'Number (1,234.57)' },
  { id: 'plain', label: 'Plain (1234.57)' },
  { id: 'pct', label: 'Percent (12.34%)' },
  { id: 'cur', label: 'Currency ($1,234.57)' },
]

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

// How a number should read given a format. Non-numbers are never touched:
// a number format on a text cell is inert, not an error.
export function formatNumber(n, fmt) {
  const spec = fmt?.n
  switch (spec) {
    case 'int': return formatter(0, 0).format(n)
    case 'dec2': return formatter(2, 2).format(n)
    case 'plain': return String(n)
    case 'pct': return formatter(0, 2).format(n * 100) + '%'
    case 'cur': {
      const sym = fmt.cur || '$'
      // The sign goes outside the symbol: -$5.00, not $-5.00.
      return (n < 0 ? '-' : '') + sym + formatter(2, 2).format(Math.abs(n))
    }
    default: return null // 'auto': the caller's own default applies
  }
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

export function parseTypedNumber(text) {
  let s = String(text).trim()
  if (s === '') return null

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

  if (!/^\d{1,3}(,\d{3})*(\.\d+)?$|^\d*\.?\d+$/.test(s)) return null
  const grouped = s.includes(',')
  const n = Number(s.replace(/,/g, ''))
  if (!Number.isFinite(n)) return null

  // Grouping separators the user typed are themselves a format request.
  if (!fmt && grouped) fmt = { n: s.includes('.') ? 'dec2' : 'int' }

  let value = negative ? -n : n
  if (fmt?.n === 'pct') value = value / 100
  return { value, fmt }
}
