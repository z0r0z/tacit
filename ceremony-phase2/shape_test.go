package ceremony

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	mpcsetup "github.com/consensys/gnark/backend/groth16/bn254/mpcsetup"
	cs "github.com/consensys/gnark/constraint/bn254"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
)

// a circuit with a commitment, so the accumulator has the per-commitment parts as well
type committed struct {
	X frontend.Variable
	Y frontend.Variable `gnark:",public"`
}

func (c *committed) Define(api frontend.API) error {
	cm, err := api.(frontend.Committer).Commit(c.X)
	if err != nil {
		return err
	}
	api.AssertIsDifferent(cm, 0)
	api.AssertIsEqual(api.Mul(c.X, c.X), c.Y)
	return nil
}

func TestShapeWithCommitments(t *testing.T) {
	ccsI, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &committed{})
	if err != nil {
		t.Fatal(err)
	}
	ccs := ccsI.(*cs.R1CS)
	var p1 mpcsetup.Phase1
	p1.Initialize(ecc.NextPowerOfTwo(uint64(ccs.GetNbConstraints())))
	commons := p1.Seal([]byte("b"))
	var p2 mpcsetup.Phase2
	p2.Initialize(ccs, &commons)
	if len(p2.Parameters.G2.Sigma) == 0 {
		t.Fatal("the circuit should have a commitment")
	}
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a"), filepath.Join(dir, "b")
	if err := Write(&p2, a); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(a)
	if n, err := CheckShape(a); err != nil || n != st.Size() {
		t.Fatalf("the layout accounts for the whole file: %d of %d, %v", n, st.Size(), err)
	}
	if _, err := Contribute(a, b); err != nil {
		t.Fatal(err)
	}
	prev, err := Read(a)
	if err != nil {
		t.Fatal(err)
	}
	next, err := Read(b)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(prev, next); err != nil {
		t.Fatal(err)
	}
}
