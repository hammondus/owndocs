// Runs a user script in a sandboxed iframe and brokers its calls to the
// script API. This is the only browser-specific half of scripting; what
// the calls DO lives in scriptapi.js and is tested headlessly.
//
// Why an iframe rather than eval:
//
// A script lives in the document, and documents get shared. So the threat
// is not "the user runs their own code" — it is "someone shares a sheet
// whose script runs as YOU". Plain eval would give that script the page's
// origin: session cookie, API access, the lot. Instead the iframe is
// created with `sandbox="allow-scripts"` and WITHOUT `allow-same-origin`,
// which puts it in a unique opaque origin: no cookies, no storage, no
// access to the parent document, and no ability to call our API as the
// signed-in user. A CSP of `connect-src 'none'` removes the network, so a
// script cannot exfiltrate what it reads either. Everything it can do it
// must ask for by postMessage, and the host decides.
//
// `unsafe-eval` is granted INSIDE the sandbox on purpose — running
// arbitrary code is the entire feature. The isolation comes from the
// opaque origin and the absent network, not from restricting eval.
//
// Residual risk, recorded rather than hidden: a script can still make
// destructive *edits* as the person who ran it. That is why nothing runs
// automatically — see the no-triggers note in DESIGN-DECISIONS.md — and
// why every edit it makes is undoable and lands in version history.

// Exported so tests can evaluate it against a fake message channel in node.
// It only ever touches `parent` and `window`, so it runs anywhere those can
// be supplied — which is what makes the protocol testable without a browser.
export const RUNTIME = String.raw`
(function () {
  var seq = 0
  var pending = new Map()

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq
      pending.set(id, { resolve: resolve, reject: reject })
      parent.postMessage({ t: 'call', id: id, method: method, args: args }, '*')
    })
  }

  function show(v) {
    if (typeof v === 'string') return v
    try { return JSON.stringify(v) } catch (e) { return String(v) }
  }

  var log = function () {
    var parts = []
    for (var i = 0; i < arguments.length; i++) parts.push(show(arguments[i]))
    parent.postMessage({ t: 'log', text: parts.join(' ') }, '*')
  }

  // The object scripts are written against. Every method is async because
  // each one is a round trip to the host.
  var docs = {
    sheets: function () { return call('sheets') },
    get: function (range, sheet) { return call('get', { range: range, sheet: sheet }) },
    getText: function (range, sheet) { return call('getText', { range: range, sheet: sheet }) },
    getFormulas: function (range, sheet) { return call('getFormulas', { range: range, sheet: sheet }) },
    set: function (range, values, sheet) { return call('set', { range: range, values: values, sheet: sheet }) },
    format: function (range, format, sheet) { return call('setFormat', { range: range, format: format, sheet: sheet }) },
    clear: function (range, sheet) { return call('clear', { range: range, sheet: sheet }) },
    insertRows: function (at, count, sheet) { return call('insertRows', { at: at, count: count, sheet: sheet }) },
    deleteRows: function (at, count, sheet) { return call('deleteRows', { at: at, count: count, sheet: sheet }) },
    addSheet: function (name) { return call('addSheet', { name: name }) },
    usedRange: function (sheet) { return call('usedRange', { sheet: sheet }) },
    log: log,
  }

  window.addEventListener('message', function (e) {
    var msg = e.data
    if (!msg) return
    if (msg.t === 'result') {
      var p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error))
      else p.resolve(msg.value)
      return
    }
    if (msg.t === 'run') {
      var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      var fn
      try {
        // An async wrapper so scripts can await at the top level.
        fn = new AsyncFunction('docs', 'log', msg.code)
      } catch (err) {
        parent.postMessage({ t: 'done', error: 'SyntaxError: ' + err.message }, '*')
        return
      }
      Promise.resolve()
        .then(function () { return fn(docs, log) })
        .then(function () { parent.postMessage({ t: 'done' }, '*') })
        .catch(function (err) {
          parent.postMessage({ t: 'done', error: String(err && err.stack || err) }, '*')
        })
    }
  })

  parent.postMessage({ t: 'ready' }, '*')
})()
`

const SRCDOC = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'">
<script>${RUNTIME}<\/script>`

export const DEFAULT_TIMEOUT_MS = 5000

// Run `code` against `workbook`, calling onLog for each log line. Resolves
// with {error} or {} when the script finishes. A fresh iframe per run, so
// one script can never leave state behind for the next.
export function runScript(code, { workbook, dispatch, onLog, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    // No allow-same-origin: that is what makes the origin opaque.
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.style.display = 'none'
    frame.srcdoc = SRCDOC

    let finished = false
    let timer = 0

    const cleanup = () => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      frame.remove()
    }
    const finish = (result) => {
      if (finished) return
      finished = true
      cleanup()
      resolve(result)
    }

    function onMessage(e) {
      // Identity, not origin: a sandboxed frame's origin is the string
      // "null", which anyone could claim. The window reference cannot be
      // forged.
      if (e.source !== frame.contentWindow) return
      const msg = e.data
      if (!msg || finished) return
      if (msg.t === 'ready') {
        frame.contentWindow.postMessage({ t: 'run', code }, '*')
      } else if (msg.t === 'log') {
        onLog?.(String(msg.text))
      } else if (msg.t === 'call') {
        const res = dispatch(workbook, msg.method, msg.args)
        frame.contentWindow.postMessage(
          { t: 'result', id: msg.id, value: res.value, error: res.error }, '*')
      } else if (msg.t === 'done') {
        finish(msg.error ? { error: msg.error } : {})
      }
    }

    window.addEventListener('message', onMessage)
    document.body.appendChild(frame)

    // Removing the iframe is what stops a runaway script: it destroys the
    // whole execution context. Caveat, recorded honestly: if the script is
    // a tight synchronous loop AND the browser gave the frame the same
    // process as the page, the main thread may be blocked and this timer
    // cannot fire. Chrome normally isolates opaque-origin frames, so in
    // practice it fires. A real interrupt would need QuickJS in WASM.
    timer = setTimeout(() => {
      finish({ error: `script timed out after ${timeoutMs}ms and was stopped` })
    }, timeoutMs)
  })
}
