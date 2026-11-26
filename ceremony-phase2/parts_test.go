package ceremony

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func putPart(t *testing.T, srv *httptest.Server, tok string, off int, b []byte) apiResp {
	return call(t, srv, "PUT", "/api/upload-part?offset="+strconv.Itoa(off), tok, bytes.NewReader(b), int64(len(b)))
}

func waitResult(t *testing.T, srv *httptest.Server, tok string) apiResp {
	t.Helper()
	for i := 0; i < 600; i++ {
		r := call(t, srv, "GET", "/api/upload-result", tok, nil, -1)
		if s := r.Body["state"]; s != "verifying" {
			return r
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the check never finished")
	return apiResp{}
}

// A contribution sent in parts: resumed after a failed part, refused when a part starts in the wrong place, checked on
// finish exactly like an upload, and the old PUT /api/upload still works beside it.
// A one-byte part must not freeze the slot rules: an upload that has not moved 64 MiB within ten minutes is dropped; one that has is kept to the cap.
func TestTrickleUploadIsDropped(t *testing.T) {
	oldB := floorBytes
	floorBytes = 100
	defer func() { floorBytes = oldB }()
	f := newFixture(t)
	c := f.chain(t)
	clk := withClock(c)
	c.PerIP = -1
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	in := filepath.Join(f.dir, "in")
	_ = copyFile(c.path(17), in)
	out := filepath.Join(f.dir, "out")
	if _, err := Contribute(in, out); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(out)
	pollFor := func(tok string, d time.Duration) error {
		for el := time.Duration(0); el < d; el += 30 * time.Second {
			clk.add(30 * time.Second)
			if _, err := c.Poll(tok); err != nil {
				return err
			}
		}
		return nil
	}
	slow := joinHTTP(t, srv, "trickle")
	call(t, srv, "POST", "/api/claim", slow, nil, -1)
	if r := putPart(t, srv, slow, 0, data[:1]); r.Code != 200 {
		t.Fatalf("a part: %d %v", r.Code, r.Body)
	}
	if err := pollFor(slow, floorWindow-time.Minute); err != nil {
		t.Fatalf("a slot is not dropped inside the window: %v", err)
	}
	if err := pollFor(slow, 2*time.Minute); err == nil {
		t.Fatal("a slot whose upload has moved a byte in ten minutes is dropped")
	}
	// a second holder that moved enough keeps the slot
	fast := joinHTTP(t, srv, "steady")
	call(t, srv, "POST", "/api/claim", fast, nil, -1)
	if r := putPart(t, srv, fast, 0, data[:200]); r.Code != 200 {
		t.Fatalf("a part: %d %v", r.Code, r.Body)
	}
	if err := pollFor(fast, 30*time.Minute); err != nil {
		t.Fatalf("a slot whose upload is moving is kept: %v", err)
	}
}

// A chunked upload that at its pace cannot finish inside the slot is dropped once its pace is known; one that will finish is kept.
func TestUploadThatCannotFinishIsDropped(t *testing.T) {
	oldB := floorBytes
	floorBytes = 10
	defer func() { floorBytes = oldB }()
	f := newFixture(t)
	c := f.chain(t)
	clk := withClock(c)
	c.PerIP = -1
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	in := filepath.Join(f.dir, "in")
	_ = copyFile(c.path(17), in)
	out := filepath.Join(f.dir, "out")
	if _, err := Contribute(in, out); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(out)
	pollFor := func(tok string, d time.Duration) error {
		for el := time.Duration(0); el < d; el += 30 * time.Second {
			clk.add(30 * time.Second)
			if _, err := c.Poll(tok); err != nil {
				return err
			}
		}
		return nil
	}
	// a twentieth of the file in the first minutes: the whole would take over five hours
	slow := joinHTTP(t, srv, "slow")
	call(t, srv, "POST", "/api/claim", slow, nil, -1)
	if r := putPart(t, srv, slow, 0, data[:len(data)/20]); r.Code != 200 {
		t.Fatalf("a part: %d %v", r.Code, r.Body)
	}
	if err := pollFor(slow, paceWindow-time.Minute); err != nil {
		t.Fatalf("its pace is not judged before it has one: %v", err)
	}
	if err := pollFor(slow, 2*time.Minute); err == nil {
		t.Fatal("an upload that would end past the slot's cap is dropped once its pace is known")
	}
	// half the file in the same time: it will finish in about half an hour, so it is kept
	steady := joinHTTP(t, srv, "steady")
	call(t, srv, "POST", "/api/claim", steady, nil, -1)
	if r := putPart(t, srv, steady, 0, data[:len(data)/2]); r.Code != 200 {
		t.Fatalf("a part: %d %v", r.Code, r.Body)
	}
	if err := pollFor(steady, 40*time.Minute); err != nil {
		t.Fatalf("an upload that will finish inside the slot is kept: %v", err)
	}
	// and one that is slow but will still just make it is kept too: a fifth in a quarter hour is an hour and a quarter in all
	call(t, srv, "DELETE", "/api/leave", steady, nil, -1)
	late := joinHTTP(t, srv, "late")
	call(t, srv, "POST", "/api/claim", late, nil, -1)
	if r := putPart(t, srv, late, 0, data[:len(data)/5]); r.Code != 200 {
		t.Fatalf("a part: %d %v", r.Code, r.Body)
	}
	if err := pollFor(late, paceWindow+5*time.Minute); err != nil {
		t.Fatalf("a slow upload that will still make the slot is kept: %v", err)
	}
}

// A single-request upload that trickles is cut once it is clearly too slow, and one that moves is not.
func TestFloorReader(t *testing.T) {
	oldW, oldB := floorWindow, floorBytes
	floorWindow, floorBytes = 40*time.Millisecond, 10
	defer func() { floorWindow, floorBytes = oldW, oldB }()
	slow := &floorReader{r: bytes.NewReader(make([]byte, 100)), t0: time.Now()}
	buf := make([]byte, 1)
	slow.Read(buf)
	time.Sleep(60 * time.Millisecond)
	if _, err := slow.Read(buf); err != errTooSlow {
		t.Fatalf("a body that moved one byte in the window is cut: %v", err)
	}
	ok := &floorReader{r: bytes.NewReader(make([]byte, 100)), t0: time.Now()}
	ok.Read(make([]byte, 50))
	time.Sleep(60 * time.Millisecond)
	if _, err := ok.Read(buf); err != nil {
		t.Fatalf("a body that moved enough is not: %v", err)
	}
}

// A single-request upload that is moving but would end past the slot is cut once its pace is known; one that will finish in time is not.
func TestFloorReaderPace(t *testing.T) {
	oldW, oldB, oldP := floorWindow, floorBytes, paceWindow
	floorWindow, floorBytes, paceWindow = time.Hour, 1, 40*time.Millisecond
	defer func() { floorWindow, floorBytes, paceWindow = oldW, oldB, oldP }()
	buf := make([]byte, 1)
	slow := &floorReader{r: bytes.NewReader(make([]byte, 1000)), t0: time.Now(), size: 1000, limit: time.Now().Add(150 * time.Millisecond)}
	slow.Read(make([]byte, 10))
	time.Sleep(60 * time.Millisecond)
	if _, err := slow.Read(buf); err != errTooSlow {
		t.Fatalf("a body that would end far past the limit is cut: %v", err)
	}
	ok := &floorReader{r: bytes.NewReader(make([]byte, 1000)), t0: time.Now(), size: 1000, limit: time.Now().Add(time.Second)}
	ok.Read(make([]byte, 500))
	time.Sleep(60 * time.Millisecond)
	if _, err := ok.Read(buf); err != nil {
		t.Fatalf("a body that will end in time is not: %v", err)
	}
}

// Parts no claimed place owns are removed at start-up; the holder's are kept.
func TestStartupRemovesStrayParts(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	clk := withClock(c)
	c.PerIP = -1
	a, _, _ := c.Join("alice", "", "192.0.2.1")
	c.Claim(a)
	mine := c.partPath(a)
	stray := filepath.Join(c.Dir, "part-deadbeefdeadbeef")
	os.WriteFile(mine, []byte("x"), 0o600)
	os.WriteFile(stray, []byte("y"), 0o600)
	if _, err := open(c.Dir, clk.now); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(mine); err != nil {
		t.Fatal("the holder's parts are kept")
	}
	if _, err := os.Stat(stray); !os.IsNotExist(err) {
		t.Fatal("a stray part is removed")
	}
}

// A part cut off by a dropped connection or a restart leaves bytes past the confirmed end; the next part from the confirmed end replaces them.
func TestPartReplacesAnUnconfirmedTail(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	c.PerIP = -1
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	in := filepath.Join(f.dir, "in")
	_ = copyFile(c.path(17), in)
	out := filepath.Join(f.dir, "out")
	hash, err := Contribute(in, out)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(out)
	tok := joinHTTP(t, srv, "restart")
	call(t, srv, "POST", "/api/claim", tok, nil, -1)
	cut := len(data) / 2
	if r := putPart(t, srv, tok, 0, data[:cut]); r.Code != 200 {
		t.Fatalf("first part: %d %v", r.Code, r.Body)
	}
	// a stray tail past what the client has confirmed (as a cut-off part would leave)
	p := c.partPath(tok)
	fh, _ := os.OpenFile(p, os.O_WRONLY|os.O_APPEND, 0)
	fh.Write([]byte("partial bytes of a part that did not finish"))
	fh.Close()
	if r := putPart(t, srv, tok, cut, data[cut:]); r.Code != 200 || r.Body["have"].(float64) != float64(len(data)) {
		t.Fatalf("the part from the confirmed end: %d %v", r.Code, r.Body)
	}
	if got, _ := os.ReadFile(p); !bytes.Equal(got, data) {
		t.Fatal("the stored file is not the contribution")
	}
	if r := call(t, srv, "POST", "/api/upload-finish", tok, nil, -1); r.Code != 202 {
		t.Fatalf("finish: %d %v", r.Code, r.Body)
	}
	if r := waitResult(t, srv, tok); r.Body["state"] != "done" || r.Body["receipt"].(map[string]any)["contribution_hash"] != hash {
		t.Fatalf("result: %v", r.Body)
	}
}

func TestUploadInParts(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	c.PerIP = -1
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	in := filepath.Join(f.dir, "in")
	_ = copyFile(c.path(17), in)
	out := filepath.Join(f.dir, "out")
	hash, err := Contribute(in, out)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(out)

	tok := joinHTTP(t, srv, "browser")
	stranger := joinHTTP(t, srv, "stranger")
	if r := putPart(t, srv, tok, 0, data[:10]); r.Code != 409 {
		t.Fatalf("a part before the claim: %d", r.Code)
	}
	if r := call(t, srv, "POST", "/api/claim", tok, nil, -1); r.Code != 200 {
		t.Fatalf("claim: %d %v", r.Code, r.Body)
	}
	if r := putPart(t, srv, stranger, 0, data[:10]); r.Code != 409 {
		t.Fatalf("a place that is not at the head: %d", r.Code)
	}
	if r := call(t, srv, "POST", "/api/upload-finish", tok, nil, -1); r.Code != 400 {
		t.Fatalf("finish with nothing stored: %d %v", r.Code, r.Body)
	}
	cut := len(data) / 3
	if r := putPart(t, srv, tok, 0, data[:cut]); r.Code != 200 || r.Body["have"].(float64) != float64(cut) {
		t.Fatalf("first part: %d %v", r.Code, r.Body)
	}
	if r := putPart(t, srv, tok, cut+5, data[cut+5:cut+9]); r.Code != 409 || r.Body["have"].(float64) != float64(cut) {
		t.Fatalf("a gap: %d %v", r.Code, r.Body)
	}
	if r := call(t, srv, "GET", "/api/upload-part", tok, nil, -1); r.Code != 200 || r.Body["have"].(float64) != float64(cut) {
		t.Fatalf("resume point: %d %v", r.Code, r.Body)
	}
	if r := putPart(t, srv, tok, cut, append(append([]byte{}, data[cut:]...), 0)); r.Code != 400 {
		t.Fatalf("past the end: %d", r.Code)
	}
	if r := call(t, srv, "POST", "/api/upload-finish", tok, nil, -1); r.Code != 400 {
		t.Fatalf("finish with part of it: %d", r.Code)
	}
	if r := putPart(t, srv, tok, cut, data[cut:]); r.Code != 200 || r.Body["have"].(float64) != float64(len(data)) {
		t.Fatalf("rest: %d %v", r.Code, r.Body)
	}
	if r := call(t, srv, "POST", "/api/upload-finish", stranger, nil, -1); r.Code != 409 {
		t.Fatalf("finish by another place: %d", r.Code)
	}
	if r := call(t, srv, "POST", "/api/upload-finish", tok, nil, -1); r.Code != 202 {
		t.Fatalf("finish: %d %v", r.Code, r.Body)
	}
	r := waitResult(t, srv, tok)
	rc, _ := r.Body["receipt"].(map[string]any)
	if r.Body["state"] != "done" || rc == nil || rc["contribution_hash"] != hash || rc["index"].(float64) != 18 {
		t.Fatalf("result: %v", r.Body)
	}
	if m, _ := filepath.Glob(filepath.Join(f.dir, "part-*")); len(m) != 0 {
		t.Fatalf("parts left behind: %v", m)
	}
	if s := c.State(); s.HeadIndex != 18 || len(s.Receipts) == 0 {
		t.Fatalf("head did not move: %d", s.HeadIndex)
	}

	// a bad file of the right size is refused and counted like a bad upload
	call(t, srv, "DELETE", "/api/leave", stranger, nil, -1)
	tok2 := joinHTTP(t, srv, "junk")
	if r := call(t, srv, "POST", "/api/claim", tok2, nil, -1); r.Code != 200 {
		t.Fatalf("claim 2: %d %v", r.Code, r.Body)
	}
	junk, _ := os.ReadFile(c.path(18))
	junk[len(junk)/2] ^= 0xff
	if r := putPart(t, srv, tok2, 0, junk); r.Code != 200 {
		t.Fatalf("junk part: %d %v", r.Code, r.Body)
	}
	if r := call(t, srv, "POST", "/api/upload-finish", tok2, nil, -1); r.Code != 202 {
		t.Fatalf("junk finish: %d %v", r.Code, r.Body)
	}
	if r := waitResult(t, srv, tok2); r.Body["state"] != "refused" || r.Body["code"].(float64) != 400 {
		t.Fatalf("junk: %v", r.Body)
	}
	if m, _ := filepath.Glob(filepath.Join(f.dir, "part-*")); len(m) != 0 {
		t.Fatalf("junk part left behind: %v", m)
	}
}

// Two parts at the same offset, both started before either wrote a byte, could both pass the offset check; the second
// then wrote into the file after it was checked (or into the head it became). One part at a time, and no check while
// a part is still arriving.
func TestOnePartAtATime(t *testing.T) {
	f := newFixture(t)
	c := f.chain(t)
	c.PerIP = -1
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	in := filepath.Join(f.dir, "in")
	_ = copyFile(c.path(17), in)
	out := filepath.Join(f.dir, "out")
	if _, err := Contribute(in, out); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(out)
	tok := joinHTTP(t, srv, "browser")
	if r := call(t, srv, "POST", "/api/claim", tok, nil, -1); r.Code != 200 {
		t.Fatalf("claim: %d", r.Code)
	}
	cut := len(data) - 8
	if r := putPart(t, srv, tok, 0, data[:cut]); r.Code != 200 {
		t.Fatalf("first part: %d %v", r.Code, r.Body)
	}
	// part A opens and stalls before its body
	pr, pw := io.Pipe()
	req, _ := http.NewRequest("PUT", srv.URL+"/api/upload-part?offset="+strconv.Itoa(cut), pr)
	req.ContentLength = 8
	req.Header.Set(TokenHeader, tok)
	done := make(chan struct{})
	go func() {
		defer close(done)
		if resp, err := http.DefaultClient.Do(req); err == nil {
			resp.Body.Close()
		}
	}()
	time.Sleep(300 * time.Millisecond)
	if r := putPart(t, srv, tok, cut, data[cut:]); r.Code != 409 {
		t.Fatalf("a second part while one is arriving: %d %v", r.Code, r.Body)
	}
	if r := call(t, srv, "POST", "/api/upload-finish", tok, nil, -1); r.Code != 409 {
		t.Fatalf("finish while a part is arriving: %d %v", r.Code, r.Body)
	}
	_, _ = pw.Write(data[cut:])
	pw.Close()
	<-done
	if r := call(t, srv, "POST", "/api/upload-finish", tok, nil, -1); r.Code != 202 {
		t.Fatalf("finish after it ended: %d %v", r.Code, r.Body)
	}
	if r := waitResult(t, srv, tok); r.Body["state"] != "done" {
		t.Fatalf("result: %v", r.Body)
	}
}
