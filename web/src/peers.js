// Who is who, in colour. One list, shared by the editor and the grid.
//
// This existed twice — byte-identical arrays in EditorView and SheetView —
// which is the failure the document palette was built to avoid: "three copies
// of a colour list is three chances for them to disagree". Neither copy had
// ever had to change, so neither had diverged yet. Dark mode was the change
// that would have made them.
//
// ── Why these are not light/dark pairs ──────────────────────────────────────
// Every other colour in this app is chosen by the machine that *renders* it.
// A peer colour cannot be: awareness carries it from the person it belongs to,
// and y-codemirror.next reads `user.color` and `user.colorLight` straight off
// that state to draw a remote caret. So the value is picked on the sender's
// machine and painted on the receiver's, and the two need not agree about the
// scheme. Publishing a dark-scheme colour would mean a peer in dark mode is
// drawn in dark-mode colours on a light screen.
//
// Rather than a protocol that carries an index and resolves it per viewer —
// which the library's contract does not allow for the editor — both roles are
// made scheme-independent:
//
//   * the caret sits at a middle lightness, dark enough to read on white and
//     light enough to read on near-black; and
//   * the selection wash is the same colour with an alpha channel, so it
//     composites over whatever ground it lands on instead of replacing it.
//     This is the trick the interface already uses for its hairline greys,
//     which are `#8884` for exactly this reason.
//
// Hues are the eight from palette.js, in the same order, so a person's colour,
// a document colour and a chart series all come from one wheel.

const HUES = [25, 60, 95, 145, 195, 255, 300, 345]

// Generated rather than listed, so the set stays even: one lightness and one
// chroma, hue the only variable, which is what stops any one person's cursor
// shouting louder than another's.
export const PEERS = HUES.map((h) => ({
  hue: h,
  caret: `oklch(0.62 0.18 ${h})`,
  wash: `oklch(0.62 0.18 ${h} / 0.22)`,
}))

// Everyone derives the same colour for the same client, so a person keeps one
// colour across both views and across every other participant's screen.
export const peerColor = (clientID) => PEERS[clientID % PEERS.length]
