package ceremony

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	curve "github.com/consensys/gnark-crypto/ecc/bn254"
)

// PinnedCoordinatorKey is the live coordinator's ed25519 public key; receipts are checked against it.
const PinnedCoordinatorKey = "c22b59ae8acf7a1c2b78c4da8cfd2a3e7a21f2d2809a4d35e3a71e0fd2052eb7"

// ClientOptions for a contributor.
type ClientOptions struct {
	Coordinator    string        // the coordinator's URL
	CoordinatorKey string        // hex ed25519 public key the receipt must be signed with
	Name, Handle   string        // as they will appear in the transcript
	Workdir        string        // where the head and the contribution are written (removed by Cleanup)
	Poll           time.Duration // how often to poll; zero: as the coordinator asks
	Log            func(string)  // status lines
	Progress       io.Writer     // progress lines (nil: none)
}

// Client is one contributor's session with a coordinator: a place in the queue kept alive by polling, the slot, the
// files, and the receipt.
type Client struct {
	o      ClientOptions
	base   string
	api    *http.Client
	big    *http.Client
	mu     sync.Mutex
	token  string
	done   bool
	status Status
	lost   error
	notify chan struct{}
	stopHB context.CancelFunc
	temp   []string
	once   sync.Once
}

func NewClient(o ClientOptions) *Client {
	if o.Log == nil {
		o.Log = func(string) {}
	}
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   30 * time.Second,
		ExpectContinueTimeout: 5 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	}
	return &Client{
		o:      o,
		base:   strings.TrimRight(o.Coordinator, "/"),
		api:    &http.Client{Timeout: 30 * time.Second, Transport: tr},
		big:    &http.Client{Transport: tr}, // bounded per request by a context and a stall timer
		notify: make(chan struct{}, 1),
	}
}

type httpError struct {
	Code int
	Msg  string
}

func (e *httpError) Error() string {
	if e.Msg != "" {
		return e.Msg
	}
	return fmt.Sprintf("HTTP %d", e.Code)
}

// transient: worth trying again (no answer, or the coordinator or something in front of it failed).
func transient(err error) bool {
	var he *httpError
	if errors.As(err, &he) {
		return he.Code >= 500
	}
	return err != nil && !errors.Is(err, context.Canceled)
}

func (c *Client) call(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	c.mu.Lock()
	if c.token != "" {
		req.Header.Set(TokenHeader, c.token)
	}
	c.mu.Unlock()
	resp, err := c.api.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		var e struct{ Error string }
		_ = json.Unmarshal(b, &e)
		return &httpError{resp.StatusCode, e.Error}
	}
	if out != nil {
		return json.Unmarshal(b, out)
	}
	return nil
}

// retry fn on transient errors, up to n times, with a growing pause.
func retry(ctx context.Context, n int, log func(string), what string, fn func() error) error {
	var err error
	for i := 0; i < n; i++ {
		if err = fn(); err == nil || !transient(err) || ctx.Err() != nil {
			return err
		}
		d := time.Duration(1<<min(i, 5)) * time.Second
		log(fmt.Sprintf("%s: %v; trying again in %s", what, err, d))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
		}
	}
	return err
}

// Head as the coordinator gives it.
type Head struct {
	Index  int    `json:"index"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	URL    string `json:"url"`
	Closed bool   `json:"closed"`
	Queue  int    `json:"queue"`
}

func (c *Client) head(ctx context.Context) (Head, error) {
	var h Head
	err := retry(ctx, 6, c.o.Log, "reading the head", func() error { return c.call(ctx, "GET", "/api/head", nil, &h) })
	if err == nil && h.Closed {
		err = errors.New("the ceremony is closed")
	}
	return h, err
}

func (c *Client) join(ctx context.Context) error {
	var j struct {
		Token string `json:"token"`
		Ahead int    `json:"ahead"`
		State string `json:"state"`
		Poll  int    `json:"poll_seconds"`
	}
	err := retry(ctx, 6, c.o.Log, "joining the queue", func() error {
		return c.call(ctx, "POST", "/api/join", map[string]string{"name": c.o.Name, "handle": c.o.Handle}, &j)
	})
	if err != nil {
		return fmt.Errorf("could not join the queue: %w", err)
	}
	c.mu.Lock()
	c.token = j.Token
	c.status = Status{Ahead: j.Ahead, State: j.State, PollSeconds: j.Poll}
	c.mu.Unlock()
	hctx, cancel := context.WithCancel(ctx)
	c.stopHB = cancel
	go c.heartbeat(hctx)
	return nil
}

func (c *Client) pollEvery() time.Duration {
	if c.o.Poll > 0 {
		return c.o.Poll
	}
	c.mu.Lock()
	s := c.status.PollSeconds
	c.mu.Unlock()
	if s <= 0 {
		s = 15
	}
	return time.Duration(s) * time.Second
}

// heartbeat polls the place until the session ends; the coordinator drops a place that stops polling. A dropped
// connection is retried on the next beat; a place the coordinator no longer knows ends the session.
func (c *Client) heartbeat(ctx context.Context) {
	failing := false
	for {
		var st Status
		err := c.call(ctx, "GET", "/api/slot", nil, &st)
		var he *httpError
		switch {
		case ctx.Err() != nil:
			return
		case errors.As(err, &he) && he.Code == 404:
			c.mu.Lock()
			if !c.done {
				c.lost = errors.New("the coordinator dropped this place in the queue (" + he.Msg + ")")
			}
			c.mu.Unlock()
			c.ping()
			return
		case err != nil:
			if !failing {
				c.o.Log(fmt.Sprintf("cannot reach the coordinator (%v); still trying, the place is kept while polls get through", err))
			}
			failing = true
		default:
			if failing {
				c.o.Log("the coordinator answers again")
			}
			failing = false
			c.mu.Lock()
			c.status = st
			c.mu.Unlock()
			c.ping()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(c.pollEvery()):
		}
	}
}

func (c *Client) ping() {
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *Client) lostErr() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lost
}

// waitTurn until this place is at the head.
func (c *Client) waitTurn(ctx context.Context) error {
	last := -1
	for {
		c.mu.Lock()
		st, lost := c.status, c.lost
		c.mu.Unlock()
		if lost != nil {
			return lost
		}
		if st.State == "claim" || st.State == "active" {
			return nil
		}
		if st.Ahead != last {
			c.o.Log(fmt.Sprintf("in the queue, %d ahead", st.Ahead))
			last = st.Ahead
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.notify:
		}
	}
}

func (c *Client) claim(ctx context.Context) (Slot, error) {
	var s Slot
	err := retry(ctx, 6, c.o.Log, "claiming the slot", func() error { return c.call(ctx, "POST", "/api/claim", nil, &s) })
	return s, err
}

// Cleanup leaves the queue if the session still holds a place and removes the session's files. It is safe to call
// more than once and from a signal handler.
func (c *Client) Cleanup() {
	c.once.Do(func() {
		if c.stopHB != nil {
			c.stopHB()
		}
		c.mu.Lock()
		tok, done := c.token, c.done
		files := append([]string(nil), c.temp...)
		c.mu.Unlock()
		if tok != "" && !done {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := c.call(ctx, "DELETE", "/api/leave", nil, nil); err == nil {
				c.o.Log("left the queue")
			}
			cancel()
		}
		for _, f := range files {
			os.Remove(f)
		}
	})
}

func (c *Client) track(paths ...string) {
	c.mu.Lock()
	c.temp = append(c.temp, paths...)
	c.mu.Unlock()
}

func (c *Client) finished() {
	c.mu.Lock()
	c.done = true
	c.mu.Unlock()
	if c.stopHB != nil {
		c.stopHB()
	}
}

// Contribute: join, wait for the slot, claim it, download the head and check it, contribute with fresh randomness,
// upload, and check the receipt. It returns the receipt and this contribution's hash.
func (c *Client) Contribute(ctx context.Context) (*Receipt, string, error) {
	h, err := c.head(ctx)
	if err != nil {
		return nil, "", err
	}
	need := uint64(2*h.Size) + 256<<20
	if free, err := diskFree(c.o.Workdir); err == nil && free < need {
		return nil, "", fmt.Errorf("%s has %s free; a contribution needs about %s (the head and the new file)", c.o.Workdir, mb(int64(free)), mb(int64(need)))
	}
	if err := c.join(ctx); err != nil {
		return nil, "", err
	}
	if err := c.waitTurn(ctx); err != nil {
		return nil, "", err
	}
	slot, err := c.claim(ctx)
	if err != nil {
		return nil, "", fmt.Errorf("could not claim the slot: %w", err)
	}
	c.o.Log(fmt.Sprintf("your turn: the slot is yours until %s", slot.Expires))
	in := filepath.Join(c.o.Workdir, fmt.Sprintf("phase2-%d", slot.Index))
	out := filepath.Join(c.o.Workdir, fmt.Sprintf("phase2-%d", slot.Index+1))
	c.track(in, in+".part", out, out+".tmp")
	if err := c.download(ctx, c.base+slot.URL, in, slot.Size, slot.SHA256, fmt.Sprintf("downloading phase2-%d", slot.Index)); err != nil {
		return nil, "", err
	}
	if err := c.lostErr(); err != nil {
		return nil, "", err
	}
	est := EstimateContribute(slot.Size)
	c.o.Log(fmt.Sprintf("contributing: fresh randomness, discarded when this program exits (rough estimate for this machine: %s)", est.Round(time.Minute)))
	stop := c.ticker("contributing", est)
	hash, err := Contribute(in, out)
	stop()
	if err != nil {
		return nil, "", err
	}
	os.Remove(in)
	c.o.Log("your contribution hash: " + hash)
	if err := c.lostErr(); err != nil {
		return nil, hash, err
	}
	r, err := c.upload(ctx, out, hash, slot)
	if err != nil {
		return nil, hash, err
	}
	c.finished()
	return r, hash, nil
}

// UploadFile is the offline path: in is the head the contribution was made on (with contribute-file), out the
// contribution. It joins the queue, waits for the slot, checks the head is still in, uploads out and checks the receipt.
func (c *Client) UploadFile(ctx context.Context, in, out string) (*Receipt, error) {
	inSHA, err := FileSHA256(in)
	if err != nil {
		return nil, err
	}
	if _, err := CheckShape(out); err != nil {
		return nil, err
	}
	outSHA, err := FileSHA256(out)
	if err != nil {
		return nil, err
	}
	h, err := c.head(ctx)
	if err != nil {
		return nil, err
	}
	stale := func(idx int, sha string) (*Receipt, error) {
		if r := c.findReceipt(ctx, outSHA); r != nil {
			c.o.Log("this contribution is already in the chain")
			return r, checkReceipt(r, c.o.CoordinatorKey, outSHA, outSHA, inSHA, r.Index-1)
		}
		return nil, fmt.Errorf("the head is now phase2-%d (sha256 %s), not the file this contribution was made on (%s); download the head and contribute again", idx, sha, inSHA)
	}
	if h.SHA256 != inSHA {
		return stale(h.Index, h.SHA256)
	}
	if st, err := os.Stat(out); err != nil || st.Size() != h.Size {
		return nil, fmt.Errorf("the contribution must be %d bytes, the size of the head", h.Size)
	}
	if err := c.join(ctx); err != nil {
		return nil, err
	}
	if err := c.waitTurn(ctx); err != nil {
		return nil, err
	}
	slot, err := c.claim(ctx)
	if err != nil {
		return nil, fmt.Errorf("could not claim the slot: %w", err)
	}
	if slot.SHA256 != inSHA {
		return stale(slot.Index, slot.SHA256)
	}
	r, err := c.upload(ctx, out, outSHA, slot)
	if err != nil {
		return nil, err
	}
	c.finished()
	return r, nil
}

func (c *Client) findReceipt(ctx context.Context, hash string) *Receipt {
	var s State
	if err := c.call(ctx, "GET", "/api/transcript", nil, &s); err != nil {
		return nil
	}
	for i := range s.Receipts {
		if s.Receipts[i].ContributionHash == hash {
			return &s.Receipts[i]
		}
	}
	return nil
}

// checkReceipt: signed by the pinned key, for this contribution, built on the head this slot was given.
func checkReceipt(r *Receipt, key, hash, fileSHA, prevSHA string, prevIdx int) error {
	switch {
	case r == nil:
		return errors.New("no receipt")
	case !VerifyReceipt(*r, key):
		return fmt.Errorf("the receipt is not signed by the coordinator key %s", key)
	case r.ContributionHash != hash:
		return fmt.Errorf("the receipt is for contribution %s, not yours (%s)", r.ContributionHash, hash)
	case r.FileSHA256 != fileSHA:
		return fmt.Errorf("the receipt's file hash %s is not your file's (%s)", r.FileSHA256, fileSHA)
	case r.PrevFileSHA256 != prevSHA:
		return fmt.Errorf("the receipt says it builds on %s, not on the head you were given (%s)", r.PrevFileSHA256, prevSHA)
	case r.Index != prevIdx+1:
		return fmt.Errorf("the receipt is for phase2-%d, not phase2-%d", r.Index, prevIdx+1)
	}
	return nil
}

func (c *Client) upload(ctx context.Context, out, hash string, slot Slot) (*Receipt, error) {
	fileSHA, err := FileSHA256(out)
	if err != nil {
		return nil, err
	}
	if fileSHA != hash {
		return nil, errors.New("the written file does not hash to the contribution hash")
	}
	expires, err := time.Parse(time.RFC3339, slot.Expires)
	if err != nil {
		expires = time.Now().Add(2 * time.Hour)
	}
	for attempt := 0; ; attempt++ {
		r, again, err := c.uploadOnce(ctx, out, slot, expires)
		if err == nil {
			return r, checkReceipt(r, c.o.CoordinatorKey, hash, fileSHA, slot.SHA256, slot.Index)
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// the answer may have been lost after the coordinator took it
		if r := c.findReceipt(ctx, hash); r != nil {
			c.o.Log("the upload was accepted (found in the transcript)")
			return r, checkReceipt(r, c.o.CoordinatorKey, hash, fileSHA, slot.SHA256, slot.Index)
		}
		if !again || attempt >= 5 || time.Now().After(expires) {
			return nil, fmt.Errorf("the contribution was refused: %w", err)
		}
		if lost := c.lostErr(); lost != nil {
			return nil, lost
		}
		d := time.Duration(5*(attempt+1)) * time.Second
		c.o.Log(fmt.Sprintf("upload: %v; trying again in %s", err, d))
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(d):
		}
	}
}

func (c *Client) uploadOnce(ctx context.Context, out string, slot Slot, expires time.Time) (*Receipt, bool, error) {
	f, err := os.Open(out)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, false, err
	}
	rctx, cancel := context.WithDeadline(ctx, expires.Add(20*time.Minute))
	defer cancel()
	p := c.progress(fmt.Sprintf("uploading phase2-%d", slot.Index+1), st.Size(), 0)
	body := newStallReader(&progressReader{f, p}, 90*time.Second, cancel)
	req, err := http.NewRequestWithContext(rctx, "PUT", c.base+"/api/upload", body)
	if err != nil {
		return nil, false, err
	}
	req.ContentLength = st.Size()
	req.Header.Set("Content-Type", "application/octet-stream")
	c.mu.Lock()
	req.Header.Set(TokenHeader, c.token)
	c.mu.Unlock()
	resp, err := c.big.Do(req)
	body.stop()
	p.finish()
	if err != nil {
		return nil, true, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		var e struct{ Error string }
		_ = json.Unmarshal(b, &e)
		he := &httpError{resp.StatusCode, e.Error}
		return nil, he.Code >= 500 || strings.Contains(he.Msg, "already in progress"), he
	}
	var r Receipt
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, true, err
	}
	return &r, false, nil
}

// download url to path, resuming a partial file after a dropped connection, and check its size and SHA-256.
func (c *Client) download(ctx context.Context, url, path string, size int64, sha, label string) error {
	part := path + ".part"
	for attempt := 0; ; attempt++ {
		err := c.downloadOnce(ctx, url, part, size, label)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if lost := c.lostErr(); lost != nil {
			return lost
		}
		if attempt >= 10 {
			return fmt.Errorf("%s: %w", label, err)
		}
		d := time.Duration(2*(attempt+1)) * time.Second
		c.o.Log(fmt.Sprintf("%s: %v; resuming in %s", label, err, d))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
		}
	}
	sum, err := FileSHA256(part)
	if err != nil {
		return err
	}
	if sum != sha {
		os.Remove(part)
		return fmt.Errorf("the downloaded file hashes to %s, not the coordinator's %s", sum, sha)
	}
	return os.Rename(part, path)
}

func (c *Client) downloadOnce(ctx context.Context, url, part string, size int64, label string) error {
	f, err := os.OpenFile(part, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	have := st.Size()
	if have > size {
		have = 0
	}
	if have == size {
		return nil
	}
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, "GET", url, nil)
	if err != nil {
		return err
	}
	if have > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", have))
	}
	c.mu.Lock()
	if c.token != "" {
		req.Header.Set(TokenHeader, c.token) // the slot's download: never limited, and counted as its progress
	}
	c.mu.Unlock()
	resp, err := c.big.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusPartialContent:
	case http.StatusOK:
		have = 0
	default:
		return &httpError{resp.StatusCode, ""}
	}
	if err := f.Truncate(have); err != nil {
		return err
	}
	if _, err := f.Seek(have, io.SeekStart); err != nil {
		return err
	}
	p := c.progress(label, size, have)
	body := newStallReader(resp.Body, 60*time.Second, cancel)
	defer body.stop()
	_, err = io.Copy(f, &progressReader{io.LimitReader(body, size-have), p})
	p.finish()
	if err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if st, _ := f.Stat(); st == nil || st.Size() != size {
		return errors.New("the connection closed early")
	}
	return nil
}

// ── progress ──

func mb(n int64) string { return fmt.Sprintf("%.0f MB", float64(n)/1e6) }

type progress struct {
	w           io.Writer
	label       string
	total, base int64
	done        int64
	start, last time.Time
	tty         bool
	mu          sync.Mutex
}

func isTTY(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

func (c *Client) progress(label string, total, base int64) *progress {
	return &progress{w: c.o.Progress, label: label, total: total, base: base, done: base, start: time.Now(), tty: c.o.Progress != nil && isTTY(c.o.Progress)}
}

func (p *progress) add(n int) {
	if p.w == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.done += int64(n)
	every := 10 * time.Second
	if p.tty {
		every = 500 * time.Millisecond
	}
	if time.Since(p.last) >= every {
		p.last = time.Now()
		p.print()
	}
}

func (p *progress) print() {
	el := time.Since(p.start).Seconds()
	rate := float64(p.done-p.base) / max(el, 0.001)
	line := fmt.Sprintf("%s: %s of %s (%d%%)", p.label, mb(p.done), mb(p.total), p.done*100/max(p.total, 1))
	if rate > 0 && el > 1 {
		left := time.Duration(float64(p.total-p.done)/rate) * time.Second
		line += fmt.Sprintf(", %.1f MB/s, about %s left", rate/1e6, left.Round(time.Second))
	}
	if p.tty {
		fmt.Fprintf(p.w, "\r%-100s", line)
	} else {
		fmt.Fprintln(p.w, line)
	}
}

func (p *progress) finish() {
	if p.w == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.print()
	if p.tty {
		fmt.Fprintln(p.w)
	}
}

type progressReader struct {
	r io.Reader
	p *progress
}

func (r *progressReader) Read(b []byte) (int, error) {
	n, err := r.r.Read(b)
	r.p.add(n)
	return n, err
}

// stallReader cancels a transfer that moves no bytes for a while.
type stallReader struct {
	r io.Reader
	t *time.Timer
	d time.Duration
}

func newStallReader(r io.Reader, d time.Duration, cancel func()) *stallReader {
	return &stallReader{r: r, d: d, t: time.AfterFunc(d, cancel)}
}

func (s *stallReader) Read(b []byte) (int, error) {
	n, err := s.r.Read(b)
	if n > 0 {
		s.t.Reset(s.d)
	}
	if err != nil {
		s.t.Stop() // the body is sent (or failed); the answer is bounded by the request's own deadline
	}
	return n, err
}

func (s *stallReader) stop() { s.t.Stop() }

// ticker prints the time spent on a step with no progress of its own, against an estimate.
func (c *Client) ticker(label string, est time.Duration) func() {
	if c.o.Progress == nil {
		return func() {}
	}
	start := time.Now()
	tty := isTTY(c.o.Progress)
	every := 30 * time.Second
	if tty {
		every = time.Second
	}
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				el := time.Since(start).Round(time.Second)
				line := fmt.Sprintf("%s: %s so far", label, el)
				if left := est - el; left > 0 {
					line += fmt.Sprintf(", roughly %s left", left.Round(time.Minute))
				}
				if tty {
					fmt.Fprintf(c.o.Progress, "\r%-100s", line)
				} else {
					fmt.Fprintln(c.o.Progress, line)
				}
			}
		}
	}()
	return func() {
		close(done)
		wg.Wait()
		if tty {
			fmt.Fprintln(c.o.Progress)
		}
		fmt.Fprintf(c.o.Progress, "%s: done in %s\n", label, time.Since(start).Round(time.Second))
	}
}

// EstimateContribute: a rough time for a contribution to a file of this size on this machine, from the cost of the
// per-point work (decompress, scale, compress) measured on a few hundred points on every core.
func EstimateContribute(size int64) time.Duration {
	n := runtime.NumCPU()
	const per = 64
	_, _, g1, _ := curve.Generators()
	pts := make([][32]byte, per)
	for i := range pts {
		k, _ := rand.Int(rand.Reader, curve.ID.ScalarField())
		var p curve.G1Affine
		p.ScalarMultiplication(&g1, k)
		pts[i] = p.Bytes()
	}
	k, _ := rand.Int(rand.Reader, curve.ID.ScalarField())
	start := time.Now()
	var wg sync.WaitGroup
	for w := 0; w < n; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var p curve.G1Affine
			for i := range pts {
				_, _ = p.SetBytes(pts[i][:])
				p.ScalarMultiplication(&p, k)
				_ = p.Bytes()
			}
		}()
	}
	wg.Wait()
	perPoint := time.Since(start) / time.Duration(n*per) // wall time per point with every core busy
	points := size / 32
	return time.Duration(points)*perPoint*3/2 + time.Duration(size/(200<<20))*time.Second // + reading, writing and hashing
}
