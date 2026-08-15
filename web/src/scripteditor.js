// The script editor's CodeMirror instance: JavaScript highlighting, line
// numbers, and save-on-pause. A plain module like editor.js, so the Svelte
// component stays a layout and this stays testable from node.
//
// Why the grammar is not a new dependency. `@codemirror/language-data` is
// already a declared dep and is already a table of *lazy* imports — it is what
// makes a ```js block in a markdown document highlight (see editor.js,
// `markdownSetup`). Asking that same table for JavaScript costs one dynamic
// import the first time a script is opened, and nothing at all for someone who
// never opens one. Importing `@codemirror/lang-javascript` directly would be
// shorter, but that package is only in the tree transitively, and depending on
// a hoisted transitive is how a working build breaks on someone else's npm.
//
// Why not y-codemirror.next, which the markdown editor uses. A script is
// stored as a whole `{id, name, code}` object in a Y.Map, so there is no
// Y.Text to bind carets to. Giving each script one would change the storage
// format to buy live co-editing of twenty lines of automation — the wrong
// trade. Scripts still sync: a save replaces the object and every other window
// sees it, just per-save rather than per-keystroke.
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { syntaxHighlighting, bracketMatching, indentOnInput } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { codeHighlight } from './editor.js'

// How long a pause counts as "stopped typing". Long enough that a thinking
// pause mid-line does not save a half-written statement, short enough that
// switching to the sheet and hitting run never races the save.
export const SAVE_DELAY = 800

// The grammar, fetched once per page and shared by every editor after that.
// A module-level promise rather than a per-mount one so opening a second
// script does not import it again.
let jsSupport = null
function loadJS() {
  if (!jsSupport) {
    const entry = languages.find((l) => l.name === 'JavaScript')
    // No entry means the table changed under us. Highlighting is the one
    // feature here that is safe to simply not have, so fall back to a plain
    // editor rather than failing to mount one.
    jsSupport = entry ? entry.load() : Promise.resolve(null)
  }
  return jsSupport
}

// Mount an editor into `parent`.
//
// `onSave(code)` is called after a typing pause, on blur, and on destroy —
// never per keystroke. It is also called by `flush()`, which is what a caller
// uses before running the script, so ▶ run always runs what is on screen.
//
// Returns { destroy, flush, setCode, hasUnsaved }.
export function mountScriptEditor({ parent, code = '', readOnly = false, onSave = () => {}, onDirty = () => {} }) {
  const language = new Compartment()
  let timer = 0
  let dirty = false
  let destroyed = false
  // True while `setCode` is writing. Without it the update listener treats an
  // arriving change as something the user typed and schedules a save of it —
  // which writes the value straight back, and with two windows open on one
  // script that is a loop, each save waking the other.
  let applying = false

  const save = () => {
    clearTimeout(timer)
    timer = 0
    if (!dirty || destroyed) return
    dirty = false
    onDirty(false)
    onSave(view.state.doc.toString())
  }

  const view = new EditorView({
    state: EditorState.create({
      doc: code,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        bracketMatching(),
        indentOnInput(),
        // indentWithTab last, so it does not shadow the defaults it extends.
        // Tab indenting a code editor is worth the focus-trap it costs: this
        // is a pane you type code into, not a form field you tab past.
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        language.of([]),
        syntaxHighlighting(codeHighlight),
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || applying) return
          if (!dirty) { dirty = true; onDirty(true) }
          clearTimeout(timer)
          timer = setTimeout(save, SAVE_DELAY)
        }),
        // Blur still saves. In the drawer that is the common path; in a popped
        // out window it may never fire, which is the whole reason the timer
        // above exists rather than blur alone.
        EditorView.domEventHandlers({ blur: () => { save(); return false } }),
      ],
    }),
    parent,
  })

  loadJS().then((support) => {
    if (support && !destroyed) view.dispatch({ effects: language.reconfigure(support) })
  })

  return {
    view,
    // Save whatever is pending, right now. Called before a run and before the
    // pane switches scripts, so neither can act on a stale copy.
    flush: save,
    hasUnsaved: () => dirty,
    // Replace the contents wholesale — switching scripts, or a collaborator's
    // change arriving. Any pending edit of the OLD script is flushed first by
    // the caller; this only resets the buffer.
    setCode(next) {
      if (next === view.state.doc.toString()) return
      clearTimeout(timer)
      timer = 0
      dirty = false
      applying = true
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
      } finally {
        applying = false
      }
      onDirty(false)
    },
    destroy() {
      save() // an unsaved edit must not die with the window
      destroyed = true
      clearTimeout(timer)
      view.destroy()
    },
  }
}
