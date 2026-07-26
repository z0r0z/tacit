# In-guest authorization for the Bitcoin AMM reflection folds (H-01)

Closes H-01: the reflection folds for `T_SWAP_BATCH` (0x2F), `T_SWAP_VAR` (0x32), and `T_SWAP_ROUTE` (0x33)
verify aggregate conservation but NOT the per-trader authorization the wire format carries. The immutable guest
must enforce every value-bearing term the trader signed, instead of delegating fairness to an off-chain settler.
The aggregate identity gives *no inflation*; it does not give *no theft between traders*.

## The authorization predicate (already defined — port it verbatim into the guest)

`intent_sig` is a BIP-340 signature by `trader_pubkey` (x-only) over a domain-separated message. The canonical
constructions live in the worker and dapp and are the source of truth — the guest reconstruction MUST be
byte-identical or every honest signature fails. Do not re-invent the layout; mirror these.

### T_SWAP_BATCH — `ammBuildIntentMsg` (`worker/src/index.js`, domain `tacit-amm-intent-v1`)

```
sha256(
  "tacit-amm-intent-v1"
  ‖ pool_id(32)
  ‖ direction(1)
  ‖ n_inputs(1) ‖ { txid(32, little-endian/reversed) ‖ vout(4 LE) } × n_inputs
  ‖ C_in_secp(33) ‖ C_in_bjj(32) ‖ in_xcurve_sigma(169)
  ‖ len(receive_spk)(2 LE) ‖ receive_spk(var)
  ‖ min_out(8 LE) ‖ tip_amount(8 LE) ‖ tip_asset(1) ‖ expiry_height(4 LE)
  ‖ trader_pubkey(33)
)
```

### T_SWAP_VAR — `ammSwapVarIntentMsg` (domain `tacit-amm-swap-var-v1`)

```
sha256(
  "tacit-amm-swap-var-v1"
  ‖ pool_id(32) ‖ direction(1)
  ‖ delta_in(8 LE) ‖ delta_in_min(8 LE) ‖ delta_in_max(8 LE) ‖ delta_out(8 LE)
  ‖ min_out(8 LE) ‖ tip_amount(8 LE) ‖ tip_asset(1) ‖ expiry_height(4 LE)
  ‖ trader_pubkey(33) ‖ asset_input_outpoint(36)
  ‖ len(receive_spk)(2 LE) ‖ receive_spk(var)
  ‖ C_receipt_secp(33) ‖ C_change_or_sentinel(33)
)
```

### T_SWAP_ROUTE

Mirror the dapp/worker `buildSwapRouteIntentMsg` verbatim (multi-hop sibling of VAR: the trader signs the whole
value chain + each hop's reserve floor + the final receipt/destination). Read the exact field order from the
worker builder before implementing; do not guess the hop encoding.

## What each fold MUST verify (per intent)

1. **Signature.** `bip340_verify(trader_pubkey_xonly, intent_msg, intent_sig)`. `intent_msg` reconstructed
   exactly as above.
2. **Expiry.** `expiry_height >= reflected_block_height` (the fold has the confirmed height). Reject expired.
3. **Input binding.** The `C_in_secp` (and, for BATCH, each intent's declared input outpoints) must be the
   trader's real spent notes — already matched by the aggregate/spent path, but the reconstruction must use the
   SAME outpoints the guest authenticated from the tx, not prover-free values.
4. **Input cross-curve (BATCH).** `verify_xcurve(C_in_secp, C_in_bjj, in_xcurve_sigma)` — currently omitted;
   the Groth16 clears over `C_in_bjj`, so without this a substituted `C_in_bjj` is unbound to the real secp
   input. VAR/ROUTE bind their input via the kernel already; confirm and document.
5. **Destination binding.** `receive_spk` in `intent_msg` MUST equal the scriptPubKey of the confirmed Bitcoin
   output that receives the trader's receipt (vout `i+1` for batch receipt `i`; the receipt vout for VAR/ROUTE).
   This is the anti-redirection gate — a coordinator cannot point the receipt at its own key without breaking
   the signature.
6. **Receipt binding.** The onboarded `C_out_secp[i]` MUST be the commitment at that authorized destination —
   bind receipt ↔ (signed `min_out`, destination) so a coordinator can't swap receipts between traders.
7. **Terms.** `min_out`, `tip`, `direction` used by the fold are the signed ones (they are inputs to
   `intent_msg`, so a mismatch already fails the signature — no separate check needed once 1 holds).

### Authenticated-tx vs prover-witness discipline

Everything the signature commits to that the guest can read from the confirmed tx (input outpoints, output
scriptPubKeys/commitments) MUST be taken from the wtxid-authenticated tx, never from free prover witness — the
same discipline the provenance blob follows. The prover supplies only append/membership paths, which are
`assert!`/`expect` (abort on bad witness), never silent skips.

## Fail mode

A failed authorization check ABORTS the fold’s proof — it is a per-tx-deterministic property of a confirmed
transaction (the signature either verifies against the on-chain bytes or it does not), so unlike a
prover-discretionary witness it cannot be used to censor: an honest prover produces the same verdict. Reject the
whole intent/batch on any failure (do not partial-fold).

## Scope of change

- `guest/cxfer-core/bitcoin.rs`: surface the currently-discarded fields (trader_pubkey, in_xcurve_sigma,
  expiry, intent_sig) from the 0x2F/0x32/0x33 parsers (`SWAP_BATCH_INTENT_LEN` etc. already size them).
- `guest/settle/swap_batch.rs` + the `fold_swap_var`/`fold_swap_route` bodies: reconstruct `intent_msg`,
  `bip340_verify`, expiry, cross-curve, destination + receipt binding, per intent.
- A shared `intent_msg` builder in `cxfer-core` mirrored 1:1 by the worker/dapp (single source of truth, like
  the reflect-stdin serializer) so the two can never drift.

## Regression tests (guest + KAT)

- valid single/multi-intent batch/var/route → folds.
- invalid `intent_sig` → abort.
- wrong `trader_pubkey` → abort.
- expired intent (`expiry_height < height`) → abort.
- substituted `C_in_bjj` (BATCH) → abort (cross-curve).
- altered `min_out` / `tip` / `direction` → abort (signature).
- receipt permuted between two traders → abort.
- correct receipt, wrong destination scriptPubKey → abort.
- byte-exact KAT: guest `intent_msg` == worker/dapp `ammBuildIntentMsg` / `ammSwapVarIntentMsg` for a fixed
  vector (guards against layout drift).

## Rides the C-01 re-prove

This rotates the reflection ELF/vkey — already required by the C-01 fix — so it costs no extra deploy. Until it
lands + its tests pass end-to-end on the box, the 0x2F/0x32/0x33 folds must not be relied on.
