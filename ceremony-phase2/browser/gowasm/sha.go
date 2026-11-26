//go:build js && wasm

package main

import (
	"crypto/sha256"
	"hash"
	"syscall/js"
)

var sh hash.Hash

// shaReset(); shaUpdate(bytes); shaSum() -> 32 bytes: the previous file's hash (the challenge), streamed.
func shaReset(_ js.Value, _ []js.Value) any { sh = sha256.New(); return nil }

func shaUpdate(_ js.Value, a []js.Value) any {
	if sh == nil {
		sh = sha256.New()
	}
	sh.Write(bytesIn(a[0]))
	return nil
}

func shaSum(_ js.Value, _ []js.Value) any { return bytesOut(sh.Sum(nil)) }
