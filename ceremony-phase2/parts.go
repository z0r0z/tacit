package ceremony

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// A second way to upload, for a client that cannot send a gigabyte in one request (a browser behind an HTTPS proxy):
// the contribution goes up in parts, each appended where the last ended, and a finish call checks it exactly as an upload
// is checked (the same accept, the same refusals, the same receipt). PUT /api/upload is unchanged.
//
//	GET  /api/upload-part      (token)         {have}: bytes stored so far, to resume
//	PUT  /api/upload-part?offset=N (token)     one part (up to maxPart), appended at N, which must be the bytes stored -> {have}
//	POST /api/upload-finish    (token)         all of it is there: check it in the background -> 202
//	GET  /api/upload-result    (token)         {state: none | verifying | done | refused, receipt | error}
const maxPart = 64 << 20

// An upload that moves under floorBytes in its first floorWindow cannot finish inside a slot, and a trickle must not hold the slot to its cap:
// the slot is dropped then (a chunked upload) or the request is cut (a single request). Any connection that can finish in time is far above it.
var (
	floorWindow       = 10 * time.Minute
	floorBytes  int64 = 64 << 20
)

// downloadFloorAfter: a slot that has not downloaded a quarter of the head this long after its claim cannot finish in time at that pace, and a
// download throttled to a trickle to hold the slot does not keep it for the whole download window.
var downloadFloorAfter = 10 * time.Minute

// paceWindow: how long a chunked upload runs before its pace is judged (see cannotFinishL).
var paceWindow = 15 * time.Minute

var errTooSlow = errors.New("the upload is too slow to finish inside the slot")

// floorReader fails a body that has moved less than floorBytes by floorWindow after it began.
type floorReader struct {
	r  io.Reader
	t0 time.Time
	n  int64
	// size and limit: when set, a body that at its pace so far would end after limit is cut too, once it has run paceWindow (a single-request
	// upload that is moving, but too slowly to finish inside the slot, gives the line back instead of holding it to the cap)
	size  int64
	limit time.Time
}

func (f *floorReader) Read(b []byte) (int, error) {
	n, err := f.r.Read(b)
	f.n += int64(n)
	if err == nil && f.n < floorBytes && time.Since(f.t0) > floorWindow {
		return n, errTooSlow
	}
	if err == nil && !f.limit.IsZero() && f.size > 0 && f.n > 0 && f.n < f.size {
		if el := time.Since(f.t0); el >= paceWindow {
			if f.t0.Add(time.Duration(float64(el) * float64(f.size) / float64(f.n))).After(f.limit) {
				return n, errTooSlow
			}
		}
	}
	return n, err
}

type finishResult struct {
	at      time.Time
	state   string // verifying, done, refused
	receipt *Receipt
	code    int
	msg     string
}

func (c *Coordinator) partPath(tok string) string {
	h := sha256.Sum256([]byte(tok))
	return filepath.Join(c.Dir, "part-"+hex.EncodeToString(h[:8]))
}

// partHolder: the token holds the claimed slot of an open ceremony.
func (c *Coordinator) partHolder(tok string) (*ticket, error) { return c.partHolderTake(tok, false) }

// partHolderTake: as partHolder; with take, the caller becomes the one part in flight for this slot (partBusy), so two
// parts can never write the stored file at once, and no check starts while one is still arriving.
func (c *Coordinator) partHolderTake(tok string, take bool) (*ticket, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state.Closed {
		return nil, refuse(403, "the ceremony is closed", nil)
	}
	c.expireL()
	t, i := c.findL(tok)
	if t == nil || i != 0 {
		return nil, refuse(409, "it is not your turn (or your slot ran out)", nil)
	}
	if t.Claimed.IsZero() {
		return nil, refuse(409, "claim the slot before uploading", nil)
	}
	if t.uploading {
		return nil, refuse(409, "the contribution is being checked", nil)
	}
	if take {
		if t.partBusy {
			return nil, refuse(409, "another part of this contribution is still arriving", nil)
		}
		t.partBusy = true
	}
	return t, nil
}

func (c *Coordinator) partRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/upload-part", func(w http.ResponseWriter, r *http.Request) {
		if _, err := c.partHolder(token(r)); err != nil {
			writeErr(w, err)
			return
		}
		var have int64
		if st, err := os.Stat(c.partPath(token(r))); err == nil {
			have = st.Size()
		}
		writeJSON(w, 200, map[string]int64{"have": have})
	})
	mux.HandleFunc("PUT /api/upload-part", c.handlePart)
	mux.HandleFunc("POST /api/upload-finish", c.handleFinish)
	mux.HandleFunc("GET /api/upload-result", func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		res := c.finishRes[token(r)]
		var out map[string]any
		switch {
		case res == nil:
			out = map[string]any{"state": "none"}
		case res.state == "done":
			out = map[string]any{"state": "done", "receipt": res.receipt}
		case res.state == "refused":
			out = map[string]any{"state": "refused", "error": res.msg, "code": res.code}
		default:
			out = map[string]any{"state": "verifying"}
		}
		c.mu.Unlock()
		writeJSON(w, 200, out)
	})
}

func (c *Coordinator) handlePart(w http.ResponseWriter, r *http.Request) {
	tok := token(r)
	t, err := c.partHolderTake(tok, true)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer func() { c.mu.Lock(); t.partBusy = false; c.mu.Unlock() }()
	if r.ContentLength <= 0 || r.ContentLength > maxPart {
		writeJSON(w, 400, map[string]string{"error": fmt.Sprintf("a part is 1 to %d bytes, with a Content-Length", maxPart)})
		return
	}
	off, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	if err != nil || off < 0 {
		writeJSON(w, 400, map[string]string{"error": "offset is the number of bytes stored so far"})
		return
	}
	c.mu.Lock()
	size := c.headSize
	c.mu.Unlock()
	if off+r.ContentLength > size {
		writeJSON(w, 400, map[string]string{"error": fmt.Sprintf("the contribution is %d bytes in all", size)})
		return
	}
	p := c.partPath(tok)
	if off == 0 {
		// a new upload: no one else's leftovers stay behind
		if free, err := diskFree(c.Dir); err == nil && int64(free) < size+c.minFree() {
			writeJSON(w, 503, map[string]string{"error": "the coordinator is short of disk space; the operator has been told, try again later"})
			return
		}
		if m, _ := filepath.Glob(filepath.Join(c.Dir, "part-*")); len(m) > 0 {
			for _, f := range m {
				if f != p {
					os.Remove(f)
				}
			}
		}
		if err := os.Truncate(p, 0); err != nil && !os.IsNotExist(err) {
			writeErr(w, err)
			return
		}
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		c.logf("part: %v", err)
		writeErr(w, err)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		writeErr(w, err)
		return
	}
	if st.Size() > off {
		// bytes past the confirmed end belong to a part that was cut off (or to a coordinator restart mid-part): drop them, this part replaces them
		if err := f.Truncate(off); err != nil {
			writeErr(w, err)
			return
		}
	} else if st.Size() < off {
		writeJSON(w, 409, map[string]any{"error": "that part does not start where the stored bytes end", "have": st.Size()})
		return
	}
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(10 * time.Minute))
	_ = rc.SetWriteDeadline(time.Now().Add(11 * time.Minute))
	n, err := io.Copy(io.NewOffsetWriter(f, off), http.MaxBytesReader(w, r.Body, r.ContentLength))
	if err == nil && n != r.ContentLength {
		err = io.ErrUnexpectedEOF
	}
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		// keep only whole parts: cut back to where this one began
		_ = f.Truncate(off)
		writeJSON(w, 400, map[string]any{"error": "the part did not complete", "have": off})
		return
	}
	c.mu.Lock()
	t.uploadStarted = true // the upload has begun: the "upload did not start" rule is met
	if t.uploadFirst.IsZero() {
		t.uploadFirst = c.clock()
	}
	t.partBytes = off + n
	t.lastSeen = c.clock()
	c.mu.Unlock()
	writeJSON(w, 200, map[string]int64{"have": off + n})
}

func (c *Coordinator) handleFinish(w http.ResponseWriter, r *http.Request) {
	tok := token(r)
	p := c.partPath(tok)
	st, statErr := os.Stat(p)
	var have int64
	if statErr == nil {
		have = st.Size()
	}
	// the same gate as an upload: slot, size, disk, one at a time
	t, until, err := c.beginUpload(tok, have)
	if err != nil {
		writeErr(w, err)
		return
	}
	_ = until
	c.mu.Lock()
	if c.finishRes == nil {
		c.finishRes = map[string]*finishResult{}
	}
	for k, old := range c.finishRes { // answers older than an hour are no longer asked for
		if old.state != "verifying" && time.Since(old.at) > time.Hour {
			delete(c.finishRes, k)
		}
	}
	res := &finishResult{state: "verifying", at: time.Now()}
	c.finishRes[tok] = res
	t.verifying = true // as bodyDone does, with the lock already held
	c.mu.Unlock()
	go func() {
		defer c.endUpload(t)
		defer os.Remove(p) // a no-op once the file became the head
		rcpt, err := c.accept(p, t.Name, t.Handle, t)
		c.mu.Lock()
		if err != nil {
			res.state, res.code, res.msg = "refused", 500, "the coordinator could not do that; try again"
			if rf, ok := err.(*refusal); ok {
				res.code, res.msg = rf.Code, rf.Msg
			}
		} else {
			res.state, res.receipt = "done", rcpt
		}
		c.mu.Unlock()
		if err != nil {
			c.logf("upload: %s (%s) refused: %v", short(tok), t.Name, err)
			if rf, ok := err.(*refusal); ok && rf.Code == 400 {
				c.refusedUpload(t)
			}
		}
	}()
	writeJSON(w, 202, map[string]string{"state": "verifying"})
}
