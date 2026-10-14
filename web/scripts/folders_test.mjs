// Tree building for the document list. Run from web/: node scripts/folders_test.mjs
import { buildTree, pickerOptions, countDocs, pathTo, UNFILED } from '../src/folders.js'
import { canEdit } from '../src/roles.js'

let failures = 0
const ok = (what) => console.log('ok:', what)
const fail = (what, detail) => {
  failures++
  console.error(`FAIL: ${what}${detail ? '\n  ' + detail : ''}`)
}
const eq = (got, want, what) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(what)
    : fail(what, `got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`)

const f = (id, name, parent_id, role = 'manager') => ({ id, name, parent_id, role })
const d = (id, folder_id) => ({ id, title: id, folder_id, role: 'owner' })

// ---- nesting --------------------------------------------------------------
{
  const { roots } = buildTree(
    [f('a', 'Alpha', null), f('b', 'Beta', 'a'), f('c', 'Gamma', 'b')],
    [d('d1', 'c')],
  )
  eq(roots.length, 1, 'one root')
  eq(roots[0].children[0].children[0].id, 'c', 'nests three deep')
  eq(roots[0].children[0].children[0].docs[0].id, 'd1', 'a document lands in its folder')
}

// ---- folders sort by name, documents keep the order they arrived in -------
{
  const { roots } = buildTree(
    [f('z', 'Zulu', null), f('m', 'Mike', null), f('a', 'Alpha', null)],
    [d('newest', 'a'), d('older', 'a')],
  )
  eq(roots.map((r) => r.name), ['Alpha', 'Mike', 'Zulu'], 'folders sort by name')
  eq(roots[0].docs.map((x) => x.id), ['newest', 'older'], 'documents keep the server order')
}

// ---- the unfiled bucket ---------------------------------------------------
{
  // A null folder_id and a folder_id naming something not in the list are the
  // same situation from here: it is in none of *your* folders. The second is
  // what the server sends for a document shared with you directly out of
  // somebody's folder you cannot see — except the server nulls the id, so this
  // is the belt to that braces.
  const { roots, unfiled } = buildTree([f('a', 'Alpha', null)], [d('mine', null), d('theirs', 'invisible')])
  eq(unfiled.map((x) => x.id), ['mine', 'theirs'], 'both kinds of unfiled land together')
  eq(roots[0].docs.length, 0, 'and neither is invented into a folder')
}

// ---- a parent nobody can see is a root ------------------------------------
{
  // What the server sends somebody granted only the child: the parent id is
  // nulled so the name above is not disclosed. The child must still appear.
  const { roots } = buildTree([f('falcon', 'Falcon', null, 'viewer')], [d('d1', 'falcon')])
  eq(roots.map((r) => r.name), ['Falcon'], 'a child granted alone stands as a root')
}

// ---- the move picker offers only what the server would accept -------------
{
  const { roots } = buildTree(
    [f('a', 'Alpha', null, 'editor'), f('b', 'Beta', 'a', 'editor'), f('r', 'Readonly', null, 'viewer')],
    [],
  )
  const opts = pickerOptions(roots, canEdit)
  eq(opts.map((o) => o.label), ['Alpha', 'Alpha / Beta'], 'paths are labelled, and a viewer folder is not offered')
}

// ---- a collapsed folder still accounts for what is under it ---------------
{
  const { roots } = buildTree(
    [f('a', 'Alpha', null), f('b', 'Beta', 'a')],
    [d('d1', 'a'), d('d2', 'b'), d('d3', 'b')],
  )
  eq(countDocs(roots[0]), 3, 'the count covers the subtree, not just the folder')
}

// ---- the path above a folder, as far as the viewer can see ---------------
{
  const fs = [f('a', 'Alpha', null), f('b', 'Beta', 'a'), f('c', 'Gamma', 'b')]
  eq(pathTo(fs, 'c').map((x) => x.name), ['Alpha', 'Beta', 'Gamma'], 'the path runs root to leaf, inclusive')
  eq(pathTo(fs, 'a').map((x) => x.name), ['Alpha'], 'a root is its own path')
  eq(pathTo(fs, 'nope'), [], 'an unknown folder has no path')
  // Granted only Beta: the server nulls its parent, so the path starts there
  // and Alpha's name is never shown.
  eq(pathTo([f('b', 'Beta', null), f('c', 'Gamma', 'b')], 'c').map((x) => x.name), ['Beta', 'Gamma'],
    'the path starts at the viewer\'s own grant')
}

eq(UNFILED, '__unfiled__', 'the unfiled key is exported for the list to key on')

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall folder tree checks passed')
