package ceremony

import (
	"bufio"
	"io"
	"os"

	groth16 "github.com/consensys/gnark/backend/groth16/bn254"
)

// ReadVerifyingKey reads a BN254 Groth16 verifying key in gnark's format (SP1's groth16_vk.bin), checking every point.
func ReadVerifyingKey(path string) (*groth16.VerifyingKey, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	vk := &groth16.VerifyingKey{}
	if _, err := vk.ReadFrom(bufio.NewReader(f)); err != nil {
		return nil, err
	}
	return vk, nil
}

// Solidity writes the Solidity verifier of a verifying key, the same generator SP1 uses for its Groth16Verifier.sol,
// so the constants (alpha, beta, gamma, delta, the public-input points) can be compared with a deployed verifier's.
func Solidity(vkPath string, w io.Writer) error {
	vk, err := ReadVerifyingKey(vkPath)
	if err != nil {
		return err
	}
	return vk.ExportSolidity(w)
}
