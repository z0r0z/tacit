package ceremony

import (
	"net/http/httptest"
	"os"
	"path/filepath"
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

func TestCeremonyEndToEnd(t *testing.T) {
	ccsI, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &cube{})
	if err != nil {
		t.Fatal(err)
	}
	ccs := ccsI.(*cs.R1CS)
	// Phase 1 (stands for the inherited powers of tau), sealed with its beacon, then the initial Phase 2: the base file
	var p1 mpcsetup.Phase1
	p1.Initialize(ecc.NextPowerOfTwo(uint64(ccs.GetNbConstraints())))
	p1.Contribute()
	commons := p1.Seal([]byte("phase1 beacon"))
	var p2 mpcsetup.Phase2
	evals := p2.Initialize(ccs, &commons)
	p2.Contribute() // stands for the transcript's earlier contributions
	dir := t.TempDir()
	base := filepath.Join(dir, "base")
	if err := Write(&p2, base); err != nil {
		t.Fatal(err)
	}

	c, err := Init(filepath.Join(dir, "chain"), base, 17, "Tacit Praxis ceremony (test)")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Init(filepath.Join(dir, "chain"), base, 17, "again"); err == nil {
		t.Fatal("a second chain in the same directory must be refused")
	}
	srv := httptest.NewServer(c.Handler())
	defer srv.Close()

	// two contributors through the HTTP coordinator, one after the other
	var receipts []*Receipt
	for _, who := range []string{"alice", "bob"} {
		wd := t.TempDir()
		r, err := ContributeRemote(srv.URL, who, "@"+who, wd, 10*time.Millisecond, nil)
		if err != nil {
			t.Fatalf("%s: %v", who, err)
		}
		if !VerifyReceipt(*r, c.State().CoordPubKey) {
			t.Fatalf("%s: the receipt's signature does not verify", who)
		}
		receipts = append(receipts, r)
	}
	if receipts[0].Index != 18 || receipts[1].Index != 19 || receipts[1].PrevFileSHA256 != receipts[0].FileSHA256 {
		t.Fatalf("the receipts chain: %+v %+v", receipts[0], receipts[1])
	}
	forged := *receipts[1]
	forged.Name = "mallory"
	if VerifyReceipt(forged, c.State().CoordPubKey) {
		t.Fatal("a changed receipt must not verify")
	}

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
	if err != nil || c2.State().HeadIndex != 19 || len(c2.State().Receipts) != 2 {
		t.Fatalf("reopen: %v %+v", err, c2.State())
	}
	prev, _ := Read(base)
	for i := 18; i <= 19; i++ {
		next, err := Read(filepath.Join(dir, "chain", "phase2-"+itoa(i)))
		if err != nil || Verify(prev, next) != nil {
			t.Fatalf("link %d does not verify", i)
		}
		prev = next
	}

	// seal with the beacon and use the keys: a real Groth16 proof verifies under them
	pk, vk := prev.Seal(&commons, &evals, []byte("tacit beacon"))
	w, _ := frontend.NewWitness(&cube{X: 3, Y: 35}, ecc.BN254.ScalarField())
	proof, err := groth16.Prove(ccs, pk, w)
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
}

func itoa(i int) string { return string(rune('0'+i/10)) + string(rune('0'+i%10)) }
