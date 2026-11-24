package ceremony

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
)

// ErrNotAccumulator: the file is not laid out as a Phase2 accumulator.
var ErrNotAccumulator = errors.New("the file is not a Phase2 accumulator")

// The layout gnark's Phase2.WriteTo produces (bn254; each point compressed, or uncompressed when its top two bits are 0):
//
//	u16 commitments (c)
//	G1 delta; []G1 PKK; []G1 Z; G2 delta            (a []G1 is a u32 count, then the points)
//	c × []G1 SigmaCKK; c × G2 sigma
//	delta proof (G1, G2); c × sigma proof (G1, G2)
//	u8 challenge length, the challenge
//
// CheckShape walks a file through it without keeping anything, refusing any count that claims more than the bytes left,
// and returns the size the layout accounts for, which must be the file's size.
func CheckShape(path string) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return 0, err
	}
	s := &shape{r: bufio.NewReaderSize(f, 1<<20), size: st.Size()}
	if err := s.walk(); err != nil {
		return 0, fmt.Errorf("%w: %v", ErrNotAccumulator, err)
	}
	if s.n != s.size {
		return 0, fmt.Errorf("%w: %d bytes after the accumulator", ErrNotAccumulator, s.size-s.n)
	}
	return s.n, nil
}

const (
	g1Compressed, g2Compressed = 32, 64
)

type shape struct {
	r       *bufio.Reader
	n, size int64
}

var errShort = errors.New("a count runs past the end of the file")

func (s *shape) read(b []byte) error {
	if s.n+int64(len(b)) > s.size {
		return errShort
	}
	if _, err := io.ReadFull(s.r, b); err != nil {
		return err
	}
	s.n += int64(len(b))
	return nil
}

func (s *shape) skip(k int64) error {
	if s.n+k > s.size {
		return errShort
	}
	for k > 0 {
		step := k
		if step > 1<<30 {
			step = 1 << 30
		}
		d, err := s.r.Discard(int(step))
		s.n += int64(d)
		k -= int64(d)
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *shape) point(compressed int64) error {
	if s.n >= s.size {
		return errShort
	}
	b, err := s.r.Peek(1)
	if err != nil {
		return err
	}
	if b[0]>>6 == 0 { // uncompressed
		return s.skip(2 * compressed)
	}
	return s.skip(compressed)
}

func (s *shape) g1s() error {
	var b [4]byte
	if err := s.read(b[:]); err != nil {
		return err
	}
	k := int64(binary.BigEndian.Uint32(b[:]))
	if k*g1Compressed > s.size-s.n {
		return errShort
	}
	for i := int64(0); i < k; i++ {
		if err := s.point(g1Compressed); err != nil {
			return err
		}
	}
	return nil
}

func (s *shape) walk() error {
	var c2 [2]byte
	if err := s.read(c2[:]); err != nil {
		return err
	}
	c := int(binary.BigEndian.Uint16(c2[:]))
	if int64(c)*(4+g2Compressed+g1Compressed+g2Compressed) > s.size-s.n {
		return errShort
	}
	if err := s.point(g1Compressed); err != nil {
		return err
	}
	if err := s.g1s(); err != nil { // PKK
		return err
	}
	if err := s.g1s(); err != nil { // Z
		return err
	}
	if err := s.point(g2Compressed); err != nil {
		return err
	}
	for i := 0; i < c; i++ {
		if err := s.g1s(); err != nil {
			return err
		}
	}
	for i := 0; i < c; i++ {
		if err := s.point(g2Compressed); err != nil {
			return err
		}
	}
	for i := 0; i <= c; i++ { // the delta proof, then one per commitment
		if err := s.point(g1Compressed); err != nil {
			return err
		}
		if err := s.point(g2Compressed); err != nil {
			return err
		}
	}
	var l [1]byte
	if err := s.read(l[:]); err != nil {
		return err
	}
	return s.skip(int64(l[0]))
}
