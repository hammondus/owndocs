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

// Filename: slugged title plus a short doc-id suffix, so two docs with the
// same title never collide and a retitle is a visible rename in git.
function fileFor(doc) {
  const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled'
  return `${slug}-${doc.id.slice(0, 6)}.md`
}

async function textAtSeq(docID, seq) {
  const buf = new Uint8Array(await (await api(`/api/docs/${docID}/replay?to_seq=${seq}`)).arrayBuffer())
  const ydoc = new Y.Doc()
  for (const u of iterFrames(buf)) Y.applyUpdate(ydoc, u)
  return ydoc.getText('text').toString()
}

async function exportVersion(doc, v, state) {
  const text = await textAtSeq(doc.id, v.seq)
  const st = state[doc.id] || (state[doc.id] = {})
  const file = fileFor(doc)
  if (st.path && st.path !== file && fs.existsSync(path.join(REPO, st.path))) {
    fs.rmSync(path.join(REPO, st.path)) // retitled: old name goes, git sees a rename
  }
  fs.writeFileSync(path.join(REPO, file), text.endsWith('\n') || text === '' ? text : text + '\n')
  st.path = file
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
  console.log(`committed ${file} @ seq ${v.seq} ("${v.name}")`)
}

async function pass() {
  const docs = (await (await api('/api/docs')).json()).filter((d) => d.kind === 'doc')
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
