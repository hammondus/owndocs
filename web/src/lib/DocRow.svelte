<script>
  // One document, wherever it is being listed from. Extracted when folders
  // arrived and the same row started appearing in two places — the flat recent
  // list and the folder tree. A second copy of it would have drifted, and the
  // half that drifts is always the one holding the role gates.
  import { canEdit, canManage } from '../roles.js'

  let {
    doc,
    onOpen,
    onShare,
    onRenamed,
    onDelete,
    // Move controls. `moveTo` is null when this row is not the one being
    // moved; the parent holds that, so only one picker is ever open.
    moveOptions = [],
    moving = false,
    onMoveStart,
    onMoveCancel,
    onMoveTo,
  } = $props()

  let renaming = $state(false)

  async function commitRename(event) {
    const title = event.target.value.trim()
    renaming = false
    if (!title || title === doc.title) return
    onRenamed(doc, title)
  }
</script>

<li>
  {#if renaming}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="rename"
      autofocus
      value={doc.title}
      onblur={commitRename}
      onkeydown={(e) => {
        if (e.key === 'Enter') e.target.blur()
        if (e.key === 'Escape') renaming = false
      }}
    />
  {:else}
    <div class="name">
      <a
        href={'#doc=' + doc.id}
        title="Double-click to rename"
        onclick={(e) => { e.preventDefault(); onOpen(doc) }}
        ondblclick={(e) => { e.preventDefault(); if (canEdit(doc.role)) renaming = true }}
      >{doc.title}</a>
      <!-- Kind and role are what the machine knows about this row, so they
           are a readout, under the name rather than beside it. -->
      <span class="meta label">{doc.kind} · {doc.role}</span>
      <!-- Unresolved threads, counted by the list query rather than one
           request per row. Shown only when there are some: a "0" beside
           every document is noise that trains people to stop reading it. -->
      {#if doc.open_comments}
        <span class="meta label open">{doc.open_comments} unresolved</span>
      {/if}
    </div>
  {/if}

  {#if moving}
    <!-- The warning is not decoration. Filing a document is the one gesture in
         the app that hands other people access as a side effect, and the folder
         it goes into is the only place that fact is visible. -->
    <div class="move">
      <span class="label warn">everyone in the destination folder gets access</span>
      <select
        onchange={(e) => onMoveTo(doc, e.target.value === '' ? null : e.target.value)}
      >
        <option value="">— no folder —</option>
        {#each moveOptions as opt (opt.id)}
          <option value={opt.id} selected={opt.id === doc.folder_id}>{opt.label}</option>
        {/each}
      </select>
      <button onclick={onMoveCancel}>cancel</button>
    </div>
  {:else if canManage(doc.role)}
    <!-- Two gates, not one, and this is where they part company: sharing and
         filing are administration and a manager does them; deleting is
         irreversible and total, so it stays with the owner. -->
    <span class="actions">
      <button onclick={() => onMoveStart(doc)}>move</button>
      <button onclick={() => onShare(doc)}>share</button>
      {#if doc.role === 'owner'}
        <button class="danger" onclick={() => onDelete(doc)}>delete</button>
      {/if}
    </span>
  {/if}
</li>

<style>
  li {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 9px 12px;
    /* The caret rule: transparent until the row is live, so a hover does not
       shift anything sideways. */
    border-left: 2px solid transparent;
  }
  li + li { border-top: 1px solid var(--line); }
  li:hover { background: var(--surface-2); border-left-color: var(--signal); }
  li:focus-within { border-left-color: var(--signal); }

  .name { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
  .name a {
    color: var(--ink);
    font-size: var(--t-title);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  li:hover .name a { color: var(--signal); }
  .meta { text-transform: uppercase; }
  .rename { flex: 1; font-size: var(--t-title); }

  .actions { display: flex; gap: 2px; opacity: 0; transition: opacity .12s; }
  li:hover .actions, li:focus-within .actions { opacity: 1; }
  /* Never hidden from the keyboard: a focused control inside a "hidden" group
     brings the whole group back. */
  @media (hover: none) {
    .actions { opacity: 1; }
  }

  .move { display: flex; gap: 6px; align-items: center; }
  .warn { color: var(--signal); text-transform: uppercase; }
  .open { color: var(--signal); }
</style>
