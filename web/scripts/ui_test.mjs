// Browser-level checks: the only tests here that mount a component.
//
// Three incidents in DESIGN-DECISIONS.md share one signature — a thrown error
// inside a Svelte {#if} block presents as a *dead control*, not a crash. The
// page keeps working, nothing looks broken, and the only evidence is a console
// nobody is reading. So the single highest-value assertion in this file is not
// any particular interaction: it is **the console stayed clean**. Every step
// below runs under that check.
//
// Run: node scripts/ui_test.mjs   (or `make test-ui` from the repo root)
//
// puppeteer-core, not puppeteer or playwright: those download their own
// ~150 MB browser, this one drives the Chrome already on the machine. It is a
// devDependency, never in the binary, and never cross-compiled — the deploy
// target has no browser and does not want one.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const PORT = process.env.UI_TEST_PORT || 8599 // never 8484: that is the dev instance
const BASE = `http://127.0.0.1:${PORT}`
const BIN = join(import.meta.dirname, '../../docs')

// Chrome is found, never downloaded. CHROME_PATH overrides for a machine that
// keeps it somewhere else.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

let failures = 0
const ok = (what) => console.log('ok:', what)
const fail = (what, detail) => {
  failures++
  console.error(`FAIL: ${what}${detail ? '\n  ' + detail : ''}`)
}

function check(cond, what, detail) {
  cond ? ok(what) : fail(what, detail)
}

// ---- harness ---------------------------------------------------------------

async function findChrome() {
  const { access } = await import('node:fs/promises')
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path)
      return path
    } catch {}
  }
  throw new Error(
    `no Chrome found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to override.`,
  )
}

async function startServer(dbDir) {
  const proc = spawn(BIN, ['-dev', '-addr', `127.0.0.1:${PORT}`, '-db', join(dbDir, 'ui.db')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stderr.on('data', (b) => process.env.UI_TEST_VERBOSE && process.stderr.write(b))
  // Poll rather than sleep: a fixed wait is either slow or flaky, and this is
  // the loop every CI failure otherwise gets blamed on.
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(BASE + '/')
      if (res.ok) return proc
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  proc.kill()
  throw new Error(`server did not come up on ${BASE}`)
}

// Errors are collected per *step* so a failure names the click that caused it,
// rather than surfacing at the end of the run detached from its cause.
//
// The browser logs a "Failed to load resource" console error for any non-2xx,
// including two the app makes on purpose: the /api/me probe that decides
// whether to show the sign-in form, and a favicon this project does not ship.
// Those are matched by URL, not by message text, so a genuinely broken request
// to some *other* endpoint still fails the step.
const EXPECTED_4XX = [/\/api\/me$/, /favicon\.ico$/]

function watchConsole(page) {
  const errors = []
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const url = m.location()?.url || ''
    if (EXPECTED_4XX.some((re) => re.test(url))) return
    errors.push(`console: ${m.text()}${url ? ` (${url})` : ''}`)
  })
  // An uncaught exception is never expected. This is the one that catches a
  // component throwing inside {#if} and presenting as a dead control.
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return { drain: () => errors.splice(0) }
}

// clickText finds a control by its visible label, the way a person would.
// Selectors tied to Svelte's scoped class hashes break on every recompile.
//
// The click is *dispatched* rather than driven through puppeteer's synthetic
// mouse. ElementHandle.click() waits for the element to stop moving first, and
// on a live page it never does — the editor header re-renders as sync status
// and peer count change, so a click on a link beside them hangs forever rather
// than timing out. The trade-off is real and worth stating: a dispatched click
// does not exercise hit-testing, so a control hidden behind an overlay would
// still register here. That is a class of bug this file cannot see.
async function clickText(page, tag, text) {
  const clicked = await page.evaluate(
    (tag, text) => {
      const el = [...document.querySelectorAll(tag)].find((e) =>
        e.textContent.trim().includes(text),
      )
      if (!el) return false
      el.click()
      return true
    },
    tag,
    text,
  )
  if (!clicked) throw new Error(`no <${tag}> containing ${JSON.stringify(text)}`)
}

const docIdFromHash = (url) => new URL(url).hash.replace(/^#doc=/, '')

// How many update rows the server has stored for the open document. Used to
// wait for a flush rather than sleeping through it.
const loggedRows = (page) =>
  page.evaluate(async () => {
    const id = location.hash.replace(/^#doc=/, '')
    const h = await (await fetch(`/api/docs/${id}/history`)).json()
    return h.sessions.reduce((a, s) => a + s.rows, 0)
  })

const textOf = (page, sel) =>
  page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel)

// ---- the run ---------------------------------------------------------------

// A watchdog, because a hung UI test is worse than a failing one: it stalls
// `make test-ui` indefinitely and reports nothing. Every step has its own
// timeout, but a hang inside puppeteer itself escapes those.
const watchdog = setTimeout(() => {
  console.error('\nFAIL: the suite hung — no step completed within 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const dbDir = await mkdtemp(join(tmpdir(), 'docs-ui-'))
const chrome = await findChrome()
const server = await startServer(dbDir)
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  // A throwaway profile, so this never touches the developer's own Chrome
  // session, cookies or extensions.
  userDataDir: join(dbDir, 'profile'),
  args: ['--no-first-run', '--no-default-browser-check'],
})

try {
  const page = await browser.newPage()
  const console_ = watchConsole(page)

  // A native confirm() blocks the page completely — no timer, no event, no
  // in-page poll runs until it is answered — so an unhandled one hangs the
  // suite rather than failing it. This app uses confirm() for destructive
  // actions (restore, delete a sheet, delete a thread), so the harness answers
  // yes. Any step that clicks such a control is therefore asserting the
  // *confirmed* path; there is no test here of someone clicking Cancel.
  const dialogs = []
  page.on('dialog', async (d) => {
    dialogs.push(d.message())
    await d.accept()
  })

  // A step is "do a thing, then assert nothing was logged doing it".
  // On failure, say what was actually on screen. A bare "waiting failed" sends
  // you back to the browser by hand, which is the cost this file exists to
  // remove.
  // Guarded: the page may be gone by the time a failure is being reported —
  // a detached frame must not replace the real error with its own.
  const visible = async () => {
    try {
      const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim())
      return t.slice(0, 300)
    } catch {
      return '(page unavailable)'
    }
  }

  const step = async (what, fn) => {
    let thrown = null
    try {
      await fn()
    } catch (e) {
      thrown = e
    }
    // Drain even when the step threw. A step usually fails by *timing out on a
    // selector*, while the console holds the reason — "canEdit is not defined"
    // rather than "waiting failed". Reporting only the timeout sends you back
    // to the browser by hand, which is the cost this file exists to remove.
    const errs = console_.drain()
    if (!thrown && errs.length === 0) return ok(what)
    fail(
      what,
      [
        thrown && thrown.message,
        ...errs,
        thrown && `on screen: ${await visible()}`,
      ]
        .filter(Boolean)
        .join('\n  '),
    )
  }

  await step('load and sign in', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle0' })
    await clickText(page, 'button', 'Alice')
    await page.waitForSelector('form input[placeholder="new document title"]')
  })

  await step('create and open a sheet', async () => {
    await page.type('input[placeholder="new document title"]', 'UI test sheet')
    await page.select('select', 'sheet')
    await clickText(page, 'button', 'Create')
    await page.waitForSelector('canvas')
  })

  // The regression that started this file: threadLabel threw, the {#if} block
  // never rendered, and the button looked inert.
  await step('open the comments panel', async () => {
    await clickText(page, 'button', 'comments')
    await page.waitForFunction(
      () => [...document.querySelectorAll('strong')].some((s) => s.textContent === 'Comments'),
      { timeout: 3000 },
    )
  })

  await step('write a comment on the selected cell', async () => {
    await page.type('textarea', 'does this number look right?')
    await clickText(page, 'button', 'comment on A1')
    await page.waitForFunction(
      () => document.body.textContent.includes('does this number look right?'),
      { timeout: 3000 },
    )
  })

  await step('the header count reflects the new thread', async () => {
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('(1)')),
      { timeout: 3000 },
    )
  })

  await step('reply to the thread', async () => {
    await page.type('input[placeholder="Reply…"]', 'checked, it is current')
    await clickText(page, 'button', 'reply')
    await page.waitForFunction(() => document.body.textContent.includes('checked, it is current'), {
      timeout: 3000,
    })
  })

  await step('resolve the thread, and the count clears', async () => {
    await clickText(page, 'button', 'resolve')
    // Assert on the header toggle specifically. "show resolved (1)" appears at
    // the same moment and also contains "(1)" — the first version of this
    // check matched it and failed.
    await page.waitForFunction(
      () => !document.querySelector('button.linkish')?.textContent.includes('(1)'),
      { timeout: 3000 },
    )
  })

  // A second sheet is the case the panel crashed on: workbook.sheet() hands
  // back a fresh, never-indexed model for any tab that has not been drawn.
  await step('a thread on an unopened second sheet resolves its label', async () => {
    await page.click('button.add') // the "+" tab
    await page.waitForFunction(() => document.body.textContent.includes('Sheet2'), {
      timeout: 3000,
    })
    await page.type('textarea', 'comment over on sheet 2')
    await clickText(page, 'button', 'comment on A1')
    await page.waitForFunction(() => document.body.textContent.includes('comment over on sheet 2'), {
      timeout: 3000,
    })
    // Back to the first tab: the panel must now label a thread on a sheet the
    // *other* model owns, which is exactly the unindexed path.
    await clickText(page, 'button', 'Sheet1')
    await page.waitForFunction(() => document.body.textContent.includes('Sheet2!A1'), {
      timeout: 3000,
    })
  })

  await step('open a markdown document', async () => {
    await clickText(page, 'a', '← documents')
    await page.waitForSelector('input[placeholder="new document title"]')
    await page.type('input[placeholder="new document title"]', 'UI test doc')
    await clickText(page, 'button', 'Create')
    await page.waitForSelector('.cm-content')
  })

  // Restore patches the differences rather than replacing the text, so that
  // comment anchors outside the changed region survive it (see diff.js). The
  // unit tests prove the algorithm; this proves the wiring.
  await step('type into the document', async () => {
    await page.focus('.cm-content')
    await page.keyboard.type('first line\nsecond line')
    await page.waitForFunction(() => document.body.innerText.includes('second line'), {
      timeout: 5000,
    })
  })

  await step('pin the current version', async () => {
    await clickText(page, 'a', 'history')
    await page.waitForSelector('input[placeholder="name current version"]', { timeout: 5000 })
    await page.type('input[placeholder="name current version"]', 'before the change')
    await clickText(page, 'button', 'Pin')
    await page.waitForFunction(() => document.body.innerText.includes('Named versions'), {
      timeout: 5000,
    })
  })

  await step('edit the document again, and wait for it to reach the server', async () => {
    await clickText(page, 'a', '← back to document')
    await page.waitForSelector('.cm-content', { timeout: 5000 })
    const before = await loggedRows(page)
    await page.focus('.cm-content')
    await page.keyboard.type('\nA THIRD LINE')
    await page.waitForFunction(() => document.body.innerText.includes('A THIRD LINE'), {
      timeout: 5000,
    })
    // Wait until the edit is actually *persisted*, not merely typed. The room
    // batches updates to SQLite roughly once a second, and navigating away
    // before that flush drops the edit — which silently made the first version
    // of this test pass even with the patcher stubbed out to do nothing.
    await page.waitForFunction(
      async (docId, before) => {
        const h = await (await fetch(`/api/docs/${docId}/history`)).json()
        return h.sessions.reduce((a, s) => a + s.rows, 0) > before
      },
      { timeout: 10000, polling: 300 },
      docIdFromHash(await page.url()),
      before,
    )
  })

  // Renaming through the header. The endpoint predates the UI by a long way;
  // this covers the wiring that finally exposed it.
  await step('rename the document from its header', async () => {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('strong')].find((s) =>
        s.textContent.includes('UI test doc'),
      )
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await page.waitForSelector('input.title', { timeout: 3000 })
    // Cleared directly rather than by select-all: the field is uncontrolled
    // and commit reads event.target.value, so this is exactly what a user
    // clearing it produces. Select-all silently appended instead, and the
    // rename "failed" by succeeding with the wrong title.
    await page.$eval('input.title', (el) => {
      el.value = ''
    })
    await page.focus('input.title')
    await page.keyboard.type('Renamed By Test')
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('strong')].some(
          (s) => s.textContent.trim() === 'Renamed By Test',
        ),
      { timeout: 3000 },
    )
  })

  // Reading preferences: a viewer-level display choice, so the assertion is
  // that it reaches the rendered editor and survives a reload — it lives in
  // localStorage, not in the document.
  await step('set a reading preference, and it persists', async () => {
    await clickText(page, 'button', 'Aa')
    await page.waitForSelector('#rp-font', { timeout: 3000 })
    await page.select('#rp-font', 'serif')
    await page.select('#rp-size', '20')
    await page.waitForFunction(
      () => {
        const cs = getComputedStyle(document.querySelector('.cm-editor'))
        return cs.fontSize === '20px' && /Georgia|Charter|Times/.test(cs.fontFamily)
      },
      { timeout: 3000 },
    )
    await page.reload({ waitUntil: 'networkidle0' })
    await page.waitForSelector('.cm-editor', { timeout: 5000 })
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('.cm-editor')).fontSize === '20px',
      { timeout: 3000 },
    )
  })

  // The document itself must be untouched — the whole point of putting
  // appearance in the viewer is that it never reaches the file. Asserted as
  // "no update rows appeared", since that is the observable form of it;
  // searching the history JSON proves nothing, because that endpoint returns
  // session metadata and never content.
  await step('changing a preference writes nothing to the document', async () => {
    const before = await loggedRows(page)
    await clickText(page, 'button', 'Aa')
    await page.waitForSelector('#rp-lh', { timeout: 3000 })
    await page.select('#rp-lh', '1.8')
    // Asserting an absence needs a wait: the room batches updates to SQLite
    // about once a second, so anything this triggered would land inside this.
    await new Promise((r) => setTimeout(r, 1800))
    const after = await loggedRows(page)
    if (after !== before) {
      throw new Error(`a reading preference produced ${after - before} document update(s)`)
    }
  })

  // Comments on a markdown document. Asserts the panel mounts and renders
  // against a real document without throwing — the failure mode that has bitten
  // this project three times, where a component throws inside {#if} and the
  // control merely looks dead. This step is also what caught the repaint being
  // dispatched from inside a Yjs observer.
  //
  // NOT covered, and deliberately so rather than silently: selecting text and
  // composing a comment on it. The selection itself drives fine (select-all
  // through CodeMirror's own keymap), but the compose click does not produce a
  // thread here and I have not found why within a sensible budget. The anchor
  // logic underneath is covered properly in diff_test.mjs against a real
  // Y.Doc — round trip, survives an insert before it, unaffected by one after
  // it, does not swallow text typed at its boundary, does not resolve to its
  // old word once deleted. What remains unverified is the click path.
  await step('open the comments panel on a document', async () => {
    await clickText(page, 'button', 'comments')
    await page.waitForFunction(
      () => [...document.querySelectorAll('strong')].some((s) => s.textContent === 'Comments'),
      { timeout: 3000 },
    )
    await clickText(page, 'button', 'close')
  })

  // Smoke coverage of the restore *flow*: pin, edit, restore, land back on the
  // document without a console error. Text-level correctness of the patcher is
  // diff_test.mjs's job, including the anchor-survival property that is the
  // reason restore stopped replacing the whole document.
  //
  // Known limitation, stated rather than implied: this step still passes with
  // the patcher stubbed to emit no operations, and I have not worked out why —
  // the earlier suspects (asserting against the history view's own preview
  // CodeMirror, and an edit that had not been flushed to the server) are both
  // fixed above and it still does not discriminate. So treat this as "restore
  // does not blow up", not "restore produces the right text".
  await step('restore the pin, and the later edit is undone', async () => {
    await clickText(page, 'a', 'history')
    await page.waitForSelector('a[href^="#v"]', { timeout: 5000 })
    // Dispatched, not page.click(): puppeteer's click waits for the element to
    // stop moving and the timeline re-renders as sessions load.
    await page.$eval('a[href^="#v"]', (el) => el.click())
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Restore')),
      { timeout: 5000 },
    )
    await clickText(page, 'button', 'Restore this version')
    // Wait to be back on the *document* first. The history view mounts its own
    // read-only CodeMirror for the preview, so `.cm-content` matches there too
    // — the first version of this step asserted against the preview pane,
    // which shows the pinned text by definition and could never fail.
    await page.waitForFunction(() => !document.body.innerText.includes('History of'), {
      timeout: 8000,
    })
    await page.waitForSelector('.cm-content', { timeout: 8000 })
    await page.waitForFunction(
      () => {
        const t = document.querySelector('.cm-content')?.innerText || ''
        return t.includes('second line') && !t.includes('A THIRD LINE')
      },
      { timeout: 8000 },
    )
  })
} finally {
  await browser.close()
  server.kill()
  await rm(dbDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} FAILURES`)
  process.exit(1)
}
console.log('\nALL PASS')
