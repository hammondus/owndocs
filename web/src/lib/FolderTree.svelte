<script>
  // One folder and everything under it. Recursive: the component imports
  // itself, which is how Svelte 5 does what `<svelte:self>` used to.
  //
  // The tree is drawn from what the server sent and nothing is re-derived here.
  // In particular a folder whose parent you hold no grant on arrives with a
  // null parent and so appears at the top level — two people can see the same
  // folder at different depths, and that is the design, not a rendering bug.
  import FolderTree from './FolderTree.svelte'
  import DocRow from './DocRow.svelte'
  import { canManage } from '../roles.js'
  import { countDocs } from '../folders.js'

  let { node, depth = 0, collapsed, onToggle, folderActions, docActions } = $props()

  let renaming = $state(false)
  let addingChild = $state(false)
  const isOpen = $derived(!collapsed.has(node.id))
  const total = $derived(countDocs(node))

  function commitRename(event) {
    const name = event.target.value.trim()
    renaming = false
    if (!name || name === node.name) return
    folderActions.rename(node, name)
  }
</script>

<li class="folder" style="--depth: {depth}">
  <div class="head">
    <button class="twist" onclick={() => onToggle(node.id)} aria-expanded={isOpen}>
      {isOpen ? '▾' : '▸'}
    </button>
    {#if renaming}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="rename"
        autofocus
        value={node.name}
        onblur={commitRename}
        onkeydown={(e) => {
          if (e.key === 'Enter') e.target.blur()
          if (e.key === 'Escape') renaming = false
        }}
      />
    {:else}
      <span
        class="name"
        title="Double-click to rename"
        ondblclick={() => { if (canManage(node.role)) renaming = true }}
        role="presentation"
      >{node.name}</span>
      <span class="meta label">{node.role}</span>
      <!-- The count covers the subtree, so collapsing a branch never makes
           documents look like they went away. -->
      {#if total}<span class="meta label">{total}</span>{/if}
    {/if}
    {#if canManage(node.role)}
      <!-- Shaping the tree is administration, which is why these sit behind
           `manager` while putting a document in the folder needs only editor. -->
      <span class="actions">
        <button onclick={() => { addingChild = true; if (!isOpen) onToggle(node.id) }}>new folder</button>
        <button onclick={() => folderActions.share(node)}>share</button>
        <button class="danger" onclick={() => folderActions.remove(node)}>delete</button>
      </span>
    {/if}
  </div>

  {#if isOpen}
    <ul class="contents">
      {#if addingChild}
        <li class="adding">
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="new-folder"
            autofocus
            placeholder="folder name"
            onblur={(e) => { addingChild = false; folderActions.addChild(node, e.target.value) }}
            onkeydown={(e) => {
              if (e.key === 'Enter') e.target.blur()
              if (e.key === 'Escape') { e.target.value = ''; e.target.blur() }
            }}
          />
        </li>
      {/if}
      {#each node.children as child (child.id)}
        <FolderTree
          node={child}
          depth={depth + 1}
          {collapsed}
          {onToggle}
          {folderActions}
          {docActions}
        />
      {/each}
      {#each node.docs as doc (doc.id)}
        <DocRow
          {doc}
          onOpen={docActions.open}
          onShare={docActions.share}
          onRenamed={docActions.rename}
          onDelete={docActions.remove}
          moveOptions={docActions.moveOptions}
          moving={docActions.movingId === doc.id}
          onMoveStart={docActions.moveStart}
          onMoveCancel={docActions.moveCancel}
          onMoveTo={docActions.moveTo}
        />
      {/each}
      {#if !node.children.length && !node.docs.length}
        <li class="empty">Empty. Create a document here, or move one in.</li>
      {/if}
    </ul>
  {/if}
</li>

<style>
  .folder { list-style: none; }
  /* Indentation is a padding on the header rather than a margin on the list,
     so a row's hover band still runs the full width at every depth. */
  .head {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 7px 12px 7px calc(12px + var(--depth) * 16px);
    border-left: 2px solid transparent;
  }
  .head:hover { background: var(--surface-2); border-left-color: var(--signal); }
  .head:focus-within { border-left-color: var(--signal); }

  .twist {
    border: 0;
    background: none;
    padding: 0 2px;
    cursor: pointer;
    color: var(--ink-3);
    font-size: var(--t-base);
  }
  .name { font-size: var(--t-title); font-weight: 500; color: var(--ink); }
  .rename { flex: 1; font-size: var(--t-title); }
  .meta { text-transform: uppercase; }
  .actions { margin-left: auto; display: flex; gap: 2px; opacity: 0; transition: opacity .12s; }
  .head:hover .actions, .head:focus-within .actions { opacity: 1; }
  @media (hover: none) {
    .actions { opacity: 1; }
  }

  .contents { list-style: none; margin: 0; padding: 0; }
  .contents > :global(li) { padding-left: calc(12px + (var(--depth) + 1) * 16px); }
  .adding { padding: 7px 12px; }
  .adding input { width: 16rem; }
  .empty {
    color: var(--ink-3);
    font-size: var(--t-base);
    padding: 8px 12px;
  }
</style>
