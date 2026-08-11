// Markdown text transforms for the toolbar and keymap: list toggling, list
// indentation, and table column alignment.
//
// No CodeMirror imports, by the same rule table.js follows — everything here
// takes strings and returns edits expressed as plain offsets, so it runs under
// `node scripts/mdtext_test.mjs` with no DOM and no editor. editor.js is the
// only thing that knows these become transactions.
//
// Line edits are returned as `{ to, insert }`: replace characters `[0, to)` of
// that line with `insert`. Always a *prefix* edit, never a whole-line rewrite —
// replacing the whole line would drag the cursor to one end of it.

// A list item: indent, marker (`-`/`*`/`+` or `1.`/`1)`), the spaces after it,
// and optionally a task box. `-` on its own is a legal empty item, hence the
// `$` alternative.
const LIST_RE = /^(\s*)([-*+]|\d+[.)])(\s+|$)(\[[ xX]\]\s*)?/

export function listMarker(text) {
  const m = LIST_RE.exec(text)
  if (!m) return null
  const [all, indent, marker, spaces, task] = m
  return {
    indent: indent.length,
    marker,
    ordered: /\d/.test(marker),
    // '[ ]' / '[x]', or null when this is not a task item.
    task: task ? task.trim() : null,
    // Where a nested item under this one has to start, per CommonMark: after
    // the marker and its spaces. The task box is content, not marker.
    contentCol: indent.length + marker.length + spaces.length,
    // How much of the line is marker rather than text.
    prefixLen: all.length,
  }
}

const leadLen = (text) => /^[ \t]*/.exec(text)[0].length

// ---- list toggling ---------------------------------------------------------

// Turn `lines` into a list of `kind` ('bullet' | 'ordered' | 'task'), or back
// into plain lines when every line is already that kind. Converting between
// kinds is a single step: bullets become numbers, numbers become tasks.
//
// Ordered lists are numbered per indentation level, so toggling a selection
// that spans nested items does not number 1,2,3,4 straight through a nesting
// boundary.
export function toggleList(lines, kind) {
  const parsed = lines.map((text) => ({ text, blank: text.trim() === '', m: listMarker(text) }))
  // Blank lines inside a selection are left alone — unless every line is
  // blank, which is the "cursor on an empty line, start a list" case.
  const anyText = parsed.some((p) => !p.blank)
  for (const p of parsed) p.target = anyText ? !p.blank : true

  const isKind = (p) => {
    if (!p.m) return false
    if (kind === 'task') return p.m.task !== null
    if (p.m.task !== null) return false
    return kind === 'ordered' ? p.m.ordered : !p.m.ordered
  }
  const off = parsed.filter((p) => p.target).every(isKind)

  const counters = new Map()
  return parsed.map((p) => {
    if (!p.target) return null
    const indent = p.m ? p.m.indent : leadLen(p.text)
    const to = p.m ? p.m.prefixLen : indent
    const pad = ' '.repeat(indent)
    if (off) return { to, insert: pad }
    if (kind === 'ordered') {
      // A shallower item ends every deeper run, so drop those counters.
      for (const level of [...counters.keys()]) if (level > indent) counters.delete(level)
      const n = (counters.get(indent) || 0) + 1
      counters.set(indent, n)
      return { to, insert: `${pad}${n}. ` }
    }
    if (kind === 'task') return { to, insert: `${pad}- ${p.m?.task || '[ ]'} ` }
    return { to, insert: `${pad}- ` }
  })
}

// ---- nesting ---------------------------------------------------------------

// Where the first line of the selection would sit one level deeper: at the
// content column of the nearest preceding item it could become a child of.
// Deriving the step from the parent rather than using a fixed two spaces is
// what makes ordered lists nest — `1. two` puts its children at column 3, and
// two spaces would leave them a lazy continuation of the same paragraph.
//
// Returns null when there is nothing to nest under: the first item of a list
// has no parent, so Tab on it does nothing.
function indentTarget(before, text) {
  const cur = listMarker(text)
  if (!cur) return null
  for (let i = before.length - 1; i >= 0; i--) {
    const line = before[i]
    if (line.trim() === '') continue
    const p = listMarker(line)
    // A non-list line at column 0 ends the list; an indented one is a
    // continuation paragraph inside it, so keep looking.
    if (!p) {
      if (leadLen(line) === 0) return null
      continue
    }
    if (p.indent <= cur.indent) return p.contentCol > cur.indent ? p.contentCol : null
  }
  return null
}

// The mirror image: the indent of the nearest enclosing item, or 0.
function outdentTarget(before, text) {
  const cur = listMarker(text)
  if (!cur || cur.indent === 0) return null
  for (let i = before.length - 1; i >= 0; i--) {
    const line = before[i]
    if (line.trim() === '') continue
    const p = listMarker(line)
    if (!p) {
      if (leadLen(line) === 0) break
      continue
    }
    if (p.indent < cur.indent) return p.indent
  }
  return 0
}

// One delta for the whole selection, taken from its first list line, so
// relative nesting inside the selection survives the move.
function shiftLines(lines, delta) {
  return lines.map((text) => {
    if (text.trim() === '') return null
    const lead = leadLen(text)
    return { to: lead, insert: ' '.repeat(lead + delta) }
  })
}

export function indentLines(lines, before) {
  const first = lines.findIndex((t) => listMarker(t))
  if (first < 0) return lines.map(() => null)
  const target = indentTarget([...before, ...lines.slice(0, first)], lines[first])
  if (target === null) return lines.map(() => null)
  const delta = target - listMarker(lines[first]).indent
  return delta > 0 ? shiftLines(lines, delta) : lines.map(() => null)
}

export function outdentLines(lines, before) {
  const first = lines.findIndex((t) => listMarker(t))
  if (first < 0) return lines.map(() => null)
  const target = outdentTarget([...before, ...lines.slice(0, first)], lines[first])
  if (target === null) return lines.map(() => null)
  // Clamp so no line in the selection is asked to lose more indentation than
  // it has — a deeper child must not be dragged past column 0.
  const room = Math.min(...lines.filter((t) => t.trim() !== '').map(leadLen))
  const delta = Math.min(listMarker(lines[first]).indent - target, room)
  return delta > 0 ? shiftLines(lines, -delta) : lines.map(() => null)
}

// ---- table column alignment ------------------------------------------------

// Split a table row into cells with source offsets. Outer pipes are optional
// in markdown, so the empty segment either side of them is dropped; `\|` is an
// escaped pipe inside a cell, not a separator.
export function rowCells(text) {
  const cells = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '|') {
      cells.push({ from: start, to: i })
      start = i + 1
    }
  }
  cells.push({ from: start, to: text.length })
  const blank = (c) => text.slice(c.from, c.to).trim() === ''
  if (cells.length > 1 && blank(cells[0])) cells.shift()
  if (cells.length > 1 && blank(cells[cells.length - 1])) cells.pop()
  return cells
}

// Which column an offset within a row falls in.
export function columnAt(text, offset) {
  const cells = rowCells(text)
  for (let i = 0; i < cells.length; i++) if (offset <= cells[i].to) return i
  return cells.length - 1
}

// The alignment a delimiter row (`| :--- | ---: |`) encodes for one column.
export function alignAt(text, col) {
  const cell = rowCells(text)[col]
  if (!cell) return 'left'
  const s = text.slice(cell.from, cell.to).trim()
  const left = s.startsWith(':')
  const right = s.endsWith(':')
  return left && right ? 'center' : right ? 'right' : 'left'
}

// Left is written as plain `---`, not `:---`: markdown renders the two
// identically, so a three-state cycle is the whole vocabulary.
export function nextAlign(align) {
  return align === 'left' ? 'center' : align === 'center' ? 'right' : 'left'
}

// Rewrite one delimiter cell, keeping its width — the pipes in the source
// table stay lined up, which is the only reason anyone pads them.
export function setAlign(text, col, align) {
  const cell = rowCells(text)[col]
  if (!cell) return null
  const raw = text.slice(cell.from, cell.to)
  const lead = /^\s*/.exec(raw)[0]
  const trail = /\s*$/.exec(raw.slice(lead.length))[0]
  const width = Math.max(3, raw.length - lead.length - trail.length)
  const body =
    align === 'center'
      ? ':' + '-'.repeat(width - 2) + ':'
      : align === 'right'
        ? '-'.repeat(width - 1) + ':'
        : '-'.repeat(width)
  return { from: cell.from, to: cell.to, insert: lead + body + trail }
}
