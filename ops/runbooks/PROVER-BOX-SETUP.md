# Prover box setup — build & run the Tacit SP1 provers

Stand up a machine that builds SP1 witnesses and produces on-chain groth16 proofs for the
confidential pool. Two modes:

- **Network proving (recommended, GPU-FREE).** The prover binaries submit to the **Succinct
  network prover**; the box only builds the witness + relays. Any CPU box works — no GPU needed.
  You pay per proof in **PROVE** (see ops/PRICING-RELAY-ECONOMICS.md). This is what the Render
  worker (`worker-relay/`) uses; the box is fallback only.
- **Local GPU proving.** The box proves locally on a GPU (STARK shards) + native-gnark (groth16
  wrap). No PROVE cost, but needs a real GPU **and** a host that lets you raise `memlock` (see
  Gotchas). Use only where network proving isn't an option.

The two binaries:
- `exec` (one per op-type: `exec-wrap` / `exec-lp` / `exec-swap` / `exec-unwrap` / …) — proves a
  confidential **settle** op. Source: `contracts/sp1/confidential/harnesses/exec-<op>.rs` copied
  to `harnesses/src/main.rs`, guest ELF `cxfer-guest` baked in via `include_bytes!`.
- `bitcoin_prove` — proves the **Bitcoin reflection** attest. Source:
  `contracts/sp1/eth-reflection/prover-host/src/bin/bitcoin_prove.rs`, guest ELF `eth_reflection`.

## Prerequisites (Ubuntu 22.04)
```bash
apt-get update
apt-get install -y build-essential curl git pkg-config libssl-dev \
    libclang-dev protobuf-compiler tmux            # libclang+protoc: sp1-sdk build deps
# Rust
curl https://sh.rustup.rs -sSf | sh -s -- -y && . "$HOME/.cargo/env"
# SP1 toolchain (only needed to BUILD GUEST ELFs; skip if using the committed elf/ artifacts)
curl -L https://sp1.succinct.xyz | bash && ~/.sp1/bin/sp1up
# Go — REQUIRED: sp1-recursion-gnark-ffi (a transitive sp1-sdk dep) compiles Go via CGO
curl -sL https://go.dev/dl/go1.22.5.linux-amd64.tar.gz | tar -C /usr/local -xz
export PATH=$PATH:/usr/local/go/bin
```

## Stage the guest ELFs (committed — no guest rebuild needed)
The guest ELFs are committed and vkey-pinned; place them where the host bins `include_bytes!` them:
```bash
# settle guest → the exec harness include path
mkdir -p work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release
cp contracts/sp1/confidential/elf/cxfer-guest \
   work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/cxfer-guest
# reflection guest (only for bitcoin_prove)
cp contracts/sp1/eth-reflection/elf/eth_reflection  /root/sp1-helios/target/.../eth_reflection
# sha-pin them and assert the on-chain PROGRAM_VKEY (0x003a21ba…) / BITCOIN_RELAY_VKEY matches.
```

## Build the settle harnesses (network mode)
```bash
export CARGO_TARGET_DIR=/root/settle-target LIBCLANG_PATH=/usr/lib/x86_64-linux-gnu \
       CGO_ENABLED=1 PROTOC=/usr/bin/protoc PATH=$PATH:/usr/local/go/bin
H=contracts/sp1/confidential/harnesses
# 1) ENABLE THE NETWORK FEATURE (default is native-gnark — .network() won't exist otherwise):
sed -i 's/features = \["blocking", "native-gnark"\]/features = ["blocking", "network"]/' $H/Cargo.toml
mkdir -p $H/src
for op in wrap lp swap unwrap; do
  cp $H/exec-$op.rs $H/src/main.rs
  # 2) PATCH backend to network (the harness hard-codes .cpu()):
  sed -i 's/ProverClient::builder().cpu().build()/ProverClient::builder().network().build()/g' $H/src/main.rs
  cargo build --release --bin exec
  cp $CARGO_TARGET_DIR/release/exec /workspace/bin/exec-$op
done
```
`bitcoin_prove` is the same shape: `sed .cuda()→.network()` in bitcoin_prove.rs, then
`cargo build --release --bin bitcoin_prove` (needs the eth_reflection ELF + sp1-helios path deps).

## Run a proof (network mode)
```bash
export NETWORK_PRIVATE_KEY=<succinct-key> SP1_PROVER=network
export LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu
OP_FILE=/path/op.json MODE=groth16 /workspace/bin/exec-wrap
# writes public_values.hex + proof_bytes.hex. Verify the printed VKEY == on-chain PROGRAM_VKEY.
# settle on-chain:  cast send POOL 'settle(bytes,bytes,bytes[])' 0x<pv> 0x<proof> '[0x]'
```
Fund PROVE: `approve` the PROVE token to the Succinct **vApp** (`0x5Ad5Bc4B…`), then
`deposit(uint256)`. A 176-block reflection proof cost ~28.5 PROVE; a settle op ~0.1–0.2 PROVE.

## Gotchas (learned the hard way)
- **`network` feature, not `native-gnark`.** The harness Cargo.toml defaults to `native-gnark`;
  `.network()` doesn't exist without the `network` feature. Symptom: `no method named network`.
- **Go is required** even for network mode — `sp1-recursion-gnark-ffi` builds Go via CGO at
  compile time. Symptom: `failed to run custom build command for sp1-recursion-gnark-ffi`.
- **Empty memo at settle.** The harness feeds the guest `keccak256("")` memo placeholders, so
  `settle` must pass an empty memo per leaf (`[0x]`); else `MemoLeafMismatch`. (Hold note secrets
  locally for recovery — the on-chain memo is empty.)
- **Numeric fixture fields** for lp/swap: `reserveAPre`/`d`/`feeBps`/`leafIndex` are read via
  `as_u64` — pass JSON **numbers**, not strings (wrap reads `value` as a string — per-harness).
- **tmux for long runs on RunPod.** `nohup`/`setsid` processes get killed on SSH teardown on
  RunPod; run proofs/builds inside `tmux` so they survive disconnects.
- **RunPod migration wipes the container disk.** `/workspace` (network fs) partially survives;
  `/root` (rust bins via sp1up, cargo cache, apt packages, built targets) does NOT — re-install
  deps + rebuild. Keep the guest ELFs + network key in a backup you re-upload.
- **Local GPU proving is blocked by low `memlock`.** sp1-gpu-server needs ~570 MB pinned memory;
  many containers hard-cap `memlock` at 8 MB and root can't raise it (`Operation not permitted`).
  If you can't raise it (`ulimit -l unlimited`), local GPU proving won't work → use network mode.
- **Tree/paths via keyless logs.** Public RPCs block `eth_getLogs`; rebuild the note tree from
  `eth.blockscout.com/api/v2/addresses/<pool>/logs` (LeavesInserted). Verify the rebuilt root
  equals the on-chain `currentRoot` before trusting merkle paths.

## For users running their own prover
Network mode is the whole point: a user needs only this box (any CPU), a funded PROVE balance,
and the committed guest ELFs — no GPU, no trust in an operator. They build their own witness
client-side (blindings never leave the client), submit to Succinct, and settle. See
ops/PRICING-RELAY-ECONOMICS.md for the self-prove vs relayer vs TEE tradeoffs.
