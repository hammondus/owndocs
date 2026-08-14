// Client side of document search — stage 2 in DESIGN-DECISIONS.md, *Search*.
//
// The server never parses a Yjs update. A client that has already decoded the
// document extracts its text and posts it, authorised by the same role check
// that let it read. Nothing new is granted to anybody: this can only ever index
// what its poster could already open.
//
// Extraction mirrors `scripts/exporter.mjs` rather than reinventing a second
// answer to "what is the text of this document" — the exporter renders markdown
// for documents and CSV per tab for sheets, and those are the same strings a
// person would be searching for.
import { Workbook } from './sheet/model.js'
import { toCSV } from './sheet/clipboard.js'
import { api } from './lib/api.js'

// The server's readJSON caps a body at 1 MiB. Truncating well under that keeps
// a large sheet *partly* searchable instead of failing the whole request —
// half an index beats a 400 nobody sees. Cut on a character boundary, since a
// mid-codepoint slice would corrupt the tail token.
export const MAX_INDEX_CHARS = 400_000

// Wait for typing to stop rather than indexing every keystroke: extraction
// walks the whole document, and the index only has to be roughly current.
const IDLE_MS = 15_000

export function extractText(ydoc, kind) {
  if (kind !== 'sheet') return ydoc.getText('text').toString()

  // Tab names are searchable too — "the Q3 tab" is a thing people remember.
  // Displayed values rather than raw, for the same reason the exporter uses
  // them: nobody searches for a date serial.
  const wb = new Workbook(ydoc)
  const parts = []
  for (const tab of wb.list()) {
    parts.push(tab.name)
    parts.push(toCSV(wb.sheet(tab.id).toGrid()))
  }
  return parts.join('\n')
}

export function clamp(text, max = MAX_INDEX_CHARS) {
  if (text.length <= max) return text
  // `slice` counts UTF-16 code units, not characters, so cutting at `max` can
  // land between the two halves of an astral codepoint and leave a lone
  // surrogate — which serializes as U+FFFD and gets indexed as a term that
  // matches nothing. Step back one unit when that is what happened.
  const end = isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max
  return text.slice(0, end)
}

const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff

// One indexer per open document. Returns a stop function, because a view that
// unmounts must not post for a document the person has navigated away from.
export function makeIndexer(docId, kind, ydoc) {
  let timer = null
  let stopped = false
  let last = null

  const send = async () => {
    timer = null
    if (stopped) return
    const body = clamp(extractText(ydoc, kind))
    // Nothing changed since the last post — skip the round trip. Two people
    // editing together would otherwise both re-post identical text on every
    // idle window.
    if (body === last) return
    try {
      await api(`/api/docs/${docId}/index`, { method: 'POST', body: JSON.stringify({ body }) })
      last = body
    } catch (e) {
      // Search being stale is not worth interrupting anybody over; the next
      // idle window tries again.
      console.warn('owndocs: could not index this document for search', e)
    }
  }

  const bump = () => {
    if (stopped || timer) return
    timer = setTimeout(send, IDLE_MS)
  }

  ydoc.on('update', bump)
  return {
    // Called once the document has finished syncing, so the first index is of
    // the whole document rather than of whatever had arrived by then.
    onSynced: send,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      ydoc.off('update', bump)
    },
  }
}
