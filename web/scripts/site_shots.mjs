// The screenshots on the website, taken from the real app. Run from the repo
// root as `make site-shots`, which builds the binary first.
//
// Each shot is a page state built through the UI, on a scratch database, in
// the same browser and under the same clean-console rule as ui_test.mjs. It
// is written twice, once per colour scheme, as site/shots/<name>-light.png
// and <name>-dark.png, and the site picks one with <picture>. site_test.mjs
// checks that every data-shot on the site has both files and that every file
// has a data-shot. See DESIGN-DECISIONS.md, *Screenshots are generated*.
//
// Content goes in by a synthetic paste, not by typing: the editor continues
// lists and closes brackets as a person types, so typed markdown comes out
// doubled. A paste is also how most real content arrives.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { findChrome, startServer, watchConsole, clickText } from './harness.mjs'

const PORT = process.env.SHOTS_PORT || 8598 // not 8484, the dev instance, or 8599, the UI suite
const BASE = `http://127.0.0.1:${PORT}`
const OUT = join(import.meta.dirname, '../../site/shots')

// The size a shot is taken at, in CSS pixels, and the pixel ratio. Twice the
// pixels keeps text sharp when the site scales the image down to its column.
const VIEWPORT = { width: 960, height: 660, deviceScaleFactor: 2 }

const DOCUMENT = `# Release 2.4

The release goes out on **Thursday**. Each owner ticks their line when it is done.

- [x] Freeze the release branch
- [x] Run the migration on staging
- [ ] Update the changelog
- [ ] Tell support what changed

| Service | Owner | Status |
|:--|:--|:--|
| API | Alice | ready |
| Web | Bob | in review |

> [!NOTE]
> To roll back, deploy the previous tag.
`

// Tab-separated, as a paste from another spreadsheet arrives.
// Four columns, because a chart is placed beside the range it charts.
const SHEET = [
  ['Item', 'Jul', 'Aug', 'Sep'],
  ['Hosting', '120', '120', '140'],
  ['Support', '80', '95', '90'],
  ['Licences', '45', '45', '45'],
  ['Total', '=SUM(B2:B4)', '=SUM(C2:C4)', '=SUM(D2:D4)'],
].map((r) => r.join('\t')).join('\n')

// Dispatches a paste carrying `text` at the element matching `selector`.
const paste = (page, selector, text) =>
  page.evaluate((s, t) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', t)
    document.querySelector(s).dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    )
  }, selector, text)

// The centre of a cell, from the grid's constants: 48/24 headers and the
// 100×24 default cell. The same arithmetic ui_test.mjs uses.
async function cellAt(page, r, c) {
  const b = await page.$eval('.grid', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y }
  })
  return { x: b.x + 48 + c * 100 + 50, y: b.y + 24 + r * 24 + 12 }
}

async function signIn(page, who) {
  await page.goto(BASE, { waitUntil: 'networkidle0' })
  await clickText(page, 'button', who)
  await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
}

async function create(page, title, kind) {
  await page.type('input[placeholder="new document title"]', title)
  if (kind === 'sheet') await page.select('select', 'sheet')
  await clickText(page, 'button', 'Create')
  await page.waitForSelector(kind === 'sheet' ? 'canvas' : '.cm-content', { timeout: 5000 })
  return new URL(page.url()).hash.replace(/^#doc=/, '')
}

// Writes one shot in each scheme. The page is put in a state that does not
// change between runs first: no focus, so no blinking caret, and the pointer
// on `hover` or else off every control.
async function shoot(page, name, hover) {
  await page.evaluate(() => document.activeElement?.blur())
  if (hover) await page.hover(hover)
  else await page.mouse.move(0, VIEWPORT.height - 1)
  for (const scheme of ['light', 'dark']) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])
    // The grid and the charts are canvases that repaint on a scheme change,
    // a frame or two after the CSS does.
    await page.evaluate(() => document.fonts.ready)
    await new Promise((r) => setTimeout(r, 400))
    const path = join(OUT, `${name}-${scheme}.png`)
    await page.screenshot({ path })
    console.log('wrote', path)
  }
}

const dbDir = await mkdtemp(join(tmpdir(), 'docs-shots-'))
const server = await startServer(BASE, join(dbDir, 'shots.db'))
const browser = await puppeteer.launch({
  executablePath: await findChrome(),
  headless: true,
  userDataDir: join(dbDir, 'profile'),
  // Software rasterising and a fixed sRGB profile. On the GPU, edges came out
  // a few levels apart between runs, and a shot that changes with nothing
  // changed is a git diff that says nothing. The profile also keeps a shot
  // taken on another machine from taking on that display's colours.
  args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--force-color-profile=srgb'],
  defaultViewport: VIEWPORT,
})

let failed = false
try {
  await mkdir(OUT, { recursive: true })
  const page = await browser.newPage()
  const console_ = watchConsole(page)
  // A shot of a page that logged an error is a picture of a bug.
  const clean = (what) => {
    const errs = console_.drain()
    if (errs.length) throw new Error(`${what}:\n  ${errs.join('\n  ')}`)
  }

  await signIn(page, 'Alice')

  // ---- document: live preview, with a second person in it ----------------
  const docId = await create(page, 'Release 2.4', 'doc')
  await paste(page, '.cm-content', DOCUMENT)
  await page.waitForFunction(() => document.querySelector('.cm-content').innerText.includes('previous tag'), { timeout: 5000 })
  // The editor scrolls inside its own box, and the paste left it at the end.
  await page.evaluate(() => { document.querySelector('.cm-scroller').scrollTop = 0 })
  await page.evaluate(async (id) => {
    await fetch(`/api/docs/${id}/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@dev.local', role: 'editor' }),
    })
  }, docId)

  // Bob in his own context, so his session does not replace Alice's. He puts
  // his cursor on a line, and Alice's page shows it.
  const ctx = await browser.createBrowserContext()
  const bob = await ctx.newPage()
  const bobConsole = watchConsole(bob)
  // A Yjs client ID is random per session, and a peer's colour is that ID
  // modulo the palette, so Bob would be a different colour on every run and
  // both document shots would change with nothing in the app changed. A
  // seeded generator behind getRandomValues, on Bob's page only, makes the
  // ID, and so the colour, the same every run. It is still a generator, so
  // ids made from it stay distinct.
  await bob.evaluateOnNewDocument(() => {
    let seed = 0x5eed
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return (t ^ (t >>> 14)) >>> 0
    }
    crypto.getRandomValues = (arr) => {
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
      for (let i = 0; i < bytes.length; i++) bytes[i] = next() & 0xff
      return arr
    }
  })
  await signIn(bob, 'Bob')
  await bob.goto(`${BASE}/#doc=${docId}`, { waitUntil: 'networkidle0' })
  await bob.waitForSelector('.cm-content', { timeout: 5000 })
  await bob.evaluate(() => {
    const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('Update the changelog'))
    const range = document.createRange()
    range.setStart(line.lastChild, line.lastChild.length ?? line.lastChild.textContent.length)
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  })
  await bob.focus('.cm-content')
  await page.waitForSelector('.cm-ySelectionCaret', { timeout: 5000 })
  clean('the document')
  // The name tag on a remote caret shows on hover, and a caret without a
  // name does not say whose it is.
  await shoot(page, 'document', '.cm-ySelectionCaret')
  const bobErrs = bobConsole.drain()
  if (bobErrs.length) throw new Error(`Bob's page:\n  ${bobErrs.join('\n  ')}`)
  await ctx.close()

  // ---- sheet: formulas over a paste, and a chart of it --------------------
  await page.goto(BASE, { waitUntil: 'networkidle0' })
  await page.waitForSelector('input[placeholder="new document title"]', { timeout: 5000 })
  await create(page, 'Running costs', 'sheet')
  const a1 = await cellAt(page, 0, 0)
  await page.mouse.click(a1.x, a1.y)
  await paste(page, '.grid', SHEET)
  const d4 = await cellAt(page, 3, 3)
  await page.mouse.move(a1.x, a1.y)
  await page.mouse.down()
  await page.mouse.move(d4.x, d4.y, { steps: 4 })
  await page.mouse.up()
  await clickText(page, 'button', 'chart')
  await page.waitForSelector('.chart', { timeout: 5000 })
  await page.type('.chart input[placeholder="Chart title"]', 'Running costs by month')
  await page.keyboard.press('Enter')
  // A total selected, so the formula bar shows a formula rather than a label.
  const b5 = await cellAt(page, 4, 1)
  await page.mouse.click(b5.x, b5.y)
  await page.waitForFunction(() => document.querySelector('.formula-bar input').value.startsWith('='), { timeout: 5000 })
  clean('the sheet')
  await shoot(page, 'sheet')
} catch (e) {
  failed = true
  console.error('FAIL:', e.message)
} finally {
  await browser.close()
  server.kill()
  await rm(dbDir, { recursive: true, force: true })
}
if (failed) process.exit(1)
