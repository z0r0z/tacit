package ceremony

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
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
	clk := &fakeClock{t: time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)}
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
	// the slot ends while the upload is being checked: refused, the head stays
	c.beforeCommit = func() { clk.add(time.Hour + time.Second) }
	r := call(t, srv, "PUT", "/api/upload", tok, bytes.NewReader(data), int64(len(data)))
	if r.Code != 409 || c.State().HeadIndex != 17 {
		t.Fatalf("an upload that finishes after the slot ended is refused: %d %v (head %d)", r.Code, r.Body, c.State().HeadIndex)
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
	// dave claims; polls keep the claimed slot until its cap
	if _, err := c.Claim(d); err != nil {
		t.Fatal(err)
	}
	for el := time.Duration(0); el < 2*time.Hour-time.Minute; el += 30 * time.Second {
		clk.add(30 * time.Second)
		if _, err := c.Poll(d); err != nil {
			t.Fatalf("a polling slot is kept (%s in): %v", el, err)
		}
	}
	clk.add(2 * time.Minute)
	if _, err := c.Poll(d); err == nil {
		t.Fatal("a slot past its cap is dropped")
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
	waitFor(t, func() bool { return len(c.Queue()) == 3 })
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
