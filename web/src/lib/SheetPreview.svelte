<script>
  // A read-only rendering of a workbook, used by version history to show
  // what a sheet looked like at a past point.
  //
  // Deliberately an HTML table rather than the canvas grid: a preview needs
  // no scrolling, selection, editing or virtualization, and a table is
  // selectable and copyable for free. Cell text and formatting come from
  // the same model methods the live grid uses, so what you see here is what
  // you would get back.
  import { Workbook } from '../sheet/model.js'
  import { colName } from '../sheet/engine.js'
  import { formatCss } from '../sheet/format.js'

  let { ydoc } = $props()

  // Big sheets would build an enormous DOM for no benefit — a preview is
  // for recognising a version, not reading all of it.
  const MAX_ROWS = 200
  const MAX_COLS = 40

  // $derived.by re-runs whenever ydoc changes, i.e. when a different point
  // in the timeline is selected.
  let workbook = $derived(new Workbook(ydoc))
  let tabs = $derived(workbook.list())
  let activeId = $state(null)

  // The chosen tab, falling back to the first whenever the selection is not
  // in this version (a tab may not have existed yet at this point).
  let current = $derived(tabs.find((t) => t.id === activeId) || tabs[0])

  let view = $derived.by(() => {
    if (!current) return null
    const m = workbook.sheet(current.id)
    const rows = Math.min(m.rowCount(), MAX_ROWS)
    const cols = Math.min(m.colCount(), MAX_COLS)
    const grid = []
    for (let r = 0; r < rows; r++) {
      const row = []
      for (let c = 0; c < cols; c++) {
        const d = m.display(r, c)
        row.push({ text: d.text, css: `text-align:${d.align};` + formatCss(d.fmt) })
      }
      grid.push(row)
    }
    return {
      grid, cols,
      charts: m.charts().length,
      truncated: m.rowCount() > rows || m.colCount() > cols,
      empty: m.rowCount() === 0 || m.colCount() === 0,
    }
  })
</script>

{#if tabs.length > 1}
  <div class="tabs">
    {#each tabs as tab (tab.id)}
      <button class:active={current && tab.id === current.id} onclick={() => (activeId = tab.id)}>
        {tab.name}
      </button>
    {/each}
  </div>
{/if}

{#if view === null || view.empty}
  <p class="hint">This sheet was empty at that point.</p>
{:else}
  {#if view.charts > 0}
    <p class="note">{view.charts} chart{view.charts === 1 ? '' : 's'} on this sheet (not shown in preview)</p>
  {/if}
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th></th>
          {#each { length: view.cols } as _, c}<th>{colName(c)}</th>{/each}
        </tr>
      </thead>
      <tbody>
        {#each view.grid as row, r}
          <tr>
            <th>{r + 1}</th>
            {#each row as cell}<td style={cell.css}>{cell.text}</td>{/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if view.truncated}
    <p class="note">Preview truncated to {MAX_ROWS} rows × {MAX_COLS} columns.</p>
  {/if}
{/if}

<style>
  .tabs {
    display: flex;
    gap: 2px;
    margin-bottom: 0.4rem;
    flex-wrap: wrap;
  }
  .tabs button {
    font-size: 0.8rem;
    padding: 2px 8px;
  }
  .tabs button.active {
    font-weight: 600;
    box-shadow: inset 0 -2px 0 var(--signal);
  }
  .scroll {
    overflow: auto;
    max-height: 70vh;
    border: 1px solid var(--line-strong);
  }
  table {
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  th,
  td {
    border: 1px solid var(--line);
    padding: 1px 5px;
    white-space: nowrap;
    max-width: 18rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  th {
    background: var(--surface-2);
    color: var(--ink-2);
    font-weight: 500;
    position: sticky;
    top: 0;
  }
  tbody th {
    left: 0;
    text-align: right;
  }
  .hint,
  .note {
    opacity: 0.6;
    font-size: 0.85rem;
  }
</style>
