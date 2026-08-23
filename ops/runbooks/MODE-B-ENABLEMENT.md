# Mode-B enablement — ETH→BTC reverse-fold runbook

Enables the reverse bridge fold: onboarding an ETH `crossOut` (OP_BRIDGE_BURN) as a
live confidential note on the Bitcoin side. Forward (BTC→ETH) is already live; the
reflection pipeline runs **forward batches (mode_b=0)** where every `T_CROSSOUT_MINT`
(0x65) is deliberately skipped (`crossout_set_root=0` → membership fails, no-op).

> **CRITICAL — this is a POOL REDEPLOY, not an in-place switch.** The live mainnet pool
> `0x846B`'s immutable reflection ELF (pinned via `BITCOIN_RELAY_VKEY`) recursively verifies
> the eth-reflection proof against a hardcoded `ETH_REFLECTION_VKEY` whose eth-reflection
> guest is **Sepolia-anchored** (`ETH_GENESIS_SYNC_COMMITTEE` @ Sepolia finalizedSlot
> 10462624; host `SOURCE_CHAIN_ID=11155111`). No `eth_pv` proving a *mainnet* pool's storage
> can verify against it. So Mode-B on mainnet requires re-anchoring the eth-reflection guest
> to mainnet beacon → new `ETH_REFLECTION_VKEY` → rebuilt reflection ELF (new
> `BITCOIN_RELAY_VKEY`) → **new ConfidentialPool deployment**. Any crossOut already recorded
> on `0x846B` cannot be folded (see [[project_modeb_mainnet_sepolia_anchor]]). The steps
> below apply to the *new* Mode-B-anchored pool, not the current one.

## In-flight crossout to fold first (2026-07-11)

One reverse-bridge is mid-flight and will onboard on the first Mode-B batch that covers
its 0x65 block. Full record + bearer spend key: `tacit-box-backup-2026-07-09/note2/crossout-inflight-95tac.json`.

- 95 TAC, bearer note (owner = 0), asset `0xf0bbe868…762b`
- ETH crossOut settle: `0x8449d49e…` (claimId `0x07d52d84…`, destCommitment `0xe0aa89f1…`)
- Bitcoin 0x65 reveal: `83e59e8b…` (block 957563) — decodes to the recorded claimId
- Spend key = blinding `0x4c1adf25…` (the note is spendable on Bitcoin once folded)

Nothing is stranded: the crossout is permanent on ETH and the 0x65 is permanent on
Bitcoin, so the fold reconstructs deterministically whenever Mode-B runs.

## Why it's a build-out, not a flag

The reflection guest **recursively verifies** the ETH bundle's `eth_pv` against the pool's
`ETH_REFLECTION_VKEY`. A synthetic bundle won't pass — it needs a real eth-reflection
proof. The prover box currently has only the cxfer settle/reflection guest; the
eth-reflection guest, its toolchain, and the mode_b assembler are absent.

## Preconditions (provision the box once)

1. SP1/Succinct toolchain: install `cargo-prove` (`sp1up`), confirm `cargo prove --version`.
2. Sync `contracts/sp1/eth-reflection/` to the box working dir (`/root/work/confidential/`).
3. Build the eth-reflection guest ELF: `cargo prove build` → `confidential-pool-prover`.
   - Derive its vkey on the box (`prover-host/src/bin/eth_vkey.rs`).
   - It MUST equal the pool's on-chain `ETH_REFLECTION_VKEY` (rotatable/owner-set, not one of
     the immutable pins in `elf-vkey-pin.json`). If it differs, the pool admin rotates
     `ETH_REFLECTION_VKEY` to the freshly-derived key BEFORE any fold, else the mode_b
     reflection attest reverts on the recursive verify. Any ELF drift → `ProofInvalid`.
4. ETH light-client config for mainnet: sync-committee + storage slot indices for
   `crossOutCommitment` (see `CHECKLIST-mainnet-reprove.md`; watch the `CONSUMED_AT`/slot
   drift notes).

## Fold sequence

1. **ETH bundle** — run `exec_crossout` (eth-reflection prover) over the recorded crossout
   op → `eth_pv.hex` carrying the populated `ethPool` (`crossOutCommitment[claimId]==destCommitment`).
   Assemble `ethBundle = { ethPv, crossouts:[{claimId,destCommitment,asset}], consumeds:[] }`.
2. **Mode-B witnesses** — `pool.buildModeBBatch(ethBundle, crossoutTxs, consumedSources)`
   (`dapp/confidential-pool.js`) → `modeB.crossoutImt` + the per-0x65 membership witnesses.
3. **Reflection batch (mode_b=1)** — drive the scan-reflection attester with an
   `ethBundleSource` returning that bundle for the block range covering the 0x65
   (`worker/src/reflection-attest.js` → `ethBundle`). Assemble → `reflect_prove` (bitcoin_relay_vkey).
4. **Attest** — `attestBitcoinStateProven(pv, proof)` on the pool. The 0x65 folds; the dest
   note (`leaf(asset,cx,cy,0)` = destCommitment) is now live and spendable on Bitcoin.
5. Verify: the reflection state includes the folded note; the bearer blinding spends it.

## Notes

- `buildBridgeBurn`'s JS `destLeaf` binds the provided owner, but the guest computes
  `dest_commitment = leaf(asset,cx,cy,0)` (bearer). Always use owner=0 for the 0x65
  envelope + any dapp-side crossout leaf reconstruction, or the leaf won't match.
- This is the documented "TAC-first two-way, enable Mode-B post-launch" rollout step;
  forward bridge + wrap/unwrap + confidential fungibility are already live and need none of it.
