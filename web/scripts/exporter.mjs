// Headless git exporter: mirrors named versions of every doc the exporter
// account can see into a git repository, one commit per pinned version.
//
// Pure HTTP client — no WebSocket, no server changes. It polls /api/docs and
// each doc's /history for named versions it hasn't committed yet, fetches
// /replay?to_seq=<version.seq>, rebuilds the Y.Doc locally, and commits the
// markdown text. The server never learns git exists; document content stays
// opaque to it, as everywhere else.
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

// Base name: slugged title plus a short doc-id suffix, so two documents
// with the same title never collide and a retitle is a visible rename in
// git. A doc becomes `<base>.md`; a sheet becomes a `<base>/` directory of
// one CSV per tab, since CSV has no concept of multiple sheets.
function baseFor(doc) {
  return `${slugify(doc.title) || 'untitled'}-${doc.id.slice(0, 6)}`
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
  for (const old of previous) {
    const dir = path.dirname(path.join(REPO, old))
    if (dir !== REPO && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  }

  st.files = files.map((f) => f.path)
  delete st.path
  st.last_version_id = v.id
  fs.writeFileSync(path.join(REPO, STATE_FILE), JSON.stringify(state, null, 2) + '\n')

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

async function pass() {
  const docs = await (await api('/api/docs')).json() // docs as .md, sheets as CSV directories
  const state = readState()
  for (const doc of docs) {
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
