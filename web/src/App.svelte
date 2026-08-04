<script>
  // Root component: owns "who is signed in" and "which view is showing",
  // and handles the location-hash routes (#doc=<id>, #share=<token>).
  // Each view is its own component; this file only wires them together.
  import { onMount } from 'svelte'
  import { api } from './lib/api.js'
  import AuthView from './lib/AuthView.svelte'
  import DocList from './lib/DocList.svelte'
  import EditorView from './lib/EditorView.svelte'
  import ShareView from './lib/ShareView.svelte'
  import HistoryView from './lib/HistoryView.svelte'

  // $state makes a variable reactive: assigning to it re-renders whatever
  // reads it. `me` is the signed-in user (null = signed out).
  let me = $state(null)

  // The current route. Always an object with a `view` field; editor and
  // share views also carry the document they operate on.
  let route = $state({ view: 'loading' })

  onMount(async () => {
    try {
      me = await api('/api/me')
      await afterAuth()
    } catch {
      route = { view: 'auth' }
    }
  })

  // Route on the location hash once signed in: #share=<token> redeems a
  // share link, #doc=<id> reopens a document (survives refresh), else the
  // doc list. Called on load and again right after login/signup, so a share
  // link opened while signed out still redeems after signing in.
  async function afterAuth() {
    const hash = new URLSearchParams(location.hash.slice(1))
    if (hash.get('share')) {
      try {
        const doc = await api('/api/share/redeem', {
          method: 'POST',
          body: JSON.stringify({ token: hash.get('share') }),
        })
        openDoc(doc)
        return
      } catch (err) {
        alert(err.message) // invalid or revoked link; fall through to the list
      }
    } else if (hash.get('doc')) {
      const docs = await api('/api/docs')
      const doc = docs.find((d) => d.id === hash.get('doc'))
      if (doc) {
        openDoc(doc)
        return
      }
    }
    showList()
  }

  function showList() {
    location.hash = ''
    route = { view: 'list' }
  }

  function openDoc(doc) {
    location.hash = 'doc=' + doc.id
    route = { view: 'editor', doc }
  }

  function openShare(doc) {
    route = { view: 'share', doc }
  }

  function openHistory(doc) {
    route = { view: 'history', doc }
  }

  async function signedIn(user) {
    me = user
    await afterAuth()
  }

  async function signOut() {
    await api('/api/logout', { method: 'POST' })
    me = null
    route = { view: 'auth' }
  }
</script>

<h1>docs</h1>

{#if route.view === 'auth'}
  <AuthView onSignedIn={signedIn} />
{:else if route.view === 'list'}
  <DocList {me} onOpen={openDoc} onShare={openShare} onSignOut={signOut} />
{:else if route.view === 'editor'}
  <!-- #key destroys and recreates the editor when the doc changes, so a
       stale CodeMirror/provider from the previous doc can never leak. -->
  {#key route.doc.id}
    <EditorView {me} doc={route.doc} onBack={showList} onShare={openShare} onHistory={openHistory} />
  {/key}
{:else if route.view === 'share'}
  <ShareView doc={route.doc} onBack={showList} />
{:else if route.view === 'history'}
  <HistoryView doc={route.doc} onBack={() => openDoc(route.doc)} />
{/if}
