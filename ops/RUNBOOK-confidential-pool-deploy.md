# RUNBOOK — Deploy ConfidentialPool (turn on Ethereum fast settlement)

Deploying `ConfidentialPool` is the moment **Ethereum fast settlement of
confidential trades goes live** — `settle` *is* the fast layer (~12s on-chain). The
crypto is done and proven; this is the turnkey deploy.

## Prerequisites
- **SP1 Groth16 verifier address** for the target chain — the immutable v6.1.0 leaf
  (the same family the tETH bridge pins). Sepolia + mainnet addresses from Succinct's
  published deployments. The proof selector is `0x4388a21c`; the verifier's
  `VERIFIER_HASH()` must match.
- **Deployer key + RPC** (`--private-key`, `--rpc-url`).
- **Program vkey must match the deployed guest ELF.** The guest changed with the
  in-system `value`/`unitScale` harmonization (deposit id binds `value`; wrap/unwrap
  no longer carry a separate `amount`), so the vkey shifts from the deploy script's
  current `DEFAULT_VKEY`. Freeze the guest, `cargo prove` it on the box, set
  `PROGRAM_VKEY` to the resulting vkey, and refresh the on-chain proof fixtures
  (`confidential_groth16.json` for a transfer, `platinum_groth16.json` for a
  cross-lane settle) so `ConfidentialProofReal` + `ConfidentialPlatinumProofReal`
  verify the frozen vkey before you broadcast. See "Full platinum activation" below.

## Deploy
```
cd contracts
SP1_VERIFIER=<sp1 groth16 verifier on this chain> \
  forge script script/DeployConfidentialPool.s.sol \
  --rpc-url $RPC --private-key $PK --broadcast --verify
```
Optional: `BITCOIN_RELAY_VKEY=<vkey>` is the SP1 vkey of the **reflection prover**;
it is the sole authority for Bitcoin pool/spent-set state (no trusted oracle). Leave
it `0` for an Ethereum-only deploy (cross-lane inert — see the gold→platinum staging
below); set it to the frozen reflection-prover vkey to enable full platinum.
Optional `SAMPLE_UNDERLYING=<erc20>` registers a first confidential asset inline.

## Post-deploy — register assets
Any ERC-20 becomes a confidential asset, permissionlessly:
```
pool.registerWrapped(underlying, unitScale, crossChainLink, name, symbol, decimals)
```
- **Confidential ETH** works today via **WETH**: `registerWrapped(WETH, 1, 0, "Conf
  ETH", "cETH", 18)`. (A native-ETH payable wrap is optional UX, not required.)
- `crossChainLink` binds an asset to its Bitcoin-side id (for cross-chain assets);
  `0` for Ethereum-native.

## What you have the moment this lands
- **Confidential transfers + matched/atomic swaps settle on Ethereum in ~12s**,
  final on Ethereum (instant client-side soft-finality the moment a recipient
  verifies the BP+ proof; on-chain `settle` is the serialized confirm).
- Seed-only recovery (the worker decodes `LeavesInserted`/`NullifiersSpent`; the
  client `confidential-indexer` reconstructs balances).

## What it does NOT yet do (later layers, not blocking the above)
- **Cheap at scale** = batching (the rollup): the guest already settles many ops per
  proof (`numOps`); an off-chain batcher collects users' ops into one proof →
  per-trade proving + gas amortized. (Phase 2.)
- **Full platinum (cross-lane fast lane)** for Bitcoin-homed notes — the reflection
  prover + `BITCOIN_RELAY_VKEY`. See "Full platinum activation" below.
- **Pooled confidential swaps** route to the live Bitcoin `T_SWAP_BATCH` via the
  bridge; Ethereum-side trades are transfers + matched swaps.

## Full platinum activation (cross-lane fast lane)

The contract ships cross-lane-final: `settle` accepts a Bitcoin-homed spend root and
enforces in-guest Bitcoin spent-set non-membership against the reflected root. Two
deploy postures over the **same contract + guest**:

- **Gold (Ethereum-only).** `BITCOIN_RELAY_VKEY = 0`. No Bitcoin root can be attested
  → `knownBitcoinRoot` stays empty → no spend is ever Bitcoin-homed → cross-lane is
  fully inert. Confidential transfers/swaps settle on Ethereum; this is the safe
  capped pilot.
- **Platinum (cross-lane on).** `BITCOIN_RELAY_VKEY = <reflection prover vkey>`. A
  Bitcoin-homed note can be fast-spent on Ethereum, gated by non-membership against
  the reflected Bitcoin spent set. Requires the pieces below.

### Security invariants (enforced; do not regress)
- **The reflected spent-set root is NEVER zero.** An empty Bitcoin spent set has a
  non-zero empty-IMT sentinel root. `attestBitcoinStateProven` rejects a zero
  `bitcoinSpentRoot`, and `settle` rejects any Bitcoin-homed spend whose
  `bitcoinSpentRoot` is zero or not the current reflected root. A zero root would let
  the guest skip its non-membership check (it keys off `bitcoin_spent_root != 0`) and
  re-spend on Ethereum a note already spent on Bitcoin. The reflection prover MUST
  seed and only ever advance a non-zero spent-set root.
- **Reflect from genesis.** Before the first Bitcoin-homed spend root is usable, the
  relay must have attested the Bitcoin spent set up to a confirmed height — a
  Bitcoin-homed spend can only pin the current root, so the set must already reflect
  every Bitcoin spend that could collide.
- **Monotonic height.** `attestBitcoinStateProven` requires strictly increasing
  height, so a stale reflection cannot roll the spent set backward.
- **In-system value, not amount.** Boundary effects carry the note's `value`; the
  contract scales by the asset's trusted `unitScale`. The deposit id binds `value`
  (forcing `value·unitScale == escrowed amount`); the guest never sees `unitScale`.

### Remaining build to turn platinum on (box + infra)
1. **Freeze the guest, prove, pin the vkey** (box). `cargo prove` the gen-1 guest;
   set `PROGRAM_VKEY`; regenerate `confidential_groth16.json` +
   `platinum_groth16.json`; confirm `ConfidentialProofReal` +
   `ConfidentialPlatinumProofReal` verify on-chain against the frozen vkey.
2. **Bitcoin-side confidential pool** — the indexer that maintains the canonical
   Bitcoin note tree + spent-nullifier IMT the reflection prover proves over. (New
   subsystem; today the worker indexes cxfer envelopes but not a canonical pool.)
3. **Reflection prover** — an SP1 guest (sibling of the bridge_mint guest, reusing
   `cxfer-core::bitcoin` + the IMT) that proves `(bitcoinPoolRoot, bitcoinSpentRoot,
   height)` from confirmed Bitcoin headers, committed as `BitcoinRelayPublicValues`.
   Its vkey is `BITCOIN_RELAY_VKEY`. Submission toolkit is `confidential-btc-relay.js`
   (`attestBitcoinStateProven`); proving is on the box.
4. **Deploy** with `PROGRAM_VKEY` (frozen guest) + `BITCOIN_RELAY_VKEY` (reflection
   prover). Capped pilot first; cross-lane spends only after the spent set is
   reflected from genesis.

Steps 2–3 are the substantive remaining engineering and step 1/4 are box + key
operations; the contract, guest cross-lane check, gate, relay toolkit, and proof
verification are in place and tested.
