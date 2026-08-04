<script>
  // The document list: loads its own data, creates and deletes documents,
  // and reports "open this doc" / "share this doc" upward via callbacks.
  import { onMount } from 'svelte'
  import { api } from './api.js'

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
      <a href={'#doc=' + doc.id} onclick={(e) => { e.preventDefault(); onOpen(doc) }}>{doc.title}</a>
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
