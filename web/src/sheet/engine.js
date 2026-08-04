// Formula engine: tokenizer, Pratt parser, serializer, evaluator, and the
// built-in function registry. Pure — no Yjs, no DOM, no knowledge of how
// cells are stored. The model (model.js) feeds it cell values through a
// context object and maps references between A1 notation and stable ids.
//
// Values are: number | string | boolean | null (empty cell) | {error: code}.
// Errors propagate through operators and most functions, Excel-style.

// ---- values ---------------------------------------------------------------

export const ERR = (code) => ({ error: code })
export const isErr = (v) => v !== null && typeof v === 'object' && 'error' in v

// Format a number the way a cell should show it: integers plain, floats
// trimmed of binary noise (0.1+0.2 shows 0.3, not 0.30000000000000004).
export function fmtNum(n) {
  if (Number.isInteger(n)) return String(n)
  return String(parseFloat(n.toPrecision(13)))
}

function toNum(v) {
  if (isErr(v)) return v
  if (v === null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const s = v.trim()
  if (s === '') return ERR('#VALUE!')
  const n = Number(s)
  return Number.isNaN(n) ? ERR('#VALUE!') : n
}

function toStr(v) {
  if (isErr(v)) return v
  if (v === null) return ''
  if (typeof v === 'number') return fmtNum(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return v
}

function toBool(v) {
  if (isErr(v)) return v
  if (v === null) return false
  if (typeof v === 'boolean') return v
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
const A1_RE = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]*)$/

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
      const m = /^@(\$?)([a-z0-9]+)\.(\$?)([a-z0-9]+)/.exec(src.slice(i))
      if (!m) throw new Error('bad reference')
      toks.push({ t: 'ref', ref: {
        kind: 'id', rid: m[2], cid: m[4],
        absRow: m[1] === '$', absCol: m[3] === '$',
      } })
      i += m[0].length
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
      const a1 = A1_RE.exec(word)
      if (a1) {
        toks.push({ t: 'ref', ref: {
          kind: 'a1',
          col: parseColName(a1[2]), row: Number(a1[4]) - 1,
          absCol: a1[1] === '$', absRow: a1[3] === '$',
        } })
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
        return { n: 'range', a: t.ref, b: b.ref }
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

function refText(ref) {
  if (ref.kind === 'a1') {
    return (ref.absCol ? '$' : '') + colName(ref.col) + (ref.absRow ? '$' : '') + (ref.row + 1)
  }
  if (ref.kind === 'id') {
    return `@${ref.absRow ? '$' : ''}${ref.rid}.${ref.absCol ? '$' : ''}${ref.cid}`
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
    case 'range': return refText(ast.a) + ':' + refText(ast.b)
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
      const v = toNum(evaluate(ast.e, ctx))
      if (isErr(v)) return v
      return ast.op === '-' ? -v : v
    }
    case 'pct': {
      const v = toNum(evaluate(ast.e, ctx))
      return isErr(v) ? v : v / 100
    }
    case 'bin': return binop(ast, ctx)
    case 'call': return call(ast, ctx)
  }
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
  const a = toNum(l), b = toNum(r)
  if (isErr(a)) return a
  if (isErr(b)) return b
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
  const rank = (v) => typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2
  if (rank(l) !== rank(r)) return rank(l) - rank(r)
  if (typeof l === 'string') {
    const a = l.toLowerCase(), b = r.toLowerCase()
    return a < b ? -1 : a > b ? 1 : 0
  }
  return l < r ? -1 : l > r ? 1 : 0
}

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
function numbersIn(args) {
  const out = []
  for (const a of args) {
    if (a !== null && typeof a === 'object' && 'range' in a) {
      for (const v of a.range) if (typeof v === 'number') out.push(v)
    } else {
      const n = toNum(a)
      if (isErr(n)) return n
      out.push(n)
    }
  }
  return out
}

const num1 = (fn) => (args) => {
  if (args.length !== 1 || (args[0] !== null && typeof args[0] === 'object' && 'range' in args[0])) return ERR('#VALUE!')
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
    return isErr(ns) ? ns : ns.reduce((a, b) => a + b, 0)
  },
  AVERAGE: (args) => {
    const ns = numbersIn(args)
    if (isErr(ns)) return ns
    return ns.length === 0 ? ERR('#DIV/0!') : ns.reduce((a, b) => a + b, 0) / ns.length
  },
  MIN: (args) => {
    const ns = numbersIn(args)
    return isErr(ns) ? ns : ns.length === 0 ? 0 : Math.min(...ns)
  },
  MAX: (args) => {
    const ns = numbersIn(args)
    return isErr(ns) ? ns : ns.length === 0 ? 0 : Math.max(...ns)
  },
  COUNT: (args) => {
    let n = 0
    for (const a of args) {
      if (a !== null && typeof a === 'object' && 'range' in a) {
        for (const v of a.range) if (typeof v === 'number') n++
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
    const x = toNum(args[0])
    if (isErr(x)) return x
    const d = args.length === 2 ? toNum(args[1]) : 0
    if (isErr(d)) return d
    const n = Math.trunc(d)
    // Shift the decimal point in STRING form: 1.005 is 1.00499…9 in binary,
    // so multiply-then-round would give 1.00 where the user sees 1.01.
    // Half rounds away from zero (Excel), not to even (IEEE).
    const abs = Math.abs(x)
    if (String(abs).includes('e')) return x // beyond ~1e21: decimals are moot
    const shifted = Math.round(Number(`${abs}e${n}`))
    return Math.sign(x) * Number(`${shifted}e${-n}`)
  },
  ABS: num1(Math.abs),
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

function boolFold(args, init, op) {
  let acc = init, any = false
  for (const a of args) {
    if (a !== null && typeof a === 'object' && 'range' in a) {
      for (const v of a.range) {
        if (typeof v === 'number' || typeof v === 'boolean') { acc = op(acc, toBool(v)); any = true }
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
