<script>
  // The document list: loads its own data, creates and deletes documents and
  // folders, and reports "open this doc" / "share this doc" / "share this
  // folder" upward via callbacks.
  //
  // Two views over the same two fetches. **Recent** is the flat list this
  // screen has always been, newest first, and it stays the default: recency is
  // how people actually find the thing they were working on this morning.
  // **Folders** is the tree, for when you are filing rather than resuming.
  // Neither is a different query — the server sends folders and documents, and
  // folders.js arranges them.
  import { onMount, tick, untrack } from 'svelte'
  // A Set whose *contents* are reactive. A plain Set is tracked by reference,
  // so `collapsed.add(id)` would change nothing on screen — the class of bug
  // that presents as a dead control rather than an error.
  import { SvelteSet } from 'svelte/reactivity'
  import { api } from './api.js'
  import { canEdit } from '../roles.js'
  import { buildTree, pickerOptions, pathTo } from '../folders.js'
  import ReadingPrefs from './ReadingPrefs.svelte'
  import FolderTree from './FolderTree.svelte'
  import DocRow from './DocRow.svelte'

  // focusFolder is a folder id to arrive on: the breadcrumb, a search hit and
  // a mail link all open the list this way. It switches to the tree, opens
  // every folder above it, and scrolls it into view. Null means the ordinary
  // list, which is what the back arrow and the wordmark give.
  let { me, focusFolder = null, onOpen, onShare, onShareFolder } = $props()

  let docs = $state([])
  let folders = $state([])
  let newTitle = $state('')
  let newKind = $state('doc')
  let newFolder = $state('') // where Create files it; '' is no folder
  let view = $state('recent')
  let error = $state('')

  // Which folders are folded shut, by id. The closed ones rather than the open
  // ones, so a folder created or newly shared with you arrives open.
  let collapsed = new SvelteSet()

  const tree = $derived(buildTree(folders, docs))
  const destinations = $derived(pickerOptions(tree.roots, canEdit))

  let loaded = $state(false)

  onMount(async () => {
    await load()
    loaded = true
  })

  // An effect rather than a one-off in onMount, because the list stays mounted
  // when a search hit lands on a folder from the list itself: only the prop
  // changes. Untracked inside so a reload of the folders — after a rename,
  // say — does not scroll the page back to the folder again.
  $effect(() => {
    const id = focusFolder
    if (loaded && id) untrack(() => showFolder(id))
  })

  async function load() {
    // One round trip each, in parallel: the tree needs both and neither
    // depends on the other.
    const [d, f] = await Promise.all([api('/api/docs'), api('/api/folders')])
    docs = d
    folders = f
  }

  // Opening every folder above the target is deleting from the closed set,
  // and the scroll waits a tick so the rows exist to scroll to. A folder the
  // viewer cannot see has no path, no row, and nothing happens — the list is
  // still the list.
  async function showFolder(id) {
    view = 'folders'
    for (const f of pathTo(folders, id)) collapsed.delete(f.id)
    await tick()
    document.querySelector(`[data-folder="${id}"]`)?.scrollIntoView({ block: 'center' })
  }

  async function createDoc(event) {
    event.preventDefault()
    const body = { title: newTitle, kind: newKind }
    if (newFolder) body.folder_id = newFolder
    const doc = await api('/api/docs', { method: 'POST', body: JSON.stringify(body) })
    newTitle = ''
    onOpen(doc)
  }

  // ---- folders --------------------------------------------------------------

  // An inline input, like every other name in this app — the document title,
  // the sheet tab, the folder rename. A `prompt()` would have been three lines
  // and is a modal the rest of the app never uses, so it reads as somebody
  // else's screen; it also blocks the browser, which puts it out of reach of
  // ui_test.mjs, and this is a new recursive component that most needs driving
  // through the real screen.
  let addingRoot = $state(false)

  async function createFolder(parentID, name) {
    if (!name || !name.trim()) return
    try {
      await api('/api/folders', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), parent_id: parentID }),
      })
      error = ''
      await load()
    } catch (err) {
      error = err.message
    }
  }

  // Committing the root-level input. Blur commits and Escape abandons, the
  // same two keys the rename inputs use.
  async function commitNewRoot(event) {
    const name = event.target.value
    addingRoot = false
    await createFolder(null, name)
  }

  async function renameFolder(node, name) {
    try {
      await api(`/api/folders/${node.id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
      error = ''
      await load()
    } catch (err) {
      error = err.message
    }
  }

  async function deleteFolder(node) {
    if (!confirm(`Delete the folder "${node.name}"?`)) return
    try {
      await api(`/api/folders/${node.id}`, { method: 'DELETE' })
      error = ''
      await load()
    } catch (err) {
      // The refusal worth showing rather than swallowing: the folder is not
      // empty. Deleting a folder never deletes documents, because a folder's
      // managers are not its documents' owners.
      error = err.message
    }
  }

  function toggle(id) {
    if (collapsed.has(id)) collapsed.delete(id)
    else collapsed.add(id)
  }

  // ---- documents ------------------------------------------------------------

  let movingId = $state(null)

  async function renameDoc(doc, title) {
    await api(`/api/docs/${doc.id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
    await load()
  }

  async function deleteDoc(doc) {
    if (!confirm(`Delete "${doc.title}"?`)) return
    await api(`/api/docs/${doc.id}`, { method: 'DELETE' })
    await load()
  }

  async function moveDoc(doc, folderID) {
    movingId = null
    try {
      await api(`/api/docs/${doc.id}/move`, {
        method: 'POST',
        body: JSON.stringify({ folder_id: folderID }),
      })
      error = ''
      await load()
    } catch (err) {
      // Two refusals reach here and both are worth reading: the destination is
      // one you may not file into, or the move would take away your own access
      // to the document.
      error = err.message
    }
  }

  const docActions = $derived({
    open: onOpen,
    share: onShare,
    rename: renameDoc,
    remove: deleteDoc,
    moveOptions: destinations,
    movingId,
    moveStart: (doc) => (movingId = doc.id),
    moveCancel: () => (movingId = null),
    moveTo: moveDoc,
  })

  const folderActions = {
    rename: renameFolder,
    remove: deleteFolder,
    share: (node) => onShareFolder(node),
    addChild: (node, name) => createFolder(node.id, name),
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

  // The reading panel also lives here, not only inside a document: the
  // preference is global, and a setting reachable from exactly one screen is
  // a setting nobody finds.
  let showReading = $state(false)
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
  {#if destinations.length}
    <!-- Only offered once there is somewhere to file it. A picker whose only
         entry is "nowhere" is a control that teaches nothing. -->
    <select bind:value={newFolder} title="Which folder to create it in">
      <option value="">no folder</option>
      {#each destinations as opt (opt.id)}
        <option value={opt.id}>{opt.label}</option>
      {/each}
    </select>
  {/if}
  <button class="primary">Create</button>
  <span class="spacer"></span>
  <button onclick={(e) => { e.preventDefault(); view = 'folders'; addingRoot = true }}>new folder</button>
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
    <ul class="plain">
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
  <span class="spacer"></span>
  <span class="views">
    <button class:pressed={view === 'recent'} onclick={() => (view = 'recent')}>recent</button>
    <button class:pressed={view === 'folders'} onclick={() => (view = 'folders')}>folders</button>
  </span>
</div>

{#if error}<p class="err">{error}</p>{/if}

<ul class="list">
  {#if view === 'recent'}
    <!-- The (doc.id) key tells Svelte which row belongs to which doc when
         the list changes, so rows are moved rather than rebuilt. -->
    {#each docs as doc (doc.id)}
      <DocRow
        {doc}
        onOpen={docActions.open}
        onShare={docActions.share}
        onRenamed={docActions.rename}
        onDelete={docActions.remove}
        moveOptions={docActions.moveOptions}
        moving={movingId === doc.id}
        onMoveStart={docActions.moveStart}
        onMoveCancel={docActions.moveCancel}
        onMoveTo={docActions.moveTo}
      />
    {/each}
  {:else}
    {#if addingRoot}
      <li class="adding">
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="new-folder"
          autofocus
          placeholder="folder name"
          onblur={commitNewRoot}
          onkeydown={(e) => {
            if (e.key === 'Enter') e.target.blur()
            if (e.key === 'Escape') { e.target.value = ''; e.target.blur() }
          }}
        />
      </li>
    {/if}
    {#each tree.roots as node (node.id)}
      <FolderTree {node} {collapsed} focus={focusFolder} onToggle={toggle} {folderActions} {docActions} />
    {/each}
    {#if tree.unfiled.length}
      <li class="unfiled">
        <span class="label">Unfiled</span>
        <span class="readout">{tree.unfiled.length}</span>
      </li>
      {#each tree.unfiled as doc (doc.id)}
        <DocRow
          {doc}
          onOpen={docActions.open}
          onShare={docActions.share}
          onRenamed={docActions.rename}
          onDelete={docActions.remove}
          moveOptions={docActions.moveOptions}
          moving={movingId === doc.id}
          onMoveStart={docActions.moveStart}
          onMoveCancel={docActions.moveCancel}
          onMoveTo={docActions.moveTo}
        />
      {/each}
    {/if}
  {/if}
  {#if !docs.length && !folders.length}
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
    flex-wrap: wrap;
  }
  .create input { flex: 0 1 22rem; }
  .create .spacer { flex: 1; }

  .section { display: flex; gap: 8px; align-items: baseline; }
  .section .spacer { flex: 1; }
  .views { display: flex; gap: 2px; }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--r);
    background: var(--surface);
    overflow: hidden;
  }
  ul.plain { list-style: none; margin: 0; padding: 0; }

  .adding { padding: 9px 12px; }
  .adding input { width: 18rem; }

  .unfiled {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 7px 12px;
    background: var(--surface-2);
  }

  .empty {
    color: var(--ink-3);
    font-size: var(--t-base);
    padding: 18px 12px;
  }
  .err { color: var(--danger, crimson); font-size: var(--t-base); }
</style>
