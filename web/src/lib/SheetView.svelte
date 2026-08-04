<script>
  // The spreadsheet page. Like EditorView, this component's job is
  // lifecycle and chrome; the document logic lives in framework-agnostic
  // modules (sheet/model.js + sheet/engine.js). The grid itself is a
  // canvas: only the visible window is painted, so size costs nothing.
  //
  // Layout trick for native scrolling: the scroll container holds an empty
  // spacer div sized to the whole virtual grid (so the scrollbars are
  // real), while the canvas is position:sticky at the top-left corner and
  // repaints from scrollLeft/scrollTop on every scroll event.
  import { onMount, onDestroy, tick } from 'svelte'
  import * as Y from 'yjs'
  import { Provider } from '../provider.js'
  import { SheetModel } from '../sheet/model.js'
  import { colName } from '../sheet/engine.js'
  import { scheduleCompaction } from '../compaction.js'

  let { me, doc, onBack, onShare } = $props()

  // $derived, not a plain const: props can change, and a const would keep
  // the value from the first render forever.
  let readOnly = $derived(doc.role === 'viewer')
  const HEADER_W = 48
  const HEADER_H = 24

  let status = $state('connecting…')
  let peerCount = $state(1)

  // Selection: anchor (r,c) to head (r2,c2). A single cell has both equal.
  let sel = $state({ r: 0, c: 0, r2: 0, c2: 0 })
  // While editing: which cell and the in-progress text. null = not editing.
  // The cell overlay input and the formula bar both bind to edit.value.
  let edit = $state(null)
  let totalW = $state(0)
  let totalH = $state(0)
  // Bumped on every model change. The model isn't $state (it's a plain
  // module class), so anything derived FROM it needs this to know when to
  // recompute — without it the formula bar ignores collaborators' edits.
  let revision = $state(0)

  let containerEl, canvasEl
  // $state because the overlay input mounts and unmounts with {#if edit}:
  // bind:this writes to it each time, and reads must see the fresh element.
  let cellInputEl = $state(null)
  let ydoc, provider, model, unobserve

  // Non-reactive interaction state (only the canvas cares, via redraws).
  let dragging = false
  let resizing = null // {c, startX, startW, curW} while dragging a col edge
  let layout = null

  const cursorColors = [
    ['#30bced', '#a8dff2'], ['#6eeb83', '#c6f7cf'], ['#fa69d1', '#fcc4ea'],
    ['#ffbc42', '#ffe3b0'], ['#ecd444', '#f5edb0'], ['#ee6352', '#f8c2ba'],
    ['#9b6ef3', '#d9c6fa'], ['#1be7ff', '#b3f6ff'],
  ]
  let myColor = '#30bced'

  onMount(() => {
    ydoc = new Y.Doc()
    model = new SheetModel(ydoc)

    provider = new Provider(ydoc, doc.id, {
      onStatus: (s) => { status = s },
      onSynced: (synced) => {
        if (provider.corrupted) return
        scheduleCompaction({ docId: doc.id, doc: ydoc, role: doc.role, synced })
      },
    })

    myColor = cursorColors[ydoc.clientID % cursorColors.length][0]
    provider.awareness.setLocalStateField('user', { name: me.name, color: myColor })
    provider.awareness.on('change', () => {
      peerCount = provider.awareness.getStates().size
      scheduleDraw()
    })
    publishSelection()

    unobserve = model.onChange(() => {
      revision++
      scheduleDraw()
    })

    const ro = new ResizeObserver(scheduleDraw)
    ro.observe(containerEl)
    scheduleDraw()

    return () => ro.disconnect()
  })

  onDestroy(() => {
    unobserve?.()
    provider?.destroy()
    ydoc?.destroy()
  })

  // ---- drawing ------------------------------------------------------------

  let drawQueued = false
  function scheduleDraw() {
    if (drawQueued) return
    drawQueued = true
    requestAnimationFrame(() => {
      drawQueued = false
      draw()
    })
  }

  // Column/row pixel layout: prefix sums over widths/heights, padded well
  // past the materialized area so there's always empty grid to scroll into.
  function buildLayout() {
    const R = Math.max(model.rowCount() + 40, 100)
    const C = Math.max(model.colCount() + 8, 26)
    const colX = new Array(C + 1)
    const rowY = new Array(R + 1)
    colX[0] = 0
    for (let c = 0; c < C; c++) {
      let w = model.colWidth(c)
      if (resizing && resizing.c === c) w = resizing.curW
      colX[c + 1] = colX[c] + w
    }
    rowY[0] = 0
    for (let r = 0; r < R; r++) rowY[r + 1] = rowY[r] + model.rowHeight(r)
    layout = { R, C, colX, rowY }
    totalW = HEADER_W + colX[C]
    totalH = HEADER_H + rowY[R]
  }

  function colAt(x) {
    const { C, colX } = layout
    for (let c = 0; c < C; c++) if (x < colX[c + 1]) return c
    return C - 1
  }
  function rowAt(y) {
    const { R, rowY } = layout
    for (let r = 0; r < R; r++) if (y < rowY[r + 1]) return r
    return R - 1
  }

  function selRect() {
    return {
      r1: Math.min(sel.r, sel.r2), r2: Math.max(sel.r, sel.r2),
      c1: Math.min(sel.c, sel.c2), c2: Math.max(sel.c, sel.c2),
    }
  }

  function draw() {
    if (!canvasEl || !containerEl) return
    buildLayout()
    const w = containerEl.clientWidth
    const h = containerEl.clientHeight
    const dpr = window.devicePixelRatio || 1
    canvasEl.width = w * dpr
    canvasEl.height = h * dpr
    canvasEl.style.width = w + 'px'
    canvasEl.style.height = h + 'px'
    const ctx = canvasEl.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.font = '13px system-ui, sans-serif'
    ctx.textBaseline = 'middle'

    const sx = containerEl.scrollLeft
    const sy = containerEl.scrollTop
    const { R, C, colX, rowY } = layout

    // Visible window in grid coordinates.
    const c0 = colAt(sx), c1 = colAt(sx + w)
    const r0 = rowAt(sy), r1 = rowAt(sy + h)
    const screenX = (c) => HEADER_W + colX[c] - sx
    const screenY = (r) => HEADER_H + rowY[r] - sy

    // Selection fill goes under the gridlines.
    const s = selRect()
    ctx.fillStyle = 'rgba(21, 101, 192, 0.08)'
    ctx.fillRect(screenX(s.c1), screenY(s.r1), colX[s.c2 + 1] - colX[s.c1], rowY[s.r2 + 1] - rowY[s.r1])

    // Cell contents, clipped to their cell.
    for (let r = r0; r <= r1 && r < R; r++) {
      const y = screenY(r) + (rowY[r + 1] - rowY[r]) / 2
      for (let c = c0; c <= c1 && c < C; c++) {
        if (edit && edit.r === r && edit.c === c) continue // input overlay shows here
        const { text, align } = model.display(r, c)
        if (text === '') continue
        const x = screenX(c)
        const cw = colX[c + 1] - colX[c]
        ctx.save()
        ctx.beginPath()
        ctx.rect(x, screenY(r), cw, rowY[r + 1] - rowY[r])
        ctx.clip()
        ctx.fillStyle = text.startsWith('#') && align === 'center' ? '#c62828' : '#202124'
        ctx.textAlign = align
        const tx = align === 'right' ? x + cw - 5 : align === 'center' ? x + cw / 2 : x + 5
        ctx.fillText(text, tx, y)
        ctx.restore()
      }
    }

    // Gridlines.
    ctx.strokeStyle = '#e2e3e5'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let c = c0; c <= Math.min(c1 + 1, C); c++) {
      const x = Math.round(screenX(c)) + 0.5
      ctx.moveTo(x, HEADER_H)
      ctx.lineTo(x, h)
    }
    for (let r = r0; r <= Math.min(r1 + 1, R); r++) {
      const y = Math.round(screenY(r)) + 0.5
      ctx.moveTo(HEADER_W, y)
      ctx.lineTo(w, y)
    }
    ctx.stroke()

    // Collaborator selections (position-based and ephemeral: they update on
    // every move, so a concurrent row insert misplaces them only momentarily).
    for (const [clientID, st] of provider.awareness.getStates()) {
      if (clientID === ydoc.clientID || !st.sheet || !st.user) continue
      const o = st.sheet
      if (o.r1 >= R || o.c1 >= C) continue
      ctx.strokeStyle = st.user.color
      ctx.lineWidth = 2
      ctx.strokeRect(screenX(o.c1), screenY(o.r1),
        colX[Math.min(o.c2, C - 1) + 1] - colX[o.c1], rowY[Math.min(o.r2, R - 1) + 1] - rowY[o.r1])
      ctx.fillStyle = st.user.color
      ctx.fillRect(screenX(o.c1), screenY(o.r1) - 14, ctx.measureText(st.user.name).width + 8, 14)
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'left'
      ctx.fillText(st.user.name, screenX(o.c1) + 4, screenY(o.r1) - 7)
    }

    // Own selection border.
    ctx.strokeStyle = '#1565c0'
    ctx.lineWidth = 2
    ctx.strokeRect(screenX(s.c1), screenY(s.r1), colX[s.c2 + 1] - colX[s.c1], rowY[s.r2 + 1] - rowY[s.r1])

    // Headers last, so scrolled content disappears underneath them.
    ctx.fillStyle = '#f8f9fa'
    ctx.fillRect(0, 0, w, HEADER_H)
    ctx.fillRect(0, 0, HEADER_W, h)
    ctx.fillStyle = '#5f6368'
    for (let c = c0; c <= c1 && c < C; c++) {
      const x = screenX(c), cw = colX[c + 1] - colX[c]
      if (c >= s.c1 && c <= s.c2) {
        ctx.fillStyle = '#e8f0fe'
        ctx.fillRect(x, 0, cw, HEADER_H)
        ctx.fillStyle = '#5f6368'
      }
      ctx.textAlign = 'center'
      ctx.fillText(colName(c), x + cw / 2, HEADER_H / 2)
    }
    for (let r = r0; r <= r1 && r < R; r++) {
      const y = screenY(r), rh = rowY[r + 1] - rowY[r]
      if (r >= s.r1 && r <= s.r2) {
        ctx.fillStyle = '#e8f0fe'
        ctx.fillRect(0, y, HEADER_W, rh)
        ctx.fillStyle = '#5f6368'
      }
      ctx.textAlign = 'center'
      ctx.fillText(String(r + 1), HEADER_W / 2, y + rh / 2)
    }
    ctx.strokeStyle = '#d0d1d3'
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, w - 1, HEADER_H - 1)
    ctx.strokeRect(0.5, 0.5, HEADER_W - 1, h - 1)
  }

  // ---- selection & editing ------------------------------------------------

  function publishSelection() {
    provider?.awareness.setLocalStateField('sheet', selRect())
  }

  function setSelection(r, c, extend) {
    const { R, C } = layout
    r = Math.max(0, Math.min(r, R - 1))
    c = Math.max(0, Math.min(c, C - 1))
    sel = extend ? { ...sel, r2: r, c2: c } : { r, c, r2: r, c2: c }
    publishSelection()
    scrollCellIntoView(r, c)
    scheduleDraw()
  }

  function scrollCellIntoView(r, c) {
    const { colX, rowY } = layout
    const el = containerEl
    const x1 = colX[c], x2 = colX[c + 1]
    const y1 = rowY[r], y2 = rowY[r + 1]
    if (x1 < el.scrollLeft) el.scrollLeft = x1
    if (x2 > el.scrollLeft + el.clientWidth - HEADER_W) el.scrollLeft = x2 - el.clientWidth + HEADER_W
    if (y1 < el.scrollTop) el.scrollTop = y1
    if (y2 > el.scrollTop + el.clientHeight - HEADER_H) el.scrollTop = y2 - el.clientHeight + HEADER_H
  }

  async function startEdit(initial) {
    if (readOnly) return
    edit = { r: sel.r, c: sel.c, value: initial ?? model.getInput(sel.r, sel.c) }
    // tick() waits until Svelte has rendered the overlay input; only then
    // can it be focused.
    await tick()
    cellInputEl?.focus()
    if (initial === undefined) cellInputEl?.select()
    scheduleDraw()
  }

  function commitEdit(dr, dc) {
    if (!edit) return
    model.setCell(edit.r, edit.c, edit.value)
    edit = null
    if (dr !== 0 || dc !== 0) setSelection(sel.r + dr, sel.c + dc, false)
    containerEl.focus()
    scheduleDraw()
  }

  function cancelEdit() {
    edit = null
    containerEl.focus()
    scheduleDraw()
  }

  function clearSelection() {
    if (readOnly) return
    const s = selRect()
    model.tx(() => {
      for (let r = s.r1; r <= Math.min(s.r2, model.rowCount() - 1); r++) {
        for (let c = s.c1; c <= Math.min(s.c2, model.colCount() - 1); c++) {
          model.setCell(r, c, '')
        }
      }
    })
  }

  // ---- mouse --------------------------------------------------------------

  function gridPos(e) {
    const rect = canvasEl.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function onMouseDown(e) {
    containerEl.focus()
    const { x, y } = gridPos(e)
    const sx = containerEl.scrollLeft, sy = containerEl.scrollTop

    if (y < HEADER_H && x >= HEADER_W) {
      // Column header: near a column edge starts a resize, else selects the
      // whole column.
      const gx = sx + x - HEADER_W
      const c = colAt(gx)
      const edge = layout.colX[c + 1] - gx
      if (!readOnly && (edge < 5 || (gx - layout.colX[c] < 5 && c > 0))) {
        const rc = edge < 5 ? c : c - 1
        resizing = { c: rc, startX: e.clientX, startW: layout.colX[rc + 1] - layout.colX[rc], curW: 0 }
        resizing.curW = resizing.startW
        e.preventDefault()
        return
      }
      commitEdit(0, 0)
      sel = { r: 0, c, r2: layout.R - 1, c2: c }
      publishSelection()
      scheduleDraw()
      return
    }
    if (x < HEADER_W && y >= HEADER_H) {
      const r = rowAt(sy + y - HEADER_H)
      commitEdit(0, 0)
      sel = { r, c: 0, r2: r, c2: layout.C - 1 }
      publishSelection()
      scheduleDraw()
      return
    }
    if (x < HEADER_W || y < HEADER_H) return

    const r = rowAt(sy + y - HEADER_H)
    const c = colAt(sx + x - HEADER_W)
    if (edit && (edit.r !== r || edit.c !== c)) commitEdit(0, 0)
    dragging = true
    setSelection(r, c, e.shiftKey)
  }

  function onMouseMove(e) {
    if (resizing) {
      resizing.curW = Math.max(24, resizing.startW + e.clientX - resizing.startX)
      scheduleDraw()
      return
    }
    if (!dragging) return
    const { x, y } = gridPos(e)
    const r = rowAt(containerEl.scrollTop + Math.max(y, HEADER_H) - HEADER_H)
    const c = colAt(containerEl.scrollLeft + Math.max(x, HEADER_W) - HEADER_W)
    setSelection(r, c, true)
  }

  function onMouseUp() {
    if (resizing) {
      model.setColWidth(resizing.c, resizing.curW)
      resizing = null
      scheduleDraw()
    }
    dragging = false
  }

  function onDblClick(e) {
    const { x, y } = gridPos(e)
    if (x < HEADER_W || y < HEADER_H) return
    startEdit()
  }

  // ---- keyboard -----------------------------------------------------------

  function onKeyDown(e) {
    if (edit) return // the overlay input handles its own keys
    const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key]
    if (move) {
      e.preventDefault()
      const base = e.shiftKey ? { r: sel.r2, c: sel.c2 } : { r: sel.r, c: sel.c }
      setSelection(base.r + move[0], base.c + move[1], e.shiftKey)
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (readOnly) return
      if (e.shiftKey) model.undo.redo()
      else model.undo.undo()
      return
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      startEdit()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      setSelection(sel.r, sel.c + (e.shiftKey ? -1 : 1), false)
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      clearSelection()
      return
    }
    // Any printable character replaces the cell and starts editing with it.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      startEdit(e.key)
    }
  }

  function onInputKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEdit(e.shiftKey ? -1 : 1, 0)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      commitEdit(0, e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
  }

  // ---- toolbar row/col operations ----------------------------------------

  function insertRowsAt(after) {
    const s = selRect()
    model.insertRows(after ? s.r2 + 1 : s.r1, s.r2 - s.r1 + 1)
  }
  function insertColsAt(after) {
    const s = selRect()
    model.insertCols(after ? s.c2 + 1 : s.c1, s.c2 - s.c1 + 1)
  }
  function deleteSelRows() {
    const s = selRect()
    model.deleteRows(s.r1, s.r2 - s.r1 + 1)
    setSelection(Math.min(s.r1, model.rowCount() - 1), sel.c, false)
  }
  function deleteSelCols() {
    const s = selRect()
    model.deleteCols(s.c1, s.c2 - s.c1 + 1)
    setSelection(sel.r, Math.min(s.c1, model.colCount() - 1), false)
  }

  // The formula bar shows the ACTIVE cell's input; typing in it edits that
  // cell. $derived recomputes whenever sel/edit (or a redraw bump) change.
  let cellName = $derived(colName(sel.c) + (sel.r + 1))

  // While editing, the bar mirrors the in-progress text; otherwise it shows
  // the selected cell's stored input. Reading `revision` is what makes it
  // follow remote changes.
  let barValue = $derived.by(() => {
    revision
    return edit ? edit.value : model ? model.getInput(sel.r, sel.c) : ''
  })

  function onFormulaBarInput(e) {
    if (readOnly) return
    if (!edit) edit = { r: sel.r, c: sel.c, value: '' }
    edit.value = e.target.value
    scheduleDraw()
  }

  // Position of the overlay input, in scroll-content coordinates (it lives
  // inside the scroll container, so it moves with the grid naturally).
  function editStyle() {
    if (!edit || !layout) return 'display:none'
    const { colX, rowY } = layout
    const x = HEADER_W + colX[edit.c]
    const y = HEADER_H + rowY[edit.r]
    const w = colX[edit.c + 1] - colX[edit.c]
    const h = rowY[edit.r + 1] - rowY[edit.r]
    return `left:${x}px; top:${y}px; width:${Math.max(w, 120)}px; height:${h}px`
  }
</script>

<svelte:window onmousemove={onMouseMove} onmouseup={onMouseUp} />

<p>
  <a href="#list" onclick={(e) => { e.preventDefault(); onBack() }}>← documents</a>
  <strong>{doc.title}</strong>
  {#if doc.role === 'owner'}
    <a href="#share" onclick={(e) => { e.preventDefault(); onShare(doc) }}>share</a>
  {/if}
  <span class="status">{status}</span>
  {#if peerCount > 1}
    <span class="status">{peerCount} online</span>
  {/if}
</p>

{#if !readOnly}
  <div class="toolbar">
    <button onclick={() => insertRowsAt(false)} title="Insert row above">+row ↑</button>
    <button onclick={() => insertRowsAt(true)} title="Insert row below">+row ↓</button>
    <button onclick={deleteSelRows} title="Delete selected rows">−row</button>
    <button onclick={() => insertColsAt(false)} title="Insert column left">+col ←</button>
    <button onclick={() => insertColsAt(true)} title="Insert column right">+col →</button>
    <button onclick={deleteSelCols} title="Delete selected columns">−col</button>
  </div>
{/if}

<div class="formula-bar">
  <span class="cell-name">{cellName}</span>
  <input
    value={barValue}
    oninput={onFormulaBarInput}
    onkeydown={onInputKeyDown}
    readonly={readOnly}
    placeholder={readOnly ? '' : 'value or =formula'}
  />
</div>

<!-- tabindex makes the div focusable, which is what lets it receive
     keyboard events for grid navigation. -->
<div
  class="grid"
  bind:this={containerEl}
  tabindex="0"
  role="grid"
  onscroll={scheduleDraw}
  onmousedown={onMouseDown}
  ondblclick={onDblClick}
  onkeydown={onKeyDown}
>
  <div class="spacer" style="width:{totalW}px; height:{totalH}px"></div>
  <canvas bind:this={canvasEl}></canvas>
  {#if edit}
    <input
      class="cell-edit"
      style={editStyle()}
      bind:this={cellInputEl}
      bind:value={edit.value}
      onkeydown={onInputKeyDown}
    />
  {/if}
</div>

<style>
  .toolbar {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 0.25rem;
  }
  .formula-bar {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.25rem;
  }
  .cell-name {
    font: 13px monospace;
    min-width: 3.5rem;
    text-align: center;
    border: 1px solid #d0d1d3;
    border-radius: 3px;
    padding: 3px 0;
  }
  .formula-bar input {
    flex: 1;
    font: 13px monospace;
    padding: 3px 6px;
  }
  .grid {
    position: relative;
    overflow: auto;
    height: calc(100vh - 170px);
    border: 1px solid #d0d1d3;
    outline: none;
    background: #fff;
  }
  .spacer {
    position: absolute;
    top: 0;
    left: 0;
  }
  .grid canvas {
    position: sticky;
    top: 0;
    left: 0;
    display: block;
  }
  .cell-edit {
    position: absolute;
    z-index: 2;
    font: 13px system-ui, sans-serif;
    border: 2px solid #1565c0;
    padding: 0 3px;
    outline: none;
    box-sizing: border-box;
  }
  .status {
    font-size: 0.85rem;
    opacity: 0.7;
    margin-left: 0.5rem;
  }
</style>
