// fixture: the files of a small stand-in for the ceremony, so the whole flow (init, serve, contribute, close, beacon,
// seal) can be rehearsed with the real tool in minutes. It is a toy circuit, not SP1's.
//
//	fixture make <dir>                 phase1, phase2-17 (the base), evals, circuit.r1cs
//	fixture prove <dir> <pk> <vk>      a proof with the sealed keys verifies, and does not for another statement
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	groth16bn254 "github.com/consensys/gnark/backend/groth16/bn254"
	"github.com/consensys/gnark/backend/groth16/bn254/mpcsetup"
	cs "github.com/consensys/gnark/constraint/bn254"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	ceremony "tacit.finance/ceremony"
)

// knowledge of x with x^3 + x + 5 = y, y public
type cube struct {
	X frontend.Variable
	Y frontend.Variable `gnark:",public"`
}

func (c *cube) Define(api frontend.API) error {
	api.AssertIsEqual(api.Add(api.Mul(c.X, c.X, c.X), c.X, 5), c.Y)
	// FIXTURE_PAD=n adds n constraints, for a file with enough points to cross chunk boundaries (the default is the toy circuit)
	pad, _ := strconv.Atoi(os.Getenv("FIXTURE_PAD"))
	acc := c.X
	for i := 0; i < pad; i++ {
		acc = api.Mul(acc, acc, c.X)
	}
	api.AssertIsEqual(api.Sub(acc, acc), 0)
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(a []string) error {
	switch {
	case len(a) == 2 && a[0] == "make":
		return mk(a[1])
	case len(a) == 4 && a[0] == "prove":
		return prove(a[1], a[2], a[3])
	}
	return errors.New("usage: fixture make <dir> | fixture prove <dir> <pk> <vk>")
}

func compile() (*cs.R1CS, error) {
	c, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &cube{})
	if err != nil {
		return nil, err
	}
	return c.(*cs.R1CS), nil
}

func writeTo(path string, w io.WriterTo) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if _, err := w.WriteTo(f); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// mk: Phase 1 with one contribution, sealed with the same Phase 1 beacon as the real chain (drand round 1000), then the
// initial Phase 2 with one contribution: the base the chain starts from, at index 17 as in the real ceremony.
func mk(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	ccs, err := compile()
	if err != nil {
		return err
	}
	var p1 mpcsetup.Phase1
	p1.Initialize(ecc.NextPowerOfTwo(uint64(ccs.GetNbConstraints())))
	p1.Contribute()
	if err := writeTo(filepath.Join(dir, "phase1"), &p1); err != nil {
		return err
	}
	commons := p1.Seal(ceremony.Phase1Beacon())
	var p2 mpcsetup.Phase2
	evals := p2.Initialize(ccs, &commons)
	p2.Contribute()
	if err := ceremony.Write(&p2, filepath.Join(dir, "phase2-17")); err != nil {
		return err
	}
	ef, err := os.Create(filepath.Join(dir, "evals"))
	if err != nil {
		return err
	}
	if err := ceremony.WritePhase2Evaluations(&evals, ef); err != nil {
		ef.Close()
		return err
	}
	if err := ef.Close(); err != nil {
		return err
	}
	fmt.Println("fixture written to", dir)
	return nil
}

func readKey[T io.ReaderFrom](path string, k T) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = k.ReadFrom(bufio.NewReader(f))
	return err
}

func prove(dir, pkPath, vkPath string) error {
	ccs, err := compile()
	if err != nil {
		return err
	}
	pk, vk := &groth16bn254.ProvingKey{}, &groth16bn254.VerifyingKey{}
	if err := readKey(pkPath, pk); err != nil {
		return fmt.Errorf("pk: %w", err)
	}
	if err := readKey(vkPath, vk); err != nil {
		return fmt.Errorf("vk: %w", err)
	}
	w, _ := frontend.NewWitness(&cube{X: 3, Y: 35}, ecc.BN254.ScalarField())
	proof, err := groth16.Prove(ccs, pk, w)
	if err != nil {
		return fmt.Errorf("prove: %w", err)
	}
	pub, _ := w.Public()
	if err := groth16.Verify(proof, vk, pub); err != nil {
		return fmt.Errorf("the proof does not verify under the sealed vk: %w", err)
	}
	bad, _ := frontend.NewWitness(&cube{Y: 36}, ecc.BN254.ScalarField(), frontend.PublicOnly())
	if groth16.Verify(proof, vk, bad) == nil {
		return errors.New("the proof verifies for another statement")
	}
	fmt.Println("a proof with the sealed keys verifies, and not for another statement")
	return nil
}
