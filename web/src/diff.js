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
  const edits = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      edits.push({ op: 'keep' })
      i++
      j++
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      edits.push({ op: 'del' })
      i++
    } else {
      edits.push({ op: 'ins', line: b[j] })
      j++
    }
  }
  while (i < n) {
    edits.push({ op: 'del' })
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
