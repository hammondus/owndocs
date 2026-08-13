<script>
  // The document list: loads its own data, creates and deletes documents,
  // and reports "open this doc" / "share this doc" upward via callbacks.
  import { onMount } from 'svelte'
  import { api } from './api.js'
  import { canEdit } from '../roles.js'
  import ReadingPrefs from './ReadingPrefs.svelte'

  let { me, onOpen, onShare } = $props()

  let docs = $state([])
  let newTitle = $state('')
  let newKind = $state('doc')

  onMount(load)

  async function load() {
    docs = await api('/api/docs')
  }

  async function createDoc(event) {
    event.preventDefault()
    const doc = await api('/api/docs', {
      method: 'POST',
      body: JSON.stringify({ title: newTitle, kind: newKind }),
    })
    newTitle = ''
    onOpen(doc)
  }

  // ---- invites --------------------------------------------------------------
  // How a new staff member gets an account once signup is closed, which is how
  // a publicly reachable instance runs. Same shape as a share link: the token
  // comes back once, so it is shown until dismissed and never again.
  let invites = $state([])
  let showInvites = $state(false)
  let inviteNote = $state('')
  let freshLink = $state('')
  let inviteError = $state('')

  async function loadInvites() {
    try {
      invites = await api('/api/invites')
    } catch (err) {
      inviteError = err.message
    }
  }

  async function createInvite(event) {
    event.preventDefault()
    inviteError = ''
    try {
      const v = await api('/api/invites', {
        method: 'POST',
        body: JSON.stringify({ note: inviteNote }),
      })
      freshLink = `${location.origin}/#invite=${v.token}`
      inviteNote = ''
      await loadInvites()
    } catch (err) {
      inviteError = err.message
    }
  }

  async function revokeInvite(v) {
    if (!confirm(`Revoke the invite for "${v.note}"?`)) return
    await api(`/api/invites/${v.id}`, { method: 'DELETE' })
    await loadInvites()
  }

  const when = (ts) => new Date(ts * 1000).toLocaleDateString()

  // Rename in place, matching the double-click gesture used in the document
  // headers and on sheet tabs.
  let renamingId = $state(null)

  // The reading panel also lives here, not only inside a document: the
  // preference is global, and a setting reachable from exactly one screen is
  // a setting nobody finds.
  let showReading = $state(false)

  async function commitRename(event, doc) {
    const title = event.target.value.trim()
    renamingId = null
    if (!title || title === doc.title) return
    await api(`/api/docs/${doc.id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
    await load()
  }

  async function deleteDoc(doc) {
    if (!confirm(`Delete "${doc.title}"?`)) return
    await api(`/api/docs/${doc.id}`, { method: 'DELETE' })
    await load()
  }
</script>

<!-- The create field is the first thing on the screen because it is the reason
     anyone comes here with nothing open. Secondary actions sit to its right,
     quiet, in the same row. -->
<form class="create" onsubmit={createDoc}>
  <!-- bind:value keeps the input and the newTitle variable in sync both ways -->
  <input placeholder="new document title" bind:value={newTitle} />
  <select bind:value={newKind}>
    <option value="doc">doc</option>
    <option value="sheet">sheet</option>
  </select>
  <button class="primary">Create</button>
  <span class="spacer"></span>
  <button onclick={(e) => { e.preventDefault(); showInvites = !showInvites; if (showInvites) loadInvites() }}>
    {showInvites ? 'hide' : 'invite someone'}
  </button>
  <button
    onclick={(e) => { e.preventDefault(); showReading = !showReading }}
    class:pressed={showReading}
    title="How documents render for you"
  >Aa reading</button>
</form>

{#if showReading}
  <!-- No editor to re-measure from here, so onChanged has nothing to do: the
       CSS variables are already live, and any document opened later picks
       them up when it mounts. -->
  <ReadingPrefs onChanged={() => {}} onClose={() => (showReading = false)} />
{/if}

{#if showInvites}
  <fieldset>
    <legend>Invites</legend>
    <form onsubmit={createInvite}>
      <input placeholder="who is this for?" bind:value={inviteNote} required />
      <button>Create invite link</button>
    </form>
    {#if freshLink}
      <!-- Shown once. Only the hash is stored, so this cannot be produced
           again — a lost link is revoked and reissued. -->
      <p class="fresh">
        <input readonly value={freshLink} onfocus={(e) => e.target.select()} />
        <button onclick={() => (freshLink = '')}>done</button>
      </p>
    {/if}
    {#if inviteError}<p class="err">{inviteError}</p>{/if}
    <ul>
      {#each invites as v (v.id)}
        <li>
          <strong>{v.note}</strong>
          {#if v.used_at}
            <span class="kind">used {when(v.used_at)}</span>
          {:else if v.expires_at * 1000 < Date.now()}
            <span class="kind">expired</span>
          {:else}
            <span class="kind">expires {when(v.expires_at)}</span>
            <button onclick={() => revokeInvite(v)}>revoke</button>
          {/if}
        </li>
      {/each}
    </ul>
  </fieldset>
{/if}

<div class="section">
  <span class="label">Documents</span>
  <span class="readout">{docs.length}</span>
</div>

<ul>
  <!-- The (doc.id) key tells Svelte which <li> belongs to which doc when
       the list changes, so rows are moved rather than rebuilt. -->
  {#each docs as doc (doc.id)}
    <li>
      {#if renamingId === doc.id}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="rename"
          autofocus
          value={doc.title}
          onblur={(e) => commitRename(e, doc)}
          onkeydown={(e) => {
            if (e.key === 'Enter') e.target.blur()
            if (e.key === 'Escape') renamingId = null
          }}
        />
      {:else}
        <div class="name">
          <a
            href={'#doc=' + doc.id}
            title="Double-click to rename"
            onclick={(e) => { e.preventDefault(); onOpen(doc) }}
            ondblclick={(e) => { e.preventDefault(); if (canEdit(doc.role)) renamingId = doc.id }}
          >{doc.title}</a>
          <!-- Kind and role are what the machine knows about this row, so they
               are a readout, under the name rather than beside it. -->
          <span class="meta label">{doc.kind} · {doc.role}</span>
          <!-- Unresolved threads, counted by the list query rather than one
               request per row. Shown only when there are some: a "0" beside
               every document is noise that trains people to stop reading it. -->
          {#if doc.open_comments}
            <span class="meta label open">{doc.open_comments} unresolved</span>
          {/if}
        </div>
      {/if}
      {#if doc.role === 'owner'}
        <!-- Quiet until the row is under the pointer or holds focus. They are
             still in the tab order and still announced; what changes is how
             loudly a list of twenty rows shouts at you. -->
        <span class="actions">
          <button onclick={() => onShare(doc)}>share</button>
          <button class="danger" onclick={() => deleteDoc(doc)}>delete</button>
        </span>
      {/if}
    </li>
  {/each}
  {#if !docs.length}
    <li class="empty">Nothing here yet. Name one above and it opens straight away.</li>
  {/if}
</ul>

<style>
  /* Component-scoped: these rules only apply to elements in THIS file.
     Svelte adds a hash class to both the elements and the selectors. */
  .create {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .create input { flex: 0 1 22rem; }
  .create .spacer { flex: 1; }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--r);
    background: var(--surface);
    overflow: hidden;
  }
  li {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 9px 12px;
    /* The caret rule: transparent until the row is live, so a hover does not
       shift anything sideways. */
    border-left: 2px solid transparent;
  }
  li + li { border-top: 1px solid var(--line); }
  li:hover { background: var(--surface-2); border-left-color: var(--signal); }
  li:focus-within { border-left-color: var(--signal); }

  .name { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
  .name a {
    color: var(--ink);
    font-size: var(--t-title);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  li:hover .name a { color: var(--signal); }
  .meta { text-transform: uppercase; }
  .rename { flex: 1; font-size: var(--t-title); }

  .actions { display: flex; gap: 2px; opacity: 0; transition: opacity .12s; }
  li:hover .actions, li:focus-within .actions { opacity: 1; }
  /* Never hidden from the keyboard: a focused control inside a "hidden" group
     brings the whole group back. */
  @media (hover: none) {
    .actions { opacity: 1; }
  }

  .empty {
    color: var(--ink-3);
    font-size: var(--t-base);
    padding: 18px 12px;
  }
  /* The caret rule again: an unresolved thread is something live on that
     document, which is exactly what the signal colour means. */
  .open { color: var(--signal); }
</style>
