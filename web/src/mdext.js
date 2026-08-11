// Two Lezer parser extensions: `==highlight==` and definition lists. Both are
// plain text that survives a round trip through the `.md` file, and neither is
// something CommonMark or GFM knows, so the parser has to be taught them
// before the decoration layer can style anything at all.
//
// This imports @lezer/markdown only — no CodeMirror, no DOM — so
// scripts/mdext_test.mjs can parse strings in node and assert on the tree.
// Superscript, subscript and emoji need nothing here: @lezer/markdown ships
// those three itself, and editor.js just switches them on.

// ---- ==highlight== ---------------------------------------------------------

// Modelled directly on the Strikethrough extension in @lezer/markdown, down to
// the open/close rules — `==` behaves like `~~`, so behaving *differently*
// would be the surprise. addDelimiter lets the inline parser match pairs
// across other inline structure, which a hand-rolled regex could not.
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' }

// The same class @lezer/markdown uses to decide whether a delimiter can open
// or close: a marker next to punctuation behaves differently from one next to
// a letter, which is what stops `a==b` from opening a highlight.
const Punctuation = /[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~\xA1‐-‧]|[\p{S}\p{P}]/u

export const Highlight = {
  defineNodes: [
    // No `style` entry: the live preview decorates Highlight itself, and a
    // highlight tag here would put a second rule on the same span.
    { name: 'Highlight' },
    { name: 'HighlightMark' },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        // `=` `=`, and not a third — `===` is a setext heading's business.
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1
        const before = cx.slice(pos - 1, pos)
        const after = cx.slice(pos + 2, pos + 3)
        const spaceBefore = /\s|^$/.test(before)
        const spaceAfter = /\s|^$/.test(after)
        const punctBefore = Punctuation.test(before)
        const punctAfter = Punctuation.test(after)
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !spaceAfter && (!punctAfter || spaceBefore || punctBefore),
          !spaceBefore && (!punctBefore || spaceAfter || punctAfter),
        )
      },
      after: 'Emphasis',
    },
  ],
}

// ---- definition lists ------------------------------------------------------

// Pandoc / PHP Markdown Extra shape:
//
//   Term
//   : What it means
//   : And another sense of it
//
// A leaf-block parser, the same machinery GFM tables use, and for the same
// reason: the first line looks exactly like a paragraph and only the *second*
// line reveals what the block is. So the parser accumulates lines and decides
// in finish(), which is also what makes the terminating blank line free.
//
// Deliberately strict about what a definition line is — `:` followed by a
// space, at the start of the line. Pandoc also allows `~`, indented
// continuation lines, and a blank line between term and definition. Those are
// left out: each one costs a lookahead rule, and none of them is what anyone
// writing a definition list by hand actually types.
const DEF_LINE = /^:[ \t]/

class DefinitionParser {
  constructor(termFrom, termText) {
    // null until the second line settles it; false once it is decided this is
    // an ordinary paragraph after all; otherwise the elements built so far.
    this.elts = null
    // Kept rather than re-read: BlockContext exposes no way back to the input,
    // so the first line's text has to be carried from where it was handed to
    // us.
    this.termFrom = termFrom
    this.termText = termText
  }

  // A term can hold inline markup, so it is parsed rather than taken flat.
  term(cx, from, text) {
    return cx.elt('DefinitionTerm', from, from + text.length, cx.parser.parseInline(text, from))
  }

  desc(cx, from, text) {
    return cx.elt('DefinitionDesc', from, from + text.length, [
      cx.elt('DefinitionMark', from, from + 1),
      ...cx.parser.parseInline(text.slice(1), from + 1),
    ])
  }

  nextLine(cx, line, leaf) {
    if (this.elts === false) return false
    const from = cx.lineStart + line.pos
    const text = line.text.slice(line.pos)
    const isDef = DEF_LINE.test(text)
    if (this.elts === null) {
      // The second line decides. A term with no definition under it is a
      // paragraph, and has to stay one.
      if (!isDef) {
        this.elts = false
        return false
      }
      this.elts = [this.term(cx, this.termFrom, this.termText)]
    }
    // A later non-definition line starts the next term, so several pairs can
    // share one block without a blank line between them.
    this.elts.push(isDef ? this.desc(cx, from, text) : this.term(cx, from, text))
    return false
  }

  finish(cx, leaf) {
    if (!this.elts) return false
    cx.addLeafElement(
      leaf,
      cx.elt('DefinitionList', leaf.start, leaf.start + leaf.content.length, this.elts),
    )
    return true
  }
}

export const DefinitionList = {
  defineNodes: [
    { name: 'DefinitionList', block: true },
    'DefinitionTerm',
    'DefinitionDesc',
    { name: 'DefinitionMark' },
  ],
  parseBlock: [
    {
      name: 'DefinitionList',
      // Every paragraph gets a parser, because any line at all can be a term.
      // Tables can prefilter on "contains a pipe"; there is no equivalent
      // here, so the object stays as small as possible instead.
      leaf(cx, leaf) {
        return DEF_LINE.test(leaf.content)
          ? null // a block that *starts* with `: ` has no term above it
          : new DefinitionParser(leaf.start, leaf.content)
      },
      before: 'SetextHeading',
    },
  ],
}

export const markdownExtensions = [Highlight, DefinitionList]
