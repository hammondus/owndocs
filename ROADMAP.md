# Roadmap

Things decided but not yet built. `DESIGN-DECISIONS.md` is the *why* file —
routes considered, taken or rejected, and the reasoning. This is the *what
next* file: short lines, no argument. If an item needs a paragraph to justify
it, the paragraph belongs in the design doc and this file just points at it.

Conventions: an item is deleted from here when it ships (the design doc records
what shipped and why). Nothing lands here until it is actually decided —
undecided things stay under **Open questions** in the design doc.

---

## Comment threads

Decided: bodies, identity and resolved-state in SQLite; anchors as opaque
blobs. See *Comments* for why, and for the two traps. Build order — each step
is useful on its own:

1. Email, optional: unset SMTP config means none, and the app is whole
   without it. Two events only — mentioned, and shared-with-you. The presence
   skip and the per-(user, document) debounce belong here rather than in the
   inbox — see *Notifications* for why.
2. Share UI: offer the `commenter` role (the API takes it already)

Shipped: mentions and the in-app inbox (schema v8), and the unresolved count on
each row of the document list.

Not yet covered by `make test-ui`: composing a comment on a text selection.
The selection drives fine; the compose click does not produce a thread under
automation and the reason is unfound. Verify that path by hand until it is.

## Harden the login surface

The audience is trusted staff; the login page is on the public internet. These
defend the perimeter, not the colleagues — see *Threat model*.

- **Rate-limit and lock out** repeated failures, per account and per source
  address, on `/api/login`. `clientIP()` already resolves the source correctly
  behind the proxy; nothing consumes it yet beyond the log line.
- Deliberately not now: 2FA, email verification, password-strength rules. See
  *Threat model* for why the bar sits here.

## Kanban: a third document kind

Boards alongside docs and sheets, riding the same sync, sharing, history and
comment machinery. Nothing about the collaboration engine changes; what changes
is one more `kind` and everything that branches on it:

- `documents.kind` CHECK is `('doc','sheet')` — widening it means rebuilding
  the table, as `commenter` did (schema v5)
- A `KanbanView`, and the routing in `App.svelte` that picks a view
- Columns and cards in Yjs: fractional-index order, exactly as sheet rows and
  columns already do, so concurrent inserts merge without coordination
- History: a board preview renderer, and a `restoreFrom` like `Workbook`'s
  rather than the text patcher
- Git exporter: it skips any kind it has no text serialization for

A card **is** a document, and inherits the board's access — decided, see
*Kanban* for why and for what it costs. That adds:

- `documents.parent_id`, `ON DELETE CASCADE`, and `roleFor` falling back to the
  parent's permissions — derived, never copied
- `handleListDocs` filtered to `parent_id IS NULL`, or a 20-card board buries
  the list
- The share UI saying that sharing a board shares every card in it

Comments on the board itself need no new mechanism — a card carries a stable
id, so the anchor is `{k:'card', card, quote}` in the envelope that already
exists. A comment *inside* a card is just a document comment.

**Templates**, wanted concretely (a "new staff member" template producing a
15–20 card induction board): a board flagged as a template, instantiated by
copying the board and every card document. Decide the copy strategy and
whether template variables are substituted — see *Open questions*, since the
second answer settles the first.

## Document formatting: what markdown can and cannot express

Mostly done now; kept as the reference for where the line falls. The constraint
that shapes all of it: **the document is plain markdown text**, so anything
here has to survive a round trip through a `.md` file the git exporter writes,
and be decoratable from the CodeMirror syntax tree. That second part was the
real cost driver — `@codemirror/lang-markdown` parses CommonMark + GFM, and
anything beyond it needs a Lezer parser extension before it can be styled at
all. Five of those were written: highlight, definition lists, footnotes, and —
for rich documents — attribute spans and fenced divs.

### Already shipped

Bold, italic, strikethrough, inline code, H1–H6, bullet lists, numbered lists,
nested lists, task lists, blockquotes, links, images, tables (rendered as real
HTML tables, with writable column alignment), fenced code blocks with syntax
highlighting, horizontal rules, hard line breaks, `==highlight==`, superscript
and subscript, `:emoji:` shortcodes, `> [!NOTE]` callouts, definition lists,
footnotes.

Everything above is plain text that survives the round trip through the `.md`
file the exporter writes. See *The plain-markdown constructs*, *The extended
constructs* and *Footnotes* in the design doc for what each one cost.

Also shipped, and *not* part of the document: a table of contents built from
the headings, and an emoji picker. Both are display, and live with the reading
preferences — see *Formatting*.

### Still open — each needs a real dependency

- **Math** — `$…$` / `$$…$$`, needs KaTeX or MathJax
- **Mermaid diagrams** in a fenced block — likewise a real dependency

Nothing else in markdown is unsupported by accident. Anything not listed here
is either shipped or in *Not expressible in markdown at all* below.

Emoji ships a **curated** shortcode table (242 entries), not the full ~1800.
An unknown shortcode stays literal text; adding one is a line in `emoji.js`.

### Not expressible in markdown at all

Markdown encodes **meaning**, not **appearance**. These are appearance, and
none of them has a text representation:

- Font family
- Arbitrary font size (headings give six semantic sizes; nothing else)
- Text colour, background colour beyond a highlight convention
- Paragraph alignment — centred or right-aligned body text
- Line spacing, indentation, margins, columns, page breaks
- Letter spacing, small caps

**Decided: semantic constructs only, in the plain document.** No escape hatch,
no arbitrary styling. Markdown says what a thing *is*; how it looks is settled
elsewhere — see *Formatting* in the design doc.

**Amended 2026-08-13, and shipped.** Colour, size, highlight colour and
alignment are available in a document flagged *rich*, via Pandoc's bracketed
span and fenced div. The plain type is unchanged, and the flag exists to keep
it that way. Font family, line spacing, margins, columns and page breaks stay
out of both — page layout is what would have forced a second renderer, and
ruling it out is what made the browser's own print a real PDF export. See
*Rich documents: what was asked for* and the six sections after it in the
design doc; the open questions underneath it are in *Open questions*.

## Sheets — formatting

- Borders
- Merged cells
- Conditional formatting
- Font size / family
- Selection readout in the selection's own number format — a column of
  currency totals as a bare number today, because the bar prints with the
  engine's plain `fmtNum` rather than resolving a format the whole range
  agrees on

## Sheets — tabs

- Reorder tabs by drag
- Move / copy a sheet between docs

## Sheets — copy, paste and fill

- Double-click the fill handle to fill down
- Weekday / month-step series
- Paste-special (values only, formats only, formulas only)

## Sheets — charts

- Scatter, area, stacked variants
- Pick a range by dragging, not select-first

## Export

- xlsx (CSV shipped; see *CSV export*)

## Scripting

- Runner scheduling: `cmd/runner` is invoked once per document per script and
  leaves scheduling to cron. Give it a schedule of its own, and edit-watching.

---

## Deliberately not scheduled

Recorded so they are not re-proposed as oversights:

- **Search** — needs a client-fed index, since the server never reads document
  content. Deferred until actually wanted.
- **Route-level lazy loading** — measured and declined: it buys a router
  loading state to save a fraction of a second, once, on a LAN app. Design
  doc, *Static assets*.
- **Snapshot thresholds and the 1s flush interval** — revisit against real
  traffic, not in the abstract.
