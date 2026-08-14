// Minimal text patcher, used by restore.
//
// Restoring an old version used to be `delete(0, length)` then `insert(0, …)`,
// which is correct about the resulting text and wrong about everything else:
// it replaces every character in the document, so every Yjs RelativePosition
// anchored into it — every comment — is orphaned, even on a paragraph the
// restore did not touch. It also sends the whole document over the wire and
// yanks every collaborator's cursor to the end.
//
// So a restore is expressed as the edits that actually differ. Line-level,
// because markdown is line-oriented and a line is the unit a person edits;
// character-level diffing would preserve a few more anchors while producing a
// far bigger edit script and a much harder algorithm to audit.
//
// No dependency: this is a textbook LCS over lines, bounded so it cannot
// become the reason a restore hangs.

// Two 2000-line halves is 4M cells — a few tens of ms and a few MB, which is
// the point where a single replace becomes the better trade. Above it, the
// documents have so little in common that a fine-grained script would not
// preserve much anyway.
const LCS_BUDGET = 4_000_000

// splices returns {at, remove, insert} operations in ascending order of `at`,
// with offsets against the ORIGINAL string. Apply them last-first so earlier
// offsets stay valid.
export function splices(from, to) {
  if (from === to) return []

  const A = from.split('\n')
  const B = to.split('\n')

  // Trim the matching head and tail first. A restore usually differs in one
  // region, and this alone reduces most real cases to a handful of lines
  // without any table at all.
  let head = 0
  while (head < A.length && head < B.length && A[head] === B[head]) head++
  let tail = 0
  while (
    tail < A.length - head &&
    tail < B.length - head &&
    A[A.length - 1 - tail] === B[B.length - 1 - tail]
  ) {
    tail++
  }

  const midA = A.slice(head, A.length - tail)
  const midB = B.slice(head, B.length - tail)

  // Character offset where each line begins, counting the newline that
  // follows it.
  const starts = []
  let at = 0
  for (const line of A) {
    starts.push(at)
    at += line.length + 1
  }
  const offsetOf = (i) => starts[i]

  // Every splice this module emits is one of these: replace `removed` lines
  // starting at line `start` with `inserted`. Newline bookkeeping lives here
  // and nowhere else — the first version had two copies of it and they were
  // wrong in two different ways, because the last line of a document is the
  // one line not followed by a newline.
  const runSplice = (start, removed, inserted) => {
    const end = start + removed
    if (end < A.length) {
      // Interior: the removed range covers each line's trailing newline, and
      // the inserted text supplies its own.
      const at = offsetOf(start)
      return {
        at,
        remove: offsetOf(end) - at,
        insert: inserted.length ? inserted.join('\n') + '\n' : '',
      }
    }
    if (removed > 0) {
      // The run reaches the end, where there is no trailing newline to take.
      let at = offsetOf(start)
      let remove = from.length - at
      let insert = inserted.join('\n')
      if (!inserted.length && start > 0) {
        at -= 1 // nothing replaces these lines, so the newline before them goes too
        remove += 1
      }
      return { at, remove, insert }
    }
    // Pure append past the last line: supply the newline that joins it on.
    return {
      at: from.length,
      remove: 0,
      insert: (A.length ? '\n' : '') + inserted.join('\n'),
    }
  }

  const one = (start, removed, inserted) => {
    const s = runSplice(start, removed, inserted)
    return s.remove || s.insert ? [s] : []
  }

  // Either side empty means there is nothing to align — and over budget means
  // the documents share too little for a fine-grained script to preserve much
  // anyway. Both collapse to replacing the differing middle wholesale.
  if (!midA.length || !midB.length || midA.length * midB.length > LCS_BUDGET) {
    return one(head, midA.length, midB)
  }

  return fromEdits(lcsEdits(midA, midB), head, one)
}

// Standard LCS length table, walked back into an edit script. Rows are kept as
// plain arrays rather than a typed matrix so the walk-back reads like the
// recurrence it comes from.
function lcsEdits(a, b) {
  const n = a.length
  const m = b.length
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    }
  }
  // Every edit carries its text, including deletions and keeps. `splices`
  // needs it only on inserts — it takes what to remove from the original — but
  // a diff being *read* has to show the line that went away, and carrying it
  // here keeps one edit script serving both callers.
  const edits = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      edits.push({ op: 'keep', line: a[i] })
      i++
      j++
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      edits.push({ op: 'del', line: a[i] })
      i++
    } else {
      edits.push({ op: 'ins', line: b[j] })
      j++
    }
  }
  while (i < n) {
    edits.push({ op: 'del', line: a[i] })
    i++
  }
  while (j < m) {
    edits.push({ op: 'ins', line: b[j] })
    j++
  }
  return edits
}

// Turn the line edit script into character splices, coalescing each run of
// adjacent deletes and inserts into one operation — a changed line is a delete
// next to an insert, and emitting them separately would double the ops and
// churn positions that a single replace leaves alone.
function fromEdits(edits, head, one) {
  const out = []
  let line = head // index into the original line array
  let i = 0
  while (i < edits.length) {
    if (edits[i].op === 'keep') {
      line++
      i++
      continue
    }
    const start = line
    let removed = 0
    const inserted = []
    while (i < edits.length && edits[i].op !== 'keep') {
      if (edits[i].op === 'del') {
        removed++
        line++
      } else {
        inserted.push(edits[i].line)
      }
      i++
    }
    out.push(...one(start, removed, inserted))
  }
  return out
}

// ---- the same diff, for reading ---------------------------------------------
//
// `splices` answers "what edits turn A into B" for a machine to apply. This
// answers "what changed" for a person to read, off the same LCS: line numbers
// on both sides, unchanged runs collapsed to a little context, and the whole
// thing grouped into hunks.
//
// Deliberately a second entry point rather than a flag on the first. A splice
// is a character range with no notion of a line number, and a hunk is a list of
// lines with no notion of a character offset; folding them together would mean
// one caller always carrying the other's bookkeeping.

// How many unchanged lines sit either side of a change. Three is the
// convention every diff tool settled on, and the reason is legibility rather
// than arbitrary: it is enough to recognise where you are in a document, and
// little enough that two nearby edits still read as one region.
const CONTEXT = 3

// hunks(from, to) -> {identical, coarse, added, removed, hunks: [{skipped, rows}]}
//
// A row is {op: 'keep'|'del'|'ins', text, a, b} where `a` and `b` are 1-based
// line numbers in the old and new text, null on the side where the line does
// not exist. `skipped` is how many unchanged lines were collapsed before that
// hunk, so the view can say what it is not showing rather than silently
// dropping it.
export function hunks(from, to, context = CONTEXT) {
  const A = from.split('\n')
  const B = to.split('\n')
  if (from === to) return { identical: true, coarse: false, added: 0, removed: 0, hunks: [] }

  // Same head/tail trim as splices, and for the same reason: one edited
  // paragraph in a long document should cost an LCS over the paragraph, not
  // over the document.
  let head = 0
  while (head < A.length && head < B.length && A[head] === B[head]) head++
  let tail = 0
  while (
    tail < A.length - head &&
    tail < B.length - head &&
    A[A.length - 1 - tail] === B[B.length - 1 - tail]
  ) {
    tail++
  }

  const midA = A.slice(head, A.length - tail)
  const midB = B.slice(head, B.length - tail)

  // Over budget means the two versions share too little for an alignment to
  // tell anyone anything — the same call splices makes, and the view is told
  // so it can say "shown as a wholesale replacement" instead of implying the
  // line pairing below means something.
  const coarse = midA.length * midB.length > LCS_BUDGET
  const midEdits =
    coarse || !midA.length || !midB.length
      ? [
          ...midA.map((line) => ({ op: 'del', line })),
          ...midB.map((line) => ({ op: 'ins', line })),
        ]
      : lcsEdits(midA, midB)

  const rows = []
  for (let k = 0; k < head; k++) rows.push({ op: 'keep', text: A[k], a: k + 1, b: k + 1 })
  let a = head
  let b = head
  for (const e of midEdits) {
    if (e.op === 'keep') {
      rows.push({ op: 'keep', text: e.line, a: a + 1, b: b + 1 })
      a++
      b++
    } else if (e.op === 'del') {
      rows.push({ op: 'del', text: e.line, a: a + 1, b: null })
      a++
    } else {
      rows.push({ op: 'ins', text: e.line, a: null, b: b + 1 })
      b++
    }
  }
  for (let k = 0; k < tail; k++) {
    rows.push({
      op: 'keep',
      text: A[A.length - tail + k],
      a: A.length - tail + k + 1,
      b: B.length - tail + k + 1,
    })
  }

  return {
    identical: false,
    coarse,
    added: rows.reduce((n, r) => n + (r.op === 'ins' ? 1 : 0), 0),
    removed: rows.reduce((n, r) => n + (r.op === 'del' ? 1 : 0), 0),
    hunks: group(rows, context),
  }
}

// Keep every changed row and the `context` rows either side of it, then cut
// what survives into contiguous runs. Two changes closer together than twice
// the context merge into one hunk for free, because their context windows
// overlap — no special case needed for "are these near enough to join".
function group(rows, context) {
  const shown = new Array(rows.length).fill(false)
  rows.forEach((r, i) => {
    if (r.op === 'keep') return
    const lo = Math.max(0, i - context)
    const hi = Math.min(rows.length - 1, i + context)
    for (let j = lo; j <= hi; j++) shown[j] = true
  })

  const out = []
  let current = null
  let skipped = 0
  for (let i = 0; i < rows.length; i++) {
    if (!shown[i]) {
      skipped++
      current = null
      continue
    }
    if (!current) {
      current = { skipped, rows: [] }
      skipped = 0
      out.push(current)
    }
    current.rows.push(rows[i])
  }
  return out
}

// apply is here so the algorithm and its inverse live together and the tests
// can check them against each other. Callers on a Y.Text do the same walk with
// delete/insert inside one transaction.
export function apply(from, ops) {
  let out = from
  for (let i = ops.length - 1; i >= 0; i--) {
    const { at, remove, insert } = ops[i]
    out = out.slice(0, at) + insert + out.slice(at + remove)
  }
  return out
}
