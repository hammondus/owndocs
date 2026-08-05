# Roadmap

Things decided but not yet built. `DESIGN-DECISIONS.md` is the *why* file —
routes considered, taken or rejected, and the reasoning. This is the *what
next* file: short lines, no argument. If an item needs a paragraph to justify
it, the paragraph belongs in the design doc and this file just points at it.

Conventions: an item is deleted from here when it ships (the design doc records
what shipped and why). Nothing lands here until it is actually decided —
undecided things stay under **Open questions** in the design doc.

---

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

## Testing

- A browser-level harness. Two user-reported chart bugs were unreachable by the
  headless suite, which never mounts a component — see *Incidents, 2026-08-05*.
  Until this exists, interaction logic must be extracted into pure functions.

---

## Deliberately not scheduled

Recorded so they are not re-proposed as oversights:

- **Comment threads** — wanted, but the anchor storage question (Yjs doc vs.
  SQLite side-table) is unanswered. Design doc, *Open questions*.
- **Search** — needs a client-fed index, since the server never reads document
  content. Deferred until actually wanted.
- **Route-level lazy loading** — measured and declined: it buys a router
  loading state to save a fraction of a second, once, on a LAN app. Design
  doc, *Static assets*.
- **Snapshot thresholds and the 1s flush interval** — revisit against real
  traffic, not in the abstract.
