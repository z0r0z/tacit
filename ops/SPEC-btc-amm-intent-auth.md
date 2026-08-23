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
  ‖ len(change_spk)(2 LE) ‖ change_spk(var)   [ empty when C_change_or_sentinel is the sentinel ]
)
```

### T_SWAP_ROUTE — `ammSwapRouteIntentMsg` (domain `tacit-swap-route-v1`)

```
sha256(
  "tacit-swap-route-v1"
  ‖ trader_pubkey(33) ‖ trader_input_asset(32) ‖ trader_output_asset(32)
  ‖ min_out(8 LE) ‖ expiry_height(4 LE) ‖ n_hops(1)
  ‖ hop_block × n_hops   [ pool_id(32) ‖ direction(1) ‖ fee_bps(2 LE) ‖ R_A_pre(8) ‖ R_B_pre(8)
                            ‖ delta_a_net_mag(8) ‖ delta_b_net_mag(8) ]
  ‖ c_in_secp(33) ‖ c_receipt_secp(33)
  ‖ len(receive_spk)(2 LE) ‖ receive_spk(var)
)
```

**Destination-binding gap (route only) — RESOLVED.** Unlike VAR, the earlier route message did not bind the
receipt destination, and `r_receipt` is PUBLIC — so whoever controls the receipt output controls the routed
output note. Rather than rely on the trader's Bitcoin input signature being SIGHASH_ALL, the route intent
message (`tacit-swap-route-v1`) now appends the receipt destination the same way VAR and BATCH do: the
length-prefixed `receive_spk`. The guest reads that script verbatim from the confirmed reveal tx's vout 1, so a
coordinator that redirects the receipt reconstructs a different message and the signature fails — no sighash
dependency. Guest (`swap_route_intent_msg`, redirected-receipt + missing-output negative tests), worker
(`ammSwapRouteIntentMsg`), and dapp (`buildSwapRouteIntentMsg`) all bind it. Route is dormant, so no prior
signatures break (the domain string is kept — this is the launch format, no version bump).

**Destination-binding gap (VAR change) — RESOLVED.** VAR onboards TWO notes, not one: the receipt at vout 1 and
the taker's change at vout 2. The message bound the receipt's destination but only the change's *commitment*, and
in this lane the change opening is recoverable — so a settler could pay the leftover to its own script and still
reproduce the signed message, turning the taker's change into a note only the settler can spend. The
`tacit-amm-swap-var-v1` message now appends the length-prefixed `change_spk` after `C_change_or_sentinel`
(content change in place; the op is dormant, so no live signature breaks and the domain string is unchanged).
The guest derives which shape to bind from the envelope's sentinel — empty for a whole-input swap, the vout-2
script read verbatim otherwise — so the shape is never the settler's choice, and a change-bearing swap whose tx
has no vout 2 fails closed rather than binding an empty script. Guest (`swap_var_intent_msg` + the
redirected-change / missing-change-output / non-P2TR-change negative tests), worker (`ammSwapVarIntentMsg` and
its scan-loop call site), dapp (`buildSwapVarIntentMsg`, which now also returns the bound script so the
broadcast wrapper cannot pay a different one), and the `tests/swap-var.mjs` reference harness all bind it.

**Zero expiry is not "no expiry".** An intent with `expiry_height == 0` has no deadline and is replayable by a
settler at any later block. The height comparison alone already rejected it (`0 < height`), but the emitters
documented and defaulted 0 as "unlimited" — a request built that way would have stranded the trader's input.
All three folds now reject `expiry_height == 0` explicitly, and `buildBitcoinAmmRouteRequest` requires a
non-zero u32 instead of defaulting to 0.

**Bind the SCRIPT, never a reconstructed script shape.** All three messages bind `receive_spk` as the raw
scriptPubKey bytes read from the confirmed tx. An earlier revision of the guest instead rebuilt an assumed
P2TR program (`0x5120 ‖ x-only`) from the output's Taproot key. Reconstruction cannot reproduce the signed
message for any emitter that pays a different shape than the guest assumes:
every honest VAR swap would have failed auth in-guest *after* the vin scan nullified the trader's
input, stranding the principal, while the worker (which reads the real script) credited the receipt — a silent
cross-lane divergence. Reading the script verbatim is also what keeps the guest from imposing an undeclared
output-type rule on batch settlers. `tests/amm-intent-msg-pin.test.mjs` pins every builder — guest, worker,
dapp, and the swap-var reference harness — on P2WPKH vectors so this cannot regress. (The note outputs the
emitters actually pay are P2TR, which is a separate, independently enforced requirement: the reflection commits
each note output's x-only key as that note's spend authority, so a non-P2TR note output has no auth key and the
folds fail closed on it rather than onboard something unspendable.)

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
   output that receives the trader's receipt (vout `i+1` for batch receipt `i`; the receipt vout for VAR/ROUTE),
   AND — for every other output the fold onboards as a note — that output's script too (VAR's change at vout 2).
   This is the anti-redirection gate — a coordinator cannot point an onboarded note at its own key without
   breaking the signature. The rule is per onboarded note, not per op: any future output a fold onboards needs
   its destination in the message.
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
