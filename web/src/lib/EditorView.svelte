<script>
  // The editor page. The actual editor is NOT a Svelte component — it's the
  // framework-agnostic CodeMirror module (editor.js) plus the sync provider
  // (provider.js). This component's job is lifecycle: create them when the
  // page mounts, hand them a real DOM node, and tear them down on leave.
  import { onMount, onDestroy } from 'svelte'
  import * as Y from 'yjs'
  import { Provider } from '../provider.js'
  import { mountEditor, toolbarCommands } from '../editor.js'
  import { scheduleCompaction } from '../compaction.js'

  let { me, doc, onBack, onShare, onHistory } = $props()

  let status = $state('connecting…')
  let peerCount = $state(1)

  // bind:this fills this variable with the actual <div> DOM element once it
  // exists — the escape hatch for handing DOM to non-Svelte code.
  let editorEl

  let ydoc, provider, view

  const cursorColors = [
    ['#30bced', '#a8dff2'], ['#6eeb83', '#c6f7cf'], ['#fa69d1', '#fcc4ea'],
    ['#ffbc42', '#ffe3b0'], ['#ecd444', '#f5edb0'], ['#ee6352', '#f8c2ba'],
    ['#9b6ef3', '#d9c6fa'], ['#1be7ff', '#b3f6ff'],
  ]

  onMount(() => {
    ydoc = new Y.Doc()
    const ytext = ydoc.getText('text')

    provider = new Provider(ydoc, doc.id, {
      onStatus: (s) => { status = s },
      onSynced: (synced) => {
        if (provider.corrupted) return // never snapshot/verify after a bad frame
        scheduleCompaction({ docId: doc.id, doc: ydoc, role: doc.role, synced })
      },
    })

    const [color, colorLight] = cursorColors[ydoc.clientID % cursorColors.length]
    provider.awareness.setLocalStateField('user', { name: me.name, color, colorLight })
    provider.awareness.on('change', () => {
      peerCount = provider.awareness.getStates().size
    })

    view = mountEditor({
      parent: editorEl,
      ytext,
      awareness: provider.awareness,
      readOnly: doc.role === 'viewer',
    })
  })

  onDestroy(() => {
    view?.destroy()
    provider?.destroy()
    ydoc?.destroy()
  })
</script>

<p>
  <a href="#list" onclick={(e) => { e.preventDefault(); onBack() }}>← documents</a>
  <strong>{doc.title}</strong>
  {#if doc.role === 'owner'}
    <a href="#share" onclick={(e) => { e.preventDefault(); onShare(doc) }}>share</a>
  {/if}
  <a href="#history" onclick={(e) => { e.preventDefault(); onHistory(doc) }}>history</a>
  <span class="status">{status}</span>
  {#if peerCount > 1}
    <span class="status">{peerCount} online</span>
  {/if}
</p>

{#if doc.role !== 'viewer'}
  <div class="toolbar">
    {#each toolbarCommands as cmd (cmd.title)}
      <!-- onmousedown preventDefault keeps focus (and the text selection)
           inside the editor while the button is clicked -->
      <button
        title={cmd.title}
        onmousedown={(e) => e.preventDefault()}
        onclick={() => cmd.run(view)}
      >{cmd.label}</button>
    {/each}
  </div>
{/if}

<div bind:this={editorEl}></div>

<style>
  .status {
    font-size: 0.85rem;
    opacity: 0.7;
    margin-left: 0.5rem;
  }
</style>
