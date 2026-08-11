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
- **Pivot tables, ~~charts,~~ array formulas** — each is its own project.
  (Charts shipped after all — see Charts. Pivot tables and array formulas
  stand.)
- **docx import/export** — fidelity is endless, and `unioffice` went
  commercial. Export is Markdown/HTML/CSV/xlsx instead.
- Offline editing, mobile apps.

### Invite links: how an account exists once signup is closed

A publicly reachable instance has to run `-signup=closed`, which left no way to
add staff — so accounts now come from invite links, modelled on share links
because they are the same shape of thing: a bearer capability, stored as
SHA-256, plaintext returned once at creation, revoked and reissued rather than
recovered.

Two differences from a share link, both following from what an invite grants:

- **Single use.** A share link grants access to one document and is naturally
  reusable. An invite creates an *account*, and "the link for the new hires" is
  how one invite quietly becomes six.
- **Seven days.** An old invite in a mailbox is a standing offer to join the
  instance, long after the person it was meant for did or did not take it up.

**Any signed-in user may invite.** There is no global admin in this app — roles
are per-document — and inventing one for this is out of proportion to a company
where everyone with an account is staff. The upgrade path, if it is ever
wanted, is a flag on `users` checked in `handleCreateInvite` and nowhere else.

Claiming and account creation share one transaction, and the claim is an
`UPDATE ... WHERE used_at IS NULL` rather than a check followed by a write.
Two reasons, one of which is not yet load-bearing: a rejected password must not
cost someone their invite (it is, today — the rollback is why), and concurrent
claims must not both succeed (they cannot today anyway, since the pool is
`MaxOpenConns(1)` and transactions serialize — but that is a pool setting, not
a guarantee anyone will remember this depends on).

Two defects fixed alongside it, both consequences of the login being public:

- **`-signup=closed` is now in the Dockerfile entrypoint.** The flag defaults
  to `open` and the entrypoint never passed it, so the production instance had
  been letting anyone who found the URL create an account.
- **Concurrent password hashing is bounded.** argon2id at 64 MiB per call is
  correct against guessing, but it is paid by the server on unauthenticated
  input — a few dozen simultaneous `/api/login` posts is a gigabyte on a box
  that has not got many. Four permits, 5s wait, then 503. The fix is a bound,
  not a cheaper hash, and a rate limiter would not replace it: a burst inside
  one window allocates before any limiter has counted it. The unknown-account
  dummy verify takes a permit too, or the timing-equalisation it exists for
  would have become a way around the bound.

Failed logins are now logged with the source address, resolved by `clientIP()`.
Behind a proxy every request appears to come from the proxy, so that needs
`X-Forwarded-For` — but honouring it unconditionally lets anyone reaching the
app directly claim any address. It is trusted only when the immediate peer is
loopback or private, and only its last entry, which is the one the proxy wrote.

### Renaming: an HTTP write, not a collaborative edit

The rename endpoint existed from the beginning; nothing in the UI ever called
it. Now the title is editable in place — double-click, matching the gesture the
sheet tabs already used, so there is one thing to learn rather than two — from
the document header and from the list.

Worth knowing: **a title lives in SQLite, not in the Yjs document.** So a
rename is an ordinary HTTP write and does not reach anyone else's open tab
until they reload. That is the right trade for a title and would be the wrong
one for content; if it ever grates, the fix is a nudge on the socket exactly
like `msgComments`, not moving the title into the document.

The permission check moved from `role != "owner" && role != "editor"` to a
rank comparison. A title is document content in every sense that matters, so
the bar is "may edit" — and equality tests written that way are precisely what
adding `commenter` broke in three other places.

### Formatting: semantic constructs in the document, appearance in the viewer

Decided 2026-08-05, and it settles the escape-hatch question by refusing it.

**The document gets semantic constructs only** — things markdown can say a
piece of text *is*. Headings, lists, quotes, code, tables, and later callouts,
highlight, footnotes, super/subscript. No font family, no arbitrary size, no
colour, no paragraph alignment: those are appearance, markdown has no
representation for them, and every way of smuggling them in costs something
this project deliberately bought. Raw HTML needs a sanitizer and makes the git
export noise; a directive syntax of our own weakens the "it is just a markdown
file" property the exporter exists for; attributes outside the text break the
property that the document *is* the markdown.

**Appearance is the viewer's, not the author's.** Each person chooses the font,
size, line height and measure that markdown renders as for them, and that
choice never enters the document, the CRDT or the export. This is the reader's
stylesheet, and it is why refusing the escape hatch costs so little: nobody
actually wanted Times New Roman *stored in the file* — they wanted to read in
Times New Roman.

It also lands the preference in the right place for a collaborative editor. A
document-level font is a setting one person changes and everyone else lives
with; a viewer-level font is a setting that cannot start an argument.

Stored in `localStorage`, per person per machine, following the precedent set
by trigger consent — which is deliberately local for a different reason, but
establishes that not every choice needs a row in the database. Two machines
means setting it twice; an account setting is the upgrade path if anyone asks.

Implementation (`prefs.js`, `ReadingPrefs.svelte`):

- **Applied through a CodeMirror theme, not through `app.css`.** The base
  theme sets `font-family: monospace` on the scroller, and CodeMirror's
  injected styles beat an app rule of equal specificity. The first version put
  everything in `app.css` and appeared to work: font *size* is set on
  `.cm-editor`, which the base theme does not touch, so it took effect while
  family, line height and measure silently did nothing. `EditorView.theme()`
  is applied after the base theme by construction — precedence by design
  rather than by stylesheet order.
- **The values stay CSS custom properties**, set on the root element in
  `main.js` before the first paint. The theme references them, so preferences
  remain live and every mounted editor follows without being told.
- **Stored preferences merge over the defaults**, never replace them. A blob
  written by an older build is missing whatever was added since, and trusting
  it wholesale is how a new preference arrives permanently unset.
- **Every `localStorage` access is guarded.** Some privacy modes throw on
  *touching* it, not on writing, so this is a `try` around the property read
  as well as the call. A preference failing to save must not take the editor
  down with it.
- **A zero measure becomes `none`, not `0ch`** — the difference between "no
  limit" and a column of zero width.
- **Code stays monospace** because `.md-code` and `.md-codeblock` set their own
  family, which outranks the inherited one. That was already true; it is now
  load-bearing, so it has a test and a line in the panel saying so.
- **CodeMirror re-measures on change.** It caches per-line heights, and size or
  family changes them without it noticing — `view.requestMeasure()` is what the
  panel's `onChanged` is for.
- **Any installed font, not just the four built-ins.** `queryLocalFonts()`
  lists what is actually on the machine — but it is Chromium-only, needs a
  secure context, and prompts for permission, so it is behind a button (a
  permission prompt needs a user gesture) and degrades to a plain text field
  everywhere else.

  Once the list is known the control is a **`<select>`**, each option drawn in
  its own family. A `<datalist>` was the first attempt and is the wrong control
  here: the browser filters it by whatever is already in the field, so choosing
  a font left that font as the only visible option until the text was cleared
  by hand — a picker that hides the thing you are picking from. The typed-name
  input remains for the case where enumeration never happens.
- **A named family is stored beside the built-in id, not instead of it.**
  `family` wins when set; `font` stays an id. Re-stacking or relabelling a
  built-in later then does not orphan everyone's stored preference.
- **A family name is user input reaching a CSS declaration**, so it is reduced
  to the characters a font name can contain, quoted, and given a generic
  fallback. Not a security boundary — `setProperty` parses the value rather
  than splicing it into a stylesheet — but one stray character invalidates the
  whole declaration silently, which is the failure `Helvetica Neue` already
  caused once.
- **A multi-word family needs quotes inside the stack.** `Helvetica Neue`
  unquoted invalidates the whole `font-family` declaration, so that option
  silently fell back to the previous font rather than failing visibly.
- **Reachable from the document list as well as from inside a document.** The
  first version put the control only in the markdown editor, which is where
  the preference has an effect but not where anyone looks for a setting —
  and it left it invisible entirely to someone in a spreadsheet or on the
  list. A global preference reachable from one screen is a preference nobody
  finds. Deliberately *not* in the sheet view: nothing there would change,
  and a control that does nothing is worse than an absent one.

### The plain-markdown constructs, and the five traps in shipping them

Shipped 2026-08-11: H4–H6, numbered and nested lists, fenced code blocks with
syntax highlighting, horizontal rules, hard line breaks, and a way to *write*
table column alignment. These were the roadmap's "free" list — free because
`lezer-markdown` already emits a node for every one of them, and the live
preview is a decoration layer over that tree. A construct the parser does not
report cannot be styled at all, which is the line between this batch and the
next one (highlight, footnotes, callouts), where each item needs a parser
extension before any of it is possible.

Nothing here changes the document model. Every one is text a `.md` file
already holds, so the git exporter needed no change and neither did the CRDT.

**Enter was already right; Tab was the missing half.** `markdown()` installs
its own keymap at `Prec.high`, binding Enter to `insertNewlineContinueMarkup`
— so continuing a list and incrementing its number worked before any of this.
What nothing bound was nesting. Tab is bound here rather than left to the
language package because the command *declines* outside a list: an editor that
swallows Tab everywhere is one a keyboard user cannot escape, so
`indentListCmd` returns false unless the selection actually touches a list
item, and Tab keeps moving focus everywhere else.

**A nesting step is not two spaces.** It is the parent item's content column:
2 under `- a`, but 3 under `1. a`, and 4 under `10. a`. Two spaces under a
numbered item is not a nested list at all — CommonMark reads it as a lazy
continuation of the same paragraph. Indent is therefore derived from the
nearest preceding item the line could become a child of, which also caps it at
one level: you cannot Tab past a level that does not exist yet.

**Indenting does not renumber**, deliberately. A nested item keeps the number
it had, so `2. two` indented becomes a nested list starting at 2. That is legal
markdown and renders as written. The alternative was rejected on the multi-line
case: renumbering the first line of a selection and not the rest is worse than
renumbering none, and renumbering all of them destroys the relative numbering
the selection came in with.

**A rule needs a blank line above it.** `---` directly under a paragraph is a
setext heading — it underlines the text above rather than drawing a rule. So
`insertRule` emits the blank line itself when the current line has text.

**Fence markers are dimmed, not hidden.** Every other marker in this editor is
hidden unless the selection touches its construct, and applying that rule to
` ``` ` is worse: the fence lines still exist, so the block renders with an
empty line above and below it that reads as stray padding. They stay visible
at low contrast, which also keeps the language tag readable.

**Alignment was half-built already.** `table.js` has parsed `:---`/`:---:`/
`---:` since tables shipped, and the widget has honoured it. What was missing
was any way to *write* it, so this adds a command that cycles the column the
cursor is in by rewriting one cell of the delimiter row — keeping the cell's
width, so the pipes in the source stay lined up. Left is written as plain
`---` rather than `:---`: markdown renders the two identically, so three
states is the entire vocabulary. The command resolves the table through
`ensureSyntaxTree`, not `syntaxTree`, for the reason `buildTableDecorations`
already records — the parser works to a budget and the table under the cursor
need not be in the tree yet.

**Six heading levels are a menu, not six buttons.** The menu is stateless: it
does not report the current line's level. Everything else on this toolbar is a
canned text edit rather than a mode, and a control that looked like state but
only sometimes was would be worse than one that never claims to be.

**Found while doing this, and fixed:** the toolbar was gated on
`role !== 'viewer'`, so a **commenter** saw it. A commenter's editor is mounted
read-only for the reason `roles.js` states — the provider would send a doc
update and the server would close the socket — but `EditorState.readOnly` only
stops *user input*. A toolbar button is a programmatic `view.dispatch` and goes
straight through it. Clicking Bold as a commenter edited the document and lost
the connection. The gate is now `canEdit`. Same class of bug as the one
`handleCheckboxClick` already guards against by hand.

Pure logic lives in `mdtext.js` — list toggling, indentation, delimiter-row
rewriting — with no CodeMirror import, by the rule `table.js` set: it takes
strings and returns edits as plain offsets, so `mdtext_test.mjs` runs it in
node with no DOM. Line edits are returned as *prefix* replacements rather than
whole-line rewrites, because replacing a whole line drags the cursor to one end
of it.

### The extended constructs: highlight, callouts, definition lists, and three that were already there

Shipped 2026-08-11, right behind the plain-markdown batch: `==highlight==`,
`x^2^` / `H~2~O`, `:emoji:`, `> [!NOTE]` callouts, and definition lists. Still
plain text, still round-trips through the `.md` file, still no escape hatch —
see *Formatting*. What separates these from the previous batch is that the
grammar did not know four of the six, and a construct the parser does not
report cannot be decorated at all.

**Only two needed a parser extension.** The other four were cheaper than the
roadmap assumed, in two different ways:

- **Superscript, subscript and emoji were already parsing.** `markdownLanguage`
  is lang-markdown's *extended* parser, and it has always been configured with
  `[GFM, Subscript, Superscript, Emoji, …]`. This app has used it since the
  editor was written. All three were emitting nodes the whole time and nothing
  was styling them, so what shipped is CSS, not grammar.
- **Callouts need no parser at all**, which is the reason the syntax was chosen
  over inventing one: `> [!NOTE]` is *already a valid blockquote*. It degrades
  to an ordinary quote in every other markdown tool, and the git export stays
  readable.

**A callout marker has to be intercepted, not merely styled.** `[!NOTE]` parses
as an ordinary `Link` — brackets and all — so without a special case the label
renders as a hyperlink and the brackets get hidden by the generic marker rule.
The whole node is replaced with the label widget and its children skipped,
exactly as `Image` does it, because a replace decoration may not contain other
decorations. Text alone is not enough to identify one: it counts only at the
very start of the first paragraph of a blockquote, which is where the syntax
puts it anyway. An unrecognised kind is still treated as a callout and styled
as a note, so `[!EXAMPLE]` written for another tool does not read as broken.

**Emoji is the one that needs data, not code.** The parser marks `:name:` and
stops; there is no shortcode table in a browser and `Intl` does not expose CLDR
annotation names. `emoji.js` is a **curated ~250 entries**, not the full ~1800:
the whole set would be the largest file in this project for a convenience
feature. An unknown shortcode is left as literal text, which is the right
failure — that is exactly what it looks like in the `.md` file read by anything
else, so the document reads the same everywhere. It is a `Map` rather than an
object literal because `:constructor:` is a valid spelling and a bare object
resolves it to a function. One known gap, asserted in the test so it stays a
known one: the upstream extension's character class is `[a-zA-Z_0-9]`, so
GitHub's `:+1:` and `:-1:` never reach the table — the `thumbsup` and
`thumbsdown` aliases are carried for that reason.

**Definition lists are a leaf-block parser**, the same machinery GFM tables
use and for the same reason: the first line looks exactly like a paragraph, and
only the *second* line reveals what the block is. So the parser accumulates
lines and decides in `finish()`, which also makes the terminating blank line
free. Deliberately strict about what a definition line is — `:` then a space,
at the start of the line. Pandoc also allows `~`, indented continuations, and a
blank line between term and definition; each costs a lookahead rule and none is
what anyone typing a definition list actually writes. The negative cases matter
more than the positive ones and are tested as such: a wrapped two-line
paragraph must not become a definition list, and `12:30` on its own line must
not either.

**Highlight copies Strikethrough's open/close rules** rather than using a
regex, so `==` behaves like `~~` — behaving *differently* would be the
surprise. That also means it nests with the rest of the inline grammar, which a
regex could not: `==**bold** inside==` parses both, and a code span still wins.

`mdext.js` imports `@lezer/markdown` only, no CodeMirror and no DOM, so
`mdext_test.mjs` parses strings in node and asserts on the tree.

**A trap that cost a debugging round:** `parser.configure()` takes the
extension, or a nested array of them, *directly*. An object like
`{extensions: [...]}` is not a `MarkdownConfig`, and is accepted and ignored in
silence. The first version of the test did exactly that and still passed its
superscript assertions — because those come from `markdownLanguage` regardless
— while both new extensions did nothing at all. (`markdown()` from
lang-markdown *does* take `{extensions}`; the two APIs are one level apart.)

**Found while doing this, and fixed:** `.md-blockquote { padding-left: .6rem }`
in `app.css` **never worked**. CodeMirror's base theme sets
`.cm-line { padding: 0 2px 0 6px }`, and its injected styles beat an app rule
of equal specificity — the same trap the reading preferences hit, already
recorded above under *Formatting*. Blockquotes have been shipping with their
text flush against the rule since blockquotes landed; it is subtle enough that
nobody reported it. Every rule setting padding on a line is now qualified
`.cm-line.md-…`, which is (0,2,0) against (0,1,0) and wins on specificity
rather than on load order. There is now a browser assertion on the computed
padding, so it cannot regress quietly a second time.

Two smaller decisions worth recording:

- **Superscript and subscript are positioned, not `vertical-align`d.** Sub- and
  superscript via `vertical-align` grow the line box, and CodeMirror caches
  per-line heights — a construct that silently changes them is a construct that
  makes it re-measure. `position: relative` with a `top` offset does not.
- **Highlight pins its text colour.** It is the one place in the editor that
  does. A highlighter pen is a light ground by definition, so inheriting the
  dark-mode foreground would put near-white text on yellow.

### The emoji picker inserts the shortcode, not the character

Shipped 2026-08-11. A toolbar drawer showing the whole curated table as
itself, grouped, with a search box; Enter takes the first match, so a name you
already know needs no mouse.

**What lands in the document is `:warning:`, not ⚠️.** The alternative was
weighed and is a real argument — a literal character renders in every tool,
including the ones that know nothing about shortcodes, and this project cares
about the `.md` file reading the same everywhere. Two things decided it:

- This app already renders shortcodes. If the picker wrote characters, the
  rendering half would serve only the people who never open the picker, and the
  two halves of one feature would disagree about what a document looks like.
- The file stays ASCII, which is friendlier in a `git diff` and in a terminal.

Nothing is lost visually: the decoration replaces the shortcode as it is
inserted, so you see the character immediately — one keystroke later, anyway.
The cursor lands *at the end of* the shortcode it just wrote, which touches the
node, so live preview correctly keeps the source visible until you move off it.
That is the same rule every other marker in this editor follows, and the
browser test says so out loud, having first been written the other way.

Smaller decisions:

- **`emoji.js` is grouped, not flat.** The picker needs the categories, and a
  separate list of them would be the same fact written twice. The lookup `Map`
  is built by flattening the groups, so adding an entry puts it in both.
- **A toolbar entry with a `panel` id rather than a `run`.** The toolbar stays
  one ordered list; `EditorView` maps the id to a component. The alternative
  was a control living outside the toolbar data, beside it, which is how a
  toolbar stops being a list.
- **Focus is not taken back after a pick**, so several can be inserted in a
  row. Safe because the selection lives in CodeMirror's state, not in the DOM.
- **One `openPanel` value, not a flag per panel.** Two drawers open at once
  would push the editor off the screen, and only one can be wanted at a time.
- **The panel uses the `#8881`/`#8884` alpha convention** rather than the
  hardcoded light greys `ReadingPrefs` uses, so it works in both schemes.

### Fenced code blocks: highlighting costs 117 files, not 117 downloads

`@codemirror/language-data` is the one dependency this batch adds — a table
mapping a fence's language tag to a dynamic `import()` of its grammar. 29
packages, 6 MB of `node_modules`.

What it costs the *client* is small, and was measured rather than assumed: the
eagerly-loaded bundle goes from 735 kB to 777 kB (+42 kB raw, ~13 kB gzipped),
which is language-data's own lookup table. The 117 grammars are separate
chunks, fetched the first time a block declares that language; a document with
no code blocks pays nothing.

That only holds because of a change to `manualChunks` in `vite.config.js`, and
this is the trap: **naming a chunk overrides Rollup's dynamic-import
splitting**. The existing rule sweeps anything matching `codemirror` or `lezer`
into `vendor-editor`, which would have pulled all 117 grammars into the
eagerly-loaded chunk and turned a 42 kB cost into roughly a megabyte. The
config now returns undefined for `@codemirror/lang-*`, `@codemirror/legacy-modes`
and the `@lezer/*` grammars, leaving the lazy boundary intact.

What it does cost is the artifact: `web/static` goes from 4 JS files to 121,
all of them embedded in the Go binary. If that is ever unwanted, the way out is
not to filter `languages` at runtime — the `import()` calls are still in the
source, so Rollup still emits every chunk — but to replace the table with a
hand-written list of `LanguageDescription.of({...})` for the languages actually
wanted, which drops the dependency entirely at the cost of an unknown tag
falling back to plain text.

The highlight style is ours and covers **only code tokens** — keyword, string,
comment, number, name, type. `defaultHighlightStyle` also styles markdown's own
tags (heading, strong, emphasis, link), which the live-preview decorations
already own, and two rules fighting over the same span is how a heading ends up
a colour nobody chose. The colours are CSS custom properties defined in
`app.css` so the light/dark pair sits with the rest of the app's colours;
unlike the `#8884` alpha trick used elsewhere, a syntax colour is a real hue and
cannot serve both grounds.

### Table of contents: a reading preference, not a document feature

Shipped 2026-08-11. Off by default; left or right; a depth limit from H1 to
H1–H6.

It belongs with the font and the measure, and for the same reason (*Formatting*
above): it is built entirely from headings the document already has, adds
nothing to it, and one reader wanting it does not mean everyone gets it. So it
is two more fields in the `localStorage` blob and nothing in SQLite, the CRDT
or the export. **Nothing is stored** — no anchors, no ids, no slugs, and
therefore no migration when a heading is renamed. The document says what its
headings are and the panel reads them back.

- **Read from the syntax tree, not from a regex over the text.** `# hash` in a
  fenced code block is not a heading, and only the parser knows that.
- **The heading's node, not its line.** A heading inside a blockquote starts
  after the `>`, and reading the line put the quote marker in the contents —
  found by the browser test, which is exactly the sort of thing it is for.
  Setext headings span two lines, so only the first is the title.
- **`ensureSyntaxTree` with a budget, and a fallback**, for the reason
  `buildTableDecorations` records: the parser works incrementally and a heading
  below the viewport need not be in the tree yet. If the budget runs out the
  partial tree is used — contents that are briefly short beat contents that
  block typing.
- **Debounced 300 ms, and on `docChanged` only.** Walking the tree per keypress
  is the cost worth avoiding; being 300 ms stale in a list of headings is not a
  cost anyone can perceive. A `ViewPlugin` rather than a bare `updateListener`,
  purely for `destroy()` — leaving the document with a rebuild pending would
  otherwise fire it against an editor that no longer exists.
- **One listener covers collaborators too.** A remote edit arrives as a
  CodeMirror transaction like any other, so this does not need to hang off the
  `Y.Text` the way the comment repaint does.
- **Hidden when a document has no headings.** An empty column beside the text
  is worse than no column, and it is exactly what a new document has.
- **Left/right is `flex-direction: row-reverse`**, so the contents stay first
  in the DOM whichever side they are drawn on — which is where a screen reader
  wants a nav landmark. The editor needs `min-width: 0`, or a long unbreakable
  line inside CodeMirror pushes the column off the page; flex items refuse to
  shrink below their content by default.
- **The page widens via `:has()`.** The `.page` wrapper is `App.svelte`'s and
  the contents panel is `EditorView`'s; `:has()` lets the width follow the
  editor's markup without either learning about the other. The alternative was
  a custom property set on the root at mount and cleared on destroy, which is
  the same fact in two places plus a lifecycle to get wrong.
- **Dropped below 60rem.** There is no room for two columns on a narrow window
  and the text is what matters, so the contents go rather than being squeezed.
- **The active entry is derived from the cursor**, using the selection the
  editor already reports for the comment composer. No new listener.
- **`apply()` sets nothing for it**, unlike every other reading preference —
  this one is a layout decision, not a CSS custom property. There is a test
  asserting that, so adding a `--toc-…` property later is a deliberate act
  rather than an accident that puts the same fact in two places.

### Threat model: trusted users, untrusted network

The audience is **staff inside one company**, all authenticated, all known to
each other. The adversary this is built against is *mistake* — a wrong share, a
lost edit, a bad restore — not a colleague attacking a colleague. Security is
required, but it does not have to price in a hostile user, and features whose
only value is against one are not worth their friction here.

What that rules out spending on, unless someone asks: email verification, 2FA,
rate limiting and lockout, audit trails, per-field encryption, and hardening
against a determined authenticated attacker.

What it does **not** relax, because the reasoning is different:

- **The network is not internal even when the audience is.** Confirmed
  2026-08-05: the login page *is* publicly reachable, and only company staff
  have accounts. So password hashing (argon2id), session handling, hashed
  share tokens and `-signup=closed` keep earning their place — they defend the
  perimeter, not the colleagues, and the perimeter is the open internet. Two
  defects that followed from it are fixed — see *Invite links* — and what is
  still owed is in `ROADMAP.md` under *Harden the login surface*.
- **Server-side permission checks stay**, because they are also what keeps the
  UI honest. `roleFor` is the thing that makes "viewer" mean something; take it
  out and a bug becomes a data-loss event rather than a rejected write.
- **Defences already built and paid for stay built.** The scripting sandbox is
  the clear case: it exists for "someone shares a sheet whose script runs as
  you", which is far less alarming among colleagues — but it costs nothing now,
  and an opaque-origin iframe is not a thing to unpick for tidiness.

The distinction to hold on to: a document id is 128 bits of `crypto/rand`
(stronger than a UUIDv4's 122, and no reason to change), which makes a leaked
id in a log survivable — but it is a *name*, not a capability. Share-link
tokens are the opposite: there the secret **is** the access, which is why only
their SHA-256 is stored. Treating an unguessable id as if it were a permission
is how "unlisted means private" systems get built, and this is not one.

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

One exception exists and is load-bearing: the code-block grammars are lazy,
and `manualChunks` has to *decline* to name them or they stop being. See
*Fenced code blocks* — naming a chunk overrides Rollup's dynamic-import
splitting, so the rule above would otherwise have dragged all 117 of them
into `vendor-editor`.


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

### Live fanout: `msgComments`, a nudge rather than a delta

Comments are written over HTTP, so the socket's job is only to say *that* they
changed. Type byte 2 carries **no payload**: the GET handler is the single
place that assembles what the comment state is, and putting a delta on the
wire would mean a second assembly path plus a client-side merge to keep in
step with it. Clients refetch, which is affordable because comments change at
human speed — unlike keystrokes, which is why `msgDoc` cannot work this way.

Two properties that make it unlike the other two message types:

- **Server → client only, and server-*originated*.** Every other message is
  relayed from a peer. Nothing may accept `msgComments` *from* a client: the
  reader's switch handles the two client types and drops the rest, which is
  what stops a peer fabricating comment activity at everyone else. There is a
  test for the forgery specifically, using a following legitimate update as a
  barrier — if the forged message were relayed it would arrive first.
- **It fires after the write commits**, not before. A client refetching on the
  nudge must not race the transaction that caused it.

Sent to everyone including whoever made the change: an HTTP request and a
WebSocket connection are separate things, so the room cannot tell which socket
belongs to the caller, and one redundant refetch is cheaper than the
bookkeeping to find out. No protocol version bump — the client demultiplexes
with an `if/else if` chain and ignores unknown types, so a tab on the previous
v2 bundle sees nothing rather than breaking.

### Comments on sheets: the anchor is already there

Sheet comments needed no anchor mechanism at all, which is why they went
first. `model.js` keys cells by stable row/col ids, so an anchor is
`{k:'cell', sheet, row, col, quote}` — the same identity formula references
and chart ranges use, and it follows inserts and deletes for the same reason
they do. The `k` field is an envelope so the document anchor (`k:'text'`, a
pair of encoded RelativePositions) can share the column.

- **The panel knows nothing about sheets.** It takes threads, a `label(thread)`
  function and callbacks, so the docs UI can reuse it whole.
- **Markers are resolved once per change, not per frame.** `commentedCells`
  holds *positions*, so the draw loop is a Set lookup per visible cell; going
  the other way meant two id lookups per cell on every repaint.
- **A thread whose row or column was deleted says "deleted"** rather than
  resolving to whatever cell now sits at those coordinates. Ids do not come
  back, and a comment pointing confidently at the wrong cell is worse than one
  admitting it lost its place.
- **The unresolved count in the header spans every tab.** It is how you find
  out something is waiting on a sheet you are not looking at.

One bug this closed on the way past: `readOnly` was `role === 'viewer'` in both
`SheetView` and `EditorView`. A commenter would have got an editable grid,
typed, sent a doc update and had their socket closed for a policy violation.
Both now go through `canEdit()` in `roles.js`, which mirrors `roleRank` — with
a test asserting the two agree, since nothing else would catch them drifting.

### Comments on documents: encoded RelativePositions

A sheet comment names a cell by its stable ids. A document comment has no such
handle, so it names its range with two Yjs **RelativePositions**, encoded to
bytes and carried in the same opaque anchor blob (`{k:'text', start, end,
quote}`). A relative position identifies a spot by the *item* it sits beside,
not by an offset, so it survives arbitrary concurrent editing — and only a
client holding the Y.Doc can turn it back into an index, which is how the
server stores these while still knowing nothing about the document.

- **The two ends associate in opposite directions**: start to the character
  after it, end to the character before. Text typed at either boundary
  therefore lands *outside* the comment rather than silently extending it.
- **An anchor that no longer resolves is an ordinary outcome**, not an error.
  The text it named was deleted and garbage-collected; the panel says
  "(deleted)" and falls back to the quoted snippet rather than showing whatever
  has since moved into that position.
- **Highlights live in a StateField, pushed in by an effect.** Where the
  commented ranges are is not something the editor can work out — it comes from
  threads fetched over HTTP and resolved against the Y.Doc. A ViewPlugin
  rebuilding from the viewport would drop a highlight the moment it scrolled
  out of view.
- **Anything a commenter can select, they can comment on.** Unlike a sheet,
  nothing has to be created first: the text already exists, so no document
  write is involved and the editor/commenter asymmetry does not arise here.

The bug this shipped with, caught by `make test-ui` before it reached anyone:
the repaint was called straight from `ytext.observe`, and that observer runs
inside the transaction — which for a local edit is inside CodeMirror's own
update. Dispatching there throws *"Calls to EditorView.update are not allowed
while an update is in progress"*, which CodeMirror reports as a crashed plugin
and which corrupts the editor's state; typed characters went missing several
steps later, so the symptom did not resemble the cause at all. The repaint is
now queued on a microtask, coalesced, so it runs once the update has unwound.

### Notifications: in-app always, email only if configured

The filter is **"did this happen while you were not looking?"** Anything you
would notice on your next visit belongs in-app, where it costs nothing and
cannot be marked as spam. That leaves a short list.

**In-app** carries everything: a mention inbox, the unresolved count in the
document list, replies to threads you are in. No deployment surface, so it
ships first and the feature is whole without any mail at all.

**Email covers exactly two events**, because they are the only ones where the
recipient is by definition *not* in the app to see a badge:

- **You were mentioned.** Someone named you and is waiting.
- **A document was shared with you.** Today `handleAddShare` grants a role and
  the document silently appears in a list — if the recipient never opens the
  app, they never learn it exists. This is the only event with no in-app place
  to discover it, and it is not a comment feature at all.

Deliberately *not* emailed: any comment on a document you own (ownership is not
interest, and an active document is a firehose), thread resolved (that is
closure — nothing waits on you), and all version/snapshot/share bookkeeping
for actions you took yourself.

Rules that keep it signal:

- **Skip anyone connected to that document right now** — they can see it
  happen. `hub.evictUser` already walks a room's clients by user id, so the
  presence test is a few lines, not a subsystem.
- **Debounce per (user, document)**, around five minutes. A thread during a
  live session is one conversation, not N events.
- **Never notify anyone of their own action**, including self-mentions.
- **Never put a share-link token in an email.** Those are bearer capabilities
  stored only as SHA-256; mail is archived, forwarded and indexed. Link to the
  document URL and let ordinary auth do its job.

Consequence worth knowing before writing the templates: the server can include
the **comment body** — those are stored in the clear, deliberately, so mentions
can be read — but never *what the comment is about*, because the quoted text is
inside the opaque anchor. The mail says "Craig said: this seems wrong" and
cannot say what it was said about. That is the content-blind design working,
and it means these emails are pointers into the app, not substitutes for it.
Keep them short and link-first.

Transport: **submission only, to an existing relay** — the deploy environment
has one, so this app never touches SPF/DKIM/DMARC, reputation or bounces, and
it must not grow a queue pretending otherwise. `net/smtp` over 587 with
STARTTLS and PLAIN is enough, so no new dependency; headers are hand-built and
a non-ASCII subject goes through `mime`. Unset config means the feature is off,
not broken.

Loose end for whoever builds it: signup never verifies an email address, so
notifications go to unverified addresses. Fine for a small self-hosted team,
worth a second look if an instance runs `-signup=open`.

---

### Browser tests: `puppeteer-core`, and the assertion that matters

`make test-ui` drives the real UI in a real Chrome. It exists because three
incidents below share one signature: **a thrown error inside a Svelte `{#if}`
presents as a dead control, not a crash.** The page keeps working, nothing
looks broken, and the only evidence is a console nobody is reading. No
headless model test can produce that, because none of them mount a component.

So the highest-value assertion here is not any interaction — it is *the
console stayed clean*. Every step runs under that check, and an uncaught
exception fails the step that caused it.

- **`puppeteer-core`, not `puppeteer` or `playwright`.** The other two
  download their own ~150 MB browser; this drives the Chrome already on the
  machine (`CHROME_PATH` overrides the lookup). It is a devDependency, never
  in the binary, never cross-compiled — the linux/arm64 target has no browser
  and should not acquire one. 7.8 MB installed.
- **Separate target from `test`**, for the reason `e2e.mjs` is separate: it
  needs the built binary and a browser, which a plain unit run should not
  depend on.
- **The harness boots and kills its own server** on port 8599 with a temp db
  and a throwaway Chrome profile, so it never touches the dev instance on 8484
  or the developer's own browser session.
- **Controls are found by visible label**, not by selector. Svelte's scoped
  class hashes change on every recompile, so selector-based tests would rot
  by construction.
- **A failing step reports the console and the visible text**, not just
  "waiting failed" — the timeout is the symptom, the console holds the cause.
  Two of the first three failures it produced were diagnosable only that way.

It earned itself on the first run, catching a live regression: `EditorView`
called `canEdit()` without importing it, so **the markdown editor threw on
mount and rendered nothing** — shipped, committed, and invisible to `go test`,
`sheet_test.mjs` and a `vite build` alike. Verified by reintroducing the bug
and watching the suite fail.

Also caught, in the feature it was written for: an anchor names row and column
ids, and a new sheet materialises *zero* rows however many the grid draws — so
commenting on an untouched cell had to materialise it first. Editors now do
that on submit exactly as typing would; commenters cannot, since it is a
document write, and the composer says so instead of sitting inexplicably
disabled.

## Kanban (decided, not built)

### A card *is* a document, and inherits the board's access

Decided 2026-08-05. A card opens as a full document — same editor, same
history, same comments, same sync — rather than being a title plus a body
stored inside the board. One document kind fewer to special-case, and the
machinery already exists.

Access follows: **anyone who can open the board can open its cards.** Card
documents are reached through the board, not shared individually.

The load-bearing consequence, worth getting right before there is data:

- **Derive access, never copy it.** The tempting shortcut is to write a
  `permissions` row per card whenever the board is shared. That turns one
  share into N writes, makes every card creation copy the board's *current*
  permissions, and guarantees drift the first time the two disagree. Instead
  `documents` gains `parent_id`, and `roleFor` falls back to the parent's
  permissions. Depth is exactly one — a card's parent is a board, and boards
  have no parent — so it is a single join, not a tree walk.
- **`handleListDocs` must exclude cards** (`WHERE parent_id IS NULL`), or a
  20-item induction board buries the document list it belongs to.
- **`parent_id ... ON DELETE CASCADE`**, so deleting a board takes its cards
  with it rather than leaving 20 documents nobody can reach.
- **Removing a card from a board needs a decided answer**: delete its document,
  or promote it to top level. Silently orphaning it is the one option that is
  wrong, because `parent_id` is also what makes it visible.
- **The share UI has to say this out loud.** "Share this board" now means
  "share every card in it", and a permission surprise is the kind users only
  discover the wrong way.
- Note the boundary this is *not*: a card document still has a URL, and anyone
  with board access can open it directly. "Only reachable via the board" is a
  navigation statement, not a security one — the security statement is the
  board's own permission row.

### Templates: instantiate by copying documents

Decided 2026-08-05, wanted concretely: a "new staff member" template that
creates an induction board of 15–20 cards.

A template is an ordinary board flagged as one, and instantiating it copies the
board plus every card document. The interesting constraint is the same one that
shapes everything else here — **the server cannot read document content**, so
it cannot merge or rewrite a Yjs document. That leaves two honest options, and
they differ in what history the copy starts with:

- **Server-side blob copy.** Duplicate the template's stored update rows under
  a new document id. Correct without parsing anything: replaying the same
  frames reproduces the same state. Fast, and no client has to load 20
  documents. Cost: the copy inherits the *template's* editing history, so a new
  starter's induction board opens with a timeline of someone drafting the
  template.
- **Client-side copy.** The instantiating client loads each template document,
  `encodeStateAsUpdate`s it, and posts that as the new document's first update.
  History starts clean, at instantiation. Cost: it must load every card
  document first, and it is the client's session that has to survive the loop.

Open underneath this: whether instantiating substitutes per-instance values
(the staff member's name, a start date) into card content. That is a content
rewrite, so it forces the client-side path regardless of the choice above —
see *Open questions*.

## Incidents

- **2026-08-05, the comments panel threw before it could render.** User
  report: "clicking comments does nothing". `threadLabel` raised
  `Cannot read properties of undefined (reading 'get')`, so the
  `{#if showComments}` block failed to render and the button looked inert —
  a thrown error inside a conditional block presents as a dead control, not
  as a crash.

  Root cause: **`rowIds`/`rowPos` are a lazily built cache that does not exist
  until `_index()` runs.** Every caller inside `model.js` runs it first; the
  panel read the maps directly and did not. `sheet?.rowPos.get(...)` guarded
  the sheet being nullish but not the map being absent, which is the failure
  optional chaining invites — it protects the hop you wrote a `?.` on and
  none of the ones after it.

  The masking effect is the interesting part. `workbook.sheet(id)` returns a
  **cached** model, so the active tab is always indexed — *drawing it indexes
  it*. Every other tab hands back a fresh, never-indexed one. The bug was
  therefore invisible on the sheet under test and certain to fire the first
  time anyone commented on a second sheet and reloaded. What made it fire
  immediately was a thread injected by hand during testing carrying
  `sheet:"__first"` where `FIRST_SHEET` is `"1"`, and `workbook.sheet()`
  invents a model for an id that does not exist.

  Fixes, in order of how much they matter: `SheetModel` gained public
  `idsAt(r, c)` and `posOf(rowId, colId)` that index first and return nulls
  for ids whose row or column is gone — **the component no longer knows the
  index exists**; `threadLabel` uses `sheetById` (null for a missing sheet)
  rather than `sheet` (invents one); and hand-injected test rows are not
  test coverage — the id in that row was guessed rather than read from
  `FIRST_SHEET`, and it seeded a fixture no real client would ever write.

  The lesson worth carrying: **a lazily populated cache reached from outside
  its module is a crash waiting for the one caller that arrives first**, and
  the "it works when I try it" case is often the one that ran the
  initialisation. This is the third browser-only bug in this file that the
  headless suite could not see (see the two below), which is what promoted a
  browser-level harness from a nice-to-have into `make test-ui` — see Browser
  tests above, which caught a fourth on its first run.

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
  Answered — see Comments. ~~Still open underneath it: the notification
  delivery channel.~~ Also answered — see Notifications: in-app first and
  always, email optional and submission-only to an existing relay, so the
  deliverability burden never lands on this app.
- Search: without server-side document reads, any full-text search must be
  client-fed. Deferred until wanted.
- ~~Kanban: is a card a body inside the board, or a reference to a document?~~
  Answered — a card *is* a document, inheriting the board's access. See
  *Kanban*. Still open underneath it:
  - **Template variables.** Does instantiating a template substitute
    per-instance values (staff name, start date) into card content? If yes,
    that is a content rewrite, which forces the client-side copy — the server
    cannot read a document, let alone edit one. Placeholder syntax would want
    to be something markdown leaves alone, e.g. `{{name}}`.
  - **Which copy strategy** for instantiation (blob copy inherits the
    template's history; client copy starts clean and must load every card).
    Moot if template variables are wanted: that decides it.
  - **What a board serializes to for the git exporter** — markdown with a
    heading per column is the obvious shape, with each card either inlined or
    linked to its own exported file.
