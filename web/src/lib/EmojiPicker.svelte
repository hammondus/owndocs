<script>
  // The emoji the app knows about, shown as themselves so one can be picked by
  // sight rather than by remembering its name. What lands in the document is
  // the shortcode — see insertEmoji in editor.js for why.
  //
  // The list is emoji.js's `EMOJI_GROUPS` verbatim, so there is no second copy
  // of the categories and adding an entry there puts it here.
  import { EMOJI_GROUPS, searchEmoji } from '../emoji.js'

  let { onPick, onClose } = $props()

  let query = $state('')
  let results = $derived(searchEmoji(query))
  // An empty query means "show the groups"; anything else collapses to one
  // flat list, because a search that kept the headings would be mostly
  // headings with nothing under them.
  let searching = $derived(query.trim() !== '')

  // Enter picks the first match, so a name you already know is four keystrokes
  // and never needs the mouse.
  function onKey(e) {
    if (e.key === 'Escape') return onClose()
    if (e.key !== 'Enter' || !results.length) return
    e.preventDefault()
    onPick(results[0].name)
    query = ''
  }
</script>

<div class="panel">
  <div class="head">
    <strong>Emoji</strong>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      id="emoji-search"
      autofocus
      placeholder="search…"
      bind:value={query}
      onkeydown={onKey}
    />
    <span class="note">inserts the shortcode</span>
    <span class="spacer"></span>
    <button onclick={onClose}>close</button>
  </div>

  <div class="grid-scroll">
    {#if searching}
      {#if results.length}
        <div class="grid">
          {#each results as e (e.name)}
            <button class="emoji" title=":{e.name}:" aria-label=":{e.name}:" onclick={() => onPick(e.name)}>
              {e.char}
            </button>
          {/each}
        </div>
      {:else}
        <p class="note">
          Nothing called “{query}”. The list is a curated one — anything missing
          can still be typed as a shortcode, and added to <code>emoji.js</code>.
        </p>
      {/if}
    {:else}
      {#each EMOJI_GROUPS as group (group.name)}
        <div class="group">{group.name}</div>
        <div class="grid">
          {#each Object.entries(group.entries) as [name, char] (name)}
            <button class="emoji" title=":{name}:" aria-label=":{name}:" onclick={() => onPick(name)}>
              {char}
            </button>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  /* Matches ReadingPrefs: both are drawers that open under the toolbar. */
  .panel {
    border: 1px solid #8884;
    border-radius: 4px;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
    background: #8881;
  }
  .head {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    margin-bottom: 0.4rem;
  }
  .spacer {
    flex: 1;
  }
  .note {
    font-size: 0.75rem;
    opacity: 0.7;
    margin: 0.3rem 0 0;
  }
  .group {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    margin: 0.5rem 0 0.2rem;
  }
  .group:first-child {
    margin-top: 0;
  }
  /* Capped and scrolled: 242 buttons unrolled would push the editor off the
     bottom of the window every time the panel opened. */
  .grid-scroll {
    max-height: 16rem;
    overflow-y: auto;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(2.1rem, 1fr));
    gap: 0.1rem;
  }
  .emoji {
    padding: 0.15rem;
    margin: 0;
    border: 0;
    border-radius: 4px;
    background: none;
    cursor: pointer;
    /* Named explicitly for the same reason .md-emoji is: the reader's font may
       have no emoji coverage, and this panel is nothing but emoji. */
    font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
    font-size: 1.2rem;
    line-height: 1.4;
  }
  .emoji:hover {
    background: #8883;
  }
</style>
