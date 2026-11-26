package ceremony

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"time"
)

// Receipt of an accepted contribution, signed by the coordinator. A contributor shares it; anyone checks it against the
// published transcript and the files.
type Receipt struct {
	Index            int    `json:"index"` // the file this contribution produced: phase2-<index>
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
	Label       string    `json:"label"`
	BaseIndex   int       `json:"base_index"` // the last file of the transcript this chain extends (Succinct's phase2-17)
	BaseSHA256  string    `json:"base_sha256"`
	HeadIndex   int       `json:"head_index"`
	HeadSHA256  string    `json:"head_sha256"`
	CoordPubKey string    `json:"coordinator_pubkey"`
	Receipts    []Receipt `json:"receipts"`
	Closed      bool      `json:"closed"`
}

// Config of the queue. Zero values take the defaults below.
type Config struct {
	Heartbeat   time.Duration // a place is dropped when its client has not polled for this long (60 s)
	ClaimWindow time.Duration // at the head, the time to claim the slot (3 min)
	SlotCap     time.Duration // from the claim, the time to download, contribute and upload (2 h)
	QueueCap    int           // places in the queue (100)
	PerIP       int           // places one client address may hold (1; negative: no limit)
	// PerNet24 and PerNet16: places one network may hold at once, an IPv4 /24 or /16 (an IPv6 /40 or /32); 0: no limit. One person with many
	// addresses in one network, or one party filling the queue from a block, cannot crowd everyone else out.
	PerNet24, PerNet16 int
	// A claimed slot must show progress, so a place cannot be held by polling alone: from the claim, the head's
	// download must start within DownloadStart (10 min) and be complete within DownloadBy (75 min), and the upload must
	// start within UploadStart (105 min). An offline contributor, who uploads without downloading, starts the upload
	// within DownloadStart.
	DownloadStart time.Duration
	DownloadBy    time.Duration
	UploadStart   time.Duration
	MaxRefused    int   // uploads refused as contributions before the slot is given up (2)
	MinFree       int64 // bytes the chain's disk must keep free beyond an upload (1 GiB)
	FilesPerIP    int   // concurrent file downloads per client address (2); the slot holder's are not limited
	FilesTotal    int   // concurrent file downloads in all (24)
	// AcceptedPerIP: contributions accepted from one client address (an IPv6 /48) over the whole ceremony, after which it
	// may not join again (0: no limit). Kept in accepted.json, never published.
	AcceptedPerIP int
	// The client's address is the socket's unless the connection comes from one of TrustedProxies, in which case it is
	// the last address in ClientIPHeader (e.g. X-Forwarded-For).
	ClientIPHeader string
	TrustedProxies []netip.Prefix
	Logf           func(format string, a ...any)
}

func (c Config) heartbeat() time.Duration { return orDur(c.Heartbeat, 60*time.Second) }
func (c Config) claimWindow() time.Duration {
	return orDur(c.ClaimWindow, 3*time.Minute)
}
func (c Config) slotCap() time.Duration { return orDur(c.SlotCap, 2*time.Hour) }
func (c Config) queueCap() int {
	if c.QueueCap > 0 {
		return c.QueueCap
	}
	return 100
}
func (c Config) perIP() int {
	if c.PerIP == 0 {
		return 1
	}
	return c.PerIP
}

func (c Config) downloadStart() time.Duration { return orDur(c.DownloadStart, 10*time.Minute) }
func (c Config) downloadBy() time.Duration    { return orDur(c.DownloadBy, 75*time.Minute) }
func (c Config) uploadStart() time.Duration   { return orDur(c.UploadStart, 105*time.Minute) }
func (c Config) maxRefused() int              { return orInt(c.MaxRefused, 2) }
func (c Config) filesPerIP() int              { return orInt(c.FilesPerIP, 2) }
func (c Config) filesTotal() int              { return orInt(c.FilesTotal, 24) }
func (c Config) minFree() int64 {
	if c.MinFree > 0 {
		return c.MinFree
	}
	return 1 << 30
}

// the check of an upload is bounded too: past the slot's cap it may run this much longer
const verifyGrace = 30 * time.Minute

func orInt(v, def int) int {
	if v > 0 {
		return v
	}
	return def
}

func orDur(d, def time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return def
}

// a place in the queue; persisted in queue.json (the poll time and the upload flag live in memory only)
type ticket struct {
	Token     string    `json:"token"`
	Name      string    `json:"name"`
	Handle    string    `json:"handle,omitempty"`
	IP        string    `json:"ip"`
	Joined    time.Time `json:"joined"`
	HeadSince time.Time `json:"head_since,omitzero"`
	Claimed   time.Time `json:"claimed,omitzero"`
	// Lane "pool": a machine of the prover pool that contributes when idle; it waits behind every person in the queue.
	Lane      string `json:"lane,omitempty"`
	lastSeen  time.Time
	partBusy  bool // a part of a chunked upload is arriving (parts.go)
	uploading bool // the upload's body is arriving
	verifying bool // the whole body arrived and is being checked: the slot's cap waits (up to verifyGrace)
	// progress of a claimed slot (restored as done after a restart, so a restart never drops a slot)
	served        int64 // bytes of the head sent to this slot's token
	uploadStarted bool
	uploadFirst   time.Time // when the first part of a chunked upload arrived
	partBytes     int64     // bytes of the chunked upload stored and confirmed
	refused       int
}

// Coordinator: one contributor at a time, first come first served; an upload becomes the head only if it verifies
// against the current head.
type Coordinator struct {
	Dir string
	Config
	mu        sync.Mutex
	state     State
	headSize  int64
	queue     []*ticket
	bans      []netip.Prefix
	accepted  map[string]int // contributions accepted per client address key (accepted.json)
	key       ed25519.PrivateKey
	finishRes map[string]*finishResult // the outcome of a finish call, by token (parts.go)
	verifyMu  sync.Mutex               // one check of a contribution at a time (each holds several GB)
	files     fileLimiter
	now       func() time.Time
	// tests: runs after an upload is verified and before it is committed
	beforeCommit func()
}

var nameRe = regexp.MustCompile(`^[\x20-\x7e]{1,64}$`)

func (c *Coordinator) path(i int) string { return filepath.Join(c.Dir, fmt.Sprintf("phase2-%d", i)) }

func (c *Coordinator) logf(f string, a ...any) {
	if c.Logf != nil {
		c.Logf(f, a...)
		return
	}
	log.Printf(f, a...)
}

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
		if err := copyFile(base, dst); err != nil {
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
	if err := writeFileSync(filepath.Join(dir, "coordinator.key"), priv, 0o600); err != nil {
		return nil, err
	}
	c.key = priv
	st := State{Label: label, BaseIndex: baseIndex, BaseSHA256: sum, HeadIndex: baseIndex, HeadSHA256: sum, CoordPubKey: hex.EncodeToString(pub)}
	if err := c.saveState(st); err != nil {
		return nil, err
	}
	c.state = st
	return c, c.loadHeadSize()
}

// Open an existing chain, and its queue if one was saved. Every place gets a fresh poll window; a head that had not
// claimed its slot gets a fresh claim window; a claimed slot keeps its time.
func Open(dir string) (*Coordinator, error) { return open(dir, nil) }

func open(dir string, now func() time.Time) (*Coordinator, error) {
	b, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		return nil, err
	}
	c := &Coordinator{Dir: dir, now: now}
	if err := json.Unmarshal(b, &c.state); err != nil {
		return nil, err
	}
	k, err := os.ReadFile(filepath.Join(dir, "coordinator.key"))
	if err != nil {
		return nil, err
	}
	if len(k) != ed25519.PrivateKeySize {
		return nil, errors.New("coordinator.key is not an ed25519 private key")
	}
	c.key = ed25519.PrivateKey(k)
	if hex.EncodeToString(c.key.Public().(ed25519.PublicKey)) != c.state.CoordPubKey {
		return nil, errors.New("coordinator.key does not match the key in state.json")
	}
	if err := c.loadHeadSize(); err != nil {
		return nil, err
	}
	q, err := os.ReadFile(filepath.Join(dir, "queue.json"))
	if err == nil {
		var saved struct {
			Tickets []*ticket `json:"tickets"`
		}
		if err := json.Unmarshal(q, &saved); err != nil {
			return nil, fmt.Errorf("queue.json: %w", err)
		}
		now := c.clock()
		for i, t := range saved.Tickets {
			t.lastSeen = now
			if i == 0 && t.Claimed.IsZero() {
				t.HeadSince = now
			}
			if !t.Claimed.IsZero() {
				t.served, t.uploadStarted = c.headSize, true // a restart never costs a slot its progress
			}
		}
		c.queue = saved.Tickets
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if b, err := os.ReadFile(filepath.Join(dir, "bans.json")); err == nil {
		if err := json.Unmarshal(b, &c.bans); err != nil {
			return nil, fmt.Errorf("bans.json: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if b, err := os.ReadFile(filepath.Join(dir, "accepted.json")); err == nil {
		if err := json.Unmarshal(b, &c.accepted); err != nil {
			return nil, fmt.Errorf("accepted.json: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	// parts of a chunked upload that no claimed place owns (the holder's are kept: its client carries on from them)
	keep := map[string]bool{}
	for _, t := range c.queue {
		if !t.Claimed.IsZero() {
			keep[c.partPath(t.Token)] = true
		}
	}
	if old, _ := filepath.Glob(filepath.Join(dir, "part-*")); len(old) > 0 {
		n := 0
		for _, p := range old {
			if !keep[p] {
				os.Remove(p)
				n++
			}
		}
		if n > 0 {
			c.logf("removed %d stray part file(s)", n)
		}
	}
	// uploads cut off by a crash or a restart
	if old, _ := filepath.Glob(filepath.Join(dir, "upload-*")); len(old) > 0 {
		for _, p := range old {
			os.Remove(p)
		}
		c.logf("removed %d unfinished upload(s)", len(old))
	}
	return c, nil
}

func (c *Coordinator) loadHeadSize() error {
	st, err := os.Stat(c.path(c.state.HeadIndex))
	if err != nil {
		return fmt.Errorf("the head file: %w", err)
	}
	c.headSize = st.Size()
	return nil
}

func (c *Coordinator) saveState(s State) error {
	b, _ := json.MarshalIndent(s, "", "  ")
	return writeFileAtomic(filepath.Join(c.Dir, "state.json"), b, 0o644)
}

func (c *Coordinator) saveQueueL() {
	b, _ := json.MarshalIndent(struct {
		Tickets []*ticket `json:"tickets"`
	}{c.queue}, "", "  ")
	if err := writeFileAtomic(filepath.Join(c.Dir, "queue.json"), b, 0o600); err != nil {
		c.logf("queue: could not save queue.json: %v", err)
	}
}

func (c *Coordinator) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

func short(tok string) string {
	if len(tok) > 8 {
		return tok[:8]
	}
	return tok
}

// expireL drops places whose client stopped polling, a head that did not claim in time, and a slot past its cap; it
// starts the claim window of each new head (lock held).
func (c *Coordinator) expireL() {
	now := c.clock()
	changed := false
	kept := c.queue[:0]
	for _, t := range c.queue {
		if !t.uploading && now.Sub(t.lastSeen) > c.heartbeat() {
			c.logf("queue: %s (%s) left: no poll for %s", short(t.Token), t.Name, now.Sub(t.lastSeen).Round(time.Second))
			changed = true
			continue
		}
		kept = append(kept, t)
	}
	c.queue = kept
	for len(c.queue) > 0 {
		t := c.queue[0]
		if t.HeadSince.IsZero() {
			t.HeadSince = now
			changed = true
		}
		if why := c.slotOverL(t, now); why != "" {
			c.logf("queue: %s (%s) left: %s", short(t.Token), t.Name, why)
		} else {
			break
		}
		c.queue = c.queue[1:]
		changed = true
	}
	if changed {
		c.saveQueueL()
	}
}

// slotOverL: why the head's place ends now, or "" (lock held).
func (c *Coordinator) slotOverL(t *ticket, now time.Time) string {
	if t.Claimed.IsZero() {
		if now.Sub(t.HeadSince) > c.claimWindow() {
			return fmt.Sprintf("slot not claimed in %s", c.claimWindow())
		}
		return ""
	}
	in := now.Sub(t.Claimed)
	switch {
	case t.verifying:
		if in > c.slotCap()+verifyGrace {
			return "the check of the upload ran past the slot's cap"
		}
	case in > c.slotCap():
		return fmt.Sprintf("slot ran past %s", c.slotCap())
	case t.uploadStarted && !t.uploading && !t.uploadFirst.IsZero() && now.Sub(t.uploadFirst) > floorWindow && t.partBytes < floorBytes:
		return "the upload is too slow to finish inside the slot"
	case c.cannotFinishL(t, now):
		return "at its pace the upload cannot finish inside the slot"
	case t.uploadStarted || t.uploading:
	case t.served == 0 && in > c.downloadStart():
		return fmt.Sprintf("the head's download did not start within %s", c.downloadStart())
	case t.served < c.headSize/4 && in > downloadFloorAfter:
		return fmt.Sprintf("less than a quarter of the head was downloaded in %s", downloadFloorAfter)
	case t.served < c.headSize && in > c.downloadBy():
		return fmt.Sprintf("the head's download was not complete within %s", c.downloadBy())
	case in > c.uploadStart():
		return fmt.Sprintf("the upload did not start within %s", c.uploadStart())
	}
	return ""
}

// cannotFinishL: a chunked upload that, at the pace it has kept so far, would end well past the slot's cap. It is judged only once it has run
// long enough to have a pace (paceWindow), and only when the projected end is clearly past the cap (by an eighth of it), so a slow machine
// that will make it is kept and one that never could does not hold the line for the whole slot.
func (c *Coordinator) cannotFinishL(t *ticket, now time.Time) bool {
	if t.uploadFirst.IsZero() || t.uploading || t.verifying || t.partBytes <= 0 || t.partBytes >= c.headSize {
		return false
	}
	ran := now.Sub(t.uploadFirst)
	if ran < paceWindow {
		return false
	}
	end := t.uploadFirst.Add(time.Duration(float64(ran) * float64(c.headSize) / float64(t.partBytes)))
	return end.After(t.Claimed.Add(c.slotCap() + c.slotCap()/8))
}

// netKey: the network of an address, its first bits4 bits (IPv4) or bits6 bits (IPv6) as a prefix.
func netKey(ip string, bits4, bits6 int) string {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	a = a.Unmap()
	bits := bits6
	if a.Is4() {
		bits = bits4
	}
	p, err := a.Prefix(bits)
	if err != nil {
		return ip
	}
	return p.String()
}

// TrimNetworks drops the places beyond PerNet24 and PerNet16 from one network, keeping the earliest in the queue and always a claimed slot.
// For when the limits are turned on with a queue that one network's places already fill.
func (c *Coordinator) TrimNetworks() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.PerNet24 <= 0 && c.PerNet16 <= 0 {
		return 0
	}
	n24, n16 := map[string]int{}, map[string]int{}
	kept := make([]*ticket, 0, len(c.queue))
	dropped := 0
	for _, t := range c.queue {
		k24, k16 := netKey(t.IP, 24, 40), netKey(t.IP, 16, 32)
		over := (c.PerNet24 > 0 && n24[k24] >= c.PerNet24) || (c.PerNet16 > 0 && n16[k16] >= c.PerNet16)
		if over && t.Claimed.IsZero() {
			dropped++
			continue
		}
		n24[k24]++
		n16[k16]++
		kept = append(kept, t)
	}
	if dropped > 0 {
		c.queue = kept
		c.saveQueueL()
		c.logf("queue: %d places beyond the per-network limits were dropped", dropped)
	}
	return dropped
}

func (c *Coordinator) findL(tok string) (*ticket, int) {
	if tok == "" {
		return nil, -1
	}
	for i, t := range c.queue {
		if t.Token == tok {
			return t, i
		}
	}
	return nil, -1
}

func (c *Coordinator) removeL(t *ticket) {
	for i, x := range c.queue {
		if x == t {
			c.queue = append(c.queue[:i:i], c.queue[i+1:]...)
			c.saveQueueL()
			return
		}
	}
}

// refusal is an error a client may see; its detail goes to the log only.
type refusal struct {
	Code   int
	Msg    string
	detail error
}

func (r *refusal) Error() string {
	if r.detail != nil {
		return r.Msg + ": " + r.detail.Error()
	}
	return r.Msg
}
func (r *refusal) Unwrap() error { return r.detail }

func refuse(code int, msg string, detail error) error { return &refusal{code, msg, detail} }

// ipKey groups addresses for the per-address limits: an IPv6 client by its /48 (the block a site is usually given,
// and free tunnel brokers hand out), an IPv4 client by its address.
func ipKey(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	a = a.Unmap()
	if a.Is6() {
		p, _ := a.Prefix(48)
		return p.String()
	}
	return a.String()
}

func (c *Coordinator) bannedL(ip string) bool {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	a = a.Unmap()
	for _, p := range c.bans {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// Ban refuses new places from a prefix (e.g. 203.0.113.0/24 or 2001:db8::/32) and drops the places it holds now,
// except a slot already uploading. It returns how many places were dropped.
func (c *Coordinator) Ban(prefix string) (int, error) {
	p, err := netip.ParsePrefix(prefix)
	if err != nil {
		a, aerr := netip.ParseAddr(prefix)
		if aerr != nil {
			return 0, fmt.Errorf("a prefix like 203.0.113.0/24 or an address: %w", err)
		}
		p = netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen())
	}
	p = p.Masked()
	c.mu.Lock()
	defer c.mu.Unlock()
	bans := append(append([]netip.Prefix(nil), c.bans...), p)
	b, _ := json.MarshalIndent(bans, "", "  ")
	if err := writeFileAtomic(filepath.Join(c.Dir, "bans.json"), b, 0o600); err != nil {
		return 0, err
	}
	c.bans = bans
	n := 0
	for _, t := range append([]*ticket(nil), c.queue...) {
		if c.bannedL(t.IP) && !t.uploading && !t.verifying {
			c.removeL(t)
			n++
		}
	}
	c.expireL()
	c.logf("queue: %s banned, %d place(s) dropped", p, n)
	return n, nil
}

// Status of a place in the queue, as the client sees it.
type Status struct {
	Ahead       int    `json:"ahead"`
	State       string `json:"state"` // "waiting", "claim" (yours: claim it), "active" (claimed)
	ClaimBy     string `json:"claim_by,omitempty"`
	Expires     string `json:"expires,omitempty"`
	PollSeconds int    `json:"poll_seconds"`
}

func (c *Coordinator) pollSeconds() int {
	s := int(c.heartbeat() / 4 / time.Second)
	return max(s, 1)
}

func (c *Coordinator) statusL(t *ticket, i int) Status {
	s := Status{Ahead: i, State: "waiting", PollSeconds: c.pollSeconds()}
	if i == 0 {
		if t.Claimed.IsZero() {
			s.State = "claim"
			s.ClaimBy = t.HeadSince.Add(c.claimWindow()).UTC().Format(time.RFC3339)
		} else {
			s.State = "active"
			s.Expires = t.Claimed.Add(c.slotCap()).UTC().Format(time.RFC3339)
		}
	}
	return s
}

// Join the queue.
func (c *Coordinator) Join(name, handle, ip string) (string, Status, error) {
	return c.JoinLane(name, handle, ip, "")
}

// JoinLane: lane "" for a person, "pool" for a prover-pool machine that contributes when no person is waiting.
func (c *Coordinator) JoinLane(name, handle, ip, lane string) (string, Status, error) {
	if !nameRe.MatchString(name) || (handle != "" && !nameRe.MatchString(handle)) {
		return "", Status{}, refuse(400, "a name (and handle) of 1 to 64 printable characters", nil)
	}
	if lane != "" && lane != "pool" {
		return "", Status{}, refuse(400, `lane is "" or "pool"`, nil)
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", Status{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state.Closed {
		return "", Status{}, refuse(403, "the ceremony is closed", nil)
	}
	c.expireL()
	if c.bannedL(ip) {
		return "", Status{}, refuse(403, "this address may not join", nil)
	}
	if c.AcceptedPerIP > 0 && c.accepted[ipKey(ip)] >= c.AcceptedPerIP {
		return "", Status{}, refuse(429, fmt.Sprintf("this address has already contributed %d times; thank you", c.accepted[ipKey(ip)]), nil)
	}
	if len(c.queue) >= c.queueCap() {
		return "", Status{}, refuse(429, "the queue is full; try again later", nil)
	}
	if c.PerNet24 > 0 || c.PerNet16 > 0 {
		k24, k16, n24, n16 := netKey(ip, 24, 40), netKey(ip, 16, 32), 0, 0
		for _, t := range c.queue {
			if netKey(t.IP, 24, 40) == k24 {
				n24++
			}
			if netKey(t.IP, 16, 32) == k16 {
				n16++
			}
		}
		if (c.PerNet24 > 0 && n24 >= c.PerNet24) || (c.PerNet16 > 0 && n16 >= c.PerNet16) {
			return "", Status{}, refuse(429, "this network already holds several places in the queue; try again later", nil)
		}
	}
	if lim := c.perIP(); lim > 0 {
		k, n := ipKey(ip), 0
		for _, t := range c.queue {
			if ipKey(t.IP) == k {
				n++
			}
		}
		if n >= lim {
			return "", Status{}, refuse(429, "this address already holds a place in the queue", nil)
		}
	}
	now := c.clock()
	t := &ticket{Token: hex.EncodeToString(b), Name: name, Handle: handle, IP: ip, Joined: now, Lane: lane, lastSeen: now}
	at := len(c.queue)
	if lane == "" {
		// a person goes ahead of every pool machine that has not claimed its slot
		for i, x := range c.queue {
			if x.Lane == "pool" && x.Claimed.IsZero() {
				at = i
				break
			}
		}
		if at < len(c.queue) {
			c.queue[at].HeadSince = time.Time{} // a pool machine moved back from the head starts its claim window again later
		}
	}
	c.queue = append(c.queue, nil)
	copy(c.queue[at+1:], c.queue[at:])
	c.queue[at] = t
	if at == 0 {
		t.HeadSince = now // the claim window starts now
	}
	c.saveQueueL()
	c.logf("queue: %s (%s%s) joined from %s, %d ahead", short(t.Token), name, map[string]string{"": "", "pool": ", pool"}[lane], ip, at)
	return t.Token, c.statusL(t, at), nil
}

// Poll: the client is still there; its place in the queue.
func (c *Coordinator) Poll(tok string) (Status, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.expireL()
	t, i := c.findL(tok)
	if t == nil {
		return Status{}, refuse(404, "no such place in the queue (it may have run out)", nil)
	}
	t.lastSeen = c.clock()
	return c.statusL(t, i), nil
}

// Slot is what a claimed slot works on: the head, and when the slot ends.
type Slot struct {
	Index   int    `json:"index"`
	SHA256  string `json:"sha256"`
	Size    int64  `json:"size"`
	URL     string `json:"url"`
	Expires string `json:"expires"`
}

// Claim the slot at the head of the queue.
func (c *Coordinator) Claim(tok string) (Slot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.expireL()
	t, i := c.findL(tok)
	if t == nil {
		return Slot{}, refuse(404, "no such place in the queue (it may have run out)", nil)
	}
	if i != 0 {
		return Slot{}, refuse(409, "it is not your turn yet", nil)
	}
	now := c.clock()
	t.lastSeen = now
	if t.Claimed.IsZero() {
		t.Claimed = now
		c.saveQueueL()
		c.logf("queue: %s (%s) claimed the slot on phase2-%d", short(t.Token), t.Name, c.state.HeadIndex)
	}
	return Slot{Index: c.state.HeadIndex, SHA256: c.state.HeadSHA256, Size: c.headSize, URL: fmt.Sprintf("/f/phase2-%d", c.state.HeadIndex),
		Expires: t.Claimed.Add(c.slotCap()).UTC().Format(time.RFC3339)}, nil
}

// Leave the queue.
func (c *Coordinator) Leave(tok string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	t, _ := c.findL(tok)
	if t == nil {
		return refuse(404, "no such place in the queue", nil)
	}
	c.removeL(t)
	c.logf("queue: %s (%s) left", short(t.Token), t.Name)
	return nil
}

// Kick drops a place by its position (0 is the head) or by a token prefix of at least 6 characters.
func (c *Coordinator) Kick(position int, tokenPrefix string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var t *ticket
	switch {
	case tokenPrefix != "":
		if len(tokenPrefix) < 6 {
			return "", errors.New("give at least 6 characters of the token")
		}
		for _, x := range c.queue {
			if len(x.Token) >= len(tokenPrefix) && x.Token[:len(tokenPrefix)] == tokenPrefix {
				if t != nil {
					return "", errors.New("the prefix matches more than one place")
				}
				t = x
			}
		}
	case position >= 0 && position < len(c.queue):
		t = c.queue[position]
	}
	if t == nil {
		return "", errors.New("no such place in the queue")
	}
	c.removeL(t)
	c.expireL()
	c.logf("queue: %s (%s) removed by the operator", short(t.Token), t.Name)
	return fmt.Sprintf("%s (%s)", short(t.Token), t.Name), nil
}

// QueueEntry is the operator's view of a place.
type QueueEntry struct {
	Position  int    `json:"position"`
	Token     string `json:"token"` // a prefix
	Name      string `json:"name"`
	Handle    string `json:"handle,omitempty"`
	IP        string `json:"ip"`
	Joined    string `json:"joined"`
	Claimed   string `json:"claimed,omitempty"`
	LastPoll  string `json:"last_poll"`
	Uploading bool   `json:"uploading,omitempty"`
	Lane      string `json:"lane,omitempty"`
}

// Queue as the operator sees it.
func (c *Coordinator) Queue() []QueueEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.expireL()
	out := make([]QueueEntry, 0, len(c.queue))
	for i, t := range c.queue {
		e := QueueEntry{Position: i, Token: short(t.Token), Name: t.Name, Handle: t.Handle, IP: t.IP, Joined: t.Joined.UTC().Format(time.RFC3339),
			LastPoll: t.lastSeen.UTC().Format(time.RFC3339), Uploading: t.uploading, Lane: t.Lane}
		if !t.Claimed.IsZero() {
			e.Claimed = t.Claimed.UTC().Format(time.RFC3339)
		}
		out = append(out, e)
	}
	return out
}

// beginUpload: the slot is the caller's, claimed, not already uploading, and the upload is exactly the head's size.
func (c *Coordinator) beginUpload(tok string, length int64) (*ticket, time.Time, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state.Closed {
		return nil, time.Time{}, refuse(403, "the ceremony is closed", nil)
	}
	c.expireL()
	t, i := c.findL(tok)
	if t == nil || i != 0 {
		return nil, time.Time{}, refuse(409, "it is not your turn (or your slot ran out)", nil)
	}
	if t.Claimed.IsZero() {
		return nil, time.Time{}, refuse(409, "claim the slot before uploading", nil)
	}
	if t.uploading {
		return nil, time.Time{}, refuse(409, "an upload for this slot is already in progress", nil)
	}
	if t.partBusy {
		return nil, time.Time{}, refuse(409, "a part of this contribution is still arriving", nil)
	}
	if length != c.headSize {
		return nil, time.Time{}, refuse(400, fmt.Sprintf("the upload must be exactly %d bytes (the size of the head)", c.headSize), nil)
	}
	if free, err := diskFree(c.Dir); err == nil && int64(free) < c.headSize+c.minFree() {
		c.logf("upload: refused, the disk has %d bytes free", free)
		return nil, time.Time{}, refuse(503, "the coordinator is short of disk space; the operator has been told, try again later", nil)
	}
	t.uploading, t.uploadStarted = true, true
	t.lastSeen = c.clock()
	return t, t.Claimed.Add(c.slotCap()), nil
}

// bodyDone: the whole upload arrived; while it is checked the slot's cap waits (up to verifyGrace).
func (c *Coordinator) bodyDone(t *ticket) {
	c.mu.Lock()
	t.verifying = true
	c.mu.Unlock()
}

func (c *Coordinator) endUpload(t *ticket) {
	c.mu.Lock()
	t.uploading, t.verifying = false, false
	t.lastSeen = c.clock()
	c.expireL()
	c.mu.Unlock()
}

// refusedUpload counts an upload refused as a contribution; past MaxRefused the slot goes to the next place.
func (c *Coordinator) refusedUpload(t *ticket) {
	c.mu.Lock()
	defer c.mu.Unlock()
	t.refused++
	if t.refused >= c.maxRefused() {
		if _, i := c.findL(t.Token); i >= 0 {
			c.removeL(t)
			c.logf("queue: %s (%s) left: %d uploads refused", short(t.Token), t.Name, t.refused)
			c.expireL()
		}
	}
}

// headServed counts bytes of the head sent to the token of the claimed slot.
func (c *Coordinator) headServed(tok string, n int64) {
	c.mu.Lock()
	if t, i := c.findL(tok); i == 0 && !t.Claimed.IsZero() {
		t.served += n
	}
	c.mu.Unlock()
}

// isSlotHolder: tok holds the claimed slot.
func (c *Coordinator) isSlotHolder(tok string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	t, i := c.findL(tok)
	return i == 0 && !t.Claimed.IsZero()
}

// Accept verifies a file against the head and, if it verifies, makes it the head and returns the receipt (the
// operator's path; contributions over HTTP go through the queue).
func (c *Coordinator) Accept(upload, name, handle string) (*Receipt, error) {
	return c.accept(upload, name, handle, nil)
}

// accept: the files are read and verified without the lock; the head (and, for an upload, the slot) is checked again
// under the lock before the file is committed.
func (c *Coordinator) accept(upload, name, handle string, owner *ticket) (*Receipt, error) {
	owns := func() error {
		if c.state.Closed {
			return refuse(403, "the ceremony is closed", nil)
		}
		if owner != nil {
			c.expireL()
			if len(c.queue) == 0 || c.queue[0] != owner || owner.Claimed.IsZero() {
				return refuse(409, "your slot ran out before the upload was checked", nil)
			}
		}
		return nil
	}
	c.mu.Lock()
	if err := owns(); err != nil {
		c.mu.Unlock()
		return nil, err
	}
	headIdx, headSHA, size := c.state.HeadIndex, c.state.HeadSHA256, c.headSize
	c.mu.Unlock()

	if st, err := os.Stat(upload); err != nil || st.Size() != size {
		return nil, refuse(400, fmt.Sprintf("the upload must be exactly %d bytes (the size of the head)", size), err)
	}
	c.verifyMu.Lock()
	defer c.verifyMu.Unlock()
	prev, err := Read(c.path(headIdx))
	if err != nil {
		return nil, refuse(500, "the coordinator could not read its head", err)
	}
	next, err := Read(upload)
	if err != nil {
		return nil, refuse(400, "the upload is not a Phase2 accumulator of this circuit", err)
	}
	if err := Verify(prev, next); err != nil {
		return nil, refuse(400, fmt.Sprintf("the contribution does not verify against the head, phase2-%d", headIdx), err)
	}
	prev = nil
	hash, err := Hash(next)
	if err != nil {
		return nil, refuse(500, "the coordinator could not hash the contribution", err)
	}
	next = nil
	sum, err := FileSHA256(upload)
	if err != nil {
		return nil, refuse(500, "the coordinator could not hash the upload", err)
	}
	if sum != hash {
		return nil, refuse(400, "the upload is not in the canonical encoding (its SHA-256 is not its contribution hash)", nil)
	}
	if c.beforeCommit != nil {
		c.beforeCommit()
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if err := owns(); err != nil {
		return nil, err
	}
	if c.state.HeadIndex != headIdx || c.state.HeadSHA256 != headSHA {
		return nil, refuse(409, "the head moved on while the upload was checked", nil)
	}
	idx := headIdx + 1
	dst := c.path(idx)
	if err := os.Rename(upload, dst); err != nil {
		return nil, refuse(500, "the coordinator could not store the contribution", err)
	}
	syncDir(c.Dir)
	r := Receipt{Index: idx, Name: name, Handle: handle, ContributionHash: hash, FileSHA256: sum, PrevFileSHA256: headSHA, At: c.clock().UTC().Format(time.RFC3339)}
	r.Signature = hex.EncodeToString(ed25519.Sign(c.key, r.signedBytes()))
	ns := c.state
	ns.Receipts = append(append([]Receipt(nil), c.state.Receipts...), r)
	ns.HeadIndex, ns.HeadSHA256 = idx, sum
	if err := c.saveState(ns); err != nil {
		_ = os.Rename(dst, upload) // memory and disk stay at the old head
		return nil, refuse(500, "the coordinator could not store the contribution", err)
	}
	c.state = ns
	c.headSize = size
	if owner != nil && owner.IP != "" {
		if c.accepted == nil {
			c.accepted = map[string]int{}
		}
		c.accepted[ipKey(owner.IP)]++
		if b, err := json.Marshal(c.accepted); err == nil {
			if err := writeFileAtomic(filepath.Join(c.Dir, "accepted.json"), b, 0o600); err != nil {
				c.logf("could not save accepted.json: %v", err)
			}
		}
	}
	if owner != nil {
		owner.uploading = false
		c.removeL(owner)
		c.expireL()
	}
	c.logf("chain: phase2-%d accepted from %s, contribution %s", idx, name, hash)
	return &r, nil
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

// Close the chain (no more contributions; the beacon comes next). The queue is emptied.
func (c *Coordinator) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	ns := c.state
	ns.Closed = true
	if err := c.saveState(ns); err != nil {
		return err
	}
	c.state = ns
	c.queue = nil
	c.saveQueueL()
	return nil
}

// ── files ──

func writeFileSync(path string, b []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// writeFileAtomic: a synced temporary file renamed over the old one, then the directory synced.
func writeFileAtomic(path string, b []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := writeFileSync(tmp, b, mode); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	syncDir(filepath.Dir(path))
	return nil
}

func syncDir(dir string) {
	if runtime.GOOS == "windows" {
		return
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
