<script>
  // Version history for one document: a timeline of editing sessions and
  // named versions on the left, a read-only preview of the selected point
  // on the right. Restore rewrites the live document to the previewed state
  // through a normal collaborative edit — history itself is never touched.
  import { onMount, onDestroy } from 'svelte'
  import * as Y from 'yjs'
  import { api, apiFetch } from './api.js'
  import { canManage } from '../roles.js'
  import { iterFrames } from '../frames.js'
  import { mountPreview } from '../editor.js'
  import { Provider } from '../provider.js'
  import { Workbook } from '../sheet/model.js'
  import { splices, hunks } from '../diff.js'
  import { sheetChanges } from '../sheetdiff.js'
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

  // 'preview' shows what the document looked like; 'diff' shows what changed to
  // get there. Two questions about the same point, so one selection serves both
  // and switching does not lose your place in the timeline.
  let mode = $state('preview')
  let baseSeq = $state(null) // the point the selection is compared against
  let textDiff = $state(null)
  let sheetDiff = $state(null)
  let diffing = $state(false)

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

  // Every point in the timeline as one list, newest first. Sessions and named
  // versions are separate lists in the UI because they mean different things,
  // but "the point before this one" spans both — a version pinned mid-session
  // sits between two sessions and comparing against it should be possible.
  let points = $derived.by(() => {
    const all = [
      ...sessions.map((s) => ({ seq: s.end_seq, label: sessionLabel(s) })),
      ...versions.map((v) => ({ seq: v.seq, label: v.name })),
    ]
    // Descending, and de-duplicated: a version pinned at the end of a session
    // shares its seq, and offering the same point twice invites comparing
    // something with itself.
    const seen = new Set()
    return all
      .sort((x, y) => y.seq - x.seq)
      .filter((p) => (seen.has(p.seq) ? false : seen.add(p.seq)))
  })

  // What a point is compared against unless you say otherwise: the point
  // immediately before it. That answers "what did this session do", which is
  // the question the timeline itself invites — where comparing against the
  // newest point answers "what has happened since", and is one click away.
  function defaultBaseFor(seq) {
    const i = points.findIndex((p) => p.seq === seq)
    const older = points[i + 1]
    return older ? older.seq : null
  }

  // The update log up to a point, replayed into a fresh Y.Doc — the same
  // reconstruction a normal load does, stopped in the past. Extracted because
  // a diff needs two of them and the preview needs one.
  async function replayAt(seq) {
    const res = await apiFetch(`/api/docs/${doc.id}/replay?to_seq=${seq}`)
    if (!res.ok) throw new Error('failed to load that point')
    const frames = new Uint8Array(await res.arrayBuffer())
    const replayed = new Y.Doc()
    for (const update of iterFrames(frames)) Y.applyUpdate(replayed, update)
    return replayed
  }

  async function computeDiff() {
    if (selectedSeq == null) return
    textDiff = null
    sheetDiff = null
    error = ''
    if (baseSeq == null) return // the oldest point has nothing before it
    diffing = true
    try {
      // Both ends fetched together: they are independent requests and the
      // second is usually already in the browser's cache from the preview.
      const [before, after] = await Promise.all([replayAt(baseSeq), replayAt(selectedSeq)])
      try {
        if (isSheet) {
          sheetDiff = sheetChanges(before, after)
        } else {
          textDiff = hunks(before.getText('text').toString(), after.getText('text').toString())
        }
      } finally {
        // Destroyed after the diff is built, never before: sheetChanges reads
        // through Workbooks constructed on these docs.
        before.destroy()
        after.destroy()
      }
    } catch (err) {
      error = err.message
    } finally {
      diffing = false
    }
  }

  function setMode(next) {
    mode = next
    if (next === 'diff') {
      if (baseSeq === null) baseSeq = defaultBaseFor(selectedSeq)
      computeDiff()
    }
  }

  // Fetch the update log up to a sequence number and replay it into a
  // fresh Y.Doc — the same reconstruction a normal load does, just stopped
  // at a point in the past.
  async function preview(seq) {
    selectedSeq = seq
    error = ''
    // A new selection means a new default comparison; keeping the old base
    // would silently leave you comparing two points you did not choose.
    baseSeq = defaultBaseFor(seq)
    textDiff = null
    sheetDiff = null

    let replayDoc
    try {
      replayDoc = await replayAt(seq)
    } catch {
      error = 'failed to load that point'
      return
    }

    if (isSheet) {
      // The reconstructed doc stays alive: SheetPreview reads through a
      // Workbook built on it, and restore copies straight out of it.
      previewDoc?.destroy()
      previewDoc = replayDoc
    } else {
      previewText = replayDoc.getText('text').toString()
      replayDoc.destroy()
      previewView?.destroy()
      // The container is always in the DOM — hidden rather than unmounted in
      // diff mode — so this never has to cope with a null parent or remount an
      // editor on every mode switch.
      previewView = mountPreview({ parent: previewEl, content: previewText })
    }
    loaded = true
    if (mode === 'diff') computeDiff()
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
        // Patch the differences rather than replacing the text. Deleting every
        // character orphans every RelativePosition anchored into it — every
        // comment, including ones on paragraphs this restore does not touch —
        // and sends the whole document over the wire while yanking every
        // collaborator's cursor. Applied last-first so earlier offsets stay
        // valid, in one transaction so it is still one undo step.
        const ops = splices(ytext.toString(), previewText)
        ydoc.transact(() => {
          for (let i = ops.length - 1; i >= 0; i--) {
            if (ops[i].remove) ytext.delete(ops[i].at, ops[i].remove)
            if (ops[i].insert) ytext.insert(ops[i].at, ops[i].insert)
          }
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

<div class="viewbar">
  <a class="back" href="#back" title="Back to the document" aria-label="Back to the document"
     onclick={(e) => { e.preventDefault(); onBack() }}>←</a>
  <strong>{doc.title}</strong>
  <span class="label kind">history</span>
</div>

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
            <!-- Only the label goes; the underlying history is untouched,
                 which is why this is not a power the owner keeps to itself. -->
            {#if canManage(doc.role)}
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
    {:else}
      <div class="head">
        <div class="modes">
          <button class:on={mode === 'preview'} onclick={() => setMode('preview')}>Preview</button>
          <button class:on={mode === 'diff'} onclick={() => setMode('diff')}>Changes</button>
        </div>
        {#if mode === 'diff'}
          <label for="hv-base">compared with</label>
          <select
            id="hv-base"
            value={baseSeq}
            onchange={(e) => { baseSeq = Number(e.target.value); computeDiff() }}
          >
            {#each points.filter((p) => p.seq !== selectedSeq) as p (p.seq)}
              <option value={p.seq}>{p.label}</option>
            {/each}
          </select>
        {/if}
        <span class="spacer"></span>
        {#if doc.role !== 'viewer'}
          <button onclick={restore} disabled={busy}>Restore this version</button>
        {/if}
      </div>
    {/if}

    <!-- Kept in the DOM in both modes and hidden rather than unmounted: the
         preview is a live CodeMirror instance, and tearing it down on every
         mode switch would mean rebuilding it on every switch back. -->
    {#if !isSheet}
      <div bind:this={previewEl} hidden={mode !== 'preview' || !loaded}></div>
    {:else if previewDoc && mode === 'preview'}
      <!-- #key rebuilds the preview when a different point is selected,
           so no state from the previous version can leak into it. -->
      {#key selectedSeq}
        <SheetPreview ydoc={previewDoc} />
      {/key}
    {/if}

    {#if loaded && mode === 'diff'}
      {#if diffing}
        <p class="hint">Comparing…</p>
      {:else if baseSeq === null}
        <p class="hint">This is the earliest point in the history — there is nothing before it to compare against.</p>
      {:else if textDiff}
        {#if textDiff.identical}
          <p class="hint">No change between these two points.</p>
        {:else}
          <p class="stat">
            <span class="plus">+{textDiff.added}</span>
            <span class="minus">−{textDiff.removed}</span>
            {textDiff.added + textDiff.removed === 1 ? 'line' : 'lines'}
            {#if textDiff.coarse}
              <em>— too little in common to align, shown as a wholesale replacement</em>
            {/if}
          </p>
          {#each textDiff.hunks as h, i (i)}
            {#if h.skipped}
              <p class="gap">⋯ {h.skipped} unchanged {h.skipped === 1 ? 'line' : 'lines'}</p>
            {/if}
            <table class="diff">
              <tbody>
                {#each h.rows as row, j (j)}
                  <tr class={row.op}>
                    <td class="num">{row.a ?? ''}</td>
                    <td class="num">{row.b ?? ''}</td>
                    <td class="sign">{row.op === 'ins' ? '+' : row.op === 'del' ? '−' : ''}</td>
                    <td class="text">{row.text}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/each}
        {/if}
      {:else if sheetDiff}
        {#if sheetDiff.identical}
          <p class="hint">No change between these two points.</p>
        {:else}
          <p class="stat">
            {sheetDiff.cellsChanged} {sheetDiff.cellsChanged === 1 ? 'cell' : 'cells'} changed
          </p>
          {#each sheetDiff.sheets as s (s.id)}
            <h4>
              {s.name}
              {#if s.state === 'added'}<span class="tag">new sheet</span>
              {:else if s.state === 'removed'}<span class="tag">deleted sheet</span>{/if}
            </h4>
            <table class="diff cells">
              <thead>
                <tr><th>Cell</th><th>Before</th><th>After</th></tr>
              </thead>
              <tbody>
                {#each s.cells as c (c.rowId + '.' + c.colId)}
                  <tr class={c.kind === 'added' ? 'ins' : c.kind === 'removed' ? 'del' : ''}>
                    <td class="at">{c.at ?? '—'}</td>
                    <td class="text">{c.from}</td>
                    <td class="text">{c.to}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
            {#if s.cells.length < s.added + s.removed + s.changed}
              <p class="gap">⋯ only the first {s.cells.length} shown</p>
            {/if}
          {/each}
        {/if}
      {/if}
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

  /* ---- the changes view --------------------------------------------------
     Tokens throughout, and the added/removed colours come from the document
     palette rather than a fresh green and red: those are already a matched
     pair at one lightness in each scheme, so a diff reads the same way a
     coloured document does. The grounds are mixed at low percentage so the
     text on them stays --ink and never needs its own contrast decision. */
  .head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
    flex-wrap: wrap;
  }
  .head label {
    font-size: 0.8rem;
    opacity: 0.75;
  }
  .spacer {
    flex: 1;
  }
  .modes button.on {
    border-color: var(--signal);
    color: var(--signal);
  }
  .stat {
    margin: 0 0 0.4rem;
    font-size: 0.85rem;
  }
  .plus { color: var(--doc-c-green); font-weight: 600; }
  .minus { color: var(--doc-c-red); font-weight: 600; }
  .stat em { opacity: 0.7; font-style: normal; }

  .gap {
    margin: 0.35rem 0;
    font-size: 0.8rem;
    opacity: 0.55;
  }

  table.diff {
    width: 100%;
    border-collapse: collapse;
    font: 12px var(--mono);
    /* A diff is one of the few places a long line must not wrap: wrapping
       breaks the alignment that makes two versions comparable at a glance. */
    table-layout: auto;
  }
  table.diff td,
  table.diff th {
    padding: 0 0.35rem;
    vertical-align: top;
  }
  table.diff th {
    text-align: left;
    font: 600 11px var(--ui);
    opacity: 0.7;
    border-bottom: 1px solid var(--line);
  }
  /* Line numbers are scaffolding: present, countable, never competing with
     the text they index. */
  .num, .at {
    width: 1%;
    white-space: nowrap;
    text-align: right;
    color: var(--ink-3);
    user-select: none;
  }
  .sign {
    width: 1%;
    user-select: none;
    color: var(--ink-3);
  }
  .text {
    white-space: pre-wrap;
    word-break: break-word;
  }
  tr.del { background: color-mix(in srgb, var(--doc-c-red) 12%, transparent); }
  tr.ins { background: color-mix(in srgb, var(--doc-c-green) 12%, transparent); }

  /* Not full width, unlike the line diff. A line diff is one column of text
     and wants the room; this is three short columns, and stretching them puts
     "before" and "after" too far apart to compare at a glance — which is the
     only thing this table is for. */
  table.cells {
    width: auto;
    font: 12px var(--mono);
    margin-bottom: 0.6rem;
  }
  table.cells td.text {
    min-width: 8rem;
    max-width: 24rem;
  }
  h4 {
    font-size: 0.85rem;
    margin: 0.7rem 0 0.2rem;
  }
  .tag {
    font: 500 10px var(--ui);
    letter-spacing: var(--track);
    text-transform: uppercase;
    color: var(--ink-2);
    border: 1px solid var(--line);
    border-radius: var(--r);
    padding: 0 0.3rem;
  }
</style>
