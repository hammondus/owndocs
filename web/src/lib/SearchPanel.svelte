<script>
  // Search results: documents whose text a client has indexed, and comments,
  // which the server has always held in the clear. See DESIGN-DECISIONS,
  // *Search*.
  //
  // Two lists rather than one ranked list, because FTS5 `rank` is not
  // comparable across two tables — merging them would mean inventing a score,
  // and an invented score is a ranking nobody can explain when it puts the
  // wrong thing first.
  let { q, results, searching, onQuery, onOpenDoc, onOpenComment, onClose } = $props()

  const hits = $derived((results.documents?.length ?? 0) + (results.comments?.length ?? 0))

  // The snippet arrives as plain text with control characters around the
  // matched terms — deliberately NOT markup. Splitting on them and rendering
  // real elements keeps the body on Svelte's normal escaping path; handing
  // the server's string to {@html} would make a comment body an XSS payload.
  // Must match hlStart/hlEnd in search.go.
  const HL_START = '\u0002'
  const HL_END = '\u0003'

  function pieces(snippet) {
    const out = []
    for (const chunk of (snippet ?? '').split(HL_START)) {
      const [hit, ...rest] = chunk.split(HL_END)
      if (rest.length) {
        out.push({ hit: true, text: hit })
        out.push({ hit: false, text: rest.join(HL_END) })
      } else {
        out.push({ hit: false, text: hit })
      }
    }
    return out.filter((p) => p.text !== '')
  }
</script>

<div class="panel">
  <div class="head">
    <strong>Search</strong>
    <input
      class="q"
      type="search"
      placeholder="documents and comments"
      value={q}
      oninput={(e) => onQuery(e.currentTarget.value)}
    />
    <span class="spacer"></span>
    <button onclick={onClose}>close</button>
  </div>

  {#if q.trim() === ''}
    <p class="note empty">
      Documents are searchable once somebody has opened them, and comments
      always are.
    </p>
  {:else if searching}
    <p class="note empty">Searching…</p>
  {:else if hits === 0}
    <p class="note empty">
      Nothing for “{q}”. A document nobody has opened since search arrived is
      not indexed yet — opening it is what indexes it.
    </p>
  {:else}
    <div class="list-scroll">
      {#if results.documents?.length}
        <div class="group label">In documents</div>
        {#each results.documents as d (d.doc_id)}
          <button class="row" onclick={() => onOpenDoc(d)}>
            <span class="line"><strong>{d.title}</strong></span>
            <span class="meta label">{d.kind}</span>
            <span class="body">
              {#each pieces(d.snippet) as p}{#if p.hit}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}
            </span>
          </button>
        {/each}
      {/if}

      {#if results.comments?.length}
        <div class="group label">In comments</div>
        {#each results.comments as c (c.comment_id)}
          <button class="row" class:resolved={c.resolved} onclick={() => onOpenComment(c)}>
            <span class="line">
              <strong>{c.author}</strong>
              <span class="what">in</span>
              <strong>{c.title}</strong>
              {#if c.resolved}<span class="what">· resolved</span>{/if}
            </span>
            <span class="meta label">{c.kind}</span>
            <span class="body">
              {#each pieces(c.snippet) as p}{#if p.hit}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}
            </span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Matches the other drawers: NotificationsPanel, EmojiPicker, FormatPanel. */
  .panel {
    border: 1px solid #8884;
    border-radius: 4px;
    padding: 0.5rem;
    margin-bottom: 0.75rem;
    background: #8881;
  }
  .head {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.4rem;
  }
  .q {
    flex: 1;
    max-width: 22rem;
    font: inherit;
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--line-strong);
    border-radius: 3px;
    background: var(--surface);
    color: var(--ink);
  }
  .q:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
  .spacer { flex: 1; }
  .note { font-size: 0.75rem; opacity: 0.7; }
  .empty { margin: 0.4rem 0 0.2rem; }
  .list-scroll { max-height: 22rem; overflow-y: auto; }
  .group {
    padding: 0.4rem 0.5rem 0.2rem;
    opacity: 0.6;
  }
  .row {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-areas: "line meta" "body body";
    gap: 0 0.5rem;
    width: 100%;
    padding: 0.35rem 0.5rem;
    border: 0;
    border-left: 2px solid transparent;
    background: none;
    cursor: pointer;
    text-align: left;
    color: inherit;
  }
  .row:hover,
  .row:focus-visible { background: #8882; border-left-color: var(--signal); }
  .row.resolved { opacity: 0.6; }
  .line {
    grid-area: line;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .what { opacity: 0.7; }
  .meta { grid-area: meta; opacity: 0.6; white-space: nowrap; }
  /* Two lines at most: a snippet identifies the hit, it is not the document. */
  .body {
    grid-area: body;
    opacity: 0.85;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  mark {
    background: var(--signal-soft);
    color: inherit;
    border-radius: 2px;
  }
</style>
