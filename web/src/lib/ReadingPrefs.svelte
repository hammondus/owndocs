<script>
  // The reading-preferences drawer. Everything here is a display choice that
  // belongs to the reader, never to the document — see prefs.js.
  import {
    FONTS, SIZES, LINE_HEIGHTS, MEASURES, DEFAULTS,
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
      <!-- A datalist rather than a select: it type-aheads through hundreds of
           families, and still accepts a name typed by hand where the browser
           will not enumerate them. -->
      <input
        id="rp-family"
        list="rp-local-fonts"
        value={prefs.family}
        style="font-family: '{prefs.family}', system-ui"
        onchange={(e) => set({ family: e.target.value })}
      />
      <datalist id="rp-local-fonts">
        {#each localFonts as f (f)}<option value={f}></option>{/each}
      </datalist>
      {#if !localFonts.length}
        <button onclick={loadLocalFonts} disabled={localState === 'loading'}>
          {localState === 'loading' ? 'asking…' : 'list my fonts'}
        </button>
      {:else}
        <span class="note">{localFonts.length} installed</span>
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

  <p class="note">
    Code stays monospace whatever you pick here — its alignment carries meaning.
  </p>
</div>

<style>
  .panel {
    border: 1px solid #d0d1d3;
    border-radius: 4px;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
    background: #fafafa;
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
