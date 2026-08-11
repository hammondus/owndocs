// The parser extensions, asserted against real parses. These are the only
// markdown constructs in this project the grammar did not already know, so
// they are the only ones where "does it parse" is a real question — everything
// else is decoration over a tree lezer-markdown built.
//
// Run from web/: node scripts/mdext_test.mjs
import { markdownLanguage } from '@codemirror/lang-markdown'
import { markdownExtensions } from '../src/mdext.js'
import { emojiFor } from '../src/emoji.js'

// Exactly what editor.js builds. `markdownLanguage` is lang-markdown's
// *extended* parser and already carries GFM plus Subscript, Superscript and
// Emoji — so those three were parsing in this app before any of this work, and
// were only ever missing a decoration. Only Highlight and DefinitionList are
// added here.
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
