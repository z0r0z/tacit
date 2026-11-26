package ceremony

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// TokenHeader carries a place's token (never the URL, so it stays out of logs and proxies' access lines).
const TokenHeader = "X-Ceremony-Token"

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	var r *refusal
	if errors.As(err, &r) {
		writeJSON(w, r.Code, map[string]string{"error": r.Msg})
		return
	}
	writeJSON(w, 500, map[string]string{"error": "the coordinator could not do that; try again"})
}

var fileRe = regexp.MustCompile(`^phase2-\d+$`)

// clientIP: the socket's address, or, behind a trusted proxy, the last address in the configured header.
func (c *Coordinator) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if c.ClientIPHeader == "" {
		return host
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	trusted := false
	for _, p := range c.TrustedProxies {
		if p.Contains(peer.Unmap()) {
			trusted = true
			break
		}
	}
	if !trusted {
		return host
	}
	vals := strings.Split(strings.Join(r.Header.Values(c.ClientIPHeader), ","), ",")
	for i := len(vals) - 1; i >= 0; i-- {
		if a, err := netip.ParseAddr(strings.TrimSpace(vals[i])); err == nil {
			return a.Unmap().String()
		}
	}
	return host
}

func token(r *http.Request) string { return strings.TrimSpace(r.Header.Get(TokenHeader)) }

// Handler serves the ceremony API:
//
//	GET    /api/head                          the head: index, sha256, size, file url, closed, queue length
//	GET    /f/phase2-<n>                      a file of the chain (byte ranges supported)
//	POST   /api/join      {name, handle, lane?} a place in the queue -> {token, ahead, state, poll_seconds}; lane "pool": a
//	                                          prover-pool machine, which waits behind every person
//	GET    /api/slot      (token header)      poll: {ahead, state, claim_by | expires, poll_seconds}; polling keeps the place
//	POST   /api/claim     (token header)      at the head: claim the slot -> {index, sha256, size, url, expires}
//	PUT    /api/upload    (token header)      the contribution, exactly the head's size -> the receipt, or why it was refused
//	DELETE /api/leave     (token header)      give the place up
//	GET    /api/transcript                    the state: base, head, receipts, coordinator key
func (c *Coordinator) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/head", func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		c.expireL()
		s, size, q := c.state, c.headSize, len(c.queue)
		c.mu.Unlock()
		writeJSON(w, 200, map[string]any{"index": s.HeadIndex, "sha256": s.HeadSHA256, "size": size, "url": fmt.Sprintf("/f/phase2-%d", s.HeadIndex), "closed": s.Closed, "queue": q})
	})
	mux.HandleFunc("GET /f/{name}", func(w http.ResponseWriter, r *http.Request) {
		n := r.PathValue("name")
		if !fileRe.MatchString(n) {
			http.NotFound(w, r)
			return
		}
		// The slot holder's downloads are never limited and count as its progress; everyone else shares a few
		// connections (the mirror serves every accepted file too).
		tok := token(r)
		holder := tok != "" && c.isSlotHolder(tok)
		if !holder {
			release, ok := c.files.acquire(ipKey(c.clientIP(r)), c.filesPerIP(), c.filesTotal())
			if !ok {
				w.Header().Set("Retry-After", "60")
				writeJSON(w, 429, map[string]string{"error": "too many downloads at once; try again in a minute, or use the mirror"})
				return
			}
			defer release()
		}
		c.mu.Lock()
		isHead := n == fmt.Sprintf("phase2-%d", c.state.HeadIndex)
		c.mu.Unlock()
		if holder && isHead {
			cw := &countingWriter{ResponseWriter: w, flush: func(k int64) { c.headServed(tok, k) }}
			defer cw.done()
			w = cw
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(2 * time.Hour))
		http.ServeFile(w, r, filepath.Join(c.Dir, n))
	})
	mux.HandleFunc("POST /api/join", func(w http.ResponseWriter, r *http.Request) {
		// a JSON body only: a cross-site form or text/plain post (which a browser sends without asking) cannot join
		if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
			writeJSON(w, 415, map[string]string{"error": "send the body as application/json"})
			return
		}
		var body struct{ Name, Handle, Lane string }
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]string{"error": "a name of 1 to 64 printable characters"})
			return
		}
		tok, st, err := c.JoinLane(body.Name, body.Handle, c.clientIP(r), body.Lane)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"token": tok, "ahead": st.Ahead, "state": st.State, "claim_by": st.ClaimBy, "poll_seconds": st.PollSeconds})
	})
	mux.HandleFunc("GET /api/slot", func(w http.ResponseWriter, r *http.Request) {
		st, err := c.Poll(token(r))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, st)
	})
	mux.HandleFunc("POST /api/claim", func(w http.ResponseWriter, r *http.Request) {
		s, err := c.Claim(token(r))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, s)
	})
	mux.HandleFunc("DELETE /api/leave", func(w http.ResponseWriter, r *http.Request) {
		if err := c.Leave(token(r)); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"left": true})
	})
	mux.HandleFunc("PUT /api/upload", c.handleUpload)
	c.partRoutes(mux)
	mux.HandleFunc("GET /api/transcript", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, c.State()) })
	return c.logRequests(oldClients(mux))
}

// oldClients: the first version of the tool sent the token in the URL; say what to do rather than "not found".
func oldClients(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Query().Has("token") {
			writeJSON(w, 400, map[string]string{"error": "this tacit-ceremony is out of date: git pull and build it again"})
			return
		}
		h.ServeHTTP(w, r)
	})
}

func (c *Coordinator) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.ContentLength < 0 {
		writeJSON(w, 411, map[string]string{"error": "the upload needs a Content-Length"})
		return
	}
	t, until, err := c.beginUpload(token(r), r.ContentLength)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer c.endUpload(t)
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(until)
	_ = rc.SetWriteDeadline(until.Add(verifyGrace + 5*time.Minute)) // the check after the upload waits its turn and takes a minute or two
	f, err := os.CreateTemp(c.Dir, "upload-*")
	if err != nil {
		c.logf("upload: %v", err)
		writeErr(w, err)
		return
	}
	name := f.Name()
	defer os.Remove(name) // a no-op once the file became the head
	n, err := io.Copy(f, &floorReader{r: http.MaxBytesReader(w, r.Body, r.ContentLength), t0: time.Now(), size: r.ContentLength, limit: until.Add(c.slotCap() / 8)})
	if err == nil && n != r.ContentLength {
		err = io.ErrUnexpectedEOF
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		c.logf("upload: %s: %d of %d bytes: %v", short(t.Token), n, r.ContentLength, err)
		writeJSON(w, 400, map[string]string{"error": "the upload did not complete"})
		return
	}
	c.bodyDone(t)
	rcpt, err := c.accept(name, t.Name, t.Handle, t)
	if err != nil {
		c.logf("upload: %s (%s) refused: %v", short(t.Token), t.Name, err)
		if r, ok := err.(*refusal); ok && r.Code == 400 {
			c.refusedUpload(t)
		}
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, rcpt)
}

// fileLimiter bounds concurrent file downloads per client address and in all.
type fileLimiter struct {
	mu    sync.Mutex
	byKey map[string]int
	total int
}

func (l *fileLimiter) acquire(key string, perKey, total int) (func(), bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.byKey == nil {
		l.byKey = map[string]int{}
	}
	if l.total >= total || l.byKey[key] >= perKey {
		return nil, false
	}
	l.total++
	l.byKey[key]++
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			l.total--
			if l.byKey[key]--; l.byKey[key] <= 0 {
				delete(l.byKey, key)
			}
			l.mu.Unlock()
		})
	}, true
}

// countingWriter reports the bytes written, in steps of 16 MiB and at the end.
type countingWriter struct {
	http.ResponseWriter
	pending int64
	flush   func(int64)
}

func (w *countingWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	if w.pending += int64(n); w.pending >= 16<<20 {
		w.flush(w.pending)
		w.pending = 0
	}
	return n, err
}
func (w *countingWriter) done() {
	if w.pending > 0 {
		w.flush(w.pending)
		w.pending = 0
	}
}
func (w *countingWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

type loggedWriter struct {
	http.ResponseWriter
	code  int
	bytes int64
}

func (l *loggedWriter) WriteHeader(code int) { l.code = code; l.ResponseWriter.WriteHeader(code) }
func (l *loggedWriter) Write(b []byte) (int, error) {
	if l.code == 0 {
		l.code = 200
	}
	n, err := l.ResponseWriter.Write(b)
	l.bytes += int64(n)
	return n, err
}
func (l *loggedWriter) Unwrap() http.ResponseWriter { return l.ResponseWriter }

// logRequests: one line per request (method, path without the query, status, bytes out, time, client address).
func (c *Coordinator) logRequests(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lw := &loggedWriter{ResponseWriter: w}
		h.ServeHTTP(lw, r)
		if r.URL.Path == "/api/slot" && lw.code < 500 {
			return // polls every few seconds, and stale tokens; the queue's own lines say what changed
		}
		c.logf("http: %s %s %d %dB %s %s", r.Method, r.URL.Path, lw.code, lw.bytes, time.Since(start).Round(time.Millisecond), c.clientIP(r))
	})
}

// Server for the public API, with timeouts; file downloads and uploads extend their own deadlines.
func (c *Coordinator) Server(addr string) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           c.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
}

// AdminHandler is for the operator, on a loopback address only:
//
//	GET  /admin/queue                         every place: position, token prefix, name, address, times
//	POST /admin/kick   {position | token}     drop a place (token: a prefix of 6 or more characters)
//	POST /admin/close                         close the ceremony
func (c *Coordinator) AdminHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /admin/queue", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, c.Queue()) })
	mux.HandleFunc("POST /admin/kick", func(w http.ResponseWriter, r *http.Request) {
		body := struct {
			Position *int   `json:"position"`
			Token    string `json:"token"`
		}{}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]string{"error": "position or token"})
			return
		}
		pos := -1
		if body.Position != nil {
			pos = *body.Position
		}
		who, err := c.Kick(pos, body.Token)
		if err != nil {
			writeJSON(w, 404, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]string{"removed": who})
	})
	mux.HandleFunc("POST /admin/ban", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Prefix string `json:"prefix"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]string{"error": "prefix"})
			return
		}
		n, err := c.Ban(body.Prefix)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"banned": body.Prefix, "dropped": n})
	})
	mux.HandleFunc("POST /admin/close", func(w http.ResponseWriter, r *http.Request) {
		if err := c.Close(); err != nil {
			c.logf("admin: close: %v", err)
			writeErr(w, err)
			return
		}
		c.logf("admin: the ceremony is closed")
		writeJSON(w, 200, map[string]bool{"closed": true})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		if a, err := netip.ParseAddr(host); err != nil || !a.Unmap().IsLoopback() {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// Serve the API on addr (and the operator's endpoints on adminAddr, if given, which must be a loopback address) until
// ctx ends.
func (c *Coordinator) Serve(ctx context.Context, addr, adminAddr string) error {
	srv := c.Server(addr)
	errc := make(chan error, 2)
	var admin *http.Server
	if adminAddr != "" {
		host, _, err := net.SplitHostPort(adminAddr)
		if a, perr := netip.ParseAddr(host); err != nil || perr != nil || !a.IsLoopback() {
			return errors.New("the admin address must be a loopback address, e.g. 127.0.0.1:8081")
		}
		admin = &http.Server{Addr: adminAddr, Handler: c.AdminHandler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second}
		go func() { errc <- admin.ListenAndServe() }()
	}
	go func() { errc <- srv.ListenAndServe() }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if admin != nil {
		_ = admin.Shutdown(sctx)
	}
	err := srv.Shutdown(sctx)
	c.mu.Lock()
	c.saveQueueL()
	c.mu.Unlock()
	return err
}
