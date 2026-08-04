// inspect is a read-only integrity checker for a docs database: it verifies
// snapshot checksums and the length-prefix framing of every update row and
// archived segment, and can export a document's replay frames to files for
// decode-testing with real Yjs (tools outside Go can then pinpoint which
// frame a client chokes on). Never writes to the database.
//
//	go run ./tools/inspect -db path/to/docs.db [-export DIR -doc DOCID]
package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

func main() {
	dbPath := flag.String("db", "data/docs.db", "database to inspect (opened read-only)")
	exportDir := flag.String("export", "", "export replay frames of -doc to this directory")
	docFilter := flag.String("doc", "", "restrict to one document id")
	flag.Parse()

	db, err := sql.Open("sqlite", "file:"+*dbPath+"?mode=ro")
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	rows, err := db.Query("SELECT id, title, last_seq FROM documents ORDER BY updated_at DESC")
	if err != nil {
		log.Fatal(err)
	}
	type docInfo struct {
		id, title string
		lastSeq   int64
	}
	var docs []docInfo
	for rows.Next() {
		var d docInfo
		if err := rows.Scan(&d.id, &d.title, &d.lastSeq); err != nil {
			log.Fatal(err)
		}
		docs = append(docs, d)
	}
	rows.Close()

	for _, d := range docs {
		if *docFilter != "" && d.id != *docFilter {
			continue
		}
		fmt.Printf("\n=== doc %s %q last_seq=%d ===\n", d.id, d.title, d.lastSeq)

		var frameIdx int
		export := func(kind string, seq int64, frame []byte) {
			if *exportDir == "" {
				return
			}
			name := fmt.Sprintf("%04d-%s-seq%d.bin", frameIdx, kind, seq)
			frameIdx++
			if err := os.WriteFile(filepath.Join(*exportDir, name), frame, 0o644); err != nil {
				log.Fatal(err)
			}
		}

		snaps, err := db.Query("SELECT last_seq, state, data, sha256 FROM snapshots WHERE doc_id = ? ORDER BY last_seq", d.id)
		if err != nil {
			log.Fatal(err)
		}
		type snapInfo struct {
			seq   int64
			state string
			data  []byte
			shaOK bool
		}
		var snapList []snapInfo
		for snaps.Next() {
			var s snapInfo
			var sum []byte
			if err := snaps.Scan(&s.seq, &s.state, &s.data, &sum); err != nil {
				log.Fatal(err)
			}
			got := sha256.Sum256(s.data)
			s.shaOK = bytes.Equal(got[:], sum)
			snapList = append(snapList, s)
		}
		snaps.Close()
		for _, s := range snapList {
			fmt.Printf("  snapshot seq=%d state=%s size=%d sha=%v\n", s.seq, s.state, len(s.data), okStr(s.shaOK))
			export("snapshot-"+s.state, s.seq, s.data)
		}

		segs, err := db.Query("SELECT start_seq, end_seq, data FROM history_segments WHERE doc_id = ? ORDER BY start_seq", d.id)
		if err != nil {
			log.Fatal(err)
		}
		type segInfo struct {
			start, end int64
			gz         []byte
		}
		var segList []segInfo
		for segs.Next() {
			var s segInfo
			if err := segs.Scan(&s.start, &s.end, &s.gz); err != nil {
				log.Fatal(err)
			}
			segList = append(segList, s)
		}
		segs.Close()
		for _, s := range segList {
			raw, err := gunzip(s.gz)
			if err != nil {
				fmt.Printf("  segment %d-%d: GUNZIP FAILED: %v\n", s.start, s.end, err)
				continue
			}
			n, bad := checkFraming(raw)
			fmt.Printf("  segment %d-%d: gz=%d raw=%d frames=%d framing=%s\n", s.start, s.end, len(s.gz), len(raw), n, bad)
		}

		upd, err := db.Query("SELECT seq, data FROM updates WHERE doc_id = ? ORDER BY seq", d.id)
		if err != nil {
			log.Fatal(err)
		}
		type rowInfo struct {
			seq  int64
			data []byte
		}
		var rowList []rowInfo
		for upd.Next() {
			var r rowInfo
			if err := upd.Scan(&r.seq, &r.data); err != nil {
				log.Fatal(err)
			}
			rowList = append(rowList, r)
		}
		upd.Close()
		for _, r := range rowList {
			n, bad := checkFraming(r.data)
			fmt.Printf("  row seq=%d size=%d frames=%d framing=%s\n", r.seq, len(r.data), n, bad)
			for i, f := 0, r.data; len(f) > 0; i++ {
				ln, w := binary.Uvarint(f)
				if w <= 0 || int(ln) > len(f)-w {
					break
				}
				export("row", r.seq, f[w:w+int(ln)])
				f = f[w+int(ln):]
			}
		}
	}
}

func okStr(ok bool) string {
	if ok {
		return "OK"
	}
	return "MISMATCH"
}

// checkFraming walks [uvarint len][bytes]... and reports whether the frame
// lengths tile the payload exactly.
func checkFraming(data []byte) (frames int, verdict string) {
	i := 0
	for i < len(data) {
		ln, w := binary.Uvarint(data[i:])
		if w <= 0 {
			return frames, fmt.Sprintf("BAD uvarint at offset %d", i)
		}
		i += w
		if int(ln) > len(data)-i {
			return frames, fmt.Sprintf("OVERRUN: frame %d claims %d bytes, only %d remain", frames, ln, len(data)-i)
		}
		i += int(ln)
		frames++
	}
	return frames, "ok"
}

func gunzip(data []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(zr)
}
