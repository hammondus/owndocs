<script>
  // Sharing panel for a document the current user owns: the collaborator
  // list with add/remove, and capability share links. Each section loads
  // and refreshes its own data with plain async functions.
  import { onMount } from 'svelte'
  import { api } from './api.js'

  let { doc, onBack } = $props()

  // The three grantable roles. `owner` is absent because it is not a thing to
  // hand out — the server refuses it on both endpoints — and the list is
  // shared by the person picker and the link buttons so the two can never
  // offer different sets, which is exactly how `commenter` came to work
  // everywhere except here.
  const ROLES = [
    { value: 'editor', can: 'can change the document' },
    { value: 'commenter', can: 'can comment, but not change it' },
    { value: 'viewer', can: 'can read it' },
  ]

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
    <!-- Ordered by what each role can do, most to least, which is also
         `roleRank`'s order. Each says what it grants rather than only naming
         itself: "commenter" is the one nobody guesses, and the difference
         between commenting and editing is the whole reason the role exists. -->
    <select bind:value={addRole}>
      {#each ROLES as r (r.value)}
        <option value={r.value}>{r.value} — {r.can}</option>
      {/each}
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
    {#each ROLES as r (r.value)}
      <button onclick={() => createLink(r.value)}>New {r.value} link</button>
    {/each}
  </p>
  <p class="note">
    Anyone with the link gets that role, without an account of their own being
    named — so a commenter link is the one to hand out when you want remarks
    back but not edits.
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
  .note {
    font-size: 0.8rem;
    opacity: 0.75;
    max-width: 40rem;
  }
</style>
