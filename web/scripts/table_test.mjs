// Tests table.js extraction against real lezer-markdown parses.
// Run: node scripts/table_test.mjs
import { markdownLanguage } from '@codemirror/lang-markdown'
import { parseTableData } from '../src/table.js'

let failed = 0
function check(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    console.log('ok:', name)
  } else {
    failed++
    console.log(`FAIL: ${name}\n  got  ${g}\n  want ${w}`)
  }
}

function extract(doc) {
  const tree = markdownLanguage.parser.parse(doc)
  let result = null
  tree.iterate({
    enter(n) {
      if (n.name === 'Table' && !result) {
        result = parseTableData(n.node, (a, b) => doc.slice(a, b))
        return false
      }
    },
  })
  return result
}

check('basic table', extract(
`| Name | Age |
| ---- | --- |
| Ada  | 36  |
| Bob  | 41  |`), {
  header: ['Name', 'Age'],
  aligns: ['left', 'left'],
  rows: [['Ada', '36'], ['Bob', '41']],
})

check('alignment row', extract(
`| L | C | R |
| :-- | :-: | --: |
| a | b | c |`), {
  header: ['L', 'C', 'R'],
  aligns: ['left', 'center', 'right'],
  rows: [['a', 'b', 'c']],
})

check('ragged rows survive', extract(
`| A | B | C |
| - | - | - |
| only |
| x | y | z |`), {
  header: ['A', 'B', 'C'],
  aligns: ['left', 'left', 'left'],
  rows: [['only'], ['x', 'y', 'z']],
})

check('no outer pipes', extract(
`Name | Age
---- | ---
Ada | 36`), {
  header: ['Name', 'Age'],
  aligns: ['left', 'left'],
  rows: [['Ada', '36']],
})

if (failed > 0) process.exit(1)
console.log('\nALL PASS')
