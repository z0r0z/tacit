// Package ceremony runs Tacit's Phase-2 trusted-setup ceremony for a Groth16 circuit (the Tacit Praxis ceremony extends
// Succinct's SP1 v6.1.0 wrapper transcript). It uses gnark's mpcsetup as Succinct's tool does, so a contribution here is a
// contribution to the same chain: each file is a Phase2 accumulator, each contribution is checked against the one
// before it with Phase2.Verify, and the contribution hash is SHA-256 of the serialized accumulator, as Succinct's tool
// prints it, so receipts read the same way in both.
package ceremony

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"

	mpcsetup "github.com/consensys/gnark/backend/groth16/bn254/mpcsetup"
)

// Read a Phase2 accumulator from a file.
func Read(path string) (*mpcsetup.Phase2, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	p := &mpcsetup.Phase2{}
	if _, err := p.ReadFrom(bufio.NewReaderSize(f, 1<<20)); err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	return p, nil
}

// Write a Phase2 accumulator to a file (atomically: a temporary file renamed into place).
func Write(p *mpcsetup.Phase2, path string) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 1<<20)
	if _, err := p.WriteTo(w); err != nil {
		f.Close()
		return err
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Hash is the contribution hash: SHA-256 of the serialized accumulator (as semaphore-gnark-11 computes it).
func Hash(p *mpcsetup.Phase2) (string, error) {
	var buf bytes.Buffer
	if _, err := p.WriteTo(&buf); err != nil {
		return "", err
	}
	h := sha256.Sum256(buf.Bytes())
	return hex.EncodeToString(h[:]), nil
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

// Verify that next is a valid contribution on top of prev.
func Verify(prev, next *mpcsetup.Phase2) error { return prev.Verify(next) }
