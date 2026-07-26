# Targeted local review — the NEW code from this session (pre-external-bundle)

Scope: ONLY the code added/changed in this session's fix commits (below). This is unaudited new crypto on the
immutable reflection surface — the highest-risk delta. Attack it adversarially; assume a malicious permissionless
prover and a malicious batch coordinator/settler. Verify against code, not these notes.

## The commits in scope
```
1177fe69 reflection: prove the consumed-outpoint verdict on scan-free burns        (C-01 fix)
8db1a0fc reflection: enforce trader intent authorization on T_SWAP_VAR             (H-01)
e5a63b98 reflection: enforce trader intent authorization on T_SWAP_ROUTE           (H-01)
5258af98 reflection: enforce trader intent authorization on T_SWAP_BATCH           (H-01)
3ae75253 + 7e85d2c3  route receipt-destination binding (in the tacit-swap-route-v1 intent)
fc3fdc77  worker/dapp emitter parity for the route destination
c1b88612  reflection: track consumed outpoints in the scan accumulator             (earlier C-01 gate)
08adc9dc  classic range scalar canonicalization + allowlist warnings
```

## Files / functions to review
- `guest/settle/reflect.rs` — the burn-deposit consumed-outpoint gate (the C-01 presence verdict), and the
  three swap fold call sites (VAR/ROUTE/BATCH) that pass `height` + the resolved outpoints/receipt auths.
- `guest/cxfer-core/lib.rs` — `fold_swap_var`, `fold_swap_route` (intent auth blocks + expiry).
- `guest/settle/swap_batch.rs` — `fold_swap_batch` (per-intent auth + input cross-curve + the intent→spend
  1:1 matching loop).
- `guest/cxfer-core/bitcoin.rs` — the three `swap_*_intent_msg` builders, and the parser field-surfacing for
  `SwapVarEnvelope` / `SwapRouteEnvelope` / `SwapBatchIntent`.

## Invariants the new code must uphold
1. **C-01:** a real, confirmed scan-free burn is NEVER silently omitted by a prover-supplied witness. A member
   claim must prove membership (then skip = no double-mint); a non-member claim must prove non-membership (then
   fold); a lying/malformed witness must ABORT (not skip). No path lets a prover force a skip of a fresh burn,
   and no path lets a fresh (non-consumed) outpoint be double-minted by claiming it a member.
2. **H-01:** every reflected Bitcoin AMM receipt is authorized by the trader over ALL value-bearing terms —
   destination, min_out, tip, direction, expiry, the exact spent input, and (batch) the input cross-curve.
   A coordinator cannot redirect a receipt, relabel/re-price a trade, replay an expired intent, or substitute
   `c_in_bjj` while aggregate conservation holds.

## Soft spots — go here first (where I'm least certain)
1. **KAT-vs-ACTUAL-worker gap (most important).** The three `*_intent_msg_kat` tests pin the Rust builder
   against a hand-written node REPLICA of the worker's `ammBuildIntentMsg` / `ammSwapVarIntentMsg` /
   `ammSwapRouteIntentMsg` — NOT against the real worker functions. If my replica diverged from the real
   worker/dapp byte layout, the guest would reject every honest signature (safe-fail) OR, worse, a subtle
   mismatch could be exploitable. **Verify the guest builders byte-match the ACTUAL `worker/src/index.js` and
   `dapp/tacit.js` functions** by running the real functions on a shared vector, not my replica.
2. **Batch input↔intent mapping.** `fold_swap_batch` assumes each intent maps to exactly ONE spent input
   (the 1:1 `matched`/`used[]` loop), so the signed intent's single outpoint = the matched spend's outpoint.
   Confirm the wire/worker actually enforces 1-input-per-intent; if an intent can sign multiple inputs
   (`ammBuildIntentMsg` takes `inputUtxos[]`), the guest reconstruction is wrong.
3. **txid byte order.** The intent outpoint uses `spend.prev_txid` (internal/little-endian). The worker signs
   `reverseBytes(display_txid)`. Confirm these are the same orientation — a reversed txid breaks every sig or
   (worse) lets a crafted one pass.
4. **`receive_spk` reconstruction.** VAR/BATCH rebuild the receipt SPK as `0x5120 ‖ receipt_auth` and route
   binds `receipt_auth` directly. Confirm receipts are always P2TR (so this equals the real output SPK), and
   that a non-P2TR receipt output fails closed rather than binding a wrong/zero key that still verifies.
5. **`tip_asset == direction` (batch).** The guest passes `it.direction` as `tip_asset` into the intent_msg.
   Confirm the worker's `ammBuildIntentMsg` really uses `tipAsset == direction`; if a trader can sign a
   different tip_asset, the guest reconstruction diverges.
6. **Expiry height semantics.** The folds use the per-block `height`. Confirm that's the block carrying the
   swap tx (not the batch tip) so an honest in-window swap isn't wrongly rejected and an expired one isn't
   wrongly accepted.
7. **Route dapp dest derivation.** `dapp/tacit.js` derives `receiptDestXonly` from `recipientPubHex||traderPub`
   x-only. Confirm that equals the ACTUAL receipt output key the tx pays to (untweaked key-path vs a tweaked
   output key) — a mismatch is safe-fail but breaks the (dormant) feature.
8. **Auth-before-effect ordering.** Confirm no fold commits ANY state (reserves, note append, nullifier)
   before its auth check returns, and that a failed auth reverts cleanly (skip-not-partial).
9. **The EVM OP_SWAP_BLIND zero-fill.** `main.rs` zero-fills the new `SwapBatchIntent` fields on the settle
   lane. Confirm `swap_blind::verify_clearing` never reads `trader_pubkey/in_xcurve_sigma/expiry/intent_sig`
   (so the zeros can't matter), and that the EVM lane's own `verify_opening_pok_blind` auth is unaffected.

## Deliverable
Per finding: file:line, the concrete attacker sequence, and a minimal patch. If a soft spot checks out, say so
explicitly (it becomes a verified property for the external round). This is a focused delta review, not a
full-surface audit — bound coverage to the commits above.
