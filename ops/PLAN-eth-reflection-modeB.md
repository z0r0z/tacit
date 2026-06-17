# PLAN — Mode B reverse reflection (trustless Ethereum→Bitcoin cross-out)

**Goal.** Make a confidential-pool **cross-out** (Ethereum→Bitcoin value movement) trustless and
first-class: cross-out value enters the trustless Bitcoin reflection pool root, is freely usable on
Bitcoin, round-trips back to Ethereum, and is verifiable by anyone — with **no one trusting the
worker** for cross-out validity. This closes the one remaining worker-trust surface (Mode A; see
`PLAN-crossout-consumer.md`), symmetric to how the forward Bitcoin→Ethereum bridge already works.

## The constraint that dictates the design

The Bitcoin reflection guest runs **off-chain** (on the prover box). For it to learn an Ethereum
fact trustlessly it must **verify a proof itself** — it cannot "read the contract" (reading Ethereum
trustlessly *is* the light-client problem), and there is no Bitcoin contract to verify a proof for
it (unlike the forward direction, where the Ethereum contract verifies the Bitcoin proof). So Mode B
**requires an Ethereum light client whose proof the Bitcoin reflection consumes** — the on-chain-anchor
shortcut does not exist on the Bitcoin side.

## Architecture (recursive, one accounting)

A separate **`eth-reflection`** SP1 guest (fork [`sp1-helios`](https://github.com/succinctlabs/sp1-helios) —
do not hand-roll a beacon light client), **folded recursively** into the Bitcoin reflection guest:

```
eth-reflection guest                        bitcoin reflection guest (existing, extended)
────────────────────                        ─────────────────────────────────────────────
verify beacon sync-committee + finality     scan Bitcoin blocks (existing)
prove storage-slot inclusion of             recursively verify the eth-reflection proof
  crossOutCommitment[claimId]==destC          (sp1_zkvm verify_sp1_proof; eth vkey pinned)
  against finalized stateRoot                fold T_CROSSOUT_MINT note into the MAIN pool root
commit: CrossOut set root @ finalized slot    iff (claimId,destC,asset) ∈ verified set
                                              and leaf==destCommitment; add to live UTXO set
                                            commit Bitcoin roots (existing)  ── verified on
                                              Ethereum by attestBitcoinStateProven (line 699)
```

Why this is clean, not just feasible:
- The Bitcoin reflection proof is **already verified on Ethereum** (`attestBitcoinStateProven`,
  `ConfidentialPool.sol:699`, `BITCOIN_RELAY_VKEY`). Recursion makes the eth-consensus check ride
  transitively to that on-chain verification — **no new on-chain verify path**.
- `bridge_mint` works **uniformly** against the resulting roots — **no segregated cross-out
  accounting, no dedicated re-mint path**. Cross-out value is fully fungible once verified.
- On-chain delta is just a **new reflection vkey** (the redeploy we already accept) + the
  `crossOutCommitment` storage anchor (Phase 0, done).
- A Bitcoin-light client that wants to self-verify a cross-out verifies the same reflection proof
  off-chain (SP1 Groth16 verify) — Bitcoin-side acceptance is trustless too.

## Phases

- **Phase 0 — Storage anchor (DONE).** `ConfidentialPool.crossOutCommitment[claimId] = destCommitment`
  written in `settle` alongside `CrossOutRecorded` — a clean `eth_getProof` storage-slot target (state
  trie, not receipts). vkey-neutral (reads only existing PublicValues), rides any deploy.
  `test_cross_out_emits_record_and_spends_note` asserts it.
- **Inter-guest ABI (DONE).** `cxfer-core::eth_reflection` — the shared `EthCrossOut` record,
  `eth_crossout_leaf` (`keccak(claimId ‖ destChain ‖ destCommitment ‖ assetId)`, reusing the existing
  `claim_id` binding), `eth_crossout_member` (membership via the existing `keccak_merkle_verify`), and
  the `EthReflectionPublicValues` spec as the module contract. Both guests build the same leaf; the
  Bitcoin guest binds a `T_CROSSOUT_MINT` note without the Ethereum nullifier. KATs green (leaf field
  binding + accumulator membership round-trip + non-member/tampered rejection); 61 cxfer-core tests pass.
- **Phase 1 — guest compiles to ELF — ✅ (2026-06-12).** `contracts/sp1/eth-reflection/src/main.rs`
  (committed) built as `eth_reflection` inside sp1-helios's workspace on a fresh NGC-image box:
  `cargo prove build` rc=0, ELF at `target/.../riscv64im-succinct-zkvm-elf/release/eth_reflection`
  (2.2 MB). Confirms the light_client+storage flow + the `cxfer-core::eth_reflection` accumulator fold +
  `EthReflectionPublicValues` all compile, cxfer-core builds as a zkVM dep, slot index 76 locked by a
  forge test.
- **Phase 1 — guest EXECUTES + commits — ✅ (2026-06-12).** Host harness
  `contracts/sp1/eth-reflection/host/eth_reflection_exec.rs` (built in sp1-helios's `script` crate) fetches
  real Sepolia LC data (publicnode), runs the guest in the SP1 executor: **39M cycles, commits 256 bytes**
  of valid `EthReflectionPublicValues` — real `finalizedSlot` (10461536, 32-aligned), `syncCommitteeRoot`,
  `finalizedExecStateRoot`; `crossOutSetRoot` = empty-tree root (0 cross-outs this run, contract_storage
  empty). The audited sync-committee BLS + finality verification runs end-to-end in-zkVM. Guest fix:
  `head >= prev_head` (no-rollback, idempotent re-prove — strict `>` crashed on a same-finalized-slot run).
  GOTCHA: `cargo prove build` MUST run from `program/`, not the workspace root, else it compiles the host
  `script` crate (tokio/reqwest→socket2) for the zkVM target and dies. REMAINING for the full guest: the
  cross-out *fold* execute (needs the Mode-B pool deployed with a real recorded cross-out, Phase 4).
- **eth-reflection vkey (Phase-2 handoff, 2026-06-12).** Of the committed guest ELF (this commit; helios
  0.11.1, cargo-prove sp1 cfb5544). For the parallel session's `reflect.rs` recursion + `elf-vkey-pin.json`:
  - `bytes32` (pin / contract form): `0x0091c484a3daebe8b8a27b5841cb41661a754a4759e6d926fa647e6d33e80226`
  - `[u32;8]` (`ETH_REFLECTION_VKEY` for `verify_sp1_proof`): `[0x0091c484, 0xa3daebe8, 0xb8a27b58, 0x41cb4166, 0x1a754a47, 0x59e6d926, 0xfa647e6d, 0x33e80226]`
  - ELF sha256 (`eth_reflection_elf_sha256`): `369415ed2a5ab40e1abece0e987642200c36ff326b38da0724c3c8d3b47a2031`
  Recompute on ANY guest or toolchain change (the §5 vkey-coupling cascade) — drift makes the recursive
  verify fail.
- **Phase 1 (full guest) — `eth-reflection` guest.** Fork sp1-helios: beacon sync-committee + finality verification
  from a genesis checkpoint; storage-slot inclusion proof of `crossOutCommitment` against the finalized
  execution `stateRoot`; commit a CrossOut accumulator (the verified `(claimId, destChain,
  destCommitment, assetId)` set) + finalized slot for monotonicity. Own canonical-ELF + vkey-pin.
- **Phase 2 — recursive fold.** Extend the Bitcoin reflection guest to recursively verify the
  eth-reflection proof (pin its vkey as a constant), fold `T_CROSSOUT_MINT` (opcode `0x65`) notes into
  the pool root + live UTXO set only on verified membership + `leaf == destCommitment`. New reflection
  vkey. Node + KAT tests; extend `confidential-crosslane-roundtrip.mjs` to a full ETH→BTC→ETH loop.
- **Phase 3 — prover infra (box).** New eth-reflection prover loop: pull beacon light-client updates +
  `eth_getProof` for pending claimIds, prove, feed the proof as a witness into the Bitcoin reflection
  prover. Canonical-ELF discipline; heartbeat/monitoring; beacon data source.
- **Phase 4 — redeploy + wiring.** Redeploy ConfidentialPool with the new recursive `BITCOIN_RELAY_VKEY`
  + updated `REFLECTION_GENESIS_DIGEST`; Sepolia → mainnet. Migrate any pilot escrow.
- **Phase 5 — dapp/worker.** Cross-out broadcast + status (mostly built, `PLAN-crossout-consumer.md`);
  the worker no longer authoritative for cross-out validity — it's in the trustless reflection. Provide
  the off-chain reflection-proof verify path for Bitcoin-light clients.

## Phase 3 status + the remaining gaps (2026-06-17)

The prover infra is largely BUILT (the Phase 3 bullet above predates it). What exists, what's stale, what
remains — the eth inner-proof pipeline scope:

**Built + has run on the box (don't rebuild):**
- `eth-reflection` guest (`src/main.rs`) — complete + sound: helios sync-committee + finality, the pool
  storage-slot MPT proofs, folds each `crossOutCommitment` → cross-out set + each `bitcoinConsumed` →
  consumed set (with the on-chain `claimId` binding), enforces the freshness anchor (`consumedNuCount ==
  on-chain bitcoinConsumedCount`), commits the 11-word `EthReflectionPublicValues`.
- `prover-host/src/bin/eth_prove.rs` (stage-i) — helios bootstrap (pinned `GENESIS_SLOT`) → `eth_getProof`
  of the pool slots → preflight verify → **compressed** proof + `eth_pv.hex` (~50s).
- `prover-host/src/bin/bitcoin_prove.rs` (stage-iii recursion) — loads the eth proof, `write_proof`s it,
  proves compressed/groth16, local-verifies.
- `prover-host/run-reflect-loop.sh` — durable loop: `[REGEN_CMD] → eth_prove → bitcoin_prove groth16 →
  submit attestBitcoinStateProven`, GPU cleanup, heartbeat, digest persistence, reboot cron, DRY-RUN vs
  SUBMIT_URL. `lib.rs` (helios bootstrap), `eth_vkey.rs` (vkey derivation), the Phase-0 anchor, the
  inter-guest ABI, and the §A gate design (D1) are all in place.

**The remaining gaps:**
- **G1 — `eth_prove` proves an EMPTY set.** `crossouts`/`consumeds` are `vec![]` and the resume is
  hardcoded empty. Wire the witness population from on-chain events (`CrossOutRecorded` / the consumed
  events) + the `append_path` frontier per appended leaf + the cross-cycle resume
  (`prior_set_root`/`prior_count`/`prior_consumed_*` from the last cycle). The `eth_getProof` key
  derivation + preflight already handle non-empty key sets.
- **G2 — bitcoin_prove writer drift — DONE (2026-06-17).** The old `write_prior`/`write_scan_rest`
  predated the mode_b gate (no `mode_b` flag, `eth_pv` ungated, no consumed-ν loop, none of the Track-B/C
  or crossout witnesses). Factored the writer into a shared crate `contracts/sp1/reflect-stdin`
  (`write_stdin`, pure sp1-sdk/serde_json/hex) consumed by BOTH `reflect-exec` — DIGEST_MATCH-validated
  (forward `0x5ec86a90` + reverse mode_b=1 `0x1c05cc0c`) — and `bitcoin_prove`, so the prover writer can
  no longer drift from the guest. bitcoin_prove now gates the eth recursion on `modeB` and asserts
  `fixture.ethPv == eth proof public values` (the real `ethPool` word rides through so the on-chain
  `ethPoolReflected == address(this)` gate passes). Box setup: copy `contracts/sp1/reflect-stdin` →
  `/root/work/reflect-stdin` (sibling of `/root/work/confidential`).
- **G3 — indexer→fixture handoff — JS core DONE (2026-06-17), box emit + worker threading remain.**
  `buildModeBBatch` (confidential-pool.js) rebuilds the eth crossout/consumed sets from the eth proof's
  bundle and derives each leaf's FINAL membership path (NOT the append-time frontier); the scan-indexer's
  `assembleBlocks` now accepts `{ ethBundle, consumedSources }` → matches each 0x65 to its crossOutSet
  entry, stamps `env.membership`, and sets `batch.modeB`; the assembler prefers the real `modeB.ethPv`
  (populated `ethPool` for the on-chain gate) over the synthetic `buildEthPv`. Validated:
  `gen-reflection-modeb-synth` drives the full path THROUGH `buildModeBBatch` → reflect-exec DIGEST_MATCH
  `0x1c05cc0c`. **The eth-bundle contract** (what `eth_prove` must emit alongside `eth_pv.hex`):
  `{ ethPv:0x<704hex>, crossouts:[{claimId,destCommitment,asset}], consumeds:[{nu,spendRoot}] }` in the
  set's APPEND order. The attester threads it via an injected `ethBundleSource({from,to,blocks})` →
  `assembleBlocks` (forward batch when absent). Validated end-to-end through the production indexer:
  `gen-reflection-modeb-indexer` (worker-shaped block → `assembleBlocks` → `buildModeBBatch` → onboard) →
  reflect-exec DIGEST_MATCH `0xa9c689c9`. REMAINING: (a) `eth_prove` writes the bundle (box; couples with
  G1); (b) wire `ethBundleSource` to read `out/eth_set.json`; (c) the consumed-ν fast lane needs the worker
  to resolve each ν → its live source note's `cx,cy,txid,vout` (a live-note→outpoint index extension — the
  crossout-mint path needs none). (Also fixed `build-reflection-bootstrap-fixture.mjs`'s missing `await`.)
- **G4 — vkey + genesis pinning (lockstep).** The eth ELF's vkey must == `reflect.rs`'s
  `ETH_REFLECTION_VKEY`; the genesis anchor (`ETH_GENESIS_SYNC_COMMITTEE` + `GENESIS_SLOT 10462624`)
  captured together. The eth ELF is box-built inside sp1-helios's workspace — not a committed/pinned repo
  artifact yet; needs the canonical-ELF discipline the other guests have.
- **G5 — deploy/§A-gate (Phase 4).** Deploy with the recursive `BITCOIN_RELAY_VKEY` + the genesis anchor;
  the SAME coordinated re-prove bundle as the reflection Track-B/C work, not a standalone deploy.

**Validation ladder:** reflect-exec DIGEST_MATCH (done, no GPU) → compressed recursion on the box
(`PROOF_MODE=compressed`, fast — validates `verify_sp1_proof` accepts the eth proof over a real mode_b=1
fixture) → groth16 (on-chain fixture). G2 unblocks the first real recursive prove of a mode_b=1 fixture.

## Trust model (after Mode B)

- **Trust root:** SP1 soundness + the Succinct Groth16 verifier (immutable leaf, same as tETH) +
  Ethereum sync-committee honesty + a genesis sync-committee checkpoint (the one bootstrap, like the
  forward relay's genesis Bitcoin header). No admin, no oracle, no swappable prover.
- **Worker:** indexer only, never authoritative for cross-out validity. Cannot inflate, steal, or
  mislead — anyone re-derives.

## Phase-4 deploy decisions (2026-06-12)

**D1 (CORRECTED) — pool address ↔ vkey circularity: gate `ethPool == address(this)` ON-CHAIN; vkey stays
an immutable constructor arg.** The only real circularity is the *guest* pinning the pool address. It
doesn't need to — **the contract knows its own address**. So: the reflection guest does NOT pin
`ETH_POOL`; it passes `eth_pv.ethPool` THROUGH into `BitcoinReflectionPublicValues`, and
`attestBitcoinStateProven` gates `ethPoolReflected == address(this)` (blocks the fake-pool inflation:
an attacker's pool's crossOuts have a different ethPool → rejected). No CREATE2 gymnastics, no setter,
**`BITCOIN_RELAY_VKEY` stays immutable in the constructor**, plain CREATE deploy. (Superseded the
set-once/CREATE2 over-engineering — the eth vkey + genesis anchor aren't circular, so only the pool
address needed solving, and the on-chain gate is the clean break.) Cost: +1 `address ethPoolReflected`
field in `BitcoinReflectionPublicValues` + the on-chain gate.

**D2 — genesis / sync-committee anchor: CHAINED weak-subjectivity, not a fixed current committee.** A
fixed `ETH_SYNC_COMMITTEE_ANCHOR == current` breaks at the first sync-committee rotation (~27 h), so it
must be a **genesis** the proof chains forward from: pin a recent Sepolia finalized checkpoint (block
root + its sync committee) as `ETH_GENESIS_SYNC_COMMITTEE`; the eth-reflection commits BOTH
`prevSyncCommitteeHash` and `syncCommitteeHash` (sp1-helios already computes both — I only surfaced the
current one), and the Bitcoin guest gates the genesis ONCE (first proof's `prev == genesis`) then chains
(`prev == last current`) via the resume-digest. Mirrors `REFLECTION_GENESIS_DIGEST`.

**These decisions reveal the re-prove is a chain, not a one-shot:**
1. eth-reflection guest: add `prevSyncCommitteeHash` to `EthReflectionPublicValues` + pin the genesis
   bootstrap → re-prove (`.compressed()`) → NEW eth vkey + the genesis anchor. (Supersedes the
   handed-off vkey `0x0091c484`, which was the single-shot guest.)
2. `ConfidentialPool.sol`: vkey `immutable`→set-once + a CREATE2 deploy script → compute the pool address.
3. `reflect.rs`: set `ETH_REFLECTION_VKEY` (new eth vkey), `ETH_POOL` (CREATE2 addr),
   `ETH_GENESIS_SYNC_COMMITTEE` (genesis) + the genesis-once-then-chain gate + the resume-digest extension.
4. recursive re-prove the Bitcoin reflection (stage-i compressed eth → stage-ii `write_proof` → stage-iii
   groth16 outer) → NEW `BITCOIN_RELAY_VKEY`.
5. conservation negative test on the new reflection ELF + add the vkey to the gate allowlist → **BRIDGE clears**.
6. Phase-4 redeploy (CREATE2) + `setBitcoinRelayVkey` + verify.

This is a deliberate, fund-critical production phase (a guest rework + TWO recursive GPU proves + a
contract change + a deploy), not a tail-of-session rush.

## Confirmed (toolchain + data plane, 2026-06-12)

- **SP1 recursion supported.** Box (`ssh9.vast.ai:12876`, RTX 4090 24 GB, 130 GB free) runs
  `cargo-prove sp1 (150e629, 2026-05-23)`; cxfer pins **sp1-zkvm/sp1-lib 6.2.3**;
  `sp1_lib::verify::verify_sp1_proof(vk_digest:[u32;8], pv_digest:[u8;32])` is present → the recursive
  fold is viable. Host adds the `compressed()` inner-proof flow in Phase 3 (6.2 SDK supports it; not
  used today since the existing flow only emits Groth16).
- **Beacon + execution data plane: `publicnode.com`, keyless, both Sepolia and mainnet.**
  - Beacon LC API (200): `https://ethereum-beacon-api.publicnode.com` / `…-sepolia-beacon-api…` serve
    `/eth/v1/beacon/light_client/{finality_update,updates}` (verified live). `lightclientdata.org` is
    dead (503); drpc needs a token.
  - Execution: `https://ethereum-sepolia-rpc.publicnode.com` (chainId 0xaa36a7) serves `eth_getProof`
    (account + storage proof) — the `crossOutCommitment` inclusion source.
- **No existing sp1-helios** in repo or on the box → Phase 1 vendors it fresh.

## Phase-1 integration map (sp1-helios is an ADAPTATION, not a from-scratch fork)

sp1-helios (HEAD `bbc1d66`, tag `v1.1.4`; Zellic-audited) already ships the two components we need, so
`eth-reflection` = its `light_client` program + our accumulator fold:
- `program/src/light_client.rs` verifies sync-committee `updates` + `finality_update`
  (`helios_consensus_core::{verify_update, apply_update, verify_finality_update, apply_finality_update}`)
  AND **already verifies contract storage-slot MPT proofs against the finalized execution state root**
  (`verify_storage_slot_proofs`), committing `StorageSlot { bytes32 key; bytes32 value; address
  contractAddress }[]` in `ProofOutputs`.
- So our guest: take that program, and over its verified `storageSlots` (each a `crossOutCommitment`
  slot of our pool), for each one read witnesses `(claimId, destChain, nullifier, assetId)`, assert
  `key == mappingSlot(claimId)`, `value == destCommitment`, `claimId == claim_id(destChain,
  destCommitment, nullifier, assetId)`, then append `eth_crossout_leaf` to the
  `KeccakTreeAccumulator` and commit `EthReflectionPublicValues` (map: `finalizedExecStateRoot =
  executionStateRoot`, `finalizedSlot = newHead`, `syncCommitteeRoot = syncCommitteeHash`).
- Inputs (`ProofInputs`): `updates`, `finality_update`, `expected_current_slot`, `store`
  (`LightClientStore<MainnetConsensusSpec>`), `genesis_root`, `forks`, `contract_storage`
  (`{ address, value: TrieAccount, mpt_proof, storage_slots: [{key, value, mpt_proof}] }`). All sourced
  from publicnode (beacon LC API + `eth_getProof`).
- Critical `[patch.crates-io]` to replicate (zkVM): sp1-patched `sha2`(0.9.9/0.10.9), `sha3`,
  `tiny-keccak`, **`bls12_381`** (all `-sp1-6.0.0` tags) + `ethereum_hashing` (ncitron fork).

**Fork status (corrected):** helios 0.11.1 *and* master both list only `variants(…Electra)` for the LC
containers — no Fulu SSZ variant. Fulu is the PeerDAS/DA fork; it does **not** change the LC-relevant
containers, so a Fulu LC object is Electra-shaped. The only open question is fork-version *routing*
(does helios accept `"version":"fulu"` and map it to Electra types) — a small `Forks`-config addition at
worst, confirmed by the FIRST empirical milestone below, not a container rewrite. Base on helios
**master** (`1fbb9099ff57917061630069744ec1ff9098c3a6`, has the fulu routing) rather than tag 0.11.1;
sp1-helios HEAD bumps its helios dep to that commit.

**First empirical milestone — ✅ PASS (2026-06-12).** `script/bin/lc_probe.rs` on the box bootstrapped
helios **0.11.1** (audited pin, no master bump) against publicnode Sepolia and parsed + verified a real
`fulu` finality_update (finalized slot 10460896) + a sync-committee update. Fulu confirmed Electra-shaped
(no container change) → **stay on the audited 0.11.1**; full stack (helios + sp1-sdk 6.1 + alloy) builds
and runs on the box; publicnode data plane proven end-to-end. Scaffolding proceeds against 0.11.1.

## Open decisions / risks

- **Weak subjectivity / liveness.** Light clients bootstrap from a recent-enough trusted checkpoint and
  must follow sync-committee period transitions; offline > ~2 periods needs a fresh checkpoint. Define
  the bootstrap + a liveness SLA for the eth-reflection loop.
- **Proving cost.** sp1-helios (BLS12-381 pairings) + recursion + the Bitcoin scan in one cycle is the
  real cost. Measure on the 4090; consider proving cadence (per finalized epoch / per pending cross-out
  batch).
- **CrossOut set commitment shape.** How the eth-reflection commits the verified set (accumulator root
  the Bitcoin guest does membership against, vs. a bounded list) — pick for the Bitcoin guest's lookup.
- **Genesis sync-committee anchor** must be a fixed constant (no governance), tied to the eth-reflection
  vkey — mirror `REFLECTION_GENESIS_DIGEST`.

## Reused vs net-new

| Reused | Net-new |
|---|---|
| SP1 stack, canonical-ELF/vkey-pin discipline, Groth16 verifier trust root | `eth-reflection` guest (sp1-helios fork) |
| `attestBitcoinStateProven` + `bridge_mint` (unchanged; new vkey only) | SP1 recursion in the Bitcoin reflection guest |
| Box prover-loop + queue pattern, monotonic anchor | Beacon light-client data pipeline + genesis anchor |
| CrossOut consumer / `T_CROSSOUT_MINT` wire format | The `crossOutCommitment` storage anchor (Phase 0, done) |
