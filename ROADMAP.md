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

1. Mentions, and in-app notifications: mention inbox, unresolved count in the
   document list
2. Email, optional: unset SMTP config means none, and the app is whole
   without it. Two events only — mentioned, and shared-with-you
3. Share UI: offer the `commenter` role (the API takes it already)

Not yet covered by `make test-ui`: composing a comment on a text selection.
The selection drives fine; the compose click does not produce a thread under
automation and the reason is unfound. Verify that path by hand until it is.

## Harden the login surface

The audience is trusted staff; the login page is on the public internet. These
defend the perimeter, not the colleagues — see *Threat model*.

- **`-signup=closed` in the deployed entrypoint.** The flag defaults to `open`
  and `Dockerfile` does not pass it, so the production instance currently lets
  anyone who finds the URL create an account. Needs an answer for how staff are
  onboarded once it is closed.
- **Bound concurrent password verifications.** argon2id is configured at 64 MiB
  per call and nothing limits how many run at once, so unauthenticated requests
  to `/api/login` can exhaust memory on a small arm64 box. A semaphore of a few
  permits, with a 503 past it — this is an availability bug, not a nicety.
- **Rate-limit and lock out** per account and per source address, on `/api/login`
  and `/api/share/redeem`. Trap: behind a proxy every request appears to come
  from the proxy, so this needs `X-Forwarded-For` — but trusting it blindly
  lets an attacker spoof their way around the limit. Trust it only when the
  direct peer is private/loopback, else use the peer.
- **Log failed attempts** with address and account, so an attack is visible at
  all. Nothing currently records one.
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

## Sheets — formatting

- Borders
- Merged cells
- Conditional formatting
- Font size / family

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
