package ceremony

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
	"time"
)

// quicknet rounds as https://api.drand.sh/52db9ba7…e971/public/<round> serves them
var quicknetRounds = []struct {
	round           uint64
	randomness, sig string
}{
	{1, "1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a", "b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b"},
	{1000, "fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd", "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39"},
	{2000000, "3fcc32da81d3de7243f1b702a3a502a3118e0492e19e39e30f3da36be1eef788", "a7c94d62fa50475c65f259bc4d50afc0cebc5cb29848568f90dff842789c05d7f6b2414971a0b67bf532624ad6bab054"},
	{20000000, "f39c98df5525968e6622e0c63edb3d1f9c5607cf780db78abdded36e4b3dba95", "96892582a33552a7b67ba44ef09c3ccd535bbebe760c93ecf45be8958d0c0f06390c6d19d7bf492eb806af7eef6b125c"},
}

func TestQuicknetRoundsVerify(t *testing.T) {
	for _, q := range quicknetRounds {
		r, err := VerifyQuicknet(q.round, q.sig)
		if err != nil {
			t.Fatalf("round %d: %v", q.round, err)
		}
		if hex.EncodeToString(r) != q.randomness {
			t.Fatalf("round %d: randomness %x, want %s", q.round, r, q.randomness)
		}
	}
}

func TestQuicknetRefusesWrongRoundOrKey(t *testing.T) {
	if _, err := VerifyQuicknet(2, quicknetRounds[0].sig); err == nil {
		t.Fatal("round 1's signature must not pass for round 2")
	}
	bad := []byte(quicknetRounds[1].sig)
	bad[10] ^= 1
	if _, err := VerifyQuicknet(1000, string(bad)); err == nil {
		t.Fatal("a changed signature must not pass")
	}
	if _, err := VerifyQuicknet(1, "abcd"); err == nil {
		t.Fatal("a short signature must not pass")
	}
	// another G2 point as the key: the default chain's round-1000 signature (a valid G2 point, wrong key)
	if _, err := verifyQuicknetWith(Phase1DrandSignature, 1, quicknetRounds[0].sig); err == nil {
		t.Fatal("a signature must not pass under another key")
	}
}

func TestPhase1BeaconConstant(t *testing.T) {
	r, err := verifyChained(DefaultChainPublicKey, Phase1DrandRound, Phase1DrandSignature, Phase1DrandPrevSig)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(r) != Phase1DrandRandomness || hex.EncodeToString(Phase1Beacon()) != Phase1DrandRandomness {
		t.Fatalf("the Phase 1 constant is not round 1000's randomness: %x", r)
	}
	if _, err := verifyChained(DefaultChainPublicKey, 1001, Phase1DrandSignature, Phase1DrandPrevSig); err == nil {
		t.Fatal("the round number is part of the signed message")
	}
}

func TestBeaconDefinition(t *testing.T) {
	// the genesis block's hash, as explorers print it
	const genesis = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
	bh, err := ParseBitcoinBlockHash(genesis)
	if err != nil {
		t.Fatal(err)
	}
	rnd, _ := hex.DecodeString(quicknetRounds[1].randomness)
	got := Beacon(bh, rnd)
	want := sha256.Sum256(append(append([]byte("tacit-praxis-beacon-v1"), bh...), rnd...))
	if hex.EncodeToString(got) != hex.EncodeToString(want[:]) {
		t.Fatal("the beacon is SHA-256 of the domain, the block hash and the randomness")
	}
	// a fixed vector, so another implementation can check itself against this one
	if hex.EncodeToString(got) != "82ae2cf75d1d9a1c02b62d7dfca50fb9f3f38419d42b6f6c4a20719580eefcde" {
		t.Fatalf("beacon(genesis, quicknet 1000) = %x", got)
	}
	// the reversed (internal) order is refused, so the two orders cannot be confused
	rev := make([]byte, 32)
	for i := range bh {
		rev[i] = bh[31-i]
	}
	if _, err := ParseBitcoinBlockHash(hex.EncodeToString(rev)); err == nil || !strings.Contains(err.Error(), "display order") {
		t.Fatalf("a reversed hash must be refused: %v", err)
	}
	if _, err := ParseBitcoinBlockHash("00"); err == nil {
		t.Fatal("a short hash must be refused")
	}
}

func TestQuicknetRoundAt(t *testing.T) {
	if r := QuicknetRoundAt(time.Unix(QuicknetGenesis, 0)); r != 1 {
		t.Fatalf("genesis is round 1, got %d", r)
	}
	if r := QuicknetRoundAt(time.Unix(QuicknetGenesis+3*999, 0)); r != 1000 {
		t.Fatalf("got %d", r)
	}
	if r := QuicknetRoundAt(time.Unix(QuicknetGenesis+3*999+1, 0)); r != 1001 {
		t.Fatalf("got %d", r)
	}
}
