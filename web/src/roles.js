// Access levels, mirroring roleRank in docs_api.go. The server enforces; this
// only decides what the UI offers, and the two must stay in step.
//
// canEdit is the one that matters: a commenter who gets an editable grid will
// type, the provider will send a doc update, and the server will close the
// socket for a policy violation. Read-only-ness is not cosmetic here.
const RANK = { viewer: 0, commenter: 1, editor: 2, owner: 3 }

const rank = (role) => (role in RANK ? RANK[role] : -1)

export const canEdit = (role) => rank(role) >= RANK.editor
export const canComment = (role) => rank(role) >= RANK.commenter
