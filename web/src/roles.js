// Access levels, mirroring roleRank in docs_api.go. The server enforces; this
// only decides what the UI offers, and the two must stay in step.
//
// canEdit is the one that matters: a commenter who gets an editable grid will
// type, the provider will send a doc update, and the server will close the
// socket for a policy violation. Read-only-ness is not cosmetic here.
const RANK = { viewer: 0, commenter: 1, editor: 2, manager: 3, owner: 4 }

const rank = (role) => (role in RANK ? RANK[role] : -1)

// Exported for the share panel, which has to compare two people's roles rather
// than test one against a fixed bar. Unknown roles rank below viewer, so a
// client that has not been reloaded since a level was added offers nothing
// rather than guessing.
export const rankOf = rank

export const canEdit = (role) => rank(role) >= RANK.editor
export const canComment = (role) => rank(role) >= RANK.commenter

// canManage is the bar for administering a document rather than writing in it:
// sharing, links, moderating somebody else's comment, removing a version label,
// and later overriding sheet protection. `manager` exists so none of those
// belong to one person who may be on leave — see DESIGN-DECISIONS.md,
// *Ownership: one owner, one deputy rank*.
//
// isOwner is separate and deliberately not a rank helper, because the two
// things above this bar are not "more privileged", they are *irreversible*:
// deleting the document, and transferring it. Anything gated on those should
// read `doc.role === 'owner'` at the call site so it is obvious which of the
// two rules it is using.
export const canManage = (role) => rank(role) >= RANK.manager

// Which toolbar entries one person sees on one document. Two filters, and they
// are different in kind — worth keeping straight, because only one of them is
// a boundary.
//
//   - **role** is a gate. `EditorState.readOnly` stops *user input*, and a
//     toolbar button is a programmatic dispatch that goes straight through it,
//     so a commenter who kept the editing buttons could type into the document
//     through them — the provider would send an update and the server would
//     close the socket for it. The entries marked `display` are the ones that
//     change nothing in the document, which is why they survive.
//   - **rich** is not a boundary at all. The syntax is plain text and anyone
//     who may edit can type it by hand; hiding the buttons cannot stop that and
//     is not meant to. What it does is keep the plain document type plain, by
//     keeping the controls that would make every document drift colourful off
//     the documents that did not ask for them. See DESIGN-DECISIONS.md, *Rich
//     documents*.
//
// Lives here rather than in editor.js so it can be tested without a browser:
// editor.js imports CodeMirror, and this is the rule that decides what a
// commenter can reach.
export function visibleToolbar(commands, { canEdit, rich }) {
  return commands.filter((c) => {
    // Separators and spacers carry no `display`, so they fall away with the
    // commands they were dividing rather than leaving a bar of dividers.
    if (!canEdit && !c.display) return false
    if (c.rich && !rich) return false
    return true
  })
}
