// tacit-ceremony: the Tacit Praxis ceremony's tool.
//
//	tacit-ceremony contribute --coordinator <url> --name <name> [--handle @x]   join, contribute, print your receipt
//	tacit-ceremony contribute-file <in> <out>                                    contribute offline (prints the contribution hash)
//	tacit-ceremony verify <prev> <next>                                          check one contribution
//	tacit-ceremony verify-chain <dir> <from> <to>                                check phase2-<from> .. phase2-<to> link by link
//	tacit-ceremony init <dir> <base-file> <base-index> <label>                   coordinator: start a chain from a transcript's last file
//	tacit-ceremony serve <dir> <addr>                                            coordinator: run the queue and API
//	tacit-ceremony beacon <bitcoin-block-hash> <drand-round>                     the ceremony's beacon: SHA-256("tacit-praxis-beacon-v1" || block hash || drand randomness)
//	tacit-ceremony seal <phase1> <head> <evals> <phase1-drand-round> <beacon-hex> <out-dir>   extract the keys (pk, vk)
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	ceremony "tacit.finance/ceremony"
)

func die(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...); os.Exit(1) }

func main() {
	if len(os.Args) < 2 {
		die("usage: tacit-ceremony contribute|contribute-file|verify|verify-chain|init|serve ...")
	}
	switch os.Args[1] {
	case "contribute":
		fs := flag.NewFlagSet("contribute", flag.ExitOnError)
		coord := fs.String("coordinator", "", "the coordinator's URL")
		name := fs.String("name", "", "your name, as it will appear in the transcript")
		handle := fs.String("handle", "", "an optional handle (e.g. @you)")
		_ = fs.Parse(os.Args[2:])
		if *coord == "" || *name == "" {
			die("--coordinator and --name are required")
		}
		wd, _ := os.MkdirTemp("", "tacit-ceremony-")
		defer os.RemoveAll(wd)
		r, err := ceremony.ContributeRemote(*coord, *name, *handle, wd, 15*time.Second, func(s string) { fmt.Println(s) })
		if err != nil {
			die("%v", err)
		}
		b, _ := json.MarshalIndent(r, "", "  ")
		fmt.Printf("\nYour contribution is in the Tacit Praxis ceremony. Your receipt:\n%s\n", b)
	case "contribute-file":
		if len(os.Args) != 4 {
			die("usage: tacit-ceremony contribute-file <in> <out>")
		}
		h, err := ceremony.Contribute(os.Args[2], os.Args[3])
		if err != nil {
			die("%v", err)
		}
		fmt.Println("contribution hash:", h)
	case "verify":
		if len(os.Args) != 4 {
			die("usage: tacit-ceremony verify <prev> <next>")
		}
		p, err := ceremony.Read(os.Args[2])
		if err != nil {
			die("%v", err)
		}
		n, err := ceremony.Read(os.Args[3])
		if err != nil {
			die("%v", err)
		}
		if err := ceremony.Verify(p, n); err != nil {
			die("does not verify: %v", err)
		}
		h, _ := ceremony.Hash(n)
		fmt.Println("ok, contribution hash", h)
	case "verify-chain":
		if len(os.Args) != 5 {
			die("usage: tacit-ceremony verify-chain <dir> <from> <to>")
		}
		from, _ := strconv.Atoi(os.Args[3])
		to, _ := strconv.Atoi(os.Args[4])
		prev, err := ceremony.Read(filepath.Join(os.Args[2], fmt.Sprintf("phase2-%d", from)))
		if err != nil {
			die("%v", err)
		}
		for i := from + 1; i <= to; i++ {
			next, err := ceremony.Read(filepath.Join(os.Args[2], fmt.Sprintf("phase2-%d", i)))
			if err != nil {
				die("%v", err)
			}
			if err := ceremony.Verify(prev, next); err != nil {
				die("phase2-%d does not verify: %v", i, err)
			}
			h, _ := ceremony.Hash(next)
			fmt.Printf("ok phase2-%d %s\n", i, h)
			prev = next
		}
		fmt.Println("the chain verifies")
	case "init":
		if len(os.Args) != 6 {
			die("usage: tacit-ceremony init <dir> <base-file> <base-index> <label>")
		}
		idx, err := strconv.Atoi(os.Args[4])
		if err != nil {
			die("base-index: %v", err)
		}
		c, err := ceremony.Init(os.Args[2], os.Args[3], idx, os.Args[5])
		if err != nil {
			die("%v", err)
		}
		s := c.State()
		fmt.Printf("chain started at phase2-%d (sha256 %s); coordinator key %s\n", s.BaseIndex, s.BaseSHA256, s.CoordPubKey)
	case "serve":
		if len(os.Args) != 4 {
			die("usage: tacit-ceremony serve <dir> <addr>")
		}
		c, err := ceremony.Open(os.Args[2])
		if err != nil {
			die("%v", err)
		}
		fmt.Println("serving on", os.Args[3])
		die("%v", http.ListenAndServe(os.Args[3], c.Handler()))
	case "beacon":
		if len(os.Args) != 4 {
			die("usage: tacit-ceremony beacon <bitcoin-block-hash> <drand-round>")
		}
		bh, err := hex.DecodeString(strings.TrimPrefix(os.Args[2], "0x"))
		if err != nil || len(bh) != 32 {
			die("the Bitcoin block hash is 32 bytes of hex")
		}
		round, err := strconv.ParseUint(os.Args[3], 10, 64)
		if err != nil {
			die("drand round: %v", err)
		}
		rnd, err := ceremony.DrandRandomness(round)
		if err != nil {
			die("%v", err)
		}
		h := sha256.New()
		h.Write([]byte("tacit-praxis-beacon-v1"))
		h.Write(bh)
		h.Write(rnd)
		fmt.Println(hex.EncodeToString(h.Sum(nil)))
	case "seal":
		if len(os.Args) != 8 {
			die("usage: tacit-ceremony seal <phase1> <head> <evals> <phase1-drand-round> <beacon-hex> <out-dir>")
		}
		r1, err := strconv.ParseUint(os.Args[5], 10, 64)
		if err != nil {
			die("phase1 drand round: %v", err)
		}
		b1, err := ceremony.DrandRandomness(r1)
		if err != nil {
			die("%v", err)
		}
		b2, err := hex.DecodeString(os.Args[6])
		if err != nil || len(b2) != 32 {
			die("the beacon is 32 bytes of hex")
		}
		pk, vk, err := ceremony.Seal(os.Args[2], os.Args[3], os.Args[4], b1, b2)
		if err != nil {
			die("%v", err)
		}
		_ = os.MkdirAll(os.Args[7], 0o755)
		for name, k := range map[string]interface {
			WriteTo(io.Writer) (int64, error)
		}{"groth16_pk.bin": pk, "groth16_vk.bin": vk} {
			f, err := os.Create(filepath.Join(os.Args[7], name))
			if err != nil {
				die("%v", err)
			}
			if _, err := k.WriteTo(f); err != nil {
				die("%v", err)
			}
			f.Close()
			sum, _ := ceremony.FileSHA256(filepath.Join(os.Args[7], name))
			fmt.Printf("%s sha256 %s\n", name, sum)
		}
	default:
		die("unknown command %q", os.Args[1])
	}
}
