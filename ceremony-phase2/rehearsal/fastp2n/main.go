// fastp2n: gnark's mpcsetup Phase2.Initialize (the initial Phase 2 file and the evaluations of a circuit, from Phase 1),
// with its per-wire sums run on every core. gnark's loop adds each constraint's terms into its wires one after another,
// on one thread, in affine coordinates; for SP1 v6.1.0's wrapper that is about 391 million G1 and 62 million G2 scalar
// multiplications in a row. Here each thread owns a range of wires and sums only their terms, in Jacobian coordinates,
// converting to affine once at the end. A sum of points does not depend on the order of its terms and a point's affine
// form is unique, so the files are byte for byte gnark's: `fastp2n check` compares the two on a small circuit.
//
//	fastp2n run <phase1> <circuit.bin> <phase2 out> <evals out>    (Phase 1 sealed with drand round 1000, as sg11 p2n --beacon-round 1000)
//	fastp2n check                                                 (this program's files == gnark's Initialize, on test circuits)
package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"fmt"
	"math/big"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	curve "github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark/backend/groth16/bn254/mpcsetup"
	"github.com/consensys/gnark/constraint"
	cs "github.com/consensys/gnark/constraint/bn254"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	ceremony "tacit.finance/ceremony"
)

func parallelize(n int, work func(int, int), _ ...int) {
	t := runtime.NumCPU()
	if t > n {
		t = n
	}
	if t < 1 {
		t = 1
	}
	var wg sync.WaitGroup
	for i := 0; i < t; i++ {
		lo, hi := i*n/t, (i+1)*n/t
		wg.Add(1)
		go func() { defer wg.Done(); work(lo, hi) }()
	}
	wg.Wait()
}

func logf(f string, a ...any) {
	fmt.Fprintf(os.Stderr, time.Now().UTC().Format("15:04:05 ")+f+"\n", a...)
}

// initialize: the same values as gnark's Phase2.Initialize, the per-wire sums in parallel.
func initialize(r *cs.R1CS, commons *mpcsetup.SrsCommons) (*mpcsetup.Phase2, mpcsetup.Phase2Evaluations) {
	n := len(commons.G1.AlphaTau)
	if n < r.GetNbConstraints() {
		panic("Number of constraints is larger than expected")
	}
	logf("lagrange coefficients (4 FFTs of size %d)", n)
	coeffTau1 := lagrangeCoeffsG1(commons.G1.Tau, n)
	coeffTau2 := lagrangeCoeffsG2(commons.G2.Tau, n)
	coeffAlphaTau1 := lagrangeCoeffsG1(commons.G1.AlphaTau, n)
	coeffBetaTau1 := lagrangeCoeffsG1(commons.G1.BetaTau, n)

	nbInternal, nbSecret, nbPublic := r.GetNbVariables()
	nWires := nbInternal + nbSecret + nbPublic
	var evals mpcsetup.Phase2Evaluations
	commitmentInfo := r.CommitmentInfo.(constraint.Groth16Commitments)
	evals.PublicAndCommitmentCommitted = commitmentInfo.GetPublicAndCommitmentCommitted(commitmentInfo.CommitmentIndexes(), nbPublic)

	// the coefficients as big integers, once
	coeffs := make([]big.Int, len(r.Coefficients))
	for i := range r.Coefficients {
		r.Coefficients[i].BigInt(&coeffs[i])
	}
	A := make([]curve.G1Jac, nWires)
	B1 := make([]curve.G1Jac, nWires)
	B2 := make([]curve.G2Jac, nWires)
	bA := make([]curve.G1Jac, nWires)
	aB := make([]curve.G1Jac, nWires)
	C := make([]curve.G1Jac, nWires)
	acc1 := func(res *curve.G1Jac, t constraint.Term, v *curve.G1Affine) {
		switch t.CoeffID() {
		case constraint.CoeffIdZero:
		case constraint.CoeffIdOne:
			res.AddMixed(v)
		case constraint.CoeffIdMinusOne:
			var m curve.G1Affine
			m.Neg(v)
			res.AddMixed(&m)
		case constraint.CoeffIdTwo:
			res.AddMixed(v).AddMixed(v)
		default:
			var tmp curve.G1Jac
			tmp.FromAffine(v)
			tmp.ScalarMultiplication(&tmp, &coeffs[t.CoeffID()])
			res.AddAssign(&tmp)
		}
	}
	acc2 := func(res *curve.G2Jac, t constraint.Term, v *curve.G2Affine) {
		switch t.CoeffID() {
		case constraint.CoeffIdZero:
		case constraint.CoeffIdOne:
			res.AddMixed(v)
		case constraint.CoeffIdMinusOne:
			var m curve.G2Affine
			m.Neg(v)
			res.AddMixed(&m)
		case constraint.CoeffIdTwo:
			res.AddMixed(v).AddMixed(v)
		default:
			var tmp curve.G2Jac
			tmp.FromAffine(v)
			tmp.ScalarMultiplication(&tmp, &coeffs[t.CoeffID()])
			res.AddAssign(&tmp)
		}
	}
	threads := runtime.NumCPU()
	logf("per-wire sums: %d constraints, %d wires, %d threads", r.GetNbConstraints(), nWires, threads)
	start := time.Now()
	var wg sync.WaitGroup
	for k := 0; k < threads; k++ {
		lo, hi := k*nWires/threads, (k+1)*nWires/threads
		wg.Add(1)
		go func(k int) {
			defer wg.Done()
			own := func(w int) bool { return w >= lo && w < hi }
			i := 0
			it := r.GetR1CIterator()
			for c := it.Next(); c != nil; c = it.Next() {
				for _, t := range c.L {
					if w := t.WireID(); own(w) {
						acc1(&A[w], t, &coeffTau1[i])
						acc1(&bA[w], t, &coeffBetaTau1[i])
					}
				}
				for _, t := range c.R {
					if w := t.WireID(); own(w) {
						acc1(&B1[w], t, &coeffTau1[i])
						acc2(&B2[w], t, &coeffTau2[i])
						acc1(&aB[w], t, &coeffAlphaTau1[i])
					}
				}
				for _, t := range c.O {
					if w := t.WireID(); own(w) {
						acc1(&C[w], t, &coeffTau1[i])
					}
				}
				i++
				if k == 0 && i%1_000_000 == 0 {
					logf("  thread 0: %d of %d constraints (%s)", i, r.GetNbConstraints(), time.Since(start).Round(time.Second))
				}
			}
		}(k)
	}
	wg.Wait()
	logf("sums done in %s; to affine", time.Since(start).Round(time.Second))
	evals.G1.A = curve.BatchJacobianToAffineG1(A)
	evals.G1.B = curve.BatchJacobianToAffineG1(B1)
	evals.G2.B = make([]curve.G2Affine, nWires)
	parallelize(nWires, func(lo, hi int) {
		for j := lo; j < hi; j++ {
			evals.G2.B[j].FromJacobian(&B2[j])
		}
	})
	bAa := curve.BatchJacobianToAffineG1(bA)
	aBa := curve.BatchJacobianToAffineG1(aB)
	Ca := curve.BatchJacobianToAffineG1(C)
	A, B1, B2, bA, aB, C = nil, nil, nil, nil, nil, nil

	p := &mpcsetup.Phase2{}
	_, _, g1, g2 := curve.Generators()
	p.Parameters.G1.Delta = g1
	p.Parameters.G2.Delta = g2
	p.Parameters.G1.Z = make([]curve.G1Affine, n)
	for i := range n - 1 {
		p.Parameters.G1.Z[i].Sub(&commons.G1.Tau[i+n], &commons.G1.Tau[i])
	}
	bitReverse(p.Parameters.G1.Z)
	p.Parameters.G1.Z = p.Parameters.G1.Z[:n-1]

	commitments := r.CommitmentInfo.(constraint.Groth16Commitments)
	evals.G1.CKK = make([][]curve.G1Affine, len(commitments))
	p.Parameters.G1.SigmaCKK = make([][]curve.G1Affine, len(commitments))
	p.Parameters.G2.Sigma = make([]curve.G2Affine, len(commitments))
	for j := range commitments {
		evals.G1.CKK[j] = make([]curve.G1Affine, 0, len(commitments[j].PrivateCommitted))
		p.Parameters.G2.Sigma[j] = g2
	}
	if len(commitments) != 0 {
		panic("circuits with commitments are not handled here (SP1 v6.1.0's wrapper has none)")
	}
	p.Parameters.G1.PKK = make([]curve.G1Affine, 0, nbInternal+nbSecret)
	evals.G1.VKK = make([]curve.G1Affine, 0, nbPublic)
	for j := 0; j < nWires; j++ {
		var tmp curve.G1Affine
		tmp.Add(&bAa[j], &aBa[j])
		tmp.Add(&tmp, &Ca[j])
		if j < nbPublic {
			evals.G1.VKK = append(evals.G1.VKK, tmp)
		} else {
			p.Parameters.G1.PKK = append(p.Parameters.G1.PKK, tmp)
		}
	}
	p.Challenge = nil
	return p, evals
}

func readR1CS(path string) *cs.R1CS {
	f, err := os.Open(path)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	r := &cs.R1CS{}
	if _, err := r.ReadFrom(bufio.NewReaderSize(f, 1<<22)); err != nil {
		panic(err)
	}
	return r
}

func files(p *mpcsetup.Phase2, e *mpcsetup.Phase2Evaluations) ([]byte, []byte) {
	var a, b bytes.Buffer
	if _, err := p.WriteTo(&a); err != nil {
		panic(err)
	}
	if err := ceremony.WritePhase2Evaluations(e, &b); err != nil {
		panic(err)
	}
	return a.Bytes(), b.Bytes()
}

// test circuits: a cube, and one with many wires, repeated wires, negative and large coefficients, and public inputs
type cube struct {
	X frontend.Variable
	Y frontend.Variable `gnark:",public"`
}

func (c *cube) Define(api frontend.API) error {
	api.AssertIsEqual(api.Add(api.Mul(c.X, c.X, c.X), c.X, 5), c.Y)
	return nil
}

type mix struct {
	P [3]frontend.Variable `gnark:",public"`
	S [40]frontend.Variable
}

func (c *mix) Define(api frontend.API) error {
	acc := frontend.Variable(0)
	for i, s := range c.S {
		t := api.Mul(s, s, c.P[i%3])
		acc = api.Add(acc, api.Mul(t, -7), api.Mul(s, 123456789123456789), api.Sub(c.P[(i+1)%3], s))
		if i%5 == 0 {
			acc = api.Mul(acc, c.S[(i*7)%40])
		}
	}
	api.AssertIsDifferent(acc, 0)
	return nil
}

func check() {
	for _, circ := range []frontend.Circuit{&cube{}, &mix{}} {
		ccsI, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, circ)
		if err != nil {
			panic(err)
		}
		r := ccsI.(*cs.R1CS)
		var p1 mpcsetup.Phase1
		p1.Initialize(ecc.NextPowerOfTwo(uint64(r.GetNbConstraints())))
		p1.Contribute()
		commons := ceremony.SealPhase1(&p1, ceremony.Phase1Beacon())
		var ref mpcsetup.Phase2
		refEvals := ref.Initialize(r, &commons)
		mine, myEvals := initialize(r, &commons)
		a1, b1 := files(&ref, &refEvals)
		a2, b2 := files(mine, &myEvals)
		ok := bytes.Equal(a1, a2) && bytes.Equal(b1, b2)
		fmt.Printf("%T: %d constraints: phase2 %x vs %x, evals %x vs %x: %v\n", circ, r.GetNbConstraints(), sha256.Sum256(a1), sha256.Sum256(a2), sha256.Sum256(b1), sha256.Sum256(b2), ok)
		if !ok {
			os.Exit(1)
		}
	}
	fmt.Println("CHECK OK: byte for byte gnark's Initialize")
}

func run(phase1, circuit, outP2, outEvals string) {
	logf("reading phase1 %s", phase1)
	p1 := &mpcsetup.Phase1{}
	f, err := os.Open(phase1)
	if err != nil {
		panic(err)
	}
	if _, err := p1.ReadFrom(bufio.NewReaderSize(f, 1<<22)); err != nil {
		panic(err)
	}
	f.Close()
	commons := ceremony.SealPhase1(p1, ceremony.Phase1Beacon())
	p1 = nil
	logf("reading the circuit %s", circuit)
	r := readR1CS(circuit)
	p, e := initialize(r, &commons)
	logf("writing %s and %s", outP2, outEvals)
	pf, err := os.Create(outP2)
	if err != nil {
		panic(err)
	}
	w := bufio.NewWriterSize(pf, 1<<22)
	if _, err := p.WriteTo(w); err != nil {
		panic(err)
	}
	w.Flush()
	pf.Close()
	ef, err := os.Create(outEvals)
	if err != nil {
		panic(err)
	}
	ew := bufio.NewWriterSize(ef, 1<<22)
	if err := ceremony.WritePhase2Evaluations(&e, ew); err != nil {
		panic(err)
	}
	ew.Flush()
	ef.Close()
	logf("done")
}

func main() {
	switch {
	case len(os.Args) == 2 && os.Args[1] == "check":
		check()
	case len(os.Args) == 6 && os.Args[1] == "run":
		run(os.Args[2], os.Args[3], os.Args[4], os.Args[5])
	default:
		fmt.Fprintln(os.Stderr, "usage: fastp2n check | fastp2n run <phase1> <circuit.bin> <phase2 out> <evals out>")
		os.Exit(2)
	}
}
