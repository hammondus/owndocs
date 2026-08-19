<script>
  // Sharing panel for a document the current user manages: the collaborator
  // list with add/remove, capability share links, and — for the owner alone —
  // handing the document over. Each section loads and refreshes its own data
  // with plain async functions.
  import { onMount } from 'svelte'
  import { api } from './api.js'
  import { rankOf } from '../roles.js'

  let { doc, onBack } = $props()

  // The grantable roles, in `roleRank` order, most to least. `owner` is absent
  // because it is not a thing to hand out: there is exactly one and it moves
  // only through transfer, which demotes the outgoing owner in the same
  // transaction.
  //
  // One list, read by both the person picker and the link buttons, so the two
  // can never offer different sets — which is exactly how `commenter` came to
  // work everywhere except here. What differs between them is not the list but
  // the *filter*: `link: false` marks a role no bearer token may carry.
  const ROLES = [
    { value: 'manager', can: 'can share and administer it, but not delete it', link: false },
    { value: 'editor', can: 'can change the document', link: true },
    { value: 'commenter', can: 'can comment, but not change it', link: true },
    { value: 'viewer', can: 'can read it', link: true },
  ]

  const LINK_ROLES = ROLES.filter((r) => r.link)

  const isOwner = $derived(doc.role === 'owner')

  // Who this person may act on, mirroring mayModify on the server: strictly
  // below their own rank. The server is what enforces it; hiding the button
  // keeps the panel from offering an action that would only 403.
  const mayModify = (person) => rankOf(doc.role) > rankOf(person.role)

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
    try {
      await api(`/api/docs/${doc.id}/shares/${person.user_id}`, { method: 'DELETE' })
      error = ''
    } catch (err) {
      error = err.message
    }
    await loadPeople()
  }

  // Handing the document over. The confirm names the person because this is the
  // one action its own actor cannot undo: afterwards you are a manager, and a
  // manager cannot transfer. See DESIGN-DECISIONS.md.
  async function transfer(person) {
    if (!confirm(
      `Make ${person.name} <${person.email}> the owner of "${doc.title}"?\n\n` +
      `You become a manager: you keep sharing and administration, but you ` +
      `cannot delete the document or take ownership back. Only ${person.name} can.`
    )) return
    try {
      await api(`/api/docs/${doc.id}/transfer`, {
        method: 'POST',
        body: JSON.stringify({ user_id: person.user_id }),
      })
      error = ''
      // The caller's own role changed, so the panel is now showing a role the
      // server disagrees with. Reload rather than patch `doc` in place: the
      // socket was closed by the transfer and every gate in the app reads
      // `doc.role`.
      location.reload()
    } catch (err) {
      error = err.message
    }
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
        {#if person.via_folder_name}
          <!-- Their access is a grant on the folder this document sits in, so
               there is no row here to withdraw and no button offered. Saying
               where it came from beats a remove that reports success and
               changes nothing — which is exactly what this panel would do if
               it listed only direct grants. -->
          <span class="via">via the folder “{person.via_folder_name}”</span>
        {:else}
          <!-- Gated on rank rather than on `!== 'owner'`: a manager may not
               remove a peer either, and the old test would have offered them a
               button that only ever returned 403. -->
          {#if mayModify(person)}
            <button onclick={() => removePerson(person)}>remove</button>
          {/if}
        {/if}
        <!-- Transfer is owner-only, and offered per person because the target
             must already have access — which is what makes this list the
             natural place for it. -->
        {#if isOwner && person.role !== 'owner'}
          <button onclick={() => transfer(person)}>make owner</button>
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
    {#each LINK_ROLES as r (r.value)}
      <button onclick={() => createLink(r.value)}>New {r.value} link</button>
    {/each}
  </p>
  <p class="note">
    Anyone with the link gets that role, without an account of their own being
    named — so a commenter link is the one to hand out when you want remarks
    back but not edits. There is no manager link, deliberately: a link is a
    bearer token and nobody knows who is holding it, so it stops one level
    below the roles that can change who else has access.
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
  .via {
    font-size: 0.8rem;
    opacity: 0.75;
    font-style: italic;
  }
</style>
