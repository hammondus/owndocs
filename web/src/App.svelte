<script>
  // Root component: owns "who is signed in" and "which view is showing",
  // and handles the location-hash routes (#doc=<id>, #share=<token>).
  // Each view is its own component; this file only wires them together.
  import { onMount } from 'svelte'
  import { api } from './lib/api.js'
  import AuthView from './lib/AuthView.svelte'
  import DocList from './lib/DocList.svelte'
  import EditorView from './lib/EditorView.svelte'
  import SheetView from './lib/SheetView.svelte'
  import ShareView from './lib/ShareView.svelte'
  import HistoryView from './lib/HistoryView.svelte'

  // $state makes a variable reactive: assigning to it re-renders whatever
  // reads it. `me` is the signed-in user (null = signed out).
  let me = $state(null)

  // The current route. Always an object with a `view` field; editor and
  // share views also carry the document they operate on.
  let route = $state({ view: 'loading' })

  // An invite token from #invite=<token>. Read once at load, because signing
  // up clears the hash and the token must outlive that.
  const inviteToken = new URLSearchParams(location.hash.slice(1)).get('invite') || ''

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

  // Children report a rename rather than writing to route themselves — the
  // same rule the auth view follows about not setting parent state directly.
  function renamed(title) {
    route.doc.title = title
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

  // A sheet, and a sheet's history preview, both show grids and want the
  // window's full width. Only the editor also *fills* the height — the
  // history view has its own two-column layout and scrolls normally.
  let wideView = $derived(route.doc?.kind === 'sheet' &&
    (route.view === 'editor' || route.view === 'history'))
  let fillView = $derived(route.doc?.kind === 'sheet' && route.view === 'editor')

  async function signOut() {
    await api('/api/logout', { method: 'POST' })
    me = null
    route = { view: 'auth' }
  }
</script>

<!-- Prose views keep a comfortable reading width; a grid gets the whole
     window, since a spreadsheet's usefulness is columns you can see. -->
<div class="page" class:wide={wideView} class:fill={fillView}>
  <h1>docs</h1>

  {#if route.view === 'auth'}
    <!-- An #invite=<token> link lands here signed out; the token is handed to
         the sign-up form, which is the only thing that can spend it. -->
    <AuthView onSignedIn={signedIn} invite={inviteToken} />
  {:else if route.view === 'list'}
    <DocList {me} onOpen={openDoc} onShare={openShare} onSignOut={signOut} />
  {:else if route.view === 'editor'}
    <!-- #key destroys and recreates the editor when the doc changes, so a
         stale CodeMirror/provider from the previous doc can never leak. -->
    {#key route.doc.id}
      {#if route.doc.kind === 'sheet'}
        <SheetView {me} doc={route.doc} onBack={showList} onShare={openShare} onHistory={openHistory} onRenamed={renamed} />
      {:else}
        <EditorView {me} doc={route.doc} onBack={showList} onShare={openShare} onHistory={openHistory} onRenamed={renamed} />
      {/if}
    {/key}
  {:else if route.view === 'share'}
    <ShareView doc={route.doc} onBack={showList} />
  {:else if route.view === 'history'}
    <HistoryView doc={route.doc} onBack={() => openDoc(route.doc)} />
  {/if}
</div>
