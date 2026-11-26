package ceremony

import (
	"crypto/sha256"
	"math/big"
	"reflect"
	"runtime"
	"sync"
	"unsafe"

	curve "github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark-crypto/ecc/bn254/mpcsetup"
	gmpc "github.com/consensys/gnark/backend/groth16/bn254/mpcsetup"
)

// SealPhase1 is gnark's Phase1.Seal with its scalar multiplications spread over every core.
//
// gnark's Seal applies the beacon's contribution (τ', α', β') to the whole Phase 1 file: each of the 2^24 indices takes four
// multiplications (two of them in G1, one in G2, one more in G1) in one loop on one thread, about 67 million in G1 and 17 million in
// G2 (hours on SP1's file; it is most of what Succinct's key extraction takes). The multiplications do not depend on each other,
// only on τ^i, so each thread takes a range of indices and starts from τ^start. The result is the same values in the same slots:
// TestSealPhase1MatchesGnark compares them with gnark's own Seal.
func SealPhase1(p1 *gmpc.Phase1, beacon []byte) gmpc.SrsCommons {
	sha := sha256.New()
	if _, err := p1.WriteTo(sha); err != nil {
		panic(err)
	}
	c := beaconContributions(sha.Sum(nil), beacon)
	params := phase1Parameters(p1)
	updatePhase1Parallel(params, &c[0], &c[1], &c[2])
	return *params
}

func beaconContributions(hash, beacon []byte) []fr.Element {
	return mpcsetup.BeaconContributions(hash, []byte("Groth16 MPC Setup - Phase 1"), beacon, 3)
}

// phase1Parameters reaches gnark's unexported Phase1.parameters, the SrsCommons that Seal updates in place and returns.
func phase1Parameters(p1 *gmpc.Phase1) *gmpc.SrsCommons {
	f := reflect.ValueOf(p1).Elem().FieldByName("parameters")
	if !f.IsValid() || f.Type() != reflect.TypeOf(gmpc.SrsCommons{}) {
		panic("gnark's Phase1 no longer has a parameters field of type SrsCommons: update seal_fast.go")
	}
	return (*gmpc.SrsCommons)(unsafe.Pointer(f.UnsafeAddr()))
}

// updatePhase1Parallel is SrsCommons.update (phase1.go, gnark) over ranges of indices.
func updatePhase1Parallel(c *gmpc.SrsCommons, tauUpdate, alphaUpdate, betaUpdate *fr.Element) {
	var coeff big.Int
	alphaUpdate.BigInt(&coeff)
	c.G1.AlphaTau[0].ScalarMultiplication(&c.G1.AlphaTau[0], &coeff)
	betaUpdate.BigInt(&coeff)
	c.G1.BetaTau[0].ScalarMultiplication(&c.G1.BetaTau[0], &coeff)
	c.G2.Beta.ScalarMultiplication(&c.G2.Beta, &coeff)

	n := len(c.G2.Tau)
	parallelRange(1, n, func(lo, hi int) {
		pow := powOf(tauUpdate, uint64(lo))
		var scaled fr.Element
		var k big.Int
		for i := lo; i < hi; i++ {
			pow.BigInt(&k)
			c.G1.Tau[i].ScalarMultiplication(&c.G1.Tau[i], &k)
			c.G2.Tau[i].ScalarMultiplication(&c.G2.Tau[i], &k)
			scaled.Mul(&pow, alphaUpdate)
			scaled.BigInt(&k)
			c.G1.AlphaTau[i].ScalarMultiplication(&c.G1.AlphaTau[i], &k)
			scaled.Mul(&pow, betaUpdate)
			scaled.BigInt(&k)
			c.G1.BetaTau[i].ScalarMultiplication(&c.G1.BetaTau[i], &k)
			pow.Mul(&pow, tauUpdate)
		}
	})
	parallelRange(n, len(c.G1.Tau), func(lo, hi int) {
		pow := powOf(tauUpdate, uint64(lo))
		var k big.Int
		for i := lo; i < hi; i++ {
			pow.BigInt(&k)
			c.G1.Tau[i].ScalarMultiplication(&c.G1.Tau[i], &k)
			pow.Mul(&pow, tauUpdate)
		}
	})
}

func powOf(x *fr.Element, e uint64) fr.Element {
	var r fr.Element
	r.Exp(*x, new(big.Int).SetUint64(e))
	return r
}

// parallelRange splits [from, to) over the cores in chunks small enough to balance and runs work on each.
func parallelRange(from, to int, work func(lo, hi int)) {
	if to <= from {
		return
	}
	threads := runtime.GOMAXPROCS(0)
	chunk := (to - from + threads*8 - 1) / (threads * 8)
	if chunk < 1 {
		chunk = 1
	}
	var wg sync.WaitGroup
	next := make(chan [2]int)
	for t := 0; t < threads; t++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for r := range next {
				work(r[0], r[1])
			}
		}()
	}
	for lo := from; lo < to; lo += chunk {
		next <- [2]int{lo, min(lo+chunk, to)}
	}
	close(next)
	wg.Wait()
}

var _ = curve.ID
