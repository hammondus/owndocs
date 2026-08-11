// Reading preferences: how markdown renders *for you*.
//
// Deliberately not part of the document — see DESIGN-DECISIONS.md
// "Formatting". Markdown says what a piece of text *is*; this says how it
// looks to one person on one machine, and nothing here reaches the file, the
// CRDT or the git export. It is the reader's stylesheet.
//
// Applied as CSS custom properties on the root element, so a change takes
// effect everywhere at once with no component needing to know.

const KEY = 'docs:reading'

// System stacks only: no font files to ship, so no assets, no licensing, and
// nothing to load before text can be painted.
export const FONTS = [
  { id: 'system', label: 'System', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: 'serif', label: 'Serif', stack: 'Charter, Georgia, "Times New Roman", Times, serif' },
  { id: 'sans', label: 'Sans', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: 'mono', label: 'Monospace', stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
]

export const SIZES = [14, 15, 16, 17, 18, 20, 22]
export const LINE_HEIGHTS = [1.4, 1.6, 1.8, 2.0]

// Measure in `ch` — the width of a "0" — so the column holds roughly the same
// number of characters whatever the size, which is the thing that actually
// governs reading comfort. 0 means full width.
export const MEASURES = [
  { value: 0, label: 'Full width' },
  { value: 60, label: 'Narrow' },
  { value: 75, label: 'Comfortable' },
  { value: 90, label: 'Wide' },
]

// `family` overrides `font` when set: a specific family the reader named or
// picked from the ones installed on their machine. Kept as a separate field so
// the four built-ins stay ids — relabelling or re-stacking one later then does
// not orphan everyone's stored preference.
export const DEFAULTS = { font: 'system', size: 16, lineHeight: 1.6, measure: 75, family: '' }

// A family name is user input that ends up in a CSS declaration, so it is
// reduced to the characters a font name can actually contain. Not a security
// boundary — setProperty cannot break out of a declaration, since the CSSOM
// parses the value rather than splicing it into a stylesheet — but a name with
// a stray quote or semicolon silently invalidates the whole thing, which is
// the same class of failure as `Helvetica Neue` unquoted.
export function familyStack(name) {
  const clean = String(name).replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 64)
  if (!clean) return ''
  // Always quoted, so multi-word names work, and always with a generic
  // fallback so a family that turns out to be missing still renders.
  return `"${clean}", system-ui, sans-serif`
}

// The fonts actually installed, when the browser will say. The Local Font
// Access API is Chromium-only, needs a secure context, and prompts for
// permission — so it must be called from a user gesture and must degrade to
// null rather than throwing. Everywhere else, the reader types a name instead.
export async function listLocalFonts() {
  if (typeof window === 'undefined' || typeof window.queryLocalFonts !== 'function') return null
  try {
    const fonts = await window.queryLocalFonts()
    return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b))
  } catch {
    // Permission refused, or not a secure context. Neither is an error worth
    // surfacing — the text field still works.
    return null
  }
}

export const localFontsSupported = () =>
  typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function'

// localStorage throws rather than returning null in some privacy modes, so
// every access is guarded: a preference failing to save must not take the
// editor down with it.
function storage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function load() {
  try {
    const raw = storage()?.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    // Merged over the defaults rather than trusted wholesale: a stored blob
    // from an older version is missing whatever was added since.
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function save(prefs) {
  try {
    storage()?.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // Out of quota or blocked: the preference still applies for this session.
  }
}

export function apply(prefs, root = document.documentElement) {
  // A named family wins over the built-in stacks; an unusable one falls back
  // rather than leaving the property unset to inherit whatever the page had.
  const custom = prefs.family ? familyStack(prefs.family) : ''
  const font = FONTS.find((f) => f.id === prefs.font) || FONTS[0]
  root.style.setProperty('--reading-font', custom || font.stack)
  root.style.setProperty('--reading-size', `${prefs.size}px`)
  root.style.setProperty('--reading-line-height', String(prefs.lineHeight))
  root.style.setProperty('--reading-measure', prefs.measure ? `${prefs.measure}ch` : 'none')
}
