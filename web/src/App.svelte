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
  import NotificationsPanel from './lib/NotificationsPanel.svelte'

  // $state makes a variable reactive: assigning to it re-renders whatever
  // reads it. `me` is the signed-in user (null = signed out).
  let me = $state(null)

  // The current route. Always an object with a `view` field; editor and
  // share views also carry the document they operate on.
  let route = $state({ view: 'loading' })

  // ---- the inbox ----------------------------------------------------------
  // Mentions and thread replies. Fetched rather than pushed: a notification is
  // not urgent by definition — the whole filter is "did this happen while you
  // were not looking?" — so it is refreshed when signing in, when returning to
  // the list, and when the drawer is opened. A socket for this would be a
  // subscription to something nobody is waiting on.
  let notes = $state([])
  let showNotes = $state(false)
  let unread = $derived(notes.filter((n) => !n.read_at).length)

  async function loadNotes() {
    try {
      notes = await api('/api/notifications')
    } catch (e) {
      // Quiet: the app is whole without an inbox, and a failed poll must not
      // put an error in front of somebody who was doing something else.
      console.warn('docs: could not load notifications', e)
    }
  }

  async function markRead(ids) {
    try {
      await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ ids: ids || [] }) })
    } catch (e) {
      console.warn('docs: could not mark notifications read', e)
      return
    }
    loadNotes()
  }

  // Following one opens its document *with the comments drawer already up*.
  // Landing in a long document with no idea which comment was meant is the
  // failure this avoids, and it costs one flag on the route.
  async function openNote(n) {
    showNotes = false
    markRead([n.id])
    const doc = await findDoc(n.doc_id)
    if (doc) openDoc(doc, true)
  }

  // An invite token from #invite=<token>. Read once at load, because signing
  // up clears the hash and the token must outlive that.
  const inviteToken = new URLSearchParams(location.hash.slice(1)).get('invite') || ''

  onMount(async () => {
    try {
      me = await api('/api/me')
      await afterAuth()
      loadNotes()
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
      const doc = await findDoc(hash.get('doc'))
      if (doc) {
        openDoc(doc)
        return
      }
    }
    showList()
  }

  // A document by id, or null. Routing needs the whole row — kind picks the
  // view, role decides what is editable — and the list is the only place that
  // has it, since the server never hands out one document's metadata alone.
  async function findDoc(id) {
    try {
      return (await api('/api/docs')).find((d) => d.id === id) || null
    } catch {
      return null
    }
  }

  // Following a document link. Fetched fresh rather than resolved against the
  // editor's cached list: that list is from when the document was opened, so a
  // document shared since would be unreachable through a link to it — and if
  // the fetch that built it failed, every link in the document would be a
  // control that looks live and does nothing.
  //
  // Staying put on a dead id is deliberate. The link is already dimmed and
  // says why on hover, and dropping someone to the document list because they
  // clicked a link would lose their place to no purpose.
  async function openDocById(id) {
    const doc = await findDoc(id)
    if (doc) openDoc(doc)
  }

  // Children report a rename rather than writing to route themselves — the
  // same rule the auth view follows about not setting parent state directly.
  function renamed(title) {
    route.doc.title = title
  }

  // Likewise the formatting mode. Both are properties of the document row that
  // the child has already persisted over HTTP; what lands here is the copy the
  // rest of the app reads from.
  function richChanged(rich) {
    route.doc.rich = rich
  }

  function showList() {
    location.hash = ''
    route = { view: 'list' }
    loadNotes()
  }

  function openDoc(doc, withComments = false) {
    location.hash = 'doc=' + doc.id
    route = { view: 'editor', doc, withComments }
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
    loadNotes()
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

<!-- The app bar is full bleed and a fixed height, so every screen starts on the
     same line. It carries only what is true everywhere: what this is, and who
     you are. Anything about the *current* document belongs to the view that
     owns it, in its own bar below. -->
<header class="appbar">
  <span class="wordmark">own docs</span>
  <span class="spacer"></span>
  {#if me}
    <!-- The unread count is the whole notification surface: no badge dot, no
         toast, nothing that interrupts. Somebody who is working stays working. -->
    <button
      class="linkish"
      class:has-unread={unread > 0}
      title="Mentions and replies"
      onclick={() => { showNotes = !showNotes; if (showNotes) loadNotes() }}
    >inbox{unread ? ` (${unread})` : ''}</button>
    <span class="who readout">{me.name}</span>
    <button class="linkish" onclick={signOut}>sign out</button>
  {/if}
</header>

<!-- Prose views keep a comfortable reading width; a grid gets the whole
     window, since a spreadsheet's usefulness is columns you can see. -->
<div class="page" class:wide={wideView} class:fill={fillView}>
  {#if me && showNotes}
    <NotificationsPanel
      items={notes}
      onOpen={openNote}
      onMarkAll={() => markRead()}
      onClose={() => (showNotes = false)}
    />
  {/if}
  {#if route.view === 'auth'}
    <!-- An #invite=<token> link lands here signed out; the token is handed to
         the sign-up form, which is the only thing that can spend it. -->
    <AuthView onSignedIn={signedIn} invite={inviteToken} />
  {:else if route.view === 'list'}
    <DocList {me} onOpen={openDoc} onShare={openShare} />
  {:else if route.view === 'editor'}
    <!-- #key destroys and recreates the editor when the doc changes, so a
         stale CodeMirror/provider from the previous doc can never leak. -->
    {#key route.doc.id}
      {#if route.doc.kind === 'sheet'}
        <SheetView {me} doc={route.doc} onBack={showList} onShare={openShare} onHistory={openHistory} onRenamed={renamed} />
      {:else}
        <!-- onOpenDoc follows a document link, by id. It ends in openDoc like
             any other navigation, so the hash updates and the #key above swaps
             the editor rather than leaving a stale one on the old document. -->
        <EditorView {me} doc={route.doc} onBack={showList} onShare={openShare} onHistory={openHistory} onRenamed={renamed} onOpenDoc={openDocById} onRichChanged={richChanged}
          startWithComments={route.withComments} />
      {/if}
    {/key}
  {:else if route.view === 'share'}
    <ShareView doc={route.doc} onBack={showList} />
  {:else if route.view === 'history'}
    <HistoryView doc={route.doc} onBack={() => openDoc(route.doc)} />
  {/if}
</div>

<style>
  /* Truncated rather than wrapped: the bar is a fixed height, and a long name
     must not be what decides it. */
  /* The signal colour means "live / yours / here". An inbox with something in
     it is the one bar item that qualifies, so it is the one that gets it. */
  .has-unread { color: var(--signal); font-weight: 600; }
  .who {
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
