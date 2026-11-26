// tacit-ceremony: the Tacit Praxis ceremony's tool.
//
// Contributors:
//
//	tacit-ceremony contribute --coordinator <url> --name <name> [--handle @x]   join, contribute, check and save your receipt
//	tacit-ceremony contribute-file <in> <out>                                    contribute offline (prints the contribution hash)
//	tacit-ceremony upload --coordinator <url> --name <name> [--handle @x] <in> <out>   upload an offline contribution
//	tacit-ceremony verify <prev> <next>                                          check one contribution
//	tacit-ceremony verify-chain <dir> <from> <to>                                check phase2-<from> .. phase2-<to> link by link
//	tacit-ceremony version                                                       the tool's commit and Go version
//
// Coordinator:
//
//	tacit-ceremony init <dir> <base-file> <base-index> <label>                   start a chain from a transcript's last file
//	tacit-ceremony serve [flags] <dir> <addr>                                    run the queue and API
//	tacit-ceremony queue|kick|close --admin <url> ...                            the operator's view, drop a place, close
//	tacit-ceremony ban <prefix | address>                                        refuse new places from a prefix
//	tacit-ceremony close --dir <dir>                                             close a chain whose coordinator is stopped
//	tacit-ceremony beacon [--signature <hex>] <bitcoin-block-hash> <quicknet-round>   the Phase 2 beacon
//	tacit-ceremony seal <phase1> <head> <evals> <beacon-hex> <out-dir>           extract the keys (pk, vk) and the Solidity verifier
//	tacit-ceremony solidity <vk> [out.sol]                                       the Solidity verifier of a verifying key
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	groth16bn254 "github.com/consensys/gnark/backend/groth16/bn254"

	ceremony "tacit.finance/ceremony"
)

type usageErr string

func (u usageErr) Error() string { return "usage: tacit-ceremony " + string(u) }

func main() {
	err := run(os.Args[1:])
	if err == nil {
		return
	}
	fmt.Fprintln(os.Stderr, err)
	if errors.Is(err, context.Canceled) {
		os.Exit(130)
	}
	os.Exit(1)
}

func run(args []string) error {
	if len(args) < 1 {
		return usageErr("contribute|contribute-file|upload|verify|verify-chain|version|init|serve|queue|kick|ban|close|beacon|seal|pkdump|solidity ...")
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "contribute":
		return contribute(rest)
	case "upload":
		return upload(rest)
	case "contribute-file":
		if len(rest) != 2 {
			return usageErr("contribute-file <in> <out>")
		}
		h, err := ceremony.Contribute(rest[0], rest[1])
		if err != nil {
			os.Remove(rest[1] + ".tmp")
			return err
		}
		fmt.Println("contribution hash:", h)
		fmt.Println("next: tacit-ceremony upload --coordinator <url> --name \"<your name>\"", rest[0], rest[1])
		return nil
	case "verify":
		if len(rest) != 2 {
			return usageErr("verify <prev> <next>")
		}
		p, err := ceremony.Read(rest[0])
		if err != nil {
			return err
		}
		n, err := ceremony.Read(rest[1])
		if err != nil {
			return err
		}
		if err := ceremony.Verify(p, n); err != nil {
			return fmt.Errorf("does not verify: %w", err)
		}
		h, _ := ceremony.Hash(n)
		fmt.Println("ok, contribution hash", h)
		return nil
	case "verify-chain":
		return verifyChain(rest)
	case "version":
		fmt.Println(version())
		return nil
	case "init":
		if len(rest) != 4 {
			return usageErr("init <dir> <base-file> <base-index> <label>")
		}
		idx, err := strconv.Atoi(rest[2])
		if err != nil {
			return fmt.Errorf("base-index: %w", err)
		}
		c, err := ceremony.Init(rest[0], rest[1], idx, rest[3])
		if err != nil {
			return err
		}
		s := c.State()
		fmt.Printf("chain started at phase2-%d (sha256 %s); coordinator key %s\n", s.BaseIndex, s.BaseSHA256, s.CoordPubKey)
		return nil
	case "serve":
		return serve(rest)
	case "queue", "kick", "close", "ban":
		return admin(cmd, rest)
	case "beacon":
		return beacon(rest)
	case "seal":
		return seal(rest)
	case "pkdump":
		if len(rest) != 2 {
			return usageErr("pkdump <compressed pk> <out>   (a proving key written by an earlier seal, in SP1's dump format)")
		}
		return pkDump(rest[0], rest[1])
	case "solidity":
		if len(rest) < 1 || len(rest) > 2 {
			return usageErr("solidity <groth16_vk.bin> [out.sol | -]")
		}
		out := "-"
		if len(rest) == 2 {
			out = rest[1]
		}
		return writeSolidity(rest[0], out)
	}
	return fmt.Errorf("unknown command %q", cmd)
}

func version() string {
	v := "tacit-ceremony"
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return v
	}
	v += " " + bi.GoVersion
	for _, s := range bi.Settings {
		switch s.Key {
		case "vcs.revision", "vcs.modified", "GOOS", "GOARCH":
			v += fmt.Sprintf(" %s=%s", s.Key, s.Value)
		}
	}
	return v
}

func contributorFlags(name string) (*flag.FlagSet, *ceremony.ClientOptions, *string) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	o := &ceremony.ClientOptions{}
	fs.StringVar(&o.Coordinator, "coordinator", "", "the coordinator's URL")
	fs.StringVar(&o.Name, "name", "", "your name, as it will appear in the transcript")
	fs.StringVar(&o.Handle, "handle", "", "an optional handle (e.g. @you, or your 0x address for the ceremony's points)")
	fs.StringVar(&o.Lane, "lane", "", `"pool" for a prover-pool machine contributing when idle: it waits behind every person`)
	fs.StringVar(&o.CoordinatorKey, "coordinator-key", ceremony.PinnedCoordinatorKey, "the coordinator's ed25519 public key (hex); the receipt must be signed with it")
	out := fs.String("receipt-dir", ".", "where to save receipt-<index>.json")
	return fs, o, out
}

// session runs fn with a client whose files and queue place are given up on every way out: a return, an error, or
// Ctrl-C / SIGTERM (which may arrive while the contribution is computing, so the handler cleans up and exits itself).
func session(o *ceremony.ClientOptions, fn func(ctx context.Context, c *ceremony.Client) error) error {
	o.Log = func(s string) { fmt.Println(s) }
	o.Progress = os.Stdout
	c := ceremony.NewClient(*o)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sig)
	go func() {
		if _, ok := <-sig; !ok {
			return
		}
		fmt.Fprintln(os.Stderr, "\nstopping: giving up the place in the queue and removing the files")
		cancel()
		c.Cleanup()
		if o.Workdir != "" {
			os.RemoveAll(o.Workdir)
		}
		os.Exit(130)
	}()
	defer c.Cleanup()
	return fn(ctx, c)
}

func saveReceipt(dir string, r *ceremony.Receipt) (string, error) {
	b, _ := json.MarshalIndent(r, "", "  ")
	p := filepath.Join(dir, fmt.Sprintf("receipt-%d.json", r.Index))
	return p, os.WriteFile(p, append(b, '\n'), 0o644)
}

func printReceipt(r *ceremony.Receipt, path, key string) {
	b, _ := json.MarshalIndent(r, "", "  ")
	fmt.Printf("\nYour contribution is in the Tacit Praxis ceremony as phase2-%d. The receipt is signed by the coordinator key %s\nand was checked against your own contribution hash and the head you built on. Saved to %s:\n%s\n", r.Index, key, path, b)
	fmt.Printf(`
next: post your attestation, e.g. as a gist or a post, and add it to ceremony-phase2/attestations/ by pull request:

  Tacit Praxis ceremony, contribution #%d
  contribution hash: %s
  built on: %s
  tool: %s
  machine: <hardware, OS>
  randomness: the tool's own (crypto/rand), discarded when it exited; <anything else you did, e.g. machine wiped>
  signed: <your PGP/SSH/wallet signature of the lines above, or the post's link>
`, r.Index, r.ContributionHash, r.PrevFileSHA256, version())
}

func contribute(args []string) error {
	fs, o, out := contributorFlags("contribute")
	work := fs.String("workdir", "", "where to keep the head and the contribution while working (default: a temporary directory)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if o.Coordinator == "" || o.Name == "" || fs.NArg() != 0 {
		return usageErr("contribute --coordinator <url> --name <name> [--handle @you] [--coordinator-key <hex>] [--workdir <dir>] [--receipt-dir <dir>]")
	}
	wd, err := os.MkdirTemp(*work, "tacit-ceremony-")
	if err != nil {
		return err
	}
	o.Workdir = wd
	defer os.RemoveAll(wd)
	return session(o, func(ctx context.Context, c *ceremony.Client) error {
		r, hash, err := c.Contribute(ctx)
		if hash != "" && err != nil {
			fmt.Fprintln(os.Stderr, "your contribution hash was", hash)
		}
		if err != nil {
			return err
		}
		p, werr := saveReceipt(*out, r)
		if werr != nil {
			fmt.Fprintln(os.Stderr, "could not save the receipt:", werr)
		}
		printReceipt(r, p, o.CoordinatorKey)
		return nil
	})
}

func upload(args []string) error {
	fs, o, out := contributorFlags("upload")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if o.Coordinator == "" || o.Name == "" || fs.NArg() != 2 {
		return usageErr("upload --coordinator <url> --name <name> [--handle @you] [--coordinator-key <hex>] <head-it-was-built-on> <contribution>")
	}
	return session(o, func(ctx context.Context, c *ceremony.Client) error {
		r, err := c.UploadFile(ctx, fs.Arg(0), fs.Arg(1))
		if err != nil {
			return err
		}
		p, werr := saveReceipt(*out, r)
		if werr != nil {
			fmt.Fprintln(os.Stderr, "could not save the receipt:", werr)
		}
		printReceipt(r, p, o.CoordinatorKey)
		return nil
	})
}

func verifyChain(args []string) error {
	if len(args) != 3 {
		return usageErr("verify-chain <dir> <from> <to>")
	}
	from, err1 := strconv.Atoi(args[1])
	to, err2 := strconv.Atoi(args[2])
	if err1 != nil || err2 != nil || to < from {
		return usageErr("verify-chain <dir> <from> <to>")
	}
	prev, err := ceremony.Read(filepath.Join(args[0], fmt.Sprintf("phase2-%d", from)))
	if err != nil {
		return err
	}
	for i := from + 1; i <= to; i++ {
		next, err := ceremony.Read(filepath.Join(args[0], fmt.Sprintf("phase2-%d", i)))
		if err != nil {
			return err
		}
		if err := ceremony.Verify(prev, next); err != nil {
			return fmt.Errorf("phase2-%d does not verify: %w", i, err)
		}
		h, _ := ceremony.Hash(next)
		fmt.Printf("ok phase2-%d %s\n", i, h)
		prev = next
	}
	fmt.Println("the chain verifies")
	return nil
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	var cfg ceremony.Config
	fs.DurationVar(&cfg.Heartbeat, "heartbeat", 60*time.Second, "drop a place whose client has not polled for this long")
	fs.DurationVar(&cfg.ClaimWindow, "claim-window", 3*time.Minute, "time the head of the queue has to claim its slot")
	fs.DurationVar(&cfg.SlotCap, "slot-cap", 2*time.Hour, "time a claimed slot may last")
	fs.IntVar(&cfg.QueueCap, "queue-cap", 100, "places in the queue")
	fs.IntVar(&cfg.PerIP, "per-ip", 1, "places one client address (an IPv6 /48) may hold; -1 for no limit")
	fs.IntVar(&cfg.PerNet24, "per-24", 0, "places one network (an IPv4 /24, an IPv6 /40) may hold at once (0: no limit)")
	fs.IntVar(&cfg.PerNet16, "per-16", 0, "places one larger network (an IPv4 /16, an IPv6 /32) may hold at once (0: no limit)")
	fs.IntVar(&cfg.AcceptedPerIP, "accepted-per-ip", 3, "contributions accepted from one client address over the ceremony (0: no limit)")
	fs.DurationVar(&cfg.DownloadStart, "download-start", 10*time.Minute, "from the claim, time for the head's download to start (or an offline upload)")
	fs.DurationVar(&cfg.DownloadBy, "download-by", 75*time.Minute, "from the claim, time for the head's download to complete")
	fs.DurationVar(&cfg.UploadStart, "upload-start", 105*time.Minute, "from the claim, time for the upload to start")
	fs.IntVar(&cfg.MaxRefused, "max-refused", 2, "uploads refused as contributions before the slot passes on")
	fs.IntVar(&cfg.FilesPerIP, "files-per-ip", 2, "concurrent file downloads per client address (the slot holder's are not limited)")
	fs.IntVar(&cfg.FilesTotal, "files-total", 24, "concurrent file downloads in all")
	fs.StringVar(&cfg.ClientIPHeader, "client-ip-header", "", "behind a proxy: the header with the client address (e.g. X-Forwarded-For); used only for connections from --trusted-proxies")
	proxies := fs.String("trusted-proxies", "", "comma-separated CIDRs of proxies whose --client-ip-header is believed")
	adminAddr := fs.String("admin", "127.0.0.1:8081", "loopback address for the operator's endpoints (queue, kick, close); empty to turn off")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 2 {
		return usageErr("serve [--heartbeat 60s] [--claim-window 3m] [--slot-cap 2h] [--queue-cap 100] [--per-ip 1] [--client-ip-header H --trusted-proxies CIDR,...] [--admin 127.0.0.1:8081] <dir> <addr>")
	}
	for _, s := range strings.Split(*proxies, ",") {
		if s = strings.TrimSpace(s); s == "" {
			continue
		}
		p, err := netip.ParsePrefix(s)
		if err != nil {
			return fmt.Errorf("--trusted-proxies: %w", err)
		}
		cfg.TrustedProxies = append(cfg.TrustedProxies, p)
	}
	if cfg.ClientIPHeader != "" && len(cfg.TrustedProxies) == 0 {
		return errors.New("--client-ip-header needs --trusted-proxies")
	}
	c, err := ceremony.Open(fs.Arg(0))
	if err != nil {
		return err
	}
	c.Config = cfg
	c.TrimNetworks()
	s := c.State()
	fmt.Printf("serving %s on %s: head phase2-%d, coordinator key %s, admin on %s\n", s.Label, fs.Arg(1), s.HeadIndex, s.CoordPubKey, *adminAddr)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err = c.Serve(ctx, fs.Arg(1), *adminAddr)
	if errors.Is(err, http.ErrServerClosed) || ctx.Err() != nil {
		return nil
	}
	return err
}

func admin(cmd string, args []string) error {
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	url := fs.String("admin", "http://127.0.0.1:8081", "the coordinator's admin address (on its machine)")
	dir := fs.String("dir", "", "close: the chain directory, for a coordinator that is not running")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if cmd == "close" && *dir != "" {
		c, err := ceremony.Open(*dir)
		if err != nil {
			return err
		}
		if err := c.Close(); err != nil {
			return err
		}
		fmt.Println("closed")
		return nil
	}
	var method, path string
	var body any
	switch cmd {
	case "queue":
		method, path = "GET", "/admin/queue"
	case "close":
		method, path = "POST", "/admin/close"
	case "kick":
		if fs.NArg() != 1 {
			return usageErr("kick [--admin <url>] <position | token prefix>")
		}
		method, path = "POST", "/admin/kick"
		if n, err := strconv.Atoi(fs.Arg(0)); err == nil {
			body = map[string]int{"position": n}
		} else {
			body = map[string]string{"token": fs.Arg(0)}
		}
	case "ban":
		if fs.NArg() != 1 {
			return usageErr("ban [--admin <url>] <prefix | address>   (e.g. 203.0.113.0/24, 2001:db8::/32)")
		}
		method, path, body = "POST", "/admin/ban", map[string]string{"prefix": fs.Arg(0)}
	}
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, strings.TrimRight(*url, "/")+path, rd)
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("%w (is serve running with --admin on this machine?)", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var pretty bytes.Buffer
	if json.Indent(&pretty, b, "", "  ") == nil {
		b = pretty.Bytes()
	}
	fmt.Println(string(b))
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func beacon(args []string) error {
	fs := flag.NewFlagSet("beacon", flag.ContinueOnError)
	sig := fs.String("signature", "", "the quicknet round's signature (hex), to compute the beacon offline; fetched from drand otherwise")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 2 {
		return usageErr("beacon [--signature <hex>] <bitcoin-block-hash (display order)> <quicknet-round>")
	}
	bh, err := ceremony.ParseBitcoinBlockHash(fs.Arg(0))
	if err != nil {
		return err
	}
	round, err := strconv.ParseUint(fs.Arg(1), 10, 64)
	if err != nil {
		return fmt.Errorf("quicknet round: %w", err)
	}
	if *sig == "" {
		if *sig, err = ceremony.FetchQuicknet(round); err != nil {
			return err
		}
	}
	rnd, err := ceremony.VerifyQuicknet(round, *sig)
	if err != nil {
		return err
	}
	fmt.Printf("bitcoin block hash    %x (display order)\n", bh)
	fmt.Printf("quicknet chain        %s\n", ceremony.QuicknetChainHash)
	fmt.Printf("quicknet round        %d (signature verified against the pinned public key)\n", round)
	fmt.Printf("quicknet signature    %s\n", *sig)
	fmt.Printf("quicknet randomness   %x\n", rnd)
	fmt.Printf("beacon                %x\n", ceremony.Beacon(bh, rnd))
	return nil
}

func seal(args []string) error {
	if len(args) != 5 {
		return usageErr("seal <phase1> <head> <evals> <beacon-hex> <out-dir>   (Phase 1 is sealed with drand round 1000's randomness, a constant)")
	}
	b2, err := hex.DecodeString(args[3])
	if err != nil || len(b2) != 32 {
		return errors.New("the beacon is 32 bytes of hex (from tacit-ceremony beacon)")
	}
	pk, vk, err := ceremony.Seal(args[0], args[1], args[2], ceremony.Phase1Beacon(), b2)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(args[4], 0o755); err != nil {
		return err
	}
	pkTyped, ok := pk.(*groth16bn254.ProvingKey)
	if !ok {
		return errors.New("the sealed proving key is not a BN254 key")
	}
	// the proving key is written in gnark's dump format, as SP1 ships groth16_pk.bin and loads it (the verifying key in its usual one)
	for _, k := range []struct {
		name  string
		write func(io.Writer) (int64, error)
	}{
		{"groth16_pk.bin", func(w io.Writer) (int64, error) { return 0, pkTyped.WriteDump(w) }},
		{"groth16_vk.bin", vk.WriteTo},
	} {
		p := filepath.Join(args[4], k.name)
		f, err := os.Create(p)
		if err != nil {
			return err
		}
		if _, err := k.write(f); err != nil {
			f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		sum, _ := ceremony.FileSHA256(p)
		fmt.Printf("%s sha256 %s\n", k.name, sum)
	}
	return writeSolidity(filepath.Join(args[4], "groth16_vk.bin"), filepath.Join(args[4], "Groth16Verifier.sol"))
}

// pkDump rewrites a proving key from gnark's compressed encoding to the dump format of SP1's groth16_pk.bin. The input is the
// output of this tool's own seal, so its points are not checked again.
func pkDump(in, out string) error {
	f, err := os.Open(in)
	if err != nil {
		return err
	}
	defer f.Close()
	pk := &groth16bn254.ProvingKey{}
	if _, err := pk.UnsafeReadFrom(bufio.NewReaderSize(f, 1<<22)); err != nil {
		return err
	}
	o, err := os.Create(out)
	if err != nil {
		return err
	}
	if err := pk.WriteDump(o); err != nil {
		o.Close()
		return err
	}
	if err := o.Close(); err != nil {
		return err
	}
	sum, err := ceremony.FileSHA256(out)
	if err != nil {
		return err
	}
	fmt.Printf("%s sha256 %s\n", out, sum)
	return nil
}

func writeSolidity(vkPath, out string) error {
	var b bytes.Buffer
	if err := ceremony.Solidity(vkPath, &b); err != nil {
		return err
	}
	sum, err := ceremony.FileSHA256(vkPath)
	if err != nil {
		return err
	}
	if out == "-" {
		_, err = os.Stdout.Write(b.Bytes())
	} else if err = os.WriteFile(out, b.Bytes(), 0o644); err == nil {
		fmt.Printf("%s written; the verifier hash (sha256 of the vk) is 0x%s\n", out, sum)
	}
	return err
}
