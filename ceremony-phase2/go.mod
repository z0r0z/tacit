module tacit.finance/ceremony

go 1.24.0

require github.com/consensys/gnark v0.14.0

require (
	github.com/bits-and-blooms/bitset v1.24.0 // indirect
	github.com/blang/semver/v4 v4.0.0 // indirect
	github.com/consensys/gnark-crypto v0.19.3-0.20251115174214-022ec58e8c19 // indirect
	github.com/fxamacker/cbor/v2 v2.9.0 // indirect
	github.com/google/pprof v0.0.0-20250820193118-f64d9cf942d6 // indirect
	github.com/mattn/go-colorable v0.1.14 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/ronanh/intcomp v1.1.1 // indirect
	github.com/rs/zerolog v1.34.0 // indirect
	github.com/x448/float16 v0.8.4 // indirect
	golang.org/x/crypto v0.45.0 // indirect
	golang.org/x/sync v0.16.0 // indirect
	golang.org/x/sys v0.38.0 // indirect
)

// the same gnark as Succinct's semaphore-gnark-11 (github.com/succinctlabs/semaphore-gnark-11 go.mod), so every file
// this tool reads or writes is byte-compatible with the SP1 v6.1.0 Phase-2 transcript it extends
replace github.com/consensys/gnark => github.com/p4u/gnark v0.0.0-20251217225531-cd7874155e26
