// Markdown editor: CodeMirror 6 over a shared Y.Text, with Obsidian-style
// live preview — the document stays plain markdown; styling is a decoration
// layer over the syntax tree, and marker characters (**, #, `…) are hidden
// unless the selection touches the construct they belong to.
import { EditorView, keymap, ViewPlugin, Decoration } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { defaultKeymap } from '@codemirror/commands'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'

// ---- live preview ---------------------------------------------------------

const hide = Decoration.replace({})
const mark = (cls) => Decoration.mark({ class: cls })
const line = (cls) => Decoration.line({ class: cls })

const inlineMarks = {
  StrongEmphasis: mark('md-strong'),
  Emphasis: mark('md-em'),
  InlineCode: mark('md-code'),
  Strikethrough: mark('md-strike'),
  Link: mark('md-link'),
}

// Marker nodes hidden when the selection does not touch their parent
// construct. HeaderMark also swallows the space that follows it.
const markerParents = ['EmphasisMark', 'CodeMark', 'StrikethroughMark', 'LinkMark', 'URL', 'HeaderMark']

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
        if (name in inlineMarks) {
          decos.push(inlineMarks[name].range(node.from, node.to))
          return
        }
        if (markerParents.includes(name)) {
          const parent = node.node.parent
          if (parent && !selectionTouches(state, parent.from, parent.to)) {
            let end = node.to
            if (name === 'HeaderMark' && state.sliceDoc(end, end + 1) === ' ') end++
            if (end > node.from) decos.push(hide.range(node.from, end))
          }
          return
        }
        if (name === 'Blockquote') {
          addLines(node.from, node.to, 'md-blockquote')
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

// Set (or toggle off) an ATX heading level on every selected line.
function setHeading(level) {
  return (view) => {
    const { state } = view
    const sel = state.selection.main
    const changes = []
    const target = '#'.repeat(level) + ' '
    for (let pos = sel.from; pos <= sel.to; ) {
      const ln = state.doc.lineAt(pos)
      const m = ln.text.match(/^#{1,6} /)
      const cur = m ? m[0] : ''
      const insert = cur === target ? '' : target
      changes.push({ from: ln.from, to: ln.from + cur.length, insert })
      pos = ln.to + 1
    }
    dispatchKeepingCursor(view, changes)
    return true
  }
}

// Toggle a per-line prefix ('- ' bullets, '> ' quotes) across the selection.
function toggleLinePrefix(prefix) {
  return (view) => {
    const { state } = view
    const sel = state.selection.main
    const lines = []
    for (let pos = sel.from; pos <= sel.to; ) {
      const ln = state.doc.lineAt(pos)
      lines.push(ln)
      pos = ln.to + 1
    }
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

export const toolbarCommands = [
  { label: 'B', title: 'Bold (⌘B)', run: toggleInline('**') },
  { label: 'I', title: 'Italic (⌘I)', run: toggleInline('*') },
  { label: 'S̶', title: 'Strikethrough', run: toggleInline('~~') },
  { label: '<>', title: 'Inline code (⌘E)', run: toggleInline('`') },
  { label: 'H1', title: 'Heading 1', run: setHeading(1) },
  { label: 'H2', title: 'Heading 2', run: setHeading(2) },
  { label: 'H3', title: 'Heading 3', run: setHeading(3) },
  { label: '•', title: 'Bullet list', run: toggleLinePrefix('- ') },
  { label: '❝', title: 'Quote', run: toggleLinePrefix('> ') },
  { label: '🔗', title: 'Link (⌘K)', run: insertLink },
]

const formatKeymap = [
  { key: 'Mod-b', run: toggleInline('**') },
  { key: 'Mod-i', run: toggleInline('*') },
  { key: 'Mod-e', run: toggleInline('`') },
  { key: 'Mod-k', run: insertLink },
]

// ---- editor construction --------------------------------------------------

export function mountEditor({ parent, ytext, awareness, readOnly }) {
  const undoManager = new Y.UndoManager(ytext)
  const extensions = [
    keymap.of([...yUndoManagerKeymap, ...formatKeymap, ...defaultKeymap]),
    markdown({ base: markdownLanguage }),
    livePreview,
    EditorView.lineWrapping,
    yCollab(ytext, awareness, { undoManager }),
  ]
  if (readOnly) {
    extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false))
  }
  const view = new EditorView({
    state: EditorState.create({ doc: ytext.toString(), extensions }),
    parent,
  })
  return view
}
