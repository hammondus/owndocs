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
    class="name"
    class:renamable={canRename}
    title={canRename ? 'Rename — double-click' : ''}
    ondblclick={start}
    role="presentation"
  >{doc.title}</strong>
{/if}
{#if error}
  <span class="err">⚠ {error}</span>
{/if}

<style>
  /* The subject of the screen, so it is the largest thing in the bar — every
     other readout around it is deliberately smaller. */
  .name {
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.01em;
    /* Matched to .renamable's border and padding, so nothing shifts when the
       outline appears under the pointer or when the field replaces it. */
    border: 1px solid transparent;
    border-radius: var(--r);
    padding: 2px 6px;
    margin-left: -6px;
  }
  /* An affordance you can see. A tooltip alone cannot tell you a thing is
     editable — you have to already suspect it to hover, which is the position
     nobody is in. */
  .renamable {
    cursor: text;
  }
  .renamable:hover {
    border-color: var(--line-strong);
    background: var(--surface);
  }
  .title {
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.01em;
    padding: 2px 6px;
    margin-left: -6px;
  }
  .err {
    font-size: var(--t-small);
    color: var(--danger);
  }
</style>
