// Headless git exporter: mirrors named versions of every doc the exporter
// account can see into a git repository, one commit per pinned version.
//
// Pure HTTP client — no WebSocket, no server changes. It polls /api/docs and
// each doc's /history for named versions it hasn't committed yet, fetches
// /replay?to_seq=<version.seq>, rebuilds the Y.Doc locally, and commits the
// markdown text. The server never learns git exists; document content stays
// opaque to it, as everywhere else.
//
// The repo mirrors the folder tree as the exporter's account sees it. That
// is the one thing to know before granting it anything: the path is per
// viewer, so a document whose folder the account cannot see lands at the top
// level, and granting the account a folder higher up moves every path under
// it. Grant the account at each root it should mirror, and leave it there.
// See DESIGN-DECISIONS.md, *The folder path reaches the exporter*.
//
// Usage:
//   DOCS_EMAIL=... DOCS_PASSWORD=... node scripts/exporter.mjs <server-url> <repo-dir> [--once] [--interval=60]
//
// Run from web/ (node module resolution). --once does a single pass (cron
// friendly); the default is a poll loop. State lives in .docs-export.json at
// the repo root and is committed along with each export, so a clone of the
// repo carries everything needed to continue exporting from it.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { iterFrames } from '../src/frames.js'
import { Workbook } from '../src/sheet/model.js'
import { toCSV } from '../src/sheet/clipboard.js'

const STATE_FILE = '.docs-export.json'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'))
const BASE = args[0]
const REPO = args[1] && path.resolve(args[1])
const ONCE = flags.includes('--once')
const INTERVAL = 1000 * Number((flags.find((f) => f.startsWith('--interval=')) || '--interval=60').split('=')[1])
const EMAIL = process.env.DOCS_EMAIL
const PASSWORD = process.env.DOCS_PASSWORD

if (!BASE || !REPO || !EMAIL || !PASSWORD) {
  console.error('usage: DOCS_EMAIL=... DOCS_PASSWORD=... node scripts/exporter.mjs <server-url> <repo-dir> [--once] [--interval=60]')
  process.exit(2)
}

// ---- server ---------------------------------------------------------------

let cookie = ''

async function login() {
  const res = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`)
  cookie = res.headers.get('set-cookie').split(';')[0]
}

async function api(p) {
  let res = await fetch(BASE + p, { headers: { cookie } })
  if (res.status === 401) { // session expired mid-loop: re-login once
    await login()
    res = await fetch(BASE + p, { headers: { cookie } })
  }
  if (!res.ok) throw new Error(`${p}: ${res.status} ${await res.text()}`)
  return res
}

// ---- git ------------------------------------------------------------------

// Committer identity is passed per-invocation (-c) rather than written into
// the repo config, so the exporter leaves no settings behind.
function git(gitArgs, env = {}) {
  const res = spawnSync('git',
    ['-c', 'user.name=docs exporter', '-c', 'user.email=exporter@docs.invalid', ...gitArgs],
    { cwd: REPO, env: { ...process.env, ...env }, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${gitArgs.join(' ')}: ${res.stderr || res.stdout}`)
  return res.stdout
}

function ensureRepo() {
  fs.mkdirSync(REPO, { recursive: true })
  if (!fs.existsSync(path.join(REPO, '.git'))) {
    git(['init', '-q'])
    console.log('initialized git repo at', REPO)
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, STATE_FILE), 'utf8'))
  } catch {
    return {}
  }
}

// ---- export ---------------------------------------------------------------

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

// The folders the exporter's account can see, by id, refreshed each pass.
let folderIndex = new Map()

// The directory a document lives in: one segment per folder above it, as far
// up as the account can see. Each segment is slugged name plus id suffix, the
// same shape as a document's base name and for the same reason — sibling
// folders may share a name, and a rename must be a rename rather than a merge.
function dirFor(doc) {
  const segs = []
  for (let f = folderIndex.get(doc.folder_id); f; f = f.parent_id ? folderIndex.get(f.parent_id) : null) {
    segs.unshift(`${slugify(f.name) || 'folder'}-${f.id.slice(0, 6)}`)
  }
  return segs.join('/')
}

// Base name: the directory, then slugged title plus a short doc-id suffix, so
// two documents with the same title never collide and a retitle or a move is
// a visible rename in git. A doc becomes `<base>.md`; a sheet becomes a
// `<base>/` directory of one CSV per tab, since CSV has no concept of
// multiple sheets.
function baseFor(doc) {
  const name = `${slugify(doc.title) || 'untitled'}-${doc.id.slice(0, 6)}`
  const dir = dirFor(doc)
  return dir ? `${dir}/${name}` : name
}

// Where a document's files were last written, from the state file. Newer
// state records it; older state only listed the files, and the base is what
// they have in common.
function previousBase(st) {
  if (st.base !== undefined) return st.base
  const first = st.files?.[0] ?? st.path
  if (!first) return undefined
  return first.endsWith('.md') ? first.slice(0, -3) : path.dirname(first)
}

// Remove the directories a set of removed files emptied, so a moved document
// does not leave its old folder behind as an empty tree.
function pruneEmptyDirs(removed) {
  for (const old of removed) {
    for (let dir = path.dirname(path.join(REPO, old)); dir !== REPO; dir = path.dirname(dir)) {
      if (!fs.existsSync(dir) || fs.readdirSync(dir).length > 0) break
      fs.rmdirSync(dir)
    }
  }
}

function writeState(state) {
  fs.writeFileSync(path.join(REPO, STATE_FILE), JSON.stringify(state, null, 2) + '\n')
}

// A document whose base changed since it was last written — moved to another
// folder, or retitled — gets its files moved and one commit saying so, with
// no new content. Without this a move would reach the repo only at the next
// pin, and "the tree mirrors the folders" would be true only eventually.
function relocate(doc, state) {
  const st = state[doc.id]
  const from = previousBase(st)
  const to = baseFor(doc)
  if (from === undefined || from === to) return
  const files = st.files || [st.path]
  const moved = []
  for (const old of files) {
    const next = to + old.slice(from.length)
    const abs = path.join(REPO, next)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    if (fs.existsSync(path.join(REPO, old))) fs.renameSync(path.join(REPO, old), abs)
    moved.push(next)
  }
  pruneEmptyDirs(files)
  st.files = moved
  st.base = to
  delete st.path
  writeState(state)
  git(['add', '-A'])
  git(['commit', '-q', '-m', `${doc.title}: now at ${to}`, '-m', `Docs-Doc: ${doc.id}`])
  console.log(`moved ${from} -> ${to}`)
}

async function docAtSeq(docID, seq) {
  const buf = new Uint8Array(await (await api(`/api/docs/${docID}/replay?to_seq=${seq}`)).arrayBuffer())
  const ydoc = new Y.Doc()
  for (const u of iterFrames(buf)) Y.applyUpdate(ydoc, u)
  return ydoc
}

// The files a version should produce, as {path, text}. Everything is
// rendered from the replayed document, so an export is a pure function of
// a point in history.
async function filesForVersion(doc, seq) {
  const ydoc = await docAtSeq(doc.id, seq)
  const base = baseFor(doc)
  if (doc.kind !== 'sheet') {
    const text = ydoc.getText('text').toString()
    return [{ path: `${base}.md`, text: text.endsWith('\n') || text === '' ? text : text + '\n' }]
  }
  const wb = new Workbook(ydoc)
  const out = []
  const used = new Set()
  for (const tab of wb.list()) {
    // Tab names are free text and may repeat; keep filenames unique
    // without letting tab ORDER into them, so reordering tabs doesn't
    // rewrite every file.
    let name = slugify(tab.name) || 'sheet'
    if (used.has(name)) name = `${name}-${tab.id.slice(0, 4)}`
    used.add(name)
    // Displayed values, not raw: a diff should read "10 → 999", not a date
    // serial. No BOM — that would be noise in every diff.
    out.push({ path: `${base}/${name}.csv`, text: toCSV(wb.sheet(tab.id).toGrid()) + '\n' })
  }
  return out
}

async function exportVersion(doc, v, state) {
  const files = await filesForVersion(doc, v.seq)
  const base = baseFor(doc)
  const st = state[doc.id] || (state[doc.id] = {})

  // Older state recorded a single `path`; treat it as a one-file list.
  const previous = st.files || (st.path ? [st.path] : [])
  const written = new Set(files.map((f) => f.path))
  // A retitle, a renamed tab or a deleted tab leaves files behind. Removing
  // them here is what makes git show a rename or a deletion rather than
  // quietly accumulating orphans.
  for (const old of previous) {
    if (written.has(old)) continue
    const abs = path.join(REPO, old)
    if (fs.existsSync(abs)) fs.rmSync(abs)
  }

  for (const f of files) {
    const abs = path.join(REPO, f.path)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, f.text)
  }
  // Prune directories the removals emptied, so a deleted sheet's folder
  // doesn't linger.
  pruneEmptyDirs(previous)

  st.files = files.map((f) => f.path)
  st.base = base
  delete st.path
  st.last_version_id = v.id
  writeState(state)

  // Author = whoever pinned the version; commit dates = when they pinned it,
  // so git log reads as the document's own timeline.
  const date = `${v.created_at} +0000`
  git(['add', '-A'])
  git(['commit', '-q',
    '--author', `${v.created_by} <exporter@docs.invalid>`,
    '-m', `${doc.title}: ${v.name}`,
    '-m', `Docs-Doc: ${doc.id}\nDocs-Version: ${v.id}`],
    { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
  console.log(`committed ${files.length} file(s) for ${baseFor(doc)} @ seq ${v.seq} ("${v.name}")`)
}

// The top-level documents of the last pass, so the line about them is
// printed when the set changes rather than once a minute.
let lastTopLevel = ''

async function pass() {
  const docs = await (await api('/api/docs')).json() // docs as .md, sheets as CSV directories
  folderIndex = new Map((await (await api('/api/folders')).json()).map((f) => [f.id, f]))
  // The server nulls folder_id on a document whose folder this account cannot
  // see, so from here those are indistinguishable from documents filed
  // nowhere. Both land at the top level, and this is the line to read when a
  // document is not where the app shows it: the account needs a grant on the
  // folder, or one above it.
  const topLevel = docs.filter((d) => !d.folder_id).map((d) => d.id).sort().join(',')
  if (topLevel !== lastTopLevel) {
    lastTopLevel = topLevel
    const n = topLevel ? topLevel.split(',').length : 0
    if (n) console.log(`${n} document(s) at the top level: filed nowhere, or in a folder ${EMAIL} cannot see`)
  }
  const state = readState()
  for (const doc of docs) {
    if (state[doc.id]?.last_version_id) relocate(doc, state)
    const hist = await (await api(`/api/docs/${doc.id}/history`)).json()
    // History returns versions newest-first; commits must go oldest-first.
    const versions = (hist.versions || []).sort((a, b) => a.seq - b.seq || a.id - b.id)
    const last = state[doc.id]?.last_version_id || 0
    for (const v of versions) {
      if (v.id <= last) continue // ids are insert-ordered: already committed
      await exportVersion(doc, v, state)
    }
  }
}

// ---- main -----------------------------------------------------------------

ensureRepo()
await login()
for (;;) {
  try {
    await pass()
  } catch (err) {
    console.error('export pass failed (will retry):', err.message)
  }
  if (ONCE) break
  await new Promise((r) => setTimeout(r, INTERVAL))
}
