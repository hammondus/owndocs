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
  import ScriptsView from './lib/ScriptsView.svelte'
  import NotificationsPanel from './lib/NotificationsPanel.svelte'
  import SearchPanel from './lib/SearchPanel.svelte'

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

  // Why the last thing you tried did nothing — today, a write refused by sheet
  // protection. It lives in the app bar rather than in the view that raised it,
  // and that is the whole point: the bar has a fixed height, so a message
  // appearing and going cannot move anything. As a block above the grid it
  // pushed every row down and then back up, which is a worse interruption than
  // the refusal it was reporting.
  //
  // Not the "Not saved" banner, which is an alarm about work that did not reach
  // the server and stays until dismissed. This is routine and self-clearing.
  let notice = $state('')
  let noticeTimer = 0

  // Passed down as `onNotice`. Held here rather than per view so the timer and
  // the replace-rather-than-stack rule are written once: a held-down key raises
  // one message, not a queue of them.
  //
  // `ms` because the two things this reports are not read at the same speed. A
  // refusal you caused by typing is understood the moment you see it — you know
  // what you just did. A script that failed on your behalf has to be read: it
  // names a script you did not run and a cell you may not have been looking at.
  function notify(msg, ms = 5000) {
    notice = msg
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => (notice = ''), ms)
  }

  // Search. `seq` is what makes an out-of-order response harmless: typing is
  // faster than the network, so a slow early query can land after a fast later
  // one and overwrite the results for what is currently in the box.
  let showSearch = $state(false)
  let searchQ = $state('')
  let searchResults = $state({ documents: [], comments: [] })
  let searching = $state(false)
  let searchSeq = 0
  let searchTimer = null

  function onSearchQuery(v) {
    searchQ = v
    clearTimeout(searchTimer)
    if (v.trim() === '') {
      searchResults = { documents: [], comments: [] }
      searching = false
      return
    }
    searching = true
    // Debounced: a search box that fires per keystroke is a query per
    // keystroke, and FTS5 prefix matching makes the early ones useless anyway.
    searchTimer = setTimeout(runSearch, 200)
  }

  async function runSearch() {
    const mine = ++searchSeq
    try {
      const r = await api('/api/search?q=' + encodeURIComponent(searchQ))
      if (mine !== searchSeq) return // a later query already answered
      searchResults = r
    } catch (e) {
      if (mine !== searchSeq) return
      console.warn('owndocs: search failed', e)
      searchResults = { documents: [], comments: [] }
    } finally {
      if (mine === searchSeq) searching = false
    }
  }

  async function openSearchDoc(h) {
    showSearch = false
    const doc = await findDoc(h.doc_id)
    if (doc) openDoc(doc)
  }

  // A comment hit opens the document with the comments panel showing, which is
  // the same landing an inbox item gets — the thread is what was searched for.
  async function openSearchComment(h) {
    showSearch = false
    const doc = await findDoc(h.doc_id)
    if (doc) openDoc(doc, true)
  }
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
    } else if (hash.get('scripts')) {
      // A whole-window script editor. Its own route rather than a flag on the
      // editor route, because it is a different view of the same document and
      // has to survive a refresh — this is a URL people will keep open in a
      // second window all afternoon.
      const doc = await findDoc(hash.get('scripts'))
      if (doc && doc.kind === 'sheet') {
        route = { view: 'scripts', doc }
        return
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
  // The scripts window joins both lists: it is a code editor, so it wants the
  // width, and its whole reason for existing is height the drawer could not
  // give it.
  let wideView = $derived(route.doc?.kind === 'sheet' &&
    (route.view === 'editor' || route.view === 'history' || route.view === 'scripts'))
  let fillView = $derived(route.doc?.kind === 'sheet' &&
    (route.view === 'editor' || route.view === 'scripts'))

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
  <!-- Beside the wordmark, in the space the spacer would otherwise eat. The
       bar's height is fixed, so this can never move the page under whoever is
       reading it — which is what it did as a block above the grid. `title`
       carries the whole sentence when the window is too narrow to show it. -->
  {#if notice}
    <span class="notice" role="status" title={notice}>{notice}</span>
  {/if}
  <span class="spacer"></span>
  {#if me}
    <!-- The unread count is the whole notification surface: no badge dot, no
         toast, nothing that interrupts. Somebody who is working stays working. -->
    <button
      class="linkish"
      title="Search documents and comments"
      onclick={() => { showSearch = !showSearch; if (showSearch) showNotes = false }}
    >search</button>
    <button
      class="linkish"
      class:has-unread={unread > 0}
      title="Mentions and replies"
      onclick={() => { showNotes = !showNotes; if (showNotes) { loadNotes(); showSearch = false } }}
    >inbox{unread ? ` (${unread})` : ''}</button>
    <span class="who readout">{me.name}</span>
    <button class="linkish" onclick={signOut}>sign out</button>
  {/if}
</header>

<!-- Prose views keep a comfortable reading width; a grid gets the whole
     window, since a spreadsheet's usefulness is columns you can see. -->
<div class="page" class:wide={wideView} class:fill={fillView}>
  {#if me && showSearch}
    <SearchPanel
      q={searchQ}
      results={searchResults}
      {searching}
      onQuery={onSearchQuery}
      onOpenDoc={openSearchDoc}
      onOpenComment={openSearchComment}
      onClose={() => (showSearch = false)}
    />
  {/if}
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
        <SheetView {me} doc={route.doc} onBack={showList} onShare={openShare} onHistory={openHistory} onRenamed={renamed} onNotice={notify} />
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
  {:else if route.view === 'scripts'}
    {#key route.doc.id}
      <ScriptsView doc={route.doc} onBack={() => openDoc(route.doc)} />
    {/key}
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
  /* Truncates rather than pushing: `min-width: 0` is what lets a flex item
     shrink below its content, without which a long message would shove the
     inbox and sign-out off the end of the bar instead of ellipsing.
     Signal-coloured, because this is the app telling you something about right
     now — not danger-coloured, because nothing is wrong. */
  .notice {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85rem;
    padding: 2px 8px;
    border-radius: var(--r);
    color: var(--ink);
    background: var(--signal-tint);
    border-left: 2px solid var(--signal);
  }
</style>
