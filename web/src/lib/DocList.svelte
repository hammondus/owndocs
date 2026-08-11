<script>
  // The document list: loads its own data, creates and deletes documents,
  // and reports "open this doc" / "share this doc" upward via callbacks.
  import { onMount } from 'svelte'
  import { api } from './api.js'
  import { canEdit } from '../roles.js'
  import ReadingPrefs from './ReadingPrefs.svelte'

  let { me, onOpen, onShare, onSignOut } = $props()

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

<p>
  Signed in as {me.name} &lt;{me.email}&gt; —
  <a href="#signout" onclick={(e) => { e.preventDefault(); onSignOut() }}>sign out</a>
</p>

<p>
  <button onclick={() => { showInvites = !showInvites; if (showInvites) loadInvites() }}>
    {showInvites ? 'hide' : 'invite someone'}
  </button>
  <button onclick={() => (showReading = !showReading)} title="How documents render for you">
    Aa reading
  </button>
</p>

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

<form onsubmit={createDoc}>
  <!-- bind:value keeps the input and the newTitle variable in sync both ways -->
  <input placeholder="new document title" bind:value={newTitle} />
  <select bind:value={newKind}>
    <option value="doc">doc</option>
    <option value="sheet">sheet</option>
  </select>
  <button>Create</button>
</form>

<ul>
  <!-- The (doc.id) key tells Svelte which <li> belongs to which doc when
       the list changes, so rows are moved rather than rebuilt. -->
  {#each docs as doc (doc.id)}
    <li>
      {#if renamingId === doc.id}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          value={doc.title}
          onblur={(e) => commitRename(e, doc)}
          onkeydown={(e) => {
            if (e.key === 'Enter') e.target.blur()
            if (e.key === 'Escape') renamingId = null
          }}
        />
      {:else}
        <a
          href={'#doc=' + doc.id}
          title="Double-click to rename"
          onclick={(e) => { e.preventDefault(); onOpen(doc) }}
          ondblclick={(e) => { e.preventDefault(); if (canEdit(doc.role)) renamingId = doc.id }}
        >{doc.title}</a>
      {/if}
      <span class="kind">{doc.kind}</span>
      {doc.role}
      {#if doc.role === 'owner'}
        <button onclick={() => onShare(doc)}>share</button>
        <button onclick={() => deleteDoc(doc)}>delete</button>
      {/if}
    </li>
  {/each}
</ul>

<style>
  /* Component-scoped: these rules only apply to elements in THIS file.
     Svelte adds a hash class to both the elements and the selectors. */
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.25rem 0;
  }
  li a {
    flex: 1;
  }
  .kind {
    font-size: 0.75rem;
    opacity: 0.6;
    border: 1px solid currentColor;
    border-radius: 3px;
    padding: 0 4px;
  }
</style>
