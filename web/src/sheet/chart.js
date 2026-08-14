// Charts: data extraction, axis scaling and canvas drawing. The extraction
// and scaling halves are pure and tested; only drawChart needs a canvas.
//
// A chart's data range is stored as stable row/column IDS, exactly like a
// formula reference — that was the whole point of the id-based grid, and it
// means inserting a row inside a charted range simply extends the chart.

import { isDec, decToNumber } from './exact.js'

export const CHART_TYPES = [
  { id: 'column', label: 'Column' },
  { id: 'line', label: 'Line' },
  { id: 'pie', label: 'Pie' },
]

// The light-scheme series colours, and the fallback for a caller that passes
// no chrome. The live app does not use these: SheetView resolves --chart-1..8
// from the stylesheet so a chart follows the scheme like everything else. They
// are kept as a literal here so this module stays runnable without a document.
export const SERIES_COLORS = [
  'oklch(0.55 0.17 25)', 'oklch(0.55 0.17 60)', 'oklch(0.55 0.17 95)', 'oklch(0.55 0.17 145)',
  'oklch(0.55 0.17 195)', 'oklch(0.55 0.17 255)', 'oklch(0.55 0.17 300)', 'oklch(0.55 0.17 345)',
]

export const MIN_CHART_W = 160
export const MIN_CHART_H = 120
// Below this the pointer was clicking, not dragging. Without it, every
// click on a chart nudges it by whatever the hand wobbled.
export const DRAG_THRESHOLD = 3

// Where a chart lands for a drag of (dx, dy) from `orig`. Returns null
// while the gesture is still just a click. `started` is true once a drag
// has been recognised, so it can't drop back below the threshold mid-drag.
export function chartDragPatch(mode, orig, dx, dy, started) {
  if (!started && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return null
  if (mode === 'move') {
    // Clamped at the top-left: a chart dragged off the sheet would be
    // unreachable, since the grid never scrolls to negative coordinates.
    return { x: Math.max(0, orig.x + dx), y: Math.max(0, orig.y + dy) }
  }
  return { w: Math.max(MIN_CHART_W, orig.w + dx), h: Math.max(MIN_CHART_H, orig.h + dy) }
}

// Round axis bounds and a tick step from the 1/2/5 family. Raw min/max
// give ticks like 3.7143 that nobody can read off a chart.
export function niceScale(min, max, targetTicks = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1, step: 1, ticks: [0, 1] }
  }
  if (min === max) {
    if (min === 0) { min = 0; max = 1 } else {
      const pad = Math.abs(min) * 0.1
      min -= pad
      max += pad
    }
  }
  const raw = (max - min) / Math.max(1, targetTicks)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const ticks = []
  // Rebuild each tick from the step rather than accumulating, so floating
  // point drift can't turn 0.3 into 0.30000000000000004 on an axis label.
  for (let i = 0; lo + i * step <= hi + step / 1e9; i++) ticks.push(lo + i * step)
  return { min: lo, max: hi, step, ticks }
}

// Pull a chart's data out of a resolved rect.
//   one column   -> a single series, categories are row numbers
//   two or more  -> first column is the category labels, the rest are series
// With headers, the first row names the series.
//
// Labels come from display(), so a charted date column shows dates and a
// currency column shows currency — the formatting work pays off here.
export function extractChartData(model, rect, spec) {
  const headers = spec.headers !== false
  const r0 = rect.r1 + (headers ? 1 : 0)
  const singleCol = rect.c1 === rect.c2
  const catCol = singleCol ? null : rect.c1
  const firstSeriesCol = singleCol ? rect.c1 : rect.c1 + 1

  const categories = []
  for (let r = r0; r <= rect.r2; r++) {
    categories.push(catCol === null
      ? String(r - r0 + 1)
      : model.display(r, catCol).text)
  }

  const series = []
  for (let c = firstSeriesCol; c <= rect.c2; c++) {
    const values = []
    for (let r = r0; r <= rect.r2; r++) {
      const v = model.getValue(r, c)
      // An exact value plots as a double: a chart pixel cannot express 34
      // digits, and treating it as non-numeric would silently punch a hole
      // in the series instead.
      values.push(isDec(v) ? decToNumber(v) : typeof v === 'number' ? v : null)
    }
    series.push({
      name: headers ? (model.display(rect.r1, c).text || `Series ${series.length + 1}`)
        : `Series ${series.length + 1}`,
      values,
      // The value axis borrows the first data cell's format, so a chart of
      // a currency column gets currency tick labels.
      fmt: model.formatOf(r0, c),
    })
  }
  return { categories, series }
}

// ---- drawing --------------------------------------------------------------

const PAD = 10

// The chrome a chart draws that is not data: ground, ink, axis labels and
// gridlines. Passed in rather than read from the document, because everything
// above this line is pure and tested headlessly, and reaching for
// `getComputedStyle` here would make drawChart need a DOM to run.
//
// The default is the light scheme, so a caller that does not care — the test
// suite, which asserts geometry rather than colour — needs no argument. The
// real caller is SheetView, which passes the resolved tokens from theme.js.
export const LIGHT_CHART_CHROME = {
  ground: '#ffffff',
  ink: '#202124',
  ink2: '#5f6368',
  gridline: '#e2e3e5',
  onSeries: '#ffffff',
  series: SERIES_COLORS,
}

export function drawChart(ctx, w, h, spec, data, formatTick, chrome = LIGHT_CHART_CHROME) {
  // Wrapped rather than indexed at each use: `series` is already the *data*
  // series here, and the two must not be confusable.
  const seriesColor = (i) => chrome.series[i % chrome.series.length]
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = chrome.ground
  ctx.fillRect(0, 0, w, h)
  ctx.font = '11px system-ui, sans-serif'
  ctx.textBaseline = 'middle'

  let top = PAD
  if (spec.title) {
    ctx.fillStyle = chrome.ink
    ctx.font = 'bold 12px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(spec.title, w / 2, top + 7)
    top += 20
    ctx.font = '11px system-ui, sans-serif'
  }

  const { categories, series } = data
  if (!series.length || !categories.length) {
    ctx.fillStyle = chrome.ink2
    ctx.textAlign = 'center'
    ctx.fillText('No data in range', w / 2, h / 2)
    return
  }

  // Legend along the bottom when there is more than one series.
  let bottom = h - PAD
  if (series.length > 1) {
    bottom -= 16
    let x = PAD
    ctx.textAlign = 'left'
    for (let i = 0; i < series.length; i++) {
      ctx.fillStyle = seriesColor(i)
      ctx.fillRect(x, h - PAD - 12, 9, 9)
      ctx.fillStyle = chrome.ink2
      const label = series[i].name
      ctx.fillText(label, x + 13, h - PAD - 7)
      x += 13 + ctx.measureText(label).width + 12
      if (x > w - PAD) break
    }
  }

  if (spec.type === 'pie') return drawPie(ctx, w, top, bottom, data, chrome)

  // Value range across every series, with zero included for columns so the
  // bars stand on a real baseline rather than a floating one.
  let min = Infinity, max = -Infinity
  for (const s of series) {
    for (const v of s.values) {
      if (v === null) continue
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (min === Infinity) { min = 0; max = 1 }
  if (spec.type === 'column') {
    min = Math.min(min, 0)
    max = Math.max(max, 0)
  }
  const scale = niceScale(min, max)

  // Axis gutter sized to the widest tick label.
  ctx.textAlign = 'right'
  let gutter = 0
  const tickText = scale.ticks.map((t) => formatTick(t))
  for (const t of tickText) gutter = Math.max(gutter, ctx.measureText(t).width)
  const left = PAD + gutter + 6
  const plotW = w - left - PAD
  const plotH = bottom - top - 16 // room for category labels
  if (plotW <= 10 || plotH <= 10) return
  const yOf = (v) => top + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH

  // Gridlines and value labels.
  ctx.strokeStyle = chrome.gridline
  ctx.fillStyle = chrome.ink2
  ctx.lineWidth = 1
  scale.ticks.forEach((t, i) => {
    const y = Math.round(yOf(t)) + 0.5
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(left + plotW, y)
    ctx.stroke()
    ctx.fillText(tickText[i], left - 6, y)
  })

  const n = categories.length
  const slot = plotW / n
  // Category labels, thinned out until they stop overlapping.
  ctx.textAlign = 'center'
  ctx.fillStyle = chrome.ink2
  const every = Math.max(1, Math.ceil((n * 46) / plotW))
  for (let i = 0; i < n; i++) {
    if (i % every) continue
    ctx.fillText(categories[i], left + slot * (i + 0.5), bottom - 6)
  }

  if (spec.type === 'line') {
    series.forEach((s, si) => {
      ctx.strokeStyle = seriesColor(si)
      ctx.lineWidth = 2
      ctx.beginPath()
      let pen = false
      s.values.forEach((v, i) => {
        if (v === null) { pen = false; return } // a gap breaks the line
        const x = left + slot * (i + 0.5)
        const y = yOf(v)
        if (pen) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
        pen = true
      })
      ctx.stroke()
    })
    return
  }

  // Columns: grouped side by side within each category slot.
  const groupW = slot * 0.7
  const barW = Math.max(1, groupW / series.length)
  const zeroY = yOf(Math.max(scale.min, Math.min(0, scale.max)))
  series.forEach((s, si) => {
    ctx.fillStyle = seriesColor(si)
    s.values.forEach((v, i) => {
      if (v === null) return
      const x = left + slot * i + (slot - groupW) / 2 + si * barW
      const y = yOf(v)
      ctx.fillRect(x, Math.min(y, zeroY), Math.max(1, barW - 1), Math.abs(zeroY - y))
    })
  })
}

function drawPie(ctx, w, top, bottom, data, chrome) {
  const seriesColor = (i) => chrome.series[i % chrome.series.length]
  const s = data.series[0]
  const total = s.values.reduce((a, v) => a + (v === null || v < 0 ? 0 : v), 0)
  const cx = w / 2
  const cy = (top + bottom) / 2
  const r = Math.max(4, Math.min(w, bottom - top) / 2 - PAD)
  if (total <= 0) {
    ctx.fillStyle = chrome.ink2
    ctx.textAlign = 'center'
    ctx.fillText('Nothing to plot', cx, cy)
    return
  }
  let angle = -Math.PI / 2 // start at twelve o'clock, as pies do
  s.values.forEach((v, i) => {
    if (v === null || v <= 0) return
    const sweep = (v / total) * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.arc(cx, cy, r, angle, angle + sweep)
    ctx.closePath()
    ctx.fillStyle = seriesColor(i)
    ctx.fill()
    // Label slices with room for one.
    if (sweep > 0.25) {
      const mid = angle + sweep / 2
      ctx.fillStyle = chrome.onSeries
      ctx.textAlign = 'center'
      ctx.fillText(data.categories[i] || '', cx + Math.cos(mid) * r * 0.62, cy + Math.sin(mid) * r * 0.62)
    }
    angle += sweep
  })
}
