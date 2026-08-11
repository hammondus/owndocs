<script>
  // The editor page. The actual editor is NOT a Svelte component — it's the
  // framework-agnostic CodeMirror module (editor.js) plus the sync provider
  // (provider.js). This component's job is lifecycle: create them when the
  // page mounts, hand them a real DOM node, and tear them down on leave.
  import { onMount, onDestroy } from 'svelte'
  import * as Y from 'yjs'
  import { Provider } from '../provider.js'
  import { mountEditor, toolbarCommands, setCommentRanges, revealRange } from '../editor.js'
  import CommentsPanel from './CommentsPanel.svelte'
  import DocTitle from './DocTitle.svelte'
  import ReadingPrefs from './ReadingPrefs.svelte'
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
  let showReading = $state(false)
  let threads = $state([])
  let selection = $state({ from: 0, to: 0 })
  let mayComment = $derived(canComment(doc.role))
  let openComments = $derived(threads.filter((t) => !t.resolved_at).length)

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
    })

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

<p>
  <a href="#list" onclick={(e) => { e.preventDefault(); onBack() }}>← documents</a>
  <DocTitle {doc} canRename={canEdit(doc.role)} {onRenamed} />
  {#if doc.role === 'owner'}
    <a href="#share" onclick={(e) => { e.preventDefault(); onShare(doc) }}>share</a>
  {/if}
  <a href="#history" onclick={(e) => { e.preventDefault(); onHistory(doc) }}>history</a>
  <!-- Outside the editing toolbar: viewers read comments and commenters write
       them, and neither sees that toolbar. -->
  <button class="linkish" onclick={() => (showComments = !showComments)}>
    💬 comments{openComments ? ` (${openComments})` : ''}
  </button>
  <button class="linkish" onclick={() => (showReading = !showReading)} title="How this renders for you">
    Aa
  </button>
  <span class="status">{status}</span>
  {#if peerCount > 1}
    <span class="status">{peerCount} online</span>
  {/if}
</p>

{#if doc.role !== 'viewer'}
  <div class="toolbar">
    {#each toolbarCommands as cmd (cmd.title)}
      <!-- onmousedown preventDefault keeps focus (and the text selection)
           inside the editor while the button is clicked -->
      <button
        title={cmd.title}
        onmousedown={(e) => e.preventDefault()}
        onclick={() => cmd.run(view)}
      >{cmd.label}</button>
    {/each}
  </div>
{/if}

{#if showReading}
  <!-- Changing size or family changes line heights, and CodeMirror does not
       find that out on its own — it caches measurements per line. -->
  <ReadingPrefs onChanged={() => view?.requestMeasure()} onClose={() => (showReading = false)} />
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

<div bind:this={editorEl}></div>


<style>
  /* A button, because it toggles a panel rather than navigating — styled to
     sit with the links beside it. */
  .linkish {
    border: 0;
    background: none;
    padding: 0;
    margin-left: 0.5rem;
    font: inherit;
    font-size: 0.9rem;
    color: #1565c0;
    cursor: pointer;
  }
  .status {
    font-size: 0.85rem;
    opacity: 0.7;
    margin-left: 0.5rem;
  }
</style>
