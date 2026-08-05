# Design Decisions

Self-hosted collaborative docs + sheets ("Google Docs clone"). Go backend,
Svelte frontend. This file records *why* each non-obvious route was taken, for
future me, reviewers, and Claude. Newest decisions at the bottom of each
section; superseded decisions get struck through, not deleted.

Decided-but-unbuilt work lives in `ROADMAP.md`, not here. When something on
that list ships, delete it there and record the reasoning here.

---

## Scope

**Self-hosted, small-team target — not parity, not multi-tenant.**
Tens of concurrent editors per document, one server, deployed as a single
binary on linux/arm64 behind nginx proxy manager. Feature target is the ~20%
of Google Docs/Sheets that covers 80% of real use: rich-text docs and
formula-capable sheets with live multi-cursor collaboration, sharing, and
version history.

Explicitly out of scope (each is a project-killer for a solo clone):

- **Suggestion mode / track changes** — a second overlay document model.
- **Pivot tables, charts, array formulas** — each is its own project.
- **docx import/export** — fidelity is endless, and `unioffice` went
  commercial. Export is Markdown/HTML/CSV/xlsx instead.
- Offline editing, mobile apps.

---

## Collaboration engine

### CRDT via Yjs, not OT

Google itself uses OT with a central server, but there is no mature Go OT
library for rich text and writing one is a research project. Yjs is the
de-facto collaborative-editing ecosystem: battle-tested, with maintained
bindings for the editor we use. Sheets and docs ride the same sync layer.

### Server treats Yjs updates as opaque binary blobs

The Go server is a WebSocket relay plus an append-only log of updates it never
parses. This keeps the server small and auditable, and means no Go CRDT
implementation is needed. Accepted cost: the server cannot read document
content, so server-side export/search/REST-reads are off the table. A
TypeScript-end-to-end stack (Node + Hocuspocus) would remove that limit and
was seriously considered; rejected because it trades away the single static
binary and an auditable dependency tree — the properties this project is
optimising for. Rust (yrs + axum) rejected on solo dev velocity.

### Compaction: snapshot is a cache, log is the source of truth

~~Original design: a client posts its merged state covering revision N; the
server keeps the raw update log until a *second* client confirms the snapshot
loads cleanly, then truncates.~~ Superseded — single-user documents never have
a second client, and truncation-on-trust makes a bad snapshot a data-loss
event.

Replacement: the snapshot only accelerates loads; the update log is never
auto-deleted, so a wrong snapshot costs a cache miss, not data. Verification
needs a *second load*, not a second client — the same user's next session
counts.

Flow:

1. **Append + coalesce.** Every incoming update is appended to `updates` with
   a sequence number. The server buffers per-room and writes one
   length-prefixed batch row per ~second — concatenating opaque blobs needs no
   CRDT knowledge; clients apply them in order.
2. **Trigger.** The load response reports tail length ("snapshot at seq 4200,
   plus 1,300 updates since"). A client seeing the tail past a threshold is
   elected to snapshot. No server-side scheduling; unopened docs don't need
   compacting.
3. **Client self-check.** Before posting, the client decodes its own
   `encodeStateAsUpdate` output into a fresh Y.Doc and compares state vectors
   with the live doc. Encode and decode are different code paths, so this
   catches most serialization bugs at the source. It posts
   `{snapshot, last_seq, state_vector}`.
4. **Server stores it as `pending`** with a SHA-256 of the bytes (catches
   storage/transport corruption — the one check possible without parsing
   Yjs). Loads are served snapshot-plus-tail immediately.
5. **Verify on next load.** The next session applies snapshot+tail, then
   asynchronously replays the full log since the previous *verified* snapshot
   into a scratch doc and compares state vectors. Match → ack → `verified`.
   Mismatch or decode failure → server deletes the snapshot, logs loudly,
   client transparently falls back to full log replay.
6. **Archive, never auto-delete.** On verification, pre-snapshot updates move
   to `history_segments` (seq range + one gzipped blob; Yjs streams compress
   well). Real deletion of history is only ever an explicit user action
   ("trim history older than N days") — a different trust calculus from an
   automatic process destroying data.

Each layer catches a distinct failure class: checksum → bit rot; self-check →
encode bugs; replay-compare → decodable-but-semantically-wrong snapshots
(e.g. a Yjs version bug). If all three miss, the archived log still recovers.
Trusting client blobs is thereby a performance question, not a durability one.

Implementation notes (phase 2): the replay-compare uses state-vector
**dominance**, not equality — the snapshot legitimately contains its
uploader's not-yet-flushed edits, so it may be ahead of the log but must
never be behind it. The verify bundle (both reconstructions + the pending
seq) is read in one SQLite transaction, so a flush can't race the
comparison. Caveat: state vectors track inserts, not delete sets, so a
snapshot that lost only deletions would pass — accepted as a residual risk
since the archived log makes even that recoverable. If the pending snapshot
fails checksum or rejection, joins transparently fall back to verified
snapshot, else archived segments + live log.

Edge cases: client crash mid-snapshot costs nothing (next session
re-triggers); concurrent snapshot posts resolve by highest `last_seq` wins; a
never-reopened doc never verifies but is also never read; a marathon single
session grows the tail unboundedly, but only until the next open.

Accepted cost vs. blind truncation: storage never shrinks below compressed
full history unless the user explicitly trims. Heavy typing is a few hundred
KB of raw updates a day before batching and gzip — cheap on a self-hosted
SQLite instance, and full history was wanted anyway (see Version history).

Fallback if client-driven compaction bites in practice: cgo binding to `yrs`
(Rust, C ABI). Not the first choice because cgo complicates the linux/arm64
cross-compile.

### Sheets data model: Y.Map of cells + fractional-index row/col order

A sheet is a `Y.Map` keyed by cell ref → `{formula, format}`. Cell edits are
last-writer-wins — which is exactly Google Sheets' behaviour, so this is not a
compromise. Row/column *order* uses fractional indexing so concurrent inserts
merge without coordination.

---

## Frontend

### Editor: markdown-native via CodeMirror 6 (supersedes ProseMirror)

~~Original decision: rich-text model via ProseMirror (no TipTap wrapper),
collaboration via `y-prosemirror`.~~ Superseded 2026-08-04: the requirement is
Obsidian-style live markdown editing — type markdown source, rendered in
place as you type, syntax markers revealed when the cursor enters a span.
That experience comes from the document *model*, not the renderer: the doc
must stay plain markdown text with rendering as a decoration layer, which is
CodeMirror 6 territory (Obsidian itself is CM6), not ProseMirror's structured
node tree.

Consequences, mostly simplifying:

- Shared type is plain `Y.Text` instead of `Y.XmlFragment` — the simplest
  CRDT case. Collaboration + remote cursors via `y-codemirror.next`
  (maintained, first-party-adjacent). Undo via `Y.UndoManager` (selective:
  undoes your edits only).
- Export is the document itself; markdown portability (Obsidian, git) free.
- The live-preview decoration layer is ours to build on CM6's incremental
  `lezer-markdown` syntax tree: style spans, hide marker characters unless
  the selection overlaps the node. Inline styles/headings/code/links are the
  tractable core; images and checkboxes are widget decorations; tables are
  the deep end (widget when cursor outside, raw text inside) and come last.
- Toolbar "syntactic sugar": formatting buttons are canned text edits
  (bold = toggle-wrap selection in `**`) dispatched through the normal
  editing pipeline, so they collaborate, undo, and keybind for free.

Accepted costs: no rich-text ceiling (font sizes, colours, WYSIWYG table
manipulation, image resize), and collaborators see markdown syntax while
editing near it. For a self-hosted instance whose users are markdown-literate
this is a fit, not a compromise.

### Sheets grid: hand-rolled virtualized canvas

DOM grids die around 10k cells; Google's grid is canvas. The good off-the-shelf
grids (AG Grid) are enormous and commercially licensed. A virtualized canvas
grid with selection, fill-handle, frozen rows, and a cell-edit overlay is a
few weeks of tractable, auditable work.

### Formula engine: hand-rolled subset, client-side evaluation only

HyperFormula was rejected: **GPLv3**. Chosen: a Pratt parser, dependency
graph, dirty-cell topological recalc, and ~40–60 functions (SUM, IF, VLOOKUP,
text/date basics). Evaluation happens *only* on clients, deterministically,
from the shared formula strings; the server stores inputs, never derived
values. This avoids maintaining two engines (Go + TS) that would inevitably
drift, at the cost of no server-computed values for exports/API.

### Framework: Svelte 5 + Vite, no SvelteKit SSR

The two hard components (CodeMirror, canvas grid) are imperative libraries
that want to own their DOM. React fights that (refs, effect hooks, firewalling
editor state out of the render cycle); Svelte compiles away and hands over real
DOM nodes, which is exactly what mounting ProseMirror or a canvas wants. Yjs
events wire straight into runes. React's real advantage — ecosystem breadth —
is nearly worthless here because the hard parts are hand-rolled regardless.
Accepted cost: collab-editing examples online are React-first and need
translating. (Also: maintainer wants to learn Svelte, which is a legitimate
input on a solo project.)

SvelteKit is used only as a static builder (`adapter-static`) if at all — the
Go binary is the server; half-used SSR would confuse the architecture.

---

## Backend

### Go, single static binary

Matches deployment target (linux/arm64 behind nginx proxy manager) and the
auditability goal. Expected size ~3–5k lines: sync hub (one goroutine-managed
room per open document), auth, CRUD, persistence.

### WebSocket: `coder/websocket`

stdlib has no WebSocket support (`x/net/websocket` is effectively abandoned).
`coder/websocket` is minimal, modern, and context-aware — the smallest
justified dependency that closes the gap.

### Sync wire protocol (v2)

Every binary message starts with a type byte: `0` document, `1` awareness.

- client → server `[0]`: one raw Yjs update, unframed.
- client → server `[1]`: one raw y-protocols awareness update.
- server → client `[0]`: a batch — repeated `[uvarint len][bytes]`. A stored
  `updates` row is a batch payload, so replay is prepend-a-byte-and-copy.
- server → client `[1]`: one awareness update, relayed as-is.
- server → client, text: JSON control. `synced` carries replay stats
  (`last_seq`, snapshot seq/state, tail rows/bytes) — the client uses these
  to decide whether to upload or verify a snapshot (compaction.js).

Awareness (presence/cursors) is ephemeral: relayed, never persisted. The
room remembers each connection's latest awareness payload and replays them
to joiners so peers appear immediately. Known wart: the server can't
synthesize a departure (it would need to decode client IDs), so on a hard
crash a peer's cursor lingers until the awareness protocol's 30s timeout;
clean closes broadcast removal via beforeunload. Viewers may send awareness
but their doc writes close the connection.

**Reconnect resync**: there is no per-update ack, so after a dropped
connection the client cannot know which of its updates the server received.
On reconnect the client rebuilds the server's state vector from the replay
it just received and sends only the **diff**. ~~First version pushed the
full document state~~ — combined with the per-message size limit, that
turned one oversized document into a self-sustaining reconnect loop
(send > limit → server closes 1009 → reconnect → full resync → 1009 → …).
The diff is near-empty in the normal case, so the loop cannot restart.

**Message size limit**: 16 MiB server-side read limit (a paste arrives as
ONE Yjs update; the original 1 MiB broke the first big paste). The client
refuses to send any single update over 15 MiB with a loud console error
instead of letting the server close the connection — a deliberate hard
ceiling on single-edit size rather than a retry loop. Close codes are
surfaced in the client status line for diagnosability.

**Protocol version gate**: clients dial `/ws/{id}?v=2`; anything else is
refused at upgrade with 426. Added after a real incident (2026-08-04): the
server cannot validate opaque payloads, so its only defense against a stale
tab speaking an older framing is to refuse the conversation entirely. Bump
the version on any wire-format change.

**Defensive decode on the client**: one undecodable frame is skipped (loudly)
rather than aborting the rest of the replay, and a client that saw one never
uploads or verifies snapshots that session — a doc that missed frames must
not launder its partial state into a snapshot. Server-side, `tools/inspect`
verifies snapshot checksums and row framing across the whole database.

Joining holds the room lock across the log read and client registration, so
no update can slip between "read the log" and "start receiving broadcasts".
Slow consumers are evicted rather than buffered without bound — the client
reconnects and replays from the log, so eviction never loses data. Room
buffers flush to SQLite after 1s of activity, on last-client exit, and on
shutdown; a failed flush re-queues rather than drops. `documents.last_seq`
is the authoritative sequence counter — `MAX(updates.seq)` breaks once
verified rows are archived away.

### Persistence: SQLite via `modernc.org/sqlite`

Pure-Go SQLite driver — **no cgo**, so the linux/arm64 cross-compile stays
`GOOS=linux GOARCH=arm64 go build`. Single-writer SQLite is a fit for the
scale target. Backups via Litestream. Postgres deferred until (if ever) the
project goes multi-node; don't start there.

Schema sketch: `documents`, `updates` (append-only blob log), `snapshots`,
`history_segments` (compressed archived update ranges), `users`,
`permissions`.

### Auth & sharing

stdlib sessions, argon2id password hashing (`x/crypto`), owner/editor/viewer
roles, share-by-link via capability tokens. Permissions are checked at
WebSocket upgrade **and** per-message — read-only clients receive updates but
their writes are rejected server-side, not just hidden in the UI.

Implementation details worth knowing: session tokens are stored as SHA-256
hashes (a leaked db doesn't leak live sessions); CSRF protection is the
`Content-Type: application/json` requirement on mutating endpoints (a
cross-origin form can't send that without a CORS preflight) plus
`coder/websocket`'s default same-origin check on upgrade; signup is gated by
the `-signup=open|closed` flag — close it before exposing an instance to the
internet (sharing-by-email requires existing accounts, so onboard the team
while open, then close).

Sharing (phase: sharing UI): invite-by-email grants editor/viewer to
existing accounts; only owners mutate shares and nothing can change or
remove the owner. Share links are capability tokens stored as SHA-256 like
sessions — the plaintext appears exactly once at creation; lost links are
revoked and re-minted, never retrieved. Redeeming grants the link's role but
only ever upgrades (viewer→editor); revoking a link stops future
redemptions without clawing back roles already granted. Revoking or
downgrading a person evicts their live WebSocket connections immediately —
enforcement is server-side, not hidden UI. Share URLs use hash routing
(`/#share=<token>`, `/#doc=<id>`) so the token never appears in server logs
or Referer headers; the fragment survives the login flow for signed-out
recipients.

### Static assets: hashed + immutable via Vite

Dependencies are split into their own chunks (`vendor-editor`,
`vendor-sync`, `vendor`). This saves **no bytes on a first visit** —
everything is still loaded on every page — and that is not what it is for.
Assets are hashed and served `immutable`, so with a single bundle a
one-line change to our own code re-hashes all of it and every client
re-downloads CodeMirror, which measurement showed to be 170 kB gzipped, or
about 70% of the bundle. Split out, a code-only deploy re-hashes only the
~33 kB app chunk and the rest stays cached — verified by changing one
constant and diffing the emitted filenames.

Real byte savings would need route-level lazy loading, so that opening a
sheet never fetches the markdown editor at all. Deferred: it costs a
loading state in the router, and on a self-hosted LAN app the first-visit
cost is a fraction of a second, once.


~~Interim policy: everything no-cache, because the esbuild bundle was
unhashed and `max-age` let browsers run a stale bundle for up to an hour
after a rebuild.~~ Resolved by the Svelte shell migration: Vite emits
content-hashed files under `/assets/`, served
`public, max-age=31536000, immutable`; `index.html` stays `no-cache` since
it carries the hashed URLs. Dev loop: `npm run dev` (vite, hot reload)
proxies API+WS to the Go server, which needs
`-allow-origin http://localhost:5173` for the websocket origin check.

### Version history: the archived update log *is* the history

Because compaction archives rather than deletes (see Compaction), the full
edit history survives in `history_segments` — version history and compaction
are one mechanism, not two. Named versions are just labelled sequence numbers;
any past state is reconstructable by replaying the log to that point.
"Restore" is a new update that overwrites current state — history itself is
never rewritten.

Implementation (phase: version history):

- **Browseable points are derived at query time**, never stored: rows whose
  timestamps sit within 5 minutes of each other form one "session" (capped
  at 30 minutes, so nonstop editing still gets boundaries); each session is
  one point. Both rules are constants (`sessionGap`, `sessionMax`) — tuning re-buckets all history retroactively for free.
- **Archiving preserves row metadata**: each segment carries a JSON row
  index of (seq, timestamp, byte offset), so sessions survive compaction
  and replay can cut mid-segment. Pre-index segments degrade to one coarse
  point at their end — addressability is only as fine as what was recorded.
- **Replay is server-side byte assembly, client-side reconstruction**: the
  server concatenates frames up to a seq (it still never reads content);
  the client replays them into a fresh Y.Doc and previews read-only.
- **Restore is an ordinary collaborative edit**: one transaction replacing
  current text with the previewed state, delivered through a normal
  provider connection — it syncs to live collaborators, is undoable, and
  itself appears in history. Pinning a name flushes the room first so the
  label lands on the very latest edit.

### Git exporter: a headless client, not a server feature

`web/scripts/exporter.mjs` mirrors named versions into a git repo — one
commit per pin, oldest first. It is deliberately **just another client**:
it logs in with an ordinary account, polls `/api/docs` + `/history`, fetches
`/replay?to_seq=<pin>`, rebuilds the Y.Doc locally and commits the markdown.
Zero server changes, so the server still never reads document content, and
the exporter only sees docs its account has (at least) viewer access to —
git visibility is governed by the existing sharing model, nothing new.

Choices worth recording:

- **Named versions are the commit points.** Pinning a version *means* "this
  is a commit"; sessions stay browseable in-app only. An exporter that
  committed every session would bury the meaningful states in noise.
- **Polling over WebSocket push.** A pin is a deliberate, occasional act; a
  60s poll (configurable, `--once` for cron) is simpler than keeping a live
  socket per doc, and the exporter needs no realtime anything.
- **HTTP-only via the replay endpoint** — no Provider, no `ws` dep; the only
  non-stdlib dependency is `yjs` itself, already present.
- **State (`.docs-export.json`) is committed into the export repo**: maps
  doc id → last exported version id + path. A clone of the repo can continue
  exporting, and every export commit is guaranteed non-empty.
- **Filenames are `slug(title)-<6-char doc-id>.md`** — same-title docs never
  collide, retitles show up as renames (handled via the state file's
  remembered path). Trailers `Docs-Doc:`/`Docs-Version:` tie each commit
  back to its source.
- **Git metadata mirrors doc history**: author = whoever pinned (synthetic
  `@docs.invalid` email — users have no public email), author/committer
  dates = pin time. Committer identity is passed with `-c` per invocation;
  the exporter never writes repo config.
- **Append-only, like everything else**: deleting a named version in-app
  removes the label but never rewrites exported git history.
- Credentials come from `DOCS_EMAIL`/`DOCS_PASSWORD` env vars, not argv
  (argv is visible in `ps`).

Verified by `web/scripts/exporter_e2e.mjs` (needs a running server, like
`e2e.mjs`): pins through the real WebSocket pipeline, then asserts commit
count, per-commit content, ordering, author, trailers, idempotent rerun,
and retitle-as-rename.

### Version history for sheets

Docs and sheets share the entire history mechanism — the append-only log,
session bucketing, named versions, the replay endpoint — because the
server has never known what a document contains. Only two things are
kind-specific, and both are client-side:

- **Preview** renders an HTML table rather than the canvas grid. A preview
  needs no scrolling, editing, selection or virtualization, and a table is
  selectable and copyable for free. Cell text, alignment and formatting
  come from the same `display()`/`formatOf()` the live grid uses, so the
  preview cannot drift from what a restore would actually give back.
  Capped at 200x40 cells: a preview is for recognising a version, not
  reading all of it.
- **Restore** is `Workbook.restoreFrom(snapshot)` — the sheet equivalent of
  the editor's "delete all text, insert the old text", but across rows,
  columns, cells, dimensions, formats, charts, the tab order and tab
  names. Row and column ids are replaced *wholesale* rather than
  reconciled, so formulas stored against the historical ids resolve
  exactly as they did. Sheets created since the snapshot are unlinked from
  the tab order rather than emptied, matching `removeSheet`.

Two properties worth keeping: the whole restore is **one transaction**, so
it is a single update on the wire and a single undo step; and the copy
skips keys that already match, so **restoring to the state you are already
in writes nothing** and cannot pollute history with a no-op.

Like the document restore, this is an ordinary collaborative edit: it
syncs to anyone with the sheet open, is undoable, and itself appears in
history. Nothing is ever rewritten.

### CSV export

CSV is the export format and **displayed values** are what it contains —
dates as dates, currency as currency, formulas as their computed result.
Raw storage would be unreadable (a date is a serial like `46239`) and the
whole point is to be legible somewhere else. It is the same decision, and
now literally the same code, as the clipboard's `text/plain` flavour: CSV
and TSV differ only by delimiter.

- **In the app**, the button exports the active tab, since CSV has no
  concept of multiple sheets and bundling would mean inventing a zip
  writer. It carries a UTF-8 BOM, because Excel otherwise reads a UTF-8
  CSV as the local codepage and mangles anything non-ASCII.
- **In the git exporter**, a sheet becomes a *directory* of one CSV per
  tab (`<slug>-<id>/<tab>.csv`), and there is deliberately **no BOM** — it
  would be noise in every diff. Filenames come from the tab name, not its
  position, so reordering tabs doesn't rewrite every file; a duplicate
  name gets a short id suffix.
- Exports are trimmed to the sheet's **used rectangle**, so a stray
  `=Z100` reference — which materializes rows and columns — doesn't emit a
  hundred blank lines.
- The exporter's state file now records the **set of files** each document
  produced, so a retitle, a renamed tab or a deleted tab removes the old
  file and git shows a rename or a deletion instead of accumulating
  orphans. Older state with a single `path` is read as a one-file list.

### Import/export

xlsx via `excelize` (mature, justified). Doc export is now trivial: the
document *is* markdown, and HTML export is a render of it. See Scope for why
docx is excluded.

---

## Sheets

Same collaboration engine, same opaque-blob server: a sheet is just a Y.Doc
with a different internal shape, synced through the unchanged provider and
compacted/versioned by the unchanged machinery. Everything below is
client-side.

### Grid identity: stable row/col ids, not coordinates

The CRDT-killer in spreadsheets is concurrent structural edits: if cells are
keyed by position (`row3:col2`), inserting a row means rewriting every key
below it — a huge transaction that conflicts disastrously with any
concurrent edit. Instead:

- `rows` / `cols` are Y.Arrays of random short ids. Inserting a row is a
  one-element array insert; Yjs merges concurrent inserts the same way it
  merges concurrent text typing.
- `cells` is a Y.Map keyed `rowId.colId`, value = the raw input string.
  Cells never move; only the order arrays do. Per-cell last-writer-wins is
  the right granularity (merging keystrokes *within* one cell is not worth
  the complexity — Google doesn't either).
- Deleting a row deletes its id and its cells in one transaction. A
  concurrent edit to a deleted cell resurfaces as an orphan (id no longer
  in the array) — invisible and harmless, cleaned by history compaction of
  the map itself. Never auto-resurrected.

Rows/cols are **materialized lazily**: a fresh sheet's arrays are empty (no
seeding — two clients seeding 50 rows on first open would merge into 100),
and the grid displays a virtual minimum size. Touching a cell materializes
ids up to its position. Two clients materializing concurrently merge into
extra rows — both sides' data kept, nothing lost; rare and acceptable.

### Formulas: A1 at the edges, stable ids inside

Stored formulas reference ids (`@r1a2b3.c9d8e7`), not positions. The user
types and sees A1 notation; conversion happens at the boundary (commit
parses A1 → ids; display renders ids → current A1). Why: a reference tracks
*cell identity*, so inserting rows never rewrites a single formula — the
displayed text just changes, which is exactly Google's behaviour, achieved
with zero rewrite transactions and no concurrent-rewrite hazards. A
reference to a deleted row/col displays and evaluates as `#REF!`, like
everyone else. Ranges store their two endpoint ids and therefore grow and
shrink naturally as rows are inserted or deleted between them. ~~`$`
absolute markers are parsed and round-tripped but have no semantics until
fill/paste exists.~~ Superseded: `$` now has full meaning (see Copy/paste
and fill). The flags are stored on the id ref itself (`@$rid.$cid`) — the
first implementation dropped them at the storage boundary, so `=$A$1` came
back as `=A1`; absolute-ness is part of the reference, not decoration.
`#REF!` is likewise a real parseable literal, so a formula whose reference
died survives being re-committed instead of decaying to `#ERROR!`.

### Computed values are never stored

Only raw input strings live in the doc. Every client computes formula
results locally: one source of truth, no stored-value/formula skew, nothing
for the (content-blind) server to compute, and history/replay reproduce
exact results by construction. This is also what forces scripting client-
side, which we independently want (see below).

### Engine: hand-rolled, ~20 functions, registry-based

Tokenizer + Pratt parser + evaluator, no dependencies (a formula parser is
a few hundred auditable lines; a library would bring its own value model).
Excel compatibility quirks are followed where users would notice
(`-2^2 = 4`: unary minus binds tighter than `^`; `^` is left-associative)
and deviated from where Excel is silly: circular references are a proper
`#CYCLE!` error, not a warning-and-zero. `IF` evaluates only the taken
branch. Functions live in a plain name→fn registry so scripts can later
register custom ones.

Recalculation (v1): any doc change clears the whole computed-value cache;
values recompute lazily on demand (render pulls visible cells; watchers
pull their ranges), memoized per pass, with cycle detection via an
in-progress mark. Deliberately naive — trivially correct under concurrent
edits, no dirty-propagation bugs — and fast enough until sheets get big.
The upgrade path (reverse-dependency dirty sets) is contained inside the
model and changes no interfaces.

### Model is a library; the grid is one consumer

`sheet/model.js` (`Workbook` + `SheetModel`: Yjs mapping, A1↔id and
name↔id translation, recalc, transactions, `watchRange`) has no DOM and no
Svelte. The canvas grid consumes it through
the same API a chart or a script bridge will later: this is the provision
agreed for graphs and scripting — ranges are subscribable by *anything*,
writes are transactional (a script setting 1000 cells is one update), and
the future `objects` / `scripts` containers are named in the doc layout.
Scripting itself stays unbuilt until the model API has been exercised;
plan of record: sandboxed-iframe execution in the browser, plus a headless
Sobek runner as "just another client" for scheduled scripts and the
line-by-line debugger.

### Rendering: canvas, virtualized

A DOM grid dies at tens of thousands of cells; every serious web
spreadsheet paints on canvas. One canvas draws only the visible window
(native scrollbars via a sized spacer div, canvas stuck in the corner);
editing is a real `<input>` overlaid on the active cell, so IME, selection
and clipboard behave natively where it matters. Numbers right-aligned,
text left, like every spreadsheet since VisiCalc. Collaborator selections
render from the same awareness channel the editor uses.

### Copy/paste and fill

Both are the same operation underneath — **relative reference translation**
— and that operation is exactly the A1↔id boundary conversion the grid
design already had. A cell's portable form is its A1 rendering at its own
position (`getInput`); pasting it elsewhere shifts every relative component
by the destination delta and converts back to ids. So `=A1` copied a row
down becomes `=A2`, `=$A$1` doesn't move, and a reference pushed off the
top or left edge becomes `#REF!`, matching Excel. Because it is one
`setCellShifted` primitive, paste, tiled paste, fill-down, fill-up,
fill-left/right and Cmd+D all share it and cannot disagree.

Clipboard interop puts two flavours on the clipboard, the same trick
Google Sheets uses:

- `text/plain` — TSV of **displayed values**, so pasting into Excel,
  Numbers or Sheets works.
- `text/html` — an ordinary `<table>` of those values carrying the **raw
  inputs** in a `data-docs-sheet` attribute, so pasting back into this app
  keeps formulas (translated) even across tabs. Foreign HTML has no such
  attribute and falls back to TSV-as-literals. A same-page in-memory copy
  is kept as a fallback in case a browser strips the attribute.

Riding the browser's own `copy`/`cut`/`paste` events (on the focused grid
div) avoids the async Clipboard API and its permission prompt entirely.
Cut marks its source and empties it only when the paste lands — so a cut
that is never pasted changes nothing — and clearing happens *before* the
write inside the same transaction, so a destination overlapping the source
isn't damaged.

Fill series rules: a line of two or more **plain numbers** with a constant
step extrapolates; a single number copies (1 dragged down gives 1,1,1 —
Excel and Sheets agree); anything else repeats cyclically with formulas
translated. Formula *results* never count as a series, or a computed column
would extrapolate as if it had been typed.

Every bulk operation is one Yjs transaction: one update on the wire and one
undo step. Relatedly, the UndoManager runs with `captureTimeout: 0` —
Yjs's 500ms merge window is right for prose but wrong here, where each cell
entry, paste and fill is a discrete act. Cell writes invalidate only the
value cache, not the id index (a cell write can't move an id), so a large
paste doesn't rebuild the index once per cell.

### Multiple sheets: adopt the old containers, don't migrate

Tabs were done early and deliberately, because a container restructure is
the one change that gets *more* expensive with every day of real data.
Formatting and charts are additive and can land on a stable shape at any
time; this could not.

The trick that made it free: **the first sheet keeps the bare top-level
container names** (`rows`, `cols`, `cells`, `dims`), and additional sheets
use `s.<id>.rows` and so on. A document written before tabs existed is
therefore *already* a one-sheet workbook — nothing is copied, nothing is
rewritten, and there is no migration transaction that two clients could
run concurrently and duplicate. `sheets` (a Y.Array of ids) and
`sheetNames` (a Y.Map) stay empty until a second tab is created, at which
point the implicit first sheet is materialized into the list.

Consequences worth recording:

- **Duplicate first-sheet entries are expected, not a bug.** Two clients
  adding a second tab at once each materialize the implicit first one, so
  the array can legitimately hold it twice. The reader dedupes rather than
  trying to repair the array — no coordination, no lost tabs.
- **Removing a tab unlinks it but leaves its containers.** Undo is then a
  one-entry insert rather than a replay of every cell, and formulas
  pointing into it come back to life intact. Yjs tombstones mean deleting
  the cells would not reclaim the space it appears to anyway.
- **One undo stack for the workbook** (`UndoManager.addToScope` as sheets
  are instantiated): Cmd+Z should undo the user's last action wherever it
  happened, not per-tab.
- **Caches move to the workbook.** A cross-sheet formula makes every sheet
  interdependent, so the value cache and the in-progress set used for
  cycle detection are workbook-wide and keyed `sheetId/rid.cid`. A cycle
  that runs out to another sheet and back is caught exactly like a local
  one. The row/column id index stays per-sheet.

### Cross-sheet references

Same boundary trick as everything else: **stored by id, displayed by
name.** `Sheet2!A1` is stored as `@<sheetid>!<rowid>.<colid>`, so renaming
a tab changes what every formula *displays* without rewriting a single
stored byte — the same property row/column ids give for inserts. A
reference into a removed tab is `#REF!`, and a range names its sheet once
(`Sheet2!A1:A5`) so it can never straddle two sheets. Sheet names are
quoted when bare text would be ambiguous — spaces, or a name that looks
like a cell reference (`'A1'!A1`).

Writing `=Sheet2!C5` materializes that sheet up to C5, exactly as an
in-sheet forward reference does; otherwise the reference would be born
dead on an empty sheet.

### Formatting lives in its own map, not in the cell value

~~Cell values become `{v, ...format}` objects; readers accept both.~~
Superseded. Formatting is a **separate Y.Map** (`fmt`) keyed the same way
as `cells`. The reason is concurrent merging: if the format lived inside
the cell value, one person bolding A1 while another types into A1 would be
two writes to the same map key, and last-writer-wins would throw one away.
In separate maps they touch different keys and both survive — verified
with two clients, locally and over the wire. It also leaves the formula
and paste machinery completely untouched, since `cells` stays a map of
plain input strings.

Other decisions here:

- **Cell over row over column.** `fmt` also holds `c.<colId>` and
  `r.<rowId>` defaults, so "make this column currency" is one stored entry
  that covers rows nobody has created yet — a per-cell write would cover
  neither. A selection made by clicking a column header formats the
  column; any other selection formats its cells.
- **Values are never formatted, only displayed.** `display()` applies the
  format; `getValue()` and every formula see the raw number. Storing
  formatted text would corrupt arithmetic, and the "computed values are
  never stored" rule already forbids it.
- **Typed punctuation is a format request.** `$1,234.50`, `12%` and
  `1,000` store a *number* and set the format the punctuation implies —
  what every spreadsheet does, and the alternative (storing the string
  "12%") makes the cell unusable in arithmetic. `parseTypedNumber` is
  pure and tested, including the cases that must stay text.
- **`Intl.NumberFormat` for grouping and rounding**, cached per spec:
  built into browser and node, locale-correct, no dependency, and no
  hand-rolled digit juggling. Currency stores a *symbol* rather than an
  ISO code, so there is no locale guessing to get wrong; a proper currency
  picker can come later.
- **Formatting travels with content** through copy, paste and fill. The
  clipboard's HTML flavour also carries inline CSS, so bold and colours
  survive a paste into Excel or Google Sheets.
- Deleting a row or column removes its formats, so a later id occupying
  that position cannot inherit a ghost.

### Dates are numbers, not a new type

A date is a **serial**: days since 1899-12-30, with the fraction being time
of day — the Excel/Sheets model. Adding a distinct date type to the value
model was the obvious alternative and the wrong one: serials give date
arithmetic for free (`=B1-A1` is days between, `=A1+7` is a week later),
keep comparison, sorting and every existing function working unchanged,
and let the formula engine stay a two-type (number/string) evaluator. The
"type" is carried entirely by the format, which the formatting phase had
already built.

- **Serials are timezone-free civil date-times.** 2026-08-05 is that
  calendar day everywhere, not an instant. Every conversion goes through
  UTC accessors so daylight saving can never shift a date by a day; the
  test suite is run under `Australia/Sydney`, `America/New_York` and
  `Pacific/Kiritimati` to keep that honest.
- **Excel's 1900 leap-year bug is not replicated.** Excel believes
  1900-02-29 existed and Sheets copies it; we keep the real calendar.
  Serials agree with Excel for every date from 1900-03-01 onward and
  differ by one before it — an era nobody puts in a spreadsheet. Recorded
  because "compatible except where Excel is wrong" is a decision, not an
  accident.
- **Typed input is validated; `DATE()` rolls over.** `2026-02-30` typed
  into a cell stays text rather than silently becoming 2 March, but
  `=DATE(2026,13,1)` is January 2027 on purpose, because that is what
  makes month arithmetic work. Both match Excel.
- **Ambiguous numeric dates follow the viewer's locale**, asked of `Intl`
  rather than assumed, so `5/8/2026` is 5 August in Sydney and May 8 in
  New York — the same text, each user's own reading. Dashed pairs without
  a year (`1-2`) stay text, being far more often a range.
- **A date-producing formula gets a date format automatically**, or
  `=TODAY()` would display 46239 and be useless. Generalised later into
  format propagation (see Number formats travel through formulas). The rule is narrow and
  deliberately unlike Excel in one place: `=A1+7` is a date, but
  `=B1-A1` is a *number of days*, because subtracting a date from a date
  yields a count. Excel's habit of showing that as a date in 1900 is a
  well-known annoyance.
- **`TODAY`/`NOW` are the engine's only impure functions.** Each client
  computes them from its own clock and timezone, since nothing is ever
  computed on the server — so two people in different zones can briefly
  read a different `TODAY()`. The stored document is identical either
  way, because computed values are never stored. They refresh on
  recalculation rather than continuously. The engine takes its clock
  through a seam so tests pin "now" instead of asserting against the wall
  clock.
- Fill series work on the **stored serial**, not the displayed text, which
  is what makes dragging two consecutive dates continue the run.

### Number formats travel through formulas

A formula's result used to carry no format, so a total under a currency
column read `15.5` while every cell above it read `$10.00`. The number
format is closer to a *unit* than to decoration, and units are what a
calculation carries forward, so results now inherit one from their inputs.

Only the number format travels. Bold, colour and alignment stay with the
cells they were applied to — those are presentation the user chose for
particular cells, not a property of the value.

The rules, chosen to be defensible rather than merely Excel-compatible:

- `=A1`, `=SUM(C2:C9)`, `=AVERAGE(...)`, `=MIN/MAX/ROUND/ABS` inherit.
  `COUNT`, `COUNTA` and `DAYS` deliberately do not: they return counts.
- `+` and `-` inherit when the operands agree, or when only one is
  formatted (`=A1+50` on currency stays currency).
- `=B1-A1` with two dates stays a plain number of days — the pre-existing
  rule, now falling out of "subtracting like from like gives that unit,
  except dates, whose difference is a duration".
- `*` and `/` inherit only when **one** side is formatted: currency times
  a plain count is currency, but two formatted operands make units no
  single format describes, so nothing is inherited rather than something
  wrong. Percent is the exception, being dimensionless: currency times a
  percentage is still currency.
- A range whose cells disagree inherits nothing, and the scan is capped
  (400 cells) since it runs on every formula commit and one disagreement
  is enough to give up.
- **An explicit format always wins.** Inheritance only fills a cell that
  has no number format of its own, which also means it does not re-derive
  when a formula is later edited.

### Charts: a range consumer, exactly as reserved

The sheets design promised that "ranges are subscribable by *anything*" and
reserved an `objects` container. Charts are the first thing to collect on
that promise, and they needed no new machinery:

- **A chart's range is stored as row/column IDS**, exactly like a formula
  reference. That is what makes a chart follow its data: inserting a row
  inside a charted range extends the chart, and moving data never
  re-points it at the wrong cells. Positions would have broken on the
  first insert.
- **Deleting an endpoint row re-anchors** to the nearest survivor inside
  the range, because losing a range's anchor to an ordinary row delete
  would be a nasty surprise. If the whole range goes, the chart says so
  rather than rendering nonsense.
- **`objects` is a Y.Map keyed by object id.** Concurrent inserts of
  different ids never conflict. A chart is stored as one JSON object and
  updated by whole-object replace, so edits to the *same* chart are
  last-writer-wins — charts are edited rarely and by one person at a time,
  and finer granularity would buy nothing for the complexity.
- **Rendered on canvas, in DOM panels floating inside the scroll
  container**, so they scroll with the sheet for free and never fight the
  sticky-canvas trick the grid uses. Repainted from the same `draw()` as
  the grid, so a chart can never show stale data.
- **Labels and axis ticks reuse the display layer**: categories come from
  `display()` and tick labels from the first series' cell format. A chart
  of a date column reads as dates and a chart of a currency column gets
  currency ticks, with no chart-specific formatting code.
- Non-numeric cells become **gaps rather than zeros**, so a line breaks
  instead of diving to the axis.
- Axis bounds use a 1/2/5 "nice scale"; ticks are rebuilt from the step
  rather than accumulated, so the top tick lands exactly on the axis.
- **Putting interactive DOM inside the grid means every grid handler needs
  a source check.** Charts are real elements inside the scroll container,
  so their key, clipboard and dblclick events bubble into the grid's own
  handlers — which is how typing a chart title ended up creating a cell
  edit (the grid called preventDefault, swallowed the character and
  started editing the cell underneath). One `fromOverlay(e)` guard now
  fronts keydown, copy, cut, paste and dblclick. It tests for controls and
  chart panels rather than `target !== container`, because the grid's own
  canvas is a child too and every ordinary click on a cell targets it.
- Drag and resize write **once on mouse-up**, so a drag is one undo step
  and one update on the wire rather than one per mouse event. The **body**
  is the drag surface, not the title strip: ~~the strip is the drag handle
  so a click on the chart body cannot move it by accident~~ was wrong in
  practice, because a selected chart's controls fill that strip and each
  one must swallow mousedown to stay clickable, leaving nothing to grab. A
  3px movement threshold does the job the strip was meant to do.

Types are column, line and pie. Scatter, area and stacked variants are
deferred, as is picking a range by dragging rather than selecting first.

### Scripting: a sandboxed iframe, and nothing runs by itself

Scripts live **in the document**, so they are shared, versioned, restored
and git-exported by machinery that already existed. That is also precisely
what makes them dangerous, and it sets the threat model: the risk is not
"the user runs their own code", it is **"someone shares a sheet whose
script runs as you"**.

- **Never `eval`.** That would hand a shared document's script the page's
  origin — session cookie, API access, everything. The script runs in an
  iframe created with `sandbox="allow-scripts"` and deliberately *without*
  `allow-same-origin`, which puts it in a unique opaque origin: no
  cookies, no storage, no parent DOM, no ability to call our API as the
  signed-in user. A CSP of `connect-src 'none'` removes the network, so it
  cannot exfiltrate what it reads either. Everything it can do it must ask
  for by `postMessage`, and the host decides.
- `'unsafe-eval'` *is* granted inside the sandbox. Running arbitrary code
  is the entire feature; the isolation comes from the opaque origin and the
  absent network, not from restricting eval.
- Messages are trusted by **window identity, not origin** — a sandboxed
  frame's origin is the string `"null"`, which anything could claim, but a
  window reference cannot be forged.
- ~~**Nothing runs automatically.** No triggers, no on-open, no on-edit.
  This is the single property that makes opening a shared sheet safe, and
  it is why triggers are not a "later feature" to add casually — adding
  them re-opens the whole threat model.~~ **Overstated, and corrected
  below.** That reasoning is true of Google Apps Script, which runs with
  your Google identity and can fetch URLs, send mail and read Drive. It is
  mostly false here: this sandbox has no network and no ambient authority,
  and the API reaches exactly one document. On-edit triggers now exist —
  see On-edit triggers. `onOpen` is still absent, deliberately.
- Residual risk, stated plainly: a script can still make destructive
  *edits* as whoever ran it. Every edit is one transaction, undoable, and
  lands in version history — the same protections a careless human gets.
- **Runaway scripts** are stopped by removing the iframe, which destroys
  the execution context. Honest caveat: a tight *synchronous* loop can only
  be interrupted if the browser gave the frame its own process. Chrome
  normally isolates opaque-origin frames, so in practice the timeout fires;
  a guaranteed interrupt would need QuickJS in WASM, which is the
  dependency this design is avoiding.

The split that makes it testable, and that the Go runner will reuse:

- `scriptapi.js` is a **pure function over the workbook** — what each call
  does is ordinary model work, tested headlessly. A headless Go/Sobek
  runner implements the same call names against the same model and
  inherits the same behaviour.
- `sandbox.js` is only transport. Its runtime is exported as a string, so
  the tests evaluate the code that actually ships against a fake message
  channel: the async wrapper, log forwarding, the call/result round trip
  and error reporting all covered without a browser.
- The API is **async throughout**, because every call is a round trip.
  Writes take a *block* of values rather than one cell, which is what keeps
  a thousand-cell script to one transaction, one update and one undo step.
- Script values are committed exactly as if typed, so `"$1,200"` becomes
  currency and `"=SUM(A1:A2)"` becomes a formula. One rule for humans and
  scripts.

### On-edit triggers

The decisive argument, which the original "no triggers" position missed:
**to put a script in a document you must already be an editor of it, and
an editor can already destroy that document directly.** An automatic
script therefore grants its author no capability they lack. What it
changes is attribution (the damage looks like yours) and timing — not
power. Combined with a sandbox that has no network and an API bound to one
document, the residual risk is a destructive edit that is one transaction,
undoable, and in version history.

The one genuine escalation is narrow: **a script outlives its author's
access.** Someone writes a script, their sharing is later revoked, and it
keeps running as you. That is what the consent gate is for, and its shape
follows from it — documents you own run their triggers freely, and a
document shared with you asks once, with the answer remembered **locally
on that machine**. Local rather than in the document, because the document
is exactly the thing whose trustworthiness is in question; an editor could
otherwise grant consent on your behalf. So the *binding* ("this script
runs on edit") lives in the document where it belongs, and the *decision
to honour it* does not.

`onOpen` remains absent: on-edit at least requires you to act, whereas a
trigger firing because you merely looked at a document is a materially
worse bargain.

The harder problems turned out to be engineering, not security, and all
three are enforced in the model rather than left to the caller:

- **Exactly one client runs it.** Yjs marks a transaction `local`, so only
  the client that made the edit fires the trigger. Otherwise the effect is
  applied once per open browser — verified live with three connected
  clients, where an edit produced one run and two zeroes.
- **A script's writes never re-trigger.** Every script write carries the
  workbook's `scriptOrigin` instead of the ordinary origin, and the
  dispatcher ignores it. This kills feedback loops absolutely rather than
  heuristically. Script edits stay undoable because that origin is also in
  the UndoManager's tracked set.
- **Bursts coalesce.** A short debounce turns ten quick edits into one run
  carrying every changed cell, and one trigger runs at a time.

The event a script receives is the sheet name, the bounding range of the
change and a cell count — derived from the changed keys, skipping any
whose row or column has since been deleted.

### The headless runner: Sobek running the browser's own model

Scripts in a browser only run while a browser is open, which leaves
scheduled and unattended work undone. The runner (`cmd/runner`) fills that
gap as **just another client**, the same shape as the git exporter: it logs
in with an ordinary account, speaks the ordinary WebSocket protocol, and
the server is unchanged and still cannot read a document.

The hard part is that last clause. Because updates are opaque blobs,
*anything* that wants to read a document needs a CRDT, and there is no Go
Yjs implementation worth betting a document's integrity on. Two obvious
routes were rejected:

- **cgo to Rust's `yrs`** — reintroduces cgo, which is exactly what the
  `CGO_ENABLED=0` linux/arm64 cross-compile exists to avoid.
- **Writing a Yjs-compatible CRDT in Go** — a research project whose
  failure mode is silently corrupting documents in ways the browser never
  would.

Instead the binary embeds **Sobek** (a pure-Go JavaScript engine) and runs
the *same bundled model the browser runs*: `web/src/runner.js` pulls in
`sheet/model.js` and `sheet/scriptapi.js` and is bundled by `make
runner-js` into an embedded `runtime.js`. **Go owns the socket, the clock
and the loop; JavaScript owns the CRDT.** Neither half can drift from the
browser, because one of them *is* the browser's code — a formula, a date,
a currency format and a script all behave identically by construction
rather than by discipline.

Things learned building it, all verified rather than assumed:

- **Yjs runs in Sobek** given three host globals: `crypto.getRandomValues`,
  `performance.now` and `Intl`. Sobek is a language engine with no ICU, so
  `Intl` is a small fixed-locale shim covering exactly the option sets
  `format.js` and `dates.js` ask for. Fixed-locale on purpose: a headless
  runner wants output identical on every machine far more than it wants to
  guess a locale from a server's environment.
- **No JavaScript event loop is needed.** The API resolves calls
  immediately, so a script's `await` settles on values already present.
- **But run and collect must be two calls.** A promise callback is a
  microtask and cannot run until the JavaScript job that queued it returns
  to Go, so checking a script's result inside the same call always saw an
  unsettled promise — however trivial the script. The first version did
  exactly that and reported every script as unfinished.
- Startup is ~25ms to load the bundle and single-digit milliseconds to run
  a script. The binary is ~19 MB, which is Sobek plus a 350 KB bundle —
  cheap for a tool invoked from cron.

Scripts receive the same `event` argument as an on-edit trigger, so one
script can be run by hand, by the browser on edit, or on a schedule. What
is deliberately *not* here yet: the runner is invoked per document and per
script, leaving scheduling to cron, and it does not watch for edits.

### v1 scope cuts (deliberate, recorded)

~~Single sheet per doc (tabs need a container restructure — decide before,
not after, people have data)~~ (shipped — see Multiple sheets; still
missing: tab reordering by drag, moving/copying a sheet); ~~no cell
formatting~~ (shipped — see Formatting and Dates; still missing: borders,
merged cells, conditional formatting, font size/family); ~~no fill handle or
copy-paste of formulas (hence `$` inert)~~ (both shipped — see Copy/paste
and fill; still missing: double-click-to-fill-down, weekday/month-step
series, paste-special); ~~no volatile functions (`TODAY`/`NOW` make clients
disagree and recalc time-dependent — needs thought, not code)~~ (thought
applied, then shipped — see Dates for exactly what "disagree" amounts to);
~~history *browsing* UI for sheets deferred (the log and
replay already work — only the preview renderer is markdown-specific)~~
(shipped — see Version history for sheets);
~~CSV/xlsx export later; the git exporter keeps skipping `kind=sheet` until
a text serialization is chosen (likely CSV alongside the .md files)~~ (CSV
shipped — see CSV export; xlsx still later).

---

## Comments

### Comment threads live in SQLite, not in the Yjs doc

Decided before building, because it is a schema shape and those get more
expensive with real data in them (the lesson from Multiple sheets).

A comment is **metadata about the document, not content of it**. Everything
below follows from that one sentence.

The obvious alternative — a `Y.Map` of comment id → `{anchor, author, body,
resolved}` inside the doc — was rejected despite getting live sync, offline
merge, version history, git export and sharing entirely for free from
machinery that already exists. Two things it cannot do at any price:

- **Viewers could never comment.** `ws.go` drops document writes from
  `role == "viewer"` at the socket, deliberately. In-doc comments would mean
  the only way to let someone comment is to make them an editor, which lets
  them rewrite the document. A `commenter` role is impossible by
  construction.
- **Authorship would be unverifiable.** The server never parses Yjs, so an
  in-doc `author` field is client-supplied and uncheckable. Worse, given
  Scripting: `scriptapi.js` writes to the workbook, so a shared sheet's
  script could fabricate comments attributed to whoever opened it — the
  "someone shares a sheet whose script runs as you" threat model reappearing
  on a new surface. A SQLite endpoint stamps the author from the session and
  the forgery stops being expressible.

Server-side reads follow too, and they were wanted: mentions, notifications,
and an unresolved-comment count in the document list are all impossible while
the data is inside an opaque blob.

**Anchors are a separate question, and a smaller one.** A Yjs
`RelativePosition` is a *value*: `encodeRelativePosition` yields bytes that
survive arbitrary concurrent edits and resolve back to an offset via
`createAbsolutePositionFromRelativePosition`. It tracks text without living
in the document. So the anchor is stored as an opaque `BLOB` and the server
stays exactly as content-blind as it is everywhere else — it can say a
comment exists and who wrote it, never where it points or what it quotes.
Only a client with the doc loaded can resolve one. Sheets need none of this:
`model.js` already keys cells by stable row/col ids, so a sheet comment
anchors to an id pair, the same way formula refs and chart ranges do.

Consequences accepted on purpose:

- **Comments are not versioned and not restored.** Rolling the text back to
  yesterday does not resurrect yesterday's resolved threads. A conversation
  about a document has its own lifecycle; Google draws the line in the same
  place.
- **Comments are not git-exported as document text.** The exporter commits
  what the document *is*. If comments are ever wanted in the export they get
  their own file, not inline markers.
- **⌘Z never touches a comment.** In-doc storage would have made undo scope a
  live hazard — `model.js` adds every sheet container to the UndoManager
  scope, so a comments map would have needed an explicit exclusion.
- **This is the first mutable state outside the append-only log.** Everything
  else in this project is append-and-archive. Threads are edited and resolved
  in place, so they are ordinary rows. Accepted: the durability argument for
  the log is about document content, which this is not.

Costs, stated plainly:

- **Live sync is no longer free.** It needs a third WebSocket message type
  (`provider.js` frames `0 doc, 1 awareness` today) plus hub fanout. Cheap,
  because the hub already knows rooms — but it is real code that in-doc
  storage would not have needed.
- **A new `commenter` role** between `viewer` and `editor`, which touches the
  `permissions` CHECK constraint, `roleFor`, and the share UI.

Two things to get right when building, both verified against the current
code rather than assumed:

- **Doc restore orphans every anchor.** `HistoryView.svelte` restores as
  `ytext.delete(0, length)` then `insert(0, text)`, so after a restore every
  relative position points into deleted content. Comments turn that
  full-replace from a stylistic choice into a defect: restore needs to become
  a diff-and-patch.
- **`gc` is on** (every `new Y.Doc()` here takes the default), so anchors
  into deleted text degrade. Store the quoted snippet alongside the anchor,
  so an unresolvable comment shows as a visible orphan rather than vanishing.

Implementation notes (schema v5 + the REST layer):

- **One `roleRank` map, in `docs_api.go`.** Adding a level between viewer and
  editor turned every `role == "viewer"` test into a latent hole — the socket
  check in particular, which must reject a commenter exactly as hard. It is
  now a rank comparison in all three places (`requireRole`, the `msgDoc`
  branch, share-link redemption), and the map's comment says so, because the
  next role added will be someone else's problem.
- **Share-link redemption became rank-based** rather than the enumerated
  `viewer && editor` case it was. With three grantable roles the enumeration
  would have needed every pair; the rank comparison expresses the actual rule,
  which is "a link raises access and never lowers it".
- **The author is not a field.** No request body has one — `readJSON` uses
  `DisallowUnknownFields`, so a client that sends `author_id` gets a 400
  rather than having it quietly ignored. That is the difference from the
  in-doc design stated as code.
- **Edit and delete diverge on purpose.** A document owner may delete anyone's
  comment (moderation) but may not edit one: rewriting words that stay under
  someone else's name is forgery. Only the author edits.
- **A thread never exists empty.** Opening one writes the thread and its first
  comment in a single transaction, and deleting the last comment deletes the
  thread — so no reader has to render an anchor with nothing attached.
- **Migration**: widening a CHECK constraint means rebuilding the table, so
  `permissions` and `share_links` are copied through a new table and dropped.
  Nothing points *at* either, so no `foreign_keys` toggle is needed.
  `db_test.go` migrates a *populated* v4 database, because every other test
  starts empty and would pass even if the copy dropped every row.

---

## Incidents

- **2026-08-05, two chart UX bugs, one root cause.** Both user-reported,
  both from the same mistake: **charts are real DOM inside the grid, so
  they share the grid's event scope and its handlers' assumptions.**
  1. *Charts could not be moved.* The title strip was the only drag
     handle, but a selected chart's controls fill that strip and each
     swallows mousedown to stay clickable — leaving nothing to grab.
  2. *Typing a chart title created a cell edit.* Keystrokes bubbled into
     the grid's keydown handler, which called `preventDefault` and started
     editing the cell underneath. It appeared to "work the second time"
     only because a cell edit was by then in progress and an unrelated
     early return bailed out.

  The lesson, now enforced in `SheetView.svelte`: **a surface that owns
  broad handlers (keydown, clipboard, dblclick) must check the event
  source the moment real controls live inside it**, and the check must
  name what it means — the first attempt at the guard,
  `target !== container`, would have broken double-click-to-edit on every
  cell, because the grid's own canvas is a child too.

  The meta-lesson is about testing: neither bug was reachable by the
  headless suite, which exercises the model and never mounts a component.
  Interaction logic must therefore either be **extracted into a pure,
  testable function** (as the chart drag geometry now is) or reasoned
  through case by case before shipping. "The tests pass" says nothing
  about anything that only exists once a browser is involved.

- **2026-08-05, first cell edit silently discarded (sheets).** User report:
  "most times the first time doesn't take; I have to enter it twice."
  `SheetModel` caches the row/col id index and invalidated it from Yjs
  observers — but **observers fire at the end of a transaction**, and
  `setCell` materializes rows and then reads that index back *inside* the
  same transaction. With the index fresh-but-not-flagged-stale (the canvas
  redraws constantly, and every redraw refreshes it), the rebuild was
  skipped and the value was written under the key `"undefined.undefined"`:
  invisible to every reader, so the edit appeared to vanish. The retry
  worked because the first attempt had materialized the row. Fix:
  `_invalidate()` called by mutators at the point of mutation (not only by
  observers), plus a guard that throws instead of writing an undefined key —
  the failure mode was silent data loss, which must never be quiet again.
  Node tests missed it because only a redraw-style read leaves the index in
  the fatal state; regression tests now reproduce that interleaving.

- **2026-08-04, corrupt update row.** During the full-state-resync death
  loop (see Reconnect resync), one 524,002-byte row was stored whose payload
  is the truncated prefix of a resync-style update — internally consistent
  framing, undecodable content. Forensics (`tools/inspect` + Yjs replay of
  every stored frame): all other bytes intact, and the log replayed without
  the bad row produced *identical* text to the live client's snapshot, so no
  user content was lost — the resync's content had already arrived via live
  updates. Row quarantined to `data/quarantine-row150-corrupt.bin` and
  deleted. Exact truncation mechanism unproven (candidates: abnormal-close
  edge in the websocket read path; browser-side send abort). Mitigations:
  diff resync removed the producer of huge resyncs; protocol version gate;
  client-side defensive decode + compaction lockout. The log-is-truth design
  did its job: worst case was a fallback and a forensic session, not loss.

## Open questions

- Snapshot-trigger thresholds (currently >100 tail rows or >128 KiB) and the
  1s batch-flush interval: revisit once there's real typing traffic.
- ~~Comment threads: anchor storage in the Yjs doc vs. SQLite side-table.~~
  Answered — see Comments. Still open underneath it: the **notification
  delivery channel**. In-app only needs nothing new; email needs SMTP config
  and a sending identity on a self-hosted box, which is a deployment burden
  this project has so far avoided entirely.
- Search: without server-side document reads, any full-text search must be
  client-fed. Deferred until wanted.
