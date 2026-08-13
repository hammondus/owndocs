// doclink.js decides what counts as a link to another document, and what
// markdown gets written when one is inserted. Both are quiet failure modes: a
// pattern that is too loose steals ordinary links, one that is too tight leaves
// a document link inert and looking like a typo, and an unescaped title breaks
// the link it was meant to label.
// Run from web/: node scripts/doclink_test.mjs
import {
  docLinkTarget,
  docLinkURL,
  linkParts,
  docLinkIn,
  escapeBrackets,
  docLinkMarkdown,
} from '../src/doclink.js'

let failures = 0
const ok = (what) => console.log('ok:', what)
const fail = (what, detail) => {
  failures++
  console.error(`FAIL: ${what}${detail ? '\n  ' + detail : ''}`)
}
const eq = (got, want, what) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(what)
    : fail(what, `got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`)

// A real id, as newDocID writes them: base32 of 16 random bytes, lowercased.
const ID = 'k3n7q2wx9mzt4bvr8sfhy6ecpa'

// ---- docLinkTarget ---------------------------------------------------------

eq(docLinkTarget(`#doc=${ID}`), ID, 'a document URL yields its id')
eq(docLinkTarget(`  #doc=${ID}  `), ID, 'surrounding space is ignored')
eq(docLinkTarget('#doc=anything-at-all'), 'anything-at-all', 'the id is opaque, not a fixed alphabet')

eq(docLinkTarget('https://example.com'), null, 'an external URL is not a document link')
eq(docLinkTarget('#heading'), null, 'an ordinary fragment is not a document link')
eq(docLinkTarget('#doc='), null, 'an empty id does not resolve')
// The one that matters: a pattern searching rather than anchoring would find
// the tail of this and route a link that points somewhere else entirely.
eq(docLinkTarget('https://evil.example/#doc=' + ID), null, 'a URL that merely contains #doc= is not one')
eq(docLinkTarget(`#doc=${ID}#more`), `${ID}#more`, 'everything after #doc= is the id, so this simply will not resolve')

eq(docLinkURL(ID), `#doc=${ID}`, 'docLinkURL is the inverse')
eq(docLinkTarget(docLinkURL(ID)), ID, 'URL and target round-trip')

// ---- linkParts -------------------------------------------------------------

eq(linkParts('[Onboarding](#doc=x)'), { text: 'Onboarding', url: '#doc=x' }, 'a link splits into label and URL')
eq(linkParts('[](#doc=x)'), { text: '', url: '#doc=x' }, 'an empty label is still a link')
eq(linkParts('[a](#doc=x) trailing'), null, 'anchored: trailing text means this is not one whole link')
eq(linkParts('not a link'), null, 'plain text is not a link')
// Reference links keep their destination in another part of the document, so
// there is nothing here to read. They are meant to fall through as ordinary
// links rather than be half-recognised.
eq(linkParts('[text][label]'), null, 'a reference link is not an inline link')
eq(linkParts('[text](url "title")'), null, 'a titled link is left to render as an ordinary link')

// A label may itself contain brackets once escaped, and `.*` with the `s` flag
// means a label containing a newline still parses.
eq(linkParts('[two\nlines](#doc=x)').text, 'two\nlines', 'a label may span lines')

// ---- docLinkIn -------------------------------------------------------------

eq(docLinkIn(`[Onboarding](#doc=${ID})`), ID, 'a document link is recognised from its source')
eq(docLinkIn('[Anthropic](https://example.com)'), null, 'an external link is not one')
eq(docLinkIn('[Contents](#heading)'), null, 'an in-page anchor is not one')
eq(docLinkIn('plain text'), null, 'text that is not a link is not one')

// ---- escapeBrackets --------------------------------------------------------

eq(escapeBrackets('Plain'), 'Plain', 'an ordinary title is untouched')
// The failure this exists for: `]` would close the label early and spill the
// rest of the link into the document as literal characters.
eq(escapeBrackets('Q3 [draft]'), 'Q3 \\[draft\\]', 'brackets are escaped, not stripped')
eq(escapeBrackets('back\\slash'), 'back\\\\slash', 'a backslash is escaped first, not doubled twice')
eq(escapeBrackets(null), '', 'a missing title is empty, not "null"')

// ---- docLinkMarkdown -------------------------------------------------------

eq(docLinkMarkdown(ID, 'Onboarding'), `[Onboarding](#doc=${ID})`, 'the ordinary case')
eq(docLinkMarkdown(ID, '  Onboarding  '), `[Onboarding](#doc=${ID})`, 'the label is trimmed')
eq(docLinkMarkdown(ID, ''), `[Untitled](#doc=${ID})`, 'an empty title still produces a usable label')
eq(docLinkMarkdown(ID, '   '), `[Untitled](#doc=${ID})`, 'a whitespace-only title likewise')

// The round trip that matters: whatever the picker writes must parse back to
// the id it was given, however the title was spelled.
for (const title of ['Onboarding', 'Q3 [draft]', 'a\\b', ']]]', 'Untitled']) {
  eq(docLinkIn(docLinkMarkdown(ID, title)), ID, `round-trips a title spelled ${JSON.stringify(title)}`)
}

if (failures > 0) process.exit(1)
console.log('\nALL PASS')
