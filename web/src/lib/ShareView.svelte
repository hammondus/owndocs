<script>
  // Sharing panel for a document the current user owns: the collaborator
  // list with add/remove, and capability share links. Each section loads
  // and refreshes its own data with plain async functions.
  import { onMount } from 'svelte'
  import { api } from './api.js'

  let { doc, onBack } = $props()

  let people = $state([])
  let links = $state([])
  let addEmail = $state('')
  let addRole = $state('editor')
  let error = $state('')
  // The URL of a just-minted link. Shown exactly once: the server stores
  // only a hash of the token, so this can never be displayed again.
  let newLinkURL = $state('')

  onMount(async () => {
    await Promise.all([loadPeople(), loadLinks()])
  })

  async function loadPeople() {
    people = await api(`/api/docs/${doc.id}/shares`)
  }

  async function loadLinks() {
    links = await api(`/api/docs/${doc.id}/links`)
  }

  async function addPerson(event) {
    event.preventDefault()
    try {
      await api(`/api/docs/${doc.id}/shares`, {
        method: 'POST',
        body: JSON.stringify({ email: addEmail, role: addRole }),
      })
      addEmail = ''
      error = ''
      await loadPeople()
    } catch (err) {
      error = err.message
    }
  }

  async function removePerson(person) {
    await api(`/api/docs/${doc.id}/shares/${person.user_id}`, { method: 'DELETE' })
    await loadPeople()
  }

  async function createLink(role) {
    const link = await api(`/api/docs/${doc.id}/links`, {
      method: 'POST',
      body: JSON.stringify({ role }),
    })
    newLinkURL = `${location.origin}/#share=${link.token}`
    await loadLinks()
  }

  async function revokeLink(link) {
    await api(`/api/docs/${doc.id}/links/${link.id}`, { method: 'DELETE' })
    await loadLinks()
  }

  function copyLink() {
    navigator.clipboard?.writeText(newLinkURL)
  }

  function formatDate(unixSeconds) {
    return new Date(unixSeconds * 1000).toLocaleString()
  }
</script>

<div class="viewbar">
  <a class="back" href="#back" title="Back to documents" aria-label="Back to documents"
     onclick={(e) => { e.preventDefault(); onBack() }}>←</a>
  <strong>{doc.title}</strong>
  <span class="label kind">sharing</span>
</div>

<fieldset>
  <legend>People</legend>
  <ul>
    {#each people as person (person.user_id)}
      <li>
        {person.name} &lt;{person.email}&gt; — {person.role}
        {#if person.role !== 'owner'}
          <button onclick={() => removePerson(person)}>remove</button>
        {/if}
      </li>
    {/each}
  </ul>
  <form onsubmit={addPerson}>
    <input type="email" placeholder="email of existing account" bind:value={addEmail} required />
    <select bind:value={addRole}>
      <option value="editor">editor</option>
      <option value="viewer">viewer</option>
    </select>
    <button>Add</button>
  </form>
  {#if error}
    <p class="err">{error}</p>
  {/if}
</fieldset>

<fieldset>
  <legend>Share links</legend>
  <ul>
    {#each links as link (link.id)}
      <li>
        {link.role} link, created {formatDate(link.created_at)}
        <button onclick={() => revokeLink(link)}>revoke</button>
      </li>
    {/each}
  </ul>
  <p>
    <button onclick={() => createLink('viewer')}>New viewer link</button>
    <button onclick={() => createLink('editor')}>New editor link</button>
  </p>
  {#if newLinkURL}
    <p>
      Copy it now — it is shown only once:<br />
      <input readonly size="50" value={newLinkURL} />
      <button onclick={copyLink}>copy</button>
    </p>
  {/if}
</fieldset>

<style>
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    padding: 0.15rem 0;
  }
</style>
