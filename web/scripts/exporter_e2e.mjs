// End-to-end check of the git exporter against a running server: pins named
// versions through the real pipeline (Provider over WebSocket), runs the
// exporter, and asserts on the resulting git repo. Like e2e.mjs this needs a
// live server, so it is a dev tool rather than part of `make test`.
// Run: node scripts/exporter_e2e.mjs [base-url] [work-dir]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as Y from 'yjs'
import WS from 'ws'
import { Provider } from '../src/provider.js'

const BASE = process.argv[2] || 'http://127.0.0.1:8485'
const WORK = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'docs-exporter-e2e-'))
const REPO = path.join(WORK, 'repo')

let cookie = ''
globalThis.WebSocket = class extends WS {
  constructor(url) {
    super(url, { headers: { cookie } })
  }
}

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, { ...opts, headers: { ...(opts.headers || {}), cookie } })
  const sc = res.headers.get('set-cookie')
  if (sc) cookie = sc.split(';')[0]
  if (!res.ok) throw new Error(`${p}: ${res.status} ${await res.text()}`)
  return res
}

const postJSON = (p, body) =>
  api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function assert(ok, what) {
  if (!ok) throw new Error('FAIL: ' + what)
  console.log('ok:', what)
}

function runExporter(env) {
  const res = spawnSync(process.execPath, ['scripts/exporter.mjs', BASE, REPO, '--once'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  if (res.status !== 0) throw new Error('exporter failed:\n' + res.stderr + res.stdout)
  return res.stdout
}

const git = (...args) => {
  const res = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout.trim()
}

// ---- scenario -------------------------------------------------------------

const email = `exporter-${Date.now()}@test.local`
const password = 'password123'
await postJSON('/api/signup', { email, name: 'Exporter E2E', password })
const doc = await (await postJSON('/api/docs', { title: 'Meeting Notes' })).json()

// Type through the real pipeline and pin two versions.
const ydoc = new Y.Doc()
const p = new Provider(ydoc, doc.id, { wsUrl: `${BASE.replace(/^http/, 'ws')}/ws/${doc.id}`, onSynced: () => (p.synced = true) })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('sync timeout')), 8000)
  const iv = setInterval(() => { if (p.synced) { clearTimeout(t); clearInterval(iv); resolve() } }, 50)
})
ydoc.getText('text').insert(0, '# Meeting Notes\n\n- first point\n')
await sleep(1500) // flush interval
const v1 = await (await postJSON(`/api/docs/${doc.id}/versions`, { name: 'first draft' })).json()
const textAtV1 = ydoc.getText('text').toString()

ydoc.getText('text').insert(ydoc.getText('text').length, '- second point\n')
await sleep(1500)
await postJSON(`/api/docs/${doc.id}/versions`, { name: 'second draft' })
const textAtV2 = ydoc.getText('text').toString()
p.destroy()

// First export: one commit per pinned version, newest content on disk.
const exporterEnv = { DOCS_EMAIL: email, DOCS_PASSWORD: password }
runExporter(exporterEnv)
const mdFile = fs.readdirSync(REPO).find((f) => f.endsWith('.md'))
assert(mdFile === `meeting-notes-${doc.id.slice(0, 6)}.md`, `file named from title+id (${mdFile})`)
assert(fs.readFileSync(path.join(REPO, mdFile), 'utf8') === textAtV2, 'working tree holds latest version')
assert(git('rev-list', '--count', 'HEAD') === '2', 'two commits for two versions')
assert(git('log', '--format=%s', '-1', 'HEAD~1') === 'Meeting Notes: first draft', 'oldest commit is the first pin')
assert(git('log', '--format=%s', '-1') === 'Meeting Notes: second draft', 'newest commit is the second pin')
assert(git('show', `HEAD~1:${mdFile}`) + '\n' === textAtV1, 'first commit contains first-pin content')
assert(git('log', '--format=%an', '-1') === 'Exporter E2E', 'author is whoever pinned')
assert(git('log', '--format=%B', '-1').includes(`Docs-Version:`), 'trailer records version id')

// Second run with nothing new: no commits added.
runExporter(exporterEnv)
assert(git('rev-list', '--count', 'HEAD') === '2', 'rerun is idempotent')

// Retitle, pin again: the file is renamed in the next commit.
await api(`/api/docs/${doc.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Sprint Notes' }) })
const ydoc2 = new Y.Doc()
const p2 = new Provider(ydoc2, doc.id, { wsUrl: `${BASE.replace(/^http/, 'ws')}/ws/${doc.id}`, onSynced: () => (p2.synced = true) })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('sync timeout')), 8000)
  const iv = setInterval(() => { if (p2.synced) { clearTimeout(t); clearInterval(iv); resolve() } }, 50)
})
ydoc2.getText('text').insert(ydoc2.getText('text').length, '- renamed\n')
await sleep(1500)
await postJSON(`/api/docs/${doc.id}/versions`, { name: 'after rename' })
p2.destroy()

runExporter(exporterEnv)
const files = fs.readdirSync(REPO).filter((f) => f.endsWith('.md'))
assert(files.length === 1 && files[0] === `sprint-notes-${doc.id.slice(0, 6)}.md`, `retitle renames the file (${files})`)
assert(git('rev-list', '--count', 'HEAD') === '3', 'rename+pin is one more commit')

console.log('\nALL PASS (repo at ' + REPO + ')')
process.exit(0)
