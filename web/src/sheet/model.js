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
//   lock  / s.<id>.lock   Y.Map: the key "protected" holds the sheet flag,
//                         and every other key is keyed like fmt and marks an
//                         UNLOCKED exception (see *Sheet protection*)
//   objects / s.<id>.objects  Y.Map keyed object id -> chart spec
// and workbook-level:
//   scripts:     Y.Map keyed script id -> {id, name, code}
import * as Y from 'yjs'
import { parseFormula, mapRefs, collectRefs, serialize, evaluate, isErr, ERR, fmtNum, colName } from './engine.js'
import { formatNumber, resolveFormat, mergeFormat, parseTypedNumber } from './format.js'
import { isDec, parseDec, fromNumber, decToNumber, decToString, decAdd, decCmp, decDiv } from './exact.js'
import { formatDate, isDateFormat } from './dates.js'

// Functions whose result is a date or time, and the format it should wear.
// Without this, =TODAY() would display as 46239 — technically correct and
// completely useless.
const DATE_RETURNING = {
  TODAY: 'date', DATE: 'date', EDATE: 'date', NOW: 'datetime', TIME: 'time',
}

// Functions whose result is in the same units as their input, so a total
// under a currency column is itself currency. COUNT, COUNTA and DAYS are
// absent on purpose: they return counts, not amounts.
const AGGREGATES = new Set(['SUM', 'AVERAGE', 'MIN', 'MAX', 'ROUND', 'ABS'])

// A cap on how many cells a range is inspected for a common format. This
// runs on every formula commit and the answer is usually decided by the
// first cell or two.
const RANGE_FORMAT_SCAN_LIMIT = 400

// Text that is already a plain number and so needs no normalising on the
// way into storage. Deliberately narrower than what parseTypedNumber
// accepts: anything with a currency symbol, a percent sign or thousands
// separators has to be rewritten, because the stored cell holds the number
// and the punctuation becomes format.
const BARE_NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

// Only the number format (and its currency symbol) travels through a
// formula; bold, colour and alignment stay with the cells they were
// applied to.
function numberFormatOf(f) {
  if (!f || !f.n) return null
  return f.cur ? { n: f.n, cur: f.cur } : { n: f.n }
}

const sameNumberFormat = (a, b) => a.n === b.n && (a.cur || '') === (b.cur || '')

// A1 names for refusal messages. "B4 is protected" sends you to the cell;
// "the sheet is protected" sends you looking for which part of it.
const cellName = (r, c) => colName(c) + (r + 1)
const rectName = (rect) =>
  rect.r1 === rect.r2 && rect.c1 === rect.c2
    ? cellName(rect.r1, rect.c1)
    : `${cellName(rect.r1, rect.c1)}:${cellName(rect.r2, rect.c2)}`

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
function newId() {
  let s = ''
  for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(Math.random() * 36)]
  return s
}

// Thrown by every mutator that refuses because a sheet is protected. A throw
// rather than a silent no-op, and that is the whole design: this codebase has
// three incidents about a control that looked like it worked and did nothing,
// and a mutator that quietly declines is the same failure with the evidence
// removed. The UI asks `canWrite` first and explains, so in normal use nothing
// ever throws; if one does, a call site was missed and it says so out loud.
//
// The script API needs no special handling — the sandbox already turns a thrown
// error into a message the script author reads.
export class ProtectedError extends Error {
  constructor(what) {
    super(`${what} is protected`)
    this.name = 'ProtectedError'
  }
}

// The flag's key inside the lock map. It cannot collide with an exception key:
// those are "<rowId>.<colId>", "r.<rowId>" or "c.<colId>" and so always contain
// a dot, and `newId` draws from lowercase alphanumerics only.
const PROTECTED_KEY = 'protected'

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
    // Scripts live IN the document, so they are shared, versioned and
    // git-exported by the same machinery as everything else. Workbook
    // level rather than per sheet: a script routinely spans tabs.
    this.scripts = ydoc.getMap('scripts')
    this.models = new Map()
    this.listeners = new Set()
    // Everything a script writes carries this origin instead of the
    // workbook's. That is what stops a trigger from re-triggering itself:
    // the dispatcher ignores it. Yjs reuses the outermost transaction's
    // origin for nested ones, so wrapping a whole API call is enough.
    this.scriptOrigin = Symbol('script')
    // "Edit protected cells": the deliberate, visible, temporary override.
    // Deliberately NOT in the document — it is what *this person* may do right
    // now, not a property of the sheet, and one collaborator turning it on must
    // not turn it on for everybody. It resets to false on every reload for the
    // same reason: an override you have forgotten about is the permanent
    // invisible bypass this feature was designed to avoid.
    //
    // Workbook-level rather than per sheet, because the toggle is one control
    // on one document view and a formula reaches across tabs.
    this.overrideProtection = false
    this.editListeners = new Set()
    this._pendingEdit = null
    this._editTimer = 0

    // Caches live on the workbook, not the sheet: a formula may reach
    // across sheets, so one edit anywhere can change a value anywhere.
    this.valueCache = new Map() // "sheetId/rid.cid" -> computed value
    // Keyed like valueCache and invalidated with it. Separate map rather
    // than a field on the value because it is asked for by the paint loop
    // on every frame and answered for far fewer cells than are evaluated.
    this.lossyCache = new Map() // "sheetId/rid.cid" -> {typed, shown} | null
    this.astCache = new Map()   // formula text -> AST (content-addressed)
    this.evaluating = new Set() // cells mid-evaluation, for cycle detection

    // One undo stack for the whole workbook — Cmd+Z should undo the user's
    // last action wherever it happened. Only LOCAL transactions (origin =
    // this workbook) are rewound, never a collaborator's concurrent work.
    // captureTimeout 0 because Yjs otherwise merges everything within 500ms
    // into one step: fine for typing prose, wrong for a spreadsheet, where
    // each cell entry, paste and fill is a discrete act.
    this.undo = new Y.UndoManager([this.sheetIds, this.sheetNames, this.scripts], {
      // The script origin is tracked too, so what a script does is as
      // undoable as what a person does.
      trackedOrigins: new Set([this, this.scriptOrigin]),
      captureTimeout: 0,
    })

    const changed = () => {
      this.valueCache.clear()
      this.lossyCache.clear()
      this.notify()
    }
    this.sheetIds.observe(changed)
    this.sheetNames.observe(changed)
    this.scripts.observe(() => this.notify())
  }

  onChange(cb) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  // Fires for cell edits made BY THIS CLIENT and not by a script. Both
  // conditions matter: if every client ran the trigger for a change, the
  // effect would be applied once per open browser, and if a script's own
  // writes counted, an on-edit trigger would drive itself forever.
  onLocalEdit(cb) {
    this.editListeners.add(cb)
    return () => this.editListeners.delete(cb)
  }

  // Called by each sheet's cell observer. Coalesced on a short timer so a
  // burst of edits produces one trigger run rather than a stampede.
  _noteEdit(sheetId, keys, transaction, delay = 200) {
    if (!transaction.local || transaction.origin === this.scriptOrigin) return
    if (!this.editListeners.size || !keys.length) return
    if (!this._pendingEdit || this._pendingEdit.sheetId !== sheetId) {
      this._flushEdit()
      this._pendingEdit = { sheetId, keys: [] }
    }
    // Appended, never spread. `push(...keys)` passes one argument per key, and
    // a paste is one transaction — so a 400k-cell paste spread 400k arguments
    // into a call and overflowed the stack, taking the sheet down with it.
    // Only when a trigger listener is registered, which is why it never showed
    // up in a headless test.
    for (const k of keys) this._pendingEdit.keys.push(k)
    clearTimeout(this._editTimer)
    this._editTimer = setTimeout(() => this._flushEdit(), delay)
  }

  _flushEdit() {
    const pending = this._pendingEdit
    this._pendingEdit = null
    clearTimeout(this._editTimer)
    if (!pending) return
    for (const cb of this.editListeners) cb(pending)
  }

  notify() {
    for (const cb of this.listeners) cb()
  }

  tx(fn) {
    this.ydoc.transact(fn, this)
  }

  // ---- protection ---------------------------------------------------------

  // Turning the override on or off is itself a checkpoint, for the same reason
  // protecting a sheet is — see `_lockChanged`.
  setOverrideProtection(on) {
    on = !!on
    if (on === this.overrideProtection) return
    this.overrideProtection = on
    this.undo.clear()
    this.notify()
  }

  // Whether any sheet in the workbook is protected. What `restoreFrom` and
  // `removeSheet` ask, since both act on a sheet wholesale.
  anyProtected() {
    if (this.overrideProtection) return false
    return this.list().some((s) => this.sheet(s.id).isProtected())
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

  // ---- scripts ------------------------------------------------------------

  listScripts() {
    return [...this.scripts.values()]
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  addScript(name, code = '') {
    const id = newId()
    const script = { id, name: name || 'Untitled script', code }
    this.tx(() => this.scripts.set(id, script))
    return script
  }

  updateScript(id, patch) {
    const cur = this.scripts.get(id)
    if (!cur) return
    this.tx(() => this.scripts.set(id, { ...cur, ...patch }))
  }

  removeScript(id) {
    this.tx(() => this.scripts.delete(id))
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
    // A restore is a wholesale replace, so it would go straight through any
    // per-cell check that is not on its path — which is exactly what this is.
    // Refused if ANY sheet is protected, not just the ones the snapshot
    // touches: a restore also replaces the tab order, so a protected sheet can
    // be unlinked by a restore that never writes a cell of it.
    if (this.anyProtected()) throw new ProtectedError('this workbook')
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
        // Exactness travels with the cells it applies to. Left out, a
        // restore would silently return every marked cell to doubles and
        // change what the document computes — the one failure this whole
        // feature exists to prevent.
        copyMap(src.exact, dst.exact)
        // Protection travels with the cells it applies to, by the same
        // argument as exactness: restoring a sheet to a point before it was
        // protected must actually unprotect it, or the restored inputs are
        // locked against the person who just restored them.
        copyMap(src.lock, dst.lock)
        copyMap(src.objects, dst.objects)
        dst._invalidate()
      }
      copyArray(snapshot.sheetIds, this.sheetIds)
      copyMap(snapshot.sheetNames, this.sheetNames)
      this.valueCache.clear()
      this.lossyCache.clear()
    })
    // A restore can *introduce* protection — the snapshot may be from a point
    // when a sheet was protected — and it gets there by copying the lock map
    // wholesale, so `setProtected` never runs and the checkpoint it would have
    // made never happens. Without this, the stack from before the restore
    // survives and could be rewound into cells that are protected now.
    //
    // Only when the result is protected, so an ordinary restore stays a single
    // undoable step, which is what the history view promises.
    if (this.anyProtected()) this.undo.clear()
  }

  removeSheet(id) {
    const ids = this.list()
    if (ids.length <= 1) return false
    // The structural argument at sheet scale: unlinking a protected sheet takes
    // every protected cell on it out of the tab order at once, and there is no
    // useful sense in which that is allowed when editing one of them is not.
    if (!this.overrideProtection && this.sheet(id).isProtected()) {
      throw new ProtectedError(this.nameOf(id))
    }
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
    // Which cells compute exactly. Keyed exactly like fmt (cell, then
    // 'r.<rowId>' / 'c.<colId>' defaults), so "make this column exact" is
    // one entry — but a map of its own rather than a key inside fmt,
    // because precision changes the VALUE and formatting never does.
    // Folding it in would put "clear formatting" in a position to silently
    // change what a column adds up to.
    this.exact = this.ydoc.getMap(p + 'exact')
    // Which cells may be written while the sheet is protected, plus the
    // protection flag itself under PROTECTED_KEY. Keyed exactly like fmt and
    // exact, so "these two columns are the inputs" is two entries.
    //
    // The map holds the *exceptions*, and the default is locked — Excel's shape
    // and the right way round for the sheets that asked for this, which are
    // mostly formulas with a short list of inputs. See DESIGN-DECISIONS.md,
    // *Sheet protection*.
    this.lock = this.ydoc.getMap(p + 'lock')
    // Charts (and whatever floats over the grid later) keyed by object id.
    // A Map rather than an Array because concurrent inserts of different
    // ids never conflict, and nothing here needs an order.
    this.objects = this.ydoc.getMap(p + 'objects')
    this.indexesStale = true

    // `lock` is deliberately absent from the undo scope. Protection is not an
    // edit, it is a checkpoint on edits — and an undo that could unprotect a
    // sheet would be a way through the guard rather than a thing the guard
    // covers. Changing it clears the stack instead; see `_lockChanged`.
    workbook.undo.addToScope([this.rows, this.cols, this.cells, this.dims, this.fmt, this.exact, this.objects])

    const structural = () => { this._invalidate(); workbook.notify() }
    const contents = () => { this._invalidateValues(); workbook.notify() }
    this.rows.observe(structural)
    this.cols.observe(structural)
    this.cells.observe((event, transaction) => {
      contents()
      workbook._noteEdit(this.id, [...event.keys.keys()], transaction)
    })
    this.dims.observe(contents)
    // Formatting changes appearance, never a computed value, so there is
    // nothing to recompute — just repaint.
    this.fmt.observe(() => workbook.notify())
    // Unlike fmt, this one DOES change values: a cell that starts
    // computing exactly has a different result to recompute, and so does
    // everything downstream of it.
    this.exact.observe(contents)
    // Protection changes what may be written and how a cell is tinted, never
    // what anything computes — so this is a repaint, like fmt, not a recompute.
    this.lock.observe(() => workbook.notify())
    this.objects.observe(() => workbook.notify())
  }

  get undo() { return this.wb.undo }
  get astCache() { return this.wb.astCache }
  get valueCache() { return this.wb.valueCache }
  get lossyCache() { return this.wb.lossyCache }
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
    this.lossyCache.clear()
  }
  _invalidate() {
    this.valueCache.clear()
    this.lossyCache.clear()
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

  // The public face of the id/position index. `rowIds`, `colIds`, `rowPos`
  // and `colPos` do not exist until _index() has run, so reading them from
  // outside is a TypeError waiting for a model nobody has drawn yet — which
  // is every sheet on a tab you have not opened. Callers outside this file
  // use these two and never touch the maps.
  //
  // Both return nulls rather than throwing: an id whose row or column has
  // been deleted is an ordinary outcome for anything holding an id over
  // time, which is exactly what comment anchors do.
  idsAt(r, c) {
    this._index()
    return { row: this.rowIds[r] || null, col: this.colIds[c] || null }
  }

  posOf(rowId, colId) {
    this._index()
    const r = this.rowPos.get(rowId)
    const c = this.colPos.get(colId)
    return { r: r === undefined ? null : r, c: c === undefined ? null : c }
  }

  // Materialize row/col ids up to and including position (r, c). Appending
  // is the only way rows come into existence outside insertRow — see the
  // lazy-materialization note in the design doc.
  // Grow the materialized grid to reach (r, c).
  //
  // One insert per axis, not one per row. `Y.Array.push` takes an array, and a
  // push-per-row is a separate CRDT insert each — 10,000 of them to materialize
  // 10,000 rows, where one will do.
  //
  // The bigger cost this used to carry is in the *callers*: growing invalidates
  // the index, so a loop that grows the sheet one row at a time makes the next
  // `setCell` rebuild the whole index, which is O(rows²) across a paste. Bulk
  // writers call this once up front for that reason — see `writeRect`.
  ensureSize(r, c) {
    if (r < this.rows.length && c < this.cols.length) return
    this.tx(() => {
      const rows = r + 1 - this.rows.length
      if (rows > 0) this.rows.push(Array.from({ length: rows }, () => newId()))
      const cols = c + 1 - this.cols.length
      if (cols > 0) this.cols.push(Array.from({ length: cols }, () => newId()))
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

  // ---- exact arithmetic ---------------------------------------------------

  // Cell over row over column, the same precedence formats use, so one
  // cell can opt out of an otherwise exact column.
  isExact(r, c) {
    this._index()
    const rid = this.rowIds[r], cid = this.colIds[c]
    if (rid && cid) return this._isExactById(rid, cid)
    // Past the materialised grid there is no cell record to consult, but a
    // column default still describes what a cell created there will do —
    // and the toolbar asks about the selection before anything is typed.
    return cid ? !!this.exact.get('c.' + cid) : false
  }

  // An explicit false on the cell has to beat an inherited true, so this
  // tests for presence rather than truthiness at each level.
  _isExactById(rid, cid) {
    const own = this.exact.get(rid + '.' + cid)
    if (own !== undefined) return !!own
    const row = this.exact.get('r.' + rid)
    if (row !== undefined) return !!row
    return !!this.exact.get('c.' + cid)
  }

  // `on` is true, false, or null to clear the entry entirely and fall back
  // to whatever the row or column says. Stored as 1/0 rather than
  // true/false to keep the wire payload small — every marked cell crosses
  // it, and this map is written far less often than it is read.
  _setExactKey(key, on) {
    if (on === null || on === undefined) this.exact.delete(key)
    else this.exact.set(key, on ? 1 : 0)
  }

  setExact(rect, on) {
    this._guardRect(rect)
    this.tx(() => {
      this.ensureSize(rect.r2, rect.c2)
      this._index()
      for (let r = rect.r1; r <= rect.r2; r++) {
        for (let c = rect.c1; c <= rect.c2; c++) {
          const rid = this.rowIds[r], cid = this.colIds[c]
          if (rid && cid) this._setExactKey(rid + '.' + cid, on)
        }
      }
    })
  }

  setColExact(c1, c2, on) {
    this._guardCols(c1, c2)
    this.tx(() => {
      this.ensureSize(0, c2)
      this._index()
      for (let c = c1; c <= c2; c++) {
        if (this.colIds[c]) this._setExactKey('c.' + this.colIds[c], on)
      }
    })
  }

  setRowExact(r1, r2, on) {
    this._guardRows(r1, r2)
    this.tx(() => {
      this.ensureSize(r2, 0)
      this._index()
      for (let r = r1; r <= r2; r++) {
        if (this.rowIds[r]) this._setExactKey('r.' + this.rowIds[r], on)
      }
    })
  }

  // ---- protection ---------------------------------------------------------
  //
  // Not a security boundary, and it must never be described as one. `ws.go`
  // checks the role on a document write and then stores opaque bytes; the
  // server never looks inside an update, so it cannot tell which cells one
  // touched. Anyone with editor access and a browser console can write whatever
  // they like. What is real and server-enforced is that a viewer or commenter
  // cannot write at all. This layer stops the accident, and an accident is not
  // committed through devtools.

  isProtected() {
    return !!this.lock.get(PROTECTED_KEY)
  }

  // Neither this nor the setUnlocked family is guarded, and that is deliberate
  // rather than an omission: these ARE the protection. A guard that covered
  // them would be a lock with the key inside it, and there would be no way to
  // turn protection off. What gates them is role — manager and above — which
  // lives in the UI, because there is no server-side place to put it for the
  // same reason the rest of this is client-side.
  setProtected(on) {
    on = !!on
    if (on === this.isProtected()) return
    this.tx(() => {
      if (on) this.lock.set(PROTECTED_KEY, 1)
      else this.lock.delete(PROTECTED_KEY)
    })
    this._lockChanged()
  }

  // Cell over row over column, the same precedence formats and exactness use,
  // so one cell can be locked inside an otherwise unlocked column.
  isUnlocked(r, c) {
    this._index()
    const rid = this.rowIds[r], cid = this.colIds[c]
    if (rid && cid) return this._isUnlockedById(rid, cid)
    // Past the materialised grid there is no cell record to consult, but a row
    // or column default still describes what a cell created there will be —
    // and a paste routinely lands beyond the last materialised row.
    if (rid) {
      const row = this.lock.get('r.' + rid)
      if (row !== undefined) return !!row
    }
    return cid ? !!this.lock.get('c.' + cid) : false
  }

  // An explicit false on the cell has to beat an inherited true, so this tests
  // for presence rather than truthiness at each level — a cell can be locked
  // back inside an unlocked column.
  _isUnlockedById(rid, cid) {
    const own = this.lock.get(rid + '.' + cid)
    if (own !== undefined) return !!own
    const row = this.lock.get('r.' + rid)
    if (row !== undefined) return !!row
    return !!this.lock.get('c.' + cid)
  }

  // `on` is true, false, or null to clear the entry and fall back to whatever
  // the row or column says. Stored as 1/0 like `exact`, to keep the payload
  // small — every marked cell crosses the wire.
  _setLockKey(key, on) {
    if (on === null || on === undefined) this.lock.delete(key)
    else this.lock.set(key, on ? 1 : 0)
  }

  setUnlocked(rect, on) {
    this.tx(() => {
      this.ensureSize(rect.r2, rect.c2)
      this._index()
      for (let r = rect.r1; r <= rect.r2; r++) {
        for (let c = rect.c1; c <= rect.c2; c++) {
          const rid = this.rowIds[r], cid = this.colIds[c]
          if (rid && cid) this._setLockKey(rid + '.' + cid, on)
        }
      }
    })
    this._lockChanged()
  }

  setColUnlocked(c1, c2, on) {
    this.tx(() => {
      this.ensureSize(0, c2)
      this._index()
      for (let c = c1; c <= c2; c++) {
        if (this.colIds[c]) this._setLockKey('c.' + this.colIds[c], on)
      }
    })
    this._lockChanged()
  }

  setRowUnlocked(r1, r2, on) {
    this.tx(() => {
      this.ensureSize(r2, 0)
      this._index()
      for (let r = r1; r <= r2; r++) {
        if (this.rowIds[r]) this._setLockKey('r.' + this.rowIds[r], on)
      }
    })
    this._lockChanged()
  }

  // Any change to what is protected clears the undo stack, and this is the
  // answer to "an undo that restores a protected cell is a write to one".
  //
  // The guard cannot reach an undo: `Y.UndoManager` reverts a StackItem
  // straight onto the Yjs types, so no model method runs and there is nowhere
  // to put a check. Inspecting a stack item is not a way out either — it holds
  // DeleteSets keyed by client, not the cell keys a check would need.
  //
  // Clearing closes the hole completely instead of narrowing it: an entry can
  // only have been created by a mutator that was allowed at the time, so if the
  // rules have not changed since, no entry can write anywhere it should not.
  // Changing the rules is exactly when we clear.
  //
  // The cost, stated because it is real: the stack is workbook-wide, so
  // protecting one sheet drops undo history for edits made to another. That is
  // the price of an airtight answer over a partial one, and protecting a sheet
  // is a deliberate act at a natural stopping point.
  _lockChanged() {
    this.wb.undo.clear()
  }

  // ---- the guard ----------------------------------------------------------
  //
  // Every public mutator that writes cell content, formatting, exactness or a
  // chart consults one of these. `sheet_test.mjs` enumerates the prototype and
  // fails on any public method it cannot find in either the guarded list or the
  // exempt one, so the next mutator added has to be classified rather than
  // quietly let through.

  // Whether this sheet accepts writes at all. Everything else is a refinement.
  _unguarded() {
    return this.wb.overrideProtection || !this.isProtected()
  }

  canWrite(r, c) {
    return this._unguarded() || this.isUnlocked(r, c)
  }

  // A rect is writable only if every cell in it is. Cheap in the case that
  // matters: on a protected sheet the default is locked, so the first cell
  // usually decides it, and on an unprotected sheet there is no scan at all.
  canWriteRect(rect) {
    if (this._unguarded()) return true
    for (let r = rect.r1; r <= rect.r2; r++) {
      for (let c = rect.c1; c <= rect.c2; c++) {
        if (!this.isUnlocked(r, c)) return false
      }
    }
    return true
  }

  // What is governed by the sheet rather than by any one cell: structural
  // row/column work, and charts.
  //
  // Inserting or deleting a row takes protected cells with it — or shifts them
  // out from under the formulas that name them — so structural work is blocked
  // outright while the sheet is protected, unlocked exceptions notwithstanding.
  // A chart is an overlay: it reads a data range and writes to none of it, so
  // guarding it against that range would describe the wrong relationship. It
  // belongs to the sheet, and the sheet's flag is what decides.
  //
  // The override lifts both: with "edit protected cells" on you have said you
  // know what you are doing, and refusing then would be a rule with no reason
  // left behind it.
  canRestructure() {
    return this._unguarded()
  }

  // The three throwing forms. `what` names the cell or range in the message,
  // because "the sheet is protected" sends you looking for which part of it.
  _guardCell(r, c) {
    if (!this.canWrite(r, c)) throw new ProtectedError(cellName(r, c))
  }

  _guardRect(rect) {
    if (!this.canWriteRect(rect)) throw new ProtectedError(rectName(rect))
  }

  _guardSheet() {
    if (!this.canRestructure()) throw new ProtectedError(this.wb.nameOf(this.id))
  }

  // Column and row defaults reach every cell in the span, including rows nobody
  // has created yet, so the whole materialised extent has to be writable.
  _guardCols(c1, c2) {
    this._guardRect({ r1: 0, c1, r2: Math.max(0, this.rows.length - 1), c2 })
  }

  _guardRows(r1, r2) {
    this._guardRect({ r1, c1: 0, r2, c2: Math.max(0, this.cols.length - 1) })
  }

  // ---- precision warnings -------------------------------------------------

  // Opt-in exactness leaves one bad failure mode: you find out a cell needed
  // it by noticing a wrong digit, which means not noticing is the default.
  // This closes that, and closes it with an answer rather than a rule of
  // thumb — commit stores a bare literal exactly as typed, so the digits are
  // still here to compare against what a double made of them.
  //
  // Returns null, or {typed, shown}. The pair rather than a boolean because
  // every caller that says anything useful wants to say both.
  //
  // Literals only, deliberately. A formula can drift too, but proving it
  // takes a second evaluation of the whole dependency graph — see
  // DESIGN-DECISIONS. This is the case that costs one comparison, and in
  // practice it is the case that bites: long identifiers and account
  // numbers, which arrive as typed values and are wrong on arrival.
  lossyLiteral(r, c) {
    this._index()
    const rid = this.rowIds[r], cid = this.colIds[c]
    if (!rid || !cid) return null
    const key = this._key(rid, cid)
    if (this.lossyCache.has(key)) return this.lossyCache.get(key)
    const v = this._lossyById(rid, cid)
    this.lossyCache.set(key, v)
    return v
  }

  _lossyById(rid, cid) {
    // An exact cell has nothing to warn about: it is already keeping the
    // digits. That is what makes the marker a to-do list — it clears the
    // moment the offer is taken up.
    if (this._isExactById(rid, cid)) return null
    const stored = this.cells.get(rid + '.' + cid)
    const raw = typeof stored === 'string' ? stored : stored?.v
    // Formulas are out of scope, and a leading apostrophe means the cell is
    // text however numeric it looks.
    if (raw === undefined || raw.startsWith('=') || raw.startsWith("'")) return null
    const typed = raw.trim()
    const exact = parseDec(typed)
    // parseDec rejects what is not a plain decimal literal, which covers
    // both text cells and the numbers commit rewrote (a currency or percent
    // entry, where the stored form is already the double's own digits and
    // the comparison would be vacuous).
    if (!exact) return null
    const asDouble = fromNumber(Number(typed))
    if (!asDouble || decCmp(exact, asDouble) === 0) return null
    return { typed, shown: decToString(asDouble) }
  }

  _patchKey(key, patch) {
    const next = mergeFormat(this.fmt.get(key), patch)
    if (next) this.fmt.set(key, next)
    else this.fmt.delete(key)
  }

  // Apply a format patch to every cell in a rect. A key set to null (or
  // false) is removed, which is how the toolbar toggles bold off.
  setFormat(rect, patch) {
    this._guardRect(rect)
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
    this._guardCols(c1, c2)
    this.tx(() => {
      this.ensureSize(0, c2)
      this._index()
      for (let c = c1; c <= c2; c++) {
        if (this.colIds[c]) this._patchKey('c.' + this.colIds[c], patch)
      }
    })
  }

  setRowFormat(r1, r2, patch) {
    this._guardRows(r1, r2)
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
    this._guardRect(rect)
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
    this._guardSheet()
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
    this._guardSheet()
    const cur = this.objects.get(id)
    if (!cur) return
    // Whole-object replace: per-chart last-writer-wins. Charts are edited
    // rarely and by one person at a time, so finer granularity would buy
    // nothing for the complexity.
    this.tx(() => this.objects.set(id, { ...cur, ...patch }))
  }

  removeChart(id) {
    this._guardSheet()
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
    this._guardCell(r, c)
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
          // Only text that carried punctuation is re-serialised from the
          // parsed number — there the stored form has to *be* the number,
          // since the punctuation has moved into the format. A bare
          // literal is stored exactly as typed.
          //
          // Storing String(value) unconditionally rewrote input it had no
          // reason to touch: 1234.50 came back as 1234.5, and any integer
          // past 2^53 was replaced by the nearest double, so the document
          // itself held digits the user never typed. Keeping the literal
          // costs nothing today (the value is Number(raw) either way) and
          // is what makes exact arithmetic possible to switch on later:
          // the digits are still there to reinterpret.
          stored = BARE_NUMBER.test(text.trim()) ? text.trim() : String(typed.value)
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

          // Let the formula's inputs choose how its result reads, unless
          // the cell already says otherwise. Same spirit as typed
          // punctuation: the input tells us what the value means.
          const suggested = this._suggestedFormat(ast)
          if (suggested) {
            const key = this.rowIds[r] + '.' + this.colIds[c]
            const own = this.fmt.get(key)
            if (!own || !own.n) this._patchKey(key, suggested)
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

  // What number format, if any, a formula's result should inherit from its
  // inputs. Without this a total under a currency column reads 15.5 while
  // every cell above it reads $10.00, which looks broken.
  //
  // Only the NUMBER format travels — never bold, colour or alignment.
  // Those are presentation the user applied to particular cells; the
  // number format is closer to a unit, and units are what a calculation
  // actually carries forward.
  //
  //   =TODAY(), =DATE(...)  the function says so
  //   =A1                   a bare reference inherits
  //   =SUM(C2:C9)           an aggregate inherits from its range
  //   =A1+7                 adding to a formatted value keeps the format
  //   =B1-A1 (both dates)   NOT a date: the gap between two dates is a
  //                         count of days. Excel shows that as a date in
  //                         1900, which is a famous annoyance, not
  //                         something to copy.
  //   =C2*D2                currency times a plain count is currency, but
  //                         two formatted operands make units that no
  //                         single format describes, so nothing is
  //                         inherited. Percent is the exception: it is
  //                         dimensionless, so currency times percent is
  //                         still currency.
  _suggestedFormat(ast) {
    switch (ast.n) {
      case 'call': {
        const d = DATE_RETURNING[ast.fn]
        if (d) return { n: d }
        // The result of an aggregate is in the same units as its data.
        // COUNT and DAYS are deliberately absent: they return counts.
        if (!AGGREGATES.has(ast.fn) || !ast.args.length) return null
        return this._suggestedFormat(ast.args[0])
      }
      case 'ref': return numberFormatOf(this._refTarget(ast.ref))
      case 'range': return this._rangeFormat(ast.a, ast.b)
      case 'un': case 'pct': return this._suggestedFormat(ast.e)
      case 'bin': {
        const { op } = ast
        if (!'+-*/'.includes(op) || op.length !== 1) return null
        const l = this._suggestedFormat(ast.l)
        const r = this._suggestedFormat(ast.r)
        if (!l || !r) return l || r
        if (op === '+' || op === '-') {
          if (op === '-' && isDateFormat(l.n) && isDateFormat(r.n)) return null
          return sameNumberFormat(l, r) ? l : null
        }
        if (l.n === 'pct') return r // a percentage is a multiplier, not a unit
        if (r.n === 'pct') return l
        return null
      }
      default: return null
    }
  }

  // The resolved format of the cell an A1 reference points at, following
  // the reference into another sheet when it names one.
  _refTarget(ref) {
    if (ref.kind !== 'a1') return null
    const m = ref.sheet === undefined ? this : this.wb.sheetByName(ref.sheet)
    return m ? m.formatOf(ref.row, ref.col) : null
  }

  // The number format a rectangle agrees on, or null when its cells disagree
  // or none of them carries one. Scans a bounded number of cells: this runs on
  // every formula commit, and one disagreement anywhere is enough to give up.
  //
  // Public because two callers ask the same question, and they must not answer
  // it differently: formula inference (`=SUM` over a currency column produces
  // currency) and the selection readout (which prints that sum in the bar). One
  // rule, so the bar and the formula it stands in for agree about what the
  // answer is denominated in — the same doctrine the readout already follows
  // for *which cells count*.
  //
  // Deliberately unclamped: the caller decides what rectangle it means. The
  // readout passes the clamped one, so a whole-column selection is measured by
  // what is in it rather than by the view's padding rows; formula inference
  // passes the literal range.
  rectFormat(rect) {
    this._index()
    let found = null
    let seen = 0
    for (let r = rect.r1; r <= rect.r2; r++) {
      for (let c = rect.c1; c <= rect.c2; c++) {
        if (++seen > RANGE_FORMAT_SCAN_LIMIT) return found
        const f = numberFormatOf(this.formatOf(r, c))
        if (!f) continue
        if (!found) found = f
        else if (!sameNumberFormat(found, f)) return null
      }
    }
    return found
  }

  _rangeFormat(a, b) {
    if (a.kind !== 'a1' || b.kind !== 'a1') return null
    const m = a.sheet === undefined ? this : this.wb.sheetByName(a.sheet)
    if (!m) return null
    return m.rectFormat({
      r1: Math.min(a.row, b.row), r2: Math.max(a.row, b.row),
      c1: Math.min(a.col, b.col), c2: Math.max(a.col, b.col),
    })
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
    // Guarded against the region actually written, which is not the argument:
    // `rows`/`cols` can tile the block out past the values supplied, and
    // `clear` wipes a separate rect. Both are writes, so both are checked, and
    // checked BEFORE the transaction opens so a refusal leaves nothing half
    // applied.
    this._guardRect({ r1: r, c1: c, r2: r + nr - 1, c2: c + nc - 1 })
    if (clear) this._guardRect(clear)
    this.tx(() => {
      // Grow once for the whole rectangle before writing anything. Without
      // this, `setCell` grows the sheet a row at a time and each growth
      // invalidates the index that the next `setCell` rebuilds — quadratic in
      // the number of rows pasted, and measurably so: 500k cells took 26s this
      // way and 1.1s pre-sized.
      this.ensureSize(r + nr - 1, c + nc - 1)
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
    // Only the part of `dest` outside `src` is written — the source cells are
    // read. Guarding the whole of `dest` would refuse the ordinary case of
    // dragging a locked formula down into unlocked rows, which is a thing this
    // feature exists to *allow*.
    if (!this._unguarded()) {
      const inSrc = (r, c) => r >= src.r1 && r <= src.r2 && c >= src.c1 && c <= src.c2
      for (let r = dest.r1; r <= dest.r2; r++) {
        for (let c = dest.c1; c <= dest.c2; c++) {
          if (!inSrc(r, c) && !this.isUnlocked(r, c)) throw new ProtectedError(cellName(r, c))
        }
      }
    }
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
      value = literalValue(raw, this._isExactById(rid, cid))
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
    if (typeof v === 'number' || isDec(v)) return out(formatNumber(v, f) ?? fmtNum(v), 'right')
    if (typeof v === 'boolean') return out(v ? 'TRUE' : 'FALSE', 'center')
    return out(v, 'left')
  }

  // Aggregates over a rectangle, for the selection readout at the bottom of
  // the grid. Two rules, both borrowed rather than invented:
  //
  //   - the numeric four (sum/avg/min/max) count only real numbers, which is
  //     the engine's rule for a *range* argument (numbersIn: text, booleans
  //     and errors are skipped). So the readout agrees with =SUM(A1:B9)
  //     typed into a cell — if it didn't, one of the two would be a bug
  //     report waiting to happen.
  //   - `count` is COUNTA's rule: every non-empty cell, whatever is in it.
  //
  // `numeric` is returned alongside so the caller can say why the two differ,
  // and `errors` so a readout can admit that it skipped something broken
  // rather than quietly totalling around it.
  //
  // The rect is clamped to the materialized grid: a whole-column selection
  // spans the padding rows the view draws past the data, and scanning those
  // is pure work for a guaranteed null.
  stats(rect) {
    const r1 = Math.max(rect.r1, 0), c1 = Math.max(rect.c1, 0)
    const r2 = Math.min(rect.r2, this.rowCount() - 1)
    const c2 = Math.min(rect.c2, this.colCount() - 1)
    // min/max start as null rather than ±Infinity because the winner is
    // now returned as it was stored — an exact value must survive being
    // the smallest, and comparing a Dec against Infinity has no meaning.
    let count = 0, errors = 0, numeric = 0, sum = 0, min = null, max = null
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const v = this.getValue(r, c)
        if (v === null) continue
        count++
        if (isErr(v)) { errors++; continue }
        if (typeof v !== 'number' && !isDec(v)) continue
        numeric++
        sum = addValues(sum, v)
        if (min === null || cmpValues(v, min) < 0) min = v
        if (max === null || cmpValues(v, max) > 0) max = v
      }
    }
    return {
      count, errors, numeric,
      // What the block is denominated in, so the readout can print a column of
      // currency totals as currency rather than as a bare number. Computed on
      // the *clamped* rect, which is why it is returned from here rather than
      // asked for separately: the caller would have to re-derive the same
      // bounds to get the same answer.
      format: numeric ? this.rectFormat({ r1, c1, r2, c2 }) : null,
      // Null, not 0, when the rect holds no numbers: "no answer" and "the
      // answer is zero" have to look different to whoever renders this.
      // (=SUM over a text-only range is 0; a readout showing "Sum 0" for a
      // column of names would be worse than showing nothing.)
      sum: numeric ? sum : null,
      avg: numeric ? (isDec(sum) ? decDiv(sum, fromNumber(numeric)) : sum / numeric) : null,
      min: numeric ? min : null,
      max: numeric ? max : null,
    }
  }

  // ---- structure ----------------------------------------------------------

  insertRows(at, n = 1) {
    this._guardSheet()
    this.tx(() => {
      this.ensureSize(at - 1, 0)
      this.rows.insert(Math.min(at, this.rows.length), Array.from({ length: n }, newId))
    })
    this._invalidate()
  }

  insertCols(at, n = 1) {
    this._guardSheet()
    this.tx(() => {
      this.ensureSize(0, at - 1)
      this.cols.insert(Math.min(at, this.cols.length), Array.from({ length: n }, newId))
    })
    this._invalidate()
  }

  deleteRows(at, n = 1) {
    this._guardSheet()
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
      // Unlocked exceptions go with the cells they named. Left behind, they
      // would be dead keys that a new row reusing the id — ids are random, so
      // never in practice — could inherit. The real reason is smaller and
      // certain: the map is what the tint is drawn from, and a growing pile of
      // keys for rows that no longer exist crosses the wire on every sync.
      for (const key of [...this.lock.keys()]) {
        if (ids.includes(key.split('.')[0])) this.lock.delete(key)
      }
      for (const id of ids) {
        this.dims.delete('h.' + id)
        this.fmt.delete('r.' + id)
        this.lock.delete('r.' + id)
      }
    })
    this._invalidate()
  }

  deleteCols(at, n = 1) {
    this._guardSheet()
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
      for (const key of [...this.lock.keys()]) {
        if (ids.includes(key.split('.')[1])) this.lock.delete(key)
      }
      for (const id of ids) {
        this.dims.delete('w.' + id)
        this.fmt.delete('c.' + id)
        this.lock.delete('c.' + id)
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
// The selection readout has to agree with =SUM over the same range — if it
// didn't, one of the two would be a bug report waiting to happen — so it
// follows the engine's promotion rule: one exact value makes the running
// total exact. Folded as it goes rather than collected first, because a
// selection can cover a great many cells.
const asDec = (v) => (isDec(v) ? v : fromNumber(v))
const asDouble = (v) => (isDec(v) ? decToNumber(v) : v)

function addValues(a, b) {
  if (isDec(a) || isDec(b)) {
    const x = asDec(a), y = asDec(b)
    if (x && y) return decAdd(x, y)
  }
  return asDouble(a) + asDouble(b)
}

function cmpValues(a, b) {
  if (isDec(a) || isDec(b)) {
    const x = asDec(a), y = asDec(b)
    if (x && y) return decCmp(x, y)
  }
  const p = asDouble(a), q = asDouble(b)
  return p < q ? -1 : p > q ? 1 : 0
}

function literalValue(raw, exact) {
  if (raw.startsWith("'")) return raw.slice(1)
  const t = raw.trim()
  if (t === 'TRUE') return true
  if (t === 'FALSE') return false
  if (t !== '' && !Number.isNaN(Number(t))) {
    // In an exact cell the stored text IS the value: parsed straight to a
    // decimal, never through a double. This is the whole point of keeping
    // the typed literal at commit — the digits are still here to read.
    // parseDec is stricter than Number (no 0x10, no Infinity), so an
    // oddity it rejects still falls through to the ordinary path.
    if (exact) {
      const d = parseDec(t)
      if (d) return d
    }
    return Number(t)
  }
  return raw
}
