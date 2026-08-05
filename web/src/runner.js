// The runner's JavaScript half: the document model and the script API,
// bundled for the Go binary to execute inside Sobek.
//
// Go owns the socket, the clock and the loop; this file owns the CRDT and
// nothing else. That split is why no JavaScript event loop is needed —
// every call Go makes returns before it returns, and a user script's
// `await` resolves against values that are already present.
//
// It exists so the headless runner shares the EXACT code the browser runs.
// A reimplementation of the model in Go would need a Go CRDT and would
// drift from the browser the first time either side changed.
import * as Y from 'yjs'
import { Workbook, FIRST_SHEET } from './sheet/model.js'
import { handleCall } from './sheet/scriptapi.js'
import { iterFrames } from './frames.js'

let doc = null
let workbook = null
let pending = [] // local updates not yet handed to Go
const REMOTE = Symbol('remote') // origin for updates arriving from the server

function show(v) {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

globalThis.docsInit = function () {
  doc = new Y.Doc()
  workbook = new Workbook(doc)
  pending = []
  doc.on('update', (update, origin) => {
    // Anything not applied from the server is ours to send on.
    if (origin !== REMOTE) pending.push(update)
  })
  return doc.clientID
}

// One server->client doc message: a sequence of length-prefixed frames.
// A single undecodable frame is skipped rather than aborting the rest,
// matching the browser provider — and reported, so the runner can refuse
// to write into a document it may have read incompletely.
globalThis.docsApplyBatch = function (buf) {
  let bad = 0
  for (const update of iterFrames(new Uint8Array(buf))) {
    try {
      Y.applyUpdate(doc, update, REMOTE)
    } catch {
      bad++
    }
  }
  return bad
}

// Everything written since the last call, merged into one update, or null.
globalThis.docsPending = function () {
  if (!pending.length) return null
  const merged = pending.length === 1 ? pending[0] : Y.mergeUpdates(pending)
  pending = []
  return merged.slice().buffer
}

// The state vector, so the runner can send only what the server lacks
// after a reconnect — the same diff-not-full-state rule as the browser.
globalThis.docsStateVector = function () {
  return Y.encodeStateVector(doc).slice().buffer
}

globalThis.docsDiffFrom = function (buf) {
  const scratch = new Y.Doc()
  for (const update of iterFrames(new Uint8Array(buf))) {
    try {
      Y.applyUpdate(scratch, update)
    } catch {
      // A frame the runner cannot read is one it cannot have applied
      // either; the diff will simply include that content.
    }
  }
  const diff = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(scratch))
  scratch.destroy()
  return diff.length > 2 ? diff.slice().buffer : null // 2 bytes = empty
}

// Bodies are fetched one at a time, so listing a document's scripts does
// not haul every line of code across the Go/JS boundary.
globalThis.docsScriptCode = function (id) {
  const s = workbook.listScripts().find((x) => x.id === id)
  return s ? s.code || '' : ''
}

globalThis.docsScripts = function () {
  return JSON.stringify(workbook.listScripts().map((s) => ({
    id: s.id, name: s.name, trigger: s.trigger || null,
  })))
}

// Starting a script and collecting its result are two calls, because a
// promise callback is a microtask: it cannot run until the JavaScript job
// that queued it returns to Go. Checking inside docsRun always saw an
// unsettled promise, however trivial the script.
let runState = null

globalThis.docsRun = function (code, eventJSON) {
  const logs = []
  const log = (...args) => logs.push(args.map(show).join(' '))
  runState = { logs, error: null, done: false }

  const call = (method, args) => {
    const res = handleCall(workbook, method, args)
    if (res.error) throw new Error(res.error)
    return res.value
  }
  const docs = {
    sheets: () => call('sheets'),
    get: (range, sheet) => call('get', { range, sheet }),
    getText: (range, sheet) => call('getText', { range, sheet }),
    getFormulas: (range, sheet) => call('getFormulas', { range, sheet }),
    set: (range, values, sheet) => call('set', { range, values, sheet }),
    format: (range, format, sheet) => call('setFormat', { range, format, sheet }),
    clear: (range, sheet) => call('clear', { range, sheet }),
    insertRows: (at, count, sheet) => call('insertRows', { at, count, sheet }),
    deleteRows: (at, count, sheet) => call('deleteRows', { at, count, sheet }),
    addSheet: (name) => call('addSheet', { name }),
    usedRange: (sheet) => call('usedRange', { sheet }),
    log,
  }

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  let fn
  try {
    fn = new AsyncFunction('docs', 'log', 'event', code)
  } catch (err) {
    runState = { logs, error: 'SyntaxError: ' + err.message, done: true }
    return
  }

  fn(docs, log, eventJSON ? JSON.parse(eventJSON) : null)
    .then(() => { runState.done = true })
    .catch((err) => {
      runState.error = String((err && err.stack) || err)
      runState.done = true
    })
}

// Called by Go after docsRun returns, which is when the microtask queue
// gets its chance to run. `done` false here means the script awaited
// something the runner cannot resolve — a timer, a fetch — rather than an
// API call, which resolves immediately.
globalThis.docsRunResult = function () {
  return JSON.stringify(runState || { logs: [], error: 'nothing was run', done: true })
}
