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

1. Docs UI: encoded `RelativePosition` anchors + quoted-snippet fallback
2. Mentions, and in-app notifications: mention inbox, unresolved count in the
   document list
3. Email, optional: unset SMTP config means none, and the app is whole
   without it. Two events only — mentioned, and shared-with-you
4. Share UI: offer the `commenter` role (the API takes it already)

Prerequisite, and a defect in its own right: **doc restore is
delete-all-then-insert-all**, which orphans every anchor. It needs to become
diff-and-patch before step 1 ships.

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
