package ceremony

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	bls "github.com/consensys/gnark-crypto/ecc/bls12-381"
)

// The ceremony's beacons.
//
// Phase 1 seal: the randomness of round 1000 of drand's League of Entropy "default" chain, the beacon Succinct's
// SP1 v6.1.0 transcript was sealed with (semaphore-gnark-11 fetches https://api.drand.sh/public/<round>, which is that
// chain). The files depend on it, so it is a constant here rather than something fetched:
//
//	chain   8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce (pedersen-bls-chained, 30 s rounds)
//	source  https://api.drand.sh/public/1000 (and .../8990e7a9…/public/1000)
//	check   drand_test.go verifies the round's BLS signature against the chain's public key and that the randomness is
//	        SHA-256 of the signature, offline, from the constants below.
//
// Phase 2 seal (this ceremony's close): SHA-256("tacit-praxis-beacon-v1" || Bitcoin block hash || quicknet randomness),
// where the block hash is the 32 bytes of the hash as block explorers and `bitcoin-cli getblockhash` print it
// (display order, leading zeros first; not the reversed internal order), and the quicknet randomness is that of a
// round of drand's quicknet chain, whose BLS signature is checked against the pinned public key below before use.
const (
	Phase1DrandRound      = 1000
	Phase1DrandRandomness = "a40d3e0e7e3c71f28b7da2fd339f47f0bcf10910309f5253d7c323ec8cea3212"
	Phase1DrandSignature  = "99bf96de133c3d3937293cfca10c8152b18ab2d034ccecf115658db324d2edc00a16a2044cd04a8a38e2a307e5ecff3511315be8d282079faf24098f283e0ed2c199663b334d2e84c55c032fe469b212c5c2087ebb83a5b25155c3283f5b79ac"
	Phase1DrandPrevSig    = "af0d93299a363735fe847f5ea241442c65843dc1bd3a7b79646b3b10072e908bf034d35cd69d378e3341f139100cd4cd03030399864ef8803a5a4f5e64fccc20bbae36d1ca22a6ddc43d2630c41105e90598fab11e5c7456df3925d4b577b113"
	DefaultChainHash      = "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce"
	DefaultChainPublicKey = "868f005eb8e6e4ca0a47c8a77ceaa5309a47978a7c71bc5cce96366b5d7a569937c529eeda66c7293784a9402801af31"

	// drand quicknet (bls-unchained-g1-rfc9380, 3 s rounds from 1692803367), as https://api.drand.sh/<hash>/info gives it
	QuicknetChainHash = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
	QuicknetPublicKey = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a"
	QuicknetGenesis   = 1692803367
	QuicknetPeriod    = 3

	BeaconDomain = "tacit-praxis-beacon-v1"
	DrandAPIURL  = "https://api.drand.sh"
)

var (
	dstG1 = []byte("BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_") // quicknet: signatures on G1, RFC 9380 hash to curve
	dstG2 = []byte("BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_") // the default chain: signatures on G2
)

// Phase1Beacon is the Phase 1 seal's randomness (see above).
func Phase1Beacon() []byte {
	b, _ := hex.DecodeString(Phase1DrandRandomness)
	return b
}

func roundBytes(round uint64) []byte {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], round)
	return b[:]
}

// VerifyQuicknet checks a quicknet round's signature against the pinned public key and returns the round's randomness
// (SHA-256 of the signature).
func VerifyQuicknet(round uint64, sigHex string) ([]byte, error) {
	return verifyQuicknetWith(QuicknetPublicKey, round, sigHex)
}

func verifyQuicknetWith(pubHex string, round uint64, sigHex string) ([]byte, error) {
	if round == 0 {
		return nil, errors.New("drand round must be > 0")
	}
	sigB, err := hex.DecodeString(strings.TrimPrefix(sigHex, "0x"))
	if err != nil || len(sigB) != bls.SizeOfG1AffineCompressed {
		return nil, errors.New("a quicknet signature is 48 bytes of hex")
	}
	pkB, _ := hex.DecodeString(pubHex)
	var sig bls.G1Affine
	if _, err := sig.SetBytes(sigB); err != nil {
		return nil, fmt.Errorf("the signature is not a point: %w", err)
	}
	var pk bls.G2Affine
	if _, err := pk.SetBytes(pkB); err != nil {
		return nil, fmt.Errorf("the public key is not a point: %w", err)
	}
	m := sha256.Sum256(roundBytes(round))
	h, err := bls.HashToG1(m[:], dstG1)
	if err != nil {
		return nil, err
	}
	_, _, _, g2 := bls.Generators()
	var negH bls.G1Affine
	negH.Neg(&h)
	ok, err := bls.PairingCheck([]bls.G1Affine{sig, negH}, []bls.G2Affine{g2, pk}) // e(sig, g2) = e(H(m), pk)
	if err != nil || !ok {
		return nil, fmt.Errorf("the signature of quicknet round %d does not verify", round)
	}
	r := sha256.Sum256(sigB)
	return r[:], nil
}

// verifyChained checks a round of the default (chained) chain: signature on G2 over SHA-256(previous signature || round).
func verifyChained(pubHex string, round uint64, sigHex, prevHex string) ([]byte, error) {
	sigB, err := hex.DecodeString(sigHex)
	if err != nil || len(sigB) != bls.SizeOfG2AffineCompressed {
		return nil, errors.New("a default-chain signature is 96 bytes of hex")
	}
	prev, err := hex.DecodeString(prevHex)
	if err != nil {
		return nil, err
	}
	pkB, _ := hex.DecodeString(pubHex)
	var sig bls.G2Affine
	if _, err := sig.SetBytes(sigB); err != nil {
		return nil, err
	}
	var pk bls.G1Affine
	if _, err := pk.SetBytes(pkB); err != nil {
		return nil, err
	}
	m := sha256.Sum256(append(append([]byte{}, prev...), roundBytes(round)...))
	h, err := bls.HashToG2(m[:], dstG2)
	if err != nil {
		return nil, err
	}
	_, _, g1, _ := bls.Generators()
	var negPk bls.G1Affine
	negPk.Neg(&pk)
	ok, err := bls.PairingCheck([]bls.G1Affine{g1, negPk}, []bls.G2Affine{sig, h}) // e(g1, sig) = e(pk, H(m))
	if err != nil || !ok {
		return nil, fmt.Errorf("the signature of round %d does not verify", round)
	}
	r := sha256.Sum256(sigB)
	return r[:], nil
}

// QuicknetRoundAt is the first quicknet round published at or after t.
func QuicknetRoundAt(t time.Time) uint64 {
	s := t.Unix() - QuicknetGenesis
	if s <= 0 {
		return 1
	}
	return uint64((s+QuicknetPeriod-1)/QuicknetPeriod) + 1
}

// FetchQuicknet fetches a quicknet round from the drand HTTP API (DRAND_API_URL overrides the host) and returns its
// signature; the caller checks it with VerifyQuicknet. The URL names the pinned chain hash.
func FetchQuicknet(round uint64) (string, error) {
	base := strings.TrimRight(os.Getenv("DRAND_API_URL"), "/")
	if base == "" {
		base = DrandAPIURL
	}
	c := &http.Client{Timeout: 15 * time.Second}
	resp, err := c.Get(fmt.Sprintf("%s/%s/public/%d", base, QuicknetChainHash, round))
	if err != nil {
		return "", fmt.Errorf("fetch quicknet round %d: %w", round, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("drand answered %d: %s", resp.StatusCode, bytes.TrimSpace(body))
	}
	var p struct {
		Round      uint64 `json:"round"`
		Randomness string `json:"randomness"`
		Signature  string `json:"signature"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return "", fmt.Errorf("decode drand response: %w", err)
	}
	if p.Round != round {
		return "", fmt.Errorf("drand round mismatch: asked for %d, got %d", round, p.Round)
	}
	return p.Signature, nil
}

// ParseBitcoinBlockHash reads a block hash in display order (as explorers and `bitcoin-cli getblockhash` print it).
// Every mainnet block hash begins with at least 4 zero bytes in that order; a hash that does not is probably reversed.
func ParseBitcoinBlockHash(s string) ([]byte, error) {
	b, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(s), "0x"))
	if err != nil || len(b) != 32 {
		return nil, errors.New("a Bitcoin block hash is 32 bytes of hex")
	}
	if !bytes.Equal(b[:4], []byte{0, 0, 0, 0}) {
		return nil, errors.New("the block hash does not begin with zeros: give it in display order, as explorers and getblockhash print it")
	}
	return b, nil
}

// Beacon is the Phase 2 seal: SHA-256("tacit-praxis-beacon-v1" || block hash (display order) || quicknet randomness).
func Beacon(blockHash, quicknetRandomness []byte) []byte {
	h := sha256.New()
	h.Write([]byte(BeaconDomain))
	h.Write(blockHash)
	h.Write(quicknetRandomness)
	return h.Sum(nil)
}
