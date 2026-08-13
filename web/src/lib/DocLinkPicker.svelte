<script>
  // Pick a document to link to. What lands in the text is an ordinary markdown
  // link to `#doc=<id>` — see doclink.js for why that target and not a scheme
  // of our own.
  //
  // The list is /api/docs verbatim, so it can only ever offer documents this
  // person could already open. Sharing governs what is linkable, with no rule
  // of its own here — the same way it governs what the git exporter can see.
  let { docs, currentId, onPick, onClose } = $props()

  let query = $state('')

  // The document being edited is dropped rather than shown and refused. A link
  // to the document you are in is legal markdown that does nothing useful, and
  // an option that must not be chosen is worse than an absent one — the same
  // reasoning that keeps reading preferences out of the sheet view.
  let pool = $derived(docs.filter((d) => d.id !== currentId))

  let results = $derived.by(() => {
    const q = query.trim().toLowerCase()
    return q ? pool.filter((d) => d.title.toLowerCase().includes(q)) : pool
  })

  // Enter picks the first match, so a document whose name you know is a few
  // keystrokes and never needs the mouse. Matches the emoji picker.
  function onKey(e) {
    if (e.key === 'Escape') return onClose()
    if (e.key !== 'Enter' || !results.length) return
    e.preventDefault()
    onPick(results[0])
  }
</script>

<div class="panel">
  <div class="head">
    <strong>Link to document</strong>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      id="doclink-search"
      autofocus
      placeholder="search…"
      bind:value={query}
      onkeydown={onKey}
    />
    <span class="note">links to the document, not a copy</span>
    <span class="spacer"></span>
    <button onclick={onClose}>close</button>
  </div>

  <div class="list-scroll">
    {#if results.length}
      <!-- The title is the label the link gets, so it is what this shows in
           prose; kind and role are a readout beneath, exactly as in the
           document list. -->
      {#each results as d (d.id)}
        <button class="row" onclick={() => onPick(d)}>
          <span class="name">{d.title}</span>
          <span class="meta label">{d.kind} · {d.role}</span>
        </button>
      {/each}
    {:else if pool.length}
      <p class="note">Nothing called “{query}”.</p>
    {:else}
      <p class="note">
        Nothing else to link to yet — this is the only document you can open.
      </p>
    {/if}
  </div>
</div>

<style>
  /* Matches EmojiPicker and ReadingPrefs: all three are drawers that open
     under the toolbar. */
  .panel {
    border: 1px solid #8884;
    border-radius: 4px;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
    background: #8881;
  }
  .head {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    margin-bottom: 0.4rem;
  }
  .spacer {
    flex: 1;
  }
  .note {
    font-size: 0.75rem;
    opacity: 0.7;
    margin: 0.3rem 0 0;
  }
  /* Capped and scrolled for the reason the emoji grid is: a long list unrolled
     would push the editor off the bottom every time the panel opened. */
  .list-scroll {
    max-height: 16rem;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    width: 100%;
    padding: 0.3rem 0.4rem;
    border: 0;
    border-radius: 3px;
    background: none;
    cursor: pointer;
    text-align: left;
  }
  .row:hover,
  .row:focus-visible {
    background: #8883;
  }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    opacity: 0.6;
    flex: none;
  }
</style>
