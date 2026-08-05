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
async function clickText(page, tag, text) {
  const handle = await page.evaluateHandle(
    (tag, text) =>
      [...document.querySelectorAll(tag)].find((el) => el.textContent.trim().includes(text)),
    tag,
    text,
  )
  const el = handle.asElement()
  if (!el) throw new Error(`no <${tag}> containing ${JSON.stringify(text)}`)
  await el.click()
  return el
}

const textOf = (page, sel) =>
  page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel)

// ---- the run ---------------------------------------------------------------

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

  // A step is "do a thing, then assert nothing was logged doing it".
  // On failure, say what was actually on screen. A bare "waiting failed" sends
  // you back to the browser by hand, which is the cost this file exists to
  // remove.
  const visible = async () =>
    (await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim())).slice(0, 300)

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
