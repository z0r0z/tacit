# Build & validate — for an execution-capable audit (closes RB-03)

The source archive (`tacit-v1-audit-final.zip`) is for READING. It is deliberately source-only, so an auditor
cannot compile, execute, reproduce vkeys, or fuzz from it — which means it can only ever yield a coverage-bounded
verdict, never an authoritative GO for an immutable system, and cannot surface parity/serialization/composition
bugs that only appear at runtime. To do those, build and run from the **repository at a pinned commit** with the
manifests, lockfiles, emitters, serializers, and harnesses the archive omits. This guide is the hermetic path.

## What the archive omits (and where it lives in the repo)
- Rust workspaces + lockfiles: `contracts/sp1/confidential/Cargo.toml` (+ `cxfer-core/`, `harnesses/Cargo.lock`),
  `contracts/sp1/eth-reflection/Cargo.toml`, `contracts/sp1/reflect-stdin/` (the reflection prior-state serializer).
- Foundry project: `contracts/foundry.toml` + remappings + deps (solady, forge-std) + the Solidity tests
  (`contracts/test/*.t.sol`, incl. the `*ProofReal` suites).
- Emitters / witness builders (the byte-for-byte counterparts the guest KATs pin against):
  `worker/src/index.js`, `dapp/tacit.js`; box harnesses `contracts/sp1/confidential/harnesses/exec-*.rs`.

## Toolchain (pin these exact versions)
- SP1 `v6.2.x` (guests use `sp1-zkvm 6.2.3`). Build reproducibly with `cargo prove build --docker` for
  byte-identical ELFs; without `--docker` the ELF bytes differ but the on-chain Groth16 verifier depends on the
  SP1 *version* (v6.2.x circuit), not ELF bytes — so use ONE ELF build everywhere and gate on the `*ProofReal`
  on-chain check below.
- Rust (per the guests' toolchain file), Foundry (forge/cast), Node (for the emitters), circom + snarkjs (only
  to inspect `amm_swap_batch.circom` / re-derive the ceremony vk; the ceremony key is locked).

## Build → derive vkeys (RB-02)
```
cd contracts/sp1/confidential
cargo prove build --bin confidential-pool-prover   # settle guest  -> program_vkey (immutable PROGRAM_VKEY)
cargo prove build --bin reflection-prover          # reflection    -> bitcoin_relay_vkey
cd ../eth-reflection && cargo prove build --bin eth_reflection   # Mode-B -> eth_reflection_vkey
```
Derive each vkey from the just-built ELF (an `exec-*` harness prints `PROGRAM_VKEY`; eth recursion vkey via the
eth-reflection prover-host). Then `contracts/sp1/confidential/verify-vkey-pin.sh` asserts
`sha256(ELF) == elf_sha256` and `vkey(ELF) == program_vkey`. The DEPLOYED pool's constructor `PROGRAM_VKEY` /
`BITCOIN_RELAY_VKEY` must equal these exact values — reproduce and independently confirm both.

## Execute the guests (RB-01) — MODE=execute
- **Settle opcodes:** positive + adversarial vectors per op via the `exec-*` harnesses.
- **Reflection folds:** every reflected opcode, especially the newest — the **15 VAR/ROUTE/BATCH vectors** in
  `ops/REPROVE-amm-box-vectors.md` (positive whole-input / partial / n=1/2/16, and the negatives: destination
  substitution, min-out/expiry change, input substitution, non-P2TR output, malformed change, altered
  cross-curve, receipt permutation, double-count) — and scan-free burn-deposit onboarding (incl. the C-01
  consumed-outpoint present/absent/lying-witness cases). On every negative, assert reflection STILL ADVANCES
  (a malformed swap self-strands only its initiator; no abort/halt).
- **Witness/serializer parity:** the guest reads a stream produced by `reflect-stdin` (reflection prior state)
  and the box witness builders; confirm the guest KATs (`tests/amm-intent-msg-pin.mjs` runs the REAL
  `worker`/`dapp` emitter functions) match what the box actually emits.

## Contracts (RB-02/RB-03)
```
cd contracts && forge build && forge test           # incl. the *ProofReal suites (real Groth16 vs 0xb69f2584)
```
Reproduce runtime bytecode and verify constructor immutables against the deployment: both vkeys, the relay
(genesis start-timestamp / max-target / finality — see the L-1 gate), the factory, controllers, and
`CHAIN_BINDING = keccak256(chainid, address(this))`.

## Fuzz composition
Property-test arbitrary multi-op batches (swap→add→swap→remove, route hops sharing pools with standalone swaps,
multiple adds/removals, remove/add crossings) against a reference per-asset ledger + reference accumulator
models — the grouped contract application (all swaps before all liquidity ops) must reconcile for every
permutation. This is the surface most likely to hide an unknown-unknown and cannot be reached by static review.

## Full cross-lane lifecycle
Bitcoin create/spend → reflect → fast-lane spend → Mode-B retirement; Bitcoin burn → Ethereum mint; Ethereum
crossOut → Bitcoin note; cBTC lock→mint→redeem and unauthorized-spend→slash — each with clone/replay negatives.

The reprove/deploy side of all this is `ops/RUNBOOK-redeploy-v3.md`; this doc is the same gates framed for an
independent reviewer building from the repo.
