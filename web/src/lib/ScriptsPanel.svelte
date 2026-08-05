<script>
  // The scripts drawer: pick or create a script, edit it, run it, read the
  // output. The editor is a plain textarea on purpose — a JavaScript mode
  // for CodeMirror is another dependency, and this is a place to write
  // twenty lines of automation, not an IDE.
  import { runScript } from '../sheet/sandbox.js'
  import { handleCall } from '../sheet/scriptapi.js'

  let { workbook, readOnly, onClose } = $props()

  let scripts = $state([])
  let selectedId = $state(null)
  let output = $state([])
  let running = $state(false)

  // Falling back to the first script means a collaborator deleting the one
  // you had selected leaves you on a valid script rather than a blank pane,
  // without the effect below ever having to write the selection back.
  let current = $derived(scripts.find((s) => s.id === selectedId) || scripts[0] || null)

  // Load the list, and keep it current — a collaborator may add, rename or
  // delete a script while the drawer is open.
  $effect(() => {
    const refresh = () => { scripts = workbook.listScripts() }
    refresh()
    return workbook.onChange(refresh)
  })

  const SAMPLE = `// 'docs' is the sheet API; every call is async.
const used = await docs.usedRange()
log('used range:', used && used.range)

const rows = await docs.get('A1:B3')
log('values:', rows)

await docs.set('D1', [['from', 'a script']])
await docs.format('D1:E1', { b: 1 })
`

  function create() {
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

  async function run() {
    if (!current || running) return
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
</script>

<div class="panel">
  <div class="head">
    <strong>Scripts</strong>
    <select
      value={current?.id ?? ''}
      disabled={!scripts.length}
      onchange={(e) => (selectedId = e.target.value)}
    >
      {#each scripts as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
    </select>
    {#if !readOnly}
      <button onclick={create}>new</button>
      <button onclick={run} disabled={!current || running}>
        {running ? 'running…' : '▶ run'}
      </button>
      <button onclick={remove} disabled={!current}>delete</button>
    {/if}
    <span class="spacer"></span>
    <button onclick={onClose}>close</button>
  </div>

  {#if current}
    <input
      class="name"
      value={current.name}
      readonly={readOnly}
      onchange={(e) => workbook.updateScript(current.id, { name: e.target.value })}
    />
    <!-- Committed on blur rather than per keystroke: a script is edited in
         bursts, and one Yjs update per character would flood the log. -->
    <textarea
      spellcheck="false"
      readonly={readOnly}
      value={current.code}
      onchange={(e) => workbook.updateScript(current.id, { code: e.target.value })}
    ></textarea>
  {:else}
    <p class="hint">No scripts yet. “new” creates one with a worked example.</p>
  {/if}

  {#if output.length}
    <pre class="out">{output.join('\n')}</pre>
  {/if}
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
    align-items: center;
    margin-bottom: 0.4rem;
  }
  .spacer {
    flex: 1;
  }
  .name {
    width: 100%;
    margin-bottom: 0.25rem;
    font-size: 0.85rem;
  }
  textarea {
    width: 100%;
    height: 11rem;
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    resize: vertical;
  }
  .out {
    margin: 0.4rem 0 0;
    padding: 0.4rem;
    max-height: 10rem;
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
