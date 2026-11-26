// Package ceremony runs Tacit's Phase-2 trusted-setup ceremony for a Groth16 circuit (the Tacit Praxis ceremony extends
// Succinct's SP1 v6.1.0 wrapper transcript from its last file, phase2-17). It uses gnark's mpcsetup as Succinct's tool
// does, so the files are the same format and each contribution is checked against the one before it with
// Phase2.Verify; the contribution hash is SHA-256 of the serialized accumulator, as Succinct's tool prints it. Extending
// the transcript yields a new key (a new delta): it does not change Succinct's deployed SP1 verifier or its key.
package ceremony

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"

	mpcsetup "github.com/consensys/gnark/backend/groth16/bn254/mpcsetup"
)

// Read a Phase2 accumulator from a file. The file's layout is checked against its size first (CheckShape), so a length
// prefix that claims more points than the file holds is refused before anything is allocated for them.
func Read(path string) (*mpcsetup.Phase2, error) {
	if _, err := CheckShape(path); err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	p := &mpcsetup.Phase2{}
	if _, err := p.ReadFrom(bufio.NewReaderSize(f, 1<<20)); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNotAccumulator, err)
	}
	return p, nil
}

// Write a Phase2 accumulator to a file (atomically: a temporary file, synced, renamed into place).
func Write(p *mpcsetup.Phase2, path string) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 1<<20)
	if _, err := p.WriteTo(w); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := w.Flush(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

// Hash is the contribution hash: SHA-256 of the serialized accumulator (as semaphore-gnark-11 computes it).
func Hash(p *mpcsetup.Phase2) (string, error) {
	h := sha256.New()
	w := bufio.NewWriterSize(h, 1<<20)
	if _, err := p.WriteTo(w); err != nil {
		return "", err
	}
	if err := w.Flush(); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// FileSHA256 of a file on disk.
func FileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Contribute reads the head, adds this machine's contribution (fresh randomness, discarded when the process ends) and
// writes the result. It returns the contribution hash.
func Contribute(in, out string) (string, error) {
	p, err := Read(in)
	if err != nil {
		return "", err
	}
	p.Contribute()
	if err := Write(p, out); err != nil {
		return "", err
	}
	return Hash(p)
}

// Verify that next is a valid contribution on top of prev. next must carry its challenge (the hash of prev): gnark's
// Phase2.Verify accepts a file without one and fills it in, which would leave a file on disk that the link after it
// cannot be checked against.
func Verify(prev, next *mpcsetup.Phase2) error {
	if len(next.Challenge) != sha256.Size {
		return errors.New("the contribution does not carry the hash of the file it builds on")
	}
	return prev.Verify(next)
}

// Seal extracts the proving and verifying keys: the Phase 1 file sealed with its own beacon (for a chain that extends
// Succinct's transcript, the transcript's Phase 1 beacon, so the commons are the ones every Phase 2 file was built on),
// then the head sealed with the ceremony's beacon.
func Seal(phase1Path, headPath, evalsPath string, phase1Beacon, phase2Beacon []byte) (pk, vk interface {
	WriteTo(io.Writer) (int64, error)
}, err error) {
	p1 := &mpcsetup.Phase1{}
	f, err := os.Open(phase1Path)
	if err != nil {
		return nil, nil, err
	}
	if _, err := p1.ReadFrom(bufio.NewReaderSize(f, 1<<20)); err != nil {
		f.Close()
		return nil, nil, err
	}
	f.Close()
	head, err := Read(headPath)
	if err != nil {
		return nil, nil, err
	}
	ef, err := os.Open(evalsPath)
	if err != nil {
		return nil, nil, err
	}
	defer ef.Close()
	est, err := ef.Stat()
	if err != nil {
		return nil, nil, err
	}
	evals, err := ReadPhase2Evaluations(bufio.NewReaderSize(ef, 1<<20), est.Size())
	if err != nil {
		return nil, nil, err
	}
	commons := SealPhase1(p1, phase1Beacon)
	p, v := head.Seal(&commons, evals, phase2Beacon)
	return p, v, nil
}
