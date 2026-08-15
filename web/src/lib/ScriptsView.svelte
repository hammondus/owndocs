<script>
  // The scripts editor as a whole page, reached by #scripts=<docId>.
  //
  // This is a second client on the same document, not a second view of the
  // sheet's model — it opens its own Y.Doc and its own Provider, exactly as
  // SheetView does. That is why a separate window works at all with no new
  // machinery: two windows of your own are the same case as two collaborators,
  // and the relay already handles that. It also means the sheet window can be
  // closed while this one stays useful.
  //
  // Awareness carries one extra field, `editingScripts`. The sheet window
  // watches for it and holds on-edit triggers while any editor is open, so a
  // script saved mid-thought cannot fire on the next cell you type in.
  import { onMount, onDestroy } from 'svelte'
  import * as Y from 'yjs'
  import { Provider } from '../provider.js'
  import { Workbook } from '../sheet/model.js'
  import { canEdit } from '../roles.js'
  import ScriptsPane from './ScriptsPane.svelte'

  let { doc, onBack } = $props()

  let ydoc, provider
  let workbook = $state(null)
  let status = $state('connecting')
  let readOnly = $derived(!canEdit(doc.role))

  onMount(() => {
    ydoc = new Y.Doc()
    workbook = new Workbook(ydoc)
    provider = new Provider(ydoc, doc.id, {
      onStatus: (s) => { status = s },
    })
    provider.awareness.setLocalStateField('editingScripts', true)
    // The title is what tells you which document this window belongs to once
    // three of them are open. Restored on unmount for the tab case, where the
    // same page may route back to the list.
    document.title = `Scripts — ${doc.title}`
  })

  onDestroy(() => {
    provider?.destroy()
    ydoc?.destroy()
    document.title = 'own docs'
  })

  // Closing means closing the window when we opened it, and going back to the
  // sheet when this was reached as an ordinary tab. `window.close()` is a
  // no-op on a tab the script did not open, so the fallback is not optional.
  function close() {
    window.close()
    onBack?.()
  }
</script>

<div class="wrap">
  <div class="bar">
    <strong class="title">{doc.title}</strong>
    <span class="kind">scripts</span>
    <span class="spacer"></span>
    {#if status !== 'connected'}<span class="status">{status}</span>{/if}
  </div>
  {#if workbook}
    <ScriptsPane {workbook} {readOnly} standalone onClose={close} />
  {/if}
</div>

<style>
  /* Fills the window: the point of this view is an editor as tall as the
     screen, so every ancestor between it and the viewport has to say so. */
  .wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid var(--line);
    flex: none;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kind {
    font-size: 0.75rem;
    opacity: 0.6;
  }
  .spacer { flex: 1; }
  .status {
    font-size: 0.75rem;
    opacity: 0.7;
  }
</style>
