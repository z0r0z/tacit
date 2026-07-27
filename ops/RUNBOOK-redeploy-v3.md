# Redeploy v3 runbook — reprove (guest bug fix) → redeploy (near-tip seed)

Push-button sequence for after the guest bug fix lands. Goal: new vkeys from the fixed guest,
new pool seeded NEAR-TIP (no big fold), nothing drifting between ELF / prover-bins / fixtures / deploy.

## What actually rotates (verified against the tree, 2026-07-27)

| Thing | Rotates? | Mechanism |
|---|---|---|
| `PROGRAM_VKEY`, `BITCOIN_RELAY_VKEY` | **YES** — from the reprove | **Constructor immutables** (`ConfidentialPool.sol:150,158`). There is **no vkey setter** — the pool has no owner and no admin function at all. A vkey change is a **full pool redeploy**, never a parameter update. |
| `SP1_VERIFIER` `0xb69f2584…` | no | Reused. On-chain verify keys off the SP1 **circuit version** (v6.2.x), not ELF bytes. Codehash asserted at deploy via `EXPECTED_VERIFIER_CODEHASH`. |
| `HEADER_RELAY` `0x1677A5A3…` | no | Reused (BitcoinLightRelay is standalone + pool-agnostic). |
| `CANONICAL_FACTORY` `0x0000…8F90` | no | Reused — `CANONICAL_FACTORY` set in the env short-circuits the factory CREATE3 (`DeployV1SuiteCreateX.s.sol:173`). Canonical token addresses are `f(assetId)` off this factory, so reusing it keeps cETH/cTAC/cBTC/cUSD addresses **stable across the redeploy**. |
| Pool, Engine, Adapter, Router, Relayer, BtcCallExecutor | **YES** | Immutable CREATE3 redeploy at the round-3 salts. Router/Relayer/BtcCallExecutor take `pool` in their ctor ⇒ they *must* rotate with the pool. |
| Engine policy (feeds, ratios, staleness, pool ptr, owner) | parameterized | `setFeeds` / `setParams` / `setPool` / `transferOwnership` — done in-script, in the same broadcast. `setPool` is one-shot and enforces the M-01 reciprocal bind (`CollateralEngine.sol:302-311`). The engine is the **only** Ownable piece in the suite (see H-02 in the ledger). |

## State already staged (done before "go")
- **Deploy env**: `contracts/deployments/redeploy-v3.env` — near-tip reflection seed baked in:
  `REFLECTION_RESUME_DIGEST=0x0df5dd17` (@958735, VERIFIED == c5B537 on-chain), `GENESIS_REFLECTION_ANCHOR=0x52bb4d1f…` (block 958735 = relay tip−6). Reused externals + engine-admin + verifier-codehash filled. **Pending: vkeys + salts.**
- **Near-tip folder seed**: `nearseed-kv-958735.json` (scratchpad) — `{snapshot,attestedHeight,tipHeight}` @958735, 7578 notes. Upload to the folder/worker at cutover so the first attest is a ≤6-block incremental fold, NOT the 584-block trap.
- **Vanity salts**: **MINED AND ASSIGNED** — `contracts/deployments/vanity-salts-round3-permissioned.env` is the applicable salts file, and its six salts are already inlined into `redeploy-v3.env` (the "PENDING mining" comment there is stale). Mined with `createXcrunch create3 --caller 0x68575B --leading 5`; permissioned (`salt[0:20] == deployer 0x68575B…`, `salt[20] == 0x00`) so they are front-run-proof and safe to publish, and `salt[20] != 0x01` keeps the address chain-portable (`DeployV1SuiteCreateX.s.sol:80`). Landing addresses:
  - POOL `0x00000000000656b804235d4a94f901803391aa7c` (premium 5.5-byte) · ENGINE `0x00000000003db970…` · ADAPTER `0x0000000000bfa057…` · ROUTER `0x0000000000e5ddd5…` · RELAYER `0x00000000004595e3…` · BTC_CALL_EXECUTOR `0x000000000008338a…`
  - The script's hard guard is only 4 leading zero bytes (`_requireFourZeroBytes`) under `REQUIRE_VANITY=true`; the exact addresses above are the real assertion — eyeball them in the dry-run.
  - Spare salt available in the salts file if one slot needs reassigning (they are interchangeable; the factory is reused so `SALT_FACTORY` stays unset).
- **SP1 toolchain**: v6.2.x on box at `/workspace/.sp1/bin` (matches guest `sp1-zkvm 6.2.3`).

## Toolchain reality (why this is safe without byte-reproduction)
SP1 ELF builds are non-deterministic without `--docker` (no docker on this box), so a rebuild will NOT
reproduce the old `37b2a233`. That's fine: on-chain verify by `0xb69f2584` depends on the SP1 **version**
(v6.2.x circuit), not ELF bytes. Safety comes from **one ELF build used everywhere** + the on-chain gate below.

## REPROVE (once the fixed source is final)
Run in `contracts/sp1/confidential/` on the box (`export PATH=/workspace/.sp1/bin:/workspace/cargo/bin:$PATH`).
1. **Sync the final source to the box** (it's a source copy, not git — rsync the exact committed tree).
2. **Build the ELFs ONCE** (this exact binary is authoritative for all downstream):
   - settle:      `cargo prove build --bin confidential-pool-prover` → copy to `elf/cxfer-guest`
   - reflection:  `cargo prove build --bin reflection-prover`        → copy to `elf/reflection-prover`
   - eth-reflection (only if the reflection/eth guest changed): `cd ../eth-reflection && cargo prove build --bin eth_reflection`. If rebuilt, its recursion vkey changes ⇒ update `ETH_REFLECTION_VKEY` in `reflect.rs` and **rebuild reflection-prover in lockstep** (per CHECKLIST-mainnet-reprove.md items 1–2).
3. **Derive vkeys** from the just-built ELFs (copy ELF to the harness include path first, then run an exec harness which prints `PROGRAM_VKEY`; eth recursion vkey via `eth-reflection/prover-host/eth_vkey`).
4. **Re-pin ATOMICALLY**: update `elf-vkey-pin.json` (program_vkey, bitcoin_relay_vkey, eth_reflection_vkey + all three `elf_sha256`) **in the same commit as the ELF binaries** (the process rule that was violated last round). Run `./verify-vkey-pin.sh`.
5. **Regenerate fixtures** at the new vkeys: `./build-all-network.sh` (prover-bins) + `./gen-all-reflection-fixtures.sh`; then MODE=execute smoke on changed ops (serializer/witness parity).
6. **ON-CHAIN GATE (do not skip):** run the `*ProofReal` forge suites — they verify a real Groth16 proof of the new ELF against `0xb69f2584`. GREEN ⇒ toolchain+vkey are deployable. RED ⇒ STOP (toolchain/circuit mismatch — need the exact prod toolchain or `--docker`).

## REDEPLOY — ordered, copy-pasteable

Run everything from the repo root unless a step says otherwise. `PRED` = the predecessor (currently-live V2)
pool `0x00000000000f5DE1295Ab2F0649fDE3855b66020`; `DEPLOYER` = `0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7`.

```sh
export RPC=https://ethereum-rpc.publicnode.com
export PRED=0x00000000000f5DE1295Ab2F0649fDE3855b66020
export DEPLOYER=0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7
```

**7. GATE — predecessor drain / one-funded-generation (C-02, R-01).** Do this FIRST: it is the only gate that
can force the whole deploy to wait, and it is checkable before anything is built. Full rationale in the
"C-01 GATE — predecessor drain" section below. Mechanically, on `$PRED`:

```sh
# a) Per registered asset: the pool's escrow mapping is `internal` (ConfidentialPool.sol:261) — no getter.
#    Check the publicly-equivalent BACKING instead: the underlying ERC20 balance held by the pool.
#    Enumerate registered assets from the AssetRegistered logs, then per asset:
cast call <underlying> "balanceOf(address)(uint256)" $PRED --rpc-url $RPC        # must be 0
cast balance $PRED --rpc-url $RPC                                               # native ETH escrow: must be 0
# b) Pool-minted canonical tokens (bridged/CDP) — a live supply is a redeemable liability:
cast call <canonicalToken> "totalSupply()(uint256)" --rpc-url $RPC              # must be 0  (incl. predecessor-engine cUSD)
# c) Funded farm controllers:
cast call $PRED "farmTreasury(address)(uint256)" <controller> --rpc-url $RPC    # must be 0
```
All zero ⇒ a duplicate Bitcoin-lineage claim in the successor is unbacked. Record `$PRED` + the zeroed
balances in the deploy log. **If not drained, STOP** — do not let the successor accept deposit/wrap/bridge-mint.

**8. Fill `contracts/deployments/redeploy-v3.env`.** Only two fields are still placeholders:
`PROGRAM_VKEY` and `BITCOIN_RELAY_VKEY`, copied verbatim from the freshly re-pinned
`contracts/sp1/confidential/elf-vkey-pin.json` (step 4). Salts, verifier, codehash, externals, engine admin
and confirmations are already correct. Do **not** set `ALLOW_UNPINNED_VKEY` — the script asserts
`PROGRAM_VKEY == elf-vkey-pin.json` (`DeployV1SuiteCreateX.s.sol:106`) and that assert is the whole point.
Note the script's built-in defaults are the CURRENT LIVE vkeys (`0x00014cc4…` / `0x00580f84…`), so an unset
env silently deploys the old generation — the placeholders must be replaced, not deleted.

**9. Re-verify the reflection anchor.** If the relay has advanced past 958741, walk `relay.tip()−6` for the
new matured hash and fold `nearseed-kv-958735.json` forward that SMALL delta; update
`GENESIS_REFLECTION_ANCHOR` + `REFLECTION_RESUME_DIGEST` to match. If the reflection guest changed (it did
this round), re-derive the seed digest against the updated JS indexer FIRST — guest and indexer must agree or
the first attest reverts `StaleReflectionDigest`.

**10. Dry-run (no broadcast).**
```sh
cd contracts && source deployments/redeploy-v3.env
forge script script/DeployV1SuiteCreateX.s.sol:DeployV1SuiteCreateX --rpc-url $RPC --sender $DEPLOYER
```
Must print all six vanity addresses matching the salts file (§ staged state) and "Script ran successfully."
Also assert here: **O-1** — the pool/relay bytecode about to land is `BitcoinLightRelay` itself, not a
PoW-disabling test subclass; **L-1** — `MAX_TARGET` + `genesis(startTimestamp)` and EIP-170 headroom
(`contracts/pool-bytecode-pin.json`, `contracts/verify-pool-size.sh`).

**11. Broadcast.**
```sh
forge script script/DeployV1SuiteCreateX.s.sol:DeployV1SuiteCreateX \
  --rpc-url $RPC --broadcast --slow --private-key <box NETWORK_PRIVATE_KEY> --verify
```
One broadcast covers engine + adapter + pool + `setFeeds`/`setParams`/`setPool`/`transferOwnership` + router +
relayer + btcCallExecutor. Verify each on Etherscan.

**12. Confirm on-chain.**
```sh
export POOL=<new pool>
cast storage $POOL 80 --rpc-url $RPC                       # == REFLECTION_RESUME_DIGEST (knownReflectionDigest is internal)
cast call $ENGINE "POOL()(address)" --rpc-url $RPC         # == $POOL   (M-01 reciprocal bind landed)
cast call $ENGINE "owner()(address)" --rpc-url $RPC        # == ENGINE_ADMIN 0x006CD14F…
```
The script writes `contracts/deployments/1-createx.json` (manifest; `WRITE_MANIFEST=true` by default).

## POST-DEPLOY

**13. Prover bins.** Publish **prover-bins-v3** (new-vkey `exec-*` + `bitcoin_prove`; keep `bitcoin_prove` at
cycle_limit 4B), update `worker-relay/prover/bin/SHA256SUMS` and bump `worker-relay/Dockerfile`
`ARG PROVER_RELEASE=prover-bins-v2` → `prover-bins-v3`. If any op gained a harness this round (e.g.
`exec-swapblind`), add it to the Dockerfile's fetch list — that list is hand-maintained and does not
auto-track `harnesses/`.

**14. Reflection bootstrap.** Seed the folder from `nearseed-kv-958735.json` (near-tip), then drive:
```sh
node tools/reflection-bootstrap-v2.mjs --dry-run          # assemble batch 1, assert prior digest == seed, NO prove/attest
node tools/reflection-bootstrap-v2.mjs --batches=1        # land one real attest
node tools/reflection-bootstrap-v2.mjs --to=<height>      # then loop to matured tip
```
⚠️ `tools/reflection-bootstrap-v2.mjs` hardcodes `POOL` / `GENESIS_HEIGHT` / `RESUME_DIGEST` /
`GENESIS_ANCHOR` as top-of-file consts (lines ~38-42, currently the V2 pool @958151) — **edit them to the new
pool + this round's near-tip seed before running**. It is not env-driven. First attest must be the ≤6-block
incremental fold, not the 584-block trap.

**15. Worker repoint.** `worker-relay/render.yaml` → `POOL_ADDR` = new pool, then redeploy the Render
services. Resume folding.

**16. Manifest + dapp repoint.**
```sh
node tools/sync-deployment-config.mjs contracts/deployments/1-createx.json --network mainnet --live cTAC --write
```
This writes `dapp/confidential-deployments.generated.js` (pool/router/engine/factory/deployBlock/live) and
patches `CONFIDENTIAL_POOL_DEPLOYMENTS` in `dapp/confidential-crossout-consumer.js` (the worker imports that
module, so the indexer scan height is wired in the same edit). Run without `--write` first — it is dry-run by
default. Omitting `--live` drops the current `live: ["cTAC"]` flag, so keep it unless de-advertising is
intended. Then hand-update `contracts/deployments/1.json` (the richer hand-maintained manifest: vkeys, asset
ids, reflection anchor/digest, eth-reflection genesis) — `sync-deployment-config` does **not** touch it.

**17. Dapp bundle + IPFS pin.** Rebuild the brotli dapp bundle, publish, and pin the new CID to both pinning
services (w3/storacha + the Filebase mirror), then update the DNS/gateway pointer. There is **no committed
script for this** — `scripts/pin-asset-metadata.mjs` pins asset metadata only, not the dapp bundle. Follow the
`ops/PLAN-render-migration.md` §IPFS notes (`ipfs --api … pin add <cid>` per manifest line) and record the CID
in the deploy log.

**18. Commit** the env, manifest, generated dapp config, SHA256SUMS/Dockerfile bump and docs together.

## Safety gates (all must be green before broadcast)
predecessor-drain gate (step 7) · `verify-vkey-pin.sh` · `*ProofReal` on-chain verify · `verify-pool-size.sh`
EIP-170 headroom · deploy dry-run vanity + O-1/L-1 assertions · slot-80 digest + engine reciprocal check
post-deploy.

## Known-stale vs the current tree (fix or re-confirm at "go")
- `redeploy-v3.env` header comments still say salts are "PENDING mining" — they are mined and inlined
  (round-3 permissioned set). Only the two vkeys are genuinely pending.
- `redeploy-v3.env` `SALT_POOL` carries no `# => addr` comment unlike the other five; it does match
  `vanity-salts-round3-permissioned.env` byte-for-byte (→ `0x…0656b804`). Add the comment for symmetry.
- `worker-relay/render.yaml` `POOL_ADDR` is `0x0000000000c5B537…` — that is the pre-V2 pool, i.e. it was
  never repointed at the V2 redeploy. Confirm what the live service actually runs before assuming step 15 is
  a one-line change.
- `worker-relay/Dockerfile` is on `prover-bins-v2` and its `exec-*` fetch list has no farm/blind-swap
  harnesses.
- `tools/reflection-bootstrap-v2.mjs` (V2 pool @958151) and `tools/reflection-bootstrap-mainnet.mjs`
  (V1 pool `0x…13f1C5` @957443) both carry hardcoded prior-generation constants.
- `contracts/deployments/` holds eleven `vanity-salts-*.env` files; only
  `vanity-salts-round3-permissioned.env` applies to this deploy. Consider archiving the rest.
- The old step "update `deployments/1.json` + generated js" conflated two different artifacts and the wrong
  manifest path; the script writes `contracts/deployments/1-createx.json` (projectRoot is `contracts/`).

### Audit-response gates (Opus 5 r2)
- **F-1 LAUNCH-BLOCKER — OP_SWAP_BLIND end-to-end validation.** The op-31 dispatch arm is live in the immutable
  vkey and is armable off-chain later (no redeploy). It must NOT reach a live emitter until its groth16.rs gate
  **item 3** is closed: an end-to-end `MODE=execute` OP_SWAP_BLIND run over a full real envelope against the new
  ELF (arming ladder step 5 below). Items 1/2/4 are DONE against the burned key. Until step 5 is GREEN, ship NO
  op-31 emitter (dapp/worker). Conservation is Rust-enforced and tips fail-closed regardless, so an un-emitted
  live arm is bounded — but the emitter is gated on step 5.
- **O-1 deploy check.** `BitcoinLightRelay._verifyPow`/`_bitsToTarget` are `virtual` (test-mock hook). Confirm the
  DEPLOYED bytecode is `BitcoinLightRelay` itself, not a PoW-disabling subclass — assert in the deploy dry-run.
- **L-1 irreversible relay params (verify before broadcast, un-fixable after).** `genesis(startTimestamp)` off by
  one second permanently mis-targets the first retarget — derive from the real first-block header, cross-check
  two explorers. `MAX_TARGET` is network-specific — confirm the mainnet value. Confirm EIP-170 headroom (pool
  bytecode pin shows a thin margin) so the deployed bytecode is under 24,576 B.
- **H-2 (optional, blind-swap defense-in-depth).** `groth16.rs` `g2()` trusts the `bn` dependency's
  `check_order()` default for G2 subgroup safety. If the op-31 path arms (item-3 GREEN), consider an explicit
  in-guest `is_in_subgroup`/cofactor check in `g2()` rather than delegating to the dependency default. Dormant
  until armed; not a blocker.

### GPT-round findings (reflection guest — ride this reprove)
- **C-01 (was Critical) FIXED — scan-free burn censorship.** The burn-deposit consumed-outpoint gate now proves
  its presence verdict (member→skip, non-member→fold, lying witness→ABORT) instead of silently skipping on a
  prover-supplied bad path. **Box work:** the reflection witness emitters must supply the new `co_is_member`
  bit + the matching membership/non-membership witness per burn-deposit; add the negative vectors (absent+bad
  path → abort; present+claimed-absent → abort; competing malicious/honest proofs → only the valid one accepted).
- **H-01 (was High) FIXED — Bitcoin AMM intent authorization.** T_SWAP_VAR / T_SWAP_ROUTE / T_SWAP_BATCH folds
  now BIP-340-verify the trader's intent (destination, min_out, tip, expiry, input cross-curve for batch) with
  builders KAT-pinned to the worker. **Box work:** end-to-end MODE=execute vectors per opcode (the 15 positive/negative vectors in ops/REPROVE-amm-box-vectors.md) (valid folds;
  bad-sig / expired / substituted-c_in_bjj / redirected-receipt all abort). The T_SWAP_ROUTE destination binding
  is RESOLVED (the route intent binds the receipt destination; guest+worker+dapp) — no SIGHASH
  dependency. See ops/SPEC-btc-amm-intent-auth.md.
- **H-01 follow-up (was fund-critical) FIXED — receipt destination is the REAL script.** The folds bind
  `receive_spk` as the scriptPubKey read verbatim from the confirmed tx, not a reconstructed `0x5120 ‖ x-only`
  P2TR program. The emitters pay receipts to P2WPKH, so the reconstruction matched no honest signature: every
  T_SWAP_VAR would have failed auth in-guest after the vin scan had already nullified the taker's input —
  principal stranded, and the worker credited a receipt the reflection never onboarded. **Gate:** run
  `node tests/amm-intent-msg-pin.test.mjs` (8/8) — it executes the REAL worker + dapp builders against the
  digests parsed out of `bitcoin.rs`, so guest/worker/dapp cannot drift. Re-run after ANY intent-message
  change and re-pin the Rust KATs from its output. **Box work:** the end-to-end vectors above must use a
  P2WPKH receipt output (the emitter's real shape), not a synthetic P2TR one.

### Farm-auth audit round (C-01 Critical / H-01 / M-01 + sweep)
- **C-01 (Critical) FIXED — farm/LP-bond authorization discarded.** `T_FARM_INIT` and `T_LP_BOND` verified only
  the conservation kernel and discarded `launcher_sig`/`bonder_sig`, so a coordinator could reuse a victim's
  funding kernel under attacker ownership/terms and drain the treasury / bonded principal. The folds now
  BIP-340-verify those signatures over `farm_init_msg` / `lp_bond_msg` (the latter extended to bind the receipt
  `owner_commit`+`nonce`), KAT-pinned to the worker/dapp. **Rides the reprove** (guest change). Box vectors:
  init/bond with a wrong/garbage identity sig → skip; correct sig → fold.
- **SWEEP result (clean):** every other value-bearing op verifies its authorization in-guest — farm refund
  (`launcher_sig`, also bound to the farm's stored launcher), harvest/unbond (`owner_sig`), cmint
  (`issuer_sig`), adaptor (`claim_sig`), stealth-claim, BtcCall. The discarded-signature pattern was confined
  to init/bond.
- **H-01 (High) FIXED in-guest — CXFER + LP add/remove destination binding.** The folds read the output
  destination auth from the confirmed tx (`output_p2tr_xonly(..).unwrap_or([0;32])`) without binding it in the
  signed kernel. It was never an active exploit under the live policy — the emitters sign **SIGHASH_ALL**
  (`dapp/tacit.js:626`, `worker:8546`), so the sender's Bitcoin signature already commits to every output →
  destinations are Bitcoin-consensus-bound on the confirmed tx. The residual (defense-in-depth) is now enforced:
  the guest inspects each **note-spend input's witness signature** and requires its sighash flag be
  SIGHASH_DEFAULT (64-byte Schnorr = implicit ALL) or SIGHASH_ALL (0x01) before it onboards the reflected notes —
  the destination integrity no longer rests on wallet policy. Approach (a) from the audit note (witness-sighash
  enforcement); **no kernel message changed**, so the 19/19 amm-intent-msg-pin stays byte-identical and this rides
  the C-01 vkey rotation (no extra reprove). New `cxfer-core::bitcoin` helpers `input_first_witness_item` /
  `sig_binds_all_outputs` / `note_spends_bind_outputs`, gated in `reflect.rs` (`fold_cxfer`, `fold_lp_add`,
  `fold_lp_remove`) and mirrored byte-for-byte in the JS assembler (`dapp/burn-deposit-bitcoin.js` +
  `dapp/confidential-pool.js`) so the guest↔assembler witness stream + note-tree stay in lockstep.
  - **Adaptor exception (load-bearing scope).** The enforcement is scoped STRICTLY to the pool-note inputs of a
    PURE confidential transfer (opcode `0x22`/`0x23`) and LP-add/LP-remove. The atomic-settlement family — T_AXFER
    `0x26`/`0x37`/`0x3C`/`0x3D` and preauth-bids `0x5B`/`0x5C` — legitimately spends the maker/seller asset with
    **SIGHASH_SINGLE|ANYONECANPAY (0x83)** (`worker:17212`, `:17514`); those txs are NOT gated (their outputs are
    consensus-bound by the taker's own SIGHASH_ALL funding input). The guest keys the gate on `env[0]`, so it can
    never fire on an adaptor/bid/OTC spend. A blanket "every input must be ALL" rule would have bricked the OTC lane.
  - **Skip semantics.** A pure-CXFER/LP whose note input carries a non-ALL sighash is SKIPPED (no notes onboarded),
    the same fail-safe as a non-conserving cxfer — its inputs are already nullified by the vin scan, and honoring an
    unbound destination is exactly the risk being closed. The `txid` is witness-stripped so a mauled witness cannot
    re-key the note; only an emitter/spender that deliberately signs a permissive sighash can trip the skip, and
    stranding an unbound spend is strictly safer than routing it to an attacker-chosen output.
  - LP-remove note (traced `fold_lp_remove`): `lp_remove_kernel_verify` binds pool_id, share_amount, deltas, the
    recv **commitments** and input outpoints — but not the recv **auth keys** (read from the tx outputs). The
    sighash gate on the burned LP-share inputs now binds those outputs in-guest, closing the recv_auth residual.
- **M-01 (Medium) FIXED — engine/pool reciprocal binding** in `CollateralEngine.setPool` (contract; no reprove).
- **C-02** — the cross-generation replay, already gated by the predecessor-drain check below.

### Reflection-halt + admin-disclosure round
- **C-01 (Critical) FIXED — reflection-halt on burn asset mismatch.** A reflected-note burn whose 0x2B envelope
  declared a wrong asset hit an `assert!` (`reflect.rs`), but the envelope asset is attacker-controlled and the
  tx is in a canonical block → every honest prover panicked → forward reflection halted permanently (cheap,
  permissionless griefing). Now SKIPS the burn (note stays nullified; no bridge-out; no burn witness consumed).
  Rides the reprove. Box vector: canonical block with a real-note spend + wrong-asset 0x2B → digest advances,
  source spent, burn root unchanged.
- **SWEEP (complete, contained):** every reflection op fold guards tx-controlled properties as SKIPS before its
  `.expect()` (cxfer/bid via `verify_cxfer_conservation`, lp_add via `.is_ok()`, lp_remove via `let _`,
  burn-deposit via the None-closure). Block/header asserts are consensus (a valid block always passes);
  remaining `expect`s are bad-prover-witness. The burn asset-mismatch was the ONLY unguarded tx-controlled
  abort. No other halt vector found.
- **H-02 (High, trust-model) — CollateralEngine is NOT adminless.** Its `Ownable` owner can install arbitrary
  price feeds + an arbitrary enforcement module, force live cBTC locker escrow into `insuranceReserve` via a
  bad-feed "unhealthy" flag, and `drawInsurance(amount, to)` to any address — a real confiscation capability
  over live locker escrow, DAO-gated but present. The unqualified "no admin" claim is inaccurate: the pool +
  guests are immutable, but the CollateralEngine is a DAO-governed POLICY contract. **Decision pending** —
  accurate disclosure (minimum) and/or hardening (feed allowlist, bounded ratios, long mandatory grace,
  proof-specific disbursement instead of arbitrary `drawInsurance`), or a genuinely-adminless posture (freeze +
  renounce before funds).
- **R-01 / L-01** — cross-generation replay (gated by the drain check below); blind-swap `n_intents` in-circuit
  bound (low hardening, guest already supplies 1–16).

### Opus 5 pass-2 (no defect found; hardening + a coverage gap)
- **INFO-1 FIXED — dangerous comment drift.** `fold_consumed`'s comments said the consumed value is
  `keccak(spend_root ‖ source_asset)`; the CODE correctly uses the full `btc_note_leaf` (matching the contract).
  A maintainer "correcting" the code to the comment would freeze the bridge forever. Comments corrected
  (`lib.rs`, `reflect.rs`) + the by-convention consume-alignment invariant added to `OP-REVIEW-CHECKLIST.md`.
- **LOW-2 — CXFER non-P2TR output → `auth_key = 0`** (`output_p2tr_xonly(..).unwrap_or([0;32])`): a silent
  fast-lane capability downgrade (the note is still bridgeable, not stranded; x=0 is not a valid key so it just
  can't sign). Fold into the H-01 destination-binding hardening (prefer explicit skip/assert over the zero
  default) at reprove time.
- **LOW-1 — `min_out` not range-checked in `amm_swap_batch.circom`.** Only waives the trader's own slippage;
  unreachable from both current consumers (encoded `u64_be`). Locked ceremony ⇒ a future-consumer constraint;
  add the `Num2Bits(64)` when the circuit is next revised.
- **Positively verified (close bundle-flagged unknowns):** the six eth-reflection storage-slot pins match an
  independently-computed layout; `sha256(batch_vk.bin)` matches the pin + re-derives from the JSON vk;
  `digest()` commits all 20 fields; the circuit's inert `fee_bps`/`n_intents` are compensated by the guest
  padding + fee floor; the cross-curve sigma margin is adequate.
- **TOP COVERAGE GAP for a GO — `eth-reflection/main.rs` (beacon light client + MPT storage proofs), ~0%
  reviewed.** It is one of the three legs of no-double-spend and has NO compensating on-chain gate (the contract
  can check `consumedCount` freshness + `ethPool == address(this)`, but not that finality was really proven).
  Prioritize a deep review of this file (and `bitcoin.rs` parsers + `burn_deposit.rs` DAG linkage) next.

### Bitcoin-AMM stale-state + core-bridge liveness round
- **C-01 (Critical) — Bitcoin AMM/LP stale-state input destruction.** A confirmed swap/LP whose pool moved
  between signing and reflection (any concurrent op or attacker ordering) is skipped AFTER its input is
  nullified → principal destroyed. **Redesign chosen** (`ops/SPEC-btc-amm-stale-refund.md`): the fold recomputes
  the clearing against CURRENT reserves with `min_out` slippage (standard AMM UX — concurrent swaps still
  execute), forms the receipt in-guest, and onboards a user-authorized REFUND on over-slippage; BATCH is
  refund-only (Groth16 pinned to its reserves). **Guest + emitter only — NO circuit / ceremony change.** Large,
  math-sensitive; implement op-by-op (VAR template first) with box concurrent-swap vectors. NOT yet implemented.
- **H-02 (High, liveness) — zero-value note live-set bloat.** PARTIAL FIX: the CXFER fold now requires ≥1 live
  input, closing the *free* no-input zero-note mint. RESIDUAL: an attacker spending+recycling one note can still
  pad zero-value outputs (fee-metered bloat on the O(live) handoff). Complete closure needs strictly-positive
  outputs (range-prove `C-H`, a careful LIVE-CXFER emitter+guest change) or a sparse/deletable live-set
  accumulator (architectural). Not fund-loss; document + monitor for V1, close in the reprove/next generation.
- **H-03 (High, liveness) — burn-deposit provenance work amplification.** The provenance blob is bounded by the
  Bitcoin witness/block-weight limit (~4MB), but the per-vector caps (4096 headers / 1024 cmints / 1024 steps)
  are far above any legit note's provenance. Proper fix needs the BOX: benchmark the largest
  Bitcoin-consensus-valid hostile provenance witness end-to-end; ensure it proves within the prover
  cycle/memory envelope, then tighten the caps (and add an aggregate-byte budget + cheap structural dedup before
  per-step crypto) from the measured worst case. **Do NOT guess caps blindly** — too tight strands legit
  deep-provenance deposits. Hard release gate.

### C-01 GATE — predecessor drain (generational deploy only; the ONE-FUNDED-GENERATION invariant)

*(Rationale below; the `cast` commands to execute it are **step 7** of the redeploy checklist above.)*

This deploy is a **generational resume** (non-zero reflection genesis digest joining the SHARED Bitcoin
lineage — `ConfidentialPool.sol:827`). Single-use claim state is per-pool, so the same Bitcoin source can be
honored by two pools that share a lineage. The invariant is **at most one funded generation live per lineage**;
the successor accepts value only after the predecessor is drained. "Drained" is publicly checkable — you do NOT
need to see any private notes, only the on-chain **backing**:

**Assert on the PREDECESSOR pool, before the successor accepts any value (deposit / wrap / bridge-mint):**
1. `escrow[assetId] == 0` for EVERY registered asset id (the `escrow` mapping, `ConfidentialPool.sol:261` — the
   underlying that unwraps/mints redeem against). Enumerate the predecessor's registered assets and read each
   slot; any non-zero balance = NOT drained.
2. Every **pool-minted** canonical token's `totalSupply() == 0` (bridged/CDP assets minted by the predecessor
   — a live supply is redeemable liability). cUSD is engine-keyed, so check the predecessor engine's cUSD too.
3. `farmTreasury[controller] == 0` for any funded farm controllers (reward backing).

Only when 1–3 are all zero is a duplicate claim in the successor unbacked (`InsufficientEscrow` / no supply).
Record the predecessor address + the zeroed balances in the deploy log. A third party's shadow pool does NOT
trigger this gate (its value is its own, isolated) — the gate is purely about not funding two of OUR
lineage-sharing pools concurrently.

## Round-3 dormant-op arming (rides the reprove/box cycle — NO guest change)

Both are guest-complete and already in the vkey; arming is off-chain plumbing + fixture regen that
needs the box anyway. Neither rotates a vkey beyond the reprove itself.

### OP_SWAP_BLIND (31) — arm at tips=0 (self-settle)
Guest ships dormant but present in PROGRAM_VKEY; per-asset relay tips are FAIL-CLOSED at 0
(`swap_blind.rs`), so arming at tips=0 uses the already-validated zero-fee-floor path — no circuit or
guest change. Gasless-relay tips stay dormant (need a ceremony revision; self-settle is the v1 scope).
Feasibility confirmed: `dapp/circuits/ceremony-genesis-amm/amm_swap_batch_0000.zkey` + `dapp/vendor/amm_swap_batch.wasm` present.
Ladder (all off-chain):
1. **Emitter (JS)** — `openingPokBlind` JS mirror + 1-intent op-witness builder; generate the inner
   `amm_swap_batch` Groth16 via snarkjs.fullProve(wasm, zkey) (extend `dapp/confidential-swapbatch.js`,
   which today only verifies); assemble the OP_SWAP_BLIND settle stdin with tip_a=tip_b=0.
2. **Harness** — `harnesses/exec-swapblind.rs` (include_bytes the reprove ELF; feed the emitter's stdin).
3. **Worker decoder** — decode/classify OP_SWAP_BLIND (worker side).
4. **Fixture** — self-constructible 1-intent accept/DIGEST fixture (`fixtures/swapblind_op.json`).
5. **Box e2e (at reprove)** — build harness vs new ELF → prove tips=0 1-intent batch → on-chain accept
   + forgery-reject checks (tamper Groth16 / sigma / aggregate identity all reject). GREEN ⇒ armed.
   **CRITICAL zkey gate:** the inner amm_swap_batch Groth16 MUST be generated with the **FINALIZED ceremony
   zkey** (VK == guest's baked `fixtures/swap_batch_vk.json`, ceremony hash `2d9db81d…`, via
   `_fetchAmmZkey('swap_batch')`). The repo's genesis `amm_swap_batch_0000.zkey` has a DIFFERENT VK → a proof
   under it is guest-REJECTED. The emitter + parity test are zkey-agnostic (validate under any key); the box
   e2e is the first place the finalized zkey is required. Confirm it's available before the run.
DONE (agent, JS-mirror validated, 12 checks + forgery negatives): emitter `dapp/confidential-swapblind.js`
(+ prove side in `confidential-swapbatch.js`), test `tests/confidential-swapblind.mjs`; harness
`harnesses/exec-swapblind.rs` already exists (pins the write order to main.rs:1665). STILL TO PREP: worker
decoder. AT REPROVE: build harness vs new ELF + the box e2e with the FINALIZED zkey.

### LP_BOND — fixture regen only
Guest-complete + reprove-ready. Only needs the `protocolFeeBps`/recipient fixture regenerated
(`fixtures/lpbond_op.json`, `lp_protofee_op.json`, `reflection_lpbond.json`) — which
`gen-all-reflection-fixtures.sh` + the `*ProofReal` regen already do in the reprove. No new code.
