package ceremony

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// a clock the test moves
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (f *fakeClock) now() time.Time { f.mu.Lock(); defer f.mu.Unlock(); return f.t }
func (f *fakeClock) add(d time.Duration) {
	f.mu.Lock()
	f.t = f.t.Add(d)
	f.mu.Unlock()
}

func withClock(c *Coordinator) *fakeClock {
	// the clock starts at the real time: an upload's socket deadlines come from it too, and a fixed date in the past would
	// have them already expired
	clk := &fakeClock{t: time.Now().UTC().Truncate(time.Second)}
	c.now = clk.now
	return clk
}

type apiResp struct {
	Code int
	Body map[string]any
}

func call(t *testing.T, srv *httptest.Server, method, path, tok string, body io.Reader, length int64) apiResp {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, body)
	if tok != "" {
		req.Header.Set(TokenHeader, tok)
	}
	if length >= 0 {
		req.ContentLength = length
	}
	if method == "POST" && body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return apiResp{resp.StatusCode, m}
}

func joinHTTP(t *testing.T, srv *httptest.Server, name string) string {
	t.Helper()
	r := call(t, srv, "POST", "/api/join", "", strings.NewReader(`{"name":"`+name+`"}`), -1)
	if r.Code != 200 {
		t.Fatalf("join %s: %d %v", name, r.Code, r.Body)
	}
	return r.Body["token"].(string)
}

type countingReader struct{ n *atomic.Int64 }

func (c countingReader) Read(b []byte) (int, error) { c.n.Add(int64(len(b))); return len(b), nil }

func uploadsLeft(t *testing.T, dir string) []string {
	m, _ := filepath.Glob(filepath.Join(dir, "upload-*"))
	return m
}

func TestUploadWithoutChallengeRefused(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	headPath := c.path(c.State().HeadIndex)
	p, err := Read(headPath)
	if err != nil {
		t.Fatal(err)
	}
	p.Contribute()
	p.Challenge = nil // a valid contribution with its challenge removed
	stripped := filepath.Join(f.dir, "stripped")
	if err := Write(p, stripped); err != nil {
		t.Fatal(err)
	}
	prev, _ := Read(headPath)
	next, _ := Read(stripped)
	if err := Verify(prev, next); err == nil {
		t.Fatal("Verify must refuse a contribution without its challenge")
	}
	head := c.State()
	if _, err := c.Accept(stripped, "x", ""); err == nil {
		t.Fatal("the coordinator must refuse a contribution without its challenge")
	}
	if s := c.State(); s.HeadSHA256 != head.HeadSHA256 || len(s.Receipts) != 0 {
		t.Fatal("the head must not move")
	}
	// a whole contribution is accepted
	q, _ := Read(headPath)
	q.Contribute()
	good := filepath.Join(f.dir, "good")
	_ = Write(q, good)
	if _, err := c.Accept(good, "x", ""); err != nil {
		t.Fatalf("a whole contribution is accepted: %v", err)
	}
}

func TestReadChecksCountsAgainstFileSize(t *testing.T) {
	f := newFixture(t)
	dir := t.TempDir()
	// 38 bytes: no commitments, a compressed G1 point, then a count of 2^32-1 points
	var b bytes.Buffer
	b.Write([]byte{0, 0})
	b.Write(append([]byte{0x80}, make([]byte, 31)...))
	_ = binary.Write(&b, binary.BigEndian, uint32(0xffffffff))
	small := filepath.Join(dir, "small")
	_ = os.WriteFile(small, b.Bytes(), 0o644)
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	if _, err := Read(small); !errors.Is(err, ErrNotAccumulator) {
		t.Fatalf("a count past the end of the file must be refused: %v", err)
	}
	runtime.ReadMemStats(&after)
	if grew := after.TotalAlloc - before.TotalAlloc; grew > 32<<20 {
		t.Fatalf("refusing it allocated %d bytes", grew)
	}
	// a good file: exact; one byte short or one byte over is refused
	good, _ := os.ReadFile(f.base)
	if n, err := CheckShape(f.base); err != nil || n != int64(len(good)) {
		t.Fatalf("the base file: %d %v", n, err)
	}
	for name, data := range map[string][]byte{"short": good[:len(good)-1], "long": append(append([]byte{}, good...), 0)} {
		p := filepath.Join(dir, name)
		_ = os.WriteFile(p, data, 0o644)
		if _, err := Read(p); !errors.Is(err, ErrNotAccumulator) {
			t.Fatalf("%s: must be refused: %v", name, err)
		}
	}
}

func TestUploadMustBeHeadSize(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	tok := joinHTTP(t, srv, "alice")
	size := c.headSize
	junk := bytes.Repeat([]byte{7}, int(size))

	if r := call(t, srv, "PUT", "/api/upload", tok, bytes.NewReader(junk), size); r.Code != 409 {
		t.Fatalf("an upload before the claim is refused: %d %v", r.Code, r.Body)
	}
	if r := call(t, srv, "POST", "/api/claim", tok, nil, -1); r.Code != 200 || int64(r.Body["size"].(float64)) != size {
		t.Fatalf("claim: %d %v", r.Code, r.Body)
	}
	for _, n := range []int64{size + 1, size - 1} {
		body := io.LimitReader(io.MultiReader(bytes.NewReader(junk), bytes.NewReader(make([]byte, 2))), n)
		r := call(t, srv, "PUT", "/api/upload", tok, body, n)
		if r.Code != 400 || !strings.Contains(r.Body["error"].(string), "exactly") {
			t.Fatalf("an upload of %d bytes (head %d) is refused: %d %v", n, size, r.Code, r.Body)
		}
		if left := uploadsLeft(t, c.Dir); len(left) != 0 {
			t.Fatalf("nothing is written for a refused size: %v", left)
		}
	}
	// a claimed length of 8 GB is refused on the header alone: nothing of the body is read
	var read atomic.Int64
	req := httptest.NewRequest("PUT", "/api/upload", countingReader{&read})
	req.ContentLength = 8 << 30
	req.Header.Set(TokenHeader, tok)
	rec := httptest.NewRecorder()
	c.Handler().ServeHTTP(rec, req)
	if rec.Code != 400 || read.Load() != 0 || len(uploadsLeft(t, c.Dir)) != 0 {
		t.Fatalf("an 8 GB length: %d, %d bytes read", rec.Code, read.Load())
	}
	// the right size but not an accumulator: refused with a message that names no server path
	r := call(t, srv, "PUT", "/api/upload", tok, bytes.NewReader(junk), size)
	if r.Code != 400 || strings.Contains(r.Body["error"].(string), c.Dir) || strings.Contains(r.Body["error"].(string), "/") {
		t.Fatalf("junk of the right size: %d %v", r.Code, r.Body)
	}
	if left := uploadsLeft(t, c.Dir); len(left) != 0 {
		t.Fatalf("a refused upload is removed: %v", left)
	}
	if c.State().HeadIndex != 17 {
		t.Fatal("the head must not move")
	}
}

func TestUploadAfterSlotEndsRefused(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	clk := withClock(c)
	c.SlotCap = time.Hour
	c.PerIP = -1
	c.Heartbeat = 24 * time.Hour // the clock jumps; polls are not what this tests
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	tok := joinHTTP(t, srv, "alice")
	if r := call(t, srv, "POST", "/api/claim", tok, nil, -1); r.Code != 200 {
		t.Fatalf("claim: %v", r.Body)
	}
	out := filepath.Join(f.dir, "next")
	if _, err := Contribute(c.path(17), out); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(out)
	// the slot's cap passes while a fully received upload is checked: the check finishes past the grace: refused
	c.beforeCommit = func() { clk.add(time.Hour + verifyGrace + time.Second) }
	r := call(t, srv, "PUT", "/api/upload", tok, bytes.NewReader(data), int64(len(data)))
	if r.Code != 409 || c.State().HeadIndex != 17 {
		t.Fatalf("a check that runs past the cap and its grace is refused: %d %v (head %d)", r.Code, r.Body, c.State().HeadIndex)
	}
	// an upload that starts after the slot ended is refused at once
	c.beforeCommit = nil
	tok2 := joinHTTP(t, srv, "bob")
	call(t, srv, "POST", "/api/claim", tok2, nil, -1)
	clk.add(time.Hour + time.Second)
	if r := call(t, srv, "PUT", "/api/upload", tok2, bytes.NewReader(data), int64(len(data))); r.Code != 409 {
		t.Fatalf("an upload after the slot ended: %d %v", r.Code, r.Body)
	}
	if left := uploadsLeft(t, c.Dir); len(left) != 0 || c.State().HeadIndex != 17 {
		t.Fatalf("left %v, head %d", left, c.State().HeadIndex)
	}
	// an upload that arrived in time is not lost because its check crosses the cap
	tok3 := joinHTTP(t, srv, "carol")
	call(t, srv, "POST", "/api/claim", tok3, nil, -1)
	c.headServed(tok3, c.headSize)
	clk.add(time.Hour - time.Minute)
	c.beforeCommit = func() { clk.add(5 * time.Minute) }
	if r := call(t, srv, "PUT", "/api/upload", tok3, bytes.NewReader(data), int64(len(data))); r.Code != 200 || c.State().HeadIndex != 18 {
		t.Fatalf("a check that crosses the cap still commits: %d %v", r.Code, r.Body)
	}
}

func TestQueuePlacesNeedPolls(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	clk := withClock(c)
	a, _, _ := c.Join("alice", "", "192.0.2.1")
	b, _, _ := c.Join("bob", "", "192.0.2.2")
	d, _, _ := c.Join("dave", "", "192.0.2.3")
	// alice and dave poll; bob does not
	for i := 0; i < 3; i++ {
		clk.add(25 * time.Second)
		if _, err := c.Poll(a); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Poll(d); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := c.Poll(b); err == nil {
		t.Fatal("a place whose client stopped polling is dropped")
	}
	if st, _ := c.Poll(d); st.Ahead != 1 {
		t.Fatalf("the places behind it move up: %+v", st)
	}
	// alice is at the head and keeps polling but never claims: after the claim window her place goes to dave
	if st, _ := c.Poll(a); st.State != "claim" {
		t.Fatalf("the head is asked to claim: %+v", st)
	}
	for i := 0; i < 8; i++ {
		clk.add(25 * time.Second)
		c.Poll(a)
		c.Poll(d)
	}
	if _, err := c.Poll(a); err == nil {
		t.Fatal("a head that does not claim in time is dropped")
	}
	st, _ := c.Poll(d)
	if st.State != "claim" || st.Ahead != 0 {
		t.Fatalf("the next place gets the slot: %+v", st)
	}
	// dave claims but only polls: polls alone do not keep a claimed slot
	if _, err := c.Claim(d); err != nil {
		t.Fatal(err)
	}
	for el := time.Duration(0); el < 10*time.Minute; el += 30 * time.Second {
		clk.add(30 * time.Second)
		if _, err := c.Poll(d); err != nil {
			t.Fatalf("a fresh slot is kept while its download may start (%s in): %v", el, err)
		}
	}
	clk.add(time.Minute)
	if _, err := c.Poll(d); err == nil {
		t.Fatal("a slot whose download never started is dropped")
	}
}

// A claimed slot is kept while it makes progress: the download starts, completes, and the upload starts in time.
func TestSlotNeedsProgress(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	clk := withClock(c)
	c.PerIP = -1
	pollFor := func(tok string, d time.Duration) error {
		for el := time.Duration(0); el < d; el += 30 * time.Second {
			clk.add(30 * time.Second)
			if _, err := c.Poll(tok); err != nil {
				return err
			}
		}
		return nil
	}
	// a slow download that never completes is dropped at DownloadBy
	a, _, _ := c.Join("alice", "", "192.0.2.1")
	c.Claim(a)
	clk.add(30 * time.Second)
	c.headServed(a, c.headSize/3) // a download at a fair pace that never completes
	if err := pollFor(a, 73*time.Minute); err != nil {
		t.Fatalf("a slot whose download is running is kept: %v", err)
	}
	if err := pollFor(a, 2*time.Minute); err == nil {
		t.Fatal("a slot whose download is not complete by DownloadBy is dropped")
	}
	// a download that is a trickle is dropped at the floor, one that runs at a fair pace is not
	{
		slow, _, _ := c.Join("slowpoke", "", "192.0.2.7")
		c.Claim(slow)
		clk.add(30 * time.Second)
		c.headServed(slow, 1) // a byte, then nothing worth the name
		if err := pollFor(slow, downloadFloorAfter-time.Minute); err != nil {
			t.Fatalf("a slot is not judged before the floor: %v", err)
		}
		if err := pollFor(slow, 2*time.Minute); err == nil {
			t.Fatal("a slot that has downloaded almost nothing in ten minutes is dropped")
		}
		fair, _, _ := c.Join("fair", "", "192.0.2.8")
		c.Claim(fair)
		clk.add(30 * time.Second)
		c.headServed(fair, c.headSize/3)
		if err := pollFor(fair, downloadFloorAfter+5*time.Minute); err != nil {
			t.Fatalf("a download at a fair pace is kept: %v", err)
		}
		c.Leave(fair)
	}
	// a slot that downloaded but never uploads is dropped at UploadStart
	b, _, _ := c.Join("bob", "", "192.0.2.2")
	c.Claim(b)
	c.headServed(b, c.headSize)
	if err := pollFor(b, 104*time.Minute); err != nil {
		t.Fatalf("a downloaded slot is kept while its upload may start: %v", err)
	}
	if err := pollFor(b, 2*time.Minute); err == nil {
		t.Fatal("a slot whose upload did not start by UploadStart is dropped")
	}
	// a slot that started uploading is kept up to the cap
	d, _, _ := c.Join("dave", "", "192.0.2.3")
	c.Claim(d)
	c.headServed(d, c.headSize)
	c.mu.Lock()
	c.queue[0].uploadStarted = true
	c.mu.Unlock()
	if err := pollFor(d, 119*time.Minute); err != nil {
		t.Fatalf("a slot that started its upload is kept to the cap: %v", err)
	}
	if err := pollFor(d, 2*time.Minute); err == nil {
		t.Fatal("and dropped past it")
	}
}

// Only the slot holder's download of the head counts, and others share a few download connections.
func TestHeadDownloadCountsAndLimits(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	c.PerIP = -1
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	tok := joinHTTP(t, srv, "alice")
	call(t, srv, "POST", "/api/claim", tok, nil, -1)
	get := func(tok string) int {
		req, _ := http.NewRequest("GET", srv.URL+"/f/phase2-17", nil)
		if tok != "" {
			req.Header.Set(TokenHeader, tok)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return resp.StatusCode
	}
	if get(tok) != 200 {
		t.Fatal("the slot holder downloads the head")
	}
	c.mu.Lock()
	served := c.queue[0].served
	c.mu.Unlock()
	if served != c.headSize {
		t.Fatalf("its download counts as progress: %d of %d", served, c.headSize)
	}
	if get("") != 200 {
		t.Fatal("anyone may download a file")
	}
	// two at once per address, then 429; the slot holder is never limited
	r1, _ := c.files.acquire(ipKey("127.0.0.1"), c.filesPerIP(), c.filesTotal())
	r2, _ := c.files.acquire(ipKey("127.0.0.1"), c.filesPerIP(), c.filesTotal())
	if get("") != 429 {
		t.Fatal("a third download at once from one address is refused")
	}
	if get(tok) != 200 {
		t.Fatal("the slot holder is not limited")
	}
	r1()
	r2()
	if get("") != 200 {
		t.Fatal("downloads free up")
	}
}

// A join must be a JSON request, so a web page cannot make its visitors join (a browser sends a cross-site text/plain
// or form post without asking).
func TestJoinNeedsJSON(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	for _, ct := range []string{"", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"} {
		req, _ := http.NewRequest("POST", srv.URL+"/api/join", strings.NewReader(`{"name":"mallory"}`))
		if ct != "" {
			req.Header.Set("Content-Type", ct)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 415 {
			t.Fatalf("a join sent as %q: %d", ct, resp.StatusCode)
		}
	}
	if len(c.Queue()) != 0 {
		t.Fatal("nobody joined")
	}
}

func TestBanAndIPv6Grouping(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	if _, _, err := c.Join("a", "", "2001:db8:1:1::1"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Join("b", "", "2001:db8:1:ffff::2"); err == nil {
		t.Fatal("one place per IPv6 /48")
	}
	if _, _, err := c.Join("c", "", "198.51.100.7"); err != nil {
		t.Fatal(err)
	}
	if n, err := c.Ban("198.51.100.0/24"); err != nil || n != 1 {
		t.Fatalf("ban drops the prefix's places: %d %v", n, err)
	}
	if _, _, err := c.Join("d", "", "198.51.100.9"); err == nil {
		t.Fatal("a banned prefix cannot join")
	}
	c2, err := Open(c.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := c2.Join("e", "", "198.51.100.10"); err == nil {
		t.Fatal("bans survive a restart")
	}
}

// Uploads refused as contributions end the slot after MaxRefused, so one slot cannot make the coordinator check
// file after file.
func TestRefusedUploadsEndTheSlot(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	tok := joinHTTP(t, srv, "mallory")
	call(t, srv, "POST", "/api/claim", tok, nil, -1)
	junk, _ := os.ReadFile(c.path(17)) // the head itself: right size, does not verify as a contribution on itself
	for i := 0; i < 2; i++ {
		if r := call(t, srv, "PUT", "/api/upload", tok, bytes.NewReader(junk), int64(len(junk))); r.Code != 400 {
			t.Fatalf("upload %d: %d %v", i, r.Code, r.Body)
		}
	}
	if r := call(t, srv, "GET", "/api/slot", tok, nil, -1); r.Code != 404 {
		t.Fatalf("after two refused uploads the slot is given up: %d", r.Code)
	}
}

// A malformed evaluations file cannot make seal allocate beyond its size.
func TestEvalsLengthsBoundedByFile(t *testing.T) {
	var b bytes.Buffer
	binary.Write(&b, binary.BigEndian, uint32(1<<30)) // 1G points claimed in 4 bytes
	if _, err := ReadPhase2Evaluations(bytes.NewReader(b.Bytes()), int64(b.Len())); err == nil {
		t.Fatal("a length beyond the file is refused before allocating")
	}
	f := newFixture(t)
	var w bytes.Buffer
	if err := WritePhase2Evaluations(&f.evals, &w); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadPhase2Evaluations(bytes.NewReader(w.Bytes()), int64(w.Len())); err != nil {
		t.Fatalf("a real evaluations file reads: %v", err)
	}
	if _, err := ReadPhase2Evaluations(bytes.NewReader(append(w.Bytes(), 0)), int64(w.Len()+1)); err == nil {
		t.Fatal("trailing bytes are refused")
	}
}

func TestLeaveAndOperatorKick(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	a := joinHTTP(t, srv, "alice")
	c.PerIP = -1
	b := joinHTTP(t, srv, "bob")
	if r := call(t, srv, "DELETE", "/api/leave", a, nil, -1); r.Code != 200 {
		t.Fatalf("leave: %d %v", r.Code, r.Body)
	}
	if r := call(t, srv, "GET", "/api/slot", a, nil, -1); r.Code != 404 {
		t.Fatal("a place that was given up is gone")
	}
	if r := call(t, srv, "GET", "/api/slot", b, nil, -1); r.Code != 200 || r.Body["state"] != "claim" {
		t.Fatalf("the next place gets the slot: %v", r.Body)
	}
	// a client that is stopped gives its place up
	c2 := joinHTTP(t, srv, "carol")
	cl := NewClient(ClientOptions{Coordinator: srv.URL, CoordinatorKey: c.State().CoordPubKey, Name: "dave", Workdir: t.TempDir(), Poll: 10 * time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error)
	go func() { _, _, err := cl.Contribute(ctx); done <- err }()
	// stop it once it holds its place (its token stored), as a person pressing Ctrl-C while it waits would
	waitFor(t, func() bool { cl.mu.Lock(); defer cl.mu.Unlock(); return cl.token != "" && len(c.Queue()) == 3 })
	cancel()
	<-done
	cl.Cleanup()
	if q := c.Queue(); len(q) != 2 || q[1].Name != "carol" {
		t.Fatalf("the stopped client left the queue: %+v", q)
	}
	// the operator
	admin := httptest.NewServer(c.AdminHandler())
	defer admin.Close()
	resp, err := http.Post(admin.URL+"/admin/kick", "application/json", strings.NewReader(`{"token":"`+c2[:8]+`"}`))
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("kick by token prefix: %v %v", err, resp)
	}
	if _, err := c.Kick(0, ""); err != nil {
		t.Fatalf("kick by position: %v", err)
	}
	if len(c.Queue()) != 0 {
		t.Fatal("the queue is empty")
	}
	req := httptest.NewRequest("GET", "/admin/queue", nil)
	req.RemoteAddr = "192.0.2.9:4000"
	rec := httptest.NewRecorder()
	c.AdminHandler().ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("the operator's endpoints answer only on loopback: %d", rec.Code)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 500; i++ {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out")
}

func TestQueueKeptAcrossRestart(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	clk := withClock(c)
	a, _, _ := c.Join("alice", "@a", "192.0.2.1")
	b, _, _ := c.Join("bob", "", "192.0.2.2")
	if _, err := c.Claim(a); err != nil {
		t.Fatal(err)
	}
	claimed := clk.now()
	clk.add(10 * time.Minute)
	c2, err := open(c.Dir, clk.now)
	if err != nil {
		t.Fatal(err)
	}
	q := c2.Queue()
	if len(q) != 2 || q[0].Name != "alice" || q[0].Claimed != claimed.Format(time.RFC3339) || q[1].Name != "bob" {
		t.Fatalf("the queue survives a restart: %+v", q)
	}
	if st, err := c2.Poll(a); err != nil || st.State != "active" {
		t.Fatalf("the claimed slot is kept: %+v %v", st, err)
	}
	if st, err := c2.Poll(b); err != nil || st.Ahead != 1 {
		t.Fatalf("and the place behind it: %+v %v", st, err)
	}
}

// One network cannot fill the queue: places per /24 and per /16 are limited, other networks are not affected, and turning the limits on
// trims a queue that one network already fills, keeping its earliest places and a claimed slot.
func TestPerNetworkLimitsAndTrim(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	c.PerIP = -1
	c.PerNet24, c.PerNet16 = 2, 3
	join := func(ip string) error { _, _, err := c.Join("n", "", ip); return err }
	if join("192.0.2.1") != nil || join("192.0.2.2") != nil {
		t.Fatal("two places from a /24 are fine")
	}
	if err := join("192.0.2.3"); err == nil {
		t.Fatal("a third place from one /24 is refused")
	}
	if join("192.0.3.1") != nil {
		t.Fatal("another /24 in the same /16 is fine")
	}
	if err := join("192.0.4.1"); err == nil {
		t.Fatal("a fourth place from one /16 is refused")
	}
	if join("198.51.100.1") != nil {
		t.Fatal("another network is not affected")
	}
	if join("2001:db8:1::1") != nil || join("2001:db8:2::1") != nil {
		t.Fatal("IPv6 places are counted by network too")
	}

	// the limits turned on after the queue filled
	g := newFixture(t)
	d := g.chain(t)
	d.PerIP = -1
	var first string
	for i := 1; i <= 6; i++ {
		tok, _, err := d.Join("n", "", fmt.Sprintf("192.0.2.%d", i))
		if err != nil {
			t.Fatal(err)
		}
		if i == 1 {
			first = tok
		}
	}
	d.Join("o", "", "198.51.100.9")
	if _, err := d.Claim(first); err != nil {
		t.Fatal(err)
	}
	d.PerNet24 = 2
	if n := d.TrimNetworks(); n != 4 {
		t.Fatalf("four places beyond the limit are dropped: %d", n)
	}
	q := d.Queue()
	if len(q) != 3 || q[0].IP != "192.0.2.1" || q[1].IP != "192.0.2.2" || q[2].IP != "198.51.100.9" {
		t.Fatalf("the earliest places of the network and the other network stay: %+v", q)
	}
	if d.Queue()[0].Claimed == "" {
		t.Fatal("the claimed slot is kept")
	}
}

func TestOnePlacePerAddressAndQueueCap(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	if _, _, err := c.Join("a", "", "192.0.2.1"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Join("b", "", "192.0.2.1"); err == nil {
		t.Fatal("a second place from one address is refused")
	}
	c.Join("c", "", "2001:db8::1")
	if _, _, err := c.Join("d", "", "2001:db8::2"); err == nil {
		t.Fatal("one IPv6 /64 counts as one address")
	}
	c.QueueCap = 3
	c.Join("e", "", "192.0.2.5")
	if _, _, err := c.Join("f", "", "192.0.2.6"); err == nil {
		t.Fatal("a full queue is refused")
	}
	if _, _, err := c.Join(strings.Repeat("x", 65), "", "192.0.2.7"); err == nil {
		t.Fatal("a long name is refused")
	}
}

func TestClientAddressBehindProxy(t *testing.T) {
	c := &Coordinator{}
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.5:3000"
	r.Header.Set("X-Forwarded-For", "203.0.113.9, 198.51.100.7")
	if ip := c.clientIP(r); ip != "10.0.0.5" {
		t.Fatalf("by default the socket's address: %s", ip)
	}
	c.ClientIPHeader = "X-Forwarded-For"
	if ip := c.clientIP(r); ip != "10.0.0.5" {
		t.Fatalf("the header is ignored from an untrusted peer: %s", ip)
	}
	c.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	if ip := c.clientIP(r); ip != "198.51.100.7" {
		t.Fatalf("from a trusted proxy, the address it added: %s", ip)
	}
}

func TestTokenInURLAnsweredWithUpdateNote(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	tok := joinHTTP(t, srv, "alice")
	r := call(t, srv, "GET", "/api/slot?token="+tok, "", nil, -1)
	if r.Code != 400 || !strings.Contains(r.Body["error"].(string), "out of date") {
		t.Fatalf("%d %v", r.Code, r.Body)
	}
}

func TestDownloadResumes(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	var gets, ranged atomic.Int32
	h := c.Handler()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/f/") {
			if r.Header.Get("Range") != "" {
				ranged.Add(1)
			}
			if gets.Add(1) == 1 { // the first transfer drops halfway
				data, _ := os.ReadFile(c.path(17))
				w.Header().Set("Content-Length", strconv.Itoa(len(data)))
				w.WriteHeader(200)
				w.Write(data[:len(data)/2])
				w.(http.Flusher).Flush()
				panic(http.ErrAbortHandler)
			}
		}
		h.ServeHTTP(w, r)
	}))
	defer srv.Close()
	s := c.State()
	cl := NewClient(ClientOptions{Coordinator: srv.URL, Workdir: t.TempDir()})
	dst := filepath.Join(t.TempDir(), "head")
	if err := cl.download(context.Background(), srv.URL+"/f/phase2-17", dst, c.headSize, s.HeadSHA256, "head"); err != nil {
		t.Fatal(err)
	}
	if sum, _ := FileSHA256(dst); sum != s.HeadSHA256 || ranged.Load() != 1 {
		t.Fatalf("the download resumes with a range: %s, %d ranged", sum, ranged.Load())
	}
}

func TestOfflineUpload(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	key := c.State().CoordPubKey
	in := filepath.Join(f.dir, "in")
	_ = copyFile(c.path(17), in)
	out := filepath.Join(f.dir, "out")
	hash, err := Contribute(in, out)
	if err != nil {
		t.Fatal(err)
	}
	cl := NewClient(ClientOptions{Coordinator: srv.URL, CoordinatorKey: key, Name: "offline", Poll: 10 * time.Millisecond})
	r, err := cl.UploadFile(context.Background(), in, out)
	cl.Cleanup()
	if err != nil || r.ContributionHash != hash || r.Index != 18 {
		t.Fatalf("offline upload: %v %+v", err, r)
	}
	// once more: the head moved on, but the contribution is already in, so its receipt is returned
	cl = NewClient(ClientOptions{Coordinator: srv.URL, CoordinatorKey: key, Name: "offline", Poll: 10 * time.Millisecond})
	if r2, err := cl.UploadFile(context.Background(), in, out); err != nil || r2.Index != 18 {
		t.Fatalf("again: %v %+v", err, r2)
	}
	// a contribution on an old head is refused before joining
	out2 := filepath.Join(f.dir, "out2")
	Contribute(in, out2)
	cl = NewClient(ClientOptions{Coordinator: srv.URL, CoordinatorKey: key, Name: "late", Poll: 10 * time.Millisecond})
	if _, err := cl.UploadFile(context.Background(), in, out2); err == nil || !strings.Contains(err.Error(), "head is now phase2-18") {
		t.Fatalf("stale: %v", err)
	}
	if len(c.Queue()) != 0 {
		t.Fatal("no place was taken")
	}
}

// Pool machines fill idle time: a person who joins goes ahead of every pool machine that has not claimed its slot, and a
// pool machine that has claimed keeps it.
func TestPoolLaneWaitsBehindPeople(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	c.PerIP = -1
	p1, _, _ := c.JoinLane("0x1111111111111111111111111111111111111111", "", "192.0.2.1", "pool")
	p2, _, _ := c.JoinLane("0x2222222222222222222222222222222222222222", "", "192.0.2.2", "pool")
	if st, _ := c.Poll(p1); st.State != "claim" {
		t.Fatalf("with nobody else waiting, a pool machine gets the slot: %+v", st)
	}
	alice, st, err := c.Join("alice", "", "192.0.2.3")
	if err != nil || st.Ahead != 0 || st.State != "claim" {
		t.Fatalf("a person goes ahead of a pool machine that has not claimed: %+v %v", st, err)
	}
	if st, _ := c.Poll(p1); st.Ahead != 1 || st.State != "waiting" {
		t.Fatalf("the pool machine moves back: %+v", st)
	}
	if _, err := c.Claim(alice); err != nil {
		t.Fatal(err)
	}
	bob, st, _ := c.Join("bob", "", "192.0.2.4")
	if st.Ahead != 1 {
		t.Fatalf("a person waits behind a claimed slot, ahead of the pool: %+v", st)
	}
	if st, _ := c.Poll(p2); st.Ahead != 3 {
		t.Fatalf("pool machines keep their order behind people: %+v", st)
	}
	_ = bob
	if _, _, err := c.JoinLane("x", "", "192.0.2.9", "vip"); err == nil {
		t.Fatal("an unknown lane is refused")
	}
	// a pool machine that claimed keeps its slot when a person joins
	c2 := newFixture(t).chain(t)
	c2.PerIP = -1
	p, _, _ := c2.JoinLane("pool", "", "192.0.2.1", "pool")
	c2.Claim(p)
	if _, st, _ := c2.Join("carol", "", "192.0.2.2"); st.Ahead != 1 {
		t.Fatalf("a claimed pool slot is not taken over: %+v", st)
	}
}

// One address may contribute AcceptedPerIP times over the ceremony; the count survives a restart.
func TestAcceptedPerIPCap(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	c.AcceptedPerIP = 1
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	tok := joinHTTP(t, srv, "alice")
	call(t, srv, "POST", "/api/claim", tok, nil, -1)
	out := filepath.Join(f.dir, "next")
	if _, err := Contribute(c.path(17), out); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(out)
	if r := call(t, srv, "PUT", "/api/upload", tok, bytes.NewReader(data), int64(len(data))); r.Code != 200 {
		t.Fatalf("upload: %d %v", r.Code, r.Body)
	}
	if r := call(t, srv, "POST", "/api/join", "", strings.NewReader(`{"name":"alice again"}`), -1); r.Code != 429 {
		t.Fatalf("a second contribution from the same address is refused: %d", r.Code)
	}
	c2, err := Open(c.Dir)
	if err != nil {
		t.Fatal(err)
	}
	c2.AcceptedPerIP = 1
	if _, _, err := c2.Join("alice", "", "127.0.0.1"); err == nil {
		t.Fatal("the count survives a restart")
	}
	if _, _, err := c2.Join("bob", "", "192.0.2.7"); err != nil {
		t.Fatalf("another address may join: %v", err)
	}
}

// A coordinator short of disk refuses an upload before writing it (503), and the slot is kept.
func TestUploadRefusedWhenDiskShort(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	c.MinFree = 1 << 62
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	tok := joinHTTP(t, srv, "alice")
	call(t, srv, "POST", "/api/claim", tok, nil, -1)
	data, _ := os.ReadFile(c.path(17))
	if r := call(t, srv, "PUT", "/api/upload", tok, bytes.NewReader(data), int64(len(data))); r.Code != 503 {
		t.Fatalf("an upload with the disk short: %d %v", r.Code, r.Body)
	}
	if left := uploadsLeft(t, c.Dir); len(left) != 0 {
		t.Fatalf("nothing written: %v", left)
	}
	if r := call(t, srv, "GET", "/api/slot", tok, nil, -1); r.Code != 200 {
		t.Fatal("the slot is kept")
	}
}
