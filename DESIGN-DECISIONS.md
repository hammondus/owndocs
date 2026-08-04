# Design Decisions

Self-hosted collaborative docs + sheets ("Google Docs clone"). Go backend,
Svelte frontend. This file records *why* each non-obvious route was taken, for
future me, reviewers, and Claude. Newest decisions at the bottom of each
section; superseded decisions get struck through, not deleted.

Last updated: 2026-08-04 (pre-code planning phase).

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
`coder/websocket`'s default same-origin check on upgrade; signup is currently
open — gate or invite-code it before exposing an instance to the internet.

### Static assets: everything no-cache until content-hashed

The bundle (`app.js`) is unhashed and changes every build; `max-age` let
browsers run a stale bundle for up to an hour after a rebuild, which made
debugging incoherent (old client code against a new server). Deviation from
the usual "unhashed assets get ~1h" policy is deliberate and temporary:
switch to `public, max-age=31536000, immutable` when the Vite build
introduces content-hashed asset names.

### Version history: the archived update log *is* the history

Because compaction archives rather than deletes (see Compaction), the full
edit history survives in `history_segments` — version history and compaction
are one mechanism, not two. Named versions are just labelled sequence numbers;
any past state is reconstructable by replaying the log to that point.
"Restore" is a new update that overwrites current state — history itself is
never rewritten.

### Import/export

xlsx via `excelize` (mature, justified). Doc export is now trivial: the
document *is* markdown, and HTML export is a render of it. See Scope for why
docx is excluded.

---

## Open questions

- Snapshot-trigger thresholds (currently >100 tail rows or >128 KiB) and the
  1s batch-flush interval: revisit once there's real typing traffic.
- Comment threads: anchor storage in the Yjs doc vs. SQLite side-table.
- Search: without server-side document reads, any full-text search must be
  client-fed. Deferred until wanted.
