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

// ---- footnotes -------------------------------------------------------------

//   Some claim.[^1]
//
//   [^1]: And where it came from.
//
// The odd one out among these constructs, and the reason it was left until
// last: it is the only one that is not local. `[^1]` means nothing on its own —
// its number comes from how many other references precede it, and its content
// lives somewhere else entirely. The grammar here can only mark the two halves;
// pairing and numbering them is a document-wide pass, and that lives in
// editor.js where the whole tree is in reach.
//
// Both halves would otherwise parse as an ordinary `Link` — `[^1]` is a
// bracketed span like any other — which is why the inline rule has to run
// *before* Link rather than merely alongside it.

// A label is anything but a bracket or whitespace: `1`, `note`, `why-it-broke`.
const FOOTNOTE_REF = /^\[\^([^\]\s]+)\]/
const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:[ \t]*/

// The label a footnote node carries, read back from its own source text. Both
// halves start the same way, so one function serves both, and the index does
// not have to remember which kind it is looking at.
export function footnoteLabel(text) {
  const m = FOOTNOTE_REF.exec(text)
  return m ? m[1] : null
}

// Whether that text is a *definition* rather than a reference — the colon is
// the only thing that distinguishes them.
export const isFootnoteDef = (text) => FOOTNOTE_DEF.test(text)

export const Footnote = {
  defineNodes: [
    { name: 'FootnoteRef' },
    { name: 'Footnote', block: true },
    { name: 'FootnoteMark' },
  ],
  parseInline: [
    {
      name: 'FootnoteRef',
      parse(cx, next, pos) {
        // `[` `^`, cheaply, before spending a regex on it.
        if (next !== 91 || cx.char(pos + 1) !== 94) return -1
        const m = FOOTNOTE_REF.exec(cx.slice(pos, cx.end))
        if (!m) return -1
        // No children: the whole `[^1]` is replaced by its number, and when
        // the cursor is on it the raw text shows. Nothing in between needs a
        // node of its own.
        return cx.addElement(cx.elt('FootnoteRef', pos, pos + m[0].length))
      },
      before: 'Link',
    },
  ],
  parseBlock: [
    {
      name: 'Footnote',
      parse(cx, line) {
        const text = line.text.slice(line.pos)
        const m = FOOTNOTE_DEF.exec(text)
        if (!m) return false
        const from = cx.lineStart + line.pos
        const to = cx.lineStart + line.text.length
        const bodyFrom = from + m[0].length
        // Deliberately one line. Pandoc lets a note run on into indented
        // continuation lines; that costs a lookahead rule for a shape nobody
        // types, and a note long enough to need it wants to be a paragraph.
        const elt = cx.elt('Footnote', from, to, [
          cx.elt('FootnoteMark', from, bodyFrom),
          ...cx.parser.parseInline(text.slice(m[0].length), bodyFrom),
        ])
        cx.nextLine()
        cx.addElement(elt)
        return true
      },
      // A definition has to be able to interrupt a paragraph. Without this,
      // block parsers are never consulted for a line in the middle of one, so
      // typing `[^1]: the note` directly under the text that cites it does
      // nothing at all — the line is swallowed as paragraph continuation and
      // the failure is completely silent. Pandoc wants a blank line there;
      // being lenient costs one predicate and removes a trap.
      endLeaf(_, line) {
        return FOOTNOTE_DEF.test(line.text.slice(line.basePos))
      },
      before: 'LinkReference',
    },
  ],
}

// Pair the two halves and number them. Takes a syntax tree and a slice
// function rather than an EditorState, by the rule table.js set, so
// mdext_test.mjs can run it in node against a raw parse.
//
// Numbered by order of first **reference**, which is what every other renderer
// does and the only order a reader can predict — the definitions usually sit
// together at the bottom, so numbering by those would number them by the order
// they were typed. A definition never referenced still gets a number, after
// all the referenced ones, so it renders as a footnote rather than as leftover
// text on the page.
//
// Returns { numbers: label -> n, defs: label -> pos, firstRef: label -> pos }.
// A label present in `numbers` but not in `defs` is a citation of nothing; one
// in `defs` but not `firstRef` is a note nobody cites. Both are shown, because
// both are usually half-finished rather than wrong.
export function indexFootnotes(tree, slice) {
  const numbers = new Map()
  const defs = new Map()
  const firstRef = new Map()
  const defined = []
  tree.iterate({
    enter(node) {
      if (node.name === 'FootnoteRef') {
        const label = footnoteLabel(slice(node.from, node.to))
        if (label) {
          if (!numbers.has(label)) numbers.set(label, numbers.size + 1)
          if (!firstRef.has(label)) firstRef.set(label, node.from)
        }
        return false
      }
      if (node.name === 'Footnote') {
        const label = footnoteLabel(slice(node.from, node.to))
        if (label) {
          if (!defs.has(label)) defs.set(label, node.from)
          defined.push(label)
        }
        // Not `return false`: a note may cite another note, and that reference
        // needs a number like any other.
      }
    },
  })
  for (const label of defined) if (!numbers.has(label)) numbers.set(label, numbers.size + 1)
  return { numbers, defs, firstRef }
}

// ---- attribute spans -------------------------------------------------------
//
//   Some [important]{.c-red} text, and [bigger]{.size-lg}.
//
// Pandoc's bracketed span, and that is the whole point of the choice: it has a
// published spec and a reference implementation to check against, so this is a
// dialect with an owner elsewhere rather than a private syntax. *Formatting*
// rejected inventing one; this is the answer to that objection. See
// DESIGN-DECISIONS, *Pandoc's syntax, not one of ours*.
//
// This file knows the *shape* only. Which tokens mean anything is palette.js's
// business, and the grammar deliberately does not consult it: a parser that
// knew the app's colour list would have to change every time the list did, and
// an unknown token has to survive as literal text anyway.

// Classes only. Pandoc also allows `#id` and `key=value`, and neither has any
// meaning here — accepting them would mean deciding what to do with them, and
// the honest answer is nothing. A token starts with a letter, so `{.2}` is not
// one.
const ATTRS = /^\{((?:\s*\.[A-Za-z][\w-]*)+)\s*\}/

// The `]` closing the `[` this text starts with. A scan rather than a regex
// because the label may contain brackets of its own — a nested link, or an
// escaped one — and a lazy or greedy match picks the wrong one in opposite
// directions.
function labelEnd(src) {
  let depth = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      i++ // an escaped bracket is text, not structure
      continue
    }
    if (c === '[') depth++
    else if (c === ']' && --depth === 0) return i
  }
  return -1
}

// Un-anchored: reads a span off the *front* of `src` and says how long it was,
// which is what the inline parser needs. Returns null if the text does not
// start with one.
function scanSpan(src) {
  const close = labelEnd(src)
  if (close < 0) return null
  const m = ATTRS.exec(src.slice(close + 1))
  if (!m) return null
  return {
    // The label's *source*, escapes and all. Rewriting a span's attributes
    // keeps this verbatim, so nothing has to be re-escaped and nothing can be
    // lost in the round trip.
    text: src.slice(1, close),
    tokens: m[1].trim().split(/\s+/).map((c) => c.slice(1)),
    length: close + 1 + m[0].length,
  }
}

// Anchored: for reading a node's own source text, where the span is the whole
// of it. Returns null for anything else, so a Link that merely begins the same
// way is not mistaken for one.
export function spanParts(src) {
  const s = scanSpan(src)
  return s && s.length === src.length ? { text: s.text, tokens: s.tokens } : null
}

export const AttrSpan = {
  defineNodes: [
    // No `style`: the decoration layer resolves the classes, and a highlight
    // tag here would put a second rule on the same span.
    { name: 'AttrSpan' },
    { name: 'AttrMark' },
  ],
  parseInline: [
    {
      name: 'AttrSpan',
      parse(cx, next, pos) {
        if (next !== 91 /* [ */) return -1
        const s = scanSpan(cx.slice(pos, cx.end))
        if (!s) return -1
        const end = pos + s.length
        const textFrom = pos + 1
        return cx.addElement(
          cx.elt('AttrSpan', pos, end, [
            cx.elt('AttrMark', pos, textFrom),
            // The label carries inline markup like any other text, so it is
            // parsed rather than taken flat — `[**bold** and red]{.c-red}`.
            ...cx.parser.parseInline(s.text, textFrom),
            cx.elt('AttrMark', textFrom + s.text.length, end),
          ]),
        )
      },
      // Before Link, for the reason Footnote is: `[` handling is shared, and a
      // Link would claim `[text]` first and leave `{...}` as loose characters.
      before: 'Link',
    },
  ],
}

// ---- fenced divs -----------------------------------------------------------
//
//   ::: center
//   A centred paragraph, and anything else.
//   :::
//
// Pandoc's fenced div, in its bare-word shorthand — `::: center` rather than
// `::: {.center}`. The brace form buys nothing here, since the only attribute
// worth carrying is the one word, and the shorthand is what anyone actually
// types.
//
// The only *composite* block in this file: everything else here is a leaf, and
// a leaf cannot hold a heading or a list. Alignment has to, or "centre this"
// would silently mean "centre this paragraph and break everything else in it".
//
// No collision with definition lists, checked rather than hoped: `DEF_LINE` is
// a colon followed by whitespace, and a fence's second character is a colon.
const DIV_OPEN = /^:{3,}[ \t]*([A-Za-z][\w-]*)[ \t]*$/
const DIV_CLOSE = /^:{3,}[ \t]*$/

// The word an opening fence carries, or null. Which words *mean* anything is
// palette.js's business, exactly as it is for attribute spans — the grammar
// only reports the shape.
export function divToken(text) {
  const m = DIV_OPEN.exec(text)
  return m ? m[1] : null
}

// Whether a line is a closing fence. Exported because unwrapping a div has to
// find and delete that line, and the pattern should not be written twice.
export const isDivClose = (text) => DIV_CLOSE.test(text)

export const FencedDiv = {
  defineNodes: [
    {
      name: 'FencedDiv',
      block: true,
      // Called per line to decide whether the block is still open. It cannot
      // consume the closing fence — a skipping function may not advance the
      // parser — so the fence falls through to the block parser below, which
      // is why that one exists at all.
      composite(cx, line) {
        return !DIV_CLOSE.test(line.text.slice(line.pos))
      },
    },
    { name: 'DivMark' },
  ],
  parseBlock: [
    {
      name: 'FencedDiv',
      parse(cx, line) {
        if (!DIV_OPEN.test(line.text.slice(line.pos))) return false
        const from = cx.lineStart + line.pos
        cx.startComposite('FencedDiv', line.pos)
        cx.addElement(cx.elt('DivMark', from, cx.lineStart + line.text.length))
        cx.nextLine()
        return true
      },
      // Both fences have to be able to interrupt a paragraph, and this is the
      // trap the footnote parser hit first. A paragraph swallows following
      // lines as *lazy continuation* before any block parser is consulted, so
      // without this the closing fence is absorbed into the last paragraph, the
      // div never closes, and the whole rest of the document is centred. The
      // failure is completely silent and looks like the parser ignoring `:::`.
      endLeaf(_, line) {
        return DIV_OPEN.test(line.text.slice(line.basePos))
      },
    },
    {
      // The closing fence, and any stray `:::`. Marked rather than left as a
      // paragraph: a lone `:::` means nothing on its own, so reading it as a
      // div marker is both harmless and what the writer meant.
      name: 'FencedDivEnd',
      parse(cx, line) {
        if (!DIV_CLOSE.test(line.text.slice(line.pos))) return false
        const from = cx.lineStart + line.pos
        cx.addElement(cx.elt('DivMark', from, cx.lineStart + line.text.length))
        cx.nextLine()
        return true
      },
      endLeaf(_, line) {
        return DIV_CLOSE.test(line.text.slice(line.basePos))
      },
    },
  ],
}

export const markdownExtensions = [Highlight, DefinitionList, Footnote, AttrSpan, FencedDiv]
