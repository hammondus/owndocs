// Workbook + SheetModel: the Yjs mapping and recalculation layer. No DOM,
// no Svelte — the canvas grid is one consumer of this API; a chart or
// script bridge later is another. See DESIGN-DECISIONS.md "Sheets".
//
// Doc shape (all client-side convention; the server never reads it):
//   sheets:      Y.Array of sheet ids (order = tab order)
//   sheetNames:  Y.Map sheet id -> tab name
// and per sheet, with the FIRST sheet using the bare names so that every
// document written before tabs existed still opens with no migration:
//   rows  / s.<id>.rows   Y.Array of row ids (order = display order)
//   cols  / s.<id>.cols   Y.Array of col ids
//   cells / s.<id>.cells  Y.Map keyed "rowId.colId" -> raw input string
//   dims  / s.<id>.dims   Y.Map keyed "w.<colId>" / "h.<rowId>" -> px size
//   fmt   / s.<id>.fmt    Y.Map keyed "rowId.colId" (cell), "c.<colId>",
//                         "r.<rowId>" -> format record (see format.js)
//   objects / s.<id>.objects  Y.Map keyed object id -> chart spec
// Reserved for a later phase: scripts.
import * as Y from 'yjs'
import { parseFormula, mapRefs, collectRefs, serialize, evaluate, isErr, ERR, fmtNum } from './engine.js'
import { formatNumber, resolveFormat, mergeFormat, parseTypedNumber } from './format.js'
import { formatDate, isDateFormat } from './dates.js'

// Functions whose result is a date or time, and the format it should wear.
// Without this, =TODAY() would display as 46239 — technically correct and
// completely useless.
const DATE_RETURNING = {
  TODAY: 'date', DATE: 'date', EDATE: 'date', NOW: 'datetime', TIME: 'time',
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
function newId() {
  let s = ''
  for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(Math.random() * 36)]
  return s
}

export const DEFAULT_COL_W = 100
export const DEFAULT_ROW_H = 24

// The first sheet's containers are the bare top-level names. Nothing is
// migrated or copied when tabs arrive — the existing containers simply
// become sheet one, which also means no concurrent-migration hazard.
export const FIRST_SHEET = '1'

const ALIGN_NAMES = { l: 'left', c: 'center', r: 'right' }

export class Workbook {
  constructor(ydoc) {
    this.ydoc = ydoc
    this.sheetIds = ydoc.getArray('sheets')
    this.sheetNames = ydoc.getMap('sheetNames')
    this.models = new Map()
    this.listeners = new Set()

    // Caches live on the workbook, not the sheet: a formula may reach
    // across sheets, so one edit anywhere can change a value anywhere.
    this.valueCache = new Map() // "sheetId/rid.cid" -> computed value
    this.astCache = new Map()   // formula text -> AST (content-addressed)
    this.evaluating = new Set() // cells mid-evaluation, for cycle detection

    // One undo stack for the whole workbook — Cmd+Z should undo the user's
    // last action wherever it happened. Only LOCAL transactions (origin =
    // this workbook) are rewound, never a collaborator's concurrent work.
    // captureTimeout 0 because Yjs otherwise merges everything within 500ms
    // into one step: fine for typing prose, wrong for a spreadsheet, where
    // each cell entry, paste and fill is a discrete act.
    this.undo = new Y.UndoManager([this.sheetIds, this.sheetNames], {
      trackedOrigins: new Set([this]),
      captureTimeout: 0,
    })

    const changed = () => {
      this.valueCache.clear()
      this.notify()
    }
    this.sheetIds.observe(changed)
    this.sheetNames.observe(changed)
  }

  onChange(cb) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  notify() {
    for (const cb of this.listeners) cb()
  }

  tx(fn) {
    this.ydoc.transact(fn, this)
  }

  // The tab list. Duplicates are dropped rather than repaired: two clients
  // adding the second sheet at once each materialize the implicit first
  // one, so the array can legitimately contain it twice.
  list() {
    const seen = new Set()
    const out = []
    for (const id of this.sheetIds.toArray()) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, name: this.nameOf(id) })
    }
    if (out.length === 0) out.push({ id: FIRST_SHEET, name: this.nameOf(FIRST_SHEET) })
    return out
  }

  nameOf(id) {
    const n = this.sheetNames.get(id)
    if (typeof n === 'string' && n !== '') return n
    if (id === FIRST_SHEET) return 'Sheet1'
    const i = this.sheetIds.toArray().indexOf(id)
    return `Sheet${i < 0 ? '?' : i + 1}`
  }

  idByName(name) {
    const hit = this.list().find((s) => s.name.toLowerCase() === String(name).toLowerCase())
    return hit ? hit.id : null
  }

  sheet(id) {
    let m = this.models.get(id)
    if (!m) {
      m = new SheetModel(this, id)
      this.models.set(id, m)
    }
    return m
  }

  // The model for a stored sheet id, or null if that sheet is gone.
  sheetById(id) {
    return this.list().some((s) => s.id === id) ? this.sheet(id) : null
  }

  sheetByName(name) {
    const id = this.idByName(name)
    return id ? this.sheet(id) : null
  }

  addSheet(name) {
    const id = newId()
    this.tx(() => {
      // Materialize the implicit first sheet before appending a second, so
      // tab order is explicit from here on.
      if (this.sheetIds.length === 0) this.sheetIds.push([FIRST_SHEET])
      this.sheetIds.push([id])
      this.sheetNames.set(id, name || `Sheet${this.sheetIds.length}`)
    })
    return id
  }

  renameSheet(id, name) {
    name = String(name).trim()
    if (name === '') return
    this.tx(() => {
      if (this.sheetIds.length === 0) this.sheetIds.push([FIRST_SHEET])
      this.sheetNames.set(id, name)
    })
  }

  // Removing a sheet unlinks it from the tab order but leaves its
  // containers in the document: undo is then a one-entry insert rather than
  // a replay of every cell, and formulas pointing into it can come back to
  // life intact. Yjs keeps tombstones anyway, so deleting the cells would
  // not reclaim the space it appears to.
  // Replace this workbook's contents with another's, in ONE transaction —
  // the sheet equivalent of the document editor's "delete all, insert the
  // old text". Used by version-history restore, where `snapshot` is a
  // workbook rebuilt by replaying the update log to a past point.
  //
  // Row and column ids are replaced wholesale rather than reconciled, so
  // formulas stored against the historical ids resolve again exactly as
  // they did. Sheets that exist here but not in the snapshot are unlinked
  // from the tab order rather than emptied, matching removeSheet: undo
  // stays cheap and nothing is destroyed that a later restore might want.
  restoreFrom(snapshot) {
    // Every sheet either side knows about: the snapshot's sheets get their
    // contents back, and any sheet created since is left behind when the
    // tab order is replaced.
    const touched = new Set([
      ...snapshot.list().map((s) => s.id),
      ...this.list().map((s) => s.id),
    ])
    this.tx(() => {
      for (const id of touched) {
        const src = snapshot.sheet(id)
        const dst = this.sheet(id)
        copyArray(src.rows, dst.rows)
        copyArray(src.cols, dst.cols)
        copyMap(src.cells, dst.cells)
        copyMap(src.dims, dst.dims)
        copyMap(src.fmt, dst.fmt)
        copyMap(src.objects, dst.objects)
        dst._invalidate()
      }
      copyArray(snapshot.sheetIds, this.sheetIds)
      copyMap(snapshot.sheetNames, this.sheetNames)
      this.valueCache.clear()
    })
  }

  removeSheet(id) {
    const ids = this.list()
    if (ids.length <= 1) return false
    this.tx(() => {
      if (this.sheetIds.length === 0) {
        for (const s of ids) if (s.id !== id) this.sheetIds.push([s.id])
        return
      }
      for (let i = this.sheetIds.length - 1; i >= 0; i--) {
        if (this.sheetIds.get(i) === id) this.sheetIds.delete(i, 1)
      }
    })
    return true
  }
}

export class SheetModel {
  constructor(workbook, id = FIRST_SHEET) {
    this.wb = workbook
    this.id = id
    this.ydoc = workbook.ydoc
    const p = id === FIRST_SHEET ? '' : `s.${id}.`
    this.rows = this.ydoc.getArray(p + 'rows')
    this.cols = this.ydoc.getArray(p + 'cols')
    this.cells = this.ydoc.getMap(p + 'cells')
    this.dims = this.ydoc.getMap(p + 'dims')
    // Formatting is a SEPARATE map from cell contents on purpose: one
    // person bolding A1 while another types into A1 then touches two
    // different keys and both survive. Folding format into the cell value
    // would make last-writer-wins throw one of them away.
    this.fmt = this.ydoc.getMap(p + 'fmt')
    // Charts (and whatever floats over the grid later) keyed by object id.
    // A Map rather than an Array because concurrent inserts of different
    // ids never conflict, and nothing here needs an order.
    this.objects = this.ydoc.getMap(p + 'objects')
    this.indexesStale = true

    workbook.undo.addToScope([this.rows, this.cols, this.cells, this.dims, this.fmt, this.objects])

    const structural = () => { this._invalidate(); workbook.notify() }
    const contents = () => { this._invalidateValues(); workbook.notify() }
    this.rows.observe(structural)
    this.cols.observe(structural)
    this.cells.observe(contents)
    this.dims.observe(contents)
    // Formatting changes appearance, never a computed value, so there is
    // nothing to recompute — just repaint.
    this.fmt.observe(() => workbook.notify())
    this.objects.observe(() => workbook.notify())
  }

  get undo() { return this.wb.undo }
  get astCache() { return this.wb.astCache }
  get valueCache() { return this.wb.valueCache }
  get evaluating() { return this.wb.evaluating }

  // Cache keys are workbook-wide, so a cross-sheet reference and its target
  // can never collide.
  _key(rid, cid) { return `${this.id}/${rid}.${cid}` }

  // Drop the caches derived from doc state. Yjs fires observers only at the
  // END of a transaction, so a mutator that reads its own writes back (every
  // one of them below does — they need the ids they just created) must call
  // this itself. Relying on the observer alone silently wrote cells under an
  // "undefined.undefined" key; see the guard in setCell.
  //
  // Split in two because a cell write can't move an id: bulk writes (paste,
  // fill) would otherwise rebuild the whole id index once per cell.
  _invalidateValues() {
    this.valueCache.clear()
  }
  _invalidate() {
    this.valueCache.clear()
    this.indexesStale = true
  }

  // Fires on any change to ANY sheet, local or remote — a cross-sheet
  // formula makes them interdependent. v1 makes no attempt to say what
  // changed; consumers re-pull what they display (values are memoized, so
  // this is cheaper than it sounds). watchRange exists as the future-facing
  // name for chart/script consumers; today it has the same semantics.
  onChange(cb) {
    return this.wb.onChange(cb)
  }
  watchRange(_rect, cb) {
    return this.onChange(cb)
  }

  // Origin is the workbook, so one undo stack covers every sheet.
  tx(fn) {
    this.ydoc.transact(fn, this.wb)
  }

  // ---- id <-> position ----------------------------------------------------

  _index() {
    if (!this.indexesStale) return
    this.rowIds = this.rows.toArray()
    this.colIds = this.cols.toArray()
    this.rowPos = new Map(this.rowIds.map((id, i) => [id, i]))
    this.colPos = new Map(this.colIds.map((id, i) => [id, i]))
    this.indexesStale = false
  }

  rowCount() { return this.rows.length }
  colCount() { return this.cols.length }

  // Materialize row/col ids up to and including position (r, c). Appending
  // is the only way rows come into existence outside insertRow — see the
  // lazy-materialization note in the design doc.
  ensureSize(r, c) {
    if (r < this.rows.length && c < this.cols.length) return
    this.tx(() => {
      while (this.rows.length <= r) this.rows.push([newId()])
      while (this.cols.length <= c) this.cols.push([newId()])
    })
    this._invalidate()
  }

  // ---- formatting ---------------------------------------------------------

  // The record stored on this cell alone, ignoring row/column defaults.
  cellFormat(r, c) {
    this._index()
    const rid = this.rowIds[r], cid = this.colIds[c]
    if (!rid || !cid) return null
    return this.fmt.get(rid + '.' + cid) || null
  }

  // What the cell should actually look like: column default, then row
  // default, then the cell's own record.
  formatOf(r, c) {
    this._index()
    const rid = this.rowIds[r], cid = this.colIds[c]
    if (!rid || !cid) return null
    return resolveFormat(
      cid ? this.fmt.get('c.' + cid) : null,
      rid ? this.fmt.get('r.' + rid) : null,
      this.fmt.get(rid + '.' + cid),
    )
  }

  _patchKey(key, patch) {
    const next = mergeFormat(this.fmt.get(key), patch)
    if (next) this.fmt.set(key, next)
    else this.fmt.delete(key)
  }

  // Apply a format patch to every cell in a rect. A key set to null (or
  // false) is removed, which is how the toolbar toggles bold off.
  setFormat(rect, patch) {
    this.tx(() => {
      this.ensureSize(rect.r2, rect.c2)
      this._index()
      for (let r = rect.r1; r <= rect.r2; r++) {
        for (let c = rect.c1; c <= rect.c2; c++) {
          const rid = this.rowIds[r], cid = this.colIds[c]
          if (rid && cid) this._patchKey(rid + '.' + cid, patch)
        }
      }
    })
  }

  // Column and row defaults exist so that "format this column as currency"
  // is one entry that also covers rows nobody has created yet — writing a
  // record per cell would cover neither.
  setColFormat(c1, c2, patch) {
    this.tx(() => {
      this.ensureSize(0, c2)
      this._index()
      for (let c = c1; c <= c2; c++) {
        if (this.colIds[c]) this._patchKey('c.' + this.colIds[c], patch)
      }
    })
  }

  setRowFormat(r1, r2, patch) {
    this.tx(() => {
      this.ensureSize(r2, 0)
      this._index()
      for (let r = r1; r <= r2; r++) {
        if (this.rowIds[r]) this._patchKey('r.' + this.rowIds[r], patch)
      }
    })
  }

  // Strip formatting from a rect, including any row/column defaults that
  // fully cover it — otherwise "clear formatting" would visibly do nothing
  // on a cell whose look came from its column.
  clearFormat(rect) {
    this.tx(() => {
      this._index()
      for (let r = rect.r1; r <= rect.r2; r++) {
        const rid = this.rowIds[r]
        if (!rid) continue
        for (let c = rect.c1; c <= rect.c2; c++) {
          const cid = this.colIds[c]
          if (cid) this.fmt.delete(rid + '.' + cid)
        }
      }
      if (rect.r1 === 0 && rect.r2 >= this.rows.length - 1) {
        for (let c = rect.c1; c <= rect.c2; c++) {
          if (this.colIds[c]) this.fmt.delete('c.' + this.colIds[c])
        }
      }
      if (rect.c1 === 0 && rect.c2 >= this.cols.length - 1) {
        for (let r = rect.r1; r <= rect.r2; r++) {
          if (this.rowIds[r]) this.fmt.delete('r.' + this.rowIds[r])
        }
      }
    })
  }

  // ---- charts -------------------------------------------------------------

  charts() {
    return [...this.objects.values()].filter((o) => o && o.kind === 'chart')
  }

  // A chart's range is stored as row/column IDS, so inserting a row inside
  // it extends the chart and moving data around never silently re-points
  // it at the wrong cells — the same reason formulas store ids.
  addChart(rect, spec = {}) {
    this._index()
    const r1 = this.rowIds[rect.r1], r2 = this.rowIds[rect.r2]
    const c1 = this.colIds[rect.c1], c2 = this.colIds[rect.c2]
    if (!r1 || !r2 || !c1 || !c2) return null
    const id = newId()
    const chart = {
      kind: 'chart', id,
      type: spec.type || 'column',
      title: spec.title || '',
      headers: spec.headers !== false,
      range: { r1, c1, r2, c2 },
      x: spec.x ?? 40, y: spec.y ?? 40,
      w: spec.w ?? 420, h: spec.h ?? 260,
    }
    this.tx(() => this.objects.set(id, chart))
    return chart
  }

  updateChart(id, patch) {
    const cur = this.objects.get(id)
    if (!cur) return
    // Whole-object replace: per-chart last-writer-wins. Charts are edited
    // rarely and by one person at a time, so finer granularity would buy
    // nothing for the complexity.
    this.tx(() => this.objects.set(id, { ...cur, ...patch }))
  }

  removeChart(id) {
    this.tx(() => this.objects.delete(id))
  }

  // Current positions of a chart's range, or null if an endpoint's row or
  // column has been deleted outright.
  chartRect(chart) {
    this._index()
    const r1 = this.rowPos.get(chart.range.r1)
    const r2 = this.rowPos.get(chart.range.r2)
    const c1 = this.colPos.get(chart.range.c1)
    const c2 = this.colPos.get(chart.range.c2)
    if (r1 === undefined || r2 === undefined || c1 === undefined || c2 === undefined) return null
    return {
      r1: Math.min(r1, r2), r2: Math.max(r1, r2),
      c1: Math.min(c1, c2), c2: Math.max(c1, c2),
    }
  }

  // Called from deleteRows/deleteCols BEFORE the ids go, while positions
  // still resolve. Deleting a row in the middle of a charted range needs
  // no help — both endpoints survive — but deleting an endpoint would
  // strand the chart, so it re-anchors to the nearest survivor inside the
  // range instead.
  _reanchorCharts(deleted, axis) {
    const gone = new Set(deleted)
    for (const chart of this.charts()) {
      const rect = this.chartRect(chart)
      if (!rect) continue
      const ids = axis === 'row' ? this.rowIds : this.colIds
      const [lo, hi] = axis === 'row' ? [rect.r1, rect.r2] : [rect.c1, rect.c2]
      if (!gone.has(ids[lo]) && !gone.has(ids[hi])) continue
      let a = lo
      let b = hi
      while (a <= b && gone.has(ids[a])) a++
      while (b >= a && gone.has(ids[b])) b--
      if (a > b) continue // whole range deleted: leave it dangling and say so
      const range = { ...chart.range }
      if (axis === 'row') { range.r1 = ids[a]; range.r2 = ids[b] } else { range.c1 = ids[a]; range.c2 = ids[b] }
      this.objects.set(chart.id, { ...chart, range })
    }
  }

  // ---- cell input ---------------------------------------------------------

  getRaw(r, c) {
    this._index()
    const rid = this.rowIds[r], cid = this.colIds[c]
    if (!rid || !cid) return undefined
    const v = this.cells.get(rid + '.' + cid)
    return typeof v === 'string' ? v : v?.v // tolerate future {v, ...format} objects
  }

  // The text to show when editing: stored id-refs rendered back to current
  // A1 positions (a dead id renders #REF!, matching how it evaluates).
  getInput(r, c) {
    const raw = this.getRaw(r, c)
    if (raw === undefined) return ''
    if (!raw.startsWith('=')) {
      // A date is stored as its serial. Show it back as a date, or the
      // formula bar would read 46239 and editing would destroy it. Every
      // format this produces re-parses, so the round-trip is closed.
      const f = this.formatOf(r, c)
      if (f && isDateFormat(f.n)) {
        const n = Number(raw)
        if (Number.isFinite(n)) return formatDate(n, f.n) ?? raw
      }
      return raw
    }
    const ast = this._ast(raw.slice(1))
    if (ast === null) return raw // unparseable survives verbatim
    this._index()
    const toA1 = (ref) => {
      if (ref.kind !== 'id') return ref
      // A reference into another sheet resolves against that sheet's ids,
      // and dies with it if the tab was removed.
      const m = ref.sheet === undefined ? this : this.wb.sheetById(ref.sheet)
      if (!m) return { kind: 'dead' }
      m._index()
      const row = m.rowPos.get(ref.rid), col = m.colPos.get(ref.cid)
      if (row === undefined || col === undefined) return { kind: 'dead' }
      return {
        kind: 'a1', row, col,
        absRow: !!ref.absRow, absCol: !!ref.absCol,
        sheet: ref.sheet === undefined ? undefined : this.wb.nameOf(ref.sheet),
      }
    }
    return '=' + serialize(mapRefs(ast, toA1))
  }

  // Commit typed input. Formulas are parsed as A1 and stored with id refs;
  // everything else is stored verbatim. Refs beyond the materialized grid
  // materialize it (=Z100 on an empty sheet must mean something durable).
  setCell(r, c, text) {
    text = String(text)
    if (text === '') {
      this._index()
      const rid = this.rowIds[r], cid = this.colIds[c]
      if (rid && cid && this.cells.has(rid + '.' + cid)) {
        this.tx(() => this.cells.delete(rid + '.' + cid))
        this._invalidate()
      }
      return
    }
    this.tx(() => {
      let stored = text
      // "$1,234.50" and "12%" are numbers wearing punctuation. Store the
      // number and let the punctuation choose the format, as every
      // spreadsheet does — otherwise typing 12% would give you the string.
      if (!text.startsWith('=')) {
        const typed = parseTypedNumber(text)
        if (typed) {
          stored = String(typed.value)
          if (typed.fmt) {
            this.ensureSize(r, c)
            this._index()
            const rid = this.rowIds[r], cid = this.colIds[c]
            if (rid && cid) this._patchKey(rid + '.' + cid, typed.fmt)
          }
        }
      }
      if (text.startsWith('=')) {
        let ast = null
        try {
          ast = parseFormula(text.slice(1))
        } catch {
          // Committed anyway (collaborative editing can't refuse input the
          // way desktop Excel does); it evaluates to #ERROR!.
        }
        if (ast !== null) {
          // Every referenced sheet must be materialized far enough for the
          // reference to name real ids — including this one, and including
          // cells nobody has typed in yet (=Sheet2!Z100 has to mean
          // something durable even if Sheet2 is empty).
          const refs = collectRefs(ast)
          const extent = new Map([['', { r, c }]])
          for (const ref of [...refs.cells, ...refs.ranges.flat()]) {
            if (ref.kind !== 'a1') continue
            const key = ref.sheet === undefined ? '' : ref.sheet
            const cur = extent.get(key) || { r: -1, c: -1 }
            extent.set(key, { r: Math.max(cur.r, ref.row), c: Math.max(cur.c, ref.col) })
          }
          for (const [name, ext] of extent) {
            const m = name === '' ? this : this.wb.sheetByName(name)
            if (m && ext.r >= 0 && ext.c >= 0) m.ensureSize(ext.r, ext.c)
          }
          this._index()
          const toId = (ref) => {
            if (ref.kind !== 'a1') return ref
            const m = ref.sheet === undefined ? this : this.wb.sheetByName(ref.sheet)
            if (!m) return { kind: 'dead' } // no such tab
            m._index()
            const rid = m.rowIds[ref.row], cid = m.colIds[ref.col]
            if (!rid || !cid) return { kind: 'dead' }
            return {
              kind: 'id', rid, cid,
              absRow: !!ref.absRow, absCol: !!ref.absCol,
              // Stored by id, so renaming a tab never rewrites a formula.
              sheet: ref.sheet === undefined ? undefined : m.id,
            }
          }
          stored = '=' + serialize(mapRefs(ast, toId))

          // Give a date-producing formula a date format, unless the cell
          // already says otherwise. Same spirit as typed punctuation: the
          // input tells us how the result should read.
          const suggested = this._suggestedDateFormat(ast)
          if (suggested) {
            const own = this.fmt.get(this.rowIds[r] + '.' + this.colIds[c])
            if (!own || !own.n) {
              this._patchKey(this.rowIds[r] + '.' + this.colIds[c], { n: suggested })
            }
          }
        }
      }
      this.ensureSize(r, c)
      this._index()
      const rid = this.rowIds[r], cid = this.colIds[c]
      // Loud rather than silent: writing under an undefined id would store
      // the value where nothing ever reads it, and the edit would just
      // vanish from the grid.
      if (!rid || !cid) throw new Error(`setCell: cell ${r},${c} is not materialized`)
      this.cells.set(rid + '.' + cid, stored)
      this._invalidateValues()
    })
  }

  // Which date format, if any, a formula's result should wear:
  //   =TODAY(), =DATE(...)  the function says so
  //   =A1                   a bare reference inherits the date format
  //   =A1+7, =TODAY()+7     a date plus a count of days is still a date
  //   =B1-A1                NOT a date — the gap between two dates is a
  //                         number of days. Excel's habit of formatting
  //                         that as a date in 1900 is a well-known
  //                         annoyance, not something to copy, and the
  //                         rule that avoids it is simply "subtracting a
  //                         date from a date yields a number".
  _suggestedDateFormat(ast) {
    if (ast.n === 'call') return DATE_RETURNING[ast.fn] || null
    if (ast.n === 'ref' && ast.ref.kind === 'a1') {
      const m = ast.ref.sheet === undefined ? this : this.wb.sheetByName(ast.ref.sheet)
      if (!m) return null
      const f = m.formatOf(ast.ref.row, ast.ref.col)
      return f && isDateFormat(f.n) ? f.n : null
    }
    if (ast.n === 'bin' && (ast.op === '+' || ast.op === '-')) {
      const l = this._suggestedDateFormat(ast.l)
      const r = this._suggestedDateFormat(ast.r)
      if (ast.op === '-') return l && !r ? l : null
      return l || r
    }
    return null
  }

  // Store `input` — A1-notation text as produced by getInput — at (r,c),
  // shifting every RELATIVE reference by (dRow,dCol) first. This is the one
  // operation copy/paste and fill are built on: =A1 copied a row down
  // becomes =A2, while =$A$1 stays put. A reference pushed off the top or
  // left edge becomes #REF!, as everywhere else.
  setCellShifted(r, c, input, dRow, dCol) {
    if (typeof input !== 'string' || !input.startsWith('=') || (dRow === 0 && dCol === 0)) {
      return this.setCell(r, c, input ?? '')
    }
    const ast = this._ast(input.slice(1))
    if (ast === null) return this.setCell(r, c, input) // unparseable: copy verbatim
    const shifted = mapRefs(ast, (ref) => {
      if (ref.kind !== 'a1') return ref
      const row = ref.absRow ? ref.row : ref.row + dRow
      const col = ref.absCol ? ref.col : ref.col + dCol
      if (row < 0 || col < 0) return { kind: 'dead' }
      return { ...ref, row, col }
    })
    this.setCell(r, c, '=' + serialize(shifted))
  }

  // ---- rectangles ---------------------------------------------------------

  // The smallest rectangle holding every non-empty cell, or null when the
  // sheet is empty. Export uses it so a stray `=Z100` reference — which
  // materializes rows and columns — doesn't emit a hundred blank lines.
  usedRect() {
    this._index()
    let r2 = -1
    let c2 = -1
    for (const key of this.cells.keys()) {
      const dot = key.indexOf('.')
      const r = this.rowPos.get(key.slice(0, dot))
      const c = this.colPos.get(key.slice(dot + 1))
      if (r === undefined || c === undefined) continue // orphan from a delete
      if (r > r2) r2 = r
      if (c > c2) c2 = c
    }
    return r2 < 0 ? null : { r1: 0, c1: 0, r2, c2 }
  }

  // Every cell as displayed text, ready for CSV. Displayed rather than raw
  // so a date reads as a date and a total reads as its value — the point
  // of an export is to be readable and diffable elsewhere.
  toGrid() {
    const rect = this.usedRect()
    if (!rect) return []
    return this.readRect(rect.r1, rect.c1, rect.r2, rect.c2).values
  }

  // inputs = what to store on a copy (formulas, in A1 form); values = the
  // displayed text, which is what other applications expect on the clipboard.
  readRect(r1, c1, r2, c2) {
    const inputs = []
    const values = []
    const formats = []
    for (let r = r1; r <= r2; r++) {
      const irow = []
      const vrow = []
      const frow = []
      for (let c = c1; c <= c2; c++) {
        irow.push(this.getInput(r, c))
        vrow.push(this.display(r, c).text)
        // The RESOLVED format travels, so pasting a currency cell into a
        // plain column still looks like currency at the destination.
        frow.push(this.formatOf(r, c))
      }
      inputs.push(irow)
      values.push(vrow)
      formats.push(frow)
    }
    return { inputs, values, formats }
  }

  // Write a block at (r,c), repeating it to cover `rows` x `cols` when the
  // target area is larger (paste into a bigger selection, as in Sheets).
  // origin = where the block was copied from, or null for foreign data with
  // no references to translate. clear = a rect emptied first, for cut.
  writeRect(r, c, inputs, { rows, cols, origin = null, clear = null, formats = null } = {}) {
    const h = inputs.length
    const w = h ? inputs[0].length : 0
    if (!h || !w) return
    const nr = Math.max(rows || 0, h)
    const nc = Math.max(cols || 0, w)
    this.tx(() => {
      // Clearing first matters: a cut region that overlaps the destination
      // must not wipe what we are about to write into it.
      if (clear) {
        for (let rr = clear.r1; rr <= clear.r2; rr++) {
          for (let cc = clear.c1; cc <= clear.c2; cc++) this.setCell(rr, cc, '')
        }
      }
      for (let i = 0; i < nr; i++) {
        for (let j = 0; j < nc; j++) {
          const si = i % h
          const sj = j % w
          const dRow = origin ? r + i - (origin.r + si) : 0
          const dCol = origin ? c + j - (origin.c + sj) : 0
          this.setCellShifted(r + i, c + j, inputs[si][sj], dRow, dCol)
          if (formats) this._setCellFormat(r + i, c + j, formats[si]?.[sj] || null)
        }
      }
    })
  }

  // Replace a cell's own format record outright (paste and fill carry
  // formatting with the content, as every spreadsheet does).
  _setCellFormat(r, c, fmt) {
    this.ensureSize(r, c)
    this._index()
    const rid = this.rowIds[r], cid = this.colIds[c]
    if (!rid || !cid) return
    if (fmt && Object.keys(fmt).length) this.fmt.set(rid + '.' + cid, { ...fmt })
    else this.fmt.delete(rid + '.' + cid)
  }

  // ---- fill ---------------------------------------------------------------

  // Extend `src` over `dest` (which contains src and grows it along one
  // axis). A line of two or more plain numbers with a constant step
  // extrapolates as a series; anything else repeats, with formulas
  // translated relative to the cell each one came from.
  fill(src, dest) {
    const down = dest.r2 > src.r2
    const up = dest.r1 < src.r1
    const right = dest.c2 > src.c2
    const left = dest.c1 < src.c1
    this.tx(() => {
      if (down || up) {
        for (let c = src.c1; c <= src.c2; c++) {
          const line = []
          for (let r = src.r1; r <= src.r2; r++) line.push([r, c])
          const targets = []
          if (down) for (let r = src.r2 + 1; r <= dest.r2; r++) targets.push([r, c])
          if (up) for (let r = src.r1 - 1; r >= dest.r1; r--) targets.push([r, c])
          this._fillLine(line, targets, down)
        }
      }
      if (right || left) {
        for (let r = src.r1; r <= src.r2; r++) {
          const line = []
          for (let c = src.c1; c <= src.c2; c++) line.push([r, c])
          const targets = []
          if (right) for (let c = src.c2 + 1; c <= dest.c2; c++) targets.push([r, c])
          if (left) for (let c = src.c1 - 1; c >= dest.c1; c--) targets.push([r, c])
          this._fillLine(line, targets, right)
        }
      }
    })
  }

  // targets are ordered nearest-first; forward = extending past the end of
  // the source rather than before its start.
  _fillLine(srcCells, targets, forward) {
    if (targets.length === 0) return
    const inputs = srcCells.map(([r, c]) => this.getInput(r, c))
    // Series detection reads the STORED text, not the displayed input: a
    // date shows as "05/08/2026" but is stored as a serial, and it is the
    // serial that extrapolates. This is what makes dragging two
    // consecutive dates continue the run.
    const nums = srcCells.map(([r, c]) => numericLiteral(this.getRaw(r, c)))

    // A single number copies rather than counting — matching Excel and
    // Sheets, where 1 dragged down gives 1,1,1 and 1,2 gives 3,4,5.
    let step = null
    if (nums.length >= 2 && nums.every((n) => n !== null)) {
      step = nums[1] - nums[0]
      for (let i = 2; i < nums.length; i++) {
        if (Math.abs(nums[i] - nums[i - 1] - step) > 1e-9) { step = null; break }
      }
    }

    // Formatting travels with a fill: dragging a currency cell down must
    // give currency cells, not bare numbers.
    const formats = srcCells.map(([r, c]) => this.cellFormat(r, c))

    targets.forEach(([tr, tc], k) => {
      const idx = forward
        ? k % inputs.length
        : inputs.length - 1 - (k % inputs.length)
      if (step !== null) {
        const base = forward ? nums[nums.length - 1] : nums[0]
        const v = forward ? base + step * (k + 1) : base - step * (k + 1)
        this.setCell(tr, tc, fmtNum(v))
      } else {
        const [sr, sc] = srcCells[idx]
        this.setCellShifted(tr, tc, inputs[idx], tr - sr, tc - sc)
      }
      this._setCellFormat(tr, tc, formats[idx])
    })
  }

  // ---- evaluation ---------------------------------------------------------

  _ast(src) {
    if (this.astCache.has(src)) return this.astCache.get(src)
    let ast = null
    try {
      ast = parseFormula(src)
    } catch {
      ast = null
    }
    this.astCache.set(src, ast)
    return ast
  }

  getValue(r, c) {
    this._index()
    const rid = this.rowIds[r], cid = this.colIds[c]
    if (!rid || !cid) return null
    return this._valueById(rid, cid)
  }

  _valueById(rid, cid) {
    const key = this._key(rid, cid)
    if (this.valueCache.has(key)) return this.valueCache.get(key)
    // The in-progress set is workbook-wide, so a cycle that runs out to
    // another sheet and back is caught just like a local one.
    if (this.evaluating.has(key)) return ERR('#CYCLE!')
    const stored = this.cells.get(rid + '.' + cid)
    const raw = typeof stored === 'string' ? stored : stored?.v
    let value
    if (raw === undefined) {
      value = null
    } else if (raw.startsWith('=')) {
      const ast = this._ast(raw.slice(1))
      if (ast === null) {
        value = ERR('#ERROR!')
      } else {
        this.evaluating.add(key)
        value = evaluate(ast, this._ctx())
        this.evaluating.delete(key)
      }
    } else {
      value = literalValue(raw)
    }
    this.valueCache.set(key, value)
    return value
  }

  // The sheet a stored reference points into: this one unless it names
  // another, and null if that sheet has since been removed.
  _target(ref) {
    const m = ref.sheet === undefined ? this : this.wb.sheetById(ref.sheet)
    if (m) m._index() // the position maps below are read straight after
    return m
  }

  _ctx() {
    return {
      refValue: (ref) => {
        const m = this._target(ref)
        if (!m) return ERR('#REF!')
        if (m.rowPos.get(ref.rid) === undefined || m.colPos.get(ref.cid) === undefined) {
          return ERR('#REF!')
        }
        return m._valueById(ref.rid, ref.cid)
      },
      rangeValues: (a, b) => {
        const m = this._target(a)
        if (!m) return ERR('#REF!')
        const r1 = m.rowPos.get(a.rid), c1 = m.colPos.get(a.cid)
        const r2 = m.rowPos.get(b.rid), c2 = m.colPos.get(b.cid)
        if (r1 === undefined || c1 === undefined || r2 === undefined || c2 === undefined) {
          return ERR('#REF!')
        }
        const out = []
        for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
          for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
            out.push(m._valueById(m.rowIds[r], m.colIds[c]))
          }
        }
        return out
      },
    }
  }

  // What the grid paints: display text, alignment and the resolved format.
  // Alignment defaults by type (numbers right, text left — the convention
  // every spreadsheet user reads by) and an explicit format overrides it.
  display(r, c) {
    const v = this.getValue(r, c)
    const f = this.formatOf(r, c)
    const out = (text, align) => ({
      text,
      align: f && f.a ? ALIGN_NAMES[f.a] || align : align,
      fmt: f,
    })
    if (v === null) return out('', 'left')
    if (isErr(v)) return out(v.error, 'center')
    if (typeof v === 'number') return out(formatNumber(v, f) ?? fmtNum(v), 'right')
    if (typeof v === 'boolean') return out(v ? 'TRUE' : 'FALSE', 'center')
    return out(v, 'left')
  }

  // ---- structure ----------------------------------------------------------

  insertRows(at, n = 1) {
    this.tx(() => {
      this.ensureSize(at - 1, 0)
      this.rows.insert(Math.min(at, this.rows.length), Array.from({ length: n }, newId))
    })
    this._invalidate()
  }

  insertCols(at, n = 1) {
    this.tx(() => {
      this.ensureSize(0, at - 1)
      this.cols.insert(Math.min(at, this.cols.length), Array.from({ length: n }, newId))
    })
    this._invalidate()
  }

  deleteRows(at, n = 1) {
    this._index()
    const ids = this.rowIds.slice(at, at + n)
    if (ids.length === 0) return
    this.tx(() => {
      this._reanchorCharts(ids, 'row')
      this.rows.delete(at, ids.length)
      // Delete the row's cells too: without this they'd sit as orphans and,
      // worse, resurrect if a same-position row were ever re-created.
      for (const key of [...this.cells.keys()]) {
        if (ids.includes(key.split('.')[0])) this.cells.delete(key)
      }
      for (const key of [...this.fmt.keys()]) {
        if (ids.includes(key.split('.')[0])) this.fmt.delete(key)
      }
      for (const id of ids) {
        this.dims.delete('h.' + id)
        this.fmt.delete('r.' + id)
      }
    })
    this._invalidate()
  }

  deleteCols(at, n = 1) {
    this._index()
    const ids = this.colIds.slice(at, at + n)
    if (ids.length === 0) return
    this.tx(() => {
      this._reanchorCharts(ids, 'col')
      this.cols.delete(at, ids.length)
      for (const key of [...this.cells.keys()]) {
        if (ids.includes(key.split('.')[1])) this.cells.delete(key)
      }
      for (const key of [...this.fmt.keys()]) {
        if (ids.includes(key.split('.')[1])) this.fmt.delete(key)
      }
      for (const id of ids) {
        this.dims.delete('w.' + id)
        this.fmt.delete('c.' + id)
      }
    })
    this._invalidate()
  }

  // ---- dimensions ---------------------------------------------------------

  colWidth(c) {
    this._index()
    const cid = this.colIds[c]
    return (cid && this.dims.get('w.' + cid)) || DEFAULT_COL_W
  }

  rowHeight(r) {
    this._index()
    const rid = this.rowIds[r]
    return (rid && this.dims.get('h.' + rid)) || DEFAULT_ROW_H
  }

  setColWidth(c, px) {
    this.ensureSize(0, c)
    this._index()
    this.tx(() => this.dims.set('w.' + this.colIds[c], Math.max(24, Math.round(px))))
  }
}

// Both copiers skip work when the contents already match, so restoring to
// the state you are already in writes nothing at all — a no-op restore
// should not appear in history or travel over the wire.
function copyArray(src, dst) {
  const a = src.toArray()
  const b = dst.toArray()
  if (a.length === b.length && a.every((v, i) => v === b[i])) return
  dst.delete(0, dst.length)
  dst.insert(0, a)
}

// Set every key the source has and drop the ones it doesn't, rather than
// clear-then-fill: a key whose value is unchanged then produces no
// operation at all, which keeps a restore's update small.
function copyMap(src, dst) {
  for (const k of [...dst.keys()]) if (!src.has(k)) dst.delete(k)
  for (const [k, v] of src.entries()) {
    if (JSON.stringify(dst.get(k)) !== JSON.stringify(v)) dst.set(k, v)
  }
}

// The number a cell's INPUT plainly is, or null. Formulas and
// apostrophe-forced text never count, so a column of results doesn't get
// extrapolated as if it were a typed-in series.
function numericLiteral(input) {
  if (typeof input !== 'string') return null
  const t = input.trim()
  if (t === '' || t.startsWith('=') || t.startsWith("'")) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

// A literal cell: numbers and TRUE/FALSE become typed values; a leading
// apostrophe forces text ('123 shows as 123 but stays a string).
function literalValue(raw) {
  if (raw.startsWith("'")) return raw.slice(1)
  const t = raw.trim()
  if (t === 'TRUE') return true
  if (t === 'FALSE') return false
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t)
  return raw
}
