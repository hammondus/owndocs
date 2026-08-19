package main

// Search over comment bodies. See DESIGN-DECISIONS.md, *Search*, for why this
// is comments-first and why it costs nothing in content-blindness: comment
// bodies were already plain TEXT in SQLite, put there by the *Comments*
// decision for reasons that had nothing to do with search. Document content is
// still inside an opaque blob the server never parses.

import (
	"database/sql"
	"net/http"
	"strings"
	"time"
	"unicode"
)

// One page of results. A search box that returns everything is a search box
// nobody scrolls; if 50 is not enough the query is the thing to fix.
const searchLimit = 50

// Snippet highlight markers. Deliberately NOT `<mark>`: the snippet contains
// user-written text, and handing HTML to the client invites it to be rendered
// with {@html}, which is an XSS hole with a comment body as the payload. These
// are control characters that cannot occur in a comment typed by a person, so
// the client splits on them and renders real elements itself, through the
// normal escaping path.
const (
	hlStart = "\x02"
	hlEnd   = "\x03"
)

type searchHit struct {
	DocID     string `json:"doc_id"`
	Title     string `json:"title"`
	Kind      string `json:"kind"`
	ThreadID  int64  `json:"thread_id"`
	CommentID int64  `json:"comment_id"`
	Author    string `json:"author"`
	Snippet   string `json:"snippet"`
	CreatedAt int64  `json:"created_at"`
	Resolved  bool   `json:"resolved"`
}

type docHit struct {
	DocID     string `json:"doc_id"`
	Title     string `json:"title"`
	Kind      string `json:"kind"`
	Snippet   string `json:"snippet"`
	IndexedAt int64  `json:"indexed_at"`
}

// Two lists rather than one, because they are two kinds of hit and FTS5 `rank`
// is not comparable across separate tables. Merging them would mean inventing a
// score, and an invented score is a ranking nobody can explain when it puts the
// wrong thing first.
type searchResults struct {
	Documents []docHit    `json:"documents"`
	Comments  []searchHit `json:"comments"`
}

// ftsQuery turns what somebody typed into an FTS5 MATCH expression.
//
// This is not optional politeness. MATCH takes a query *language* — bare `AND`,
// an unbalanced quote, a leading `*` or a stray `:` are all syntax errors, and
// an unsanitised box turns "can't find it" into a 500 the moment somebody types
// an apostrophe. Every token is therefore quoted, which makes it a literal
// phrase and strips all operator meaning.
//
// Tokens are ANDed (FTS5's default for adjacent terms) and each gets a `*`
// prefix match, so typing "budg" finds "budget" — the behaviour a person
// expects from a search box, and the reason this is not simply a LIKE.
//
// Returns "" when nothing usable is left, which the caller treats as an empty
// result rather than an error: a box containing only punctuation is not a
// failure, it is a box nobody has finished typing in.
func ftsQuery(raw string) string {
	var terms []string
	for _, field := range strings.FieldsFunc(raw, func(r rune) bool {
		return unicode.IsSpace(r)
	}) {
		// Keep letters, digits and marks; everything else is either an FTS5
		// operator or noise the tokenizer would drop anyway.
		var b strings.Builder
		for _, r := range field {
			if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r) {
				b.WriteRune(r)
			}
		}
		if t := b.String(); t != "" {
			terms = append(terms, `"`+t+`"*`)
		}
	}
	return strings.Join(terms, " ")
}

// GET /api/search?q=…
//
// The index is content-keyed and permissions are applied here, at query time,
// by the same access rule `handleListDocs` uses — visibleDocsSQL, which since
// folders covers both a grant on the document and a grant on a folder above
// it. That is what makes a
// role change take effect on the next search with no reindexing: access is
// never baked into the index.
func handleSearch(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		q := ftsQuery(r.URL.Query().Get("q"))
		out := searchResults{Documents: []docHit{}, Comments: []searchHit{}}
		if q == "" {
			writeJSON(w, http.StatusOK, out)
			return
		}

		docRows, err := db.Query(visibleDocsSQL+`
			SELECT d.id, d.title, d.kind,
			       snippet(doc_search, 1, ?, ?, '…', 14),
			       doc_search.indexed_at
			FROM doc_search
			JOIN documents d ON d.id = doc_search.doc_id
			JOIN visible   v ON v.doc_id = d.id
			WHERE doc_search MATCH ?
			ORDER BY rank
			LIMIT ?`, u.ID, u.ID, hlStart, hlEnd, q, searchLimit)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "search failed")
			return
		}
		for docRows.Next() {
			var h docHit
			if err := docRows.Scan(&h.DocID, &h.Title, &h.Kind, &h.Snippet, &h.IndexedAt); err != nil {
				docRows.Close()
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			out.Documents = append(out.Documents, h)
		}
		docRows.Close()
		if err := docRows.Err(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}

		rows, err := db.Query(visibleDocsSQL+`
			SELECT d.id, d.title, d.kind, t.id, c.id, u.name,
			       snippet(comment_search, 0, ?, ?, '…', 12),
			       c.created_at, t.resolved_at IS NOT NULL
			FROM comment_search
			JOIN comments c        ON c.id = comment_search.rowid
			JOIN comment_threads t ON t.id = c.thread_id
			JOIN documents d       ON d.id = t.doc_id
			JOIN visible v         ON v.doc_id = d.id
			JOIN users u           ON u.id = c.author_id
			WHERE comment_search MATCH ?
			ORDER BY rank
			LIMIT ?`, u.ID, u.ID, hlStart, hlEnd, q, searchLimit)
		if err != nil {
			// A MATCH syntax error should be impossible after ftsQuery, so this
			// is a real fault rather than bad input, and is reported as one.
			jsonError(w, http.StatusInternalServerError, "search failed")
			return
		}
		defer rows.Close()

		for rows.Next() {
			var h searchHit
			if err := rows.Scan(&h.DocID, &h.Title, &h.Kind, &h.ThreadID, &h.CommentID,
				&h.Author, &h.Snippet, &h.CreatedAt, &h.Resolved); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			out.Comments = append(out.Comments, h)
		}
		if err := rows.Err(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// POST /api/docs/{id}/index — the client hands over text it has already
// decoded.
//
// The authorisation is the whole point and is deliberately unremarkable: the
// same `roleFor` check that gates reading the document. Nothing new is granted
// to anybody, and a client can only ever index what it could already read.
// That is what stage 2 buys over a headless indexer, which would need to read
// everything and so would be the first global-read principal in an app whose
// authorisation story is that access is per document.
//
// Replace-wholesale rather than merge: the client sends the current full text,
// so anything else would accumulate deleted paragraphs forever. In one
// transaction, because a delete that commits without its insert leaves a
// document silently unsearchable.
func handleIndexDoc(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		docID := r.PathValue("id")
		role, err := roleFor(db, docID, u.ID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		// 404 rather than 403 for no access, as everywhere else here: whether a
		// document exists is itself something you need access to learn.
		if role == "" {
			jsonError(w, http.StatusNotFound, "no such document")
			return
		}
		var in struct {
			Body string `json:"body"`
		}
		if !readJSON(w, r, &in) {
			return
		}

		tx, err := db.Begin()
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer tx.Rollback()
		if _, err := tx.Exec(`DELETE FROM doc_search WHERE doc_id = ?`, docID); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		if strings.TrimSpace(in.Body) != "" {
			if _, err := tx.Exec(`INSERT INTO doc_search(doc_id, body, indexed_at) VALUES (?, ?, ?)`,
				docID, in.Body, time.Now().Unix()); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
		}
		if err := tx.Commit(); err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}
