<script>
  // Sign-in / sign-up forms. On success, hands the user object up to the
  // parent via the onSignedIn callback prop — child components never set
  // parent state directly.
  import { api } from './api.js'

  import { onMount } from 'svelte'

  // $props() declares what the parent passes in (Svelte 5's replacement
  // for `export let`).
  // `invite` is the token from an #invite=<token> link, or '' — it decides
  // whether the sign-up form is offered at all on a closed instance.
  let { onSignedIn, invite = '' } = $props()

  let error = $state('')

  // Quick-login roster, present only when the server runs with -dev.
  // A 404 (production) simply leaves this empty and the section hidden.
  let devUsers = $state([])
  onMount(async () => {
    try {
      devUsers = await api('/api/dev/users')
    } catch {
      devUsers = []
    }
  })

  async function devLogin(u) {
    try {
      const user = await api('/api/dev/login', {
        method: 'POST',
        body: JSON.stringify({ email: u.email }),
      })
      onSignedIn(user)
    } catch (err) {
      error = err.message
    }
  }

  // Shared by both forms: read the fields, post them, report errors inline.
  async function submit(event, path) {
    event.preventDefault()
    const fields = Object.fromEntries(new FormData(event.target))
    try {
      // The invite token rides along on sign-up. The server ignores it when
      // signup is open, and requires it when closed.
      if (path === '/api/signup' && invite) fields.invite = invite
      const user = await api(path, { method: 'POST', body: JSON.stringify(fields) })
      error = ''
      onSignedIn(user)
    } catch (err) {
      error = err.message
    }
  }
</script>

{#if devUsers.length > 0}
  <fieldset>
    <legend>Dev quick login</legend>
    {#each devUsers as u (u.email)}
      <button onclick={() => devLogin(u)}>{u.name}</button>
    {/each}
  </fieldset>
{/if}

<fieldset>
  <legend>Sign in</legend>
  <form onsubmit={(e) => submit(e, '/api/login')}>
    <input name="email" type="email" placeholder="email" required />
    <input name="password" type="password" placeholder="password" required />
    <button>Sign in</button>
  </form>
</fieldset>

<fieldset>
  <legend>{invite ? 'Create your account' : 'Sign up'}</legend>
  {#if invite}
    <p class="hint">You were invited. Fill this in to claim it.</p>
  {/if}
  <form onsubmit={(e) => submit(e, '/api/signup')}>
    <input name="name" placeholder="name" required />
    <input name="email" type="email" placeholder="email" required />
    <input name="password" type="password" placeholder="password (min 8)" required />
    <button>Create account</button>
  </form>
</fieldset>

{#if error}
  <p class="err">{error}</p>
{/if}
