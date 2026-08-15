<script>
  // Scripts: a list on the left, the editor filling the rest, output below.
  // One component for both places it appears — the sheet's drawer and the
  // standalone window — because the difference between them is a height and
  // two buttons, and two copies of this would drift.
  //
  // `standalone` says which: in the drawer the pane is a fixed-height block
  // above the grid, popped out it fills the window. Everything else is shared.
  import { onDestroy } from 'svelte'
  import { runScript } from '../sheet/sandbox.js'
  import { handleCall } from '../sheet/scriptapi.js'
  import { mountScriptEditor } from '../scripteditor.js'

  let { workbook, readOnly, standalone = false, onClose = null, onPopOut = null } = $props()

  let scripts = $state([])
  let selectedId = $state(null)
  let output = $state([])
  let running = $state(false)
  let unsaved = $state(false)

  let editorEl = $state(null)
  let editor = null
  let mountedFor = null // the script id the editor currently holds

  // Falling back to the first script means a collaborator deleting the one you
  // had selected leaves you on a valid script rather than a blank pane.
  let current = $derived(scripts.find((s) => s.id === selectedId) || scripts[0] || null)

  $effect(() => {
    const refresh = () => { scripts = workbook.listScripts() }
    refresh()
    return workbook.onChange(refresh)
  })

  // Mount once per selected script, and push a collaborator's change into the
  // buffer without remounting. Remounting on every keystroke-driven refresh
  // would lose the cursor; remounting only on an id change keeps it.
  $effect(() => {
    if (!editorEl || !current) return
    if (mountedFor === current.id) {
      // Same script, new text from elsewhere. setCode is a no-op when the text
      // already matches, which it does for the echo of our own save.
      //
      // Never while there are unsaved edits, and this is not a nicety: this
      // effect re-runs on ANY document change, including one this pane just
      // made itself — ticking "run on edit" writes the script object, which
      // wakes the effect, which would push the last *saved* code back over
      // what is being typed. It cost a UI-test failure that looked like a
      // sandbox bug (a script that ran the worked example instead of the code
      // on screen) before it was this. In a genuine conflict with a
      // collaborator the buffer still wins, which matches the storage model:
      // whole-object writes, last one through the relay is the survivor.
      if (!editor?.hasUnsaved()) editor?.setCode(current.code)
      return
    }
    // Switching away: whatever is pending belongs to the OLD script, so it has
    // to land before the buffer is replaced.
    editor?.destroy()
    const id = current.id
    mountedFor = id
    editor = mountScriptEditor({
      parent: editorEl,
      code: current.code,
      readOnly,
      onSave: (code) => workbook.updateScript(id, { code }),
      onDirty: (d) => (unsaved = d),
    })
  })

  onDestroy(() => { editor?.destroy(); editor = null })

  const SAMPLE = `// 'docs' is the sheet API; every call is async.
const used = await docs.usedRange()
log('used range:', used && used.range)

const rows = await docs.get('A1:B3')
log('values:', rows)

await docs.set('D1', [['from', 'a script']])
await docs.format('D1:E1', { b: 1 })
`

  function create() {
    editor?.flush()
    const s = workbook.addScript(`Script ${scripts.length + 1}`, SAMPLE)
    scripts = workbook.listScripts()
    selectedId = s.id
  }

  function remove() {
    if (!current || !confirm(`Delete "${current.name}"?`)) return
    workbook.removeScript(current.id)
    scripts = workbook.listScripts()
    selectedId = null // `current` falls back to the first remaining script
  }

  function select(id) {
    editor?.flush() // the pending edit belongs to the script we are leaving
    selectedId = id
  }

  async function run() {
    if (!current || running) return
    // Run what is on screen, not what the last pause happened to save. Without
    // this, ▶ within 800ms of a keystroke runs the previous version — the kind
    // of thing that costs an hour before you suspect the editor.
    editor?.flush()
    running = true
    output = [`▶ ${current.name}`]
    const started = Date.now()
    const result = await runScript(current.code, {
      workbook,
      dispatch: handleCall,
      onLog: (line) => { output = [...output, line] },
    })
    output = [...output, result.error
      ? `✕ ${result.error}`
      : `✓ finished in ${Date.now() - started}ms`]
    running = false
  }

  // Metadata edits merge into the stored `{id, name, code}`, so a pending code
  // edit has to land first or the merge writes the previous code back — the
  // save that follows would fix it, but between the two the document holds a
  // version nobody typed, and an on-edit trigger could run it.
  function patch(fields) {
    editor?.flush()
    workbook.updateScript(current.id, fields)
  }

  function popOut() {
    editor?.flush() // the other window syncs from the document, not from here
    onPopOut?.()
  }
</script>

<div class="pane" class:standalone>
  <div class="head">
    <strong>Scripts</strong>
    {#if unsaved}<span class="dirty" title="Unsaved edits; saved a moment after you stop typing">●</span>{/if}
    <span class="spacer"></span>
    {#if !readOnly}
      <button onclick={run} disabled={!current || running}>
        {running ? 'running…' : '▶ run'}
      </button>
    {/if}
    {#if onPopOut}
      <button aria-label="Pop out scripts" onclick={popOut} title="Open the editor in its own window, so the sheet stays visible">⧉ pop out</button>
    {/if}
    <!-- Labelled, because the drawer's glyph is a bare × and the sheet toolbar
         has its own × a few pixels away (clear background). Two controls that
         read identically to anything addressing them by text. -->
    {#if onClose}<button aria-label="Close scripts" onclick={onClose}>{standalone ? 'close' : '×'}</button>{/if}
  </div>

  <div class="body">
    <ul class="list">
      {#each scripts as s (s.id)}
        <li>
          <button
            class="item"
            class:sel={current?.id === s.id}
            onclick={() => select(s.id)}
          >
            <span class="nm">{s.name}</span>
            <!-- A trigger is a property of the script that matters when you are
                 NOT looking at it, so it belongs in the list, not only on the
                 selected script's row. -->
            {#if s.trigger === 'onEdit'}<span class="trig" title="Runs automatically after you edit a cell">auto</span>{/if}
          </button>
        </li>
      {/each}
      {#if !readOnly}
        <li><button class="item new" onclick={create}>+ new script</button></li>
      {/if}
    </ul>

    <div class="main">
      {#if current}
        <div class="row">
          <input
            class="name"
            value={current.name}
            readonly={readOnly}
            onchange={(e) => patch({ name: e.target.value })}
          />
          <!-- The binding lives in the document (it is part of what the sheet
               IS), but whether this machine honours it is a separate, local
               decision made the first time a trigger would fire. -->
          <label title="Run automatically after you edit a cell in this document">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={current.trigger === 'onEdit'}
              onchange={(e) => patch({ trigger: e.target.checked ? 'onEdit' : null })}
            />
            run on edit
          </label>
          {#if !readOnly}<button onclick={remove}>delete</button>{/if}
        </div>
        {#if current.trigger === 'onEdit'}
          <p class="note">
            Runs on your own edits only, never on a collaborator's, and never on
            its own writes. The script receives <code>event</code> with the sheet
            and range that changed. Held while this editor is open.
          </p>
        {/if}
        <div class="editor" bind:this={editorEl}></div>
      {:else}
        <p class="hint">No scripts yet. “+ new script” creates one with a worked example.</p>
      {/if}
    </div>
  </div>

  {#if output.length}
    <pre class="out">{output.join('\n')}</pre>
  {/if}
</div>

<style>
  /* Tokens, not hex — a pinned light panel stayed white in a dark app. */
  .pane {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
    background: var(--surface-2);
    /* In the drawer the pane is a fixed block above the grid: tall enough to
       be worth using, short enough that the sheet is still the page. */
    height: 22rem;
  }
  /* Popped out there is nothing else on the page, so it takes the window and
     the editor grows with it — which is the entire reason the window exists. */
  .pane.standalone {
    height: 100%;
    margin-bottom: 0;
    border: 0;
    border-radius: 0;
  }
  .head {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    margin-bottom: 0.4rem;
    flex: none;
  }
  .spacer { flex: 1; }
  /* Signal, not danger: unsaved is a state, not a problem. */
  .dirty { color: var(--signal); font-size: 0.7rem; }

  /* The two panes. `min-height: 0` is what lets them scroll instead of
     growing the flex parent — without it the editor pushes the output off. */
  .body {
    display: flex;
    gap: 0.5rem;
    flex: 1;
    min-height: 0;
  }
  .list {
    flex: none;
    width: 11rem;
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-y: auto;
    border-right: 1px solid var(--line);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    border-radius: var(--r);
    padding: 3px 6px;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    color: var(--ink);
  }
  .item:hover { background: var(--surface-3, rgba(128, 128, 128, 0.12)); }
  .item.sel { background: var(--signal-tint); font-weight: 600; }
  .nm {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trig {
    flex: none;
    font-size: 0.65rem;
    opacity: 0.75;
    border: 1px solid var(--line);
    border-radius: 2px;
    padding: 0 3px;
  }
  .item.new { opacity: 0.7; }

  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.25rem;
    flex: none;
  }
  .row label {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    white-space: nowrap;
    font-size: 0.8rem;
  }
  .name {
    flex: 1;
    min-width: 0;
    font-size: 0.85rem;
  }
  .note {
    margin: 0 0 0.25rem;
    font-size: 0.75rem;
    opacity: 0.7;
    flex: none;
  }
  /* The editor is the thing that should grow. CodeMirror sizes to its host, so
     the host is what carries the flex — and `min-height: 0` again, or a long
     script makes the pane taller instead of scrolling inside it. */
  .editor {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 3px;
    background: var(--surface);
  }
  .editor :global(.cm-editor) { height: 100%; }
  .editor :global(.cm-scroller) {
    overflow: auto;
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .editor :global(.cm-focused) { outline: none; }

  /* Pinned dark in both schemes on purpose, following .md-highlight: this is a
     console, and console output is light-on-dark wherever you find it. Ground
     and ink are a pair, so neither may be tokenised on its own. */
  .out {
    margin: 0.4rem 0 0;
    padding: 0.4rem;
    max-height: 10rem;
    flex: none;
    overflow: auto;
    background: #202124;
    color: #e8eaed;
    border-radius: 3px;
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap;
  }
  .hint {
    opacity: 0.6;
    font-size: 0.85rem;
  }
</style>
