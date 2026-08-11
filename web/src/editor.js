// Markdown editor: CodeMirror 6 over a shared Y.Text, with Obsidian-style
// live preview — the document stays plain markdown; styling is a decoration
// layer over the syntax tree, and marker characters (**, #, `…) are hidden
// unless the selection touches the construct they belong to.
import { EditorView, keymap, ViewPlugin, Decoration, WidgetType } from '@codemirror/view'
import { EditorState, StateField, StateEffect } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxTree, ensureSyntaxTree, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags } from '@lezer/highlight'
import { defaultKeymap } from '@codemirror/commands'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { parseTableData } from './table.js'
import { markdownExtensions, footnoteLabel, isFootnoteDef, indexFootnotes } from './mdext.js'
import { emojiFor } from './emoji.js'
import {
  listMarker,
  toggleList,
  indentLines,
  outdentLines,
  columnAt,
  alignAt,
  nextAlign,
  setAlign,
} from './mdtext.js'

// ---- live preview ---------------------------------------------------------

const hide = Decoration.replace({})
const mark = (cls) => Decoration.mark({ class: cls })
const line = (cls) => Decoration.line({ class: cls })

// ---- widgets: checkboxes and images ---------------------------------------

// Replaces a `[ ]` / `[x]` task marker with a real checkbox. Clicking is
// handled by the mousedown handler in mountEditor (widgets are inert DOM;
// the edit must go through a CodeMirror transaction so it syncs and undoes
// like typing). eq() lets CodeMirror keep the DOM node when nothing changed.
class CheckboxWidget extends WidgetType {
  constructor(checked) {
    super()
    this.checked = checked
  }
  eq(other) {
    return other.checked === this.checked
  }
  toDOM() {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'md-task-checkbox'
    input.checked = this.checked
    return input
  }
  ignoreEvent() {
    return false // let our mousedown handler see clicks
  }
}

// Renders `![alt](url)` as the actual image. Clicking it places the cursor
// there (CodeMirror's default for widgets), which reveals the raw markdown.
class ImageWidget extends WidgetType {
  constructor(url, alt) {
    super()
    this.url = url
    this.alt = alt
  }
  eq(other) {
    return other.url === this.url && other.alt === this.alt
  }
  toDOM(view) {
    const img = document.createElement('img')
    img.className = 'md-image'
    img.src = this.url
    img.alt = this.alt
    // The image loads (or fails) after layout; tell CodeMirror to re-measure
    // line heights when its real size is known.
    img.onload = () => view.requestMeasure()
    img.onerror = () => {
      img.replaceWith(brokenImage(this.alt || this.url))
      view.requestMeasure()
    }
    return img
  }
}

function brokenImage(label) {
  const span = document.createElement('span')
  span.className = 'md-image-broken'
  span.textContent = `⚠ image: ${label}`
  return span
}

// Renders a whole markdown table as an HTML table (a block widget spanning
// the table's lines). Cells are plain text for now — inline styling inside
// cells still shows raw markdown; a later pass can render it. Clicking
// anywhere in the widget places the cursor there, which reveals the source.
class TableWidget extends WidgetType {
  constructor(data) {
    super()
    this.data = data
    this.key = JSON.stringify(data) // cheap deep-equality for eq()
  }
  eq(other) {
    return other.key === this.key
  }
  toDOM() {
    const table = document.createElement('table')
    table.className = 'md-table'
    const alignOf = (i) => this.data.aligns[i] || 'left'
    const addRow = (parent, cells, tag) => {
      const tr = document.createElement('tr')
      // Pad to the widest row so ragged markdown still renders rectangular.
      const width = Math.max(this.data.header.length, ...this.data.rows.map((r) => r.length))
      for (let i = 0; i < width; i++) {
        const cell = document.createElement(tag)
        cell.textContent = cells[i] || ''
        cell.style.textAlign = alignOf(i)
        tr.append(cell)
      }
      parent.append(tr)
    }
    const thead = table.createTHead()
    addRow(thead, this.data.header, 'th')
    const tbody = table.createTBody()
    for (const row of this.data.rows) addRow(tbody, row, 'td')
    return table
  }
  ignoreEvent() {
    return false // let CodeMirror turn clicks into cursor placement
  }
}

// `---` / `***` drawn as an actual rule. Inline rather than a block widget:
// the replaced range is the rule's three characters, which live on one line,
// so the line keeps its height and the cursor can still be placed on it.
class RuleWidget extends WidgetType {
  eq() {
    return true // no state, so one instance is as good as another
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'md-hr'
    return span
  }
  ignoreEvent() {
    return false
  }
}

// Source replaced by a short piece of literal text: the `\` of a hard line
// break shown as the return arrow it means, `:warning:` shown as the character
// it names, `[!NOTE]` shown as its label. Only the backslash of a hard break is
// replaced, never the newline with it — a replace decoration spanning a line
// break would have to be a block decoration, and none of these are.
class TextWidget extends WidgetType {
  constructor(text, cls) {
    super()
    this.text = text
    this.cls = cls
  }
  eq(other) {
    return other.text === this.text && other.cls === this.cls
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = this.cls
    span.textContent = this.text
    return span
  }
  ignoreEvent() {
    return false
  }
}

// Only render sources that can't execute anything.
function safeImageURL(url) {
  return /^(https?:|data:image\/)/i.test(url)
}

const inlineMarks = {
  StrongEmphasis: mark('md-strong'),
  Emphasis: mark('md-em'),
  InlineCode: mark('md-code'),
  Strikethrough: mark('md-strike'),
  Link: mark('md-link'),
  Highlight: mark('md-highlight'),
  Superscript: mark('md-sup'),
  Subscript: mark('md-sub'),
}

// Marker nodes hidden when the selection does not touch their parent
// construct. HeaderMark and DefinitionMark also swallow the space after them.
const markerParents = [
  'EmphasisMark',
  'CodeMark',
  'StrikethroughMark',
  'LinkMark',
  'URL',
  'HeaderMark',
  'HighlightMark',
  'SuperscriptMark',
  'SubscriptMark',
  'DefinitionMark',
]
const markersEatingSpace = ['HeaderMark', 'DefinitionMark']

// ---- callouts --------------------------------------------------------------
// `> [!NOTE]` — Obsidian's and GitHub's syntax, and the reason it was chosen:
// it is *already a valid blockquote*, so it needs no parser extension and
// degrades to an ordinary quote in every other markdown tool.
//
// The five GitHub kinds. Anything else in the brackets is still recognised as
// a callout and styled as a note, rather than being rejected — a `[!EXAMPLE]`
// written for another tool should not read as broken here.
const CALLOUTS = {
  note: '📘 Note',
  tip: '💡 Tip',
  important: '📣 Important',
  warning: '⚠️ Warning',
  caution: '🛑 Caution',
}

// The kind named by a blockquote's first line, or null if it is an ordinary
// quote. Takes the whole line, since the marker only counts at the start.
function calloutKind(lineText) {
  const m = /^\s*>\s*\[!(\w+)\]/.exec(lineText)
  if (!m) return null
  const kind = m[1].toLowerCase()
  return kind in CALLOUTS ? kind : 'note'
}

// The label for a Link node that is really a callout marker, or null. The
// text alone is not enough: `[!NOTE]` mid-sentence is a link someone typed.
// It counts only at the very start of the first paragraph of a blockquote,
// which is also exactly where the syntax puts it.
function calloutLabelAt(state, node) {
  const m = /^\[!(\w+)\]$/.exec(state.sliceDoc(node.from, node.to))
  if (!m) return null
  const para = node.node.parent
  if (!para || para.name !== 'Paragraph' || para.from !== node.from) return null
  if (para.parent?.name !== 'Blockquote') return null
  const kind = m[1].toLowerCase()
  return CALLOUTS[kind] || `📘 ${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}`
}

function selectionTouches(state, from, to) {
  for (const r of state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true
  }
  return false
}

function buildDecorations(view, from, to) {
  const { state } = view
  const decos = []
  const lineDecos = new Map() // line.from -> class, deduped
  // Absent in the standalone preview only if someone forgets to include the
  // field; `false` makes that a missing number rather than a thrown plugin.
  const footnotes = state.field(footnoteIndex, false)

  const addLines = (from, to, cls) => {
    for (let pos = from; pos <= to; ) {
      const ln = state.doc.lineAt(pos)
      lineDecos.set(ln.from, (lineDecos.get(ln.from) || '') + ' ' + cls)
      pos = ln.to + 1
    }
  }

  {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name
        const heading = name.match(/^ATXHeading([1-6])$/)
        if (heading) {
          addLines(node.from, node.from, 'md-heading md-h' + heading[1])
          return
        }
        if (name === 'TaskMarker') {
          // `[ ]` / `[x]` becomes a checkbox unless the cursor is on it.
          if (!selectionTouches(state, node.from, node.to)) {
            const checked = /x/i.test(state.sliceDoc(node.from, node.to))
            decos.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to))
          }
          return
        }
        if (name === 'Image') {
          // Whole `![alt](url)` becomes the image unless the cursor is
          // inside it. Returning false skips the child nodes: the replace
          // range must not contain other decorations.
          if (!selectionTouches(state, node.from, node.to)) {
            const src = state.sliceDoc(node.from, node.to)
            const m = src.match(/^!\[(.*?)\]\((\S*?)(?:\s+"[^"]*")?\)$/s)
            if (m && safeImageURL(m[2])) {
              decos.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1]) }).range(node.from, node.to))
              return false
            }
          }
          return
        }
        if (name === 'Link') {
          // `[!NOTE]` parses as an ordinary Link — brackets and all — so
          // without this a callout's label renders as a hyperlink. The whole
          // node is replaced and the children skipped, the same way Image
          // does it: a replace decoration may not contain other decorations.
          const label = calloutLabelAt(state, node)
          if (label) {
            if (!selectionTouches(state, node.from, node.to)) {
              decos.push(
                Decoration.replace({ widget: new TextWidget(label, 'md-callout-label') }).range(
                  node.from,
                  node.to,
                ),
              )
              return false
            }
            decos.push(mark('md-callout-label').range(node.from, node.to))
            return false
          }
        }
        if (name === 'Emoji') {
          // The parser marks `:name:`; what it means is emoji.js's business,
          // and an unknown name is left as the text that was typed.
          const ch = emojiFor(state.sliceDoc(node.from + 1, node.to - 1))
          if (ch && !selectionTouches(state, node.from, node.to)) {
            decos.push(
              Decoration.replace({ widget: new TextWidget(ch, 'md-emoji') }).range(node.from, node.to),
            )
          }
          return false
        }
        if (name === 'FootnoteRef' || name === 'FootnoteMark') {
          const isRef = name === 'FootnoteRef'
          // A definition's marker is revealed when the cursor is anywhere in
          // the note; a reference's, only when it is on the reference itself.
          const scope = isRef ? node : node.node.parent || node
          const label = footnoteLabel(state.sliceDoc(node.from, node.to))
          const n = label && footnotes ? footnotes.numbers.get(label) : null
          if (!n || selectionTouches(state, scope.from, scope.to)) {
            decos.push(mark('md-dim').range(node.from, node.to))
            return false
          }
          // A reference with nothing to cite still gets a number — dropping it
          // would renumber everything after it — but says so, because the
          // usual cause is a typo in one half of the pair.
          const missing = isRef && !footnotes.defs.has(label)
          const cls = `md-fn-num ${isRef ? 'md-fn-ref' : 'md-fn-def'}${missing ? ' md-fn-missing' : ''}`
          decos.push(
            Decoration.replace({ widget: new TextWidget(isRef ? String(n) : `${n}.`, cls) }).range(
              node.from,
              node.to,
            ),
          )
          return false
        }
        if (name === 'Footnote') {
          addLines(node.from, node.to, 'md-footnote')
          return // descend, so the marker above is reached
        }
        if (name === 'DefinitionTerm' || name === 'DefinitionDesc') {
          addLines(node.from, node.to, name === 'DefinitionTerm' ? 'md-dt' : 'md-dd')
          return
        }
        if (name in inlineMarks) {
          decos.push(inlineMarks[name].range(node.from, node.to))
          return
        }
        if (name === 'HorizontalRule') {
          // Drawn as a rule unless the cursor is on it, in which case the
          // `---` shows so it can be edited or deleted.
          if (selectionTouches(state, node.from, node.to)) {
            decos.push(mark('md-dim').range(node.from, node.to))
          } else {
            decos.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to))
          }
          return false
        }
        if (name === 'HardBreak') {
          // The node spans the backslash *and* the newline. Only a trailing
          // backslash gets a glyph: the other spelling of a hard break is two
          // trailing spaces, and there is nothing to show for those.
          if (
            state.sliceDoc(node.from, node.from + 1) === '\\' &&
            !selectionTouches(state, node.from, node.from + 1)
          ) {
            decos.push(
              Decoration.replace({ widget: new TextWidget('↵', 'md-break') }).range(node.from, node.from + 1),
            )
          }
          return false
        }
        if (markerParents.includes(name)) {
          const parent = node.node.parent
          // Fence markers are dimmed, never hidden. Hiding them (which the
          // general rule below would do, since CodeMark is also inline code's
          // backtick) leaves an empty line above and below the block: the
          // lines still exist, so the block reads as if it had stray padding.
          if (name === 'CodeMark' && parent && parent.name === 'FencedCode') {
            decos.push(mark('md-dim').range(node.from, node.to))
            return
          }
          if (parent && !selectionTouches(state, parent.from, parent.to)) {
            let end = node.to
            if (markersEatingSpace.includes(name) && state.sliceDoc(end, end + 1) === ' ') end++
            if (end > node.from) decos.push(hide.range(node.from, end))
          }
          return
        }
        if (name === 'Table') {
          // The rendered-table widget itself comes from tableDecorations
          // below — CodeMirror forbids block decorations from view plugins.
          // Here we only style the revealed (cursor-inside) case: monospace
          // the source lines so the pipes and columns line up while typing.
          if (!selectionTouches(state, node.from, node.to)) return false
          addLines(node.from, node.to, 'md-table-src')
          return
        }
        if (name === 'TableDelimiter') {
          decos.push(mark('md-dim').range(node.from, node.to))
          return
        }
        if (name === 'Blockquote') {
          const kind = calloutKind(state.doc.lineAt(node.from).text)
          addLines(node.from, node.to, kind ? `md-callout md-callout-${kind}` : 'md-blockquote')
          return
        }
        if (name === 'QuoteMark' || name === 'ListMark' || name === 'CodeInfo') {
          decos.push(mark('md-dim').range(node.from, node.to))
          return
        }
        if (name === 'FencedCode' || name === 'CodeBlock') {
          addLines(node.from, node.to, 'md-codeblock')
          return
        }
      },
    })
  }
  for (const [pos, cls] of lineDecos) decos.push(line(cls.trim()).range(pos))
  return Decoration.set(decos, true)
}

// Decorations are built over the viewport plus this much overscan on each
// side. Scrolling within the covered range triggers no rebuild — rebuilding
// per scroll changed line heights mid-measure and made CodeMirror's layout
// loop oscillate ("Viewport failed to stabilize") on large documents.
const OVERSCAN = 4000

// Table widgets are block decorations (they stand in for whole lines), and
// CodeMirror only accepts those from a StateField — a view plugin providing
// them throws "Block decorations may not be specified via plugins". The
// field recomputes on any doc or selection change, over the whole document
// (tables are rare; ensureSyntaxTree gives the parser a small budget to
// finish far-away regions).
function buildTableDecorations(state) {
  const decos = []
  const tree = ensureSyntaxTree(state, state.doc.length, 50) || syntaxTree(state)
  tree.iterate({
    enter(node) {
      if (node.name !== 'Table') return
      if (selectionTouches(state, node.from, node.to)) return false
      const from = state.doc.lineAt(node.from).from
      const to = state.doc.lineAt(node.to).to
      const data = parseTableData(node.node, (a, b) => state.sliceDoc(a, b))
      decos.push(Decoration.replace({ widget: new TableWidget(data), block: true }).range(from, to))
      return false
    },
  })
  return Decoration.set(decos, true)
}

const tableDecorations = StateField.define({
  create: buildTableDecorations,
  update(value, tr) {
    if (tr.docChanged || tr.selection) return buildTableDecorations(tr.state)
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})

// ---- footnotes: the document-wide pass -------------------------------------
//
// Every other construct in this editor can be decorated from its own node.
// A footnote cannot: `[^why]` renders as "3" because two other references
// happen to come before it, and what it says lives somewhere else in the file.
// So the number is a property of the *document*, and this field is where that
// is worked out.
//
// Numbered by order of first **reference**, which is what every other renderer
// does and the only order a reader can predict — the definitions are usually
// all at the bottom, so numbering by those would number them by how they were
// typed. A definition that is never referenced still gets a number, after the
// referenced ones, so it renders as a footnote rather than as leftover text.
//
// The pairing itself is `indexFootnotes` in mdext.js, which is DOM-free and
// tested there. This only supplies it with a tree.
//
// Recomputed on every document change. That is a whole-document tree walk, and
// worth it here for the same reason `buildTableDecorations` accepts one — which
// already runs on every doc *and* selection change, so this is the cheaper of
// the two.
function buildFootnoteIndex(state) {
  const tree = ensureSyntaxTree(state, state.doc.length, 50) || syntaxTree(state)
  return indexFootnotes(tree, (a, b) => state.sliceDoc(a, b))
}

const footnoteIndex = StateField.define({
  create: buildFootnoteIndex,
  update: (value, tr) => (tr.docChanged ? buildFootnoteIndex(tr.state) : value),
})

// Clicking a number follows the pairing: a reference goes to what it cites, a
// definition goes back to where it was cited. Widgets are inert DOM, so this
// is a mousedown handler reading the label out of the document at the widget's
// position — the same trick handleCheckboxClick uses, and for the same reason:
// nothing has to be stored in the widget, so nothing can go stale.
function handleFootnoteClick(event, view) {
  const el = event.target
  if (!(el instanceof HTMLElement) || !el.classList.contains('md-fn-num')) return false
  event.preventDefault()
  const index = view.state.field(footnoteIndex, false)
  if (!index) return true
  const pos = view.posAtDOM(el)
  const src = view.state.sliceDoc(pos, Math.min(view.state.doc.length, pos + 128))
  const label = footnoteLabel(src)
  if (!label) return true
  const target = isFootnoteDef(src) ? index.firstRef.get(label) : index.defs.get(label)
  if (target !== undefined) goToPos(view, target)
  return true
}

// One mousedown handler, because CodeMirror takes one per event name and both
// of these are "a widget was clicked".
function handleWidgetClick(event, view) {
  return handleCheckboxClick(event, view) || handleFootnoteClick(event, view)
}

// ---- comment highlights ---------------------------------------------------
// Where the commented ranges are is not something the editor can work out: it
// comes from threads fetched over HTTP and resolved against the Y.Doc. So the
// component pushes them in with an effect, and a StateField holds them.
//
// A StateField rather than a ViewPlugin because these decorations must survive
// viewport changes and map through edits — a plugin rebuilding from the
// viewport would lose a highlight the moment it scrolled out of view.

const setCommentRangesEffect = StateEffect.define()
const commentMark = Decoration.mark({ class: 'cm-comment-range' })

const commentRanges = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setCommentRangesEffect)) {
        return Decoration.set(
          e.value
            .filter((r) => r.to > r.from && r.to <= tr.state.doc.length)
            .map((r) => commentMark.range(r.from, r.to)),
          true,
        )
      }
    }
    // No effect this transaction: carry the highlights through the edit so they
    // track the text until the next refresh replaces them outright.
    return tr.docChanged ? value.map(tr.changes) : value
  },
  provide: (field) => EditorView.decorations.from(field),
})

export function setCommentRanges(view, ranges) {
  view.dispatch({ effects: setCommentRangesEffect.of(ranges) })
}

// ---- table of contents -----------------------------------------------------

// The headings, in document order, for the contents panel. Nothing is stored:
// the document already says what its headings are, and this reads them back.
//
// ensureSyntaxTree with a budget, not syntaxTree, for the reason
// buildTableDecorations gives — the parser works incrementally and a heading
// far below the viewport need not be in the tree yet. Falling back to the
// partial tree if the budget runs out is deliberate: a contents list that is
// briefly short is better than one that blocks typing.
export function documentHeadings(state, maxLevel = 6) {
  const out = []
  const tree = ensureSyntaxTree(state, state.doc.length, 100) || syntaxTree(state)
  tree.iterate({
    enter(node) {
      const m = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name)
      if (!m) return
      const level = Number(m[1])
      if (level <= maxLevel) {
        // The node's own text, not the line's. A heading inside a blockquote
        // starts after the `>`, and reading the line would put the quote
        // marker in the contents. Setext headings span two lines, so only the
        // first is the title.
        const text = state.sliceDoc(node.from, node.to)
          .split('\n')[0]
          .replace(/^#{1,6}\s*/, '')
          // An optional closing run of hashes: `## Thing ##`. The space before
          // it is required, so `# C#` keeps its hash, as CommonMark says.
          .replace(/\s+#+\s*$/, '')
          .trim()
        if (text) out.push({ pos: node.from, level, text })
      }
      return false // headings do not nest, and their inline markup is not wanted
    },
  })
  return out
}

// How long after the last keystroke the contents are rebuilt. Walking the tree
// per keypress is the cost worth avoiding here; being 300ms stale is not a cost
// anyone can perceive in a list of headings.
const HEADINGS_DEBOUNCE = 300

// Put the cursor at a position and scroll it to the top of the view. Distinct
// from revealRange, which *selects* — following a heading should leave you
// ready to type there, not with the heading highlighted.
export function goToPos(view, pos) {
  const at = Math.min(pos, view.state.doc.length)
  view.dispatch({
    selection: { anchor: at },
    effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: 8 }),
  })
  view.focus()
}

// Scroll a commented range into view and select it, so following a thread from
// the panel lands you on the text it is about.
export function revealRange(view, from, to) {
  const end = Math.min(to, view.state.doc.length)
  view.dispatch({
    selection: { anchor: Math.min(from, end), head: end },
    effects: EditorView.scrollIntoView(Math.min(from, end), { y: 'center' }),
  })
  view.focus()
}

const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.build(view)
    }
    update(u) {
      if (u.docChanged || u.selectionSet || (u.viewportChanged && !this.covers(u.view))) {
        this.decorations = this.build(u.view)
      }
    }
    covers(view) {
      const vp = view.viewport
      return this.range && this.range.from <= vp.from && this.range.to >= vp.to
    }
    build(view) {
      const from = Math.max(0, view.viewport.from - OVERSCAN)
      const to = Math.min(view.state.doc.length, view.viewport.to + OVERSCAN)
      this.range = { from, to }
      return buildDecorations(view, from, to)
    }
  },
  { decorations: (v) => v.decorations }
)

// ---- syntax highlighting inside fenced code blocks ------------------------

// Deliberately *only* code tokens. `defaultHighlightStyle` also styles
// markdown's own tags — heading, strong, emphasis, link — which the live
// preview decorations above already own, and two rules fighting over the same
// span is how a heading ends up a colour nobody chose.
//
// The colours are custom properties so the light/dark pair sits in app.css
// with the rest of the app's colours, rather than being compiled into an
// injected stylesheet where no one would look for them.
const codeHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.definitionKeyword, tags.operatorKeyword, tags.modifier], color: 'var(--tok-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], color: 'var(--tok-string)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--tok-comment)', fontStyle: 'italic' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom, tags.constant(tags.variableName)], color: 'var(--tok-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName), tags.macroName], color: 'var(--tok-name)' },
  { tag: [tags.typeName, tags.className, tags.tagName, tags.namespace, tags.attributeName], color: 'var(--tok-type)' },
  { tag: tags.invalid, color: 'var(--tok-invalid)' },
])

// ---- toolbar commands: canned markdown text edits -------------------------

// Toggle-wrap the main selection in an inline marker pair (**, *, `, ~~).
// Ordinary text edits: they sync, undo, and render like typed characters.
function toggleInline(marker) {
  return (view) => {
    const { state } = view
    const { from, to } = state.selection.main
    const len = marker.length
    const before = state.sliceDoc(Math.max(0, from - len), from)
    const after = state.sliceDoc(to, Math.min(state.doc.length, to + len))
    if (before === marker && after === marker) {
      view.dispatch({
        changes: [
          { from: from - len, to: from },
          { from: to, to: to + len },
        ],
        selection: { anchor: from - len, head: to - len },
      })
    } else {
      const inner = state.sliceDoc(from, to)
      if (inner.length >= 2 * len && inner.startsWith(marker) && inner.endsWith(marker)) {
        view.dispatch({
          changes: { from, to, insert: inner.slice(len, inner.length - len) },
          selection: { anchor: from, head: to - 2 * len },
        })
      } else {
        view.dispatch({
          changes: [
            { from, insert: marker },
            { from: to, insert: marker },
          ],
          selection: { anchor: from + len, head: to + len },
        })
      }
    }
    view.focus()
    return true
  }
}

// Dispatch line-prefix changes, keeping the cursor on the right side of any
// insertion. Without the explicit mapping (assoc 1 = "after insertions"), a
// cursor sitting exactly at the insert point — the blank-line case — lands
// to the LEFT of the prefix it just asked for.
function dispatchKeepingCursor(view, changes) {
  const cs = view.state.changes(changes)
  const sel = view.state.selection.main
  view.dispatch({
    changes: cs,
    selection: { anchor: cs.mapPos(sel.anchor, 1), head: cs.mapPos(sel.head, 1) },
  })
  view.focus()
}

// The lines the selection touches, whole. Every block-level command works on
// these rather than on the selection's exact offsets.
function selectedLines(state) {
  const sel = state.selection.main
  const lines = []
  for (let pos = sel.from; pos <= sel.to; ) {
    const ln = state.doc.lineAt(pos)
    lines.push(ln)
    pos = ln.to + 1
  }
  return lines
}

// Set an ATX heading level on every selected line. Level 0 means "no heading";
// re-applying the level a line already has also clears it, so the toolbar's H2
// is a toggle and its Paragraph entry is unconditional.
function setHeading(level) {
  return (view) => {
    const { state } = view
    const target = level ? '#'.repeat(level) + ' ' : ''
    const changes = []
    for (const ln of selectedLines(state)) {
      const m = ln.text.match(/^#{1,6} /)
      const cur = m ? m[0] : ''
      const insert = cur === target ? '' : target
      if (cur !== insert) changes.push({ from: ln.from, to: ln.from + cur.length, insert })
    }
    dispatchKeepingCursor(view, changes)
    return true
  }
}

// Turn the selected lines into a bullet, numbered or task list — or out of
// one. The decision of what each line becomes is mdtext.js's; this only turns
// its prefix edits into document offsets.
function toggleListCmd(kind) {
  return (view) => {
    const { state } = view
    const lines = selectedLines(state)
    const edits = toggleList(lines.map((ln) => ln.text), kind)
    const changes = []
    edits.forEach((e, i) => {
      if (e) changes.push({ from: lines[i].from, to: lines[i].from + e.to, insert: e.insert })
    })
    dispatchKeepingCursor(view, changes)
    return true
  }
}

// How far back mdtext.js is allowed to look for the item a Tab would nest
// under. A list longer than this in one unbroken run is not a document anyone
// is editing; the cap keeps a keystroke from walking a huge doc.
const LIST_CONTEXT_LINES = 500

// Tab / Shift-Tab, but only inside a list. Returning false anywhere else is
// deliberate: an editor that swallows Tab everywhere is one a keyboard user
// cannot escape.
function indentListCmd(outdent) {
  return (view) => {
    const { state } = view
    const lines = selectedLines(state)
    if (!lines.some((ln) => listMarker(ln.text))) return false
    const before = []
    for (let n = Math.max(1, lines[0].number - LIST_CONTEXT_LINES); n < lines[0].number; n++) {
      before.push(state.doc.line(n).text)
    }
    const shift = outdent ? outdentLines : indentLines
    const edits = shift(lines.map((ln) => ln.text), before)
    const changes = []
    edits.forEach((e, i) => {
      if (e) changes.push({ from: lines[i].from, to: lines[i].from + e.to, insert: e.insert })
    })
    // Still true when there is nothing to do: the cursor is in a list, so Tab
    // means "nest", not "leave the editor".
    if (changes.length) dispatchKeepingCursor(view, changes)
    else view.focus()
    return true
  }
}

// Toggle a per-line prefix ('> ' quotes) across the selection.
function toggleLinePrefix(prefix) {
  return (view) => {
    const { state } = view
    const lines = selectedLines(state)
    const allPrefixed = lines.every((ln) => ln.text.startsWith(prefix))
    const changes = lines.map((ln) =>
      allPrefixed
        ? { from: ln.from, to: ln.from + prefix.length }
        : { from: ln.from, insert: prefix }
    )
    dispatchKeepingCursor(view, changes)
    return true
  }
}

// Wrap the selection as a link and park the cursor inside the () part.
function insertLink(view) {
  const { state } = view
  const { from, to } = state.selection.main
  const text = state.sliceDoc(from, to)
  view.dispatch({
    changes: { from, to, insert: `[${text}]()` },
    selection: { anchor: from + text.length + 3 },
  })
  view.focus()
  return true
}

// Insert a 2x2 table skeleton on the line after the cursor, with the
// cursor parked in the first header cell.
function insertTable(view) {
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.head)
  const skeleton = '\n| Column | Column |\n| ------ | ------ |\n|        |        |\n'
  view.dispatch({
    changes: { from: line.to, insert: skeleton },
    selection: { anchor: line.to + 3 },
  })
  view.focus()
  return true
}

// Same shape as insertLink, with the image prefix.
function insertImage(view) {
  const { state } = view
  const { from, to } = state.selection.main
  const text = state.sliceDoc(from, to)
  view.dispatch({
    changes: { from, to, insert: `![${text}]()` },
    selection: { anchor: from + text.length + 4 },
  })
  view.focus()
  return true
}

// Wrap the selection in a fence, cursor parked on the info string so the next
// thing typed is the language. An empty selection gives an empty block.
function insertCodeBlock(view) {
  const { state } = view
  const { from, to } = state.selection.main
  const text = state.sliceDoc(from, to)
  // A fence has to start a line.
  const lead = from === state.doc.lineAt(from).from ? '' : '\n'
  const insert = lead + '```\n' + text + '\n```\n'
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + lead.length + 3 },
  })
  view.focus()
  return true
}

// A rule goes on its own line, after a blank one. `---` directly under a
// paragraph is a setext heading — it would underline the text above instead.
function insertRule(view) {
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.head)
  const insert = (line.text.trim() ? '\n' : '') + '\n---\n'
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + insert.length },
  })
  view.focus()
  return true
}

// Wrap the selected lines in a callout — which is a blockquote whose first
// line names a kind, so this is the quote command plus one line above it.
function insertCallout(kind) {
  return (view) => {
    const { state } = view
    const tag = `> [!${kind.toUpperCase()}]`
    // One change per line, the tag folded into the first, rather than a
    // separate insert at the same offset: two changes at one position is a
    // sorting question this does not need to have.
    const changes = selectedLines(state).map((ln, i) => ({
      from: ln.from,
      insert: i === 0 ? `${tag}\n> ` : '> ',
    }))
    dispatchKeepingCursor(view, changes)
    return true
  }
}

// A term and its definition, cursor on the term. The skeleton is the whole
// interface: a definition list is two lines and a colon, and there is nothing
// to toggle.
function insertDefinition(view) {
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.head)
  const insert = (line.text.trim() ? '\n' : '') + '\nTerm\n: Definition\n'
  const at = line.to
  view.dispatch({
    changes: { from: at, insert },
    // Select the word "Term", so typing replaces it.
    selection: { anchor: at + insert.indexOf('Term'), head: at + insert.indexOf('Term') + 4 },
  })
  view.focus()
  return true
}

// Insert a reference at the cursor and its definition at the foot of the
// document — the two halves in one action, because a reference written without
// a definition is the failure mode this construct has.
//
// The label is the lowest number not already in use, not "the count plus one":
// deleting a note from the middle would otherwise hand out a label that is
// still taken further down.
function insertFootnote(view) {
  const { state } = view
  const index = state.field(footnoteIndex, false)
  let n = 1
  while (index?.numbers.has(String(n))) n++
  const label = String(n)

  const { from, to } = state.selection.main
  const end = state.doc.length
  const atLineStart = end === 0 || state.sliceDoc(end - 1, end) === '\n'
  // Definitions gather at the bottom: straight under an existing one, and
  // after a blank line when starting the group.
  const lastText = lastNonBlankLine(state)
  const gap = (atLineStart ? '' : '\n') + (isFootnoteDef(lastText) ? '' : '\n')
  const note = `${gap}[^${label}]: `

  // One change when the cursor is already at the end, since two insertions at
  // the same offset is a question about ordering this does not need to answer.
  const changes =
    to >= end
      ? [{ from, to, insert: `[^${label}]${note}` }]
      : [{ from, to, insert: `[^${label}]` }, { from: end, insert: note }]
  const cs = state.changes(changes)
  // The end of the document is where the note now is, whichever branch ran.
  view.dispatch({ changes: cs, selection: { anchor: cs.newLength } })
  view.focus()
  return true
}

function lastNonBlankLine(state) {
  let line = state.doc.lineAt(state.doc.length)
  while (line.number > 1 && !line.text.trim()) line = state.doc.line(line.number - 1)
  return line.text.trim()
}

// Insert an emoji from the picker.
//
// The document gets the **shortcode**, `:warning:`, not the character. The
// alternative — inserting ⚠️ directly — would render in tools that know
// nothing about shortcodes, which is a real argument and was weighed. Against
// it: this app already renders shortcodes, so writing the character would mean
// the rendering feature only served people who never open the picker, and the
// two halves of one feature would disagree about what a document looks like.
// It also keeps the file ASCII, which is friendlier in a `git diff`. The
// picker is the authoring side of the renderer, so it speaks the same
// vocabulary — and you see the character immediately anyway, because the
// decoration replaces it as you insert it.
//
// Focus is deliberately NOT taken back: the picker stays open so several can
// be inserted in a row, and the selection lives in CodeMirror's state rather
// than in the DOM, so it survives the editor not being focused.
export function insertEmoji(view, name) {
  const { from, to } = view.state.selection.main
  const insert = `:${name}:`
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
  })
  return true
}

// A hard line break: a trailing backslash, then the newline. Distinct from
// pressing Enter, which starts a new paragraph.
function insertHardBreak(view) {
  const { from, to } = view.state.selection.main
  view.dispatch({
    changes: { from, to, insert: '\\\n' },
    selection: { anchor: from + 2 },
  })
  view.focus()
  return true
}

// Cycle the alignment of the table column the cursor is in, by rewriting that
// cell of the delimiter row. Alignment is the one piece of *appearance* plain
// markdown does encode, and the renderer has read it since tables shipped —
// this is the missing half, a way to write it.
function cycleColumnAlign(view) {
  const { state } = view
  const pos = state.selection.main.head
  // ensureSyntaxTree, not syntaxTree, for the reason buildTableDecorations
  // gives: the parser works to a time budget and syntaxTree returns whatever
  // it has, which in a long document need not yet include the table the
  // cursor is sitting in.
  const tree = ensureSyntaxTree(state, pos, 50) || syntaxTree(state)
  let node = tree.resolveInner(pos, -1)
  while (node && node.name !== 'Table') node = node.parent
  if (!node) return false
  // Table's own TableDelimiter child is the `| --- | --- |` row; the ones
  // nested inside TableHeader and TableRow are the pipes between cells.
  let delim = null
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableDelimiter') {
      delim = c
      break
    }
  }
  if (!delim) return false
  const row = state.doc.lineAt(pos)
  const col = columnAt(row.text, pos - row.from)
  const drow = state.doc.lineAt(delim.from)
  const edit = setAlign(drow.text, col, nextAlign(alignAt(drow.text, col)))
  if (!edit) return false
  view.dispatch({
    changes: { from: drow.from + edit.from, to: drow.from + edit.to, insert: edit.insert },
  })
  view.focus()
  return true
}

// Clicking a rendered checkbox flips the character in the source — an
// ordinary edit, so it syncs to collaborators and undoes like typing.
// posAtDOM gives the widget's position, where the doc text is `[ ]`/`[x]`.
function handleCheckboxClick(event, view) {
  const target = event.target
  if (!(target instanceof HTMLInputElement) || !target.classList.contains('md-task-checkbox')) {
    return false
  }
  event.preventDefault() // the transaction drives the rendering, not the input
  if (view.state.readOnly) {
    return true
  }
  const pos = view.posAtDOM(target)
  const marker = view.state.sliceDoc(pos, pos + 3)
  if (marker[0] !== '[') return true
  const checked = /x/i.test(marker[1])
  view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: checked ? ' ' : 'x' } })
  return true
}

// The Insert menu's contents, keyed by the value the <option> carries. Kept as
// data so the menu and its dispatch cannot drift apart — adding an entry here
// puts it in both.
const INSERTS = {
  image: { label: 'Image', run: insertImage },
  footnote: { label: 'Footnote', run: insertFootnote },
  definition: { label: 'Definition list', run: insertDefinition },
  rule: { label: 'Horizontal rule', run: insertRule },
  break: { label: 'Line break  ⇧⏎', run: insertHardBreak },
}

// The toolbar, as data. `sep` is a visual divider; `options` makes an entry a
// menu rather than a button, and its `run` takes the chosen value.
//
// All six heading levels are in a menu rather than six buttons. The menu is
// stateless — it does not show the current line's level — because everything
// else on this toolbar is a canned edit rather than a mode, and a control that
// looked like state but only sometimes was would be worse than one that never
// claims to be.
export const toolbarCommands = [
  { label: 'B', title: 'Bold (⌘B)', run: toggleInline('**') },
  { label: 'I', title: 'Italic (⌘I)', run: toggleInline('*') },
  { label: 'S̶', title: 'Strikethrough', run: toggleInline('~~') },
  { label: '<>', title: 'Inline code (⌘E)', run: toggleInline('`') },
  { label: '🖍', title: 'Highlight', run: toggleInline('==') },
  // A panel, not a command: the toolbar entry only says which one to open, and
  // EditorView renders it. Keeps the toolbar one ordered list rather than a
  // list plus a special case wired in beside it.
  { label: '😀', title: 'Emoji', panel: 'emoji' },
  { label: 'x²', title: 'Superscript', run: toggleInline('^') },
  { label: 'x₂', title: 'Subscript', run: toggleInline('~') },
  { sep: true },
  {
    // Google Docs' vocabulary, which maps one-to-one onto markdown's six
    // levels and reads better than counting to six: nobody writing a document
    // thinks "this is a heading 1 and that is a heading 2", they think "this
    // is the title and that is a section".
    //
    // Worth knowing when reading the source it produces: "Subtitle" is `##`,
    // which markdown treats as a second-level section heading. The label names
    // the role it plays under a Title; the level it writes is unchanged, so a
    // document written here reads correctly in any other markdown tool.
    label: 'Style',
    title: 'Text style',
    options: [
      { label: 'Normal text', value: 0 },
      { label: 'Title', value: 1 },
      { label: 'Subtitle', value: 2 },
      { label: 'Heading 1', value: 3 },
      { label: 'Heading 2', value: 4 },
      { label: 'Heading 3', value: 5 },
      { label: 'Heading 4', value: 6 },
    ],
    run: (view, value) => setHeading(Number(value))(view),
  },
  { sep: true },
  { label: '•', title: 'Bullet list', run: toggleListCmd('bullet') },
  { label: '1.', title: 'Numbered list', run: toggleListCmd('ordered') },
  { label: '☑', title: 'Task list', run: toggleListCmd('task') },
  { label: '❝', title: 'Quote', run: toggleLinePrefix('> ') },
  {
    label: 'Callout',
    title: 'Callout',
    options: Object.entries(CALLOUTS).map(([value, label]) => ({ label, value })),
    run: (view, value) => insertCallout(value)(view),
  },
  { sep: true },
  { label: '🔗', title: 'Link (⌘K)', run: insertLink },
  { label: '⊞', title: 'Table', run: insertTable },
  { label: '≡', title: 'Table column alignment (cycles left / centre / right)', run: cycleColumnAlign },
  { label: '</>', title: 'Code block', run: insertCodeBlock },
  // The five that are reached occasionally rather than constantly. They were
  // buttons, and 24 always-visible controls is what pushed this toolbar onto a
  // second row — an orphaned control on a line of its own reads as a bug. A
  // named menu is also more discoverable than a glyph nobody recognises: "†"
  // does not say footnote to anyone who has not already found it.
  {
    label: 'Insert',
    title: 'Insert',
    options: Object.entries(INSERTS).map(([value, { label }]) => ({ label, value })),
    run: (view, value) => INSERTS[value]?.run(view),
  },
  // Everything to the left acts on the document. What follows is about how it
  // looks to you, so it sits at the other end of the bar.
  { grow: true },
  // `display: true` marks the entries that are not editing commands, and so
  // survive for a viewer or a commenter — who see no toolbar otherwise, and
  // are exactly the people a *reading* preference is for.
  { label: 'Aa', title: 'Reading preferences', panel: 'reading', display: true },
]

// Nesting is Tab, list continuation is Enter — and Enter is already bound, at
// Prec.high, by markdown()'s own keymap. Tab is bound here rather than there
// because indentListCmd declines outside a list, which lets Tab keep moving
// focus everywhere else.
const formatKeymap = [
  { key: 'Mod-b', run: toggleInline('**') },
  { key: 'Mod-i', run: toggleInline('*') },
  { key: 'Mod-e', run: toggleInline('`') },
  { key: 'Mod-k', run: insertLink },
  { key: 'Shift-Enter', run: insertHardBreak },
  { key: 'Tab', run: indentListCmd(false) },
  { key: 'Shift-Tab', run: indentListCmd(true) },
]

// ---- editor construction --------------------------------------------------

// One markdown configuration for both the live editor and the history
// preview, so a document never renders two different ways.
//
// `codeLanguages` is what makes a ```go block actually parse as Go. The
// grammars are *not* in the bundle: @codemirror/language-data is a table of
// dynamic imports, so a language is fetched the first time a block declares
// it, and a document with no code blocks pays nothing. See DESIGN-DECISIONS,
// *Fenced code blocks*, for what that costs the build.
//
// `extensions` adds the two constructs the grammar does not know — highlight
// and definition lists. Superscript, subscript and emoji need nothing here:
// `markdownLanguage` is lang-markdown's *extended* parser and has carried all
// three since before this app existed. They were parsing all along, with
// nothing to style them.
const markdownSetup = () => [
  markdown({ base: markdownLanguage, codeLanguages: languages, extensions: markdownExtensions }),
  syntaxHighlighting(codeHighlight),
  // Both editors, so the read-only history preview numbers footnotes the same
  // way the live one does.
  footnoteIndex,
]

// Read-only standalone editor for previewing a historical state: same
// markdown rendering (live preview, widgets, tables), no collaboration.
export function mountPreview({ parent, content }) {
  const view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        markdownSetup(),
        livePreview,
        tableDecorations,
        EditorView.lineWrapping,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ],
    }),
    parent,
  })
  return view
}

// Reading preferences reach the editor through a CodeMirror *theme*, not
// through app.css. CodeMirror's base theme sets `font-family: monospace` on
// the scroller, and its injected styles beat an app rule of the same
// specificity — which is why the first version appeared to work for size (set
// on .cm-editor, which the base theme does not touch) while family, line
// height and measure silently did nothing. A theme is applied after the base
// theme by construction, so this is precedence by design rather than by luck.
//
// The values stay as CSS custom properties so they remain live: prefs.js sets
// them on the root element and every mounted editor follows without being told.
const readingTheme = EditorView.theme({
  '&': {
    fontSize: 'var(--reading-size, 16px)',
    fontFamily: 'var(--reading-font, system-ui, sans-serif)',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: 'var(--reading-line-height, 1.6)',
  },
  // Centring the text column, while the scroller and its scrollbar stay full
  // width. flex-grow on .cm-content is why this needs the margin as well.
  '.cm-content': {
    maxWidth: 'var(--reading-measure, none)',
    margin: '0 auto',
  },
})

export function mountEditor({ parent, ytext, awareness, readOnly, onSelectionChange, onHeadingsChange }) {
  const undoManager = new Y.UndoManager(ytext)
  const extensions = [
    keymap.of([...yUndoManagerKeymap, ...formatKeymap, ...defaultKeymap]),
    markdownSetup(),
    readingTheme,
    livePreview,
    tableDecorations,
    commentRanges,
    EditorView.domEventHandlers({ mousedown: handleWidgetClick }),
    EditorView.lineWrapping,
    yCollab(ytext, awareness, { undoManager }),
  ]
  if (onSelectionChange) {
    // The comment composer anchors to the selection, so it has to hear about
    // every change to it — including the ones caused by a collaborator's edit
    // shifting the cursor, which is why this listens to the editor rather than
    // to DOM selection events.
    extensions.push(
      EditorView.updateListener.of((u) => {
        if (!u.selectionSet && !u.docChanged) return
        const r = u.state.selection.main
        onSelectionChange(r.from, r.to)
      }),
    )
  }
  if (onHeadingsChange) {
    // Coalesced, and on docChanged only. A collaborator's edit arrives as a
    // transaction here too, so this one plugin covers remote headings as well
    // as local ones — which is why it is not hung off the Y.Text.
    //
    // A ViewPlugin rather than a plain updateListener, for destroy(): leaving
    // the document while a rebuild is pending would otherwise fire it against
    // an editor that no longer exists.
    extensions.push(
      ViewPlugin.fromClass(
        class {
          constructor() {
            this.queued = null
          }
          update(u) {
            if (!u.docChanged || this.queued) return
            this.queued = setTimeout(() => {
              this.queued = null
              onHeadingsChange()
            }, HEADINGS_DEBOUNCE)
          }
          destroy() {
            clearTimeout(this.queued)
          }
        },
      ),
    )
  }
  if (readOnly) {
    extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false))
  }
  const view = new EditorView({
    state: EditorState.create({ doc: ytext.toString(), extensions }),
    parent,
  })
  return view
}
