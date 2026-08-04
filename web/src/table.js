// Table extraction: turns a lezer `Table` syntax node into plain data for
// the table widget. No CodeMirror imports — it only walks syntax nodes and
// reads text through the provided slice function, so it can be tested in
// node without a DOM (scripts/table_test.mjs).

// Returns { header: [..], aligns: ['left'|'center'|'right', ..], rows: [[..]] }
export function parseTableData(tableNode, slice) {
  const data = { header: [], aligns: [], rows: [] }
  for (let child = tableNode.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableHeader') {
      data.header = cellTexts(child, slice)
    } else if (child.name === 'TableDelimiter') {
      data.aligns = parseAligns(slice(child.from, child.to))
    } else if (child.name === 'TableRow') {
      data.rows.push(cellTexts(child, slice))
    }
  }
  return data
}

function cellTexts(rowNode, slice) {
  const out = []
  for (let c = rowNode.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableCell') out.push(slice(c.from, c.to).trim())
  }
  return out
}

// The delimiter row (`| :--- | ---: |`) encodes per-column alignment.
function parseAligns(text) {
  return text
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const left = s.startsWith(':')
      const right = s.endsWith(':')
      if (left && right) return 'center'
      if (right) return 'right'
      return 'left'
    })
}
