// Links from one document to another.
//
// The only thing on the rich-documents list that needs no grammar extension
// and no flag: a document link *is* an ordinary markdown link, and the only
// thing that makes it one is where it points.
//
// It points at `#doc=<id>` — the app's own URL for that document, the same
// hash App.svelte already routes on. Three things follow, and together they
// are why that was chosen over a scheme of our own:
//
//   - It is exactly what sits in the address bar with that document open, so
//     copying the URL produces a working link with no special knowledge.
//   - Opened in a new tab it needs no interception at all: the app boots,
//     reads the hash and opens the document. Only the same-tab click needs a
//     handler, and only to avoid a full reload.
//   - It stays a plain markdown link in the exported `.md`, so nothing here
//     weakens the "it is just a markdown file" property the exporter exists
//     for. See DESIGN-DECISIONS, *Rich documents*.
//
// The id is treated as an opaque string. Its format is the server's business
// (`newDocID` — base32 of 16 random bytes, today); pinning that alphabet here
// would mean this file has to change when that one does, and buys nothing. An
// id that does not resolve already renders as unresolved, which is the same
// outcome a stricter pattern would reach by a longer route.
//
// No CodeMirror and no DOM imports, by the rule table.js set: strings in,
// strings out, so scripts/doclink_test.mjs runs it under plain node.

// The whole URL, not a search within it: a link that merely *contains* this is
// not a document link. `)` is excluded so the pattern can never run past the
// end of the link it lives in.
const DOC_URL = /^#doc=([^\s)]+)$/

// The id a URL points at, or null. Takes the URL rather than the whole link,
// so the caller decides how it came by one.
export function docLinkTarget(url) {
  const m = DOC_URL.exec(String(url).trim())
  return m ? m[1] : null
}

export const docLinkURL = (id) => `#doc=${id}`

// Split an inline link's source text into its label and its destination.
//
// Anchored at both ends rather than searching: the parser has already decided
// this run of text is a Link node, so this only has to read it, and a search
// would happily find a destination inside something else.
//
// Deliberately blind to reference links (`[text][label]`) and to a title after
// the URL (`[text](url "title")`). The first keeps its destination in another
// part of the document entirely; neither is something the picker writes. Both
// simply fail to resolve and render as ordinary links, which is correct — they
// are ordinary links.
const INLINE_LINK = /^\[(.*)\]\(([^\s)]*)\)$/s

export function linkParts(src) {
  const m = INLINE_LINK.exec(src)
  return m ? { text: m[1], url: m[2] } : null
}

// The id a Link node's source text points at, or null.
export function docLinkIn(src) {
  const parts = linkParts(src)
  return parts ? docLinkTarget(parts.url) : null
}

// Text that is about to become the label of a bracketed construct — a link
// here, an attribute span in palette.js. Both put user-chosen text between `[`
// and `]`, and an unescaped `]` in it would close the label early and spill the
// rest of the construct into the document as literal characters. Escaped
// rather than stripped, so the label keeps the text someone actually chose.
//
// `[` is escaped for a weaker reason: it cannot break the construct on its own,
// but an unescaped pair reads as a nested bracket to anything re-parsing the
// file, and the exporter's output is read by other tools. The backslash goes
// first in the class or it would escape the escapes.
//
// Lives here rather than in a module of its own because this is where it was
// first needed; it is one rule and it should stay in one place.
export const escapeBrackets = (text) => String(text ?? '').replace(/[\\[\]]/g, '\\$&')

// The inverse, for the one direction that needs it: unwrapping a construct
// back to bare text. Rewriting one *in place* keeps the label source verbatim
// and never needs this — only taking the brackets away does.
export const unescapeBrackets = (text) => String(text ?? '').replace(/\\([\\[\]])/g, '$1')

// The markdown for a link to `id` labelled `title`.
//
// The label is written into the document as text and stays text — it is not
// re-resolved against that document's current title when rendering. The
// round-trip property is worth more than freshness: a label that lives in
// SQLite rather than in the file is a construct the `.md` cannot carry, and a
// label that silently changed under its author would be a worse surprise than
// a stale one. The editor shows the current title on hover instead. See
// DESIGN-DECISIONS, *Rich documents*.
export function docLinkMarkdown(id, title) {
  return `[${escapeBrackets(title).trim() || 'Untitled'}](${docLinkURL(id)})`
}
