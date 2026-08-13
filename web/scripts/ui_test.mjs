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

// Same dispatched click, addressed by selector rather than by visible text.
// For controls whose label is a glyph: an arrow is not a word, so clickText has
// nothing to match on and the accessible name is the honest handle.
async function clickSel(page, selector) {
  const clicked = await page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return false
    el.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`no element matching ${JSON.stringify(selector)}`)
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

// What the editor is *showing*. innerText rather than textContent, because it
// keeps the line breaks.
//
// This is not the document. Live preview replaces source with widgets, so a
// horizontal rule reads as nothing, a hard break's backslash reads as "↵", and
// a table outside the cursor reads as its rendered cells. Anything replaced by
// a widget has to be asserted on the DOM that widget drew — which is a
// stronger assertion anyway: the widget cannot render unless the parser found
// the construct, and it cannot find it unless the source is right.
const docText = (page) =>
  page.evaluate(() => document.querySelector('.cm-content').innerText)

// Assert on the document text, and on failure say what is actually in it.
// "Waiting failed: 3000ms exceeded" for a markdown edit sends you back to the
// browser by hand; whitespace is the whole point of half these assertions and
// the step reporter collapses it.
async function waitForDoc(page, re) {
  try {
    await page.waitForFunction(
      (src, flags) => new RegExp(src, flags).test(document.querySelector('.cm-content').innerText),
      { timeout: 3000 },
      re.source,
      re.flags,
    )
  } catch {
    throw new Error(`expected ${re} in the document, which holds:\n  ${JSON.stringify(await docText(page))}`)
  }
}

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

  // `expect` names a console error the step is *supposed* to provoke. Used
  // once, for the oversized-update guard: refusing to send is the correct
  // behaviour and it logs, deliberately, so the failure is diagnosable from a
  // console someone kept. Silencing it in the provider to keep this file happy
  // would be the tail wagging the dog; matching it here is honest, and an
  // expectation that stops matching still fails the step.
  const step = async (what, fn, { expect = null } = {}) => {
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
    let errs = console_.drain()
    if (expect) {
      const before = errs.length
      errs = errs.filter((e) => !expect.test(e))
      if (errs.length === before) errs.push(`expected a console error matching ${expect}, and none arrived`)
    }
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

  // The selection readout. It renders inside an {#if}, which is the shape
  // this whole file exists to catch — and it is the only sheet feature whose
  // output is produced by a drag, so a unit test cannot reach it.
  await step('the selection readout totals a dragged range', async () => {
    // Cell geometry, from the component's own constants: 48/24 headers and
    // the 100×24 default cell. Hard-coded because the alternative is asking
    // the page for its layout, which would make the test agree with a broken
    // layout as readily as a correct one.
    const cellAt = async (r, c) => {
      const box = await page.$eval('.grid', (el) => {
        const b = el.getBoundingClientRect()
        return { x: b.x, y: b.y }
      })
      return { x: box.x + 48 + c * 100 + 50, y: box.y + 24 + r * 24 + 12 }
    }

    const a1 = await cellAt(0, 0)
    await page.mouse.click(a1.x, a1.y)
    for (const v of ['10', '2', '6']) {
      // focus(), not click(): the programmatic click helper dispatches the
      // event without moving focus, and the keystrokes would go nowhere.
      await page.focus('.formula-bar input')
      await page.keyboard.type(v)
      await page.keyboard.press('Enter') // commits and steps down a row
    }

    // One cell has nothing to aggregate, so there must be no readout at all.
    await page.mouse.click(a1.x, a1.y)
    check(
      (await page.$('.sel-stats')) === null,
      'no readout for a single cell',
      'the bar appeared for a one-cell selection',
    )

    const a3 = await cellAt(2, 0)
    await page.mouse.move(a1.x, a1.y)
    await page.mouse.down()
    await page.mouse.move(a3.x, a3.y, { steps: 4 })
    await page.mouse.up()

    await page.waitForSelector('.sel-stats', { timeout: 3000 })
    const text = (await page.$eval('.sel-stats', (el) => el.innerText)).replace(/\s+/g, ' ')
    check(
      /Sum 18/.test(text) && /Avg 6/.test(text) && /Min 2/.test(text) && /Max 10/.test(text) && /Count 3/.test(text),
      'readout shows sum, average, min, max and count for A1:A3',
      `read: ${text}`,
    )
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
    await clickText(page, 'button', 'Comment on A1')
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
    await clickText(page, 'button', 'Comment on A1')
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
    await clickSel(page, '[aria-label="Back to documents"]')
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
    // Case-insensitive, and it has to be: innerText reflects `text-transform`,
    // unlike textContent, so the section labels reading as uppercase is a
    // styling choice this assertion must not depend on.
    await page.waitForFunction(() => /named versions/i.test(document.body.innerText), {
      timeout: 5000,
    })
  })

  await step('edit the document again, and wait for it to reach the server', async () => {
    await clickSel(page, '[aria-label="Back to the document"]')
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
    await page.select('#rp-lh', '1.8')
    await page.select('#rp-measure', '60')
    // Asserted on .cm-content — where the text actually renders — not on
    // .cm-editor. The first version checked the outer element, which picks up
    // the font whether or not it reaches the text, and so passed while family,
    // line height and measure all silently did nothing.
    await page.waitForFunction(
      () => {
        const cs = getComputedStyle(document.querySelector('.cm-content'))
        return (
          cs.fontSize === '20px' &&
          /Georgia|Charter|Times/.test(cs.fontFamily) &&
          !/monospace/i.test(cs.fontFamily) &&
          Math.abs(parseFloat(cs.lineHeight) / 20 - 1.8) < 0.05 &&
          cs.maxWidth !== 'none'
        )
      },
      { timeout: 3000 },
    )
    // Code keeps its own family whatever the body font is — its alignment
    // carries meaning.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.md-code, .md-codeblock')
        return !el || /mono/i.test(getComputedStyle(el).fontFamily)
      },
      { timeout: 3000 },
    )
    await page.reload({ waitUntil: 'networkidle0' })
    await page.waitForSelector('.cm-editor', { timeout: 5000 })
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('.cm-content')).fontSize === '20px',
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

  // A named family, which is the path a reader takes after picking one from
  // their installed fonts. The enumeration itself cannot be driven here — it
  // prompts for a permission this harness has no way to grant — but everything
  // downstream of the name can be.
  await step('a named font family reaches the text', async () => {
    // Opened only if it is not already: `Aa` toggles, and a previous step
    // leaves the panel up. Steps share one browser, so a step that assumes a
    // starting state has to establish it.
    if (!(await page.$('#rp-font'))) await clickText(page, 'button', 'Aa')
    await page.waitForSelector('#rp-font', { timeout: 3000 })
    await page.select('#rp-font', 'custom')
    await page.waitForSelector('#rp-family', { timeout: 3000 })
    await page.$eval('#rp-family', (el) => {
      el.value = 'Courier New'
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.waitForFunction(
      () => /Courier New/.test(getComputedStyle(document.querySelector('.cm-content')).fontFamily),
      { timeout: 3000 },
    )
    // Note which control this exercises: the harness cannot grant the font
    // permission, so `localFonts` stays empty and the field is the typed-name
    // input. The select path only exists once enumeration has succeeded.
    // Back to a built-in, and the named family must let go rather than linger.
    await page.select('#rp-font', 'serif')
    await page.waitForFunction(
      () => !/Courier New/.test(getComputedStyle(document.querySelector('.cm-content')).fontFamily),
      { timeout: 3000 },
    )
    await clickText(page, 'button', 'close')
  })

  // Reachable from the document list as well as from inside a document: the
  // preference is global, and a setting on one screen only is a setting nobody
  // finds. This step exists because the first version shipped exactly that.
  await step('reading preferences are reachable from the document list', async () => {
    await clickSel(page, '[aria-label="Back to documents"]')
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await clickText(page, 'button', 'Aa reading')
    await page.waitForSelector('#rp-font', { timeout: 3000 })
    await clickText(page, 'button', 'close')
    // Put the document back, or every step after this one is stranded on the
    // list. Steps share one browser and run in order by design.
    await clickText(page, 'a', 'Renamed By Test')
    await page.waitForSelector('.cm-content', { timeout: 5000 })
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

  // The markdown toolbar. Run last and in a document of its own, so the text
  // it leaves behind is nobody else's problem — and started from an empty
  // document, so no step here has to guess where the cursor is.
  //
  // Most of these are canned text edits, and the assertion is the markdown
  // they produced. The exceptions are the ones that *render*: a rule and a
  // hard break are widgets, and the only proof they work is the DOM they draw.
  await step('open a document for the toolbar', async () => {
    await clickSel(page, '[aria-label="Back to documents"]')
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await page.type('input[placeholder="new document title"]', 'UI toolbar doc')
    await clickText(page, 'button', 'Create')
    await page.waitForSelector('.cm-content', { timeout: 5000 })
    await page.focus('.cm-content')
  })

  // The heading menu is the control most at risk of the dead-control failure:
  // it is the first thing on this toolbar that is not a <button>, and it lives
  // inside the same {#each}. H4 specifically, because H1–H3 were reachable
  // before and H4–H6 are what the menu was added for.
  await step('the heading menu sets a level the old buttons could not', async () => {
    await page.keyboard.type('Deep heading')
    await page.select('.toolbar select[aria-label="Text style"]', '4')
    await page.waitForFunction(
      () =>
        document.querySelector('.md-h4') &&
        document.querySelector('.cm-content').innerText.includes('#### Deep heading'),
      { timeout: 3000 },
    )
    // Back to a paragraph: the menu's first real entry has to undo as well as
    // apply, or it is a one-way door.
    await page.select('.toolbar select[aria-label="Text style"]', '0')
    await page.waitForFunction(() => !document.querySelector('.md-h4'), { timeout: 3000 })
  })

  await step('a numbered list nests with Tab', async () => {
    await page.keyboard.press('Enter')
    await page.keyboard.type('one')
    await clickText(page, 'button', '1.')
    await waitForDoc(page, /^1\. one$/m)
    // Enter continues the list — markdown()'s own keymap, not ours — and Tab
    // nests. Three spaces, not two: a numbered marker puts its children at
    // column 3, and two would leave this a lazy continuation of "one".
    //
    // The nested item stays "2.", it does not become "1.". Indenting does not
    // renumber, deliberately: renumbering one line of a multi-line selection
    // is worse than renumbering none, and a list starting at 2 is legal
    // markdown. See DESIGN-DECISIONS, *Lists*.
    await page.keyboard.press('Enter')
    await page.keyboard.type('two')
    await page.keyboard.press('Tab')
    await waitForDoc(page, /^1\. one\n {3}2\. two$/m)
    await page.keyboard.down('Shift')
    await page.keyboard.press('Tab')
    await page.keyboard.up('Shift')
    await waitForDoc(page, /^1\. one\n2\. two$/m)
  })

  // Alignment is the one piece of appearance markdown encodes, and the widget
  // has honoured it since tables shipped. This covers the half that was
  // missing: writing it. Before the code block, because a table inserted while
  // the cursor is inside a fence is not a table.
  await step('table column alignment cycles through the delimiter row', async () => {
    await clickText(page, 'button', '⊞')
    await waitForDoc(page, /\| ------ \| ------ \|/)
    await clickText(page, 'button', '≡')
    await waitForDoc(page, /\| :----: \| ------ \|/)
    await clickText(page, 'button', '≡')
    await waitForDoc(page, /\| -----: \| ------ \|/)
  })

  await step('a rule and a hard break render as themselves', async () => {
    // Out of the table first: everything below appends after the cursor's
    // line, and inside a table that would be a table row.
    await page.keyboard.down('Meta')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.up('Meta')
    await page.keyboard.press('Enter')
    await page.keyboard.type('before')
    await page.select('.toolbar select[aria-label="Insert"]', 'rule')
    await page.keyboard.type('split')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Shift')
    await page.keyboard.type('after')
    // Asserted on the widgets, not on the text: both constructs are replaced
    // in the rendered DOM, so `---` and the trailing `\` are not in innerText
    // at all. See docText.
    await page.waitForFunction(
      () => document.querySelector('.md-hr') && document.querySelector('.md-break'),
      { timeout: 3000 },
    )
    // The break has to be *between* the two halves, not merely present.
    await waitForDoc(page, /^split↵\nafter$/m)
  })

  // The one step that proves the language table is wired up end to end: the
  // grammar is not in the bundle, so this only passes if the dynamic import
  // fired, resolved, and re-parsed the block. Asserted as "some token is not
  // the colour of ordinary text", which does not care which hue it landed on.
  await step('a fenced code block loads its language and colours it', async () => {
    await page.keyboard.press('Enter')
    await clickText(page, 'button', '</>')
    await page.keyboard.type('js')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.type('const answer = 42')
    await waitForDoc(page, /^```js$/m)
    await page.waitForFunction(
      () => {
        const base = getComputedStyle(document.querySelector('.cm-content')).color
        return [...document.querySelectorAll('.md-codeblock span')].some(
          (s) => s.textContent.trim() && getComputedStyle(s).color !== base,
        )
      },
      { timeout: 10000 },
    )
  })

  // The constructs that needed the grammar taught. mdext_test.mjs proves they
  // parse; these prove the decoration layer reaches them, which is a separate
  // failure — a node the parser emits and nothing styles looks exactly like a
  // feature that was never built.
  await step('a document for the extended constructs', async () => {
    await clickSel(page, '[aria-label="Back to documents"]')
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await page.type('input[placeholder="new document title"]', 'UI extensions doc')
    await clickText(page, 'button', 'Create')
    await page.waitForSelector('.cm-content', { timeout: 5000 })
    await page.focus('.cm-content')
  })

  await step('highlight, superscript and subscript style their text', async () => {
    await page.keyboard.type('marked')
    await page.keyboard.down('Shift')
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Shift')
    await clickText(page, 'button', '🖍')
    await waitForDoc(page, /==marked==/)
    await page.keyboard.press('End')
    await page.keyboard.type(' x^2^ and H~2~O')
    await page.waitForFunction(
      () => document.querySelector('.md-highlight') && document.querySelector('.md-sup') && document.querySelector('.md-sub'),
      { timeout: 3000 },
    )
  })

  // The one with a real trap: `:warning:` renders as the character, so the
  // shortcode is not in innerText at all - and an unknown one must stay
  // exactly as typed, since that is what every other markdown tool shows.
  await step('a known emoji shortcode renders, an unknown one is left alone', async () => {
    await page.keyboard.press('Enter')
    await page.keyboard.type('status :warning: and :not_a_real_emoji:')
    await page.waitForFunction(
      () => document.querySelector('.md-emoji')?.textContent === '⚠️',
      { timeout: 3000 },
    )
    await waitForDoc(page, /:not_a_real_emoji:/)
  })

  // The picker is a drawer opened from the toolbar, which is the shape that
  // has presented as a dead control three times in this project. It also
  // inserts the SHORTCODE rather than the character, so the assertion is that
  // the document holds `:rocket:` while the editor shows 🚀 — the two halves
  // of the same feature agreeing.
  await step('the emoji picker finds one by name and inserts its shortcode', async () => {
    await page.keyboard.press('Enter')
    await clickText(page, 'button', '😀')
    await page.waitForSelector('#emoji-search', { timeout: 3000 })
    // Groups first, before any search: this is the "browse it visually" case.
    check(
      (await page.$$('.grid button')).length > 50,
      'the whole table is browsable before searching',
    )
    await page.type('#emoji-search', 'rocket')
    await page.waitForFunction(
      () => document.querySelectorAll('.grid button').length === 1,
      { timeout: 3000 },
    )
    // Enter takes the first match, so a name you know needs no mouse.
    await page.keyboard.press('Enter')
    // The panel stays open, so several can be inserted in a row.
    check(await page.$('#emoji-search'), 'picking one does not close the picker')
    await clickText(page, 'button', 'close')

    // A space, because the cursor lands *at the end of* the shortcode it just
    // inserted — which touches the node, so live preview correctly keeps the
    // source visible. The emoji appears when you move off it, exactly like
    // every other marker in this editor.
    await page.focus('.cm-content')
    await page.keyboard.type(' ')
    await page.waitForFunction(
      () => [...document.querySelectorAll('.md-emoji')].some((e) => e.textContent === '🚀'),
      { timeout: 3000 },
    )
    // And back onto it: the file holds `:rocket:`, not the character. Putting
    // the cursor on a widget is the only way to read the source it replaced.
    await page.keyboard.press('ArrowLeft')
    await waitForDoc(page, /:rocket:/)
    await page.keyboard.press('End')
  })

  // A callout is a blockquote, which is the whole point of the syntax - so the
  // assertion is that it is styled as a callout and NOT as a plain quote, and
  // that the `[!WARNING]` marker became a label rather than a hyperlink.
  await step('a callout is styled by kind, not as a link', async () => {
    await page.keyboard.press('Enter')
    await page.keyboard.type('Do not do this')
    await page.select('.toolbar select[aria-label="Callout"]', 'warning')
    // Not asserted on the text: `[!WARNING]` is replaced by its label, so what
    // innerText holds is "> ⚠️ Warning". See docText.
    await page.waitForFunction(
      () => {
        const label = document.querySelector('.md-callout-label')
        const box = document.querySelector('.md-callout-warning')
        return (
          box &&
          !box.classList.contains('md-blockquote') &&
          label &&
          label.textContent.includes('Warning') &&
          !box.querySelector('.md-link') &&
          // The indent is asserted because it did not used to work: an app.css
          // rule setting padding on a .cm-line loses to CodeMirror's own, and
          // blockquotes shipped flush against their rule for months.
          parseFloat(getComputedStyle(box).paddingLeft) > 6
        )
      },
      { timeout: 3000 },
    )
  })

  await step('a definition list indents its definitions', async () => {
    await page.keyboard.down('Meta')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.up('Meta')
    await page.select('.toolbar select[aria-label="Insert"]', 'definition')
    await waitForDoc(page, /^Term\n/m)
    // The `: ` is hidden like every other marker, so the indent is what says
    // which line is the definition. Measured where the TEXT starts, via a
    // Range: both lines are full-width block elements, so their bounding
    // rectangles have the same left edge whatever the padding does — the first
    // version of this compared those and could never have failed.
    await page.waitForFunction(
      () => {
        const textLeft = (el) => {
          const r = document.createRange()
          r.selectNodeContents(el)
          return r.getBoundingClientRect().left
        }
        const dt = document.querySelector('.md-dt')
        const dd = document.querySelector('.md-dd')
        return dt && dd && textLeft(dd) > textLeft(dt)
      },
      { timeout: 3000 },
    )
  })

  // Footnotes are the one construct whose rendering depends on the whole
  // document, so this is the one where a unit test on a single node proves
  // least. mdext_test.mjs has the numbering; these are the two things only a
  // browser shows: that the button writes both halves at once, and that a
  // number renders where the source says `[^1]`.
  await step('the footnote button writes both halves and numbers them', async () => {
    await clickSel(page, '[aria-label="Back to documents"]')
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await page.type('input[placeholder="new document title"]', 'UI footnote doc')
    await clickText(page, 'button', 'Create')
    await page.waitForSelector('.cm-content', { timeout: 5000 })
    await page.focus('.cm-content')

    await page.keyboard.type('A claim worth citing.')
    await page.select('.toolbar select[aria-label="Insert"]', 'footnote')
    // The cursor lands in the note, at the foot of the document.
    await page.keyboard.type('Where it came from.')
    await waitForDoc(page, /^\[\^1\]: Where it came from\.$/m)
  })

  // Each of these puts the cursor somewhere explicit first. Both halves are
  // markers, so live preview only replaces them once the cursor is off them —
  // and the cursor is left sitting in the note by the button that made it.
  const toDocStart = async () => {
    await page.keyboard.down('Meta')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.up('Meta')
  }

  await step('a footnote renders as its number, and the number is the pair', async () => {
    await toDocStart()
    await page.waitForFunction(
      () => {
        const ref = document.querySelector('.md-fn-ref')
        const def = document.querySelector('.md-fn-def')
        return ref?.textContent === '1' && def?.textContent === '1.' && !ref.classList.contains('md-fn-missing')
      },
      { timeout: 3000 },
    )

    // A second note. Numbering is by reference order across the whole
    // document, which is the only part of this that needed a design, so the
    // assertion is on both numbers together rather than on either alone.
    await page.keyboard.press('End')
    await page.select('.toolbar select[aria-label="Insert"]', 'footnote')
    await page.keyboard.type('The second one.')
    await page.waitForFunction(
      () => [...document.querySelectorAll('.md-fn-ref')].map((e) => e.textContent).join() === '1,2',
      { timeout: 3000 },
    )
  })

  await step('a reference citing nothing says so', async () => {
    await toDocStart()
    await page.keyboard.press('End')
    await page.keyboard.type('[^gone]')
    // Away from it, so it renders.
    await page.keyboard.down('Meta')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.up('Meta')
    await page.waitForFunction(
      () => {
        const missing = [...document.querySelectorAll('.md-fn-ref')].filter((e) =>
          e.classList.contains('md-fn-missing'),
        )
        // Numbered like any other — dropping it would renumber the notes after
        // it — but marked, because one half of the pair is missing.
        return missing.length === 1 && missing[0].textContent === '3'
      },
      { timeout: 3000 },
    )
  })

  await step('a document for the contents', async () => {
    await clickSel(page, '[aria-label="Back to documents"]')
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await page.type('input[placeholder="new document title"]', 'UI contents doc')
    await clickText(page, 'button', 'Create')
    await page.waitForSelector('.cm-content', { timeout: 5000 })
    await page.focus('.cm-content')
  })

  // Contents. Built from the headings in the document and stored nowhere, so
  // the assertions are: it lists what is there, the depth limit removes the
  // levels below it, the side actually moves it, and clicking an entry goes
  // there. The last one is the reason this is a browser test at all.
  await step('a table of contents lists the headings, to the chosen depth', async () => {
    // Wider than the default 800px, and it has to be: the contents column is
    // dropped below 60rem on purpose, so at the default viewport every
    // assertion below would be measuring a display:none element.
    await page.setViewport({ width: 1400, height: 900 })
    await page.keyboard.type('# Alpha\n')
    await page.keyboard.type('## Beta\n')
    await page.keyboard.type('### Gamma\n')
    if (!(await page.$('#rp-toc'))) await clickText(page, 'button', 'Aa')
    await page.waitForSelector('#rp-toc', { timeout: 3000 })
    await page.select('#rp-toc', 'left')
    await page.waitForSelector('#rp-toc-depth', { timeout: 3000 })
    await page.select('#rp-toc-depth', '3')
    const entries = () =>
      page.evaluate(() => [...document.querySelectorAll('nav.toc button')].map((b) => b.textContent.trim()))
    await page.waitForFunction(
      () => document.querySelectorAll('nav.toc button').length >= 3,
      { timeout: 5000 },
    )
    check(
      (await entries()).join('|').includes('Alpha|Beta|Gamma'),
      'the headings are listed in document order',
      JSON.stringify(await entries()),
    )
    // The depth limit is the feature that would silently do nothing.
    await page.select('#rp-toc-depth', '2')
    await page.waitForFunction(
      () => ![...document.querySelectorAll('nav.toc button')].some((b) => b.textContent.trim() === 'Gamma'),
      { timeout: 5000 },
    )
    check((await entries()).includes('Beta'), 'the levels above the limit stay')
  })

  await step('the contents move to the side that was chosen, and navigate', async () => {
    // `left` vs `right` is a flex-direction, so it is asserted as geometry:
    // the DOM order does not change, which is the point of doing it that way.
    const tocIsLeftOfEditor = () =>
      page.evaluate(() => {
        const nav = document.querySelector('nav.toc')
        const ed = document.querySelector('.cm-editor')
        return nav.getBoundingClientRect().left < ed.getBoundingClientRect().left
      })
    check(await tocIsLeftOfEditor(), 'left puts the contents left of the text')
    await page.select('#rp-toc', 'right')
    await page.waitForFunction(
      () =>
        document.querySelector('nav.toc').getBoundingClientRect().left >
        document.querySelector('.cm-editor').getBoundingClientRect().left,
      { timeout: 3000 },
    )
    ok('right puts them on the other side')
    await clickText(page, 'button', 'close')

    // Clicking an entry moves the cursor to that heading — asserted through
    // the contents' own active marker, which is derived from the cursor. Not
    // on scroll position: this document fits on screen, so nothing would
    // scroll and such an assertion could never fail.
    //
    // The cursor starts at the end of the document, so the LAST entry is
    // active. Clicking the first has to move it.
    await page.waitForFunction(
      () => {
        const b = [...document.querySelectorAll('nav.toc button')]
        return b.length > 1 && b[b.length - 1].classList.contains('active')
      },
      { timeout: 3000 },
    )
    await clickText(page, 'button', 'Alpha')
    await page.waitForFunction(
      () => {
        const b = [...document.querySelectorAll('nav.toc button')]
        return b[0].classList.contains('active') && !b[b.length - 1].classList.contains('active')
      },
      { timeout: 3000 },
    )
  })

  await step('turning the contents off gives the width back', async () => {
    const width = () => page.evaluate(() => document.querySelector('.page').getBoundingClientRect().width)
    const wide = await width()
    if (!(await page.$('#rp-toc'))) await clickText(page, 'button', 'Aa')
    await page.waitForSelector('#rp-toc', { timeout: 3000 })
    await page.select('#rp-toc', 'off')
    await page.waitForFunction(() => !document.querySelector('nav.toc'), { timeout: 3000 })
    check(await page.evaluate((w) => document.querySelector('.page').getBoundingClientRect().width < w, wide),
      'the page narrows back to its reading width')
    await clickText(page, 'button', 'close')
  })

  // Document links. Another toolbar drawer, which is the shape that has
  // presented as a dead control three times here — and this one is reached
  // through the Insert menu, which had no way to open a panel until now.
  //
  // The last assertion is the whole feature: a click on rendered link text
  // lands in the other document. It is also the only one that cannot be made
  // anywhere but a browser, since following a link is a real mousedown at real
  // coordinates — `el.click()` would dispatch a click with none, and the
  // handler reads the position out of the event.
  await step('a document link is picked, rendered and followed', async () => {
    await clickSel(page, '[aria-label="Back to documents"]')
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await page.type('input[placeholder="new document title"]', 'UI linking doc')
    await clickText(page, 'button', 'Create')
    await page.waitForSelector('.cm-content', { timeout: 5000 })
    await page.focus('.cm-content')
    const fromId = docIdFromHash(page.url())

    await page.select('.toolbar select[aria-label="Insert"]', 'doclink')
    await page.waitForSelector('#doclink-search', { timeout: 3000 })
    check(
      await page.evaluate(
        () =>
          ![...document.querySelectorAll('.list-scroll .row .name')].some(
            (e) => e.textContent.trim() === 'UI linking doc',
          ),
      ),
      'the document being edited is not offered as a link target',
    )

    await page.type('#doclink-search', 'UI toolbar')
    await page.waitForFunction(
      () => document.querySelectorAll('.list-scroll .row').length === 1,
      { timeout: 3000 },
    )
    // Enter takes the first match, as in the emoji picker.
    await page.keyboard.press('Enter')
    // Unlike the emoji picker, this one closes: one link is almost always the
    // last one wanted.
    await page.waitForFunction(() => !document.querySelector('#doclink-search'), { timeout: 3000 })

    // The cursor lands at the end of the link, which *touches* it — so the
    // source stays visible, exactly as every other construct here behaves. A
    // space moves off it and the link renders.
    await page.focus('.cm-content')
    await page.keyboard.type(' ')
    await page.waitForFunction(
      () => {
        const a = document.querySelector('.md-doclink')
        // Not `missing`: the index resolved it, which is the half of this that
        // depends on /api/docs having answered.
        return a && !a.classList.contains('md-doclink-missing')
      },
      { timeout: 3000 },
    )
    check(
      (await textOf(page, '.md-doclink')) === 'UI toolbar doc',
      'the link is labelled with the title it was picked by',
    )

    // Back onto it to read the source. innerText is what the editor *shows*,
    // and a rendered link hides its own URL, so this is the only place the
    // markdown itself can be asserted.
    await page.keyboard.press('ArrowLeft')
    await waitForDoc(page, /\[UI toolbar doc\]\(#doc=[a-z2-7]+\)/)
    await page.keyboard.press('End')
    await page.waitForFunction(() => document.querySelector('.md-doclink'), { timeout: 3000 })

    // A real mouse press, not a dispatched click: the handler is on mousedown
    // and reads the document position out of the event's coordinates.
    await (await page.$('.md-doclink')).click()
    await page.waitForFunction(
      () => document.querySelector('.viewbar .name')?.textContent.trim() === 'UI toolbar doc',
      { timeout: 5000 },
    )
    check(
      docIdFromHash(page.url()) !== fromId,
      'following the link routed to the other document',
    )
  })

  // Printing is the PDF export. The half that no stylesheet could fix is here:
  // live preview reveals the markers of whatever the selection touches, so
  // without the printing flag a document prints `## Section` as literal text in
  // exactly one place — wherever the cursor was left. By print time those
  // markers are real text, so this has to be asserted on the DOM before the
  // page is drawn, not on the CSS.
  await step('printing hides the markers the cursor was revealing', async () => {
    await clickSel(page, '[aria-label="Back to documents"]')
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await page.type('input[placeholder="new document title"]', 'UI print doc')
    await clickText(page, 'button', 'Create')
    await page.waitForSelector('.cm-content', { timeout: 5000 })
    await page.focus('.cm-content')

    // A heading with the cursor left sitting in it — the state that prints
    // wrong, and the state a document is always in when someone hits ⌘P.
    await page.keyboard.type('## Section')
    await waitForDoc(page, /## Section/)
    check(await page.$('.md-h2'), 'the heading is styled while its source shows')

    // beforeprint, exactly as the browser fires it for ⌘P and for print().
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
    await page.waitForFunction(
      () => !document.querySelector('.cm-content').innerText.includes('## '),
      { timeout: 3000 },
    )
    check(await page.$('.md-h2'), 'and is still a heading once the markers are hidden')

    // And back: printing must not leave the document looking read-only.
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
    await waitForDoc(page, /## Section/)

    // A quote and a fenced block, so the next step's assertions about the
    // scaffolding markers have something real to assert on. Inserted from the
    // toolbar rather than typed: Enter continues a blockquote, and typing a
    // closing fence by hand is the flakiest way to reach either of them.
    await page.keyboard.press('Enter')
    await page.keyboard.type('quoted line')
    await clickText(page, 'button', '❝')
    await page.waitForSelector('.md-quotemark', { timeout: 3000 })
    await page.focus('.cm-content')
    await clickText(page, 'button', '</>')
    await page.waitForSelector('.md-fencemark', { timeout: 3000 })

    await page.focus('.cm-content')
    await page.keyboard.down('Meta')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.up('Meta')
    await page.keyboard.press('Enter')
    await page.keyboard.type('a bullet')
    await clickText(page, 'button', '•')
    await page.waitForSelector('.md-listmark', { timeout: 3000 })
  })

  await step('the print stylesheet drops the chrome and the dark scheme', async () => {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
    await page.emulateMediaType('print')

    const hidden = (sel) =>
      page.evaluate((s) => {
        const el = document.querySelector(s)
        return !el || getComputedStyle(el).display === 'none'
      }, sel)
    check(await hidden('.appbar'), 'the app bar does not print')
    check(await hidden('.viewbar'), 'the view bar does not print')
    check(await hidden('.toolbar'), 'the toolbar does not print')

    const prop = (name) =>
      page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
    // Browsers drop background colours when printing but keep foreground ones,
    // so a dark scheme reaching paper is pale grey text on white.
    check((await prop('--ink')) === '#000000', 'dark mode does not follow the document onto paper')
    // prefs.js sets this one *inline* on the root element, so this is also the
    // assertion that the !important in the print block is earning its keep.
    check((await prop('--reading-size')) === '11pt', 'the screen reading size stays on the screen')

    // Scaffolding markers. On screen these are dimmed rather than hidden,
    // because while editing the document *is* its markdown; on paper a `>`
    // down the side of every quoted line is what most makes printed markdown
    // read as a draft. Asserted only because the previous step put a real
    // quote and a real fence in the document — otherwise `hidden()` would pass
    // on an element that was never there.
    check(await hidden('.md-quotemark'), 'quote markers do not print')
    check(
      await page.evaluate(() => {
        const fence = document.querySelector('.md-fencemark')
        return !!fence && getComputedStyle(fence.closest('.cm-line')).display === 'none'
      }),
      'a code fence prints as neither a marker nor the blank line it sat on',
    )
    check(
      await page.evaluate(() => {
        const m = document.querySelector('.md-listmark')
        return !!m && getComputedStyle(m).opacity === '1'
      }),
      'a list marker prints at full ink, being the bullet rather than scaffolding',
    )

    await page.emulateMediaType('screen')
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
  })

  // The rich flag. A property of the document row written over HTTP, exactly
  // as a rename is — so the assertion that matters is that it *persists*, not
  // that the label changed. A local toggle that never reached the server would
  // look identical until the document was reopened.
  //
  // The toolbar gating it feeds is unit-tested in roles_test.mjs; there is
  // nothing to assert about it here yet, because no appearance command exists
  // to be gated. That assertion arrives with the first one.
  await step('the formatting mode flips, and survives reopening', async () => {
    await clickSel(page, '[aria-label="Back to documents"]')
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await page.type('input[placeholder="new document title"]', 'UI rich doc')
    await clickText(page, 'button', 'Create')
    await page.waitForSelector('#doc-rich', { timeout: 5000 })
    check((await textOf(page, '#doc-rich')) === 'plain', 'a new document is plain')

    await clickSel(page, '#doc-rich')
    await page.waitForFunction(
      () => document.querySelector('#doc-rich')?.textContent.trim() === 'rich',
      { timeout: 3000 },
    )

    // Away and back, so the label is read from /api/docs rather than from the
    // component that just set it.
    await clickSel(page, '[aria-label="Back to documents"]')
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await clickText(page, 'a, button, .row', 'UI rich doc')
    await page.waitForSelector('#doc-rich', { timeout: 5000 })
    check((await textOf(page, '#doc-rich')) === 'rich', 'the flag came back from the server')

    // And off again: un-flagging is a bit-flip, which is the property that
    // made this a column rather than a third document kind.
    await clickSel(page, '#doc-rich')
    await page.waitForFunction(
      () => document.querySelector('#doc-rich')?.textContent.trim() === 'plain',
      { timeout: 3000 },
    )
  })

  // The Format drawer, and the gating it hangs off. This is the first
  // assertion that the rich flag actually withholds something: the same
  // toolbar, on the same document, before and after the flag.
  await step('the Format control appears only on a rich document', async () => {
    await clickSel(page, '[aria-label="Back to documents"]')
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await page.type('input[placeholder="new document title"]', 'UI format doc')
    await clickText(page, 'button', 'Create')
    await page.waitForSelector('.cm-content', { timeout: 5000 })

    const hasFormat = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.toolbar button')].some((b) => b.textContent.trim() === 'Format'),
      )
    check(!(await hasFormat()), 'a plain document does not offer it')

    await clickSel(page, '#doc-rich')
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.toolbar button')].some((b) => b.textContent.trim() === 'Format'),
      { timeout: 3000 },
    )
    ok('turning the flag on brings it back')
  })

  // The construct itself. The assertion that matters is the pair: the document
  // holds `[text]{.c-red}` and the editor shows `text` wearing the class — the
  // two halves of the same feature agreeing, exactly as the emoji picker's
  // shortcode-versus-character check does.
  await step('a colour wraps the selection and renders as a class', async () => {
    await page.focus('.cm-content')
    await page.keyboard.type('make this red')
    // Select the last word.
    await page.keyboard.down('Shift')
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Shift')

    await clickText(page, 'button', 'Format')
    await page.waitForSelector('.panel .swatch', { timeout: 3000 })
    await clickSel(page, '.panel .swatch[aria-label="Text colour: Red"]')
    // The label stays *selected* after applying, which is what lets the drawer
    // stay open and put a second property on the same words. Its source is
    // therefore showing, so this is where the markdown gets asserted.
    await waitForDoc(page, /\[red\]\{\.c-red\}/)

    // A second family joins rather than replacing: red *and* extra large, one
    // span. Collapsing the cursor to the span's end instead used to leave it on
    // the boundary, where this click found no span and silently did nothing.
    await clickSel(page, '.panel .size[aria-label="Size: Extra large"]')
    await waitForDoc(page, /\[red\]\{\.c-red \.size-xl\}/)
    ok('a size joins the colour instead of stacking a second span')

    // Off the span, and it renders: one element carrying both classes, showing
    // the label alone.
    await page.focus('.cm-content')
    await page.keyboard.press('End')
    await page.keyboard.type(' ')
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.md-c-red')
        return el && el.classList.contains('md-size-xl') && el.textContent === 'red'
      },
      { timeout: 3000 },
    )
    ok('and away from it, the span renders as its classes')
  })

  await step('clearing every family unwraps the span', async () => {
    // Back onto the span. One press is enough because the boundary resolves
    // from either side now.
    await page.keyboard.press('ArrowLeft')
    await clickSel(page, '.panel .none[aria-label="Text colour: none"]')
    await waitForDoc(page, /\[red\]\{\.size-xl\}/)
    await clickSel(page, '.panel .none[aria-label="Size: normal"]')
    // With no family left the brackets go entirely, rather than an empty `{}`
    // being left in the document.
    await waitForDoc(page, /make this red/)
    check(!(await docText(page)).includes('{.'), 'no attribute braces are left behind')
    await clickText(page, 'button', 'close')
  })

  // An unknown token is not a construct. It has to stay exactly the text
  // somebody typed — which is what it looks like in the .md file read by
  // anything else, so the document reads the same everywhere.
  await step('an unrecognised token stays literal text', async () => {
    await page.focus('.cm-content')
    await page.keyboard.press('End')
    await page.keyboard.type('\n[nope]{.c-taupe}')
    await page.keyboard.down('Meta')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.up('Meta')
    await waitForDoc(page, /\[nope\]\{\.c-taupe\}/)
    check(
      await page.evaluate(() => !document.querySelector('[class*="md-c-"]')),
      'and is given no class at all',
    )
  })

  // Alignment: the one block-level property, so it takes whole lines rather
  // than the selection. The assertions worth having are that changing it
  // *rewrites* the fence rather than nesting a second div, and that clearing it
  // takes both fences away — a construct that only half-unwraps leaves `:::`
  // sitting in the document with nothing to say.
  await step('alignment wraps whole lines, and unwraps cleanly', async () => {
    await page.focus('.cm-content')
    await clickText(page, 'button', 'Format')
    await page.waitForSelector('.panel .size[aria-label="Alignment: Centred"]', { timeout: 3000 })

    await clickSel(page, '.panel .size[aria-label="Alignment: Centred"]')
    await page.waitForSelector('.md-align-center', { timeout: 3000 })
    await waitForDoc(page, /::: center/)

    await clickSel(page, '.panel .size[aria-label="Alignment: Right"]')
    await page.waitForSelector('.md-align-right', { timeout: 3000 })
    check(
      !(await docText(page)).includes('::: center'),
      'changing the alignment rewrites the fence rather than nesting a second div',
    )

    await clickSel(page, '.panel .none[aria-label="Alignment: normal"]')
    await page.waitForFunction(() => !document.querySelector('.md-align-right'), { timeout: 3000 })
    check(!(await docText(page)).includes(':::'), 'clearing it removes both fences')
    await clickText(page, 'button', 'close')
  })

  // Mentions and the inbox. The only test here that needs two people, so it
  // gets a second browser context — an isolated cookie jar in the same Chrome,
  // rather than a second browser.
  //
  // Setup goes through the API rather than the UI, for a reason recorded in
  // ROADMAP: composing a comment on a text selection does not work under
  // automation and the cause is unfound. Building this test on that path would
  // make a known-flaky step the gate on a feature that has nothing to do with
  // it. What *is* driven through the real UI is the part under test — the
  // chips, the inbox, and following a notification.
  let mentionDocID
  await step('a document shared with Bob, and a comment naming him', async () => {
    await clickSel(page, '[aria-label="Back to documents"]')
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await page.type('input[placeholder="new document title"]', 'UI mention doc')
    await clickText(page, 'button', 'Create')
    await page.waitForSelector('.cm-content', { timeout: 5000 })
    mentionDocID = docIdFromHash(page.url())

    const out = await page.evaluate(async (id) => {
      const post = (path, body) =>
        fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then((r) => r.json())
      await post(`/api/docs/${id}/shares`, { email: 'bob@dev.local', role: 'commenter' })
      // btoa, because the anchor is bytes on the wire and opaque to the server.
      return post(`/api/docs/${id}/comments`, {
        anchor: btoa('ui-test-anchor'),
        body: '@Bob does this look right to you?',
      })
    }, mentionDocID)
    check(out && out.id > 0, 'the thread was created')
  })

  // The chips are the mention affordance: names contain spaces, which a typed
  // `@` cannot delimit but a click can. They come from the share list, so this
  // also asserts a commenter-visible endpoint is reachable from the panel.
  await step('the comments panel offers the people who can be mentioned', async () => {
    await clickText(page, 'button', 'comments')
    await page.waitForSelector('.mentions .chip', { timeout: 5000 })
    const names = await page.evaluate(() =>
      [...document.querySelectorAll('.mentions .chip')].map((b) => b.textContent.trim()),
    )
    check(names.includes('Bob'), `Bob is offered as a mention (got ${JSON.stringify(names)})`)
    check(!names.includes('Alice'), 'and you are not offered to yourself')
    await clickText(page, 'button', 'close')
  })

  await step('Bob finds the mention in his inbox and follows it', async () => {
    // A separate context, so Bob's session does not evict Alice's.
    const ctx = await browser.createBrowserContext()
    const bob = await ctx.newPage()
    const bobConsole = watchConsole(bob)
    try {
      await bob.goto(BASE, { waitUntil: 'networkidle0' })
      await clickText(bob, 'button', 'Bob')
      await bob.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })

      // The unread count is the whole notification surface — no toast, no dot.
      await bob.waitForFunction(
        () => document.querySelector('.appbar button.has-unread')?.textContent.includes('(1)'),
        { timeout: 5000 },
      )
      ok('the app bar shows one unread')

      await clickSel(bob, '.appbar button.has-unread')
      await bob.waitForSelector('.panel .row', { timeout: 3000 })
      const row = await bob.evaluate(() => document.querySelector('.panel .row').innerText)
      check(row.includes('Alice'), 'the row names who mentioned him')
      check(row.includes('does this look right'), 'and quotes the comment')

      // Following it lands in the document *with the comments drawer open* —
      // landing in a long document with no idea which comment was meant is the
      // failure this avoids.
      await clickSel(bob, '.panel .row')
      await bob.waitForSelector('.cm-content', { timeout: 5000 })
      check(
        docIdFromHash(bob.url()) === mentionDocID,
        'following the notification routed to the right document',
      )
      await bob.waitForFunction(
        () => [...document.querySelectorAll('.panel strong')].some((e) => e.textContent === 'Comments'),
        { timeout: 5000 },
      ).then(() => ok('and opened the comments drawer'), () => fail('the comments drawer did not open'))

      // Reading it marks it read, so the bar goes quiet.
      await bob.waitForFunction(() => !document.querySelector('.appbar button.has-unread'), { timeout: 5000 })
      ok('and the unread count cleared')

      const errs = bobConsole.drain()
      check(errs.length === 0, `Bob's page logged nothing${errs.length ? ': ' + errs.join('; ') : ''}`)
    } finally {
      await ctx.close()
    }
  })

  await step('the document list shows the unresolved count', async () => {
    await clickSel(page, '[aria-label="Back to documents"]')
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await page.waitForFunction(
      () => [...document.querySelectorAll('.open')].some((e) => e.textContent.trim() === '1 unresolved'),
      { timeout: 5000 },
    )
  })

  // A change too large to sync. The server's read limit is 16 MiB per message
  // and one paste is one Yjs update, so a big enough paste cannot be sent —
  // and until now that failed in the console, leaving the change on screen and
  // absent from the server, which looks exactly like a save until a reload.
  //
  // Driven as a real paste rather than by poking the provider: the guard is
  // unit-tested in provider_test.mjs, and what this adds is that the banner —
  // new markup inside an {#if} — actually renders. That is the shape this file
  // exists for.
  await step('a paste too large to sync says so instead of failing quietly', async () => {
    // Whichever screen the previous step left behind.
    if (await page.$('[aria-label="Back to documents"]')) {
      await clickSel(page, '[aria-label="Back to documents"]')
    }
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await page.type('input[placeholder="new document title"]', 'UI oversize sheet')
    await page.select('select', 'sheet')
    await clickText(page, 'button', 'Create')
    await page.waitForSelector('canvas', { timeout: 5000 })

    // 400k cells of long-ish values — measured at 20.4 MiB as one Yjs update,
    // against a 15 MiB guard. The same cells holding short integers come to
    // 13.2 MiB and sync fine, which is the margin this fixture is picked
    // around: cell *count* is not the limit, bytes are.
    await page.evaluate(() => {
      const rows = 20000, cols = 20
      const tsv = Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => String(r * 7 + c).padStart(24, '0')).join('\t')).join('\n')
      const dt = new DataTransfer()
      dt.setData('text/plain', tsv)
      document.querySelector('.grid').dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      )
    })

    await page.waitForSelector('.problem', { timeout: 30000 })
    const said = await textOf(page, '.problem')
    check(/Not saved/.test(said), 'the banner leads with the consequence', said)
    check(/too large to save/.test(said), 'and says why', said)
    check(/[Uu]ndo/.test(said), 'and what to do', said)

    // Dismissable, because the person may want the screen back — but only by
    // asking, never on a timer.
    await clickText(page, 'button', 'dismiss')
    await page.waitForFunction(() => !document.querySelector('.problem'), { timeout: 3000 })
  }, { expect: /refusing to send a \d+-byte update/ })

  // The `commenter` role, granted through the real share screen. It has worked
  // end to end since schema v5 — the API takes it, the socket enforces it,
  // roles.js knows it — and nothing offered it, so nobody could reach it. This
  // asserts the whole chain rather than the dropdown alone: granting it here
  // has to produce a person who can comment and cannot edit.
  await step('a commenter can be granted, and gets a reading toolbar', async () => {
    if (await page.$('[aria-label="Back to documents"]')) {
      await clickSel(page, '[aria-label="Back to documents"]')
    }
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await page.type('input[placeholder="new document title"]', 'UI commenter doc')
    await clickText(page, 'button', 'Create')
    await page.waitForSelector('.cm-content', { timeout: 5000 })
    const docID = docIdFromHash(page.url())

    await clickText(page, 'a', 'share')
    await page.waitForSelector('input[type="email"]', { timeout: 5000 })

    // All three grantable roles, and no `owner` — which is not a thing to hand
    // out, and which the server refuses on this endpoint.
    const roles = await page.evaluate(() =>
      [...document.querySelectorAll('form select option')].map((o) => o.value),
    )
    check(
      JSON.stringify(roles) === JSON.stringify(['editor', 'commenter', 'viewer']),
      `the picker offers every grantable role (got ${JSON.stringify(roles)})`,
    )

    await page.type('input[type="email"]', 'bob@dev.local')
    await page.select('form select', 'commenter')
    await clickText(page, 'button', 'Add')
    await page.waitForFunction(
      () => [...document.querySelectorAll('li')].some((li) => /bob@dev\.local/.test(li.textContent) && /commenter/.test(li.textContent)),
      { timeout: 5000 },
    )
    ok('and grants it')

    const ctx = await browser.createBrowserContext()
    const bob = await ctx.newPage()
    const bobConsole = watchConsole(bob)
    try {
      await bob.goto(`${BASE}/#doc=${docID}`, { waitUntil: 'networkidle0' })
      await clickText(bob, 'button', 'Bob')
      await bob.waitForSelector('.cm-content', { timeout: 5000 })

      const labels = await bob.evaluate(() =>
        [...document.querySelectorAll('.toolbar button, .toolbar select')].map((e) => e.textContent.trim()),
      )
      // The gate, not a courtesy: EditorState.readOnly stops user input, but a
      // toolbar button is a programmatic dispatch that goes straight past it.
      check(!labels.includes('B'), `no editing commands for a commenter (got ${JSON.stringify(labels)})`)
      check(labels.includes('Aa'), 'but the reading controls survive')

      // Commenting is the whole point of the role, so the way in must be there.
      check(
        await bob.evaluate(() =>
          [...document.querySelectorAll('.viewbar button')].some((b) => /comments/.test(b.textContent)),
        ),
        'and the comments panel is reachable',
      )

      const errs = bobConsole.drain()
      check(errs.length === 0, `Bob's page logged nothing${errs.length ? ': ' + errs.join('; ') : ''}`)
    } finally {
      await ctx.close()
    }
  })

  // Writing a formula by pointing at cells. The logic is unit-tested in
  // refs_test.mjs; what only a browser can show is that a click reaches it at
  // all — the first attempt failed because by the time a mousedown handler
  // runs the browser has already moved focus to the grid, so asking
  // `document.activeElement` which input holds the caret answers "grid".
  await step('a formula can be written by pointing at cells', async () => {
    if (await page.$('[aria-label="Back to documents"]')) {
      await clickSel(page, '[aria-label="Back to documents"]')
    }
    await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
    await page.type('input[placeholder="new document title"]', 'UI point mode')
    await page.select('select', 'sheet')
    await clickText(page, 'button', 'Create')
    await page.waitForSelector('canvas', { timeout: 5000 })

    const cellAt = async (r, c) => {
      const b = await page.$eval('.grid', (el) => {
        const x = el.getBoundingClientRect()
        return { x: x.x, y: x.y }
      })
      return { x: b.x + 48 + c * 100 + 50, y: b.y + 24 + r * 24 + 12 }
    }
    const bar = () => page.$eval('.formula-bar input', (e) => e.value)

    const a1 = await cellAt(0, 0)
    await page.mouse.click(a1.x, a1.y)
    for (const v of ['10', '20', '30']) {
      await page.focus('.formula-bar input')
      await page.keyboard.type(v)
      await page.keyboard.press('Enter')
    }

    // Start a formula, then drag A1:A3 rather than typing the range.
    await page.mouse.click((await cellAt(0, 1)).x, (await cellAt(0, 1)).y)
    await page.focus('.formula-bar input')
    await page.keyboard.type('=SUM(')
    const a3 = await cellAt(2, 0)
    await page.mouse.move(a1.x, a1.y)
    await page.mouse.down()
    await page.mouse.move(a3.x, a3.y, { steps: 5 })
    await page.mouse.up()
    await page.waitForFunction(
      () => document.querySelector('.formula-bar input').value === '=SUM(A1:A3',
      { timeout: 3000 },
    )
    ok('the drag wrote the range')

    // The outline has to be on screen *while* the range is being drawn, which
    // means a half-typed formula has to be readable. Sampled off the canvas,
    // since that is where it is drawn.
    const refColourOnScreen = () =>
      page.evaluate(() => {
        const cv = document.querySelector('canvas')
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
        for (let i = 0; i < d.length; i += 4) {
          // #8e44ad, the first reference colour.
          if (Math.abs(d[i] - 142) < 12 && Math.abs(d[i + 1] - 68) < 12 && Math.abs(d[i + 2] - 173) < 12) return true
        }
        return false
      })
    check(await refColourOnScreen(), 'and the cells it refers to are outlined before it is finished')

    await page.focus('.formula-bar input')
    await page.keyboard.type(')')
    await page.keyboard.press('Enter')
    await page.mouse.click((await cellAt(0, 1)).x, (await cellAt(0, 1)).y)
    await page.waitForFunction(
      () => document.querySelector('.formula-bar input').value === '=SUM(A1:A3)',
      { timeout: 3000 },
    )
    check(await refColourOnScreen(), 'selecting the finished formula outlines them too')
  })

  // The failure mode that would make this actively worse than typing: a click
  // that writes into somebody's formula when they meant to select a cell.
  await step('a click still selects when the formula is not expecting a reference', async () => {
    const cellAt = async (r, c) => {
      const b = await page.$eval('.grid', (el) => {
        const x = el.getBoundingClientRect()
        return { x: x.x, y: x.y }
      })
      return { x: b.x + 48 + c * 100 + 50, y: b.y + 24 + r * 24 + 12 }
    }
    const d5 = await cellAt(4, 3)

    await page.mouse.click((await cellAt(0, 4)).x, (await cellAt(0, 4)).y)
    await page.focus('.formula-bar input')
    // The caret now follows a complete reference, so the next click means
    // "stop typing and select that cell".
    await page.keyboard.type('=A1')
    await page.mouse.click(d5.x, d5.y)
    await page.waitForFunction(
      () => document.querySelector('.cell-name').textContent.trim() === 'D5',
      { timeout: 3000 },
    )
    check(
      !(await page.$eval('.formula-bar input', (e) => e.value)).includes('D5'),
      'the reference was not appended to the formula',
    )
  })

  // Pointing without the mouse, and F4. The rules are unit-tested; what needs
  // a browser is that the keys reach them — and, for the arrows, that they
  // still do the ordinary thing when the formula is not expecting a reference.
  await step('arrow keys point, and F4 cycles the absolute forms', async () => {
    const cellAt = async (r, c) => {
      const b = await page.$eval('.grid', (el) => {
        const x = el.getBoundingClientRect()
        return { x: x.x, y: x.y }
      })
      return { x: b.x + 48 + c * 100 + 50, y: b.y + 24 + r * 24 + 12 }
    }
    const bar = () => page.$eval('.formula-bar input', (e) => e.value)
    const barIs = (want, what) =>
      page.waitForFunction(
        (w) => document.querySelector('.formula-bar input').value === w,
        { timeout: 3000 }, want,
      ).then(() => ok(what), async () => fail(what, `bar reads ${JSON.stringify(await bar())}`))

    // C5, so there is room above it to point at.
    const c5 = await cellAt(4, 2)
    await page.mouse.click(c5.x, c5.y)
    await page.focus('.formula-bar input')
    await page.keyboard.type('=')

    await page.keyboard.press('ArrowUp')
    await barIs('=C4', 'an arrow points at the cell above')

    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.up('Shift')
    await barIs('=C3:C4', 'and shift grows it into a range')

    // F4 walks the range through its forms, as a unit.
    await page.keyboard.press('F4')
    await barIs('=$C$3:$C$4', 'F4 makes it absolute')
    await page.keyboard.press('F4')
    await barIs('=C$3:C$4', 'and keeps cycling')
    await page.keyboard.press('Escape')

    // The arrows must still move the caret when the formula is not expecting a
    // reference — taking that away would be a worse bug than the one this
    // whole feature fixes.
    await page.mouse.click(c5.x, c5.y)
    await page.focus('.formula-bar input')
    await page.keyboard.type('=A1+B2')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    check((await bar()) === '=A1+B2', `the formula is untouched (got ${JSON.stringify(await bar())})`)
    // And the caret really did move, so the next character lands mid-formula.
    await page.keyboard.type('9')
    check((await bar()) === '=A1+9B2', `the caret moved rather than the reference (got ${JSON.stringify(await bar())})`)
    await page.keyboard.press('Escape')
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
