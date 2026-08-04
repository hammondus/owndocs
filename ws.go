package main

import (
	"context"
	"crypto/sha256"
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

// Wire protocol v2 (see DESIGN-DECISIONS.md). Every binary message starts
// with a type byte:
//
//	client -> server  [msgDoc]       one raw Yjs update, unframed
//	client -> server  [msgAwareness] one raw y-protocols awareness update
//	server -> client  [msgDoc]       a batch: repeated [uvarint len][bytes]
//	server -> client  [msgAwareness] one awareness update, relayed as-is
//	server -> client  text           JSON control; "synced" carries replay
//	                                 stats the client uses to decide whether
//	                                 to snapshot or verify (compaction.js)
//
// A stored `updates` row is a msgDoc payload without the type byte, so
// replay is prepend-a-byte-and-copy. Awareness is ephemeral: relayed and
// remembered per-connection for join replay, never persisted.
const (
	msgDoc       = 0
	msgAwareness = 1
)

const (
	// Per-message read limit. A paste arrives as ONE Yjs update, and the
	// reconnect resync sends the full document state as one message, so this
	// must comfortably exceed any realistic document size. 1 MiB proved too
	// small the first time someone pasted a large text.
	maxUpdateSize = 16 << 20
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
	awareness  map[*client][]byte // each connection's latest awareness payload
	buf        [][]byte           // updates received but not yet flushed to sqlite
	flushTimer *time.Timer
	closed     bool // room removed from hub map; joins must retry
}

type client struct {
	conn   *websocket.Conn
	send   chan []byte // typed messages; closed by the room on eviction
	role   string
	synced []byte // the synced control message, prepared at join time
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

func typed(msgType byte, payload []byte) []byte {
	return append([]byte{msgType}, payload...)
}

func (h *hub) room(docID string) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	rm, ok := h.rooms[docID]
	if !ok {
		rm = &room{
			hub:       h,
			docID:     docID,
			clients:   make(map[*client]struct{}),
			awareness: make(map[*client][]byte),
		}
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
	rm.awareness = map[*client][]byte{}
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

// replayInfo is the initial-sync backlog plus the stats reported in the
// synced control message.
type replayInfo struct {
	msgs      [][]byte
	lastSeq   int64
	snapSeq   int64
	snapState string
	tailRows  int
	tailBytes int
}

// buildReplay assembles the document backlog: the newest snapshot whose
// checksum verifies, then live update rows past it. If no snapshot is
// usable it falls back to archived segments plus the full live log — the
// log-is-truth property means a bad snapshot costs a fallback, not data.
func buildReplay(db *sql.DB, docID string) (*replayInfo, error) {
	ri := &replayInfo{}
	if err := db.QueryRow("SELECT last_seq FROM documents WHERE id = ?", docID).Scan(&ri.lastSeq); err != nil {
		return nil, err
	}

	// The db pool is pinned to one connection, so every result set must be
	// fully consumed (or closed) before the next query — an open cursor
	// holds the only connection and the next Query deadlocks.
	type snap struct {
		seq       int64
		data, sum []byte
		state     string
	}
	var snaps []snap
	rows, err := db.Query("SELECT last_seq, data, sha256, state FROM snapshots WHERE doc_id = ? ORDER BY last_seq DESC", docID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var s snap
		if err := rows.Scan(&s.seq, &s.data, &s.sum, &s.state); err != nil {
			rows.Close()
			return nil, err
		}
		snaps = append(snaps, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	afterSeq := int64(0)
	for _, s := range snaps {
		got := sha256.Sum256(s.data)
		if string(got[:]) != string(s.sum) {
			log.Printf("doc %s: snapshot seq %d fails checksum, skipping", docID, s.seq)
			continue
		}
		ri.msgs = append(ri.msgs, typed(msgDoc, frameUpdates([][]byte{s.data})))
		ri.snapSeq, ri.snapState, afterSeq = s.seq, s.state, s.seq
		break
	}

	if afterSeq == 0 {
		// No usable snapshot: archived segments (if any) come first.
		segs, err := db.Query("SELECT data FROM history_segments WHERE doc_id = ? ORDER BY start_seq", docID)
		if err != nil {
			return nil, err
		}
		defer segs.Close()
		for segs.Next() {
			var gz []byte
			if err := segs.Scan(&gz); err != nil {
				return nil, err
			}
			raw, err := gunzip(gz)
			if err != nil {
				return nil, err
			}
			ri.msgs = append(ri.msgs, typed(msgDoc, raw))
		}
		if err := segs.Err(); err != nil {
			return nil, err
		}
	}

	upd, err := db.Query("SELECT data FROM updates WHERE doc_id = ? AND seq > ? ORDER BY seq", docID, afterSeq)
	if err != nil {
		return nil, err
	}
	defer upd.Close()
	for upd.Next() {
		var data []byte
		if err := upd.Scan(&data); err != nil {
			return nil, err
		}
		ri.msgs = append(ri.msgs, typed(msgDoc, data))
		ri.tailRows++
		ri.tailBytes += len(data)
	}
	return ri, upd.Err()
}

// join registers the client after enqueueing the replay backlog (snapshot +
// tail + unflushed buffer + peers' awareness) on c.send. Holding the lock
// across the DB read guarantees no update can slip between "read the log"
// and "start receiving broadcasts". Returns errRoomClosed if the room was
// concurrently deleted; the caller fetches a fresh room and retries.
func (rm *room) join(c *client) error {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if rm.closed {
		return errRoomClosed
	}
	ri, err := buildReplay(rm.hub.db, rm.docID)
	if err != nil {
		return err
	}
	backlog := ri.msgs
	if len(rm.buf) > 0 {
		backlog = append(backlog, typed(msgDoc, frameUpdates(rm.buf)))
		ri.tailRows++
		ri.tailBytes += len(backlog[len(backlog)-1]) - 1
	}
	for _, aw := range rm.awareness {
		backlog = append(backlog, typed(msgAwareness, aw))
	}
	c.synced, _ = json.Marshal(map[string]any{
		"type":           "synced",
		"last_seq":       ri.lastSeq,
		"snapshot_seq":   ri.snapSeq,
		"snapshot_state": ri.snapState,
		"tail_rows":      ri.tailRows,
		"tail_bytes":     ri.tailBytes,
	})
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
		delete(rm.awareness, c)
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

// broadcastLocked sends msg to every client except from, evicting slow
// consumers rather than blocking the room; they reconnect and replay from
// the log, so eviction never loses data. Caller holds rm.mu.
func (rm *room) broadcastLocked(from *client, msg []byte) {
	for c := range rm.clients {
		if c == from {
			continue
		}
		select {
		case c.send <- msg:
		default:
			delete(rm.clients, c)
			delete(rm.awareness, c)
			close(c.send)
		}
	}
}

// ingest buffers one doc update from `from` and broadcasts it.
func (rm *room) ingest(from *client, update []byte) {
	msg := typed(msgDoc, frameUpdates([][]byte{update}))
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if rm.closed {
		return
	}
	rm.buf = append(rm.buf, update)
	if rm.flushTimer == nil {
		rm.flushTimer = time.AfterFunc(flushInterval, rm.flush)
	}
	rm.broadcastLocked(from, msg)
}

// ingestAwareness relays a presence update and remembers it so later
// joiners see current peers immediately.
func (rm *room) ingestAwareness(from *client, payload []byte) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if rm.closed {
		return
	}
	rm.awareness[from] = payload
	rm.broadcastLocked(from, typed(msgAwareness, payload))
}

// flush persists the buffered updates as one batch row, advancing the
// document's sequence counter. documents.last_seq is authoritative:
// MAX(updates.seq) breaks once verified rows are archived away.
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
	err := func() error {
		tx, err := rm.hub.db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		var last int64
		if err := tx.QueryRow("SELECT last_seq FROM documents WHERE id = ?", rm.docID).Scan(&last); err != nil {
			return err
		}
		now := time.Now().Unix()
		if _, err := tx.Exec("INSERT INTO updates (doc_id, seq, data, created_at) VALUES (?,?,?,?)",
			rm.docID, last+1, frameUpdates(buf), now); err != nil {
			return err
		}
		if _, err := tx.Exec("UPDATE documents SET last_seq = ?, updated_at = ? WHERE id = ?",
			last+1, now, rm.docID); err != nil {
			return err
		}
		return tx.Commit()
	}()
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
	}
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
	if c.conn.Write(ctx, websocket.MessageText, c.synced) != nil {
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

		// Reader (this goroutine): ingest messages until the peer goes away.
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				break
			}
			if typ != websocket.MessageBinary || len(data) < 2 {
				continue
			}
			switch data[0] {
			case msgDoc:
				// Presence is harmless from viewers; document writes are not.
				if c.role == "viewer" {
					conn.Close(websocket.StatusPolicyViolation, "read-only access")
					rm.leave(c)
					return
				}
				rm.ingest(c, data[1:])
			case msgAwareness:
				rm.ingestAwareness(c, data[1:])
			}
		}
		rm.leave(c)
	}
}
