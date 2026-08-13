// palette.js is the allowlist, and an allowlist is only worth having if it
// actually refuses things — a token spliced into a class name instead of
// looked up would let a document name interface classes and restyle the app
// around itself. It is also the family arithmetic: applying a colour must
// replace the colour and leave the size alone, or spans stack.
// Run from web/: node scripts/palette_test.mjs
import {
  HUES,
  SIZES,
  TEXT_TOKENS,
  HIGHLIGHT_TOKENS,
  SIZE_TOKENS,
  isToken,
  familyOf,
  classesFor,
  withToken,
  attrSpanSource,
  ALIGNMENTS,
  isAlign,
  alignClass,
} from '../src/palette.js'

let failures = 0
const ok = (what) => console.log('ok:', what)
const fail = (what, detail) => {
  failures++
  console.error(`FAIL: ${what}${detail ? '\n  ' + detail : ''}`)
}
const eq = (got, want, what) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(what)
    : fail(what, `got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`)

// ---- the table -------------------------------------------------------------

eq(HUES.length, 8, 'eight hues')
eq(new Set(HUES.map((h) => h.token)).size, 8, 'hue tokens are unique')
eq(new Set(HUES.map((h) => h.hue)).size, 8, 'hue angles are unique')
eq(TEXT_TOKENS.length + HIGHLIGHT_TOKENS.length + SIZE_TOKENS.length, 19, 'sixteen colours and three sizes')

// Alignment has a namespace of its own: it is a block property carried by a
// fenced div, and must never mix with the inline token families.
eq(ALIGNMENTS.map((a) => a.token), ['center', 'right', 'justify'], 'three alignments')
eq([isAlign('center'), isAlign('justify')], [true, true], 'the real alignments are alignments')
eq(isAlign('left'), false, 'there is no left token — removing the div is how you get left')
eq(isAlign('c-red'), false, 'an inline token is not an alignment')
eq(alignClass('center'), 'md-align-center', 'an alignment becomes its class')
eq(alignClass('sideways'), null, 'an invented one becomes nothing')
eq(familyOf('center'), null, 'alignment is not one of the inline families')

// ---- the allowlist ---------------------------------------------------------

eq([isToken('c-red'), isToken('h-red'), isToken('size-lg')], [true, true, true], 'the real tokens are tokens')
eq(isToken('c-taupe'), false, 'an invented colour is not')
eq(isToken('size-huge'), false, 'an invented size is not')
// The one that matters: a document must not be able to name the app's own
// classes, or a stylesheet becomes writable from inside a document.
eq(isToken('viewbar'), false, 'an interface class is not a token')
eq(isToken('md-c-red'), false, 'the rendered class name is not itself a token')
eq(isToken(''), false, 'the empty token is not one')

eq(classesFor(['c-red']), 'md-c-red', 'a token becomes its class')
eq(classesFor(['c-red', 'size-lg']), 'md-c-red md-size-lg', 'several tokens become several classes')
eq(classesFor(['c-red', 'nonsense']), 'md-c-red', 'an unknown token is dropped, the rest survive')
// Null rather than '': the caller uses it to decide the whole construct is not
// a construct and should stay as literal text.
eq(classesFor(['nonsense']), null, 'nothing recognised yields null, not an empty class')
eq(classesFor([]), null, 'no tokens at all yields null')

// ---- families --------------------------------------------------------------

eq([familyOf('c-blue'), familyOf('h-blue'), familyOf('size-sm')], ['c', 'h', 'size'], 'each token knows its family')
eq(familyOf('nonsense'), null, 'an unknown token has no family')

eq(withToken(['c-red'], 'c', 'c-blue'), ['c-blue'], 'a colour replaces the colour')
eq(withToken(['c-red'], 'size', 'size-lg'), ['c-red', 'size-lg'], 'a size joins the colour rather than replacing it')
eq(withToken(['c-red', 'size-lg'], 'c', 'c-blue'), ['size-lg', 'c-blue'], 'replacing one family leaves the other alone')
eq(withToken(['c-red', 'size-lg'], 'c', null), ['size-lg'], 'a null token clears just that family')
eq(withToken(['c-red'], 'c', null), [], 'clearing the last family leaves nothing')
eq(withToken([], 'h', 'h-yellow'), ['h-yellow'], 'a highlight can be the first thing applied')

// ---- the markdown ----------------------------------------------------------

eq(attrSpanSource('text', ['c-red']), '[text]{.c-red}', 'the ordinary case')
eq(attrSpanSource('text', ['c-red', 'size-lg']), '[text]{.c-red .size-lg}', 'two tokens, space separated')
// Null is what makes clearing the last token an unwrap rather than an empty
// `{}` left in the document.
eq(attrSpanSource('text', []), null, 'no tokens means there is no span to write')
eq(attrSpanSource('text', ['nonsense']), null, 'nor when nothing is recognised')

// Source in, source out: rewriting an existing span must not escape a label
// that is already escaped.
eq(attrSpanSource('a\\]b', ['c-red']), '[a\\]b]{.c-red}', 'an already-escaped label is left alone')
// Escaping fresh text is the caller's job, for the reason attrSpanSource
// states: the label's length is what the new selection is measured from.

if (failures > 0) process.exit(1)
console.log('\nALL PASS')
