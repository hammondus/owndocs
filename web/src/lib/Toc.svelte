<script>
  // Contents, built from the headings already in the document. Nothing here is
  // stored anywhere: the markdown says what its headings are, and this reads
  // them back — which is why it needs no anchors, no ids, and no migration.
  //
  // A <nav> of buttons rather than links: these are positions in a CodeMirror
  // document, not URLs, and an <a href="#…"> would put a fragment in the
  // location bar that the router owns.
  let { headings, active, onGo } = $props()

  // Indent by level *relative to the shallowest heading present*, so a document
  // whose top level is H2 does not sit in a permanent left margin waiting for
  // an H1 that never comes.
  let base = $derived(headings.length ? Math.min(...headings.map((h) => h.level)) : 1)
</script>

<nav class="toc" aria-label="Table of contents">
  <div class="head">Contents</div>
  <ol>
    {#each headings as h, i (h.pos)}
      <li>
        <button
          class:active={i === active}
          style="padding-left: {(h.level - base) * 0.75 + 0.35}rem"
          title={h.text}
          onclick={() => onGo(h.pos)}
        >{h.text}</button>
      </li>
    {/each}
  </ol>
</nav>

<style>
  .toc {
    /* Sticks while the document scrolls past it, and scrolls internally once
       the headings outrun the window rather than pushing the page taller. */
    position: sticky;
    top: 0.5rem;
    max-height: calc(100vh - 4rem);
    overflow-y: auto;
    font-size: 0.85rem;
    line-height: 1.35;
  }
  .head {
    font-weight: 600;
    opacity: 0.6;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0 0.35rem 0.35rem;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  button {
    display: block;
    width: 100%;
    margin: 0;
    padding: 0.15rem 0.35rem;
    border: 0;
    border-left: 2px solid transparent;
    border-radius: 0;
    background: none;
    font: inherit;
    text-align: left;
    color: inherit;
    opacity: 0.8;
    cursor: pointer;
    /* One line each. A heading long enough to wrap would turn the contents
       into a second copy of the document. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  button:hover {
    background: #8882;
    opacity: 1;
  }
  button.active {
    border-left-color: #4a8fdd;
    opacity: 1;
    font-weight: 600;
  }
</style>
