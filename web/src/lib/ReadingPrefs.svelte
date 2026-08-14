<script>
  // The reading-preferences drawer. Everything here is a display choice that
  // belongs to the reader, never to the document — see prefs.js.
  import {
    THEMES, FONTS, SIZES, LINE_HEIGHTS, MEASURES, TOC_SIDES, TOC_DEPTHS, DEFAULTS,
    load, save, apply, listLocalFonts, localFontsSupported,
  } from '../prefs.js'

  let { onChanged, onClose } = $props()

  let prefs = $state(load())

  // One place to persist, apply and notify, so no control below has to
  // remember all three. onChanged is what lets CodeMirror re-measure: line
  // heights change with size and family, and it does not find out on its own.
  function set(patch) {
    prefs = { ...prefs, ...patch }
    save(prefs)
    apply(prefs)
    onChanged()
  }

  function reset() {
    set({ ...DEFAULTS })
  }

  // The fonts installed on this machine, once the reader asks for them. The
  // browser prompts for permission, so this must run from a click — hence a
  // button rather than loading the list when the panel opens.
  let localFonts = $state([])
  let localState = $state('') // '' | 'loading' | 'denied' | 'unsupported'

  // The chosen family may not be among the enumerated ones — typed by hand
  // before the list was loaded, or installed on another machine — so it is
  // added rather than silently dropped, which would leave the select showing
  // someone else's font.
  let families = $derived(
    prefs.family && !localFonts.includes(prefs.family)
      ? [prefs.family, ...localFonts]
      : localFonts,
  )

  async function loadLocalFonts() {
    localState = 'loading'
    const fonts = await listLocalFonts()
    if (!fonts) {
      localState = localFontsSupported() ? 'denied' : 'unsupported'
      return
    }
    localFonts = fonts
    localState = ''
  }
</script>

<div class="panel">
  <div class="head">
    <strong>Reading</strong>
    <span class="note">yours only — never saved in the document</span>
    <span class="spacer"></span>
    <button onclick={reset}>reset</button>
    <button onclick={onClose}>close</button>
  </div>

  <!-- Theme sits in its own row above the rest, and says so: everything below
       it dresses the document, while this dresses the whole application. Same
       kind of preference, wider blast radius. -->
  <div class="row">
    <label for="rp-theme">Theme</label>
    <select id="rp-theme" value={prefs.theme} onchange={(e) => set({ theme: e.target.value })}>
      {#each THEMES as t (t.value)}<option value={t.value}>{t.label}</option>{/each}
    </select>
    <span class="note">System follows your device. Printing is always light.</span>
  </div>

  <div class="row">
    <label for="rp-font">Font</label>
    <select
      id="rp-font"
      value={prefs.family ? 'custom' : prefs.font}
      onchange={(e) =>
        e.target.value === 'custom'
          ? set({ family: prefs.family || 'Georgia' })
          : set({ font: e.target.value, family: '' })}
    >
      {#each FONTS as f (f.id)}<option value={f.id}>{f.label}</option>{/each}
      <option value="custom">Choose a font…</option>
    </select>

    <label for="rp-size">Size</label>
    <select id="rp-size" value={prefs.size} onchange={(e) => set({ size: Number(e.target.value) })}>
      {#each SIZES as s (s)}<option value={s}>{s}px</option>{/each}
    </select>

    <label for="rp-lh">Line height</label>
    <select id="rp-lh" value={prefs.lineHeight} onchange={(e) => set({ lineHeight: Number(e.target.value) })}>
      {#each LINE_HEIGHTS as l (l)}<option value={l}>{l}</option>{/each}
    </select>

    <label for="rp-measure">Width</label>
    <select id="rp-measure" value={prefs.measure} onchange={(e) => set({ measure: Number(e.target.value) })}>
      {#each MEASURES as m (m.value)}<option value={m.value}>{m.label}</option>{/each}
    </select>
  </div>

  {#if prefs.family}
    <div class="row">
      <label for="rp-family">Family</label>
      {#if localFonts.length}
        <!-- A real select once the list is known. A datalist was the first
             attempt and is the wrong control here: the browser filters it by
             whatever is already in the field, so choosing a font left that one
             font as the only visible option until the text was cleared by
             hand. A select always shows everything.
             Each option is drawn in its own family, which is the whole reason
             anyone opens this list. -->
        <select
          id="rp-family"
          value={prefs.family}
          onchange={(e) => set({ family: e.target.value })}
        >
          {#each families as f (f)}
            <option value={f} style="font-family: '{f}', system-ui">{f}</option>
          {/each}
        </select>
        <span class="note">{localFonts.length} installed</span>
      {:else}
        <!-- Before the list is known — or where the browser will not give it —
             a typed name works just as well, given you know what it is called. -->
        <input
          id="rp-family"
          value={prefs.family}
          style="font-family: '{prefs.family}', system-ui"
          onchange={(e) => set({ family: e.target.value })}
        />
        <button onclick={loadLocalFonts} disabled={localState === 'loading'}>
          {localState === 'loading' ? 'asking…' : 'list my fonts'}
        </button>
      {/if}
    </div>
    {#if localState === 'denied'}
      <p class="note">
        Font access was declined. Type a family name instead — it works just as
        well, you just have to know what it is called.
      </p>
    {:else if localState === 'unsupported'}
      <p class="note">
        This browser will not list installed fonts (only Chrome and Edge do, on
        a secure connection). Type a family name instead.
      </p>
    {/if}
  {/if}

  <div class="row">
    <label for="rp-toc">Contents</label>
    <select id="rp-toc" value={prefs.toc} onchange={(e) => set({ toc: e.target.value })}>
      {#each TOC_SIDES as s (s.value)}<option value={s.value}>{s.label}</option>{/each}
    </select>

    <!-- Only worth showing once there is a panel to apply it to. -->
    {#if prefs.toc !== 'off'}
      <label for="rp-toc-depth">Down to</label>
      <select
        id="rp-toc-depth"
        value={prefs.tocDepth}
        onchange={(e) => set({ tocDepth: Number(e.target.value) })}
      >
        {#each TOC_DEPTHS as d (d)}<option value={d}>{d === 1 ? 'H1 only' : `H1–H${d}`}</option>{/each}
      </select>
    {/if}
  </div>

  <p class="note">
    Code stays monospace whatever you pick here — its alignment carries meaning.
    Contents are built from the headings in the document, and add nothing to it.
  </p>
</div>

<style>
  /* Tokens, not hex. This panel is where the theme is chosen, so a pinned
     light background here was the one that showed up hardest — it stayed a
     white card in a dark application. */
  .panel {
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
    background: var(--surface-2);
  }
  .head {
    display: flex;
    gap: 0.35rem;
    align-items: baseline;
    margin-bottom: 0.4rem;
  }
  .spacer {
    flex: 1;
  }
  .row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .row label {
    font-size: 0.8rem;
    opacity: 0.75;
  }
  .note {
    font-size: 0.75rem;
    opacity: 0.7;
    margin: 0.3rem 0 0;
  }
</style>
