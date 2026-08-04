// SheetModel: the Yjs mapping and recalculation layer. No DOM, no Svelte —
// the canvas grid is one consumer of this API; a chart or script bridge
// later is another. See DESIGN-DECISIONS.md "Sheets".
//
// Doc shape (all client-side convention; the server never reads it):
//   rows:  Y.Array of row ids (order = display order)
//   cols:  Y.Array of col ids
//   cells: Y.Map keyed "rowId.colId" -> raw input string
//   dims:  Y.Map keyed "w.<colId>" / "h.<rowId>" -> px size
// Reserved for later phases: objects (charts), scripts.
import * as Y from 'yjs'
import { parseFormula, mapRefs, collectRefs, serialize, evaluate, isErr, ERR, fmtNum } from './engine.js'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
function newId() {
  let s = ''
  for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(Math.random() * 36)]
  return s
}

export const DEFAULT_COL_W = 100
export const DEFAULT_ROW_H = 24

export class SheetModel {
  constructor(ydoc) {
    this.ydoc = ydoc
    this.rows = ydoc.getArray('rows')
    this.cols = ydoc.getArray('cols')
    this.cells = ydoc.getMap('cells')
    this.dims = ydoc.getMap('dims')
    this.listeners = new Set()
    this.valueCache = new Map() // "rid.cid" -> computed value, cleared on ANY change
    this.astCache = new Map()   // raw formula text -> parsed AST (content-addressed)
    this.evaluating = new Set() // cells mid-evaluation, for cycle detection
    this.indexesStale = true

    // Undo only rewinds LOCAL transactions (origin = this model), never a
    // collaborator's concurrent work — standard Yjs collaborative undo.
    this.undo = new Y.UndoManager([this.rows, this.cols, this.cells, this.dims], {
      trackedOrigins: new Set([this]),
    })

    const changed = () => {
      this._invalidate()
      for (const cb of this.listeners) cb()
    }
    this.rows.observe(changed)
    this.cols.observe(changed)
    this.cells.observe(changed)
    this.dims.observe(changed)
  }

  // Drop the caches derived from doc state. Yjs fires observers only at the
  // END of a transaction, so a mutator that reads its own writes back (every
  // one of them below does — they need the ids they just created) must call
  // this itself. Relying on the observer alone silently wrote cells under an
  // "undefined.undefined" key; see the guard in setCell.
  _invalidate() {
    this.valueCache.clear()
    this.indexesStale = true
  }

  // Fires on any change, local or remote. v1 makes no attempt to say WHAT
  // changed — consumers re-pull what they display (values are memoized, so
  // this is cheaper than it sounds). watchRange exists as the future-facing
  // name for chart/script consumers; today it has the same semantics.
  onChange(cb) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  watchRange(_rect, cb) {
    return this.onChange(cb)
  }

  tx(fn) {
    this.ydoc.transact(fn, this)
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
    if (!raw.startsWith('=')) return raw
    const ast = this._ast(raw.slice(1))
    if (ast === null) return raw // unparseable survives verbatim
    this._index()
    const toA1 = (ref) => {
      if (ref.kind !== 'id') return ref
      const row = this.rowPos.get(ref.rid), col = this.colPos.get(ref.cid)
      if (row === undefined || col === undefined) return { kind: 'dead' }
      return { kind: 'a1', row, col, absRow: false, absCol: false }
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
      if (text.startsWith('=')) {
        let ast = null
        try {
          ast = parseFormula(text.slice(1))
        } catch {
          // Committed anyway (collaborative editing can't refuse input the
          // way desktop Excel does); it evaluates to #ERROR!.
        }
        if (ast !== null) {
          const refs = collectRefs(ast)
          let maxR = r, maxC = c
          for (const ref of [...refs.cells, ...refs.ranges.flat()]) {
            if (ref.kind === 'a1') {
              maxR = Math.max(maxR, ref.row)
              maxC = Math.max(maxC, ref.col)
            }
          }
          this.ensureSize(maxR, maxC)
          this._index()
          const toId = (ref) => {
            if (ref.kind !== 'a1') return ref
            return { kind: 'id', rid: this.rowIds[ref.row], cid: this.colIds[ref.col] }
          }
          stored = '=' + serialize(mapRefs(ast, toId))
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
      this._invalidate()
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
    return this._valueByKey(rid + '.' + cid)
  }

  _valueByKey(key) {
    if (this.valueCache.has(key)) return this.valueCache.get(key)
    if (this.evaluating.has(key)) return ERR('#CYCLE!')
    const stored = this.cells.get(key)
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

  _ctx() {
    return {
      refValue: (ref) => {
        if (this.rowPos.get(ref.rid) === undefined || this.colPos.get(ref.cid) === undefined) {
          return ERR('#REF!')
        }
        return this._valueByKey(ref.rid + '.' + ref.cid)
      },
      rangeValues: (a, b) => {
        const r1 = this.rowPos.get(a.rid), c1 = this.colPos.get(a.cid)
        const r2 = this.rowPos.get(b.rid), c2 = this.colPos.get(b.cid)
        if (r1 === undefined || c1 === undefined || r2 === undefined || c2 === undefined) {
          return ERR('#REF!')
        }
        const out = []
        for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
          for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
            out.push(this._valueByKey(this.rowIds[r] + '.' + this.colIds[c]))
          }
        }
        return out
      },
    }
  }

  // What the grid paints: display text plus alignment (numbers right,
  // text left — the convention every spreadsheet user reads by).
  display(r, c) {
    const v = this.getValue(r, c)
    if (v === null) return { text: '', align: 'left' }
    if (isErr(v)) return { text: v.error, align: 'center' }
    if (typeof v === 'number') return { text: fmtNum(v), align: 'right' }
    if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', align: 'center' }
    return { text: v, align: 'left' }
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
      this.rows.delete(at, ids.length)
      // Delete the row's cells too: without this they'd sit as orphans and,
      // worse, resurrect if a same-position row were ever re-created.
      for (const key of [...this.cells.keys()]) {
        if (ids.includes(key.split('.')[0])) this.cells.delete(key)
      }
      for (const id of ids) this.dims.delete('h.' + id)
    })
    this._invalidate()
  }

  deleteCols(at, n = 1) {
    this._index()
    const ids = this.colIds.slice(at, at + n)
    if (ids.length === 0) return
    this.tx(() => {
      this.cols.delete(at, ids.length)
      for (const key of [...this.cells.keys()]) {
        if (ids.includes(key.split('.')[1])) this.cells.delete(key)
      }
      for (const id of ids) this.dims.delete('w.' + id)
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
