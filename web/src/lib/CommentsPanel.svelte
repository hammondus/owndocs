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
  import { api } from './api.js'

  let {
    docId,
    threads,
    me,
    canComment,
    // Moderation — deleting somebody else's comment or thread. A manager
    // power rather than an owner one: it leaves the document untouched.
    canModerate,
    makeAnchor, // () => anchor for "comment here"; called at submit, not before,
    // because for a sheet it may have to materialise the cell first
    canAnchor, // whether this spot can take a new thread at all
    anchorNote, // why not, when it cannot
    newLabel, // human name of that place, e.g. "B4"
    label, // (thread) => string, where this thread points
    onRefresh,
    onGoTo,
    onClose,
  } = $props()

  // ---- mentions -------------------------------------------------------------
  // Who this document can name. `/api/docs/{id}/shares` is viewer-level, so
  // every collaborator may read it — which is also the rule the server applies
  // when it resolves a mention: a mention can only ever name someone who could
  // already read the comment.
  //
  // Chips rather than a typeahead. A dropdown anchored to a caret in a textarea
  // is caret arithmetic, positioning and a keyboard model, and the list here is
  // a handful of names — so the cheaper control is also the clearer one. Names
  // contain spaces, which a typed `@` cannot delimit but a click can.
  let people = $state([])

  $effect(() => {
    let live = true
    api(`/api/docs/${docId}/shares`)
      .then((rows) => { if (live) people = rows })
      // Not fatal: mentions still work typed by hand, and the panel is whole
      // without the chips.
      .catch((e) => console.warn('docs: could not load who can be mentioned', e))
    return () => { live = false }
  })

  // Appended rather than inserted at the caret, for the same reason: no caret
  // arithmetic. A trailing space so the next word does not join the name.
  function mention(name) {
    draft = `${draft.trimEnd()} @${name} `.trimStart()
    document.querySelector('.compose textarea')?.focus()
  }

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
    if (!body) return
    const anchor = makeAnchor()
    if (!anchor) {
      error = 'could not anchor a comment there'
      return
    }
    run(async () => {
      await openThread(docId, anchor, body)
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

  // Only the author may edit — a moderator dealing with a thread deletes it,
  // since rewriting words that stay under someone else's name is forgery.
  const mayEdit = (c) => c.author_id === me.id
  const mayDelete = (c) => c.author_id === me.id || canModerate

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
        placeholder={canAnchor ? `Comment on ${newLabel}…` : anchorNote}
        disabled={!canAnchor}
      ></textarea>
      <!-- Names what will happen, and never says "comment on nothing": with no
           selection there is nothing to name, so the button just says what it
           is. The placeholder in the disabled box already explains why. -->
      <button onclick={compose} disabled={!canAnchor || !draft.trim() || busy}>
        {canAnchor ? `Comment on ${newLabel}` : 'Comment'}
      </button>
    </div>
    <!-- Only the people this document is shared with, and only when there is
         somebody other than you to name. -->
    {#if people.length > 1}
      <div class="mentions">
        <span class="label">mention</span>
        {#each people.filter((p) => p.user_id !== me.id) as p (p.user_id)}
          <button class="chip" onclick={() => mention(p.name)}>{p.name}</button>
        {/each}
      </div>
    {/if}
  {/if}

  {#each [...open, ...(showResolved ? closed : [])] as t (t.id)}
    <div class="thread" class:resolved={t.resolved_at}>
      <div class="thread-head">
        <button class="where" onclick={() => onGoTo(t)} title="Go to what this points at">
          {label(t)}
        </button>
        <span class="spacer"></span>
        {#if canComment}
          <button onclick={() => run(() => setResolved(docId, t.id, !t.resolved_at))}>
            {t.resolved_at ? 'reopen' : 'resolve'}
          </button>
        {/if}
        {#if t.created_by === me.id || canModerate}
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
    <!-- An empty screen is an invitation to act, not a place to repeat the
         composer's own instructions — which is what it did: "Select some text
         to comment on it." rendered here, in the placeholder, AND under the
         box, three times on one panel. -->
    <p class="hint">
      {!canComment ? 'No comments. Your access is read-only.' : 'No comments yet.'}
    </p>
  {/if}
</div>

<style>
  /* Tokens, not hex: pinned light values here left the panel a white card in a
     dark application. The greys below with an alpha channel (#8884 and the
     like) are deliberate and stay — a neutral at low opacity reads correctly
     against either ground, which is the whole reason they were written that
     way. */
  .panel {
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
    background: var(--surface-2);
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
  .mentions {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.3rem;
    margin: 0.3rem 0 0.6rem;
  }
  .chip {
    border: 1px solid #8884;
    border-radius: 999px;
    background: none;
    cursor: pointer;
    padding: 0.05rem 0.5rem;
    font: inherit;
    font-size: 0.78rem;
  }
  .chip:hover { background: #8882; }

  .compose textarea {
    flex: 1;
  }
  .thread {
    border-top: 1px solid var(--line);
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
    border-left: 3px solid var(--line-strong);
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
    color: var(--danger);
    opacity: 1;
  }
</style>
