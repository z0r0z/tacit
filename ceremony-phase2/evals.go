// Adapted from github.com/succinctlabs/semaphore-gnark-11 (evals.go), Apache License 2.0. Kept byte-compatible with its files.
package ceremony

import (
	"encoding/binary"
	"io"

	curve "github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark/backend/groth16/bn254/mpcsetup"
)

// writePhase2Evaluations serializes Phase2Evaluations to a writer
// This is needed because the new gnark API doesn't provide WriteTo/ReadFrom for Phase2Evaluations
func WritePhase2Evaluations(evals *mpcsetup.Phase2Evaluations, w io.Writer) error {
	enc := curve.NewEncoder(w)

	// Write G1.A
	if err := binary.Write(w, binary.BigEndian, uint32(len(evals.G1.A))); err != nil {
		return err
	}
	for i := range evals.G1.A {
		if err := enc.Encode(&evals.G1.A[i]); err != nil {
			return err
		}
	}

	// Write G1.B
	if err := binary.Write(w, binary.BigEndian, uint32(len(evals.G1.B))); err != nil {
		return err
	}
	for i := range evals.G1.B {
		if err := enc.Encode(&evals.G1.B[i]); err != nil {
			return err
		}
	}

	// Write G1.VKK
	if err := binary.Write(w, binary.BigEndian, uint32(len(evals.G1.VKK))); err != nil {
		return err
	}
	for i := range evals.G1.VKK {
		if err := enc.Encode(&evals.G1.VKK[i]); err != nil {
			return err
		}
	}

	// Write G1.CKK (slice of slices)
	if err := binary.Write(w, binary.BigEndian, uint32(len(evals.G1.CKK))); err != nil {
		return err
	}
	for i := range evals.G1.CKK {
		if err := binary.Write(w, binary.BigEndian, uint32(len(evals.G1.CKK[i]))); err != nil {
			return err
		}
		for j := range evals.G1.CKK[i] {
			if err := enc.Encode(&evals.G1.CKK[i][j]); err != nil {
				return err
			}
		}
	}

	// Write G2.B
	if err := binary.Write(w, binary.BigEndian, uint32(len(evals.G2.B))); err != nil {
		return err
	}
	for i := range evals.G2.B {
		if err := enc.Encode(&evals.G2.B[i]); err != nil {
			return err
		}
	}

	// Write PublicAndCommitmentCommitted (slice of slices of int)
	if err := binary.Write(w, binary.BigEndian, uint32(len(evals.PublicAndCommitmentCommitted))); err != nil {
		return err
	}
	for i := range evals.PublicAndCommitmentCommitted {
		if err := binary.Write(w, binary.BigEndian, uint32(len(evals.PublicAndCommitmentCommitted[i]))); err != nil {
			return err
		}
		for j := range evals.PublicAndCommitmentCommitted[i] {
			if err := binary.Write(w, binary.BigEndian, int32(evals.PublicAndCommitmentCommitted[i][j])); err != nil {
				return err
			}
		}
	}

	return nil
}

// readPhase2Evaluations deserializes Phase2Evaluations from a reader
func ReadPhase2Evaluations(r io.Reader) (*mpcsetup.Phase2Evaluations, error) {
	dec := curve.NewDecoder(r)
	evals := &mpcsetup.Phase2Evaluations{}

	// Read G1.A
	var lenA uint32
	if err := binary.Read(r, binary.BigEndian, &lenA); err != nil {
		return nil, err
	}
	evals.G1.A = make([]curve.G1Affine, lenA)
	for i := range evals.G1.A {
		if err := dec.Decode(&evals.G1.A[i]); err != nil {
			return nil, err
		}
	}

	// Read G1.B
	var lenB uint32
	if err := binary.Read(r, binary.BigEndian, &lenB); err != nil {
		return nil, err
	}
	evals.G1.B = make([]curve.G1Affine, lenB)
	for i := range evals.G1.B {
		if err := dec.Decode(&evals.G1.B[i]); err != nil {
			return nil, err
		}
	}

	// Read G1.VKK
	var lenVKK uint32
	if err := binary.Read(r, binary.BigEndian, &lenVKK); err != nil {
		return nil, err
	}
	evals.G1.VKK = make([]curve.G1Affine, lenVKK)
	for i := range evals.G1.VKK {
		if err := dec.Decode(&evals.G1.VKK[i]); err != nil {
			return nil, err
		}
	}

	// Read G1.CKK (slice of slices)
	var lenCKK uint32
	if err := binary.Read(r, binary.BigEndian, &lenCKK); err != nil {
		return nil, err
	}
	evals.G1.CKK = make([][]curve.G1Affine, lenCKK)
	for i := range evals.G1.CKK {
		var innerLen uint32
		if err := binary.Read(r, binary.BigEndian, &innerLen); err != nil {
			return nil, err
		}
		evals.G1.CKK[i] = make([]curve.G1Affine, innerLen)
		for j := range evals.G1.CKK[i] {
			if err := dec.Decode(&evals.G1.CKK[i][j]); err != nil {
				return nil, err
			}
		}
	}

	// Read G2.B
	var lenG2B uint32
	if err := binary.Read(r, binary.BigEndian, &lenG2B); err != nil {
		return nil, err
	}
	evals.G2.B = make([]curve.G2Affine, lenG2B)
	for i := range evals.G2.B {
		if err := dec.Decode(&evals.G2.B[i]); err != nil {
			return nil, err
		}
	}

	// Read PublicAndCommitmentCommitted (slice of slices of int)
	var lenPACC uint32
	if err := binary.Read(r, binary.BigEndian, &lenPACC); err != nil {
		return nil, err
	}
	evals.PublicAndCommitmentCommitted = make([][]int, lenPACC)
	for i := range evals.PublicAndCommitmentCommitted {
		var innerLen uint32
		if err := binary.Read(r, binary.BigEndian, &innerLen); err != nil {
			return nil, err
		}
		evals.PublicAndCommitmentCommitted[i] = make([]int, innerLen)
		for j := range evals.PublicAndCommitmentCommitted[i] {
			var val int32
			if err := binary.Read(r, binary.BigEndian, &val); err != nil {
				return nil, err
			}
			evals.PublicAndCommitmentCommitted[i][j] = int(val)
		}
	}

	return evals, nil
}
