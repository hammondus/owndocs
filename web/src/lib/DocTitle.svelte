<script>
  // The document title in a view header, renamable in place. Double-click to
  // edit — the same gesture the sheet tabs already use, so there is one thing
  // to learn rather than two.
  //
  // The title lives in SQLite, not in the Yjs document, so this is an ordinary
  // HTTP write and not a collaborative edit: a rename does not reach anyone
  // else's open tab until they reload. Fine for a title; it would not be for
  // content.
  import { api } from './api.js'

  let { doc, canRename, onRenamed } = $props()

  let editing = $state(false)
  let error = $state('')

  function start() {
    if (!canRename) return
    error = ''
    editing = true
  }

  async function commit(event) {
    const title = event.target.value.trim()
    editing = false
    if (!title || title === doc.title) return
    try {
      await api(`/api/docs/${doc.id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
      onRenamed(title)
    } catch (err) {
      error = err.message
    }
  }

  function onKey(event) {
    if (event.key === 'Enter') event.target.blur() // blur commits
    if (event.key === 'Escape') {
      editing = false // discard: the value was never written anywhere
      event.preventDefault()
    }
  }
</script>

{#if editing}
  <!-- svelte-ignore a11y_autofocus -->
  <input
    class="title"
    value={doc.title}
    autofocus
    onblur={commit}
    onkeydown={onKey}
  />
{:else}
  <strong
    class:renamable={canRename}
    title={canRename ? 'Double-click to rename' : ''}
    ondblclick={start}
    role="presentation"
  >{doc.title}</strong>
{/if}
{#if error}
  <span class="err">⚠ {error}</span>
{/if}

<style>
  .renamable {
    cursor: text;
  }
  .title {
    font: inherit;
    font-weight: 700;
    padding: 1px 4px;
  }
  .err {
    font-size: 0.8rem;
    color: #b00020;
    margin-left: 0.4rem;
  }
</style>
