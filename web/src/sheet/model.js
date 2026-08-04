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
    // captureTimeout 0 because Yjs otherwise merges everything within 500ms
    // into one undo step: fine for typing prose, wrong for a spreadsheet,
    // where each cell entry, paste and fill is a discrete act the user
    // expects to undo one at a time.
    this.undo = new Y.UndoManager([this.rows, this.cols, this.cells, this.dims], {
      trackedOrigins: new Set([this]),
      captureTimeout: 0,
    })

    const notify = () => {
      for (const cb of this.listeners) cb()
    }
    const structural = () => { this._invalidate(); notify() }
    const contents = () => { this._invalidateValues(); notify() }
    this.rows.observe(structural)
    this.cols.observe(structural)
    this.cells.observe(contents)
    this.dims.observe(contents)
  }

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
      return { kind: 'a1', row, col, absRow: !!ref.absRow, absCol: !!ref.absCol }
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
            return {
              kind: 'id',
              rid: this.rowIds[ref.row], cid: this.colIds[ref.col],
              absRow: !!ref.absRow, absCol: !!ref.absCol,
            }
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
      this._invalidateValues()
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

  // inputs = what to store on a copy (formulas, in A1 form); values = the
  // displayed text, which is what other applications expect on the clipboard.
  readRect(r1, c1, r2, c2) {
    const inputs = []
    const values = []
    for (let r = r1; r <= r2; r++) {
      const irow = []
      const vrow = []
      for (let c = c1; c <= c2; c++) {
        irow.push(this.getInput(r, c))
        vrow.push(this.display(r, c).text)
      }
      inputs.push(irow)
      values.push(vrow)
    }
    return { inputs, values }
  }

  // Write a block at (r,c), repeating it to cover `rows` x `cols` when the
  // target area is larger (paste into a bigger selection, as in Sheets).
  // origin = where the block was copied from, or null for foreign data with
  // no references to translate. clear = a rect emptied first, for cut.
  writeRect(r, c, inputs, { rows, cols, origin = null, clear = null } = {}) {
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
        }
      }
    })
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
    const nums = inputs.map(numericLiteral)

    // A single number copies rather than counting — matching Excel and
    // Sheets, where 1 dragged down gives 1,1,1 and 1,2 gives 3,4,5.
    let step = null
    if (nums.length >= 2 && nums.every((n) => n !== null)) {
      step = nums[1] - nums[0]
      for (let i = 2; i < nums.length; i++) {
        if (Math.abs(nums[i] - nums[i - 1] - step) > 1e-9) { step = null; break }
      }
    }

    targets.forEach(([tr, tc], k) => {
      if (step !== null) {
        const base = forward ? nums[nums.length - 1] : nums[0]
        const v = forward ? base + step * (k + 1) : base - step * (k + 1)
        this.setCell(tr, tc, fmtNum(v))
        return
      }
      const idx = forward
        ? k % inputs.length
        : inputs.length - 1 - (k % inputs.length)
      const [sr, sc] = srcCells[idx]
      this.setCellShifted(tr, tc, inputs[idx], tr - sr, tc - sc)
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
