# Reproducible builds

The three SP1 guest programs behind the gen5 pool are pinned by ELF sha256 and verifying key. This page explains
what is pinned, how to rebuild each ELF byte for byte, and how to check the result against the chain. The pin file
is [`contracts/sp1/confidential/elf-vkey-pin.json`](../contracts/sp1/confidential/elf-vkey-pin.json); the recipe
files are in [`contracts/sp1/reproducible/`](../contracts/sp1/reproducible/).

Last verified: 2026-09-21 (see [What was verified](#what-was-verified)).

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

How to obtain it:

1. Install the SP1 tooling (`sp1up`), which provides `cargo-prove`, and run `cargo prove install-toolchain` to
   fetch the `succinct` Rust toolchain. Confirm `cargo prove --version` prints the string above.
2. The `succinct` toolchain must be the `1.94.0-dev` build (`rustc +succinct -V`). A newer `sp1up` release can
   install a later `succinct` toolchain (for example `1.96.0-dev`); that one will not reproduce these bytes. Keep
   both installed if needed and point rustup's `succinct` name at the `1.94.0-dev` directory:
   `rustup toolchain link succinct <path to the 1.94.0-dev toolchain>`.
3. The `succinct` toolchain ships `rustc` only. `cargo` comes from a rustup stable toolchain on `PATH`; the
   builds above used stable 1.98.1.
4. The archive hash of the `1.94.0-dev` toolchain download was not retained. The file fingerprints above are the
   available check that you have the same compiler.

## Build paths matter

Two inputs are embedded in the ELF bytes and are part of the recipe:

- **Cargo home.** Dependency sources compiled from `$CARGO_HOME/registry` and `$CARGO_HOME/git/checkouts`
  contribute their absolute paths (panic locations). The settle and eth-reflection ELFs were built with
  `CARGO_HOME=/workspace/.cargo`. The reflection ELF was built with `CARGO_HOME=/root/.cargo`. Use the same value
  for each build.
- **Source tree path (eth-reflection only).** The eth guest's own sources and its path dependency
  `../confidential/cxfer-core` are recorded by absolute path, so the tree must sit at
  `/workspace/tacit/contracts/sp1/eth-reflection` (with `/workspace/tacit/contracts/sp1/confidential` beside it).
  Building it from another directory produced a different ELF (2326848 bytes instead of 2327032). The settle and
  reflection ELFs record their own crates by workspace-relative path; both were rebuilt byte for byte from a
  different directory, so the tree location does not affect them. Using `/workspace/tacit` for all three is still
  the simplest rule.

`/workspace` is normally not something you want to create on a development machine, so build inside a container or
chroot in which `/workspace/tacit` and `/workspace/.cargo` exist. A private mount namespace (`unshare -m`) works
where permitted. The 2026-09-21 rebuild used a chroot on a host where `unshare` was denied; a container that mounts
your checkout at `/workspace/tacit` is equivalent.

Rules for the tree you build from:

- Extract the pinned commit with `git archive` (or a clean checkout). Do not build from a working tree at another
  commit: the `eth-reflection` manifest at later commits differs (it vendors a dependency), and only the manifest
  and lock file at `4a425f1d` reproduce the pinned eth ELF.
- Always pass `--locked`. The build must not modify `Cargo.lock`.
- Network access is needed on a fresh Cargo home (git dependencies and crates.io).

## The eth-reflection comment line

The pinned eth ELF was built from a `src/main.rs` that is exactly one comment line shorter than the file committed
at `4a425f1d`. Code is identical; only panic-location line numbers in the binary differ, which is enough to change
its bytes. To reproduce the pinned binary, apply
[`eth-main-rs-original-build.patch`](../contracts/sp1/reproducible/eth-main-rs-original-build.patch) on top of
`4a425f1d` from the tree root:

```
cd /workspace/tacit && patch -p1 < eth-main-rs-original-build.patch
```

The patch merges the last two lines of a four-line comment block above `ETH_GENESIS_VALIDATORS_ROOT` into one.
Without it the build is functionally identical but hashes differently.

## Rebuild

[`build-in-chroot.sh`](../contracts/sp1/reproducible/build-in-chroot.sh) automates the steps below inside a
container or chroot that already has the toolchain and the `/workspace` layout. For each ELF it wipes
`/workspace/tacit/contracts/sp1`, extracts the pinned commit with `git archive`, applies the patch (eth only), runs
the build with the right Cargo home, then prints the sha256 and the output of `cargo prove vkey --elf` next to the
pinned values.

```
REPO=/path/to/tacit-clone RPC_URL=https://ethereum-rpc.publicnode.com \
  bash contracts/sp1/reproducible/build-in-chroot.sh            # all three
  bash contracts/sp1/reproducible/build-in-chroot.sh settle     # or one of: settle reflection eth_reflection
```

The output ELFs are copied to `./repro-out/<name>.elf`. The script exits non-zero if any hash or vkey differs.

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
   prints for a given ELF as `hash_u32`.
6. **Repository gate.** From the repo root, `VERIFY_VKEY_STRICT=1 bash contracts/sp1/confidential/verify-vkey-pin.sh`
   checks the committed ELF hashes, fixture bindings and source coherence against the pin.

## What was verified

On 2026-09-21, on the build host described under [Toolchain](#toolchain):

- All three ELFs were rebuilt from their source commits and matched the pinned sha256 exactly (settle
  `f7bc327d...`, reflection `55b5ccfd...`, eth reflection `5fb193b5...`), with `--locked` and an unchanged
  `Cargo.lock`.
- `cargo prove vkey --elf` on each rebuilt ELF printed the verifying keys in the table.
- The settle and relay keys each occur once in the runtime bytecode of the pool at the address above, read from a
  public RPC.
- The eth ELF was reproduced only with the comment-line patch and only at `/workspace/tacit`; without the patch or
  at another path the result differed.

Not verified:

- A Docker build (`cargo prove build --docker`) was not run; it uses SP1's own container and toolchain and is
  not the recipe here.
- The rebuilds ran with dependency sources already present in the Cargo home (offline). A fresh fetch resolving to
  the same locked revisions is expected but was not exercised.
- `build-in-chroot.sh` is a generalization of the commands used on the build host and was checked for syntax and
  its metadata parsing, not run end to end. The build host's chroot also overrode the host linker used for build
  scripts with a small wrapper (not retained); if a host-side build script fails to link in your environment,
  point `CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER` at your `gcc`.
- No independent second machine has reproduced these hashes yet.
