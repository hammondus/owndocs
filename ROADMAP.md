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
blobs. See *Comments* for why, and for the two traps.

Shipped, and this section is now complete: mentions and the in-app inbox
(schema v8), the unresolved count on each row of the document list, the
`commenter` role in the share UI, and optional notification email — two events,
submission-only to an existing relay, off unless `-smtp` is set.

Still owed, and not scheduled: signup never verifies an email address, so
notifications go to unverified ones. Fine for a small self-hosted team; worth a
second look if an instance ever runs `-signup=open`.

Not yet covered by `make test-ui`: composing a comment on a text selection.
The selection drives fine; the compose click does not produce a thread under
automation and the reason is unfound. Verify that path by hand until it is.

## Harden the login surface

The audience is trusted staff; the login page is on the public internet. These
defend the perimeter, not the colleagues — see *Threat model*.

- Deliberately not now: 2FA, email verification, password-strength rules. See
  *Threat model* for why the bar sits here.

Shipped: rate limiting and lockout on `/api/login`, per account and per source
address — see *Rate-limiting the login surface* in the design doc.

## Website, and a demo anyone can log into

Decided 2026-08-14. `site/` static pages served by nitro from its own
container, plus a demo that hands every visitor their own throwaway instance.
See *The site and the demo* in the design doc — the reasoning that matters is
why the demo isolates instead of moderating, and why the caps are bytes rather
than cells.

**Next up** — nothing else is queued ahead of it.

**Nothing is blocked.** Sessions are `<domain>/demo/<token>/`, routed on the
first path segment — reversed 2026-08-14 from the subdomain plan, see *A path
prefix per session* for why the original objection did not survive reading the
code. That retires the wildcard question rather than answering it: one A record,
one certificate, one proxy host with a custom location for `/demo`.

`tools/npm-wildcard-test.sh` is kept and is **no longer on the critical path**.
It probes the subdomain fallback, on a scratch VM, if the path prefix ever turns
out to be wrong.

Build order. Step 1 shipped 2026-10-18: `site/`, the enforced tier, and
`site_test.mjs` in `make test` — see *The enforced tier is data attributes,
not prose* for what is checked and in which direction. Step 2 shipped
2026-10-20: `make site-shots`, see *Screenshots are generated*. What is left:

3. **The demo supervisor** — a mode of the same binary. Starts `owndocs -demo`
   per visitor on a free port with a temp database, routes by path prefix,
   kills it after ~20 idle minutes and deletes the directory. With it, a
   contact address and a paragraph of acceptable use on the site, so there is
   a way to report a problem — see *What is left once it is isolated*.

Wanted with the demo, none of which exist:

- `-demo` mode: seeds the three users, and caps documents and bytes
- Caps announced in the UI, and the message naming the *real* figure beside the
  demo one — the unsaved-change banner is the shape
- A ceiling on concurrent sessions, and a per-source rate limit on creating one
- `robots.txt` and `noindex` on **`/demo/…` only** — the site itself wants
  indexing; it is the demo's abandoned scratchpads that must not surface under
  the domain
- Base-path awareness, and it is small because `api.js` is a chokepoint: every
  request already leaves through it, and `site_test.mjs` fails a raw `fetch`
  anywhere else. What remains is the prefix itself in `api.js`, the WebSocket
  URL in `provider.js`, the two share-link builders off `location.href`,
  `base: './'` in vite, and the session cookie `Path` from a new flag. See *A
  path prefix per session* for the table
- One proxy host with a custom location for `/demo`. No wildcard DNS, no
  wildcard certificate, no DNS-01

The name is settled: **Own Docs**, `owndocs` as one word wherever a name has to
be machine-readable. Decided 2026-08-14, so the site can be written against it —
see *The name* in the design doc for why the searchability objection lost.

## Search

Decided and built in stages 2026-08-14 — see *Search* in the design doc for why
the opacity was never the blocker, and for what each stage costs.

Shipped: **stage 1**, comment search (schema v9, FTS5 over `comments` kept in
step by triggers), and **stage 2**, document search from text the client posts
after decoding it (schema v10, `POST /api/docs/{id}/index`). `GET /api/search`
joins `permissions`, so a role change takes effect on the next query with no
reindexing.

**Stage 3 is deliberately not queued.** A headless indexer would need to read
every document, which is the first global-read principal in an app whose whole
authorisation story is per-document. Live with stages 1 and 2 first; `indexed_at`
on each row is there to make the staleness measurable rather than argued about.

Known and accepted, to be judged in use:

- A document nobody has opened since search shipped is not indexed
- Indexing happens on open and 15s after the last edit, so an entry can lag
- Text over 400,000 characters is indexed truncated rather than rejected

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
  rather than the text patcher — plus a third answer for the Changes view,
  since a board is neither a sequence nor a cell map (see *Comparing two
  points*)
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

Shipped: dark mode reaches the grid and charts — see *Dark mode reaches the
grid* for the canvas colour seam, and for why an author's cell background now
pins its own ink rather than following the scheme.

Still open, and deliberately not scheduled: the cell colour picker is still a
raw `<input type="color">`, so a sheet can hold arbitrary hex where a document
cannot. Pinning the ink makes that safe rather than correct. Replacing it with
the named palette is the correct fix and is a breaking change to stored sheets;
see the same entry for the argument.

Shipped: the selection readout now prints in the selection's own number format
— see *Selection readout* in the design doc.

## Sheets — tabs

- Reorder tabs by drag
- Move / copy a sheet between docs

## Sheets — formulas

Shipped: writing a formula by pointing at cells, outlining what a formula
refers to, F4 to cycle absolute forms, arrow keys in point mode, and the
formula reference drawer — see *Writing a formula by pointing* and *The formula
reference* in the design doc.

Adding a function to the engine now means adding a row to `functions.js`; the
test fails until you do, in both directions.

- Colouring the reference *text* to match its outline, which needs an input
  that can carry markup rather than a plain `<input>`

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
- Editor affordances the CodeMirror move now makes cheap: completion of the
  `docs` API, and marking a syntax error before ▶ rather than after.
  `@codemirror/autocomplete` and `@codemirror/lint` are already in the tree,
  but only transitively — either would have to be declared first, which is the
  decision, not the wiring. Not started; the editor is deliberately not an IDE.

---

## Deliberately not scheduled

Recorded so they are not re-proposed as oversights:

- **Route-level lazy loading** — measured and declined: it buys a router
  loading state to save a fraction of a second, once, on a LAN app. Design
  doc, *Static assets*.
- **Snapshot thresholds and the 1s flush interval** — revisit against real
  traffic, not in the abstract.
