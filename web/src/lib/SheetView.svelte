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
  import { Workbook, FIRST_SHEET } from '../sheet/model.js'
  import { colName } from '../sheet/engine.js'
  import { toTSV, toCSV, parseTSV, toHTML, readHTMLPayload } from '../sheet/clipboard.js'
  import { NUMBER_FORMATS, formatNumber } from '../sheet/format.js'
  import { CHART_TYPES, extractChartData, drawChart, chartDragPatch } from '../sheet/chart.js'
  import { scheduleCompaction } from '../compaction.js'
  import ScriptsPanel from './ScriptsPanel.svelte'
  import CommentsPanel from './CommentsPanel.svelte'
  import DocTitle from './DocTitle.svelte'
  import { listThreads, cellAnchor, cellKey, anchorKey } from '../comments.js'
  import { canEdit, canComment } from '../roles.js'
  import { runScript } from '../sheet/sandbox.js'
  import { handleCall } from '../sheet/scriptapi.js'
  import { allowTriggers, summariseEdit } from '../sheet/triggers.js'

  let { me, doc, onBack, onShare, onHistory, onRenamed } = $props()

  // $derived, not a plain const: props can change, and a const would keep
  // the value from the first render forever.
  // A commenter is read-only *here* even though they can write comments: if
  // they could type into the grid, the provider would send a doc update and
  // the server would close the socket for a policy violation.
  let readOnly = $derived(!canEdit(doc.role))
  let mayComment = $derived(canComment(doc.role))
  const HEADER_W = 48
  const HEADER_H = 24
  const BASE_FONT = '13px system-ui, sans-serif'
  const CHART_BAR_H = 26 // the chart's own title/controls strip

  function fontFor(fmt) {
    if (!fmt || (!fmt.b && !fmt.i)) return BASE_FONT
    return `${fmt.i ? 'italic ' : ''}${fmt.b ? 'bold ' : ''}${BASE_FONT}`
  }

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

  // The tab list, and which sheet is showing. Both are $state so the tab
  // bar re-renders; `model` follows activeId.
  let tabs = $state([])
  let activeId = $state(FIRST_SHEET)
  let renamingId = $state(null)

  // Charts float over the grid inside the scroll container, so they scroll
  // with the sheet without any bookkeeping. Their canvases are collected
  // here by bind:this and repainted from draw(), alongside the grid.
  let charts = $state([])
  let selectedChart = $state(null)
  let showScripts = $state(false)
  let showComments = $state(false)
  let threads = $state([])
  let triggerError = $state('')
  let triggerBusy = false // one trigger run at a time; bursts coalesce
  let chartCanvases = $state({})
  let chartDrag = null // {id, mode, startX, startY, orig} while dragging

  let containerEl, canvasEl
  // $state because the overlay input mounts and unmounts with {#if edit}:
  // bind:this writes to it each time, and reads must see the fresh element.
  let cellInputEl = $state(null)
  let ydoc, provider, model, unobserve, unwatchEdits
  // $state because the template reads it: it is created in onMount, and a
  // plain let would leave the scripts panel unable to ever render.
  let workbook = $state(null)

  // Non-reactive interaction state (only the canvas cares, via redraws).
  let dragging = false
  let resizing = null // {c, startX, startW, curW} while dragging a col edge
  let filling = null // {src, dest} while dragging the fill handle
  let cutRegion = null // marked by Cut, cleared when the paste lands
  let clipboard = null // our own last copy: {inputs, values, origin}
  let layout = null
  let handleAt = null // fill handle position, in scroll-content coordinates

  const cursorColors = [
    ['#30bced', '#a8dff2'], ['#6eeb83', '#c6f7cf'], ['#fa69d1', '#fcc4ea'],
    ['#ffbc42', '#ffe3b0'], ['#ecd444', '#f5edb0'], ['#ee6352', '#f8c2ba'],
    ['#9b6ef3', '#d9c6fa'], ['#1be7ff', '#b3f6ff'],
  ]
  let myColor = '#30bced'

  onMount(() => {
    ydoc = new Y.Doc()
    workbook = new Workbook(ydoc)
    model = workbook.sheet(activeId)
    tabs = workbook.list()

    provider = new Provider(ydoc, doc.id, {
      onStatus: (s) => { status = s },
      onSynced: (synced) => {
        if (provider.corrupted) return
        scheduleCompaction({ docId: doc.id, doc: ydoc, role: doc.role, synced })
      },
      // The server says only that comments changed, never what changed, so
      // the answer is always the same: refetch.
      onComments: loadComments,
    })

    loadComments()

    myColor = cursorColors[ydoc.clientID % cursorColors.length][0]
    provider.awareness.setLocalStateField('user', { name: me.name, color: myColor })
    provider.awareness.on('change', () => {
      peerCount = provider.awareness.getStates().size
      scheduleDraw()
    })
    publishSelection()

    unobserve = workbook.onChange(() => {
      revision++
      tabs = workbook.list()
      charts = model.charts()
      // A collaborator can delete the sheet being looked at; fall back to
      // the first remaining one rather than rendering a ghost.
      if (!tabs.some((t) => t.id === activeId)) selectSheet(tabs[0].id)
      scheduleDraw()
    })

    unwatchEdits = workbook.onLocalEdit(runTriggers)

    const ro = new ResizeObserver(scheduleDraw)
    ro.observe(containerEl)
    scheduleDraw()

    return () => ro.disconnect()
  })

  onDestroy(() => {
    unwatchEdits?.()
    unobserve?.()
    provider?.destroy()
    ydoc?.destroy()
  })

  // ---- comments -----------------------------------------------------------

  async function loadComments() {
    try {
      threads = await listThreads(doc.id)
    } catch (e) {
      // A failed refetch must not take the sheet down with it; the next nudge
      // or reopen tries again.
      console.warn('docs: could not load comments', e)
    }
    scheduleDraw()
  }

  // Cells on *this* tab carrying an unresolved thread, as "r.c" *positions*.
  // Resolved from ids here rather than in draw(): this recomputes once when
  // the threads or the sheet change, where draw() runs on every repaint and
  // would otherwise do an id lookup per visible cell per frame.
  // `revision` is the dependency that re-resolves them after a row insert
  // moves every position below it.
  let commentedCells = $derived.by(() => {
    void revision
    const marks = new Set()
    if (!model) return marks
    for (const t of threads) {
      if (t.resolved_at || t.anchor?.k !== 'cell') continue
      if ((t.anchor.sheet || FIRST_SHEET) !== activeId) continue
      const { r, c } = model.posOf(t.anchor.row, t.anchor.col)
      if (r !== null && c !== null) marks.add(r + '.' + c)
    }
    return marks
  })

  // An anchor names row and column *ids*, and a cell has no ids until it is
  // materialised — a new sheet has zero rows, however many the grid draws. So
  // commenting somewhere empty has to create the cell first, which is a
  // document write:
  //
  //   editor/owner — always allowed; materialise on submit, exactly as typing
  //                  into the cell would
  //   commenter    — only where ids already exist, because they may not write
  //                  to the document at all
  //
  // That asymmetry is inherent to id-based anchoring, not an oversight, so the
  // composer says why rather than sitting inexplicably disabled.
  let canAnchor = $derived.by(() => {
    void revision
    if (!model) return false
    if (!readOnly) return true
    const { row, col } = model.idsAt(sel.r, sel.c)
    return !!(row && col)
  })

  let anchorNote = $derived(
    canAnchor ? '' : 'That cell is still empty, and only an editor can start one there.',
  )

  // Built at submit time, not derived: it has a side effect when the cell does
  // not exist yet.
  function makeAnchor() {
    if (!model) return null
    if (!readOnly) model.ensureSize(sel.r, sel.c)
    const { row, col } = model.idsAt(sel.r, sel.c)
    if (!row || !col) return null
    return cellAnchor(activeId, row, col, model.display(sel.r, sel.c).text.slice(0, 120))
  }

  let newLabel = $derived(colName(sel.c) + (sel.r + 1))

  // Count across every tab, not just this one: the badge is how you learn a
  // thread is waiting on a sheet you are not looking at.
  let openComments = $derived(threads.filter((t) => !t.resolved_at).length)

  // Where a thread points, as an A1 name. A thread whose row or column has
  // since been deleted has no position left to name, so it says so rather
  // than silently rendering a wrong cell.
  function threadLabel(t) {
    void revision
    const a = t.anchor
    if (a?.k !== 'cell') return '—'
    const sheet = workbook?.sheetById(a.sheet || FIRST_SHEET)
    if (!sheet) return 'deleted'
    const { r, c } = sheet.posOf(a.row, a.col)
    if (r === null || c === null) return 'deleted'
    const name = colName(c) + (r + 1)
    const tab = tabs.find((t) => t.id === (a.sheet || FIRST_SHEET))
    return (a.sheet || FIRST_SHEET) === activeId ? name : `${tab?.name || '?'}!${name}`
  }

  function goToThread(t) {
    const a = t.anchor
    if (a?.k !== 'cell') return
    if ((a.sheet || FIRST_SHEET) !== activeId) selectSheet(a.sheet || FIRST_SHEET)
    const { r, c } = model.posOf(a.row, a.col)
    if (r === null || c === null) return
    setSelection(r, c, false)
    scrollCellIntoView(r, c)
  }

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
    ctx.font = BASE_FONT
    ctx.textBaseline = 'middle'

    const sx = containerEl.scrollLeft
    const sy = containerEl.scrollTop
    const { R, C, colX, rowY } = layout

    // Visible window in grid coordinates.
    const c0 = colAt(sx), c1 = colAt(sx + w)
    const r0 = rowAt(sy), r1 = rowAt(sy + h)
    const screenX = (c) => HEADER_W + colX[c] - sx
    const screenY = (r) => HEADER_H + rowY[r] - sy

    // Cell backgrounds first, so the selection tint and gridlines sit on
    // top of them rather than being painted over.
    for (let r = r0; r <= r1 && r < R; r++) {
      for (let c = c0; c <= c1 && c < C; c++) {
        const f = model.formatOf(r, c)
        if (!f || !f.bg) continue
        ctx.fillStyle = f.bg
        ctx.fillRect(screenX(c), screenY(r), colX[c + 1] - colX[c], rowY[r + 1] - rowY[r])
      }
    }

    // Selection tint over the backgrounds.
    const s = selRect()
    ctx.fillStyle = 'rgba(21, 101, 192, 0.08)'
    ctx.fillRect(screenX(s.c1), screenY(s.r1), colX[s.c2 + 1] - colX[s.c1], rowY[s.r2 + 1] - rowY[s.r1])

    // Cell contents, clipped to their cell.
    let font = BASE_FONT
    for (let r = r0; r <= r1 && r < R; r++) {
      const y = screenY(r) + (rowY[r + 1] - rowY[r]) / 2
      for (let c = c0; c <= c1 && c < C; c++) {
        if (edit && edit.r === r && edit.c === c) continue // input overlay shows here
        const { text, align, fmt } = model.display(r, c)
        if (text === '') continue
        const x = screenX(c)
        const cw = colX[c + 1] - colX[c]
        ctx.save()
        ctx.beginPath()
        ctx.rect(x, screenY(r), cw, rowY[r + 1] - rowY[r])
        ctx.clip()
        // Only touch ctx.font when it actually changes: assigning it
        // re-parses the shorthand, and this loop runs per visible cell.
        const want = fontFor(fmt)
        if (want !== font) { ctx.font = want; font = want }
        ctx.fillStyle = text.startsWith('#') && align === 'center'
          ? '#c62828'
          : (fmt && fmt.c) || '#202124'
        ctx.textAlign = align
        const tx = align === 'right' ? x + cw - 5 : align === 'center' ? x + cw / 2 : x + 5
        ctx.fillText(text, tx, y)
        ctx.restore()
      }
    }
    ctx.font = BASE_FONT

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

    // Comment markers: a small corner triangle, as in Sheets. Drawn after the
    // gridlines so it sits on top of them, and only for visible cells — this
    // runs on every repaint, so it walks the window, never the thread list.
    if (commentedCells.size) {
      ctx.fillStyle = '#f9a825'
      for (let r = r0; r <= r1 && r < R; r++) {
        for (let c = c0; c <= c1 && c < C; c++) {
          if (!commentedCells.has(r + '.' + c)) continue
          const x = screenX(c) + (colX[c + 1] - colX[c])
          const y = screenY(r)
          ctx.beginPath()
          ctx.moveTo(x - 7, y)
          ctx.lineTo(x, y)
          ctx.lineTo(x, y + 7)
          ctx.closePath()
          ctx.fill()
        }
      }
    }

    // Collaborator selections (position-based and ephemeral: they update on
    // every move, so a concurrent row insert misplaces them only momentarily).
    for (const [clientID, st] of provider.awareness.getStates()) {
      if (clientID === ydoc.clientID || !st.sheet || !st.user) continue
      const o = st.sheet
      if ((o.id || FIRST_SHEET) !== activeId) continue // they're on another tab
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

    // Cut source: marching-ants style dashes, so it's clear what will move.
    if (cutRegion) {
      ctx.strokeStyle = '#5f6368'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.strokeRect(screenX(cutRegion.c1), screenY(cutRegion.r1),
        colX[cutRegion.c2 + 1] - colX[cutRegion.c1], rowY[cutRegion.r2 + 1] - rowY[cutRegion.r1])
      ctx.setLineDash([])
    }

    // Own selection border.
    ctx.strokeStyle = '#1565c0'
    ctx.lineWidth = 2
    ctx.strokeRect(screenX(s.c1), screenY(s.r1), colX[s.c2 + 1] - colX[s.c1], rowY[s.r2 + 1] - rowY[s.r1])

    // Fill preview while dragging the handle.
    if (filling) {
      const d = filling.dest
      ctx.strokeStyle = '#5f6368'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 2])
      ctx.strokeRect(screenX(d.c1), screenY(d.r1),
        colX[Math.min(d.c2, C - 1) + 1] - colX[d.c1], rowY[Math.min(d.r2, R - 1) + 1] - rowY[d.r1])
      ctx.setLineDash([])
    }

    // Fill handle: the small square at the selection's bottom-right corner.
    // Recorded in content coordinates so mousedown can hit-test it.
    handleAt = { x: colX[s.c2 + 1], y: rowY[s.r2 + 1] }
    if (!readOnly) {
      const hx = screenX(s.c2 + 1)
      const hy = screenY(s.r2 + 1)
      ctx.fillStyle = '#fff'
      ctx.fillRect(hx - 4, hy - 4, 8, 8)
      ctx.fillStyle = '#1565c0'
      ctx.fillRect(hx - 3, hy - 3, 6, 6)
    }

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

    // Charts repaint with the grid, so they can never show stale data.
    for (const chart of charts) renderChart(chart)
  }

  // ---- selection & editing ------------------------------------------------

  // Carries the sheet id: a peer editing another tab must not be drawn on
  // this one, where their coordinates would mean something else entirely.
  function publishSelection() {
    provider?.awareness.setLocalStateField('sheet', { ...selRect(), id: activeId })
  }

  function setSelection(r, c, extend) {
    const { R, C } = layout
    r = Math.max(0, Math.min(r, R - 1))
    c = Math.max(0, Math.min(c, C - 1))
    sel = extend
      ? { ...sel, r2: r, c2: c, kind: 'cell' }
      : { r, c, r2: r, c2: c, kind: 'cell' }
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
    cellInputEl?.focus({ preventScroll: true })
    if (initial === undefined) cellInputEl?.select()
    scheduleDraw()
  }

  function commitEdit(dr, dc) {
    if (!edit) return
    model.setCell(edit.r, edit.c, edit.value)
    edit = null
    if (dr !== 0 || dc !== 0) setSelection(sel.r + dr, sel.c + dc, false)
    containerEl.focus({ preventScroll: true })
    scheduleDraw()
  }

  function cancelEdit() {
    edit = null
    containerEl.focus({ preventScroll: true })
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

  // ---- on-edit triggers ---------------------------------------------------

  // Fires only for edits made by THIS client and not by a script — the
  // model enforces both, so the effect is applied once no matter how many
  // people have the sheet open, and a script can never drive itself.
  async function runTriggers({ sheetId, keys }) {
    if (readOnly || triggerBusy) return
    const scripts = workbook.listScripts().filter((s) => s.trigger === 'onEdit')
    if (!scripts.length) return
    // Ask only when a trigger would actually fire, so a document with no
    // triggers never prompts about them.
    if (!allowTriggers(safeStorage(), doc.id, doc.role, () => confirm(
      `"${doc.title}" contains scripts set to run automatically when you edit it.\n\n` +
      'They can change this document as you, but cannot reach the network, ' +
      'your account, or any other document.\n\nRun them?'))) return

    const m = workbook.sheet(sheetId)
    const summary = summariseEdit(m, keys, colName)
    if (!summary) return
    const event = { sheet: workbook.nameOf(sheetId), range: summary.range, cells: summary.cells }

    triggerBusy = true
    try {
      for (const s of scripts) {
        const res = await runScript(s.code, {
          workbook,
          dispatch: handleCall,
          event,
          onLog: (line) => console.log(`[${s.name}]`, line),
        })
        if (res.error) {
          triggerError = `${s.name}: ${res.error}`
          console.error('trigger failed:', s.name, res.error)
        } else if (triggerError) {
          triggerError = ''
        }
      }
    } finally {
      triggerBusy = false
    }
  }

  // localStorage throws in some privacy modes; a missing store just means
  // the question gets asked again next time, which is the safe direction.
  function safeStorage() {
    try {
      return window.localStorage
    } catch {
      return null
    }
  }

  // ---- charts -------------------------------------------------------------

  function insertChart() {
    const s = selRect()
    if (s.r1 === s.r2 && s.c1 === s.c2) {
      alert('Select the data to chart first, including its header row.')
      return
    }
    // Drop it just right of the selection, where the data is still visible.
    const x = HEADER_W + layout.colX[Math.min(s.c2 + 1, layout.C - 1)] + 12
    const y = HEADER_H + layout.rowY[s.r1]
    const chart = model.addChart(s, { x, y })
    if (chart) selectedChart = chart.id
    scheduleDraw()
  }

  // Repainted from draw(), so charts and grid always agree about the data.
  function renderChart(chart) {
    const el = chartCanvases[chart.id]
    if (!el) return
    const box = el.parentElement
    const w = box.clientWidth
    const h = box.clientHeight - CHART_BAR_H
    if (w <= 0 || h <= 0) return
    const dpr = window.devicePixelRatio || 1
    el.width = w * dpr
    el.height = h * dpr
    el.style.width = w + 'px'
    el.style.height = h + 'px'
    const ctx = el.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const rect = model.chartRect(chart)
    if (!rect) {
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#c62828'
      ctx.font = '12px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('Data range no longer exists', w / 2, h / 2)
      return
    }
    const data = extractChartData(model, rect, chart)
    // Tick labels borrow the first series' cell format, so a currency
    // chart gets currency ticks and a plain one gets plain numbers.
    const fmt = data.series[0]?.fmt
    drawChart(ctx, w, h, chart, data, (v) => formatNumber(v, fmt) ?? String(Math.round(v * 1e6) / 1e6))
  }

  function onChartMouseDown(e, chart, mode) {
    e.stopPropagation() // never let this reach the grid's selection handling
    selectedChart = chart.id
    if (readOnly) return
    chartDrag = {
      id: chart.id, mode,
      startX: e.clientX, startY: e.clientY,
      orig: { x: chart.x, y: chart.y, w: chart.w, h: chart.h },
    }
  }

  // ---- formatting ---------------------------------------------------------

  // A selection made by clicking a column or row header formats the whole
  // column/row — one stored default that also covers cells nobody has
  // created yet. Anything else formats the selected cells.
  function applyFormat(patch) {
    if (readOnly) return
    const s = selRect()
    if (sel.kind === 'col') model.setColFormat(s.c1, s.c2, patch)
    else if (sel.kind === 'row') model.setRowFormat(s.r1, s.r2, patch)
    else model.setFormat(s, patch)
    scheduleDraw()
  }

  // The active cell's look drives the toolbar's pressed states.
  let activeFormat = $derived.by(() => {
    revision
    return (model && model.formatOf(sel.r, sel.c)) || {}
  })

  function toggle(key) {
    applyFormat({ [key]: activeFormat[key] ? null : 1 })
  }

  function setAlign(a) {
    applyFormat({ a: activeFormat.a === a ? null : a })
  }

  function setNumberFormat(e) {
    const id = e.target.value
    applyFormat({ n: id === 'auto' ? null : id })
  }

  // ---- sheets -------------------------------------------------------------

  function selectSheet(id) {
    if (edit) commitEdit(0, 0)
    activeId = id
    model = workbook.sheet(id)
    charts = model.charts()
    selectedChart = null
    sel = { r: 0, c: 0, r2: 0, c2: 0 }
    cutRegion = null
    if (containerEl) {
      containerEl.scrollTop = 0
      containerEl.scrollLeft = 0
    }
    publishSelection()
    scheduleDraw()
  }

  // Download the active tab. One tab, not the workbook: CSV has no concept
  // of multiple sheets, and bundling would mean inventing a zip writer.
  // The git exporter writes every tab, for whole-workbook backups.
  function downloadCsv() {
    const name = tabs.find((t) => t.id === activeId)?.name || 'Sheet1'
    // A UTF-8 BOM, because Excel otherwise reads a UTF-8 CSV as the local
    // codepage and mangles anything non-ASCII. The git export deliberately
    // omits it — a BOM in a repository is noise in every diff.
    const blob = new Blob(['﻿' + toCSV(model.toGrid())], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${doc.title} - ${name}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  function addSheet() {
    selectSheet(workbook.addSheet())
  }

  function removeSheet(id) {
    const tab = tabs.find((t) => t.id === id)
    if (!confirm(`Delete "${tab.name}"? Formulas pointing at it will show #REF!.`)) return
    if (!workbook.removeSheet(id)) alert('A workbook needs at least one sheet.')
  }

  // Renaming is an inline input on the tab itself; commit on blur or Enter.
  function startRename(id) {
    if (readOnly) return
    renamingId = id
  }

  function commitRename(e, id) {
    const name = e.target.value.trim()
    if (name) workbook.renameSheet(id, name)
    renamingId = null
  }

  // Interactive things live INSIDE the scroll container — the cell editor
  // overlay, and every chart with its title and controls — so their key,
  // clipboard and dblclick events bubble up to the grid's own handlers.
  // Without this guard the grid treated a keystroke aimed at a chart title
  // as cell entry: it called preventDefault (swallowing the character) and
  // started editing a cell with it.
  //
  // Note it tests for controls and chart panels, NOT `target !== container`:
  // the grid's own canvas is a child too, and every ordinary click and
  // double-click on a cell targets it.
  const OVERLAY_SELECTOR = 'input, select, button, textarea, .chart'
  const fromOverlay = (e) =>
    e.target !== containerEl && !!e.target?.closest?.(OVERLAY_SELECTOR)

  // ---- clipboard ----------------------------------------------------------

  // These ride the browser's own copy/cut/paste events, so Cmd+C/X/V and the
  // context menu all work without asking for clipboard permissions. When a
  // cell is being edited the events belong to that input, not to the grid.

  function onCopy(e) {
    if (fromOverlay(e) || edit) return
    e.preventDefault()
    const s = selRect()
    const { inputs, values, formats } = model.readRect(s.r1, s.c1, s.r2, s.c2)
    clipboard = { inputs, values, formats, origin: { r: s.r1, c: s.c1 } }
    e.clipboardData.setData('text/plain', toTSV(values))
    e.clipboardData.setData('text/html',
      toHTML(values, { inputs, formats, origin: clipboard.origin }))
    cutRegion = null
    scheduleDraw()
  }

  function onCut(e) {
    if (fromOverlay(e) || edit || readOnly) return
    onCopy(e)
    // Excel/Sheets semantics: the source empties when the paste lands, not
    // now — so a cut that is never pasted changes nothing.
    cutRegion = selRect()
    scheduleDraw()
  }

  function onPaste(e) {
    if (fromOverlay(e) || edit || readOnly) return
    e.preventDefault()
    const html = e.clipboardData.getData('text/html')
    const text = e.clipboardData.getData('text/plain')

    let inputs = null
    let origin = null
    let formats = null
    const payload = readHTMLPayload(html)
    if (payload) {
      inputs = payload.inputs
      origin = payload.origin
      formats = payload.formats
    } else if (clipboard && text && toTSV(clipboard.values) === text) {
      // Same-page fallback for a browser that dropped our HTML flavour:
      // the plain text still identifies our own copy.
      inputs = clipboard.inputs
      origin = clipboard.origin
      formats = clipboard.formats
    } else if (text) {
      inputs = parseTSV(text) // foreign data: literals, nothing to translate
    }
    if (!inputs || !inputs.length) return

    const s = selRect()
    model.writeRect(s.r1, s.c1, inputs, {
      rows: s.r2 - s.r1 + 1,
      cols: s.c2 - s.c1 + 1,
      origin,
      formats,
      clear: cutRegion,
    })
    cutRegion = null
    // Select what was pasted, as every spreadsheet does.
    const h = Math.max(inputs.length, s.r2 - s.r1 + 1)
    const w = Math.max(inputs[0].length, s.c2 - s.c1 + 1)
    sel = { r: s.r1, c: s.c1, r2: s.r1 + h - 1, c2: s.c1 + w - 1 }
    publishSelection()
    scheduleDraw()
  }

  // ---- mouse --------------------------------------------------------------

  function gridPos(e) {
    const rect = canvasEl.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  // preventScroll on every focus() here: focusing an element the browser
  // thinks is out of view makes it scroll the PAGE. With the scripts panel
  // open the page is taller than the viewport, so clicking a cell yanked
  // the script box to the top. The user clicked what they could already
  // see, so there is nothing to scroll to.
  function onMouseDown(e) {
    containerEl.focus({ preventScroll: true })
    const { x, y } = gridPos(e)
    const sx = containerEl.scrollLeft, sy = containerEl.scrollTop

    // The fill handle sits on the selection corner and wins over everything
    // else, since it overlaps the cell beneath it.
    if (!readOnly && handleAt && x >= HEADER_W && y >= HEADER_H) {
      const gx = sx + x - HEADER_W
      const gy = sy + y - HEADER_H
      if (Math.abs(gx - handleAt.x) <= 4 && Math.abs(gy - handleAt.y) <= 4) {
        if (edit) commitEdit(0, 0)
        const s = selRect()
        filling = { src: s, dest: s }
        e.preventDefault()
        return
      }
    }

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
      // kind 'col' so formatting targets the column default, not the cells.
      sel = { r: 0, c, r2: layout.R - 1, c2: c, kind: 'col' }
      publishSelection()
      scheduleDraw()
      return
    }
    if (x < HEADER_W && y >= HEADER_H) {
      const r = rowAt(sy + y - HEADER_H)
      commitEdit(0, 0)
      sel = { r, c: 0, r2: r, c2: layout.C - 1, kind: 'row' }
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
    if (chartDrag) {
      const patch = chartDragPatch(
        chartDrag.mode, chartDrag.orig,
        e.clientX - chartDrag.startX, e.clientY - chartDrag.startY,
        chartDrag.patch != null,
      )
      if (!patch) return // still a click, not yet a drag
      // Live-update the local copy so the drag looks immediate; the
      // document write happens once on mouseup, so a drag is one undo step
      // and one update on the wire rather than one per mouse event.
      charts = charts.map((c) => (c.id === chartDrag.id ? { ...c, ...patch } : c))
      chartDrag.patch = patch
      scheduleDraw()
      return
    }
    if (resizing) {
      resizing.curW = Math.max(24, resizing.startW + e.clientX - resizing.startX)
      scheduleDraw()
      return
    }
    if (filling) {
      const { x, y } = gridPos(e)
      const r = rowAt(containerEl.scrollTop + Math.max(y, HEADER_H) - HEADER_H)
      const c = colAt(containerEl.scrollLeft + Math.max(x, HEADER_W) - HEADER_W)
      const s = filling.src
      // Fill runs along one axis only: whichever the pointer left furthest.
      const dr = r > s.r2 ? r - s.r2 : r < s.r1 ? r - s.r1 : 0
      const dc = c > s.c2 ? c - s.c2 : c < s.c1 ? c - s.c1 : 0
      filling.dest = Math.abs(dr) >= Math.abs(dc)
        ? { ...s, r1: Math.min(s.r1, r), r2: Math.max(s.r2, r) }
        : { ...s, c1: Math.min(s.c1, c), c2: Math.max(s.c2, c) }
      scheduleDraw()
      return
    }
    if (!dragging) {
      updateCursor(e)
      return
    }
    const { x, y } = gridPos(e)
    const r = rowAt(containerEl.scrollTop + Math.max(y, HEADER_H) - HEADER_H)
    const c = colAt(containerEl.scrollLeft + Math.max(x, HEADER_W) - HEADER_W)
    setSelection(r, c, true)
  }

  // Cursor hints: crosshair over the fill handle, resize arrows over a
  // column edge. Cheap, and without them neither affordance is discoverable.
  function updateCursor(e) {
    if (!canvasEl || !layout || readOnly) return
    const { x, y } = gridPos(e)
    if (x < 0 || y < 0 || x > canvasEl.clientWidth || y > canvasEl.clientHeight) return
    const gx = containerEl.scrollLeft + x - HEADER_W
    const gy = containerEl.scrollTop + y - HEADER_H
    let cursor = 'cell'
    if (x >= HEADER_W && y >= HEADER_H && handleAt &&
        Math.abs(gx - handleAt.x) <= 4 && Math.abs(gy - handleAt.y) <= 4) {
      cursor = 'crosshair'
    } else if (y < HEADER_H && x >= HEADER_W) {
      const c = colAt(gx)
      cursor = layout.colX[c + 1] - gx < 5 || (gx - layout.colX[c] < 5 && c > 0) ? 'col-resize' : 'default'
    } else if (x < HEADER_W || y < HEADER_H) {
      cursor = 'default'
    }
    canvasEl.style.cursor = cursor
  }

  function onMouseUp() {
    if (chartDrag) {
      if (chartDrag.patch) model.updateChart(chartDrag.id, chartDrag.patch)
      chartDrag = null
      scheduleDraw()
      return
    }
    if (resizing) {
      model.setColWidth(resizing.c, resizing.curW)
      resizing = null
      scheduleDraw()
    }
    if (filling) {
      const { src, dest } = filling
      filling = null
      if (dest.r1 !== src.r1 || dest.r2 !== src.r2 || dest.c1 !== src.c1 || dest.c2 !== src.c2) {
        model.fill(src, dest)
        sel = { r: dest.r1, c: dest.c1, r2: dest.r2, c2: dest.c2 }
        publishSelection()
      }
      scheduleDraw()
    }
    dragging = false
  }

  function onDblClick(e) {
    // Double-clicking a chart's title to select a word must not also open
    // the cell editor underneath it. (mousedown is already safe: the chart
    // handlers stop propagation, but dblclick has no such stop.)
    if (fromOverlay(e)) return
    const { x, y } = gridPos(e)
    if (x < HEADER_W || y < HEADER_H) return
    startEdit()
  }

  // ---- keyboard -----------------------------------------------------------

  function onKeyDown(e) {
    if (fromOverlay(e)) return
    if (edit) return // the overlay input handles its own keys
    const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key]
    if (move) {
      e.preventDefault()
      const base = e.shiftKey ? { r: sel.r2, c: sel.c2 } : { r: sel.r, c: sel.c }
      setSelection(base.r + move[0], base.c + move[1], e.shiftKey)
      return
    }
    // Cmd/Ctrl+D fills the selection down from its top row — the standard
    // shortcut, and the keyboard route to what the fill handle does.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      if (readOnly) return
      const s = selRect()
      if (s.r2 > s.r1) model.fill({ ...s, r2: s.r1 }, s)
      return
    }
    if (e.key === 'Escape' && cutRegion) {
      e.preventDefault()
      cutRegion = null
      scheduleDraw()
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
  // A Svelte "action": a function run when the element is created. This is
  // the idiomatic way to touch a DOM node right after it mounts.
  function focusOnMount(node) {
    node.focus({ preventScroll: true })
    node.select()
  }

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

<div class="viewbar">
  <a class="back" href="#list" title="Back to documents" aria-label="Back to documents"
     onclick={(e) => { e.preventDefault(); onBack() }}>←</a>
  <DocTitle {doc} canRename={canEdit(doc.role)} {onRenamed} />
  <span class="label kind">{doc.role}</span>

  <span class="spacer"></span>

  <!-- Outside the editing toolbar on purpose: viewers read comments and
       commenters write them, and neither sees that toolbar. -->
  <button class="linkish" onclick={() => (showComments = !showComments)}>
    comments{openComments ? ` (${openComments})` : ''}
  </button>
  {#if doc.role === 'owner'}
    <a href="#share" onclick={(e) => { e.preventDefault(); onShare(doc) }}>share</a>
  {/if}
  <a href="#history" onclick={(e) => { e.preventDefault(); onHistory(doc) }}>history</a>

  <span class="status readout" class:live={status === 'synced'}>
    <span class="dot"></span>{status}{peerCount > 1 ? ` · ${peerCount} online` : ''}
  </span>
</div>

{#if !readOnly}
  <div class="toolbar">
    <button onclick={() => insertRowsAt(false)} title="Insert row above">+row ↑</button>
    <button onclick={() => insertRowsAt(true)} title="Insert row below">+row ↓</button>
    <button onclick={deleteSelRows} title="Delete selected rows">−row</button>
    <button onclick={() => insertColsAt(false)} title="Insert column left">+col ←</button>
    <button onclick={() => insertColsAt(true)} title="Insert column right">+col →</button>
    <button onclick={deleteSelCols} title="Delete selected columns">−col</button>
  </div>

  <div class="toolbar">
    <!-- class:on gives the button a pressed look when the active cell
         already has that format. -->
    <button class:on={activeFormat.b} onclick={() => toggle('b')} title="Bold (applies to the selection)"><b>B</b></button>
    <button class:on={activeFormat.i} onclick={() => toggle('i')} title="Italic"><i>I</i></button>
    <span class="sep"></span>
    <button class:on={activeFormat.a === 'l'} onclick={() => setAlign('l')} title="Align left">⇤</button>
    <button class:on={activeFormat.a === 'c'} onclick={() => setAlign('c')} title="Align centre">⇔</button>
    <button class:on={activeFormat.a === 'r'} onclick={() => setAlign('r')} title="Align right">⇥</button>
    <span class="sep"></span>
    <select value={activeFormat.n || 'auto'} onchange={setNumberFormat} title="Number format">
      {#each NUMBER_FORMATS as nf (nf.id)}
        <option value={nf.id}>{nf.label}</option>
      {/each}
    </select>
    <span class="sep"></span>
    <!-- Native colour inputs: no custom picker to build or maintain. The
         × next to each clears the colour, which a colour input cannot
         express on its own. -->
    <label title="Text colour">
      A<input type="color" value={activeFormat.c || '#202124'}
        oninput={(e) => applyFormat({ c: e.target.value })} />
    </label>
    <button onclick={() => applyFormat({ c: null })} title="Clear text colour">×</button>
    <label title="Background colour">
      ▉<input type="color" value={activeFormat.bg || '#ffffff'}
        oninput={(e) => applyFormat({ bg: e.target.value })} />
    </label>
    <button onclick={() => applyFormat({ bg: null })} title="Clear background">×</button>
    <span class="sep"></span>
    <button onclick={() => { model.clearFormat(selRect()); scheduleDraw() }} title="Clear all formatting">clear</button>
    <span class="sep"></span>
    <button onclick={insertChart} title="Chart the selected range">📊 chart</button>
    <button onclick={downloadCsv} title="Download this sheet as CSV">↓ csv</button>
    <button onclick={() => (showScripts = !showScripts)} title="Scripts">⚙ scripts</button>
  </div>
{/if}

{#if triggerError}
  <p class="trigger-error">⚠ on-edit script failed — {triggerError}</p>
{/if}

{#if showScripts && workbook}
  <ScriptsPanel {workbook} {readOnly} onClose={() => (showScripts = false)} />
{/if}

{#if showComments}
  <CommentsPanel
    docId={doc.id}
    {threads}
    {me}
    canComment={mayComment}
    isOwner={doc.role === 'owner'}
    {makeAnchor}
    {canAnchor}
    {anchorNote}
    {newLabel}
    label={threadLabel}
    onRefresh={loadComments}
    onGoTo={goToThread}
    onClose={() => (showComments = false)}
  />
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
  oncopy={onCopy}
  oncut={onCut}
  onpaste={onPaste}
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

  <!-- Charts live inside the scroll container, so they scroll with the
       sheet for free. Positions are stored in grid pixels. -->
  {#each charts as chart (chart.id)}
    <!-- The whole body is the drag surface, as in Excel and Sheets. It was
         originally only the top strip, but once a chart is selected the
         controls fill that strip and each one swallows mousedown to stay
         clickable — leaving nothing to grab. A movement threshold keeps a
         plain click from nudging the chart.
         Keyboard users reach every function from the strip's controls. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="chart"
      class:selected={selectedChart === chart.id}
      style="left:{chart.x}px; top:{chart.y}px; width:{chart.w}px; height:{chart.h}px"
      role="figure"
      onmousedown={(e) => onChartMouseDown(e, chart, 'move')}
    >
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="chart-bar"
        role="toolbar"
        tabindex="-1"
        onmousedown={(e) => onChartMouseDown(e, chart, 'move')}
      >
        <span class="chart-grip" title="Drag to move">⠿</span>
        {#if selectedChart === chart.id && !readOnly}
          <select
            value={chart.type}
            onmousedown={(e) => e.stopPropagation()}
            onchange={(e) => model.updateChart(chart.id, { type: e.target.value })}
          >
            {#each CHART_TYPES as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
          </select>
          <input
            class="chart-title"
            placeholder="Chart title"
            value={chart.title}
            onmousedown={(e) => e.stopPropagation()}
            onchange={(e) => model.updateChart(chart.id, { title: e.target.value })}
          />
          <!-- stopPropagation on the input itself, not a wrapping label:
               the strip is a drag handle, and mousedown must not start a
               drag when the user is aiming at the checkbox. -->
          <input
            type="checkbox"
            aria-label="First row holds the series names"
            title="First row holds the series names"
            checked={chart.headers !== false}
            onmousedown={(e) => e.stopPropagation()}
            onchange={(e) => model.updateChart(chart.id, { headers: e.target.checked })}
          />
          <button
            onmousedown={(e) => e.stopPropagation()}
            onclick={() => { model.removeChart(chart.id); selectedChart = null }}
            title="Delete chart"
          >×</button>
        {:else}
          <span class="chart-name">{chart.title || 'Chart'}</span>
        {/if}
      </div>
      <canvas bind:this={chartCanvases[chart.id]}></canvas>
      {#if !readOnly}
        <span
          class="chart-resize"
          role="button"
          tabindex="-1"
          title="Resize"
          onmousedown={(e) => onChartMouseDown(e, chart, 'resize')}
        ></span>
      {/if}
    </div>
  {/each}
</div>

<div class="tabs">
  {#each tabs as tab (tab.id)}
    {#if renamingId === tab.id}
      <!-- autofocus is right here: the input exists only because the user
           just double-clicked this tab to rename it. -->
      <input
        class="tab-rename"
        value={tab.name}
        onblur={(e) => commitRename(e, tab.id)}
        onkeydown={(e) => {
          if (e.key === 'Enter') e.target.blur()
          if (e.key === 'Escape') { renamingId = null }
        }}
        use:focusOnMount
      />
    {:else}
      <button
        class="tab"
        class:active={tab.id === activeId}
        onclick={() => selectSheet(tab.id)}
        ondblclick={() => startRename(tab.id)}
        title={readOnly ? tab.name : 'Double-click to rename'}
      >
        {tab.name}
        {#if !readOnly && tabs.length > 1}
          <!-- A span, not a nested button: buttons cannot nest. -->
          <span
            class="tab-x"
            role="button"
            tabindex="-1"
            title="Delete sheet"
            onclick={(e) => { e.stopPropagation(); removeSheet(tab.id) }}
            onkeydown={(e) => { if (e.key === 'Enter') removeSheet(tab.id) }}
          >×</span>
        {/if}
      </button>
    {/if}
  {/each}
  {#if !readOnly}
    <button class="tab add" onclick={addSheet} title="Add sheet">+</button>
  {/if}
</div>

<style>
  .toolbar {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 0.25rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .toolbar button.on {
    background: #e8f0fe;
    border-color: #1565c0;
  }
  .toolbar .sep {
    width: 1px;
    align-self: stretch;
    background: #d0d1d3;
    margin: 0 0.25rem;
  }
  .toolbar label {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: 0.85rem;
  }
  .toolbar input[type='color'] {
    width: 22px;
    height: 20px;
    padding: 0;
    border: 1px solid #d0d1d3;
    background: none;
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
  .tabs {
    display: flex;
    gap: 2px;
    align-items: stretch;
    margin-top: 4px;
    flex-wrap: wrap;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85rem;
    padding: 4px 10px;
    border: 1px solid #d0d1d3;
    border-top: none;
    border-radius: 0 0 4px 4px;
    background: #f8f9fa;
    cursor: pointer;
  }
  .tab.active {
    background: #fff;
    font-weight: 600;
    box-shadow: inset 0 -2px 0 #1565c0;
  }
  .tab-x {
    opacity: 0.45;
    padding: 0 2px;
    line-height: 1;
  }
  .tab-x:hover {
    opacity: 1;
    color: #c62828;
  }
  .tab.add {
    font-weight: 600;
  }
  .tab-rename {
    font-size: 0.85rem;
    padding: 4px 8px;
    width: 8rem;
    border: 1px solid #1565c0;
    border-radius: 0 0 4px 4px;
  }
  .grid {
    position: relative;
    overflow: auto;
    /* Absorbs the leftover height from .page.fill. min-height:0 is the
       non-obvious part: without it a scrollable flex child refuses to
       shrink below its content and pushes the page taller instead. */
    flex: 1;
    min-height: 0;
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
  .chart {
    position: absolute;
    z-index: 3;
    background: #fff;
    border: 1px solid #d0d1d3;
    border-radius: 4px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    cursor: move;
  }
  .chart.selected {
    border-color: #1565c0;
    box-shadow: 0 0 0 1px #1565c0, 0 2px 8px rgba(0, 0, 0, 0.2);
  }
  .chart-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 26px;
    padding: 0 4px;
    background: #f8f9fa;
    border-bottom: 1px solid #e2e3e5;
    cursor: move;
    font-size: 0.75rem;
  }
  .chart-bar select,
  .chart-bar input {
    font-size: 0.75rem;
    cursor: default;
  }
  .chart-grip {
    opacity: 0.4;
    letter-spacing: -2px;
    padding-right: 2px;
  }
  .chart-title {
    flex: 1;
    min-width: 3rem;
  }
  .chart-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.7;
  }
  .chart canvas {
    display: block;
    flex: 1;
  }
  .chart-resize {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 12px;
    height: 12px;
    cursor: nwse-resize;
    background: linear-gradient(135deg, transparent 50%, #9aa0a6 50%);
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
  .trigger-error {
    margin: 0 0 0.25rem;
    padding: 0.2rem 0.4rem;
    font-size: 0.8rem;
    color: #c62828;
    background: #fdecea;
    border-radius: 3px;
  }
  .status {
    font-size: 0.85rem;
    opacity: 0.7;
    margin-left: 0.5rem;
  }
  /* A button, because it toggles a panel rather than navigating — styled to
     sit with the links beside it. */
  .linkish {
    border: 0;
    background: none;
    padding: 0;
    margin-left: 0.5rem;
    font: inherit;
    font-size: 0.9rem;
    color: #1565c0;
    cursor: pointer;
  }
</style>
