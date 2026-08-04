package main

import (
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Wire protocol (see DESIGN-DECISIONS.md):
//   client -> server  binary: ONE raw Yjs update, unframed
//   server -> client  binary: a batch of updates, each [uvarint len][bytes]
//   server -> client  text:   JSON control, currently {"type":"synced"}
// A stored `updates` row is exactly one server->client batch message, so
// replay is a straight copy from SQLite to the socket.

const (
	maxUpdateSize = 1 << 20 // per-message read limit
	flushInterval = time.Second
	sendQueueSize = 256
	pingInterval  = 30 * time.Second // keeps proxies from idling the socket out
)

type hub struct {
	db    *sql.DB
	mu    sync.Mutex
	rooms map[string]*room
}

func newHub(db *sql.DB) *hub {
	return &hub{db: db, rooms: make(map[string]*room)}
}

type room struct {
	hub   *hub
	docID string

	mu         sync.Mutex
	clients    map[*client]struct{}
	buf        [][]byte // updates received but not yet flushed to sqlite
	flushTimer *time.Timer
	closed     bool // room removed from hub map; joins must retry
}

type client struct {
	conn *websocket.Conn
	send chan []byte // framed batches; closed by the room on eviction
	role string
}

var errRoomClosed = errors.New("room closed")

func frameUpdates(updates [][]byte) []byte {
	var out []byte
	for _, u := range updates {
		out = binary.AppendUvarint(out, uint64(len(u)))
		out = append(out, u...)
	}
	return out
}

func (h *hub) room(docID string) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	rm, ok := h.rooms[docID]
	if !ok {
		rm = &room{hub: h, docID: docID, clients: make(map[*client]struct{})}
		h.rooms[docID] = rm
	}
	return rm
}

// closeRoom evicts all clients and drops the room without flushing — used
// when the document is being deleted.
func (h *hub) closeRoom(docID string) {
	h.mu.Lock()
	rm := h.rooms[docID]
	delete(h.rooms, docID)
	h.mu.Unlock()
	if rm == nil {
		return
	}
	rm.mu.Lock()
	rm.closed = true
	rm.buf = nil
	if rm.flushTimer != nil {
		rm.flushTimer.Stop()
		rm.flushTimer = nil
	}
	for c := range rm.clients {
		close(c.send)
	}
	rm.clients = map[*client]struct{}{}
	rm.mu.Unlock()
}

// shutdown flushes every room's buffer; called once, after the HTTP server
// has stopped accepting connections.
func (h *hub) shutdown() {
	h.mu.Lock()
	rooms := make([]*room, 0, len(h.rooms))
	for _, rm := range h.rooms {
		rooms = append(rooms, rm)
	}
	h.mu.Unlock()
	for _, rm := range rooms {
		rm.flush()
	}
}

// join registers the client after enqueueing the full replay backlog (every
// persisted batch row plus the current unflushed buffer) on c.send. Holding
// the lock across the DB read guarantees no update can slip between "read
// the log" and "start receiving broadcasts". Returns errRoomClosed if the
// room was concurrently deleted; the caller fetches a fresh room and retries.
func (rm *room) join(c *client) error {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if rm.closed {
		return errRoomClosed
	}
	rows, err := rm.hub.db.Query("SELECT data FROM updates WHERE doc_id = ? ORDER BY seq", rm.docID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var backlog [][]byte
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return err
		}
		backlog = append(backlog, data)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(rm.buf) > 0 {
		backlog = append(backlog, frameUpdates(rm.buf))
	}
	// send is sized to hold the whole backlog so enqueueing here can't block
	// while the lock is held.
	c.send = make(chan []byte, len(backlog)+sendQueueSize)
	for _, b := range backlog {
		c.send <- b
	}
	rm.clients[c] = struct{}{}
	return nil
}

func (rm *room) leave(c *client) {
	rm.mu.Lock()
	if _, ok := rm.clients[c]; ok {
		delete(rm.clients, c)
		close(c.send)
	}
	empty := len(rm.clients) == 0 && !rm.closed
	rm.mu.Unlock()
	if !empty {
		return
	}
	rm.flush()
	// Drop the empty room. closed is set under both locks so a client that
	// already holds a reference from hub.room() sees it in join and retries.
	rm.hub.mu.Lock()
	rm.mu.Lock()
	if len(rm.clients) == 0 && len(rm.buf) == 0 && !rm.closed {
		rm.closed = true
		delete(rm.hub.rooms, rm.docID)
	}
	rm.mu.Unlock()
	rm.hub.mu.Unlock()
}

// ingest buffers one update from `from` and broadcasts it to everyone else.
func (rm *room) ingest(from *client, update []byte) {
	framed := frameUpdates([][]byte{update})
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if rm.closed {
		return
	}
	rm.buf = append(rm.buf, update)
	if rm.flushTimer == nil {
		rm.flushTimer = time.AfterFunc(flushInterval, rm.flush)
	}
	for c := range rm.clients {
		if c == from {
			continue
		}
		select {
		case c.send <- framed:
		default:
			// Slow consumer: evict rather than block the room. The client
			// reconnects and replays from the log, so nothing is lost.
			delete(rm.clients, c)
			close(c.send)
		}
	}
}

// flush persists the buffered updates as one batch row.
func (rm *room) flush() {
	rm.mu.Lock()
	buf := rm.buf
	rm.buf = nil
	if rm.flushTimer != nil {
		rm.flushTimer.Stop()
		rm.flushTimer = nil
	}
	rm.mu.Unlock()
	if len(buf) == 0 {
		return
	}
	now := time.Now().Unix()
	_, err := rm.hub.db.Exec(`
		INSERT INTO updates (doc_id, seq, data, created_at)
		VALUES (?, 1 + COALESCE((SELECT MAX(seq) FROM updates WHERE doc_id = ?), 0), ?, ?)`,
		rm.docID, rm.docID, frameUpdates(buf), now)
	if err != nil {
		// Put the updates back so the next flush (or shutdown) retries;
		// losing acknowledged edits is the one unacceptable outcome.
		log.Printf("room %s: flush failed, will retry: %v", rm.docID, err)
		rm.mu.Lock()
		if !rm.closed {
			rm.buf = append(buf, rm.buf...)
			if rm.flushTimer == nil {
				rm.flushTimer = time.AfterFunc(flushInterval, rm.flush)
			}
		}
		rm.mu.Unlock()
		return
	}
	_, _ = rm.hub.db.Exec("UPDATE documents SET updated_at = ? WHERE id = ?", now, rm.docID)
}

// writer drains c.send to the socket. The backlog is pre-enqueued, so "queue
// momentarily empty" after at least one drain pass means the client has
// everything; that's when the synced control message goes out.
func (c *client) writer(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()
	ping := time.NewTicker(pingInterval)
	defer ping.Stop()

	for { // backlog drain
		select {
		case msg, ok := <-c.send:
			if !ok {
				c.conn.Close(websocket.StatusGoingAway, "evicted")
				return
			}
			if c.conn.Write(ctx, websocket.MessageBinary, msg) != nil {
				return
			}
			continue
		default:
		}
		break
	}
	synced, _ := json.Marshal(map[string]string{"type": "synced"})
	if c.conn.Write(ctx, websocket.MessageText, synced) != nil {
		return
	}

	for { // steady state
		select {
		case msg, ok := <-c.send:
			if !ok {
				c.conn.Close(websocket.StatusGoingAway, "evicted")
				return
			}
			if c.conn.Write(ctx, websocket.MessageBinary, msg) != nil {
				return
			}
		case <-ping.C:
			if c.conn.Ping(ctx) != nil {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

func (h *hub) handleWS() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := currentUser(r)
		docID := r.PathValue("id")
		role, err := roleFor(h.db, docID, u.ID)
		if err != nil || role == "" {
			jsonError(w, http.StatusNotFound, "not found")
			return
		}
		conn, err := websocket.Accept(w, r, nil) // default options reject cross-origin
		if err != nil {
			return
		}
		conn.SetReadLimit(maxUpdateSize)

		c := &client{conn: conn, role: role}
		var rm *room
		for range 3 { // retry: the room can be deleted between lookup and join
			rm = h.room(docID)
			if err = rm.join(c); err != errRoomClosed {
				break
			}
		}
		if err != nil {
			conn.Close(websocket.StatusInternalError, "join failed")
			return
		}

		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		go c.writer(ctx, cancel)

		// Reader (this goroutine): ingest updates until the peer goes away.
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				break
			}
			if typ != websocket.MessageBinary || len(data) == 0 {
				continue
			}
			if c.role == "viewer" {
				conn.Close(websocket.StatusPolicyViolation, "read-only access")
				break
			}
			rm.ingest(c, data)
		}
		rm.leave(c)
	}
}
