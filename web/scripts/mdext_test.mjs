// The parser extensions, asserted against real parses. These are the only
// markdown constructs in this project the grammar did not already know, so
// they are the only ones where "does it parse" is a real question — everything
// else is decoration over a tree lezer-markdown built.
//
// Run from web/: node scripts/mdext_test.mjs
import { markdownLanguage } from '@codemirror/lang-markdown'
import { markdownExtensions, indexFootnotes } from '../src/mdext.js'
import { emojiFor } from '../src/emoji.js'

// Exactly what editor.js builds. `markdownLanguage` is lang-markdown's
// *extended* parser and already carries GFM plus Subscript, Superscript and
// Emoji — so those three were parsing in this app before any of this work, and
// were only ever missing a decoration. Only Highlight, DefinitionList and
// Footnote are added here.
//
// configure() takes the extension (or a nested array of them) directly. An
// object like `{extensions: [...]}` is not a MarkdownConfig, and is accepted
// and ignored in silence — which is how the first version of this file managed
// to pass its superscript assertions while both new extensions did nothing.
const parser = markdownLanguage.parser.configure(markdownExtensions)

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

// Every node of one name, as the source text it covers. Assertions read as
// "what did the parser decide these characters are", which is the question.
function nodes(doc, name) {
  const out = []
  parser.parse(doc).iterate({
    enter(n) {
      if (n.name === name) out.push(doc.slice(n.from, n.to))
    },
  })
  return out
}

const has = (doc, name) => nodes(doc, name).length > 0

// ---- ==highlight== ---------------------------------------------------------

eq(nodes('a ==marked== b', 'Highlight'), ['==marked=='], 'a highlight is recognised')
eq(nodes('a ==marked== b', 'HighlightMark'), ['==', '=='], 'both markers are nodes, so they can be hidden')
eq(nodes('==two words here==', 'Highlight'), ['==two words here=='], 'a highlight spans spaces')
eq(nodes('==a== and ==b==', 'Highlight'), ['==a==', '==b=='], 'two highlights on a line do not merge')
eq(nodes('a = b == c', 'Highlight'), [], 'a stray equals sign is not a highlight')
eq(nodes('====', 'Highlight'), [], 'three or more equals signs are left alone')
eq(nodes('== not opened', 'Highlight'), [], 'a marker followed by a space does not open')

// The reason this reuses lezer-markdown's own open/close rules rather than a
// regex: highlights have to nest with the rest of the inline grammar.
eq(nodes('==**bold** inside==', 'StrongEmphasis'), ['**bold**'], 'inline markup still parses inside a highlight')
eq(nodes('`==not a highlight==`', 'Highlight'), [], 'code spans win, as they do for every other marker')

// A setext heading underline is a run of `=` on its own line, and must survive.
eq(has('Title\n=====\n', 'SetextHeading1'), true, 'a setext heading is not eaten by the highlight rule')

// ---- definition lists ------------------------------------------------------

const DL = 'Widget\n: A small thing\n'
eq(nodes(DL, 'DefinitionTerm'), ['Widget'], 'the line above the colon is the term')
eq(nodes(DL, 'DefinitionDesc'), [': A small thing'], 'the colon line is the definition')
eq(nodes(DL, 'DefinitionMark'), [':'], 'the colon is its own node, so it can be hidden')
eq(has(DL, 'DefinitionList'), true, 'the pair is wrapped in a list')

eq(
  nodes('Widget\n: One sense\n: Another sense\n', 'DefinitionDesc'),
  [': One sense', ': Another sense'],
  'a term can carry several definitions',
)
eq(
  nodes('Widget\n: A thing\nGadget\n: Another thing\n', 'DefinitionTerm'),
  ['Widget', 'Gadget'],
  'a later plain line starts the next term, no blank line needed',
)

// The case that must NOT become a definition list, because it is how most
// paragraphs in any document are shaped.
eq(has('Just a paragraph\nwrapped over two lines\n', 'DefinitionList'), false, 'a wrapped paragraph stays a paragraph')
eq(has('Widget\n', 'DefinitionList'), false, 'a term with nothing under it stays a paragraph')
eq(has(': orphan definition\n', 'DefinitionList'), false, 'a definition with no term above it is not a list')
eq(has('Ratio\n:not spaced\n', 'DefinitionList'), false, 'a colon needs a space after it, or `12:30` starts a list')

eq(
  nodes('Widget\n: A **small** thing\n', 'StrongEmphasis'),
  ['**small**'],
  'inline markup parses inside a definition',
)
eq(nodes('# Heading\n\nWidget\n: A thing\n', 'DefinitionTerm'), ['Widget'], 'a list after another block still parses')

// A definition list must not swallow the constructs that share its shape.
eq(has('| a | b |\n| - | - |\n', 'Table'), true, 'tables still parse with the leaf parser installed')
eq(has('Title\n-----\n', 'SetextHeading2'), true, 'setext headings still parse')

// ---- footnotes -------------------------------------------------------------
// The grammar's job here is only to mark the two halves. Pairing and numbering
// them is indexFootnotes, tested below.

eq(nodes('A claim.[^1]', 'FootnoteRef'), ['[^1]'], 'a reference is recognised')
eq(nodes('A claim.[^why-it-broke]', 'FootnoteRef'), ['[^why-it-broke]'], 'a label can be a word')
eq(nodes('[^1]: The note.', 'Footnote'), ['[^1]: The note.'], 'a definition is a block of its own')
eq(nodes('[^1]: The note.', 'FootnoteMark'), ['[^1]: '], 'the marker is a node, so it can be replaced by a number')
eq(
  nodes('[^1]: A **strong** note.', 'StrongEmphasis'),
  ['**strong**'],
  'a definition body is parsed as inline markdown',
)

// The reason the inline rule has to run before Link: without it, both halves
// are ordinary bracketed spans and get styled as hyperlinks.
eq(nodes('A claim.[^1]', 'Link'), [], 'a reference is not left as a link')
eq(nodes('See [the docs](http://x)', 'Link'), ['[the docs](http://x)'], 'ordinary links still parse')
eq(nodes('See [the docs](http://x)', 'FootnoteRef'), [], 'and are not mistaken for footnotes')

// The shapes that must NOT be footnotes.
eq(nodes('An array index a[^2]', 'FootnoteRef'), ['[^2]'], 'a bracketed caret is a reference wherever it appears')
eq(nodes('[^ 1]: spaced', 'Footnote'), [], 'a label cannot contain a space')
eq(nodes('[]: empty', 'Footnote'), [], 'a definition needs a caret')
eq(nodes('[^1] not a definition', 'Footnote'), [], 'a reference alone is not a definition')
eq(nodes('  [^1]: indented', 'Footnote'), ['[^1]: indented'], 'a definition may be indented')

// Block parsers are not consulted mid-paragraph unless the construct says it
// can interrupt one. Without that, typing the note directly under the text
// that cites it does nothing whatsoever, and nothing says why.
eq(
  nodes('A claim.[^1]\n[^1]: the note\n', 'Footnote'),
  ['[^1]: the note'],
  'a definition interrupts a paragraph rather than vanishing into it',
)
eq(
  nodes('A claim.[^1]\n[^1]: the note\n', 'Paragraph'),
  ['A claim.[^1]'],
  'and the paragraph above it ends where it should',
)

// A definition inside a list must not swallow the item, and a reference inside
// one must still be found.
eq(nodes('- item with a note[^a]\n', 'FootnoteRef'), ['[^a]'], 'a reference works inside a list item')

// ---- footnote numbering ----------------------------------------------------
// The pairing pass, which is where the real logic is. A footnote's number is
// not a property of the text carrying it — it comes from how many other
// references precede it — so this is the one construct that cannot be checked
// by looking at a single node.

const index = (doc) => indexFootnotes(parser.parse(doc), (a, b) => doc.slice(a, b))
const numbering = (doc) => Object.fromEntries(index(doc).numbers)

eq(numbering('A[^1] B[^2]\n\n[^1]: x\n[^2]: y\n'), { 1: 1, 2: 2 }, 'numbered in order')

// The case the whole pass exists for: numbers come from REFERENCE order, not
// from the labels and not from the order the notes were written.
eq(
  numbering('First[^zebra] second[^apple]\n\n[^apple]: a\n[^zebra]: z\n'),
  { zebra: 1, apple: 2 },
  'labels do not decide the number, and neither does definition order',
)
eq(
  numbering('One[^b] two[^a] three[^b]\n\n[^a]: x\n[^b]: y\n'),
  { b: 1, a: 2 },
  'citing the same note twice does not give it two numbers',
)

// The two half-finished states, both of which must still render.
eq(numbering('A claim[^missing]\n'), { missing: 1 }, 'a reference with no note still gets a number')
eq(numbering('Text\n\n[^lonely]: nobody cites this\n'), { lonely: 1 }, 'a note nobody cites still gets one')
eq(
  numbering('A[^used]\n\n[^unused]: first in the file\n[^used]: cited\n'),
  { used: 1, unused: 2 },
  'cited notes are numbered before uncited ones, whatever their order in the file',
)

{
  const i = index('A claim[^1] and more[^1]\n\n[^1]: The note.\n')
  eq(i.defs.has('1'), true, 'the definition is located')
  eq(i.firstRef.get('1') < i.defs.get('1'), true, 'the FIRST reference is the one recorded')
  eq(i.numbers.size, 1, 'one label, one number')
}
{
  // Dangling in the other direction, which the renderer marks in red.
  const i = index('A claim[^nope]\n')
  eq(i.defs.has('nope'), false, 'a citation of nothing has no definition to point at')
}

// A definition may itself cite another note.
eq(
  numbering('A[^a]\n\n[^a]: see also[^b]\n[^b]: the other one\n'),
  { a: 1, b: 2 },
  'a reference inside a note is numbered too',
)

eq(numbering('No footnotes here.\n'), {}, 'a document without footnotes indexes to nothing')

// ---- superscript, subscript, emoji -----------------------------------------
// Shipped by @lezer/markdown; asserted because switching them on is a config
// line that could be silently dropped, and because they share `~` and `^` with
// things that already meant something.

eq(nodes('x^2^ + y^2^', 'Superscript'), ['^2^', '^2^'], 'superscript parses')
eq(nodes('H~2~O', 'Subscript'), ['~2~'], 'subscript parses')
eq(nodes('~~struck out~~', 'Strikethrough'), ['~~struck out~~'], 'a double tilde is still strikethrough, not subscript')
eq(nodes('~~struck out~~', 'Subscript'), [], 'strikethrough is not read as two subscripts')
eq(nodes('a ^ b', 'Superscript'), [], 'a lone caret is not superscript')
eq(nodes('x^a b^', 'Superscript'), [], 'superscript stops at a space, so prose is not swallowed')
eq(nodes('see :warning: here', 'Emoji'), [':warning:'], 'an emoji shortcode parses')
eq(nodes('http://host:8080/x', 'Emoji'), [], 'a port number is not a shortcode')
// A real limitation of the upstream extension, asserted so it is a known
// property rather than a surprise: its character class is [a-zA-Z_0-9], so
// GitHub's `:+1:` and `:-1:` never reach the table. The `thumbsup` and
// `thumbsdown` aliases are carried for exactly this reason.
eq(nodes('nice :+1:', 'Emoji'), [], ':+1: is not matched by the upstream extension')

// ---- the emoji table -------------------------------------------------------
// The node only marks `:name:`; turning it into a character is ours.

eq(emojiFor('warning'), '⚠️', 'a known shortcode resolves')
eq(emojiFor('thumbsup'), '👍', 'the alias for the shortcode that cannot parse resolves')
eq(emojiFor('not_a_real_emoji_name'), null, 'an unknown shortcode resolves to nothing, and stays literal text')
eq(emojiFor(''), null, 'an empty shortcode resolves to nothing')
eq(emojiFor('constructor'), null, 'a shortcode named after an Object property resolves to nothing')

if (failures > 0) process.exit(1)
console.log('\nALL PASS')
