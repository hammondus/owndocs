// The appearance vocabulary a rich document may use: eight hues in two roles,
// and a size scale. One table, which the CSS custom properties, the Format
// drawer and the allowlist all read — three copies of a colour list is three
// chances for them to disagree. `EmojiPicker` set this precedent by importing
// `EMOJI_GROUPS` verbatim so that adding an entry in one place puts it
// everywhere.
//
// No CodeMirror, no DOM and no imports at all, by the rule table.js set, so
// scripts/palette_test.mjs runs it under plain node.
//
// Why named tokens and not a colour picker, why relative sizes and not point
// sizes, and why eight hues rather than twenty-four: DESIGN-DECISIONS.md,
// *Rich documents*. The short version is that the document names *which* red
// and the scheme decides what red means, so a document stays readable when the
// reader is in dark mode and when the palette is later retuned.

// Hue angles in OKLCH, evenly enough spaced to stay tellable apart. Lightness
// and chroma are fixed per role in app.css and only the hue varies here, which
// is what keeps any one colour from carrying more visual weight than its
// neighbours.
//
// A note on `yellow`: as *text* it reads amber, because a text colour has to
// contrast with the page and there is no light yellow that does. As a
// highlight ground it is properly yellow. The name follows the hue rather than
// the appearance, so the two roles stay in step.
export const HUES = [
  { token: 'red', label: 'Red', hue: 25 },
  { token: 'orange', label: 'Orange', hue: 60 },
  { token: 'yellow', label: 'Yellow', hue: 95 },
  { token: 'green', label: 'Green', hue: 145 },
  { token: 'teal', label: 'Teal', hue: 195 },
  { token: 'blue', label: 'Blue', hue: 255 },
  { token: 'purple', label: 'Purple', hue: 300 },
  { token: 'pink', label: 'Pink', hue: 345 },
]

// Relative, never a point size: an absolute size fights the reader's own
// setting, and there is no good answer to which should win. "Larger than the
// text around it" stays true at any base size.
export const SIZES = [
  { token: 'size-sm', label: 'Small' },
  { token: 'size-lg', label: 'Large' },
  { token: 'size-xl', label: 'Extra large' },
]

// Alignment, which is the odd one out: a *block* property carried by a fenced
// div rather than an inline span, so it has a namespace of its own and never
// mixes with the token families below.
//
// `center` keeps Pandoc's spelling because that is what the syntax is; the
// label is ours. No `left` token — left is what a paragraph already is, and
// removing the div says so more honestly than a word claiming to set it.
export const ALIGNMENTS = [
  { token: 'center', label: 'Centred' },
  { token: 'right', label: 'Right' },
  { token: 'justify', label: 'Justified' },
]

const ALIGN = new Set(ALIGNMENTS.map((a) => a.token))

export const isAlign = (token) => ALIGN.has(token)

// Same allowlist discipline as the inline tokens, and for the same reason: the
// word comes out of the document, and it must be looked up rather than
// templated into a class name.
export const alignClass = (token) => (isAlign(token) ? `md-align-${token}` : null)

// A token belongs to exactly one family, and applying one replaces whatever
// that family held before — so a span can be red *and* large, but not two
// sizes. `c` is the text colour, `h` the highlight ground.
export const FAMILIES = ['c', 'h', 'size']

export const TEXT_TOKENS = HUES.map((h) => `c-${h.token}`)
export const HIGHLIGHT_TOKENS = HUES.map((h) => `h-${h.token}`)
export const SIZE_TOKENS = SIZES.map((s) => s.token)

// The allowlist. A token not in here is not a token: the attribute is left as
// the literal text it was typed as, which is what it looks like in the `.md`
// file read by anything else — the same failure an unknown `:shortcode:` gets,
// and for the same reason.
const ALL = new Set([...TEXT_TOKENS, ...HIGHLIGHT_TOKENS, ...SIZE_TOKENS])

export const isToken = (token) => ALL.has(token)

export function familyOf(token) {
  if (!isToken(token)) return null
  return token.startsWith('size-') ? 'size' : token.slice(0, 1)
}

// The CSS classes for a list of tokens, or null when none of them is known.
//
// Built from the allowlist rather than by templating the token into a class
// name. That is the load-bearing part: splicing user text into a class is an
// injection surface into the app's own stylesheet, and would let a document
// name interface classes and restyle the app around itself.
export function classesFor(tokens) {
  const known = tokens.filter(isToken)
  return known.length ? known.map((t) => `md-${t}`).join(' ') : null
}

// Apply one token, replacing whatever its family held. A null token clears the
// family — which is how "none" works, and why clearing every family unwraps
// the span rather than leaving an empty `{}` behind.
export function withToken(tokens, family, token) {
  const kept = tokens.filter((t) => familyOf(t) !== family)
  return token ? [...kept, token] : kept
}

// The markdown for a span whose label is already *source* — escapes intact, as
// it came out of the document. Rewriting an existing span's attributes goes
// through here, so a label containing `\]` survives the rewrite untouched
// instead of being escaped a second time.
//
// Returns null when nothing is left to say, which is what makes clearing the
// last token an unwrap rather than an empty `{}`.
//
// Text that is *not* source yet — a fresh selection, which may hold brackets of
// its own — is escaped by the caller before it arrives. Deliberately not done
// in here: escaping changes the label's length, and the caller measures the new
// selection from it.
export function attrSpanSource(labelSource, tokens) {
  const known = tokens.filter(isToken)
  return known.length ? `[${labelSource}]{${known.map((t) => `.${t}`).join(' ')}}` : null
}
