<script>
  // Where the open document is filed, as the folders above it — each one a
  // jump back to the list with that folder in view. Drawn before the title in
  // a view bar, so the bar reads "Engineering / Runbooks / Deploy guide".
  //
  // Fetched here, on mount, rather than carried on the document row: the row
  // holds a folder id, and the names above it live in the folder list, which
  // the editor otherwise has no reason to load. One request per document
  // opened, and nothing at all for a document filed nowhere.
  //
  // A folder the viewer holds no grant on is not named. The server nulls the
  // folder id on the row in that case, so this draws nothing rather than a
  // path into somebody else's filing — see DESIGN-DECISIONS.md, *The path is
  // per viewer*.
  import { onMount } from 'svelte'
  import { api } from './api.js'
  import { pathTo } from '../folders.js'

  let { doc, onOpenFolder } = $props()

  let path = $state([])

  onMount(async () => {
    if (!doc.folder_id) return
    try {
      path = pathTo(await api('/api/folders'), doc.folder_id)
    } catch (err) {
      // The title is still there; a breadcrumb that failed to load is not
      // worth an error in front of somebody who came to read.
      console.warn('owndocs: could not load the folder path', err)
    }
  })
</script>

{#if path.length}
  <nav class="crumbs" aria-label="Folder">
    {#each path as f (f.id)}
      <button class="crumb" title="Show this folder in the list" onclick={() => onOpenFolder(f.id)}>{f.name}</button>
      <span class="sep" aria-hidden="true">/</span>
    {/each}
  </nav>
{/if}

<style>
  .crumbs {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    /* Quieter than the title it leads into: the document is the subject,
       and this is where it lives. */
    font-size: var(--t-base);
    color: var(--ink-3);
  }
  .crumb {
    border: 0;
    background: none;
    padding: 2px 4px;
    margin: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    border-radius: var(--r);
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .crumb:hover,
  .crumb:focus-visible { color: var(--ink); background: var(--surface-2); }
  .sep { user-select: none; }
</style>
