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
