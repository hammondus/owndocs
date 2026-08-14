// What changed between two states of a workbook.
//
// ── Why this is not the line diff ───────────────────────────────────────────
// A document is a sequence, so "what changed" is an alignment problem and the
// LCS in diff.js answers it. A sheet is not: it is a sparse map from cell to
// contents, and the interesting question is per cell, not per row. Running a
// line diff over a rendered grid would answer a question nobody asked, and
// answer it badly — one inserted row and every line below it reads as changed.
//
// ── Why by id, and why that is the whole point ──────────────────────────────
// Cells are stored under `<rowId>.<colId>` with ids that never move, which is
// the property the id-based grid was built for (see DESIGN-DECISIONS, *Grid
// identity*). So comparing the two cell maps by key is already correct about
// inserted and deleted rows: inserting a row above everything changes one key
// (the new row's) and leaves every other cell's key exactly as it was.
//
// Comparing by A1 position would do the opposite, and it is the obvious
// implementation: insert a row at the top and every cell beneath it appears to
// have changed, which is both wrong and the least useful possible answer.
// Positions are still *shown*, because A1 is how people speak about a sheet —
// but they are computed at the end, for labelling, and never compared.

import { Workbook } from './sheet/model.js'
import { colName } from './sheet/engine.js'

// Where a cell id sits in one particular state, via the model's own public
// id↔position API — `posOf` builds the index on demand and returns nulls for
// an id whose row or column is gone, which is an ordinary outcome here: a
// deleted cell has no position in the new version and a fresh one has none in
// the old.
function positionOf(model, rowId, colId) {
  const { r, c } = model.posOf(rowId, colId)
  if (r === null || c === null) return null
  return { r, c, a1: colName(c) + (r + 1) }
}

// The STORED text of a cell. This is what gets compared, and it matters that it
// is the stored form rather than the rendered one: a formula is stored with row
// and column *ids* in it, and `getInput` renders those back to current A1
// positions. Insert a row above a formula and its rendered text changes from
// `=A1+A2` to `=A2+A3` while the formula itself was never touched — so
// comparing rendered text would report an edit nobody made. Comparing the
// stored form is the same reason the cells are keyed by id at all.
//
// Matches the model's own reading of the map (`getRaw`), including its
// tolerance for a future `{v, …}` record.
function storedAt(model, key) {
  const v = model.cells.get(key)
  if (v === undefined || v === null) return undefined
  return typeof v === 'string' ? v : v?.v
}

// What to SHOW for that cell: the rendered form where the cell still has a
// position, so a formula reads as `=SUM(B2:B9)` rather than in its internal
// id form. Falls back to the stored text for a cell whose row or column is
// gone, where there is no position to render against.
function shownAt(model, pos, raw) {
  if (!pos) return raw ?? ''
  const shown = model.getInput(pos.r, pos.c)
  return shown === '' && raw !== undefined ? String(raw) : shown
}

const asText = (v) => (v === undefined || v === null ? '' : String(v))

// sheetChanges(fromDoc, toDoc) -> {sheets: [...], cellsChanged, sheetsAdded, sheetsRemoved}
//
// Each sheet entry is {id, name, added, removed, changed, cells: [...]}, and
// each cell is {rowId, colId, from, to, at, kind}. `at` is the A1 label in
// whichever version the cell exists in — the new one where it still does.
export function sheetChanges(fromDoc, toDoc, { limit = 500 } = {}) {
  const fromWb = new Workbook(fromDoc)
  const toWb = new Workbook(toDoc)

  const fromSheets = new Map(fromWb.list().map((s) => [s.id, s]))
  const toSheets = new Map(toWb.list().map((s) => [s.id, s]))
  const ids = [...new Set([...toSheets.keys(), ...fromSheets.keys()])]

  const sheets = []
  let cellsChanged = 0
  let truncated = false

  for (const id of ids) {
    const inFrom = fromSheets.has(id)
    const inTo = toSheets.has(id)
    // A sheet that exists in only one version still has its cells compared
    // against nothing, which reports every one of them — correct, and the
    // reason the header says whether the sheet itself came or went.
    const fromModel = inFrom ? fromWb.sheet(id) : null
    const toModel = inTo ? toWb.sheet(id) : null

    const keys = new Set()
    if (fromModel) for (const k of fromModel.cells.keys()) keys.add(k)
    if (toModel) for (const k of toModel.cells.keys()) keys.add(k)

    const cells = []
    for (const key of keys) {
      const before = fromModel ? storedAt(fromModel, key) : undefined
      const after = toModel ? storedAt(toModel, key) : undefined
      if (asText(before) === asText(after)) continue

      const [rowId, colId] = key.split('.')
      const posTo = toModel ? positionOf(toModel, rowId, colId) : null
      const posFrom = fromModel ? positionOf(fromModel, rowId, colId) : null
      // Named by where it is now, or where it was if it is gone — the only
      // place anyone could go and look for it.
      const pos = posTo || posFrom
      cells.push({
        rowId,
        colId,
        at: pos ? pos.a1 : null,
        from: fromModel ? shownAt(fromModel, posFrom, before) : '',
        to: toModel ? shownAt(toModel, posTo, after) : '',
        kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
      })
    }

    if (!cells.length && inFrom === inTo) continue

    // Sorted by position so the list reads down the sheet the way the grid
    // does. Cells whose row or column is gone have no position and go last,
    // in a stable order rather than whatever the map iteration gave.
    cells.sort((x, y) => {
      if (x.at === null || y.at === null) return (x.at === null ? 1 : 0) - (y.at === null ? 1 : 0)
      return sortKey(x.at).localeCompare(sortKey(y.at))
    })

    cellsChanged += cells.length
    if (cells.length > limit) truncated = true

    sheets.push({
      id,
      name: (toSheets.get(id) || fromSheets.get(id)).name,
      state: inFrom && inTo ? 'both' : inTo ? 'added' : 'removed',
      added: cells.filter((c) => c.kind === 'added').length,
      removed: cells.filter((c) => c.kind === 'removed').length,
      changed: cells.filter((c) => c.kind === 'changed').length,
      cells: cells.slice(0, limit),
    })
  }

  return {
    sheets,
    cellsChanged,
    truncated,
    identical: cellsChanged === 0 && sheets.length === 0,
  }
}

// "B12" sorts after "B9" only if the number is padded — plain string order puts
// row 12 before row 9, which looks like a bug in the diff rather than in the
// sort. Column letters are already fixed-width enough to compare directly.
function sortKey(a1) {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)
  if (!m) return a1
  return m[1].padStart(4, ' ') + m[2].padStart(9, '0')
}
