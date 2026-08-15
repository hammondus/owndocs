// Formula engine: tokenizer, Pratt parser, serializer, evaluator, and the
// built-in function registry. Pure — no Yjs, no DOM, no knowledge of how
// cells are stored. The model (model.js) feeds it cell values through a
// context object and maps references between A1 notation and stable ids.
//
// Values are: number | Dec | string | boolean | null (empty cell) |
// {error: code}. Errors propagate through operators and most functions,
// Excel-style. A Dec is an exact decimal (exact.js), produced by cells the
// user has marked exact; it flows through arithmetic so that a total over
// exact inputs is itself exact, and demotes to a double at any function
// that has no exact implementation.

import { serialFromParts, partsFromSerial } from './dates.js'
import {
  DEC_ZERO, isDec, fromNumber, decToString, decToNumber, decIsZero,
  decAdd, decSub, decMul, decDiv, decCmp, decNeg, decAbs, decRound, decPow,
  decSigRound,
} from './exact.js'

// The clock TODAY/NOW read. A seam, so tests can pin "now" instead of
// asserting against the wall clock.
let clock = () => new Date()
export function setClock(fn) {
  clock = fn
}

// ---- values ---------------------------------------------------------------

export const ERR = (code) => ({ error: code })
export const isErr = (v) => v !== null && typeof v === 'object' && 'error' in v

// Digits a cell shows before it stops being readable. The double path has
// always used 13 (it is where binary noise starts, and where 0.1+0.2 reads
// as 0.3); the exact path uses the same number so that switching a cell to
// exact does not change how an ordinary number looks. Only the *rendering*
// is short — the value keeps every digit, and the formula bar shows the
// literal that was typed.
const DISPLAY_DIGITS = 13

// Format a number the way a cell should show it: integers plain, floats
// trimmed of binary noise (0.1+0.2 shows 0.3, not 0.30000000000000004).
//
// An exact value is trimmed on the same rule rather than printed whole.
// Whole is right for an integer however long — a 20-digit account number
// is the reason the cell is exact at all — but a fraction has no such
// limit: exact 1/3 carries 34 digits, and a grid full of them is unreadable
// for no gain. Scale 0 is exactly the integer test, on a Dec.
export function fmtNum(n) {
  if (isDec(n)) return decToString(n.s > 0 ? decSigRound(n, DISPLAY_DIGITS) : n)
  if (Number.isInteger(n)) return String(n)
  return String(parseFloat(n.toPrecision(DISPLAY_DIGITS)))
}

// A double promotes to exact; an exact value never silently demotes inside
// a calculation. Promotion goes through the double's shortest round-trip
// decimal, because 0.1 came from someone typing 0.1 — the binary fraction
// nearby is an artefact of storage, not what they meant.
//
// Returns an error unchanged, or null when there is no exact value to be
// had (a non-finite double), which is the caller's cue to stay on doubles.
const HUNDRED = fromNumber(100)

function toExact(v) {
  if (isDec(v)) return v
  const n = toNum(v)
  return isErr(n) ? n : fromNumber(n)
}

// toNum is deliberately the DEMOTING conversion: it always hands back a
// double. That way every function that has not been given an exact path —
// SQRT, MOD, the date and text functions — keeps working unchanged and
// falls back to double arithmetic instead of crashing on a value type it
// has never seen. Exactness is opted into per site, by looking at the raw
// value before calling this.
function toNum(v) {
  if (isErr(v)) return v
  if (v === null) return 0
  if (typeof v === 'number') return v
  if (isDec(v)) return decToNumber(v)
  if (typeof v === 'boolean') return v ? 1 : 0
  const s = v.trim()
  if (s === '') return ERR('#VALUE!')
  const n = Number(s)
  return Number.isNaN(n) ? ERR('#VALUE!') : n
}

function toStr(v) {
  if (isErr(v)) return v
  if (v === null) return ''
  if (typeof v === 'number' || isDec(v)) return fmtNum(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return v
}

function toBool(v) {
  if (isErr(v)) return v
  if (v === null) return false
  if (typeof v === 'boolean') return v
  if (isDec(v)) return !decIsZero(v)
  if (typeof v === 'number') return v !== 0
  const s = v.trim().toUpperCase()
  if (s === 'TRUE') return true
  if (s === 'FALSE') return false
  return ERR('#VALUE!')
}

// ---- A1 column names ------------------------------------------------------

// 0 -> A, 25 -> Z, 26 -> AA (bijective base 26)
export function colName(i) {
  let s = ''
  for (i = i + 1; i > 0; i = Math.floor((i - 1) / 26)) {
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s
  }
  return s
}

export function parseColName(s) {
  let n = 0
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

// ---- tokenizer ------------------------------------------------------------

// Reference forms the tokenizer understands:
//   A1 style:  $?letters$?digits        (what users type and see)
//   id style:  @rowid.colid             (what gets stored — see model.js)
// Either may carry a sheet: `Sheet2!A1` / `'My Sheet'!A1` when typed,
// `@sheetid!rowid.colid` when stored. No sheet means "this sheet".
const A1_RE = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]*)$/
const A1_HEAD_RE = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]*)/

function a1Ref(m, sheet) {
  return {
    kind: 'a1', sheet,
    col: parseColName(m[2]), row: Number(m[4]) - 1,
    absCol: m[1] === '$', absRow: m[3] === '$',
  }
}

function tokenize(src) {
  const toks = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue }
    if (c >= '0' && c <= '9' || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i))
      toks.push({ t: 'num', v: Number(m[0]) })
      i += m[0].length
      continue
    }
    if (c === '"') {
      let s = '', j = i + 1
      for (; j < src.length; j++) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { s += '"'; j++ } // "" escapes a quote
          else break
        } else s += src[j]
      }
      if (j >= src.length) throw new Error('unterminated string')
      toks.push({ t: 'str', v: s })
      i = j + 1
      continue
    }
    if (c === '@') {
      // A `$` before a component marks it absolute, exactly as in A1 — the
      // flags have to survive storage or copy/paste couldn't honour them.
      const m = /^@(?:([a-z0-9]+)!)?(\$?)([a-z0-9]+)\.(\$?)([a-z0-9]+)/.exec(src.slice(i))
      if (!m) throw new Error('bad reference')
      toks.push({ t: 'ref', ref: {
        kind: 'id', sheet: m[1], rid: m[3], cid: m[5],
        absRow: m[2] === '$', absCol: m[4] === '$',
      } })
      i += m[0].length
      continue
    }
    if (c === "'") {
      // A quoted sheet name, which is only meaningful before `!`. Cell text
      // never reaches the parser (a leading apostrophe forces a literal in
      // the model), so there is no ambiguity here.
      let name = '', j = i + 1
      for (; j < src.length; j++) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") { name += "'"; j++ } // '' escapes a quote
          else break
        } else name += src[j]
      }
      if (j >= src.length || src[j + 1] !== '!') throw new Error('bad sheet reference')
      const m = A1_HEAD_RE.exec(src.slice(j + 2))
      if (!m) throw new Error('bad reference after sheet name')
      toks.push({ t: 'ref', ref: a1Ref(m, name) })
      i = j + 2 + m[0].length
      continue
    }
    if (c === '#') {
      // #REF! is a real literal, not just a rendering: a formula whose
      // reference died must survive being re-typed or re-committed.
      if (src.slice(i, i + 5).toUpperCase() === '#REF!') {
        toks.push({ t: 'ref', ref: { kind: 'dead' } })
        i += 5
        continue
      }
      throw new Error('unknown error literal')
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[$A-Za-z0-9_.]+/.exec(src.slice(i))
      const word = m[0]
      i += word.length
      // An unquoted sheet name: the word before a `!` names a sheet, and
      // what follows is the reference within it.
      if (src[i] === '!') {
        const rm = A1_HEAD_RE.exec(src.slice(i + 1))
        if (!rm) throw new Error('bad reference after sheet name')
        toks.push({ t: 'ref', ref: a1Ref(rm, word) })
        i += 1 + rm[0].length
        continue
      }
      const a1 = A1_RE.exec(word)
      if (a1) {
        toks.push({ t: 'ref', ref: a1Ref(a1, undefined) })
      } else if (word.toUpperCase() === 'TRUE' || word.toUpperCase() === 'FALSE') {
        toks.push({ t: 'bool', v: word.toUpperCase() === 'TRUE' })
      } else {
        toks.push({ t: 'ident', v: word.toUpperCase() })
      }
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === '<=' || two === '>=' || two === '<>') {
      toks.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if ('+-*/^%&=<>(),:'.includes(c)) {
      toks.push({ t: 'op', v: c })
      i++
      continue
    }
    throw new Error(`unexpected '${c}'`)
  }
  return toks
}

// ---- parser ---------------------------------------------------------------

// Binary precedence, Excel-flavored. Two quirks worth knowing:
//   - unary minus binds tighter than ^  (-2^2 is 4, not -4)
//   - ^ is LEFT-associative             (2^3^2 is 64, not 512)
const BINPREC = {
  '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1,
  '&': 2,
  '+': 3, '-': 3,
  '*': 4, '/': 4,
  '^': 5,
}

export function parseFormula(src) {
  const toks = tokenize(src)
  let pos = 0
  const peek = () => toks[pos]
  const next = () => toks[pos++]
  const expectOp = (v) => {
    const t = next()
    if (!t || t.t !== 'op' || t.v !== v) throw new Error(`expected '${v}'`)
  }

  function parseExpr(minPrec) {
    let left = parseUnary()
    for (;;) {
      const t = peek()
      if (!t || t.t !== 'op' || !(t.v in BINPREC) || BINPREC[t.v] < minPrec) return left
      next()
      const right = parseExpr(BINPREC[t.v] + 1) // +1 = left-associative
      left = { n: 'bin', op: t.v, l: left, r: right }
    }
  }

  function parseUnary() {
    const t = peek()
    if (t && t.t === 'op' && (t.v === '-' || t.v === '+')) {
      next()
      return { n: 'un', op: t.v, e: parseUnary() }
    }
    return parsePostfix()
  }

  function parsePostfix() {
    let e = parsePrimary()
    while (peek() && peek().t === 'op' && peek().v === '%') {
      next()
      e = { n: 'pct', e }
    }
    return e
  }

  function parsePrimary() {
    const t = next()
    if (!t) throw new Error('unexpected end of formula')
    if (t.t === 'num') return { n: 'num', v: t.v }
    if (t.t === 'str') return { n: 'str', v: t.v }
    if (t.t === 'bool') return { n: 'bool', v: t.v }
    if (t.t === 'ref') {
      if (peek() && peek().t === 'op' && peek().v === ':') {
        next()
        const b = next()
        if (!b || b.t !== 'ref') throw new Error('bad range')
        // Sheet2!A1:A5 — the sheet named once applies to both endpoints, so
        // a range can never straddle two sheets.
        const end = b.ref.sheet === undefined ? { ...b.ref, sheet: t.ref.sheet } : b.ref
        return { n: 'range', a: t.ref, b: end }
      }
      return { n: 'ref', ref: t.ref }
    }
    if (t.t === 'ident') {
      expectOp('(')
      const args = []
      if (!(peek() && peek().t === 'op' && peek().v === ')')) {
        for (;;) {
          args.push(parseExpr(1))
          const s = peek()
          if (s && s.t === 'op' && s.v === ',') { next(); continue }
          break
        }
      }
      expectOp(')')
      return { n: 'call', fn: t.v, args }
    }
    if (t.t === 'op' && t.v === '(') {
      const e = parseExpr(1)
      expectOp(')')
      return e
    }
    throw new Error(`unexpected '${t.v}'`)
  }

  const ast = parseExpr(1)
  if (pos < toks.length) throw new Error('trailing input')
  return ast
}

// ---- reference mapping ----------------------------------------------------

// Rebuild an AST with every reference passed through fn. The model uses this
// to convert typed A1 refs to stored id refs and back for display. fn may
// return {kind:'dead'} for a reference whose row/col no longer exists — it
// serializes and evaluates as #REF!.
export function mapRefs(ast, fn) {
  switch (ast.n) {
    case 'ref': return { n: 'ref', ref: fn(ast.ref) }
    case 'range': return { n: 'range', a: fn(ast.a), b: fn(ast.b) }
    case 'bin': return { ...ast, l: mapRefs(ast.l, fn), r: mapRefs(ast.r, fn) }
    case 'un': return { ...ast, e: mapRefs(ast.e, fn) }
    case 'pct': return { ...ast, e: mapRefs(ast.e, fn) }
    case 'call': return { ...ast, args: ast.args.map((a) => mapRefs(a, fn)) }
    default: return ast
  }
}

// Collect every reference in an AST (the model builds its dependency picture
// from this).
export function collectRefs(ast, out = { cells: [], ranges: [] }) {
  switch (ast.n) {
    case 'ref': out.cells.push(ast.ref); break
    case 'range': out.ranges.push([ast.a, ast.b]); break
    case 'bin': collectRefs(ast.l, out); collectRefs(ast.r, out); break
    case 'un': case 'pct': collectRefs(ast.e, out); break
    case 'call': for (const a of ast.args) collectRefs(a, out); break
  }
  return out
}

// ---- serializer -----------------------------------------------------------

// A sheet name may be written bare only if it can't be mistaken for
// something else in a formula — otherwise it gets quoted, Excel-style.
export function quoteSheetName(name) {
  const bare = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !A1_RE.test(name)
  return bare ? name : "'" + name.replace(/'/g, "''") + "'"
}

function refText(ref) {
  if (ref.kind === 'a1') {
    const cell = (ref.absCol ? '$' : '') + colName(ref.col) + (ref.absRow ? '$' : '') + (ref.row + 1)
    return ref.sheet === undefined ? cell : quoteSheetName(ref.sheet) + '!' + cell
  }
  if (ref.kind === 'id') {
    const cell = `${ref.absRow ? '$' : ''}${ref.rid}.${ref.absCol ? '$' : ''}${ref.cid}`
    return ref.sheet === undefined ? '@' + cell : `@${ref.sheet}!${cell}`
  }
  return '#REF!' // kind 'dead'
}

// Precedence-aware, so =A1+B1*2 round-trips as typed instead of gaining
// parentheses. parentPrec is the minimum precedence the context requires.
function ser(ast, parentPrec) {
  switch (ast.n) {
    case 'num': return fmtNum(ast.v)
    case 'str': return '"' + ast.v.replace(/"/g, '""') + '"'
    case 'bool': return ast.v ? 'TRUE' : 'FALSE'
    case 'ref': return refText(ast.ref)
    case 'range': {
      // A range with both ends gone collapses to one #REF!, as Excel shows
      // it — "#REF!:#REF!" tells the reader nothing extra.
      if (ast.a.kind === 'dead' && ast.b.kind === 'dead') return '#REF!'
      // Print the sheet once: Sheet2!A1:A5, never Sheet2!A1:Sheet2!A5.
      const end = ast.b.sheet !== undefined && ast.b.sheet === ast.a.sheet
        ? { ...ast.b, sheet: undefined }
        : ast.b
      return refText(ast.a) + ':' + refText(end)
    }
    case 'un': {
      const inner = ast.op + ser(ast.e, 6)
      return 6 < parentPrec ? '(' + inner + ')' : inner
    }
    case 'pct': return ser(ast.e, 7) + '%'
    case 'bin': {
      const p = BINPREC[ast.op]
      const inner = ser(ast.l, p) + ast.op + ser(ast.r, p + 1)
      return p < parentPrec ? '(' + inner + ')' : inner
    }
    case 'call': return ast.fn + '(' + ast.args.map((a) => ser(a, 1)).join(',') + ')'
  }
}

export const serialize = (ast) => ser(ast, 1)

// ---- evaluator ------------------------------------------------------------

// ctx must provide:
//   refValue(ref)      -> value of one cell
//   rangeValues(a, b)  -> flat array of values in the rectangle
// Function args are evaluated to values; a range arg becomes {range: [...]}.

export function evaluate(ast, ctx) {
  switch (ast.n) {
    case 'num': return ast.v
    case 'str': return ast.v
    case 'bool': return ast.v
    case 'ref':
      if (ast.ref.kind === 'dead') return ERR('#REF!')
      return ctx.refValue(ast.ref)
    case 'range':
      return ERR('#VALUE!') // a bare range is not a scalar (no implicit intersection)
    case 'un': {
      const raw = evaluate(ast.e, ctx)
      if (isDec(raw)) return ast.op === '-' ? decNeg(raw) : raw
      const v = toNum(raw)
      if (isErr(v)) return v
      return ast.op === '-' ? -v : v
    }
    case 'pct': {
      const raw = evaluate(ast.e, ctx)
      // Dividing by exactly 100 only shifts the decimal point, so a
      // percentage of an exact value stays exact.
      if (isDec(raw)) return decDiv(raw, HUNDRED)
      const v = toNum(raw)
      return isErr(v) ? v : v / 100
    }
    case 'bin': return binop(ast, ctx)
    case 'call': return call(ast, ctx)
  }
}

// The additive and multiplicative operators, done on the operands' decimal
// images rather than on their bits.
//
// A plain cell holds a double, but that double is a binary approximation of a
// decimal someone typed. `fromNumber` recovers the shortest round-trip form —
// which is exactly what the cell shows — so operating there and demoting once
// makes `0.1+0.2` the very same double as a typed `0.3`. The noise leaves the
// *value* instead of being hidden by the formatter, which is what fixes the
// two cases a user actually notices: `0.1+0.2-0.3` is 0, not 5.55e-17, and
// `=A1+A2=0.3` is TRUE.
//
// This is not the exact path and does not widen it. The result is a double and
// still rounds at every step, so a plain cell keeps every limit it had — the
// 2^53 integer ceiling included. Only the rounding is decimal instead of
// binary. `/` is left alone deliberately: decDiv has a 34-digit policy, so
// routing it would round twice for no visible gain.
//
// Costs ~500ns against ~60ns for the raw operator, and up to ~8us at extreme
// exponents where the BigInt runs to hundreds of digits. Both are far below a
// frame at any cell count this grid renders.
const DEC_OPS = { '+': decAdd, '-': decSub, '*': decMul }

// Returns null when there is no decimal to work with (a non-finite operand),
// which is the caller's cue to fall back to the raw operator.
function decimalOp(op, a, b) {
  const x = fromNumber(a), y = fromNumber(b)
  if (!x || !y) return null
  return decToNumber(DEC_OPS[op](x, y))
}

function binop(ast, ctx) {
  const l = evaluate(ast.l, ctx)
  if (isErr(l)) return l
  const r = evaluate(ast.r, ctx)
  if (isErr(r)) return r
  const op = ast.op
  if (op === '&') {
    const a = toStr(l), b = toStr(r)
    if (isErr(a)) return a
    if (isErr(b)) return b
    return a + b
  }
  if (op in CMP) return CMP[op](compare(l, r))
  // Exactness spreads: if either operand is exact then so is the result,
  // on the same reasoning that already carries number formats through a
  // formula — precision is a property of the value, not decoration on it.
  // Marking the source cells is therefore enough; totals downstream follow
  // without being marked themselves.
  if (isDec(l) || isDec(r)) {
    const x = toExact(l), y = toExact(r)
    if (isErr(x)) return x
    if (isErr(y)) return y
    // x or y is null only when a double had no exact value (infinity), in
    // which case there is nothing to be exact about and the double path
    // below gives the honest answer.
    if (x && y) {
      switch (op) {
        case '+': return decAdd(x, y)
        case '-': return decSub(x, y)
        case '*': return decMul(x, y)
        case '/': return decIsZero(y) ? ERR('#DIV/0!') : decDiv(x, y)
        case '^': {
          // Only integer powers have an exact answer; a root falls through.
          const p = decPow(x, y)
          if (p) return p
          break
        }
      }
    }
  }
  const a = toNum(l), b = toNum(r)
  if (isErr(a)) return a
  if (isErr(b)) return b
  // Below here both operands are doubles: an exact operand returned above.
  if (op in DEC_OPS) {
    const d = decimalOp(op, a, b)
    if (d !== null) return d
  }
  switch (op) {
    case '+': return a + b
    case '-': return a - b
    case '*': return a * b
    case '/': return b === 0 ? ERR('#DIV/0!') : a / b
    case '^': {
      const p = Math.pow(a, b)
      return Number.isFinite(p) ? p : ERR('#NUM!')
    }
  }
}

const CMP = {
  '=': (c) => c === 0, '<>': (c) => c !== 0,
  '<': (c) => c < 0, '<=': (c) => c <= 0,
  '>': (c) => c > 0, '>=': (c) => c >= 0,
}

// Excel ordering: numbers < strings < booleans; string comparison is
// case-insensitive; empty coerces to the other side's type.
function compare(l, r) {
  if (l === null) l = typeof r === 'string' ? '' : typeof r === 'boolean' ? false : 0
  if (r === null) r = typeof l === 'string' ? '' : typeof l === 'boolean' ? false : 0
  const rank = (v) => typeof v === 'number' || isDec(v) ? 0 : typeof v === 'string' ? 1 : 2
  if (rank(l) !== rank(r)) return rank(l) - rank(r)
  if (typeof l === 'string') {
    const a = l.toLowerCase(), b = r.toLowerCase()
    return a < b ? -1 : a > b ? 1 : 0
  }
  // Two values a double cannot tell apart may be genuinely different, so
  // an exact operand decides the comparison exactly too. Otherwise
  // =A1=A2 could report equal for numbers the cells display differently.
  if (isDec(l) || isDec(r)) {
    const x = toExact(l), y = toExact(r)
    if (x && y && !isErr(x) && !isErr(y)) return decCmp(x, y)
  }
  return l < r ? -1 : l > r ? 1 : 0
}

// Names `call` handles itself rather than looking up in FUNCTIONS, because
// they need their arguments *unevaluated*. Anything added here must be added
// to this list too — it is what the function reference derives from, and
// functions.js has a test that fails if the two disagree.
export const SPECIAL_FORMS = ['IF']

function call(ast, ctx) {
  // IF is a special form: only the taken branch is evaluated, so an error
  // in the untaken branch (or a self-reference there) cannot poison it.
  if (ast.fn === 'IF') {
    if (ast.args.length < 2 || ast.args.length > 3) return ERR('#VALUE!')
    const c = toBool(evaluate(ast.args[0], ctx))
    if (isErr(c)) return c
    if (c) return evaluate(ast.args[1], ctx)
    return ast.args[2] ? evaluate(ast.args[2], ctx) : false
  }
  const fn = FUNCTIONS[ast.fn]
  if (!fn) return ERR('#NAME?')
  const args = []
  for (const a of ast.args) {
    if (a.n === 'range') {
      if (a.a.kind === 'dead' || a.b.kind === 'dead') return ERR('#REF!')
      const rv = ctx.rangeValues(a.a, a.b)
      if (isErr(rv)) return rv // an endpoint's row/col was deleted since parse
      args.push({ range: rv })
    } else {
      const v = evaluate(a, ctx)
      if (isErr(v)) return v // errors in args fail the call, Excel-style
      args.push(v)
    }
  }
  return fn(args)
}

// ---- functions ------------------------------------------------------------

// Aggregators follow Excel's rule: inside a RANGE only real numbers count
// (text and booleans are ignored); a DIRECT argument is coerced ("5" and
// TRUE count when passed directly).
const isNum = (v) => typeof v === 'number' || isDec(v)

function numbersIn(args) {
  const out = []
  for (const a of args) {
    if (a !== null && typeof a === 'object' && 'range' in a) {
      // Exact values stay exact here rather than being flattened to
      // doubles, which is what lets SUM over an exact column be exact.
      for (const v of a.range) if (isNum(v)) out.push(v)
    } else {
      const n = isDec(a) ? a : toNum(a)
      if (isErr(n)) return n
      out.push(n)
    }
  }
  return out
}

// Fold a list that may mix exact values and doubles. One exact member
// makes the whole result exact, so a single marked cell in a column is
// enough to make its total trustworthy. Falls back to doubles if any
// member has no exact form.
function sumOf(ns) {
  if (ns.some(isDec)) {
    const ds = ns.map(toExact)
    if (ds.every((d) => d && !isErr(d))) return ds.reduce(decAdd, DEC_ZERO)
  }
  // A fold of plain doubles goes through Dec as well, on the same reasoning as
  // `+` — and with more to gain, since a column compounds its per-step error
  // where a single operator only makes it once. One demotion at the end, so
  // SUM over doubles is now the correctly rounded decimal total rather than a
  // running binary one. Still a double, and still the double path.
  const xs = ns.map((v) => fromNumber(toNum(v)))
  if (xs.every(Boolean)) return decToNumber(xs.reduce(decAdd, DEC_ZERO))
  return ns.reduce((a, b) => toNum(a) + toNum(b), 0)
}

const num1 = (fn, exact) => (args) => {
  if (args.length !== 1 || (args[0] !== null && typeof args[0] === 'object' && 'range' in args[0])) return ERR('#VALUE!')
  // An exact argument keeps its precision only where the function has an
  // exact implementation; otherwise it demotes, which is the honest
  // answer for something like SQRT that has no exact result anyway.
  if (exact && isDec(args[0])) return exact(args[0])
  const n = toNum(args[0])
  return isErr(n) ? n : fn(n)
}

const str1 = (fn) => (args) => {
  if (args.length !== 1) return ERR('#VALUE!')
  const s = toStr(args[0])
  return isErr(s) ? s : fn(s)
}

// The registry is a plain object on purpose: scripts will later register
// custom functions by adding entries.
export const FUNCTIONS = {
  SUM: (args) => {
    const ns = numbersIn(args)
    return isErr(ns) ? ns : sumOf(ns)
  },
  AVERAGE: (args) => {
    const ns = numbersIn(args)
    if (isErr(ns)) return ns
    if (ns.length === 0) return ERR('#DIV/0!')
    const total = sumOf(ns)
    if (!isDec(total)) return total / ns.length
    return decDiv(total, fromNumber(ns.length))
  },
  // Compared rather than Math.min'd, so the winner is returned as it was
  // stored: an exact value survives being the smallest.
  MIN: (args) => {
    const ns = numbersIn(args)
    return isErr(ns) ? ns : ns.length === 0 ? 0 : ns.reduce((a, b) => (compare(b, a) < 0 ? b : a))
  },
  MAX: (args) => {
    const ns = numbersIn(args)
    return isErr(ns) ? ns : ns.length === 0 ? 0 : ns.reduce((a, b) => (compare(b, a) > 0 ? b : a))
  },
  COUNT: (args) => {
    let n = 0
    for (const a of args) {
      if (a !== null && typeof a === 'object' && 'range' in a) {
        for (const v of a.range) if (isNum(v)) n++
      } else if (!isErr(toNum(a))) n++
    }
    return n
  },
  COUNTA: (args) => {
    let n = 0
    for (const a of args) {
      if (a !== null && typeof a === 'object' && 'range' in a) {
        for (const v of a.range) if (v !== null) n++
      } else if (a !== null) n++
    }
    return n
  },
  AND: (args) => boolFold(args, true, (a, b) => a && b),
  OR: (args) => boolFold(args, false, (a, b) => a || b),
  NOT: (args) => {
    if (args.length !== 1) return ERR('#VALUE!')
    const b = toBool(args[0])
    return isErr(b) ? b : !b
  },
  ROUND: (args) => {
    if (args.length < 1 || args.length > 2) return ERR('#VALUE!')
    const d0 = args.length === 2 ? toNum(args[1]) : 0
    if (isErr(d0)) return d0
    // An exact value needs none of the string juggling below: it is
    // already a decimal, so rounding is arithmetic on its digits.
    //
    // The two paths agree on every half-way case a person can type —
    // ROUND(2326.95,1) is 2327 both ways — because the double path rounds
    // from the shortest round-trip string, which is the decimal the user
    // meant, not the binary 2326.9499… underneath it. They part company only
    // where the double genuinely cannot hold the value: past 2^53 (an exact
    // 12345678901234567890 keeps its last digits, a double lost them on the
    // way in) and past ~1e21, where the string form goes exponential and the
    // double path bails out below. Both are the ordinary integer ceiling, not
    // a difference in rounding rule.
    if (isDec(args[0])) return decRound(args[0], Math.trunc(d0))
    const x = toNum(args[0])
    if (isErr(x)) return x
    const n = Math.trunc(d0)
    // Shift the decimal point in STRING form: 1.005 is 1.00499…9 in binary,
    // so multiply-then-round would give 1.00 where the user sees 1.01.
    // Half rounds away from zero (Excel), not to even (IEEE).
    const abs = Math.abs(x)
    if (String(abs).includes('e')) return x // beyond ~1e21: decimals are moot
    const shifted = Math.round(Number(`${abs}e${n}`))
    return Math.sign(x) * Number(`${shifted}e${-n}`)
  },
  ABS: num1(Math.abs, decAbs),
  SQRT: num1((n) => (n < 0 ? ERR('#NUM!') : Math.sqrt(n))),
  MOD: (args) => {
    if (args.length !== 2) return ERR('#VALUE!')
    const a = toNum(args[0]), b = toNum(args[1])
    if (isErr(a)) return a
    if (isErr(b)) return b
    if (b === 0) return ERR('#DIV/0!')
    return a - b * Math.floor(a / b) // result takes the divisor's sign, like Excel
  },
  CONCATENATE: (args) => {
    let s = ''
    for (const a of args) {
      if (a !== null && typeof a === 'object' && 'range' in a) return ERR('#VALUE!')
      const t = toStr(a)
      if (isErr(t)) return t
      s += t
    }
    return s
  },
  LEN: str1((s) => s.length),
  UPPER: str1((s) => s.toUpperCase()),
  LOWER: str1((s) => s.toLowerCase()),
  TRIM: str1((s) => s.trim().replace(/ +/g, ' ')),
  // ---- dates (serials — see dates.js) ----
  // TODAY and NOW are the engine's only impure functions. Each client
  // computes them from its OWN clock and timezone, because nothing is ever
  // computed on the server. Two people in different zones can therefore
  // briefly read a different TODAY(); the stored document is identical
  // either way, since computed values are never stored. They refresh on
  // recalculation, not continuously.
  TODAY: (args) => {
    if (args.length) return ERR('#VALUE!')
    const d = clock()
    return serialFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate())
  },
  NOW: (args) => {
    if (args.length) return ERR('#VALUE!')
    const d = clock()
    return serialFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate(),
      d.getHours(), d.getMinutes(), d.getSeconds())
  },
  // DATE rolls over deliberately: DATE(2026,13,1) is January 2027, which
  // is what makes month arithmetic work. Typed input is validated instead.
  DATE: (args) => date3(args, (y, mo, d) => serialFromParts(y, mo, d)),
  TIME: (args) => date3(args, (h, mi, s) => (h * 3600 + mi * 60 + s) / 86400),
  YEAR: datePart((p) => p.y),
  MONTH: datePart((p) => p.mo),
  DAY: datePart((p) => p.d),
  HOUR: datePart((p) => p.hh),
  MINUTE: datePart((p) => p.mi),
  SECOND: datePart((p) => p.ss),
  WEEKDAY: (args) => {
    if (args.length < 1 || args.length > 2) return ERR('#VALUE!')
    const n = toNum(args[0])
    if (isErr(n)) return n
    const type = args.length === 2 ? toNum(args[1]) : 1
    if (isErr(type)) return type
    const dow = partsFromSerial(n).dow // 0 = Sunday
    if (type === 1) return dow + 1 // Sunday = 1, Excel's default
    if (type === 2) return ((dow + 6) % 7) + 1 // Monday = 1
    if (type === 3) return (dow + 6) % 7 // Monday = 0
    return ERR('#NUM!')
  },
  DAYS: (args) => {
    if (args.length !== 2) return ERR('#VALUE!')
    const end = toNum(args[0]), start = toNum(args[1])
    if (isErr(end)) return end
    if (isErr(start)) return start
    return Math.trunc(end) - Math.trunc(start)
  },
  EDATE: (args) => {
    if (args.length !== 2) return ERR('#VALUE!')
    const n = toNum(args[0]), months = toNum(args[1])
    if (isErr(n)) return n
    if (isErr(months)) return months
    const p = partsFromSerial(n)
    const target = p.mo - 1 + Math.trunc(months)
    const y = p.y + Math.floor(target / 12)
    const mo = ((target % 12) + 12) % 12 + 1
    // Clamp to the end of a shorter month: 31 Jan + 1 month is 28 Feb.
    const lastDay = partsFromSerial(serialFromParts(y, mo + 1, 1) - 1).d
    return serialFromParts(y, mo, Math.min(p.d, lastDay))
  },
  LEFT: (args) => sub(args, (s, n) => s.slice(0, n)),
  RIGHT: (args) => sub(args, (s, n) => (n === 0 ? '' : s.slice(-n))),
  MID: (args) => {
    if (args.length !== 3) return ERR('#VALUE!')
    const s = toStr(args[0]), start = toNum(args[1]), n = toNum(args[2])
    if (isErr(s)) return s
    if (isErr(start)) return start
    if (isErr(n)) return n
    if (start < 1 || n < 0) return ERR('#VALUE!')
    return s.slice(start - 1, start - 1 + n)
  },
}

// Everything a formula may call, from the one place that knows: the registry
// plus the special forms. The function reference lists exactly this, so it
// cannot drift from what the engine actually accepts.
export const CALLABLE = [...Object.keys(FUNCTIONS), ...SPECIAL_FORMS].sort()

// Three numeric args, no ranges: DATE(y,m,d) and TIME(h,m,s).
function date3(args, fn) {
  if (args.length !== 3) return ERR('#VALUE!')
  const ns = []
  for (const a of args) {
    if (a !== null && typeof a === 'object' && 'range' in a) return ERR('#VALUE!')
    const n = toNum(a)
    if (isErr(n)) return n
    ns.push(Math.trunc(n))
  }
  return fn(...ns)
}

// YEAR, MONTH, DAY and friends: one serial in, one component out.
function datePart(pick) {
  return (args) => {
    if (args.length !== 1) return ERR('#VALUE!')
    const n = toNum(args[0])
    if (isErr(n)) return n
    if (n < 0) return ERR('#NUM!')
    return pick(partsFromSerial(n))
  }
}

function boolFold(args, init, op) {
  let acc = init, any = false
  for (const a of args) {
    if (a !== null && typeof a === 'object' && 'range' in a) {
      for (const v of a.range) {
        if (isNum(v) || typeof v === 'boolean') { acc = op(acc, toBool(v)); any = true }
      }
    } else {
      const b = toBool(a)
      if (isErr(b)) return b
      acc = op(acc, b)
      any = true
    }
  }
  return any ? acc : ERR('#VALUE!')
}

function sub(args, fn) {
  if (args.length < 1 || args.length > 2) return ERR('#VALUE!')
  const s = toStr(args[0])
  if (isErr(s)) return s
  const n = args.length === 2 ? toNum(args[1]) : 1
  if (isErr(n)) return n
  if (n < 0) return ERR('#VALUE!')
  return fn(s, Math.trunc(n))
}
