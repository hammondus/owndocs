<script>
  // The inbox: mentions, and replies to threads you are in.
  //
  // It quotes the comment body, and that is the most it can ever say. What the
  // comment is *about* lives inside the opaque anchor, which the server never
  // reads — so this can say "Alice said: this seems wrong" and cannot say what
  // it was said about. That is the content-blind design working, and it makes
  // the inbox a pointer into a document rather than a substitute for opening
  // one. See DESIGN-DECISIONS, *Notifications*.
  let { items, onOpen, onMarkAll, onClose } = $props()

  let unread = $derived(items.filter((n) => !n.read_at).length)

  // Coarse on purpose: the exact minute of a mention is never the question,
  // and a live-updating relative clock is a timer nobody asked for.
  function when(ts) {
    const days = Math.floor((Date.now() / 1000 - ts) / 86400)
    if (days > 1) return `${days} days ago`
    const hours = Math.floor((Date.now() / 1000 - ts) / 3600)
    if (hours >= 1) return hours === 1 ? 'an hour ago' : `${hours} hours ago`
    return 'just now'
  }

  const summary = (n) => (n.kind === 'mention' ? 'mentioned you in' : 'replied in')
</script>

<div class="panel">
  <div class="head">
    <strong>Inbox</strong>
    <span class="note">mentions, and replies to threads you are in</span>
    <span class="spacer"></span>
    {#if unread}
      <button onclick={onMarkAll}>mark all read</button>
    {/if}
    <button onclick={onClose}>close</button>
  </div>

  {#if items.length}
    <div class="list-scroll">
      {#each items as n (n.id)}
        <!-- The whole row opens the document, because there is nothing else
             one would want to do with it. Unread is marked with the caret rule
             — the same 2px bar that means "this is the live one" everywhere
             else in this interface. -->
        <button class="row" class:unread={!n.read_at} onclick={() => onOpen(n)}>
          <span class="line">
            <strong>{n.actor}</strong>
            <span class="what">{summary(n)}</span>
            <strong>{n.doc_title}</strong>
          </span>
          <span class="meta label">{when(n.created_at)}</span>
          <span class="body">{n.body}</span>
        </button>
      {/each}
    </div>
  {:else}
    <p class="note empty">
      Nothing yet. You will hear about it here when somebody names you in a
      comment, or replies to a thread you are in.
    </p>
  {/if}
</div>

<style>
  /* Matches the other drawers: EmojiPicker, DocLinkPicker, FormatPanel. */
  .panel {
    border: 1px solid #8884;
    border-radius: 4px;
    padding: 0.5rem;
    margin-bottom: 0.75rem;
    background: #8881;
  }
  .head {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    margin-bottom: 0.4rem;
  }
  .spacer { flex: 1; }
  .note {
    font-size: 0.75rem;
    opacity: 0.7;
  }
  .empty { margin: 0.4rem 0 0.2rem; }
  .list-scroll {
    max-height: 18rem;
    overflow-y: auto;
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
  }
  .row:hover,
  .row:focus-visible { background: #8882; }
  .row.unread { border-left-color: var(--signal); }
  .line {
    grid-area: line;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .what { opacity: 0.7; }
  .meta { grid-area: meta; opacity: 0.6; white-space: nowrap; }
  /* One line, clipped: the body is here to identify the comment, not to be
     read instead of opening it. */
  .body {
    grid-area: body;
    opacity: 0.85;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
