// Exact decimal arithmetic, for the cells that need it.
//
// A double is exact for integers only up to 2^53-1 (9007199254740991), and
// for no decimal fraction that is not a sum of powers of two — 0.1 + 0.2 is
// famously not 0.3. Both are fine for almost every spreadsheet, which is
// why they stay the default. This type is what a cell switches to when
// they are not.
//
// A value is `d × 10⁻ˢ`: a BigInt of digits and a non-negative decimal
// scale. That makes +, - and × exact at any size and any number of places
// — align the scales, operate on integers, done. Division is the only
// operation with a policy, because 1/3 has no exact decimal: it computes
// to DIV_DIGITS significant digits and rounds half-up.
//
// Deliberately not a dependency. BigInt is stdlib and carries the part
// that is genuinely hard (arbitrary-size integer arithmetic); what is left
// is scale bookkeeping. The rounding rules are the part that is easy to
// get subtly wrong, so they are stated here and pinned in exact_test.mjs.

// Significant digits kept by division, matching IEEE decimal128. Chosen to
// be far past any input a person types, so the rounding only ever shows up
// in genuinely non-terminating results.
const DIV_DIGITS = 34

export class Dec {
  constructor(d, s) {
    this.d = d // BigInt: the digits, sign included
    this.s = s // int >= 0: how many of those digits are after the point
  }
}

export const isDec = (v) => v instanceof Dec

// The additive identity, needed often enough (SUM of an empty range, the
// seed of a fold) to be worth naming once.
export const DEC_ZERO = new Dec(0n, 0)

// The one place the representation is made canonical, so every operation
// can hand back whatever scale fell out of its arithmetic.
//
// A negative scale (digits × a positive power of ten) is arithmetically
// fine but not representable here, so it is folded into the digits. In the
// other direction, trailing zeros in the fraction carry no information —
// a spreadsheet shows 2, not 2.00, unless a format says so — and dropping
// them means equal values always print identically.
function norm(d, s) {
  if (s < 0) { d *= TEN(-s); s = 0 }
  while (s > 0 && d % 10n === 0n) { d /= 10n; s-- }
  return new Dec(d, s)
}

const TEN = (n) => 10n ** BigInt(n)

// Both values at a common scale, so integer arithmetic can proceed.
function align(a, b) {
  const s = Math.max(a.s, b.s)
  return [a.d * TEN(s - a.s), b.d * TEN(s - b.s), s]
}

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

// Parse without losing anything. Accepts what a cell can hold: an ordinary
// literal, or one in exponent form. Returns null for text.
export function parseDec(text) {
  const s = String(text).trim()
  if (s === '') return null
  const m = DECIMAL.exec(s)
  if (!m) return null
  const [, sign, int = '', frac = '', exp] = m
  if (!int && !frac) return null // "." and "e5" are not numbers
  let scale = frac.length
  let digits = BigInt((int || '0') + frac)
  // An exponent is a shift of the decimal point, so it is a change of
  // scale — never a multiplication, which is what would lose digits.
  if (exp) scale -= Number(exp)
  return norm(sign === '-' ? -digits : digits, scale)
}

// A double's shortest round-trip decimal is what the user meant by it:
// 0.1 came from someone typing 0.1, not from the binary fraction nearby.
// Promoting through that string is therefore the honest conversion.
export function fromNumber(n) {
  if (!Number.isFinite(n)) return null
  return parseDec(String(n))
}

export function decToNumber(a) {
  return Number(decToString(a))
}

export function decToString(a) {
  const neg = a.d < 0n
  let ds = (neg ? -a.d : a.d).toString()
  if (a.s > 0) {
    if (ds.length <= a.s) ds = ds.padStart(a.s + 1, '0')
    ds = ds.slice(0, ds.length - a.s) + '.' + ds.slice(ds.length - a.s)
  }
  return (neg ? '-' : '') + ds
}

export const decIsZero = (a) => a.d === 0n

export function decAdd(a, b) {
  const [x, y, s] = align(a, b)
  return norm(x + y, s)
}

export function decSub(a, b) {
  const [x, y, s] = align(a, b)
  return norm(x - y, s)
}

export function decMul(a, b) {
  // Scales add: (d₁×10⁻ˢ¹)(d₂×10⁻ˢ²) = d₁d₂×10⁻⁽ˢ¹⁺ˢ²⁾. Exact, always.
  return norm(a.d * b.d, a.s + b.s)
}

export function decCmp(a, b) {
  const [x, y] = align(a, b)
  return x < y ? -1 : x > y ? 1 : 0
}

export const decNeg = (a) => new Dec(-a.d, a.s)
export const decAbs = (a) => (a.d < 0n ? new Dec(-a.d, a.s) : a)

const countDigits = (d) => (d < 0n ? -d : d).toString().length

// Drop `n` digits off the end, rounding half away from zero — the rule a
// spreadsheet user expects (2.5 rounds to 3, -2.5 to -3), and the one
// ROUND already implements for doubles.
function dropDigits(d, n) {
  if (n <= 0) return d
  const p = TEN(n)
  const neg = d < 0n
  const abs = neg ? -d : d
  const q = abs / p
  const rounded = abs % p * 2n >= p ? q + 1n : q
  return neg ? -rounded : rounded
}

// Round to `n` significant digits. Nothing in the arithmetic calls this —
// the whole point of a Dec is that its digits are not thrown away — but a
// cell has to show something a person can read, and 34 digits of 1/3 is
// not it. Display only; the value keeps everything.
export function decSigRound(a, n) {
  const excess = countDigits(a.d) - n
  if (excess <= 0) return a
  // A scale that goes negative here is the ordinary case for a large
  // integer (trim 17 digits to 13 and the last four become zeros, not
  // absent); norm folds it back into the digits.
  return norm(dropDigits(a.d, excess), a.s - excess)
}

export function decDiv(a, b) {
  if (b.d === 0n) return null // the caller decides that this is #DIV/0!
  if (a.d === 0n) return new Dec(0n, 0)
  // A quotient that terminates is returned whole, however long it is:
  // dividing a 40-digit integer by 1 must not come back rounded to 34.
  // One modulo answers it — if the numerator scaled by 10^DIV_DIGITS
  // divides evenly, every digit of the result is real.
  const scaled = a.d * TEN(DIV_DIGITS)
  if (scaled % b.d === 0n) return norm(scaled / b.d, a.s - b.s + DIV_DIGITS)
  // Otherwise the result does not terminate within that many places.
  // a/b = (aᵈ/bᵈ) × 10^(bˢ-aˢ). Scale the numerator up first so the
  // integer division keeps enough digits to round from: k is chosen to
  // land the quotient just past DIV_DIGITS significant digits.
  const k = Math.max(0, DIV_DIGITS + 1 + countDigits(b.d) - countDigits(a.d))
  const q = (a.d * TEN(k)) / b.d
  // A division that comes out even leaves trailing zeros here, which norm
  // strips — so 1/4 is exactly 0.25 with no special case for it.
  const excess = countDigits(q) - DIV_DIGITS
  return norm(dropDigits(q, excess), k + a.s - b.s - Math.max(0, excess))
}

// ROUND's rule, on an exact value: `places` may be negative, which rounds
// to tens, hundreds and so on.
export function decRound(a, places) {
  if (places >= a.s) return a
  if (places >= 0) return norm(dropDigits(a.d, a.s - places), places)
  const shifted = dropDigits(a.d, a.s - places)
  return norm(shifted * TEN(-places), 0)
}

// Only an integer power can be exact, and only a small one is worth
// computing: 10^100000 is a 100001-digit number nobody asked for. Anything
// else is the caller's cue to fall back to a double.
const MAX_POW = 1000
export function decPow(a, b) {
  if (b.s !== 0 || b.d > BigInt(MAX_POW) || b.d < BigInt(-MAX_POW)) return null
  const n = Number(b.d)
  if (n === 0) return new Dec(1n, 0)
  const p = norm(a.d ** BigInt(Math.abs(n)), a.s * Math.abs(n))
  return n > 0 ? p : decDiv(new Dec(1n, 0), p)
}
