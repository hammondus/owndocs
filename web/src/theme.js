// The colours a canvas needs, resolved from the CSS token system.
//
// Everything else in this app gets its colours by naming a token in CSS and
// letting the cascade resolve it — see the top of app.css. A canvas cannot do
// that: `ctx.fillStyle` takes a colour string, and `var(--ink)` is not one. So
// this module is the one place that reads the token system from JavaScript,
// and the sheet grid and charts are its only consumers.
//
// It exists to keep a second palette from growing. The alternative — literal
// hex in the drawing code — is what was there before, and it is why a sheet
// stayed a white rectangle in a dark application: those values could not
// follow the scheme because nothing connected them to it.

// What the canvas calls a colour, and which token answers for it. Deliberately
// a mapping rather than a pass-through: the drawing code should say `ink` and
// `gridline`, while the decision about *which* token that is stays here, in one
// readable list. Nothing below adds a colour to the system — every entry is a
// token the interface already uses somewhere else.
const TOKENS = {
  ground: '--surface',
  headerGround: '--surface-2',
  headerActive: '--signal-soft',
  ink: '--ink',
  ink2: '--ink-2',
  gridline: '--line',
  edge: '--line-strong',
  signal: '--signal',
  signalTint: '--signal-tint',
  onSignal: '--on-signal',
  danger: '--danger',
  comment: '--marker-comment',
  // The ground under an unlocked cell on a protected sheet. A default the
  // cell's own background overrides, so the colour cannot drift from the
  // editability the way a hand-applied one does.
  cellUnlocked: '--cell-unlocked',
  // Ink for a cell the author gave a background to. Pinned dark in both
  // schemes, and shared with the document highlight grounds it is named for —
  // see canvasColors() below for why a cell background is treated as paper.
  paperInk: '--doc-h-ink',
}

// Chart series, in order. Kept apart from the map above because these are a
// *list* — a chart asks for the nth series colour, never for a colour by name.
const SERIES_TOKENS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4',
                       '--chart-5', '--chart-6', '--chart-7', '--chart-8']

let cache = null

// A custom property's computed value is the text `light-dark(#fff, #16191e)`,
// not a colour: substitution happens where the property is *used*, so reading
// `getPropertyValue('--surface')` gives back the function, unresolved. Using it
// is therefore the only way to resolve it — hence a throwaway element that
// takes `color: var(--token)` and is asked what colour it ended up.
//
// One forced style recalculation per token, which is why the result is cached.
// It is recomputed only when the scheme actually changes, never per frame.
export function canvasColors() {
  if (cache) return cache
  const probe = document.createElement('span')
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const resolve = (token) => {
    probe.style.color = `var(${token})`
    return getComputedStyle(probe).color
  }
  cache = {}
  for (const [name, token] of Object.entries(TOKENS)) cache[name] = resolve(token)
  cache.series = SERIES_TOKENS.map(resolve)
  probe.remove()
  return cache
}

const subscribers = new Set()

function invalidate() {
  cache = null
  for (const cb of subscribers) cb()
}

// Two ways the scheme changes, and both have to be watched. The attribute is
// the reader's own choice, written by prefs.js; the media query is the machine
// changing its mind underneath a reader who chose "System". Watching only the
// first leaves a sheet stale at sunset on a Mac set to auto.
//
// Installed once and never torn down: both targets outlive every component, and
// a listener on the root element for the life of the tab is not a leak worth
// the bookkeeping to avoid.
let watching = false
function watch() {
  if (watching) return
  watching = true
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', invalidate)
  new MutationObserver(invalidate).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
}

// Call back when the colours have changed and anything painted needs painting
// again. Returns an unsubscribe, so a component that goes away stops being
// asked to redraw a canvas it no longer owns.
export function onSchemeChange(cb) {
  watch()
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}
