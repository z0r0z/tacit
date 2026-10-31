# tacit-prover

Proves Tacit V1 settle ops on your own machine. The dapp finds it on `127.0.0.1:47815` and sends it the op's program input.
The machine makes the Groth16 proof the pool verifies, and you send the settle from your own wallet. No relay, no prover
network and no credit are involved, and the op's details never leave the machine.

It takes the ops whose proofs pin nothing that moves while it works: wraps (`wrap`, `wraptransfer`), private sends
(`transfer`, `stealthlock`), withdrawals (`unwrap`, `sendunwrap`) and stealth claims and refunds (`stealthclaim`,
`stealthrefund`). A proof that takes minutes is then as good as one that takes seconds. Swaps, pool joins and borrows pin the
pool's price, so the page leaves those to Tacit's relay. The list is `DEVICE_TYPES` in `dapp/device-prover.js`.

## Get it

One command picks the build for this machine, checks it against the sha256 pinned in the script, and starts it at login (`dapp/prove.sh`, served at
tacit.finance/prove.sh); with an address it mines the proof pool for TAC points to it (see [Mining the proof pool](#mining-the-proof-pool)):

```sh
curl -fsSL https://tacit.finance/prove.sh | sh                        # proves for this computer's pages
curl -fsSL https://tacit.finance/prove.sh | sh -s -- 0xYourAddress    # and mines the proof pool for that address
curl -fsSL https://tacit.finance/prove.sh | sh -s -- --status         # running? what waits in the pool? what was credited?
curl -fsSL https://tacit.finance/prove.sh | sh -s -- --uninstall
```

Or download `tacit-prover-macos-arm64.tar.gz` or `tacit-prover-linux-x86_64.tar.gz` from the repository's tacit-prover releases and
check it against the `.sha256` beside it (`shasum -a 256 -c`). The workflow that makes them is
`.github/workflows/tacit-prover-release.yml`. Or build it:

## Build

You need Rust (stable), Go 1.24 or newer (for the Groth16 step) and a C compiler. On macOS, Xcode's command line tools
supply the C compiler and the Metal framework. On Linux, `build-essential` does.

```sh
cd contracts/sp1/confidential/device-prover
cargo build --release
```

The build fails if `../elf/cxfer-guest` is not the pinned guest (`build.rs`). At startup the prover refuses to run if the
guest's verifying key is not the pool's `PROGRAM_VKEY` (`0x006cd47f…d6e3`).

## Run

```sh
./target/release/tacit-prover install    # start at login and stay ready (launchd, or a systemd user unit on Linux)
./target/release/tacit-prover uninstall  # stop that
./target/release/tacit-prover            # serve on 127.0.0.1:47815, in this terminal
./target/release/tacit-prover mine 0xYourAddress   # prove the community pool's wraps for TAC points
./target/release/tacit-prover check      # every faster path against the reference code, then exit
./target/release/tacit-prover prove f    # one proof of the bincode SP1Stdin in f, to f.proof.json
```

Installed, it loads its keys once at login, so a page finds it ready, and it idles at no CPU. Then, on tacit.finance, open
**Prove** and switch on **Prove on this computer**. There you can also keep wraps of a few sizes ready: they are proved while
the prover is idle and sent at once when you make that much private. On the tETH page it is the prover sheet's
**This computer** switch. Your browser asks once before the page reaches the local network.

The first proof downloads SP1's Groth16 circuit, v6.1.0: 6.2 GB, 8.4 GB unpacked, to `~/.sp1/circuits`. Its verifying key
hashes to the mainnet verifier's `VERIFIER_HASH`. The prover then writes a lean copy of the circuit once (~2 min). Every later
start loads in seconds.

| env | default | |
|---|---|---|
| `TACIT_PROVER_PORT` | `47815` | the page looks here |
| `TACIT_PROVER_ORIGINS` | tacit.finance, www.tacit.finance, and localhost:8080 / 127.0.0.1:8080 for a local dapp | pages allowed to ask for a proof |
| `TACIT_PROVER_DIR` | `~/.tacit-prover` | finished proofs, kept by input hash |
| `TACIT_METAL` | on, on macOS | `0` keeps all hashing and proof-of-work on the CPU |
| `TACIT_MINE` | unset | an address: mine the proof pool while idle, for TAC points to it |
| `TACIT_POOL_API` | `https://api.tacit.finance` | where the proof pool is |
| `SP1_GNARK_GPU` | off | `1` puts the Groth16 step's G1 multi-exponentiations on the Mac's GPU (Metal): faster per sum, but slower than the lean CPU path in the one busy-machine timing so far |
| `SP1_GNARK_MSM_BLOCK` | `4194304` | bases per block of a CPU multi-exponentiation; `0` scans each in one piece |
| `SP1_GNARK_LEAN` | on | `0` loads the Groth16 key and circuit, and proves, as stock SP1 does |
| `SP1_WORKER_NUM_*_WORKERS` | 1 per stage under 16 GB of RAM | the SDK's own concurrency settings |
| `SP1_WORKER_VERIFY_INTERMEDIATES` | `false` | the final proof is verified before it is returned, which no wrong step survives |

While it proves, `GET /job` says the stage (core, shrink, wrap, groth16) and an ETA from the last proof on this machine.
The server listens on 127.0.0.1 only and answers a browser only from an allowed origin. It makes one proof at a time, and
the rest wait in a queue. A job's id is the hash of its input, so a page reloaded mid-proof picks up the same job. Finished
proofs are kept on disk, without their inputs.

## Mining the proof pool

People keep wraps ready to send at once (a wrap's proof binds only the asset, the amount and the note's commitment, so it can be
made ahead), and the API holds those requests in a proof pool. `tacit-prover mine 0xYourAddress` leases one at a time, proves it
and hands it back; the API checks each proof against the pool's verifier and the note it was asked for, then credits TAC points
to the address. A wrap's input holds nothing secret, so proving it here learns nothing that its deposit will not show.

Installed with `TACIT_MINE=0xYourAddress tacit-prover install`, the prover mines whenever it has had nothing of its own to prove
for a minute. A proof you ask for while it mines waits for that one job to finish, up to the time one proof takes here.

## How long a proof takes

These are real mainnet wraps, each accepted by the live verifier `0xb69f2584…f4e2` and settled on a fork.

| machine | time |
|---|---|
| MacBook Air M2, 8 GB, fanless, stock SP1 | 41 min, 27 GB peak footprint |
| the same Air, this prover | **13.3 min** (core 4.9, shrink 1.1, wrap 2.5, Groth16 4.8) before the Groth16 and extension changes below |
| an M-series with 16 GB or more | expected 5–10 min |
| a 12-core desktop or M4 Pro | expected 5–6 min |

On macOS the wrap STARK's Merkle trees (leaves and every layer above) hash on the GPU and the CPU at once, and its 22-bit
proof-of-work is searched on the GPU; each is checked against the CPU code it replaces (see below).

Since then, measured on the same Air with other work running (so as CPU time and as A/B pairs started under the same load):
the Groth16 step takes 26% less time on the CPU path (259 s against 351 s, 6.0 GB peak against 8.3 GB, 40% of the page
faults), and on the GPU path half the CPU time (308 s against 560 s); a G1 multi-exponentiation over the key's 12.8M A
bases takes 12.8 s on the GPU path against 22.8 s on the CPU's. The quartic extension's product, 40–46% of the CPU time in
the core and recursion stages, is 2.2× faster, and a whole proof does about 150 s less CPU work.

## What the patches change

`patches/` holds six crates that replace their crates.io versions through `[patch.crates-io]`. Each one changes how a value
is computed, never which value: the proofs are what stock SP1 6.2.4 makes (a proof-of-work nonce is any one that passes, as
stock SP1 takes whichever thread finds one first). `tacit-prover check` compares every faster path with the code it replaces.

| crate | upstream | change |
|---|---|---|
| `sp1-recursion-gnark-ffi` | 6.2.4 | Groth16 loads the proving key by `mmap` and a debug-stripped R1CS (peak memory 19 → 8–10 GB, key loads 98 s → 2 s), and proves with gnark's arithmetic on a smaller footprint (`go/sp1/prove_lean.go`): H on a domain without its 2 GB of FFT tables, the multi-exponentiations one after another, each walking its bases in blocks that stay in memory, so a page of the 5.9 GB key is read about once per proof. On macOS the four G1 multi-exponentiations run on the GPU (`go/sp1/gpu_msm.metal`, Pippenger with 16-bit windows; the CPU sorts each block into its buckets while the GPU adds the block before), 1.8× the CPU's speed on the key's own bases, and then the CPU takes the G2 one; the GPU's sum over the key's own bases is compared with gnark's before it is used, and a proof it helped make is verified before it is returned, any failure putting the step back on the CPU |
| `p3-bn254-fr` | 0.4.3-succinct | CIOS Montgomery multiplication without a final carry chain (BN254 has two spare bits), the Poseidon2 internal layer's diffusion as additions, and `#[inline]` across crates: the wrap STARK 2.5× faster |
| `p3-symmetric` | 0.4.3-succinct | packs 31-bit field elements into BN254 two at a time (62-bit words), the same integer as one at a time |
| `p3-merkle-tree` | 0.4.3-succinct | a BN254 tree's leaves and each layer above hashed by `crates/leafhash` on the GPU (Metal) while the CPU's threads take the rest of the layer, the split tuned from both rates as it goes. Three of the GPU's rows or nodes in every layer are recomputed on the CPU, and a mismatch turns that GPU path off |
| `p3-koala-bear` | 0.4.3-succinct | the NEON Poseidon2 internal layer folds its Montgomery rescale into the diagonal (exact in the field), so a round takes 17 multiplications instead of 32 and no longer calls `memset` once per lane, which was 17% of the core stage's CPU time: the permutation 1.36× faster |
| `p3-challenger` | 0.4.3-succinct | the outer challenger's proof-of-work (22 bits in the wrap stage) searched on the GPU, ~4 s against ~20 s of CPU; the nonce is checked by the challenger itself before it is used |

`crates/leafhash` holds the Metal kernels (leaf hash, node compression, proof-of-work): BN254 Poseidon2 on eight 32-bit
limbs, with the KoalaBear packing done in the kernel. Page-aligned memory is handed to the GPU where it lies, without a copy.
The round constants (`src/rc.rs`) are the Horizen Labs set SP1 uses.

All six crates keep their upstream licences (MIT OR Apache-2.0).
