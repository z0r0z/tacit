// r1csstats: counts what gnark's mpcsetup Phase2.Initialize does in its serial loop for a circuit, and times those
// operations on this machine, to estimate how long that loop takes. Scratch tool.
package main

import (
	"bufio"
	"fmt"
	"math/big"
	"os"
	"time"

	curve "github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/constraint"
	cs "github.com/consensys/gnark/constraint/bn254"
)

func main() {
	f, err := os.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	r := &cs.R1CS{}
	t0 := time.Now()
	if _, err := r.ReadFrom(bufio.NewReaderSize(f, 1<<22)); err != nil {
		panic(err)
	}
	fmt.Printf("read in %s: %d constraints\n", time.Since(t0).Round(time.Second), r.GetNbConstraints())
	// per category: trivial (0, 1, -1, 2) needs adds only; other needs a scalar multiplication
	var lT, lO, rT, rO, oT, oO int64
	cat := func(t constraint.Term) bool {
		switch t.CoeffID() {
		case constraint.CoeffIdZero, constraint.CoeffIdOne, constraint.CoeffIdMinusOne, constraint.CoeffIdTwo:
			return false
		}
		return true
	}
	it := r.GetR1CIterator()
	for c := it.Next(); c != nil; c = it.Next() {
		for _, t := range c.L {
			if cat(t) {
				lO++
			} else {
				lT++
			}
		}
		for _, t := range c.R {
			if cat(t) {
				rO++
			} else {
				rT++
			}
		}
		for _, t := range c.O {
			if cat(t) {
				oO++
			} else {
				oT++
			}
		}
	}
	fmt.Printf("L terms: %d trivial, %d other; R: %d, %d; O: %d, %d\n", lT, lO, rT, rO, oT, oO)
	// time the operations (single thread, as the loop runs)
	_, _, g1, g2 := curve.Generators()
	var k fr.Element
	k.SetRandom()
	var kb big.Int
	k.BigInt(&kb)
	const N = 2000
	var a1, b1 curve.G1Affine
	b1 = g1
	s := time.Now()
	for i := 0; i < N; i++ {
		a1.Add(&a1, &b1)
	}
	add1 := time.Since(s) / N
	var a2, b2 curve.G2Affine
	b2 = g2
	s = time.Now()
	for i := 0; i < N; i++ {
		a2.Add(&a2, &b2)
	}
	add2 := time.Since(s) / N
	s = time.Now()
	for i := 0; i < N/10; i++ {
		a1.ScalarMultiplication(&b1, &kb)
	}
	mul1 := time.Since(s) / (N / 10)
	s = time.Now()
	for i := 0; i < N/10; i++ {
		a2.ScalarMultiplication(&b2, &kb)
	}
	mul2 := time.Since(s) / (N / 10)
	fmt.Printf("this machine, one thread: G1 add %s, G2 add %s, G1 mul %s, G2 mul %s\n", add1, add2, mul1, mul2)
	// the loop: L terms: 2 G1 accumulates; R: 2 G1 + 1 G2; O: 1 G1. An "other" accumulate = mul + add, trivial = 1 or 2 adds.
	g1Triv := 2*lT + 2*rT + oT
	g1Oth := 2*lO + 2*rO + oO
	est := time.Duration(g1Triv)*add1 + time.Duration(g1Oth)*(mul1+add1) + time.Duration(rT)*add2 + time.Duration(rO)*(mul2+add2)
	fmt.Printf("estimated serial loop: %s (G1: %d trivial + %d with a multiplication; G2: %d trivial + %d with one)\n", est.Round(time.Minute), g1Triv, g1Oth, rT, rO)
}
