<script>
  // Colour, highlight, size and alignment for a rich document — everything the
  // request asked for. One drawer holding all four, which costs the toolbar a
  // single button: four separate controls is how it wrapped onto a second row
  // and orphaned one, and swatches are how a colour gets picked anyway.
  //
  // Three of the four are inline spans and the fourth is a block construct.
  // That difference is editor.js's problem, not this file's — a button here
  // names a family and a token and nothing more.
  //
  // The options come from palette.js verbatim, the same way EmojiPicker takes
  // EMOJI_GROUPS, so adding a hue there puts it here, in the allowlist and in
  // the CSS without a second edit.
  import { HUES, SIZES, ALIGNMENTS } from '../palette.js'

  let { onPick, onClose } = $props()

  // Deliberately stateless: it never reports what the cursor is already
  // wearing. That is the rule the Style and Callout menus follow, for the
  // reason recorded in editor.js — a control that looked like state but was
  // only sometimes right would be worse than one that never claims to be.
  // "None" is what removes a colour, so nothing here depends on knowing.
  const FAMILIES = [
    { family: 'c', label: 'Text colour', prefix: 'c-', swatch: 'text' },
    { family: 'h', label: 'Highlight', prefix: 'h-', swatch: 'ground' },
  ]
</script>

<div class="panel">
  <div class="head">
    <strong>Format</strong>
    <span class="note">applies to the selected text</span>
    <span class="spacer"></span>
    <button onclick={onClose}>close</button>
  </div>

  {#each FAMILIES as f (f.family)}
    <div class="group">{f.label}</div>
    <div class="row">
      <button
        class="none"
        title="Remove it"
        aria-label="{f.label}: none"
        onclick={() => onPick(f.family, null)}
      >none</button>
      {#each HUES as h (h.token)}
        <!-- The swatch is drawn in the colour it applies, which is the whole
             argument for a drawer over a dropdown: the name is a label, the
             swatch is the thing itself. -->
        <button
          class="swatch {f.swatch}"
          style="--sw: var(--doc-{f.prefix}{h.token})"
          title={h.label}
          aria-label="{f.label}: {h.label}"
          onclick={() => onPick(f.family, `${f.prefix}${h.token}`)}
        >A</button>
      {/each}
    </div>
  {/each}

  <div class="group">Size</div>
  <div class="row">
    <button
      class="none"
      title="Back to the surrounding size"
      aria-label="Size: normal"
      onclick={() => onPick('size', null)}
    >normal</button>
    {#each SIZES as s (s.token)}
      <button class="size" aria-label="Size: {s.label}" onclick={() => onPick('size', s.token)}>{s.label}</button>
    {/each}
  </div>

  <!-- The odd one out: a block property, so it takes whole lines rather than
       the selected words. Said out loud, because a control that quietly did
       something wider than the selection would read as a bug. -->
  <div class="group">Alignment <span class="note">— whole paragraphs</span></div>
  <div class="row">
    <button
      class="none"
      title="Back to ordinary left-aligned text"
      aria-label="Alignment: normal"
      onclick={() => onPick('align', null)}
    >normal</button>
    {#each ALIGNMENTS as a (a.token)}
      <button class="size" aria-label="Alignment: {a.label}" onclick={() => onPick('align', a.token)}>{a.label}</button>
    {/each}
  </div>
</div>

<style>
  /* Matches EmojiPicker, DocLinkPicker and ReadingPrefs: all four are drawers
     that open under the toolbar. */
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
  .group {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    margin: 0.5rem 0 0.2rem;
  }
  .group:first-of-type { margin-top: 0; }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
  }
  .swatch,
  .none,
  .size {
    border: 1px solid #8884;
    border-radius: 3px;
    background: none;
    cursor: pointer;
    padding: 0.15rem 0.4rem;
    font: inherit;
    line-height: 1.3;
  }
  .swatch {
    width: 1.9rem;
    text-align: center;
    font-weight: 700;
  }
  /* A text swatch shows the letter in the colour; a highlight swatch shows the
     ground with the ink that is pinned to it, which is what it will actually
     look like in the document. */
  .swatch.text { color: var(--sw); }
  .swatch.ground {
    background: var(--sw);
    color: var(--doc-h-ink);
  }
  .none,
  .size {
    font-size: 0.8rem;
    opacity: 0.85;
  }
  .swatch:hover,
  .none:hover,
  .size:hover {
    border-color: #888a;
  }
</style>
