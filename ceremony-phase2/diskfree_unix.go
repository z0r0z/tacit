//go:build !windows

package ceremony

import "golang.org/x/sys/unix"

// diskFree: bytes available to this user on the filesystem holding dir.
func diskFree(dir string) (uint64, error) {
	var s unix.Statfs_t
	if err := unix.Statfs(dir, &s); err != nil {
		return 0, err
	}
	return uint64(s.Bavail) * uint64(s.Bsize), nil
}
