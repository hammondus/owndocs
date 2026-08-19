<script>
  // Sharing panel for a folder. Deliberately smaller than the document one:
  // there are no capability links and no transfer here.
  //
  // No links, because a link is a bearer token — whoever holds the URL gets the
  // role, and by design nobody knows who that is. A folder link would hand an
  // unknown holder everything filed in the folder from then on, including
  // documents put there later by people who never saw the link.
  //
  // No transfer, because a folder has no owner to transfer. Ownership is
  // per-document and singular; the top of the folder ladder is `manager`.
  import { onMount } from 'svelte'
  import { api } from './api.js'
  import { rankOf } from '../roles.js'

  let { folder, onBack } = $props()

  // The same list the document panel offers, minus `owner`, which no folder
  // may grant — a folder that could would hand everyone inside the power to
  // delete documents they did not create.
  const ROLES = [
    { value: 'manager', can: 'can share the folder and shape what is in it' },
    { value: 'editor', can: 'can change the documents in it, and add more' },
    { value: 'commenter', can: 'can comment on them, but not change them' },
    { value: 'viewer', can: 'can read them' },
  ]

  const mayModify = (person) => rankOf(folder.role) > rankOf(person.role)

  let people = $state([])
  let addEmail = $state('')
  let addRole = $state('editor')
  let error = $state('')

  onMount(load)

  async function load() {
    people = await api(`/api/folders/${folder.id}/shares`)
  }

  async function addPerson(event) {
    event.preventDefault()
    try {
      await api(`/api/folders/${folder.id}/shares`, {
        method: 'POST',
        body: JSON.stringify({ email: addEmail, role: addRole }),
      })
      addEmail = ''
      error = ''
      await load()
    } catch (err) {
      error = err.message
    }
  }

  async function removePerson(person) {
    try {
      await api(`/api/folders/${folder.id}/shares/${person.user_id}`, { method: 'DELETE' })
      error = ''
      await load()
    } catch (err) {
      // The refusal worth surfacing: their access was granted on a folder
      // further up, so there is nothing here to withdraw. The server's message
      // names the folder to go to.
      error = err.message
    }
  }
</script>

<div class="bar">
  <button onclick={onBack}>← back</button>
  <h2>{folder.name}</h2>
  <span class="label">folder · {folder.role}</span>
</div>

<p class="note">
  Everyone here reaches every document in this folder, and everything below it.
  Access adds up: a grant further up cannot be reduced by a smaller one here.
</p>

<fieldset>
  <legend>People</legend>
  <form onsubmit={addPerson}>
    <input type="email" placeholder="email address" bind:value={addEmail} required />
    <select bind:value={addRole}>
      {#each ROLES as r (r.value)}
        <option value={r.value}>{r.value} — {r.can}</option>
      {/each}
    </select>
    <button class="primary">Add</button>
  </form>
  {#if error}<p class="err">{error}</p>{/if}
  <ul>
    {#each people as p (p.user_id)}
      <li>
        <span class="who">
          <strong>{p.name}</strong>
          <span class="label">{p.email}</span>
        </span>
        <span class="label">{p.role}</span>
        {#if p.via_folder_name}
          <!-- Their access comes from a folder above this one, so the button
               that would remove it is not here — it is up there. Saying so
               beats a button that reports success and changes nothing. -->
          <span class="label via">via {p.via_folder_name}</span>
        {:else if mayModify(p)}
          <button onclick={() => removePerson(p)}>remove</button>
        {/if}
      </li>
    {/each}
    {#if !people.length}
      <li class="empty">Nobody yet. Only you can see this folder.</li>
    {/if}
  </ul>
</fieldset>

<style>
  .bar { display: flex; gap: 10px; align-items: baseline; }
  h2 { margin: 0; font-size: var(--t-title); }
  .note { color: var(--ink-3); font-size: var(--t-base); max-width: 46rem; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 10px; align-items: center; padding: 7px 0; }
  li + li { border-top: 1px solid var(--line); }
  .who { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
  .via { color: var(--ink-3); font-style: italic; }
  .err { color: var(--danger, crimson); font-size: var(--t-base); }
  .empty { color: var(--ink-3); font-size: var(--t-base); }
</style>
