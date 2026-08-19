package main

import (
	"database/sql"
	"net/http"
	"time"
)

// In-app notifications: the mention inbox, and replies to threads you are in.
//
// This is the half of *Notifications* that needs no deployment surface, so it
// ships first and the feature is whole without any mail at all. Email covers
// two events and is a separate build — see DESIGN-DECISIONS.md.
//
// One deliberate departure from that section, recorded there too: the rule
// "skip anyone connected to that document right now" is applied to **email
// only**, not here. An inbox is a record. Dropping a mention because the
// recipient happened to have the tab open is a mention they may never learn
// about, whereas an unread badge they dismiss in a second costs nothing.

type notification struct {
	ID    int64  `json:"id"`
	Kind  string `json:"kind"`
	DocID string `json:"doc_id"`
	// Denormalized for the inbox, which has to be readable without opening
	// anything: who did it, what they said, and where.
	DocTitle  string `json:"doc_title"`
	ThreadID  int64  `json:"thread_id"`
	Actor     string `json:"actor"`
	Body      string `json:"body"`
	CreatedAt int64  `json:"created_at"`
	ReadAt    *int64 `json:"read_at"`
}

// Both *sql.DB and *sql.Tx satisfy this, so recording works the same whether
// the caller already has a transaction open (creating a thread) or not
// (replying).
type execQuerier interface {
	Exec(string, ...any) (sql.Result, error)
	Query(string, ...any) (*sql.Rows, error)
}

// Everyone who can open a document, which is exactly the set a mention may
// name. Nothing here can be used to discover that an account exists.
func collaborators(q execQuerier, docID string) ([]mentionable, error) {
	rows, err := q.Query(`
		SELECT u.id, u.name FROM permissions p JOIN users u ON u.id = p.user_id
		WHERE p.doc_id = ?`, docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []mentionable
	for rows.Next() {
		var m mentionable
		if err := rows.Scan(&m.ID, &m.Name); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// recordNotifications writes the rows one new comment produces.
//
// Two kinds, and the precedence between them is the point: someone named in a
// comment gets a **mention**, and everyone else already talking in that thread
// gets a **reply**. A person who is both gets one row, the mention, because
// that is the one that says they are being waited on.
//
// Never the actor, including a self-mention. Writing a comment is not news to
// its author.
//
// Best-effort by design: it takes the ids it needs and returns an error the
// caller logs rather than fails on. A notification is a convenience layered
// over the comment, and losing one must never cost somebody the comment they
// just wrote.
// Returns the ids that got a *mention*, so the caller can mail them once the
// comment is committed. Replies deliberately do not appear in that list: they
// are in the inbox and nothing about a reply says somebody is being waited on.
func recordNotifications(q execQuerier, docID string, tid, cid, actorID int64, body string) ([]int64, error) {
	people, err := collaborators(q, docID)
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	notified := map[int64]bool{actorID: true}

	add := func(uid int64, kind string) error {
		if notified[uid] {
			return nil
		}
		notified[uid] = true
		_, err := q.Exec(`
			INSERT INTO notifications (user_id, kind, doc_id, thread_id, comment_id, actor_id, created_at)
			VALUES (?,?,?,?,?,?,?)`, uid, kind, docID, tid, cid, actorID, now)
		return err
	}

	var mentioned []int64
	for _, uid := range mentionsIn(body, people) {
		if uid == actorID {
			continue
		}
		if err := add(uid, "mention"); err != nil {
			return nil, err
		}
		mentioned = append(mentioned, uid)
	}

	// Everyone who has already spoken in this thread. On a brand-new thread
	// that is only the author, who is filtered out — so the same code covers
	// opening a thread and replying to one.
	rows, err := q.Query("SELECT DISTINCT author_id FROM comments WHERE thread_id = ?", tid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var participants []int64
	for rows.Next() {
		var uid int64
		if err := rows.Scan(&uid); err != nil {
			return nil, err
		}
		participants = append(participants, uid)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, uid := range participants {
		if err := add(uid, "reply"); err != nil {
			return nil, err
		}
	}
	return mentioned, nil
}

// GET /api/notifications — the inbox, newest first.
//
// The join on visible documents is a boundary, not a filter for tidiness: a
// notification carries a comment body, and someone whose access to a document
// was revoked must stop being able to read new — or old — comments on it
// through their inbox. Revocation therefore takes effect here for free, with
// no rows to clean up.
func handleListNotifications(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		rows, err := db.Query(visibleDocsSQL+`
			SELECT n.id, n.kind, n.doc_id, d.title, n.thread_id, a.name, c.body, n.created_at, n.read_at
			FROM notifications n
			JOIN documents d ON d.id = n.doc_id
			JOIN users a ON a.id = n.actor_id
			JOIN comments c ON c.id = n.comment_id
			JOIN visible v ON v.doc_id = n.doc_id
			WHERE n.user_id = ?
			ORDER BY n.id DESC LIMIT 100`, u.ID, u.ID, u.ID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		defer rows.Close()
		out := []notification{}
		for rows.Next() {
			var n notification
			var read sql.NullInt64
			if err := rows.Scan(&n.ID, &n.Kind, &n.DocID, &n.DocTitle, &n.ThreadID,
				&n.Actor, &n.Body, &n.CreatedAt, &read); err != nil {
				jsonError(w, http.StatusInternalServerError, "db error")
				return
			}
			n.ReadAt = nullInt(read)
			out = append(out, n)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// POST /api/notifications/read {ids?} — mark some read, or all of them.
//
// Per row rather than a high-water mark, so one item can be dismissed without
// dismissing everything above it. Scoped to the caller by the WHERE clause, so
// an id belonging to somebody else simply matches nothing.
func handleMarkNotificationsRead(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		var in struct {
			IDs []int64 `json:"ids"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		now := time.Now().Unix()
		var err error
		if len(in.IDs) == 0 {
			_, err = db.Exec("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", now, u.ID)
		} else {
			// One statement per id rather than a built IN clause: the list is
			// short, and a hand-built clause is where a placeholder count and
			// an argument count drift apart.
			for _, id := range in.IDs {
				if _, err = db.Exec(
					"UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL",
					now, id, u.ID); err != nil {
					break
				}
			}
		}
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}
