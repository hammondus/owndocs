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
