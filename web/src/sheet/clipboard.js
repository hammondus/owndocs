// Grid text serialization: the clipboard's two flavours, and the CSV used
// by file export and the git exporter. Pure string handling — no DOM, so
// it can be tested headlessly and reused by the headless exporter.
//
// Two flavours go on the clipboard, which is what every spreadsheet does:
//   text/plain  tab-separated DISPLAYED VALUES — what Excel, Numbers and
//               Google Sheets read, so paste into them works.
//   text/html   a plain <table> of the same values, carrying our raw cell
//               inputs in a data attribute. Pasting back into this app
//               reads that attribute and keeps the FORMULAS, translated;
//               every other app just sees an ordinary table.
// Google Sheets uses the same trick (data-sheets-value), so browsers are
// known to preserve data attributes across a copy.

import { formatCss } from './format.js'

const MARK = 'data-docs-sheet'

// ---- TSV ------------------------------------------------------------------

// A field containing the delimiter, a newline or a quote is wrapped in
// double quotes with "" escaping — the CSV convention, which spreadsheets
// apply to TSV too. CSV and TSV are the same format with a different
// separator, so one implementation serves the clipboard and file export.
function escapeField(s, delim) {
  return s.includes(delim) || /[\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export function toDelimited(grid, delim) {
  return grid.map((row) => row.map((f) => escapeField(String(f ?? ''), delim)).join(delim)).join('\n')
}

export const toTSV = (grid) => toDelimited(grid, '\t')
export const toCSV = (grid) => toDelimited(grid, ',')

export function parseDelimited(text, delim) {
  const src = text.replace(/\r\n?/g, '\n')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } // "" is one quote
        else quoted = false
      } else field += c
      continue
    }
    if (c === '"' && field === '') quoted = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += c
  }
  row.push(field)
  rows.push(row)
  // A trailing newline shouldn't produce a phantom empty row.
  if (rows.length > 1) {
    const last = rows[rows.length - 1]
    if (last.length === 1 && last[0] === '') rows.pop()
  }
  return rows
}

export const parseTSV = (text) => parseDelimited(text, '\t')
export const parseCSV = (text) => parseDelimited(text, ',')

// ---- HTML flavour ---------------------------------------------------------

const escapeHTML = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const unescapeHTML = (s) =>
  s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

// Inline styles on each cell, so formatting survives a paste into Excel or
// Google Sheets — they read the HTML flavour's CSS, not our attribute.
function cellStyle(f) {
  const css = formatCss(f)
  return css ? ` style="${escapeHTML(css)}"` : ''
}

// payload: {inputs, formats, origin} — raw cell inputs and their formats
// plus where they came from, which is what lets paste shift relative
// references correctly.
export function toHTML(values, payload) {
  const formats = payload?.formats
  const body = values
    .map((row, i) => '<tr>' + row
      .map((v, j) => `<td${cellStyle(formats?.[i]?.[j])}>${escapeHTML(v)}</td>`)
      .join('') + '</tr>')
    .join('')
  return `<table ${MARK}="${escapeHTML(JSON.stringify(payload))}">${body}</table>`
}

// Reads our own attribute with our own escaping, so a regex is sufficient
// and this module stays DOM-free. Returns null for foreign HTML, which the
// caller then handles as plain TSV.
export function readHTMLPayload(html) {
  const m = new RegExp(`${MARK}="([^"]*)"`).exec(html || '')
  if (!m) return null
  try {
    const payload = JSON.parse(unescapeHTML(m[1]))
    return Array.isArray(payload?.inputs) ? payload : null
  } catch {
    return null
  }
}
