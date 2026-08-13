// Writing a formula by pointing at cells, and seeing what one refers to.
//
// Two halves of the same idea, and both are pure text-and-geometry so they run
// under node — by the rule table.js set. `refs_test.mjs` covers them; the
// browser only supplies a caret position and a click.
//
//   - **Point mode.** While a formula is being typed, clicking a cell puts its
//     reference where the caret is. The whole difficulty is knowing *when*
//     that is wanted, because the same click has to keep meaning "select that
//     cell" the rest of the time.
//   - **Reference highlighting.** A formula's own references, as rectangles to
//     outline, so `=SUM(B2:B9)*C1` says which cells it is talking about.
import { parseFormula, collectRefs, colName } from './engine.js'

// A reference may follow any of these, and nothing else. The list is the
// grammar's own: an operator, an opening bracket, an argument separator, a
// range colon, or the `=` that starts a formula. Typing `=A1` and then
// clicking must *not* insert — the caret follows a complete reference, and
// what the person meant was to stop typing and select a cell.
//
// Trailing spaces are skipped, so `=SUM(A1, ` still points.
const EXPECTS_REF = /[=(,:+\-*/^&<>%]\s*$/

// Whether a reference may be inserted at `caret` in `text`.
//
// Deliberately conservative: when in doubt this says no, and the click does
// what it always did. A wrong "yes" writes into somebody's formula and moves
// their selection somewhere they did not ask for; a wrong "no" costs them
// typing the reference, which is what they do today anyway.
export function acceptsRef(text, caret) {
  if (typeof text !== 'string' || !text.startsWith('=')) return false
  const before = text.slice(0, caret)
  // `=` alone is the one case with no operator in front of it.
  if (/^=\s*$/.test(before)) return true
  return EXPECTS_REF.test(before)
}

// A1 for a single cell, A1:B9 for a rectangle. Always relative: an absolute
// reference is a deliberate act, and `$` is one keystroke away with F4 in
// every other spreadsheet — guessing it here would be wrong more often than
// right.
export function refText(rect) {
  const a = colName(rect.c1) + (rect.r1 + 1)
  if (rect.r1 === rect.r2 && rect.c1 === rect.c2) return a
  return a + ':' + colName(rect.c2) + (rect.r2 + 1)
}

// Insert (or replace) a reference, returning the new text and where the caret
// lands.
//
// `replacing` is the span a previous point-insert wrote, or null. Dragging
// across a range fires many of these, and without it every mouse-move would
// append another reference instead of growing the one being drawn — which is
// also what makes a second click *move* the reference rather than add to it,
// exactly as it does in Excel.
export function insertRef(text, caret, rect, replacing = null) {
  const ref = refText(rect)
  const from = replacing ? replacing.start : caret
  const to = replacing ? replacing.end : caret
  const next = text.slice(0, from) + ref + text.slice(to)
  return { text: next, caret: from + ref.length, span: { start: from, end: from + ref.length } }
}

// A half-typed formula, made parseable so it can still say what it refers to.
//
// This is what puts the outline on screen *while* a range is being dragged:
// `=SUM(A1:A3` is not a formula, and without repair the highlight would only
// appear at the moment the closing bracket is typed — which is exactly when it
// has stopped being useful.
//
// Two repairs, both conservative. A trailing operator, comma or colon is
// dropped, since it refers to nothing yet. Unclosed brackets are closed, with
// quoted strings skipped so a `(` inside one is not counted.
function repairFormula(body) {
  let out = body.replace(/[\s]+$/, '').replace(/[+\-*/^&<>=,:(]+$/, '')
  let depth = 0
  let inString = false
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]
    if (inString) {
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '(') depth++
    else if (ch === ')') depth--
  }
  if (inString) out += '"'
  return depth > 0 ? out + ')'.repeat(depth) : out
}

// The rectangles a formula refers to, for outlining.
//
// Only this sheet's own references: a formula may reach into another tab, and
// an outline drawn on the wrong grid is worse than none. Ranges come back
// normalised, since `=SUM(B9:B2)` is legal and means the same block.
//
// Returns [] for anything that is not a parseable formula, which includes
// every half-typed one — so a caller can hand this the live edit text on every
// keystroke and get a sensible answer while it is still nonsense.
export function formulaRefs(text) {
  if (typeof text !== 'string' || !text.startsWith('=')) return []
  let ast
  try {
    ast = parseFormula(repairFormula(text.slice(1)))
  } catch {
    return []
  }
  if (!ast) return []
  const { cells, ranges } = collectRefs(ast)
  const out = []
  const local = (ref) => ref && ref.kind === 'a1' && ref.sheet === undefined
  for (const ref of cells) {
    if (local(ref)) out.push({ r1: ref.row, c1: ref.col, r2: ref.row, c2: ref.col })
  }
  for (const [a, b] of ranges) {
    if (!local(a) || !local(b)) continue
    out.push({
      r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col),
      r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col),
    })
  }
  return out
}

// Outline colours, cycled by the order references appear. Deliberately not the
// selection blue and not a collaborator cursor colour — three different things
// drawn on one grid have to stay tellable apart.
export const REF_COLORS = ['#8e44ad', '#0b8043', '#d9730d', '#c2185b', '#00838f']

export const refColor = (i) => REF_COLORS[i % REF_COLORS.length]

// ---- absolute forms --------------------------------------------------------

// One A1 reference in a formula. The lookarounds are what keep `LOG10(` from
// reading as a reference to row 10 of column LOG: a token followed by `(` is a
// function name, and one preceded by a letter is the tail of a longer word.
// `Sheet2!A1` matches the `A1` and leaves the sheet name alone, which is what
// F4 should cycle there too.
const A1_TOKEN = /(?<![A-Za-z0-9_$])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/g

// Excel's order, and worth matching exactly because it is muscle memory:
// relative, both absolute, row absolute, column absolute, back to relative.
function nextForm(absCol, absRow) {
  if (!absCol && !absRow) return [true, true]
  if (absCol && absRow) return [false, true]
  if (!absCol && absRow) return [true, false]
  return [false, false]
}

function tokensIn(text) {
  const out = []
  A1_TOKEN.lastIndex = 0
  for (let m; (m = A1_TOKEN.exec(text)); ) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      absCol: m[1] === '$',
      col: m[2],
      absRow: m[3] === '$',
      row: m[4],
    })
  }
  return out
}

const written = (t, absCol, absRow) =>
  (absCol ? '$' : '') + t.col + (absRow ? '$' : '') + t.row

// F4: cycle the reference at the caret through its absolute forms. Returns
// null when the caret is not on one, so the key can fall through to whatever
// it would otherwise do.
//
// A range cycles as a unit — `A1:A3` becomes `$A$1:$A$3` — because that is
// what somebody who just pointed at a range and reached for F4 means, and
// cycling one end of it is never what they wanted.
export function cycleAbsolute(text, caret) {
  if (typeof text !== 'string' || !text.startsWith('=')) return null
  const tokens = tokensIn(text)
  // The caret counts as being on a token when it is inside it or sits at its
  // end — which is exactly where it lands after typing or pointing one.
  const i = tokens.findIndex((t) => caret >= t.start && caret <= t.end)
  if (i < 0) return null

  // A range is two tokens with a colon between them, and both move together.
  let group = [i]
  if (text[tokens[i].end] === ':' && tokens[i + 1] && tokens[i + 1].start === tokens[i].end + 1) {
    group = [i, i + 1]
  } else if (text[tokens[i].start - 1] === ':' && tokens[i - 1] && tokens[i - 1].end === tokens[i].start - 1) {
    group = [i - 1, i]
  }

  const [absCol, absRow] = nextForm(tokens[i].absCol, tokens[i].absRow)
  let out = text
  // Right to left, so an earlier token's offsets are still valid.
  for (const k of [...group].reverse()) {
    const t = tokens[k]
    out = out.slice(0, t.start) + written(t, absCol, absRow) + out.slice(t.end)
  }
  const first = tokens[group[0]]
  const last = tokens[group[group.length - 1]]
  const grew = out.length - text.length
  const span = { start: first.start, end: last.end + grew }
  return { text: out, caret: span.end, span }
}

// ---- pointing with the keyboard --------------------------------------------

// Where the pointed reference goes next. Shift extends from the anchor, as it
// does everywhere else in the grid; a bare arrow moves both, so the reference
// walks rather than grows.
//
// Clamped at the top and left edges only: a sheet grows downward and rightward
// on demand, so there is no far edge to stop at.
export function nextPoint(anchor, head, dr, dc, extend) {
  const h = { r: Math.max(0, head.r + dr), c: Math.max(0, head.c + dc) }
  return { anchor: extend ? anchor : h, head: h }
}

export const pointRect = (anchor, head) => ({
  r1: Math.min(anchor.r, head.r), c1: Math.min(anchor.c, head.c),
  r2: Math.max(anchor.r, head.r), c2: Math.max(anchor.c, head.c),
})
