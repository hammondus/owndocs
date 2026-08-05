<script>
  // Version history for one document: a timeline of editing sessions and
  // named versions on the left, a read-only preview of the selected point
  // on the right. Restore rewrites the live document to the previewed state
  // through a normal collaborative edit — history itself is never touched.
  import { onMount, onDestroy } from 'svelte'
  import * as Y from 'yjs'
  import { api } from './api.js'
  import { iterFrames } from '../frames.js'
  import { mountPreview } from '../editor.js'
  import { Provider } from '../provider.js'
  import { Workbook } from '../sheet/model.js'
  import SheetPreview from './SheetPreview.svelte'

  let { doc, onBack } = $props()

  // Docs and sheets share the whole history mechanism — the log, the
  // sessions, named versions, replay — and differ only in how a past state
  // is rendered and how it is written back.
  // $derived, not const: props can change, and a const would freeze the
  // value from the first render.
  let isSheet = $derived(doc.kind === 'sheet')

  let sessions = $state([])
  let versions = $state([])
  let selectedSeq = $state(null)
  let loaded = $state(false) // a point has been replayed and is on screen
  let previewText = null // docs: the markdown at that point
  let previewDoc = $state(null) // sheets: the reconstructed Y.Doc
  let versionName = $state('')
  let error = $state('')
  let busy = $state(false)

  // $state because the div now mounts conditionally (docs only): bind:this
  // writes to it each time that branch appears.
  let previewEl = $state(null)
  let previewView // the read-only CodeMirror instance (docs only)

  onMount(load)
  onDestroy(() => {
    previewView?.destroy()
    previewDoc?.destroy()
  })

  async function load() {
    const h = await api(`/api/docs/${doc.id}/history`)
    // Newest first for both lists.
    sessions = h.sessions.toReversed()
    versions = h.versions
  }

  // Fetch the update log up to a sequence number and replay it into a
  // fresh Y.Doc — the same reconstruction a normal load does, just stopped
  // at a point in the past.
  async function preview(seq) {
    selectedSeq = seq
    error = ''
    const res = await fetch(`/api/docs/${doc.id}/replay?to_seq=${seq}`)
    if (!res.ok) {
      error = 'failed to load that point'
      return
    }
    const frames = new Uint8Array(await res.arrayBuffer())
    const replayDoc = new Y.Doc()
    for (const update of iterFrames(frames)) Y.applyUpdate(replayDoc, update)

    if (isSheet) {
      // The reconstructed doc stays alive: SheetPreview reads through a
      // Workbook built on it, and restore copies straight out of it.
      previewDoc?.destroy()
      previewDoc = replayDoc
    } else {
      previewText = replayDoc.getText('text').toString()
      replayDoc.destroy()
      previewView?.destroy()
      previewView = mountPreview({ parent: previewEl, content: previewText })
    }
    loaded = true
  }

  async function pinVersion(event) {
    event.preventDefault()
    try {
      await api(`/api/docs/${doc.id}/versions`, {
        method: 'POST',
        body: JSON.stringify({ name: versionName }),
      })
      versionName = ''
      error = ''
      await load()
    } catch (err) {
      error = err.message
    }
  }

  async function deleteVersion(v) {
    await api(`/api/docs/${doc.id}/versions/${v.id}`, { method: 'DELETE' })
    await load()
  }

  // Restore: connect to the live document like any client, replace its
  // content with the previewed text in one transaction, disconnect. The
  // edit syncs to anyone currently in the doc and lands in history as a
  // new session — nothing is rewritten.
  async function restore() {
    if (!loaded || busy) return
    if (!confirm('Replace the current content with this version? The current state stays in history.')) return
    busy = true
    error = ''
    try {
      const ydoc = new Y.Doc()
      let markSynced
      const synced = new Promise((resolve, reject) => {
        markSynced = resolve
        setTimeout(() => reject(new Error('sync timeout')), 10000)
      })
      const provider = new Provider(ydoc, doc.id, { onSynced: () => markSynced() })
      await synced
      if (isSheet) {
        // One transaction, so the restore is a single update on the wire
        // and a single undo step for anyone watching.
        new Workbook(ydoc).restoreFrom(new Workbook(previewDoc))
      } else {
        const ytext = ydoc.getText('text')
        ydoc.transact(() => {
          ytext.delete(0, ytext.length)
          ytext.insert(0, previewText)
        })
      }
      provider.destroy()
      ydoc.destroy()
      onBack() // back to the editor, which reloads the live doc
    } catch (err) {
      error = err.message
      busy = false
    }
  }

  function formatTime(unixSeconds) {
    return new Date(unixSeconds * 1000).toLocaleString()
  }
  function sessionLabel(s) {
    if (s.coarse) return `archived up to here (${formatTime(s.started_at)})`
    if (s.started_at === s.ended_at) return formatTime(s.started_at)
    const end = new Date(s.ended_at * 1000).toLocaleTimeString()
    return `${formatTime(s.started_at)} – ${end}`
  }
</script>

<p>
  <a href="#back" onclick={(e) => { e.preventDefault(); onBack() }}>← back to document</a>
  History of <strong>{doc.title}</strong>
</p>

<div class="layout">
  <div class="timeline">
    {#if doc.role !== 'viewer'}
      <form onsubmit={pinVersion}>
        <input placeholder="name current version" bind:value={versionName} required />
        <button>Pin</button>
      </form>
    {/if}

    {#if versions.length > 0}
      <h3>Named versions</h3>
      <ul>
        {#each versions as v (v.id)}
          <li class:selected={selectedSeq === v.seq}>
            <a href="#v{v.id}" onclick={(e) => { e.preventDefault(); preview(v.seq) }}>
              {v.name}
            </a>
            <small>{v.created_by}, {formatTime(v.created_at)}</small>
            {#if doc.role === 'owner'}
              <button onclick={() => deleteVersion(v)}>✕</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <h3>Sessions</h3>
    <ul>
      {#each sessions as s (s.end_seq)}
        <li class:selected={selectedSeq === s.end_seq}>
          <a href="#s{s.end_seq}" onclick={(e) => { e.preventDefault(); preview(s.end_seq) }}>
            {sessionLabel(s)}
          </a>
          <small>{s.rows} change{s.rows === 1 ? '' : 's'}</small>
        </li>
      {/each}
    </ul>
    {#if error}
      <p class="err">{error}</p>
    {/if}
  </div>

  <div class="preview">
    {#if !loaded}
      <p class="hint">Select a point in the timeline to preview it.</p>
    {:else if doc.role !== 'viewer'}
      <p><button onclick={restore} disabled={busy}>Restore this version</button></p>
    {/if}
    {#if isSheet}
      {#if previewDoc}
        <!-- #key rebuilds the preview when a different point is selected,
             so no state from the previous version can leak into it. -->
        {#key selectedSeq}
          <SheetPreview ydoc={previewDoc} />
        {/key}
      {/if}
    {:else}
      <div bind:this={previewEl}></div>
    {/if}
  </div>
</div>

<style>
  .layout {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
  }
  .timeline {
    flex: 0 0 17rem;
  }
  .preview {
    flex: 1;
    min-width: 0; /* allow the editor to shrink instead of overflowing */
  }
  h3 {
    font-size: 0.95rem;
    margin: 0.8rem 0 0.3rem;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  li {
    padding: 0.2rem 0.3rem;
    border-radius: 4px;
  }
  li.selected {
    background: #8882;
  }
  li small {
    display: block;
    opacity: 0.6;
  }
  .hint {
    opacity: 0.6;
  }
</style>
