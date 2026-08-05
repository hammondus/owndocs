<script>
  // The comments drawer. Deliberately knows nothing about sheets or text: the
  // parent owns the threads and supplies a `label` for where each one points,
  // so the same panel serves both document kinds.
  //
  // Writes go straight to the API and then ask the parent to refetch. The
  // server also nudges every watcher over the socket (msgComments), which will
  // refetch us a second time — harmless, and it means the panel still works if
  // that socket happens to be down.
  import {
    replyTo,
    setResolved,
    editComment,
    deleteComment,
    deleteThread,
    openThread,
  } from '../comments.js'

  let {
    docId,
    threads,
    me,
    canComment,
    isOwner,
    newAnchor, // anchor object for "comment here", or null if nothing selected
    newLabel, // human name of that place, e.g. "B4"
    label, // (thread) => string, where this thread points
    onRefresh,
    onGoTo,
    onClose,
  } = $props()

  let draft = $state('')
  let replyDraft = $state({}) // thread id -> text
  let editing = $state(null) // {cid, text} while editing one's own comment
  let busy = $state(false)
  let error = $state('')
  let showResolved = $state(false)

  // Unresolved first and newest last, so a thread reads top-to-bottom like the
  // conversation it is. Resolved ones are hidden behind a toggle rather than
  // deleted — resolving is closure, not removal.
  let open = $derived(threads.filter((t) => !t.resolved_at))
  let closed = $derived(threads.filter((t) => t.resolved_at))

  // Any API call: one place to hold the busy flag and surface the error, so no
  // handler below has to remember either.
  async function run(fn) {
    if (busy) return
    busy = true
    error = ''
    try {
      await fn()
      await onRefresh()
    } catch (e) {
      error = e.message
    }
    busy = false
  }

  function compose() {
    const body = draft.trim()
    if (!body || !newAnchor) return
    run(async () => {
      await openThread(docId, newAnchor, body)
      draft = ''
    })
  }

  function reply(t) {
    const body = (replyDraft[t.id] || '').trim()
    if (!body) return
    run(async () => {
      await replyTo(docId, t.id, body)
      replyDraft = { ...replyDraft, [t.id]: '' }
    })
  }

  function saveEdit(t, c) {
    const body = editing.text.trim()
    if (!body) return
    run(async () => {
      await editComment(docId, t.id, c.id, body)
      editing = null
    })
  }

  // Only the author may edit — an owner moderating a thread deletes it, since
  // rewriting words that stay under someone else's name is forgery.
  const mayEdit = (c) => c.author_id === me.id
  const mayDelete = (c) => c.author_id === me.id || isOwner

  const when = (ts) => new Date(ts * 1000).toLocaleString()
</script>

<div class="panel">
  <div class="head">
    <strong>Comments</strong>
    <span class="count">{open.length} open</span>
    <span class="spacer"></span>
    {#if closed.length}
      <button onclick={() => (showResolved = !showResolved)}>
        {showResolved ? 'hide' : 'show'} resolved ({closed.length})
      </button>
    {/if}
    <button onclick={onClose}>close</button>
  </div>

  {#if error}
    <p class="error">⚠ {error}</p>
  {/if}

  {#if canComment}
    <div class="compose">
      <textarea
        bind:value={draft}
        rows="2"
        placeholder={newAnchor ? `Comment on ${newLabel}…` : 'Select a cell to comment on it'}
        disabled={!newAnchor}
      ></textarea>
      <button onclick={compose} disabled={!newAnchor || !draft.trim() || busy}>
        comment on {newLabel || '—'}
      </button>
    </div>
  {/if}

  {#each [...open, ...(showResolved ? closed : [])] as t (t.id)}
    <div class="thread" class:resolved={t.resolved_at}>
      <div class="thread-head">
        <button class="where" onclick={() => onGoTo(t)} title="Go to this cell">
          {label(t)}
        </button>
        <span class="spacer"></span>
        {#if canComment}
          <button onclick={() => run(() => setResolved(docId, t.id, !t.resolved_at))}>
            {t.resolved_at ? 'reopen' : 'resolve'}
          </button>
        {/if}
        {#if t.created_by === me.id || isOwner}
          <button
            onclick={() => confirm('Delete this whole thread?') && run(() => deleteThread(docId, t.id))}
            title="Delete thread"
          >×</button>
        {/if}
      </div>

      {#if t.anchor?.quote}
        <p class="quote">“{t.anchor.quote}”</p>
      {/if}

      {#each t.comments as c (c.id)}
        <div class="comment">
          <div class="meta">
            <strong>{c.author_name}</strong>
            <span class="time">{when(c.created_at)}{c.edited_at ? ' · edited' : ''}</span>
            <span class="spacer"></span>
            {#if mayEdit(c) && !editing}
              <button onclick={() => (editing = { cid: c.id, text: c.body })}>edit</button>
            {/if}
            {#if mayDelete(c)}
              <button onclick={() => run(() => deleteComment(docId, t.id, c.id))}>delete</button>
            {/if}
          </div>
          {#if editing?.cid === c.id}
            <textarea bind:value={editing.text} rows="2"></textarea>
            <div class="row">
              <button onclick={() => saveEdit(t, c)} disabled={busy}>save</button>
              <button onclick={() => (editing = null)}>cancel</button>
            </div>
          {:else}
            <p class="body">{c.body}</p>
          {/if}
        </div>
      {/each}

      {#if canComment && !t.resolved_at}
        <div class="row">
          <input
            placeholder="Reply…"
            value={replyDraft[t.id] || ''}
            oninput={(e) => (replyDraft = { ...replyDraft, [t.id]: e.target.value })}
            onkeydown={(e) => e.key === 'Enter' && reply(t)}
          />
          <button onclick={() => reply(t)} disabled={busy}>reply</button>
        </div>
      {/if}
    </div>
  {/each}

  {#if !open.length && !(showResolved && closed.length)}
    <p class="hint">
      {canComment
        ? 'No open comments. Select a cell and write one above.'
        : 'No open comments. Your access is read-only.'}
    </p>
  {/if}
</div>

<style>
  .panel {
    border: 1px solid #d0d1d3;
    border-radius: 4px;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
    background: #fafafa;
    max-height: 40vh;
    overflow-y: auto;
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
  .count {
    font-size: 0.75rem;
    opacity: 0.7;
  }
  .compose {
    display: flex;
    gap: 0.35rem;
    align-items: flex-start;
    margin-bottom: 0.5rem;
  }
  .compose textarea {
    flex: 1;
  }
  .thread {
    border-top: 1px solid #e4e5e7;
    padding: 0.4rem 0;
  }
  .thread.resolved {
    opacity: 0.6;
  }
  .thread-head {
    display: flex;
    gap: 0.35rem;
    align-items: center;
  }
  .where {
    font-weight: 600;
    font-family: ui-monospace, monospace;
  }
  .quote {
    margin: 0.2rem 0;
    padding-left: 0.5rem;
    border-left: 3px solid #d0d1d3;
    font-size: 0.8rem;
    opacity: 0.75;
  }
  .comment {
    margin: 0.3rem 0;
  }
  .meta {
    display: flex;
    gap: 0.35rem;
    align-items: baseline;
    font-size: 0.75rem;
  }
  .time {
    opacity: 0.6;
  }
  .body {
    margin: 0.1rem 0;
    white-space: pre-wrap;
    font-size: 0.85rem;
  }
  .row {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    margin-top: 0.2rem;
  }
  .row input {
    flex: 1;
  }
  textarea {
    width: 100%;
    font: inherit;
    font-size: 0.85rem;
  }
  .hint,
  .error {
    margin: 0.3rem 0 0;
    font-size: 0.8rem;
    opacity: 0.7;
  }
  .error {
    color: #b00020;
    opacity: 1;
  }
</style>
