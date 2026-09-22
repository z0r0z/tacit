# Reproducible builds

The three SP1 guest programs behind the mainnet pool are pinned by ELF sha256 and verifying key. This page explains
what is pinned, how to rebuild each ELF byte for byte, and how to check the result against the chain. The pin file
is [`contracts/sp1/confidential/elf-vkey-pin.json`](../contracts/sp1/confidential/elf-vkey-pin.json); the recipe
files are in [`contracts/sp1/reproducible/`](../contracts/sp1/reproducible/). The guests themselves are
described in [SPEC §2.9](../SPEC.md#29-sp1-programs).

## What is pinned

| Guest | Committed ELF | Source commit | Build command (run in the listed directory) |
| --- | --- | --- | --- |
| Settle | `contracts/sp1/confidential/elf/cxfer-guest` | `4a425f1d` | `cargo prove build --bin confidential-pool-prover --locked` in `contracts/sp1/confidential` |
| Reflection (Bitcoin relay) | `contracts/sp1/confidential/elf/reflection-prover` | `9e043071` | `cargo prove build --bin reflection-prover --locked` in `contracts/sp1/confidential` |
| Eth reflection | `contracts/sp1/eth-reflection/elf/eth_reflection` | `4a425f1d` plus one comment-line patch | `cargo prove build --bin eth_reflection --locked` in `contracts/sp1/eth-reflection` |

| Guest | ELF sha256 | Bytes | Verifying key |
| --- | --- | --- | --- |
| Settle | `f7bc327d232ec8d1f693d5a44024c1ee732dc42196d079c5be5e3f3668b922c7` | 1681088 | `0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3` |
| Reflection | `55b5ccffd4cd19e10061c4b5e70658e36bc806a365d0f5535918392e7bf12c5b` | 1340080 | `0x00bb158ba04f18a100f998af0e3b074b5368771f22b8b6e4fd1d66823a074bc5` |
| Eth reflection | `5fb193b5c463af186d35dfcedc21c089f21c010055e96daffff47800d8ff43ae` | 2327032 | `0x00ca817124b59c05eb6f2731d48a6d7145dc4aff06510e0ba710a7312f6aea72` |

Full commit ids: `4a425f1d3d2e9c81bd89510e6f9d9e49f10cdf91` and `9e04307144c6ba1da6fec57decb455fc67bbf34f`. The same
values are in [`expected.json`](../contracts/sp1/reproducible/expected.json).

### Where each key appears on chain

- **Settle vkey** is the `PROGRAM_VKEY` immutable of the pool
  [`0x000000000Ed1eabD231Be41d93b719056F7febFC`](https://etherscan.io/address/0x000000000Ed1eabD231Be41d93b719056F7febFC).
  Immutables are compiled into the runtime bytecode as `PUSH32` values, so it is readable with `cast code`.
- **Relay vkey** is the pool's `BITCOIN_RELAY_VKEY` immutable, read the same way.
- **Eth reflection vkey** is not stored in the pool. The reflection guest embeds the eth guest's recursion digest
  (`vk.hash_u32()`, eight `u32` words) as `ETH_REFLECTION_VKEY` in `contracts/sp1/confidential/src/reflect.rs` and
  checks eth proofs against it. Its value is `[1698740370, 761725306, 1843717690, 1218893588, 786585592,
  423901230, 1310805602, 795535986]`. The `0x00ca8171...` value above is the same verifying key in the
  32-byte form the SP1 tooling prints. Because the reflection ELF embeds the digest, matching the reflection ELF
  byte for byte also pins the eth guest's key.

## Toolchain

| Component | Value |
| --- | --- |
| `cargo prove --version` | `cargo-prove sp1 (4809e79 2026-06-01T14:24:14.406056341Z)` |
| `rustc +succinct -vV` | `rustc 1.94.0-dev`, host `x86_64-unknown-linux-gnu`, LLVM 21.1.8, `commit-hash: unknown` |
| Host cargo (falls back to rustup stable) | `cargo 1.98.1 (797e8a9bc 2026-08-05)`, from `rustc 1.98.1 (48a229cea 2026-09-01)` |
| Locked `sp1-zkvm` | 6.2.3 in `contracts/sp1/confidential`, 6.2.4 in `contracts/sp1/eth-reflection` |
| Build host | Ubuntu 22.04.3 x86_64, gcc 11.4.0 |

Fingerprints of the toolchain files used (SHA-256): `cargo-prove` `c6cc58074487737be6d2b4a9ad05bfb15e1d8de1fb8e969cea39347c161efd70`;
`succinct` `bin/rustc` `2e952f92635ee0388b5eac9b06f2fec7b23a620b0a7dbcceab576caeb89cb160`;
`succinct` `lib/librustc_driver-6d6de6fbd9068a63.so` `db572b411a9458e154fcc59bd900a0280fa0b4b1b8659945efc54cec126b5136`.

How to obtain it, from an empty machine state:

1. Install rustup with the host toolchain the builds used:
   `curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.98.1 --no-modify-path`.
   The `succinct` toolchain ships `rustc` only; `cargo` comes from this stable toolchain.
2. Install the pinned SP1 tooling and its Rust toolchain in one step. Do not run a bare `sp1up`, which installs the
   newest release and a newer `succinct` toolchain (for example `1.96.0-dev`) that will not reproduce these bytes:
   ```
   curl -sSfL https://sp1up.succinct.xyz | bash
   sp1up --version v6.2.3
   ```
   `v6.2.3` installs exactly `cargo-prove sp1 (4809e79 2026-06-01T14:24:14.406056341Z)` and, with it, the
   `1.94.0-dev` toolchain, which it links into rustup as `succinct` (rustup must already be installed).
   `cargo prove --version` and `rustc +succinct -V` must print the strings above.
3. Check the toolchain archive. `~/.sp1/rust-toolchain-x86_64-unknown-linux-gnu.tar.gz` has SHA-256
   `12c94435d41bfe4e20131bbcce40b35abd32270ad792befc653af4e3fabc192f`, and its `bin/rustc` and
   `lib/librustc_driver-*.so` are the fingerprinted files above.

## Build paths matter

Two inputs are embedded in the ELF bytes and are part of the recipe:

- **Cargo home.** Dependency sources compiled from `$CARGO_HOME/registry` and `$CARGO_HOME/git/checkouts`
  contribute their absolute paths (panic locations). The settle and eth-reflection ELFs were built with
  `CARGO_HOME=/workspace/.cargo`. The reflection ELF was built with `CARGO_HOME=/root/.cargo`. Use the same value
  for each build.
- **Source tree path (eth-reflection only).** The eth guest's own sources and its path dependency
  `../confidential/cxfer-core` are recorded by absolute path, so the tree must sit at
  `/workspace/tacit/contracts/sp1/eth-reflection` (with `/workspace/tacit/contracts/sp1/confidential` beside it).
  From another directory the ELF differs (2326848 bytes instead of 2327032). The settle and reflection ELFs record
  their own crates by workspace-relative path, so the tree location does not affect them. Using `/workspace/tacit`
  for all three is the simplest rule.

`/workspace` is normally not something you want to create on a development machine, so build inside a container or
chroot in which `/workspace/tacit` and `/workspace/.cargo` exist. Any of these works:

- **Container.** Mount a copy of the tree so `/workspace/tacit` exists, install the toolchain (steps 1 and 2 above)
  inside it and run the script. Nothing in the script is specific to a chroot, but this path is untested.
- **Private mount namespace** (`unshare -m`), where permitted.
- **Bare chroot without `/proc`** (the tested path, for a host where `unshare` and `mount` are denied). Copy the host
  userland (`/usr`, `/etc`, an empty `/dev/null` file, empty `/root`, `/tmp`, `/workspace`) into a new directory, then
  run rustup-init and sp1up from outside with `HOME=<root>/root RUSTUP_HOME=<root>/workspace/.rustup
  CARGO_HOME=<root>/workspace/.cargo` (both installers refuse to run in a chroot with no `/proc`), and `chroot <root>`
  to run the script. Without `/proc` the rustup proxies, rustc's sysroot lookup and the rust-lld wrapper cannot find
  themselves; `build-in-chroot.sh` detects this and creates the direct toolchain shims, host-linker shim and
  `LD_LIBRARY_PATH` it needs, and repoints the `succinct` toolchain link at the chroot's own `~/.sp1`.

Rules for the tree you build from:

- Extract the pinned commit with `git archive` (or a clean checkout). Do not build from a working tree at another
  commit: the `eth-reflection` manifest at later commits differs (it vendors a dependency), and only the manifest
  and lock file at `4a425f1d` reproduce the pinned eth ELF.
- Always pass `--locked`. The build must not modify `Cargo.lock`.
- Network access is needed on a fresh Cargo home (git dependencies and crates.io). An empty Cargo home resolves the
  locked revisions to the pinned bytes; the fetch is about 220 MB.

## The eth-reflection comment line

The pinned eth ELF corresponds to a `src/main.rs` exactly one comment line shorter than the file committed at
`4a425f1d`. The code is identical; only panic-location line numbers in the binary differ, which is enough to change
its bytes. To reproduce the pinned binary, apply
[`eth-main-rs-original-build.patch`](../contracts/sp1/reproducible/eth-main-rs-original-build.patch) on top of
`4a425f1d` from the tree root:

```
cd /workspace/tacit && patch -p1 < eth-main-rs-original-build.patch
```

The patch merges the last two lines of a four-line comment block above `ETH_GENESIS_VALIDATORS_ROOT` into one.
Without it the build is functionally identical but hashes differently.

## Rebuild

Get the sources first. The repository is public and both pinned commits are reachable from `main`:

```
git clone https://github.com/z0r0z/tacit.git
```

[`build-in-chroot.sh`](../contracts/sp1/reproducible/build-in-chroot.sh) automates the steps below inside a
container or chroot that already has the toolchain (see [Toolchain](#toolchain)). It creates `/workspace/tacit`
itself. For each ELF it wipes `/workspace/tacit/contracts/sp1`, extracts the pinned commit from the clone with
`git archive`, applies the patch (eth only), runs the build with the right Cargo home, then prints the sha256 and the
output of `cargo prove vkey --elf` next to the pinned values. With `RPC_URL` set it also runs the on-chain check in
step 5 of the checklist (through `cast` if installed, otherwise `curl`).

```
REPO=/path/to/tacit-clone RPC_URL=https://ethereum-rpc.publicnode.com \
  bash contracts/sp1/reproducible/build-in-chroot.sh            # all three
  bash contracts/sp1/reproducible/build-in-chroot.sh settle     # or one of: settle reflection eth_reflection
```

The output ELFs are copied to `./repro-out/<name>.elf`. The script exits non-zero if any hash or vkey differs. All
three ELFs build in about 4 minutes on 16 cores from an empty Cargo home.

## Verification checklist

1. **Sources.** `git cat-file -t 4a425f1d3d2e9c81bd89510e6f9d9e49f10cdf91` and `...9e04307144c6ba1da6fec57decb455fc67bbf34f`
   both print `commit`.
2. **Committed ELFs match the pin.** `sha256sum contracts/sp1/confidential/elf/cxfer-guest
   contracts/sp1/confidential/elf/reflection-prover contracts/sp1/eth-reflection/elf/eth_reflection` equals the
   table above and `elf-vkey-pin.json`.
3. **Rebuild.** Run the build in a container or chroot as above and compare the rebuilt sha256 with the pinned
   value.
4. **Key derivation.** `cargo prove vkey --elf <rebuilt.elf>` prints the verifying key; it must equal the value
   in the table. This works from the ELF alone, so it also confirms the committed ELFs.
5. **On-chain cross-check.** For the settle and relay keys, each 32-byte key must occur exactly once in the pool
   runtime code as a `PUSH32`:
   ```
   cast code 0x000000000Ed1eabD231Be41d93b719056F7febFC --rpc-url $RPC \
     | grep -o '7f006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3' | wc -l    # 1
   cast code 0x000000000Ed1eabD231Be41d93b719056F7febFC --rpc-url $RPC \
     | grep -o '7f00bb158ba04f18a100f998af0e3b074b5368771f22b8b6e4fd1d66823a074bc5' | wc -l    # 1
   ```
   The eth key is not in the pool bytecode; it is bound through the reflection ELF (step 3 for `reflection`) and
   the `ETH_REFLECTION_VKEY` digest, which the `eth_vkey` binary in `contracts/sp1/eth-reflection/prover-host`
   prints as `hash_u32`. The ELF it reads is baked in at compile time (a fixed, box-relative
   `include_bytes!` path), so checking a different ELF means rebuilding the binary against that path, not
   passing it as an argument.
6. **Repository gate.** From the repo root, `VERIFY_VKEY_STRICT=1 bash contracts/sp1/confidential/verify-vkey-pin.sh`
   checks the committed ELF hashes, fixture bindings and source coherence against the pin.

## What was verified

On the build host described under [Toolchain](#toolchain), from a fresh `git clone`, a new bare chroot with rustup
1.98.1 and `sp1up --version v6.2.3`, and empty Cargo homes, `bash contracts/sp1/reproducible/build-in-chroot.sh`
rebuilt all three ELFs to the pinned sha256 (`--locked`, `Cargo.lock` unchanged), `cargo prove vkey --elf` printed
the keys in the table, and the settle and relay keys each occur once in the pool's runtime bytecode read from a
public RPC. The eth ELF reproduces only with the comment-line patch and only at `/workspace/tacit`.

Not verified:

- `cargo prove build --docker`. It uses SP1's own container and toolchain and is not the recipe here. A
  general-purpose container with the toolchain installed was not run either (it needs no shims).
- A second physical host. A different CPU, glibc or gcc should not matter (the guest is compiled by the `succinct`
  toolchain for RISC-V, and host tools only run build scripts) but has not been tried.
