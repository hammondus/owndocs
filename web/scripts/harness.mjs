// The browser harness shared by ui_test.mjs and site_shots.mjs: find Chrome,
// start the real binary on a scratch database, and drive the page the way a
// person would. Both scripts run the same app under the same clean-console
// rule, so a screenshot of a broken feature fails rather than ships.
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

export const BIN = join(import.meta.dirname, '../../owndocs')

// Chrome is found, never downloaded. CHROME_PATH overrides for a machine that
// keeps it somewhere else.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

export async function findChrome() {
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

// Starts the binary in -dev mode, for the quick-login users, and returns once
// it answers.
export async function startServer(base, db) {
  const { host } = new URL(base)
  const proc = spawn(BIN, ['-dev', '-addr', host, '-db', db], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stderr.on('data', (b) => process.env.UI_TEST_VERBOSE && process.stderr.write(b))
  // Poll rather than sleep: a fixed wait is either slow or flaky, and this is
  // the loop every CI failure otherwise gets blamed on.
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(base + '/')
      if (res.ok) return proc
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  proc.kill()
  throw new Error(`server did not come up on ${base}`)
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

export function watchConsole(page) {
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
export async function clickText(page, tag, text) {
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
export async function clickSel(page, selector) {
  const clicked = await page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return false
    el.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`no element matching ${JSON.stringify(selector)}`)
}
