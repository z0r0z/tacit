//go:build js && wasm

// The browser's small crypto, built from the same gnark code the coordinator
// verifies with, so nothing is ported by hand: the scalar for the update, the
// commitment [delta]1, the G2 delta, and the proof of knowledge (HashToG2).
// scaleG1 is the bulk path, kept here as the reference the fast scaler is tested against.
package main

import (
	"math/big"
	"syscall/js"

	curve "github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
)

func bytesIn(v js.Value) []byte {
	b := make([]byte, v.Get("length").Int())
	js.CopyBytesToGo(b, v)
	return b
}

func bytesOut(b []byte) js.Value {
	a := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(a, b)
	return a
}

func fail(msg string) js.Value { return js.Global().Get("Error").New(msg) }

// scaleG1(chunk, scalarBE32) -> chunk: every 32-byte compressed point times the scalar.
func scaleG1(_ js.Value, a []js.Value) any {
	in, sc := bytesIn(a[0]), bytesIn(a[1])
	if len(in)%32 != 0 || len(sc) != 32 {
		return fail("bad sizes")
	}
	var k big.Int
	k.SetBytes(sc)
	out := make([]byte, len(in))
	var p curve.G1Affine
	for i := 0; i < len(in); i += 32 {
		if _, err := p.SetBytes(in[i : i+32]); err != nil {
			return fail("point " + err.Error())
		}
		p.ScalarMultiplication(&p, &k)
		b := p.Bytes()
		copy(out[i:], b[:])
	}
	return bytesOut(out)
}

// deltaProof(deltaBE32, challenge, g2delta128raw?) -> {commitment(32), pok(64), g2delta(64)}
// g2 input: 64-byte compressed G2.Delta from the previous file.
func deltaProof(_ js.Value, a []js.Value) any {
	var d fr.Element
	d.SetBytes(bytesIn(a[0]))
	chal := bytesIn(a[1])
	var prevG2 curve.G2Affine
	if _, err := prevG2.SetBytes(bytesIn(a[2])); err != nil {
		return fail("g2 " + err.Error())
	}
	var di big.Int
	d.BigInt(&di)
	_, _, g1, _ := curve.Generators()
	var com curve.G1Affine
	com.ScalarMultiplication(&g1, &di)
	// pokBase: HashToG2(Marshal(com) || challenge, dst)
	buf := append(com.Marshal(), chal...)
	r, err := curve.HashToG2(buf, []byte{byte(a[3].Int())})
	if err != nil {
		return fail(err.Error())
	}
	var pok, ng2 curve.G2Affine
	pok.ScalarMultiplication(&r, &di)
	ng2.ScalarMultiplication(&prevG2, &di)
	cb, pb, gb := com.Bytes(), pok.Bytes(), ng2.Bytes()
	o := js.Global().Get("Object").New()
	o.Set("commitment", bytesOut(cb[:]))
	o.Set("pok", bytesOut(pb[:]))
	o.Set("g2delta", bytesOut(gb[:]))
	return o
}

func main() {
	js.Global().Set("tacitGo", map[string]any{
		"scaleG1":    js.FuncOf(scaleG1),
		"deltaProof": js.FuncOf(deltaProof),
		"shaReset":   js.FuncOf(shaReset),
		"shaUpdate":  js.FuncOf(shaUpdate),
		"shaSum":     js.FuncOf(shaSum),
	})
	select {}
}
