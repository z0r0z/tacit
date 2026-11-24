package ceremony

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// Receipt of an accepted contribution, signed by the coordinator. A contributor shares it; anyone checks it against the
// published transcript and the files.
type Receipt struct {
	Index            int    `json:"index"`             // the file this contribution produced: phase2-<index>
	Name             string `json:"name"`
	Handle           string `json:"handle"`
	ContributionHash string `json:"contribution_hash"` // SHA-256 of the serialized accumulator (as Succinct's tool prints it)
	FileSHA256       string `json:"file_sha256"`
	PrevFileSHA256   string `json:"prev_file_sha256"`
	At               string `json:"at"`
	Signature        string `json:"signature,omitempty"`
}

func (r Receipt) signedBytes() []byte {
	c := r
	c.Signature = ""
	b, _ := json.Marshal(c)
	return b
}

// State of the chain: the file it continues from, the head, and every receipt.
type State struct {
	Label        string    `json:"label"`
	BaseIndex    int       `json:"base_index"` // the last file of the transcript this chain extends (Succinct's phase2-17)
	BaseSHA256   string    `json:"base_sha256"`
	HeadIndex    int       `json:"head_index"`
	HeadSHA256   string    `json:"head_sha256"`
	CoordPubKey  string    `json:"coordinator_pubkey"`
	Receipts     []Receipt `json:"receipts"`
	Closed       bool      `json:"closed"`
}

type ticket struct {
	Token, Name, Handle string
	Joined, SlotSince   time.Time
}

// Coordinator: one contributor at a time, first come first served; an upload becomes the head only if it verifies
// against the current head.
type Coordinator struct {
	Dir     string
	SlotTTL time.Duration
	mu      sync.Mutex
	state   State
	queue   []*ticket
	key     ed25519.PrivateKey
	now     func() time.Time
}

var nameRe = regexp.MustCompile(`^[\x20-\x7e]{1,64}$`)

func (c *Coordinator) path(i int) string { return filepath.Join(c.Dir, fmt.Sprintf("phase2-%d", i)) }

// Init a chain from a base file (copied into the directory as phase2-<baseIndex>).
func Init(dir, base string, baseIndex int, label string) (*Coordinator, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(dir, "state.json")); err == nil {
		return nil, errors.New("a chain already lives in this directory")
	}
	if _, err := Read(base); err != nil {
		return nil, fmt.Errorf("the base file does not read as a Phase2 accumulator: %w", err)
	}
	c := &Coordinator{Dir: dir}
	dst := c.path(baseIndex)
	if base != dst {
		in, err := os.Open(base)
		if err != nil {
			return nil, err
		}
		out, err := os.Create(dst)
		if err != nil {
			in.Close()
			return nil, err
		}
		_, err = io.Copy(out, in)
		in.Close()
		out.Close()
		if err != nil {
			return nil, err
		}
	}
	sum, err := FileSHA256(dst)
	if err != nil {
		return nil, err
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, "coordinator.key"), priv, 0o600); err != nil {
		return nil, err
	}
	c.key = priv
	c.state = State{Label: label, BaseIndex: baseIndex, BaseSHA256: sum, HeadIndex: baseIndex, HeadSHA256: sum, CoordPubKey: hex.EncodeToString(pub)}
	return c, c.save()
}

// Open an existing chain.
func Open(dir string) (*Coordinator, error) {
	b, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		return nil, err
	}
	c := &Coordinator{Dir: dir}
	if err := json.Unmarshal(b, &c.state); err != nil {
		return nil, err
	}
	k, err := os.ReadFile(filepath.Join(dir, "coordinator.key"))
	if err != nil {
		return nil, err
	}
	c.key = ed25519.PrivateKey(k)
	return c, nil
}

func (c *Coordinator) save() error {
	b, _ := json.MarshalIndent(c.state, "", "  ")
	tmp := filepath.Join(c.Dir, "state.json.tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(c.Dir, "state.json"))
}

func (c *Coordinator) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

func (c *Coordinator) ttl() time.Duration {
	if c.SlotTTL > 0 {
		return c.SlotTTL
	}
	return 90 * time.Minute
}

// expire drops a head-of-queue ticket whose slot ran out, and starts the next one's clock (lock held).
func (c *Coordinator) expire() {
	for len(c.queue) > 0 {
		t := c.queue[0]
		if t.SlotSince.IsZero() {
			t.SlotSince = c.clock()
		}
		if c.clock().Sub(t.SlotSince) < c.ttl() {
			return
		}
		c.queue = c.queue[1:]
	}
}

// Accept verifies an uploaded file against the head and, if it verifies, makes it the head and returns the receipt.
func (c *Coordinator) Accept(upload, name, handle string) (*Receipt, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state.Closed {
		return nil, errors.New("the ceremony is closed")
	}
	prev, err := Read(c.path(c.state.HeadIndex))
	if err != nil {
		return nil, err
	}
	next, err := Read(upload)
	if err != nil {
		return nil, fmt.Errorf("the upload does not read as a Phase2 accumulator: %w", err)
	}
	if err := Verify(prev, next); err != nil {
		return nil, fmt.Errorf("the contribution does not verify against the head: %w", err)
	}
	hash, err := Hash(next)
	if err != nil {
		return nil, err
	}
	idx := c.state.HeadIndex + 1
	if err := os.Rename(upload, c.path(idx)); err != nil {
		return nil, err
	}
	sum, err := FileSHA256(c.path(idx))
	if err != nil {
		return nil, err
	}
	r := Receipt{Index: idx, Name: name, Handle: handle, ContributionHash: hash, FileSHA256: sum, PrevFileSHA256: c.state.HeadSHA256, At: c.clock().UTC().Format(time.RFC3339)}
	r.Signature = hex.EncodeToString(ed25519.Sign(c.key, r.signedBytes()))
	c.state.Receipts = append(c.state.Receipts, r)
	c.state.HeadIndex, c.state.HeadSHA256 = idx, sum
	return &r, c.save()
}

// VerifyReceipt checks a receipt's signature against a coordinator public key (hex).
func VerifyReceipt(r Receipt, pubHex string) bool {
	pub, err := hex.DecodeString(pubHex)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return false
	}
	sig, err := hex.DecodeString(r.Signature)
	if err != nil {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(pub), r.signedBytes(), sig)
}

func (c *Coordinator) State() State {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state
}

// Close the chain (no more contributions; the beacon comes next).
func (c *Coordinator) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.state.Closed = true
	return c.save()
}

// ── HTTP ──

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

var fileRe = regexp.MustCompile(`^phase2-\d+$`)

// Handler serves the ceremony API:
//
//	GET  /api/head                      the head: index, sha256, file url
//	GET  /f/phase2-<n>                  a file of the chain
//	POST /api/join   {name, handle}     a place in the queue -> {token}
//	GET  /api/slot?token=               {yours, ahead, expires}
//	PUT  /api/upload?token=             the contribution (only in your slot) -> the receipt, or why it was refused
//	GET  /api/transcript                the state: base, head, receipts, coordinator key
func (c *Coordinator) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/head", func(w http.ResponseWriter, r *http.Request) {
		s := c.State()
		writeJSON(w, 200, map[string]any{"index": s.HeadIndex, "sha256": s.HeadSHA256, "url": fmt.Sprintf("/f/phase2-%d", s.HeadIndex), "closed": s.Closed})
	})
	mux.HandleFunc("GET /f/{name}", func(w http.ResponseWriter, r *http.Request) {
		n := r.PathValue("name")
		if !fileRe.MatchString(n) {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(c.Dir, n))
	})
	mux.HandleFunc("POST /api/join", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Name, Handle string }
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil || !nameRe.MatchString(body.Name) || (body.Handle != "" && !nameRe.MatchString(body.Handle)) {
			writeJSON(w, 400, map[string]string{"error": "a name of 1 to 64 printable characters"})
			return
		}
		b := make([]byte, 16)
		_, _ = rand.Read(b)
		t := &ticket{Token: hex.EncodeToString(b), Name: body.Name, Handle: body.Handle, Joined: c.clock()}
		c.mu.Lock()
		c.expire()
		c.queue = append(c.queue, t)
		ahead := len(c.queue) - 1
		c.mu.Unlock()
		writeJSON(w, 200, map[string]any{"token": t.Token, "ahead": ahead})
	})
	mux.HandleFunc("GET /api/slot", func(w http.ResponseWriter, r *http.Request) {
		tok := r.URL.Query().Get("token")
		c.mu.Lock()
		defer c.mu.Unlock()
		c.expire()
		for i, t := range c.queue {
			if t.Token == tok {
				resp := map[string]any{"yours": i == 0, "ahead": i}
				if i == 0 {
					resp["expires"] = t.SlotSince.Add(c.ttl()).UTC().Format(time.RFC3339)
				}
				writeJSON(w, 200, resp)
				return
			}
		}
		writeJSON(w, 404, map[string]string{"error": "no such place in the queue (it may have run out)"})
	})
	mux.HandleFunc("PUT /api/upload", func(w http.ResponseWriter, r *http.Request) {
		tok := r.URL.Query().Get("token")
		c.mu.Lock()
		c.expire()
		var t *ticket
		if len(c.queue) > 0 && c.queue[0].Token == tok {
			t = c.queue[0]
		}
		c.mu.Unlock()
		if t == nil {
			writeJSON(w, 409, map[string]string{"error": "it is not your turn (or your slot ran out)"})
			return
		}
		f, err := os.CreateTemp(c.Dir, "upload-*")
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		_, err = io.Copy(f, io.LimitReader(r.Body, 8<<30))
		f.Close()
		if err != nil {
			os.Remove(f.Name())
			writeJSON(w, 400, map[string]string{"error": "the upload did not complete"})
			return
		}
		rc, err := c.Accept(f.Name(), t.Name, t.Handle)
		if err != nil {
			os.Remove(f.Name())
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		c.mu.Lock()
		if len(c.queue) > 0 && c.queue[0] == t {
			c.queue = c.queue[1:]
		}
		c.mu.Unlock()
		writeJSON(w, 200, rc)
	})
	mux.HandleFunc("GET /api/transcript", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, c.State()) })
	return mux
}
