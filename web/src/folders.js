// Turning the two flat lists the server sends — folders, documents — into the
// tree the list draws. Pure functions, no DOM and no fetch, so the shape logic
// is testable in node: `node scripts/folders_test.mjs`.
//
// The server decides *what* you can see and hands back a forest rooted at your
// own grants: a folder whose parent you hold no grant on arrives with a null
// parent, so it is a root as far as you are concerned. Nothing here re-derives
// access; it only arranges what arrived.

// The bucket for documents that are in none of your folders. Two different
// situations land here and deliberately look the same, because from where you
// are standing they are the same: a document you filed nowhere, and a document
// shared with you directly that lives in somebody's folder you cannot see.
export const UNFILED = '__unfiled__'

const byName = (a, b) => a.name.localeCompare(b.name)

// buildTree returns { roots, unfiled }. Documents keep the order the server
// sent them — most recently updated first — because that is the order that
// makes a folder's contents useful; folders sort by name, because a folder
// list you have to re-read every time is not a filing system.
export function buildTree(folders, docs) {
  const nodes = new Map()
  for (const f of folders) {
    nodes.set(f.id, { id: f.id, name: f.name, role: f.role, children: [], docs: [] })
  }
  const roots = []
  for (const f of folders) {
    const node = nodes.get(f.id)
    // A parent id that names a folder not in the list is treated as absent.
    // The server already nulls those out; this is what keeps a subtree from
    // disappearing entirely if it ever stops doing so.
    const parent = f.parent_id ? nodes.get(f.parent_id) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const unfiled = []
  for (const d of docs) {
    const holder = d.folder_id ? nodes.get(d.folder_id) : null
    if (holder) holder.docs.push(d)
    else unfiled.push(d)
  }
  roots.sort(byName)
  for (const n of nodes.values()) n.children.sort(byName)
  return { roots, unfiled }
}

// pickerOptions flattens the tree into the destinations a move may name, each
// labelled with its path so two folders called "Notes" are tellable apart.
//
// Filtered by `allowed`, which the caller supplies as canEdit: putting a
// document into a folder is filling it, and filling needs `editor`. Offering
// destinations the server would refuse is how a control comes to look broken.
export function pickerOptions(roots, allowed) {
  const out = []
  const walk = (node, prefix) => {
    const label = prefix ? `${prefix} / ${node.name}` : node.name
    if (allowed(node.role)) out.push({ id: node.id, label })
    for (const c of node.children) walk(c, label)
  }
  for (const r of roots) walk(r, '')
  return out
}

// countDocs is what a collapsed folder shows. It counts the subtree rather
// than the folder itself, so collapsing a branch never makes documents look
// like they went away.
export function countDocs(node) {
  return node.docs.length + node.children.reduce((n, c) => n + countDocs(c), 0)
}
