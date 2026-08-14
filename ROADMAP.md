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

Decided 2026-08-14. `site/` static pages served by nginx from its own
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

Build order. Steps 1 and 2 are useful without 3, and are not blocked by it:

1. **`site/`** — what it is, how to host it, and the self-hosting instructions
   that today only exist in `README.md`. Static, no build step. Enforced claims
   carry `data-` attributes; see *The enforced tier* for the mechanism and the
   registry order.
2. **`make site-shots`** — the images the site uses, driven through the real
   app by the `ui_test.mjs` harness. Locks the sync property in while the site
   is small enough to retrofit cheaply.
3. **The demo supervisor** — a mode of the same binary. Starts `owndocs -demo`
   per visitor on a free port with a temp database, routes by hostname, kills it
   after ~20 idle minutes and deletes the directory.

`site_test.mjs`, built alongside step 1, in value order:

- `data-make` → `.PHONY` targets. Do this one first: it is the class of claim
  the rename broke, and it costs a regex over the `Makefile`.
- `data-fn` → `CALLABLE`. Joins the existing `functions_test.mjs` check.
- `data-role` → `RANK` in `roles.js` **and** `roleRank` in `docs_api.go`. Those
  two are hand-mirrored with nothing checking them — a live drift risk in the
  app, not just on the site.
- `data-key` → the editor's `formatKeymap` only. The sheet's shortcuts are not a
  registry; either the list stays editor-only or the sheet half stays prose.
- `data-shot` → the files `make site-shots` writes, both directions.

One more of the same shape, guarding the app rather than the site: **no raw
`fetch('/api…')` outside `api.js`**. Once sessions are path-prefixed, a new
absolute call works in dev, works self-hosted, and is silently broken in the
demo alone — the worst shape a bug has. One regex, and it retires the four
strays that exist today.

Wanted with it, none of which exist:

- `-demo` mode: seeds the three users, and caps documents and bytes
- Caps announced in the UI, and the message naming the *real* figure beside the
  demo one — the unsaved-change banner is the shape
- A ceiling on concurrent sessions, and a per-source rate limit on creating one
- `robots.txt` and `noindex` on **`*.demo.<domain>` only** — the site itself
  wants indexing; it is the demo's abandoned scratchpads that must not surface
  under the domain
- A contact address and a paragraph of acceptable use
- Base-path awareness, and it is small because `api()` is a chokepoint: the
  prefix in `api.js`, the four raw `fetch` strays routed through it, the
  WebSocket URL in `provider.js`, the two share-link builders off
  `location.href`, `base: './'` in vite, and the session cookie `Path` from a
  new flag. See *A path prefix per session* for the table
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

## Sheet protection

Decided 2026-08-13. Accident prevention, not authorisation — see *Sheet
protection* in the design doc for why the distinction is load-bearing and for
what the server can and cannot enforce.

- Locked by default; the stored map holds the *unlocked* exceptions, keyed like
  `fmt` (cell, `r.<rowId>`, `c.<colId>`)
- A `protected` flag per sheet, in the Yjs doc — sheets are a client-side
  convention the server has never heard of
- Unlocked cells are tinted from that attribute, so the colour cannot drift
  from the editability. A default background a cell's own colour overrides, and
  a reading preference so it can be turned off
- Protection applies to the **owner too**, by default. An explicit "edit
  protected cells" toggle, off by default, is the override — so testing what a
  colleague sees costs nothing
- Only an owner may change protection; editors get no override
- Structural row/column operations are blocked outright while protected

The work is the mutation sweep, not the feature: 27 `this.tx(...)` sites and 23
public mutators today, plus the script API, undo, and `restoreFrom`. The
deliverable is a table-driven test that enumerates every public mutator and
asserts each refuses.

## Ownership: transfer, and more than one owner

Wanted. Today `owner` is the creator, is not grantable, is not carried by a
share link, and cannot be changed — so every owner-only power belongs to one
person who may be on leave. Sheet protection adds a second such power, which is
what raised this.

Two shapes, and which one is still open — see *Open questions*. Worth settling
before protection ships rather than after.

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
