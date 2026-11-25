package ceremony

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	mpcsetup "github.com/consensys/gnark/backend/groth16/bn254/mpcsetup"
	cs "github.com/consensys/gnark/constraint/bn254"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
)

// a small circuit: knowledge of x with x^3 + x + 5 = y
type cube struct {
	X frontend.Variable
	Y frontend.Variable `gnark:",public"`
}

func (c *cube) Define(api frontend.API) error {
	api.AssertIsEqual(api.Add(api.Mul(c.X, c.X, c.X), c.X, 5), c.Y)
	return nil
}

type fixture struct {
	dir, base string
	ccs       *cs.R1CS
	commons   mpcsetup.SrsCommons
	evals     mpcsetup.Phase2Evaluations
}

// newFixture: Phase 1 (standing for the inherited powers of tau) sealed with its beacon, then the initial Phase 2 with
// one contribution (standing for the transcript's earlier ones): the base file.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	ccsI, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &cube{})
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{dir: t.TempDir(), ccs: ccsI.(*cs.R1CS)}
	var p1 mpcsetup.Phase1
	p1.Initialize(ecc.NextPowerOfTwo(uint64(f.ccs.GetNbConstraints())))
	p1.Contribute()
	f.commons = p1.Seal([]byte("phase1 beacon"))
	var p2 mpcsetup.Phase2
	f.evals = p2.Initialize(f.ccs, &f.commons)
	p2.Contribute()
	f.base = filepath.Join(f.dir, "base")
	if err := Write(&p2, f.base); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *fixture) chain(t *testing.T) *Coordinator {
	t.Helper()
	c, err := Init(filepath.Join(f.dir, "chain"), f.base, 17, "Tacit Praxis ceremony (test)")
	if err != nil {
		t.Fatal(err)
	}
	c.Logf = t.Logf
	c.MinFree = 1 // the disk check is its own test; a test machine's free space must not decide the others
	return c
}

func TestCeremonyEndToEnd(t *testing.T) {
	f := newFixture(t)
	dir, base := f.dir, f.base
	c := f.chain(t)
	if _, err := Init(filepath.Join(dir, "chain"), base, 17, "again"); err == nil {
		t.Fatal("a second chain in the same directory must be refused")
	}
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()
	key := c.State().CoordPubKey

	// two contributors through the HTTP coordinator, one after the other
	var receipts []*Receipt
	for _, who := range []string{"alice", "bob"} {
		wd := t.TempDir()
		cl := NewClient(ClientOptions{Coordinator: srv.URL, CoordinatorKey: key, Name: who, Handle: "@" + who, Workdir: wd, Poll: 10 * time.Millisecond, Log: func(s string) { t.Log(who + ": " + s) }})
		r, hash, err := cl.Contribute(context.Background())
		cl.Cleanup()
		if err != nil {
			t.Fatalf("%s: %v", who, err)
		}
		if r.ContributionHash != hash || !VerifyReceipt(*r, key) {
			t.Fatalf("%s: the receipt is not for this contribution, or not signed", who)
		}
		if left, _ := os.ReadDir(wd); len(left) != 0 {
			t.Fatalf("%s: files left in the work directory: %v", who, left)
		}
		receipts = append(receipts, r)
	}
	if receipts[0].Index != 18 || receipts[1].Index != 19 || receipts[1].PrevFileSHA256 != receipts[0].FileSHA256 {
		t.Fatalf("the receipts chain: %+v %+v", receipts[0], receipts[1])
	}
	forged := *receipts[1]
	forged.Name = "mallory"
	if VerifyReceipt(forged, key) {
		t.Fatal("a changed receipt must not verify")
	}

	// a client that pins another coordinator key does not accept the receipt
	cl := NewClient(ClientOptions{Coordinator: srv.URL, CoordinatorKey: PinnedCoordinatorKey, Name: "carol", Workdir: t.TempDir(), Poll: 10 * time.Millisecond})
	if _, _, err := cl.Contribute(context.Background()); err == nil || !strings.Contains(err.Error(), "not signed by the coordinator key") {
		t.Fatalf("a receipt under another key must be refused by the client: %v", err)
	}
	cl.Cleanup()

	// a stale contribution (built on the base, not on the head) is refused, and the head stays
	stale := filepath.Join(dir, "stale")
	if _, err := Contribute(base, stale); err != nil {
		t.Fatal(err)
	}
	head := c.State().HeadSHA256
	if _, err := c.Accept(stale, "late", ""); err == nil {
		t.Fatal("a contribution that is not on the head must be refused")
	}
	// a file that is not an accumulator is refused
	junk := filepath.Join(dir, "junk")
	_ = os.WriteFile(junk, []byte("not a phase2 file"), 0o644)
	if _, err := c.Accept(junk, "junk", ""); err == nil {
		t.Fatal("junk must be refused")
	}
	if c.State().HeadSHA256 != head {
		t.Fatal("a refused upload must leave the head unchanged")
	}

	// the state survives a restart, and the whole chain verifies link by link from the base
	c2, err := Open(filepath.Join(dir, "chain"))
	if err != nil || c2.State().HeadIndex != 20 || len(c2.State().Receipts) != 3 {
		t.Fatalf("reopen: %v %+v", err, c2.State())
	}
	prev, _ := Read(base)
	for i := 18; i <= 20; i++ {
		next, err := Read(filepath.Join(dir, "chain", fmt.Sprintf("phase2-%d", i)))
		if err != nil || Verify(prev, next) != nil {
			t.Fatalf("link %d does not verify", i)
		}
		prev = next
	}

	// seal with the beacon and use the keys: a real Groth16 proof verifies under them
	pk, vk := prev.Seal(&f.commons, &f.evals, []byte("tacit beacon"))
	w, _ := frontend.NewWitness(&cube{X: 3, Y: 35}, ecc.BN254.ScalarField())
	proof, err := groth16.Prove(f.ccs, pk, w)
	if err != nil {
		t.Fatal(err)
	}
	pub, _ := w.Public()
	if err := groth16.Verify(proof, vk, pub); err != nil {
		t.Fatalf("a proof under the ceremony's keys must verify: %v", err)
	}
	bad, _ := frontend.NewWitness(&cube{Y: 36}, ecc.BN254.ScalarField(), frontend.PublicOnly())
	if err := groth16.Verify(proof, vk, bad); err == nil {
		t.Fatal("and must not verify for another statement")
	}
	vkPath := filepath.Join(dir, "vk")
	vf, _ := os.Create(vkPath)
	if _, err := vk.WriteTo(vf); err != nil {
		t.Fatal(err)
	}
	vf.Close()
	var sol strings.Builder
	if err := Solidity(vkPath, &sol); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sol.String(), "DELTA_NEG_X_0") || !strings.Contains(sol.String(), "function verifyProof") {
		t.Fatal("the Solidity verifier is missing its delta or its verify function")
	}
}
