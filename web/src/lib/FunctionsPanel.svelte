<script>
  // What a formula may contain, listed from the engine's own registry — see
  // functions.js, and the test that fails if the two ever disagree.
  //
  // Clicking a row starts that function in the selected cell rather than
  // copying text somewhere: the reason to open this panel is to try something,
  // and "now type it out" is the step worth removing.
  import { FUNCTION_DOCS, SYNTAX_NOTES, documented } from '../sheet/functions.js'

  let { onPick, onClose, readOnly = false } = $props()

  let query = $state('')

  let groups = $derived.by(() => {
    const q = query.trim().toLowerCase()
    if (!q) return FUNCTION_DOCS
    return FUNCTION_DOCS
      .map((g) => ({
        ...g,
        // Name first, then the description — somebody typing "date" wants
        // DATE before they want everything that mentions a date.
        items: g.items.filter((f) => f.name.toLowerCase().includes(q) || f.help.toLowerCase().includes(q)),
      }))
      .filter((g) => g.items.length)
  })

  let total = $derived(documented().length)
  let shown = $derived(groups.reduce((n, g) => n + g.items.length, 0))
</script>

<div class="panel">
  <div class="head">
    <strong>Formulas</strong>
    <!-- svelte-ignore a11y_autofocus -->
    <input id="fn-search" autofocus placeholder="search…" bind:value={query} />
    <span class="note">{shown === total ? `${total} available` : `${shown} of ${total}`}</span>
    <span class="spacer"></span>
    <button onclick={onClose}>close</button>
  </div>

  <div class="list-scroll">
    {#each groups as g (g.group)}
      <div class="group">{g.group}</div>
      {#each g.items as f (f.name)}
        <!-- The whole row is the control when it can be: on a read-only sheet
             there is nothing to insert into, so it stays a plain listing
             rather than a button that does nothing. -->
        <svelte:element
          this={readOnly ? 'div' : 'button'}
          class="row"
          role={readOnly ? 'listitem' : undefined}
          onclick={readOnly ? undefined : () => onPick(f)}
        >
          <span class="sig"><b>{f.name}</b>{f.args}</span>
          <span class="help">{f.help}</span>
          <code class="eg">{f.eg}</code>
        </svelte:element>
      {/each}
    {/each}

    {#if !query.trim()}
      <div class="group">Writing formulas</div>
      {#each SYNTAX_NOTES as n (n.what)}
        <div class="row plain">
          <span class="sig"><b>{n.what}</b></span>
          <span class="help">{n.help}</span>
          <code class="eg">{n.eg}</code>
        </div>
      {/each}
    {/if}

    {#if !shown}
      <p class="note empty">Nothing called “{query}”.</p>
    {/if}
  </div>
</div>

<style>
  /* Matches the other drawers. */
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
  .spacer { flex: 1; }
  .note {
    font-size: 0.75rem;
    opacity: 0.7;
  }
  .empty { margin: 0.4rem 0 0.2rem; }
  .list-scroll {
    max-height: 20rem;
    overflow-y: auto;
  }
  .group {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    margin: 0.5rem 0 0.2rem;
  }
  .group:first-child { margin-top: 0; }
  .row {
    display: grid;
    grid-template-columns: 13rem 1fr auto;
    gap: 0.5rem;
    align-items: baseline;
    width: 100%;
    padding: 0.25rem 0.4rem;
    border: 0;
    border-radius: 3px;
    background: none;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }
  .row.plain { cursor: default; }
  .row:not(.plain):hover,
  .row:not(.plain):focus-visible { background: #8883; }
  .sig { white-space: nowrap; }
  .help {
    opacity: 0.8;
    font-size: 0.85em;
  }
  .eg {
    font-family: var(--mono);
    font-size: 0.8em;
    opacity: 0.7;
    white-space: nowrap;
  }
  /* Below this the three columns cannot all fit, and a wrapped signature is
     harder to scan than a stacked row. */
  @media (max-width: 52rem) {
    .row {
      grid-template-columns: 1fr;
      gap: 0.1rem;
    }
  }
</style>
