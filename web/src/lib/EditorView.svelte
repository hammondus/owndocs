<script>
  // The editor page. The actual editor is NOT a Svelte component — it's the
  // framework-agnostic CodeMirror module (editor.js) plus the sync provider
  // (provider.js). This component's job is lifecycle: create them when the
  // page mounts, hand them a real DOM node, and tear them down on leave.
  import { onMount, onDestroy } from 'svelte'
  import * as Y from 'yjs'
  import { Provider } from '../provider.js'
  import {
    mountEditor, toolbarCommands, setCommentRanges, revealRange,
    documentHeadings, goToPos, insertEmoji,
  } from '../editor.js'
  import EmojiPicker from './EmojiPicker.svelte'
  import CommentsPanel from './CommentsPanel.svelte'
  import DocTitle from './DocTitle.svelte'
  import ReadingPrefs from './ReadingPrefs.svelte'
  import Toc from './Toc.svelte'
  import { load as loadPrefs } from '../prefs.js'
  import { listThreads, textAnchor, resolveTextAnchor } from '../comments.js'
  import { scheduleCompaction } from '../compaction.js'
  import { canEdit, canComment } from '../roles.js'

  let { me, doc, onBack, onShare, onHistory, onRenamed } = $props()

  let status = $state('connecting…')
  let peerCount = $state(1)

  // bind:this fills this variable with the actual <div> DOM element once it
  // exists — the escape hatch for handing DOM to non-Svelte code.
  let editorEl

  let ydoc, provider, view

  let showComments = $state(false)
  // Which toolbar drawer is open, by the `panel` id its entry carries. A
  // single value rather than one flag per panel: two open at once would push
  // the editor off the screen, and only one can be wanted at a time.
  let openPanel = $state('')

  // A viewer and a commenter get no editing controls, but they do get the
  // reading ones — the toolbar is where those live now, so it renders for
  // everyone and drops what they may not use. Separators have no `display`,
  // so they fall away with the commands they were dividing.
  let bar = $derived(canEdit(doc.role) ? toolbarCommands : toolbarCommands.filter((c) => c.display))
  let threads = $state([])
  let selection = $state({ from: 0, to: 0 })
  let mayComment = $derived(canComment(doc.role))
  let openComments = $derived(threads.filter((t) => !t.resolved_at).length)

  // ---- contents ---------------------------------------------------------------
  // Side and depth are reading preferences, so they live in localStorage with
  // the font. Held here as state rather than read on every render because the
  // preferences panel has to be able to change them under us.
  let reading = $state(loadPrefs())
  let headings = $state([])

  // Hidden when a document has no headings at all: an empty column beside the
  // text is worse than no column, and it is exactly what a new document has.
  let tocSide = $derived(reading.toc !== 'off' && headings.length ? reading.toc : '')

  function refreshHeadings() {
    if (!view) return
    headings = documentHeadings(view.state, reading.tocDepth)
  }

  // Which heading the cursor is under: the last one at or before it. Recomputed
  // from the selection the editor already reports for the comment composer.
  let activeHeading = $derived.by(() => {
    let i = -1
    for (let n = 0; n < headings.length; n++) if (headings[n].pos <= selection.from) i = n
    return i
  })

  const cursorColors = [
    ['#30bced', '#a8dff2'], ['#6eeb83', '#c6f7cf'], ['#fa69d1', '#fcc4ea'],
    ['#ffbc42', '#ffe3b0'], ['#ecd444', '#f5edb0'], ['#ee6352', '#f8c2ba'],
    ['#9b6ef3', '#d9c6fa'], ['#1be7ff', '#b3f6ff'],
  ]

  onMount(() => {
    ydoc = new Y.Doc()
    const ytext = ydoc.getText('text')

    provider = new Provider(ydoc, doc.id, {
      onStatus: (s) => { status = s },
      onSynced: (synced) => {
        if (provider.corrupted) return // never snapshot/verify after a bad frame
        scheduleCompaction({ docId: doc.id, doc: ydoc, role: doc.role, synced })
      },
      onComments: loadComments,
    })

    const [color, colorLight] = cursorColors[ydoc.clientID % cursorColors.length]
    provider.awareness.setLocalStateField('user', { name: me.name, color, colorLight })
    provider.awareness.on('change', () => {
      peerCount = provider.awareness.getStates().size
    })

    view = mountEditor({
      parent: editorEl,
      ytext,
      awareness: provider.awareness,
      // Commenters are read-only here too: typing would send a doc update and
      // the server closes the socket for it. Comments go over HTTP instead.
      readOnly: !canEdit(doc.role),
      // The composer anchors to whatever is selected, so the panel needs to
      // know when that changes.
      onSelectionChange: (from, to) => { selection = { from, to } },
      // Coalesced inside the editor; a collaborator's edit reaches this too.
      onHeadingsChange: refreshHeadings,
    })

    // The first pass. The document arrives from the provider a moment after
    // mount, and that arrival is a doc change, so the debounced rebuild covers
    // it — this only fills the panel for a document that was already synced.
    refreshHeadings()

    loadComments()
    // Anchors resolve against the document, so re-resolve after remote edits
    // as well as local ones: a collaborator's insert moves every highlight
    // after it.
    ytext.observe(schedulePaint)
  })

  // ---- comments -------------------------------------------------------------

  async function loadComments() {
    try {
      threads = await listThreads(doc.id)
    } catch (e) {
      console.warn('docs: could not load comments', e)
      return
    }
    paintComments()
  }

  // Resolve every unresolved thread's anchor to a range in the document as it
  // is now, and hand the result to the editor to highlight. Threads whose text
  // has been deleted resolve to null and are simply not painted — the panel
  // still lists them, against their quoted snippet.
  // Never repaint straight from the Yjs observer. That observer runs inside the
  // transaction, which for a local edit is inside CodeMirror's own update — and
  // dispatching there throws "Calls to EditorView.update are not allowed while
  // an update is in progress", which CodeMirror reports as a crashed plugin and
  // which corrupts the editor's state. A microtask runs once the update has
  // unwound. Coalesced, since a burst of edits needs one repaint.
  let paintQueued = false
  function schedulePaint() {
    if (paintQueued) return
    paintQueued = true
    queueMicrotask(() => {
      paintQueued = false
      paintComments()
    })
  }

  function paintComments() {
    if (!view || !ydoc) return
    const ranges = []
    for (const t of threads) {
      if (t.resolved_at) continue
      const r = resolveTextAnchor(t.anchor, ydoc)
      if (r && r.to > r.from) ranges.push(r)
    }
    setCommentRanges(view, ranges)
  }

  // A comment needs something to point at, so an empty selection cannot start
  // one. Unlike a sheet, nothing has to be created first — the text is already
  // there — so a commenter is as able to do this as an editor.
  let canAnchor = $derived(selection.to > selection.from)
  let anchorNote = $derived(canAnchor ? '' : 'Select some text to comment on it.')
  let newLabel = $derived(canAnchor ? quoteOf(selection.from, selection.to, 24) : 'nothing')

  function quoteOf(from, to, max) {
    const s = ydoc?.getText('text').toString().slice(from, to) ?? ''
    return s.length > max ? s.slice(0, max) + '…' : s
  }

  function makeAnchor() {
    if (!ydoc || selection.to <= selection.from) return null
    return textAnchor(
      ydoc.getText('text'),
      selection.from,
      selection.to,
      quoteOf(selection.from, selection.to, 120),
    )
  }

  // A thread's label is the text it points at *now*, falling back to what it
  // pointed at when written. "deleted" is said out loud rather than showing
  // whatever text has since moved into that position.
  function threadLabel(t) {
    const r = resolveTextAnchor(t.anchor, ydoc)
    if (!r || r.to <= r.from) return t.anchor?.quote ? '(deleted)' : '—'
    return quoteOf(r.from, r.to, 24)
  }

  function goToThread(t) {
    const r = resolveTextAnchor(t.anchor, ydoc)
    if (r && view) revealRange(view, r.from, r.to)
  }

  onDestroy(() => {
    view?.destroy()
    provider?.destroy()
    ydoc?.destroy()
  })
</script>

<!-- The view's own bar, below the app bar: what document this is, what you can
     do to it, and what the connection is doing. Three groups, left to right,
     and the status readout on the far right where a status light belongs. -->
<div class="viewbar">
  <!-- An arrow with no words needs a name: `title` is a tooltip, `aria-label`
       is what a screen reader and a test both read. -->
  <a
    class="back"
    href="#list"
    title="Back to documents"
    aria-label="Back to documents"
    onclick={(e) => { e.preventDefault(); onBack() }}
  >←</a>
  <DocTitle {doc} canRename={canEdit(doc.role)} {onRenamed} />
  <span class="label kind">{doc.role}</span>

  <span class="spacer"></span>

  <button class="linkish" onclick={() => (showComments = !showComments)}>
    comments{openComments ? ` (${openComments})` : ''}
  </button>
  {#if doc.role === 'owner'}
    <a href="#share" onclick={(e) => { e.preventDefault(); onShare(doc) }}>share</a>
  {/if}
  <a href="#history" onclick={(e) => { e.preventDefault(); onHistory(doc) }}>history</a>

  <!-- A status light: the dot carries the state, the words explain it. Green
       only when the document is actually reconciled with the server. -->
  <span class="status readout" class:live={status === 'synced'}>
    <span class="dot"></span>{status}{peerCount > 1 ? ` · ${peerCount} online` : ''}
  </span>
</div>

<!-- Rendered for every role, and filtered by `bar`. What a commenter must not
     reach is the editing commands: they are mounted read-only for the reason
     roles.js states — the provider would send a doc update and the server
     would close the socket — but EditorState.readOnly only stops *user input*,
     and a toolbar button is a programmatic dispatch that goes straight through
     it. So the filter is the gate, not the {#if} that used to wrap this. -->
<div class="toolbar">
  {#each bar as cmd, i (i)}
    {#if cmd.sep}
      <span class="sep" aria-hidden="true"></span>
    {:else if cmd.grow}
      <span class="grow"></span>
    {:else if cmd.options}
      <!-- A menu, not a mode: it never reports the current style, so it resets
           to its own label after every choice. Unlike the buttons this one
           cannot preventDefault on mousedown — that would stop it opening — so
           it takes focus away from the editor. Harmless: the selection lives
           in CodeMirror's state, not in the DOM, and the command puts focus
           back when it is done. -->
      <select
        title={cmd.title}
        aria-label={cmd.title}
        onchange={(e) => { cmd.run(view, e.currentTarget.value); e.currentTarget.value = '' }}
      >
        <option value="" disabled selected>{cmd.label}</option>
        {#each cmd.options as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    {:else}
      <!-- onmousedown preventDefault keeps focus (and the text selection)
           inside the editor while the button is clicked -->
      <button
        title={cmd.title}
        aria-label={cmd.title}
        class:pressed={cmd.panel && openPanel === cmd.panel}
        aria-pressed={cmd.panel ? openPanel === cmd.panel : undefined}
        onmousedown={(e) => e.preventDefault()}
        onclick={() =>
          cmd.panel
            ? (openPanel = openPanel === cmd.panel ? '' : cmd.panel)
            : cmd.run(view)}
      >{cmd.label}</button>
    {/if}
  {/each}
</div>

{#if openPanel === 'emoji'}
  <EmojiPicker onPick={(name) => insertEmoji(view, name)} onClose={() => (openPanel = '')} />
{/if}

{#if openPanel === 'reading'}
  <!-- Changing size or family changes line heights, and CodeMirror does not
       find that out on its own — it caches measurements per line. -->
  <ReadingPrefs
    onChanged={() => {
      // Re-read rather than being handed a patch: the panel owns the shape of
      // a preference blob, and this only needs to know it changed.
      reading = loadPrefs()
      refreshHeadings()
      view?.requestMeasure()
    }}
    onClose={() => (openPanel = '')}
  />
{/if}

{#if showComments}
  <CommentsPanel
    docId={doc.id}
    {threads}
    {me}
    canComment={mayComment}
    isOwner={doc.role === 'owner'}
    {makeAnchor}
    {canAnchor}
    {anchorNote}
    {newLabel}
    label={threadLabel}
    onRefresh={loadComments}
    onGoTo={goToThread}
    onClose={() => (showComments = false)}
  />
{/if}

<!-- The contents column and the editor are siblings in a flex row, with `row-
     reverse` doing the left/right switch. The editor keeps `min-width: 0`, or
     a long unbreakable line inside CodeMirror would push the column off the
     page — flex items refuse to shrink below their content by default. -->
<div class="doc-layout" class:with-toc={tocSide} class:toc-right={tocSide === 'right'}>
  {#if tocSide}
    <Toc {headings} active={activeHeading} onGo={(pos) => goToPos(view, pos)} />
  {/if}
  <div class="editor" bind:this={editorEl}></div>
</div>


<style>
  .doc-layout {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
  }
  /* Without this the editor refuses to shrink below its content width and
     shoves the contents column out of the page. */
  .editor {
    flex: 1;
    min-width: 0;
  }
  /* Reversing the row rather than reordering the markup keeps the contents
     first in the DOM, which is where a screen reader wants a nav landmark
     whichever side it is drawn on. */
  .doc-layout.toc-right {
    flex-direction: row-reverse;
  }
  .doc-layout.with-toc :global(nav.toc) {
    flex: 0 0 13rem;
  }
  @media (max-width: 60rem) {
    /* Below this there is no room for two columns and the text column is what
       matters, so the contents drop out entirely rather than being squeezed. */
    .doc-layout.with-toc :global(nav.toc) {
      display: none;
    }
  }
</style>
