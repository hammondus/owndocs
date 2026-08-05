// The script API, implemented as a pure function over the workbook model.
//
// This is deliberately split from the sandbox that runs user code: the
// transport (an iframe and postMessage) needs a browser, but *what each
// call does* is ordinary model work and is tested headlessly. A future
// headless runner — the Go/Sobek one — implements the same call names
// against the same model and inherits the same behaviour for free.
//
// Every call is one transaction, so a script that writes a thousand cells
// produces one update on the wire and one undo step. The API shape pushes
// scripts that way: writes take a block of values, not a cell at a time.
import { colName, parseColName } from './engine.js'

// "A1", "A1:B10", "Sheet2!A1:B2" — the notation users already know from
// formulas, so a script and a formula name a range the same way.
const CELL_RE = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)$/

export function parseA1(text) {
  let s = String(text).trim()
  let sheet
  const bang = s.lastIndexOf('!')
  if (bang >= 0) {
    sheet = s.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'")
    s = s.slice(bang + 1)
  }
  const [a, b] = s.split(':')
  const first = CELL_RE.exec(a || '')
  if (!first) return null
  const start = { row: Number(first[2]) - 1, col: parseColName(first[1]) }
  if (b === undefined) return { sheet, r1: start.row, c1: start.col, r2: start.row, c2: start.col }
  const second = CELL_RE.exec(b)
  if (!second) return null
  const end = { row: Number(second[2]) - 1, col: parseColName(second[1]) }
  return {
    sheet,
    r1: Math.min(start.row, end.row), r2: Math.max(start.row, end.row),
    c1: Math.min(start.col, end.col), c2: Math.max(start.col, end.col),
  }
}

export const formatA1 = (r, c) => colName(c) + (r + 1)

class ScriptError extends Error {}

function resolveSheet(wb, rect, fallback) {
  const name = rect.sheet ?? fallback
  const m = name === undefined || name === null ? wb.sheet(wb.list()[0].id) : wb.sheetByName(name)
  if (!m) throw new ScriptError(`no sheet named ${JSON.stringify(name)}`)
  return m
}

function target(wb, args, what = 'range') {
  const rect = parseA1(args?.range ?? '')
  if (!rect) throw new ScriptError(`${what} must be in A1 notation, got ${JSON.stringify(args?.range)}`)
  return { m: resolveSheet(wb, rect, args?.sheet), rect }
}

// A 2D array of values, whatever the caller passed: a bare value becomes
// one cell, a flat array becomes one row.
function grid(values) {
  if (!Array.isArray(values)) return [[values]]
  if (!values.length) return []
  return Array.isArray(values[0]) ? values : [values]
}

// Guard against a script accidentally asking for the whole sheet: a
// runaway range would build a huge array and freeze the tab.
const MAX_CELLS = 200_000

export const METHODS = {
  sheets: (wb) => wb.list().map((s) => ({ id: s.id, name: s.name })),

  // Computed values — numbers as numbers — because that is what a script
  // wants to calculate with. getText gives the displayed strings instead.
  get(wb, args) {
    const { m, rect } = target(wb, args)
    return readRect(m, rect, (r, c) => {
      const v = m.getValue(r, c)
      return v !== null && typeof v === 'object' && 'error' in v ? v.error : v
    })
  },

  getText(wb, args) {
    const { m, rect } = target(wb, args)
    return readRect(m, rect, (r, c) => m.display(r, c).text)
  },

  getFormulas(wb, args) {
    const { m, rect } = target(wb, args)
    return readRect(m, rect, (r, c) => m.getInput(r, c))
  },

  // Values are committed exactly as if typed, so "$1,200" becomes currency
  // and "=SUM(A1:A2)" becomes a formula — one rule for humans and scripts.
  set(wb, args) {
    const { m, rect } = target(wb, args)
    const rows = grid(args?.values)
    if (!rows.length) return 0
    const cells = rows.length * rows[0].length
    if (cells > MAX_CELLS) throw new ScriptError(`too many cells in one write (${cells})`)
    m.tx(() => {
      for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < rows[i].length; j++) {
          const v = rows[i][j]
          m.setCell(rect.r1 + i, rect.c1 + j, v === null || v === undefined ? '' : String(v))
        }
      }
    })
    return rows.length * rows[0].length
  },

  setFormat(wb, args) {
    const { m, rect } = target(wb, args)
    if (!args?.format || typeof args.format !== 'object') {
      throw new ScriptError('format must be an object, e.g. {b:1} or {n:"cur"}')
    }
    m.setFormat(rect, args.format)
    return true
  },

  clear(wb, args) {
    const { m, rect } = target(wb, args)
    m.tx(() => {
      for (let r = rect.r1; r <= rect.r2; r++) {
        for (let c = rect.c1; c <= rect.c2; c++) m.setCell(r, c, '')
      }
    })
    return true
  },

  insertRows(wb, args) {
    const m = sheetByArg(wb, args)
    m.insertRows(Number(args?.at) || 0, Math.max(1, Number(args?.count) || 1))
    return true
  },

  deleteRows(wb, args) {
    const m = sheetByArg(wb, args)
    m.deleteRows(Number(args?.at) || 0, Math.max(1, Number(args?.count) || 1))
    return true
  },

  addSheet(wb, args) {
    return wb.addSheet(args?.name)
  },

  // The used rectangle, so a script can find the data without guessing.
  usedRange(wb, args) {
    const m = sheetByArg(wb, args)
    const rect = m.usedRect()
    if (!rect) return null
    return {
      range: `${formatA1(rect.r1, rect.c1)}:${formatA1(rect.r2, rect.c2)}`,
      rows: rect.r2 - rect.r1 + 1,
      cols: rect.c2 - rect.c1 + 1,
    }
  },
}

function sheetByArg(wb, args) {
  const name = args?.sheet
  const m = name === undefined || name === null ? wb.sheet(wb.list()[0].id) : wb.sheetByName(name)
  if (!m) throw new ScriptError(`no sheet named ${JSON.stringify(name)}`)
  return m
}

function readRect(m, rect, pick) {
  const cells = (rect.r2 - rect.r1 + 1) * (rect.c2 - rect.c1 + 1)
  if (cells > MAX_CELLS) throw new ScriptError(`range too large (${cells} cells)`)
  const out = []
  for (let r = rect.r1; r <= rect.r2; r++) {
    const row = []
    for (let c = rect.c1; c <= rect.c2; c++) row.push(pick(r, c))
    out.push(row)
  }
  return out
}

// Dispatch one call. Never throws: a script's mistake comes back as an
// error value it can catch, not as an exception in the host.
export function handleCall(wb, method, args) {
  const fn = METHODS[method]
  if (!fn) return { error: `unknown method ${JSON.stringify(method)}` }
  try {
    // Under the workbook's script origin, so on-edit triggers can tell a
    // script's writes from a person's and never drive themselves. Yjs
    // reuses the outermost transaction, so every nested write inherits it.
    return { value: wb.ydoc.transact(() => fn(wb, args), wb.scriptOrigin) }
  } catch (err) {
    return { error: err instanceof ScriptError ? err.message : String(err && err.message || err) }
  }
}
