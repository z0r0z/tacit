# SPEC AMM Amendment — Per-trade Variable-Amount AMM Swaps (`T_SWAP_VAR`)

> Status: 🔍 Round-1 review complete; ready for round-2 peer review
> (round-1 self-review caught + fixed: cross-asset kernel-sig closure
> bug, identity-point sentinel encoding, freshness gate against
> running state vs. block-1 snapshot, MINIMUM_LIQUIDITY unit
> mismatch, relayed receipt-binding flow, parity-overstatement of
> T_AXFER_VAR reuse — see `AMENDMENTS.md` changelog for details).
> Depends on: AMM.md (defines pool state, fee mechanics, MINIMUM_LIQUIDITY),
> `SPEC-VARIABLE-AMOUNT-AMENDMENT.md` (defines the CXFER N=2 cryptography
> and HMAC-keystream receipt-blinding convention this amendment reuses).
>
> Adds a second AMM trader path: per-trade-against-curve fills with
> continuous-amount `[Y, X]` range semantics, settled in a single Bitcoin
> tx with no Groth16 proof and no batching. Lives alongside the existing
> batched-uniform `T_SWAP_BATCH` (`0x2F`) under the "two AMM trader
> paths" model documented in AMM.md.

---

## Motivation

`T_SWAP_BATCH` (`0x2F`) settles AMM trades via batched uniform
clearing — N traders' intents resolve at one indexer-computed
`P_clear`, with a Groth16 proof binding per-trader amounts inside
Pedersen commitments. The design is load-bearing for amount
confidentiality (chain observers see only batch aggregates) but
imposes three constraints that don't fit common trader UX:

1. **Fixed-amount commitment.** Each intent commits to one
   cleartext `amount_in_swap`. There is no `[Y, X]` range; a
   trader can't say "swap up to 100k sats, minimum 30k." Pre-split
   via CXFER is required if the trader's UTXO is larger than the
   intent amount.
2. **Whole-UTXO consumption.** AMM.md §"Whole-UTXO consumption
   only" requires the trader to pre-size their input UTXO via a
   self-CXFER before posting the intent — an extra Bitcoin tx of
   trader latency.
3. **Two-round-trip settlement.** Batched settlement requires the
   settler to assemble intents, run the deterministic clearing
   solve, build the envelope, then collect per-trader sigs over
   the assembled envelope. Three+ seconds of trader-side latency
   under good network conditions; longer otherwise.

The orderbook DEX (`SPEC-VARIABLE-AMOUNT-AMENDMENT.md` +
`SPEC-BID-VARIABLE-AMOUNT-AMENDMENT.md`) solves all three for
maker-taker fills via `T_AXFER_VAR` (`0x37`) — continuous range
semantics, single-Bitcoin-tx settlement, no batching. But that
machinery is one-maker-to-one-taker; it doesn't drain an AMM
pool's virtual reserves (the AMM has no maker UTXO to consume).

**`T_SWAP_VAR` adapts the variable-amount amendment's primitives to
the AMM's virtual-pool model.** A trader posts an `[Y, X]` range,
chooses a fill amount `Δ ∈ [Y, X]` based on observed pool depth,
and settles in a single Bitcoin tx that:

- Reuses the CXFER N=2 cryptography from `T_AXFER_VAR` (same
  bulletproof, same kernel-sig construction).
- Evaluates the AMM curve per-fill at the current reserves —
  `Δ_out = ⌊R_B · γ · Δ / (R_A · γ_den + γ · Δ)⌋` — no Groth16
  proof needed.
- Publishes `Δ` and `Δ_out` in cleartext (the indexer needs them
  to verify the curve). The trader's pre-trade wallet balance
  stays confidential (Pedersen-committed input/change), but the
  trade size itself is public.
- Settles at the per-fill spot price, no clearing solve, no batch.

This is the standard AMM UX (Uniswap-style per-trade) with the
tacit-unique confidentiality of pre/post-trade wallet balances and
the tacit-unique receipt-recovery mechanism. It coexists with
`T_SWAP_BATCH` as an opt-in second path — see AMM.md §"Two AMM
trader paths" for the design rationale.

---

## §5.16.3 `T_SWAP_VAR` (`0x32`) — per-trade variable-amount AMM swap

(Numbered to follow SPEC.md §5.16's AMM block; section number is
final once SPEC.md merge lands.)

### Wire format

```
T_SWAP_VAR envelope payload (consumed by indexer; OP_RETURN at
vout[0] carries SHA256(payload) as envelope_hash):

envelope_version           1 B  = 0x01
opcode                     1 B  = 0x32
pool_id                   32 B  (= SHA256("tacit-amm-pool-v1" || asset_A || asset_B),
                                  see AMM.md §"Pool state")
direction                  1 B  (0 = A→B, 1 = B→A)
R_A_pre                    8 B  u64 LE — trader's view of asset-A reserve at intent time
R_B_pre                    8 B  u64 LE — trader's view of asset-B reserve at intent time
delta_in                   8 B  u64 LE — chosen fill amount Δ (cleartext)
delta_in_min               8 B  u64 LE — Y, lower bound of trader's range
delta_in_max               8 B  u64 LE — X, upper bound of trader's range
delta_out                  8 B  u64 LE — settler's computed Δ_out (cleartext;
                                          indexer recomputes and verifies)
min_out                    8 B  u64 LE — slippage floor; indexer verifies delta_out ≥ min_out
tip_amount                 8 B  u64 LE — settler tip (in tip_asset, paid from trader's input)
tip_asset                  1 B  (0 = asset_A, 1 = asset_B — must equal direction's input asset)
expiry_height              4 B  u32 LE — Bitcoin block height after which tx is invalid
trader_pubkey             33 B  compressed secp256k1
C_in_secp                 33 B  trader's input commitment (consumed from vin[1]).
                                  Opens to (amount_in, r_in) under trader's privkey.
C_change_secp             33 B  trader's change commitment, freshly blinded:
                                  (amount_in − delta_in − tip_amount) · H_secp + r_change · G_secp
                                  In the whole-input case (input fully consumed into
                                  delta_in + tip), this field carries the NO-CHANGE SENTINEL
                                  (33 bytes of 0x00) — see "Change UTXO" and the field-
                                  encoding note in C_change_or_sentinel above.
                                  The change commit uses a FRESH r_change ≠ r_in
                                  (CXFER rerandomisation discipline), so it is NOT
                                  derivable by the indexer from C_in_secp alone —
                                  the trader publishes it explicitly.
C_receipt_secp            33 B  trader's receipt commitment (asset-B):
                                  delta_out · H_secp + r_receipt · G_secp
                                  r_receipt is HMAC-derived from trader_privkey
                                  for on-chain recovery (see "Receipt-address blinding").
r_receipt                 32 B  scalar mod n_secp, big-endian. Published so the
                                  indexer can verify C_receipt_secp opens to exactly
                                  delta_out: indexer recomputes
                                  delta_out · H_secp + r_receipt · G_secp and requires
                                  equality with C_receipt_secp.
                                  **Load-bearing: without this binding, an inflation
                                  attack opens** — trader could put any value in
                                  C_receipt_secp, spend it later as that value, while
                                  the pool only paid out delta_out worth of asset-B.
                                  Publishing r_receipt does not compromise wallet
                                  privacy: delta_out is already cleartext in this
                                  envelope, so the commit's openability adds nothing
                                  to chain observers; HMAC pseudo-randomness preserves
                                  the secrecy of other r_receipt values (different
                                  pool_id / asset_input_outpoint).
range_proof              ~700 B  aggregated bulletproof, m=2, over
                                  (C_change_or_sentinel, C_receipt_secp)
                                  (same construction as CXFER §3.3.4 with m=2;
                                  identical wire format to T_AXFER_VAR's range_proof.
                                  In the whole-input case, the prover supplies the
                                  bulletproof with the additive identity (point at
                                  infinity, derived from the sentinel via the special-
                                  case rule) in the first slot, which opens trivially
                                  to (value=0, blinding=0) and passes the range gate.)
kernel_sig                64 B  BIP-340 over kernel_msg (defined below),
                                  signing key = excess · G_secp's x-only form
                                  where excess = r_change − r_in (or −r_in in
                                  the whole-input case).
                                  Closes the asset-A side ONLY; the asset-B receipt
                                  is bound out-of-kernel (see "Kernel-msg construction").
intent_sig                64 B  BIP-340 over intent_msg (defined below),
                                  trader's authorisation. Binds C_receipt_secp +
                                  C_change_or_sentinel (this is what enforces
                                  receipt-side correctness in lieu of a cross-asset
                                  kernel sig). Separate from kernel_sig because the
                                  trader signs the intent; the settler builds the
                                  kernel sig from the excess scalar (trader transmits
                                  excess to settler over the off-chain channel).
```

Total envelope payload: ~950–1000 bytes (depends on bulletproof
encoding choices; the receipt-binding `r_receipt(32)` adds 32B vs
the prior draft). Well under the OP_RETURN-via-Taproot-script-path
budget; one full Bitcoin tx per swap.

### Bitcoin tx layout (normative)

```
vin[0]    Settler's envelope-bearing input (Taproot script-path);
          witness carries the T_SWAP_VAR payload.
vin[1]    Trader's tacit asset UTXO of (direction == 0 ? asset_A : asset_B);
          consumed by this swap. Signed SIGHASH_ALL by trader at
          intent-completion time (see "Settlement").
vin[2..]  Optional settler BTC funding inputs (signed SIGHASH_ALL by
          settler) used to pay tx fee + dust outputs.

vout[0]   OP_RETURN(envelope_hash) — 0 sat, 32-byte data,
          envelope_hash = SHA256(payload).
vout[1]   Trader receipt UTXO — dust (e.g. 546 sat) P2WPKH paying the
          trader's pre-declared receive_scriptPubKey (derived per
          "Receipt-address blinding" below). Carries the receipt's
          Pedersen commitment C_receipt_secp; asset is the OTHER asset
          (asset_B if direction == 0, asset_A if direction == 1).
vout[2]   Trader change UTXO — dust P2WPKH paying the trader's change
          address. Carries C_change_secp. Present iff the trader's
          input commitment opens to a value strictly greater than
          (delta_in + tip_amount); see "Change UTXO" below.
vout[3]   Optional settler tip UTXO — dust P2WPKH paying settler.
          Carries the tip Pedersen commitment (constructed by the
          settler — see AMM.md §"Tip mechanics" — using the
          tacit-amm-swap-var-v1 domain tag). Omitted if tip_amount == 0.
vout[4..] Optional settler BTC change.
```

Indexers MUST reject any `T_SWAP_VAR` whose tx layout deviates,
whose `vout[0]` OP_RETURN data ≠ recomputed `envelope_hash`, or
whose tacit-output ordering ≠ the (receipt, change, tip) sequence
above.

### Kernel-msg construction

Same domain-tag scheme as CXFER (§5.4) and `T_AXFER_VAR` (§5.7.9);
the kernel sig binds the **trader's asset-A side** balance equation
under `excess · G_secp`. **`C_receipt_secp` (asset-B) is NOT in the
kernel-sig closure** — Pedersen commitments across different asset
spaces share the same `H_secp` generator but do not balance via
sum (the receipt is virtually paid by the pool, which has no UTXO).
Receipt-side binding is handled by `intent_sig` + the bulletproof
range proof; pool-side movement is enforced by the indexer's curve
recompute (§"Indexer validation").

This is structurally parallel to `T_AXFER_VAR`'s pattern: that
opcode's kernel sig closes only the maker's single-asset side
(`C_recip + C_change − C_in` with `burned_amount = 0`), and the
BTC payment leg is bound separately via `SIGHASH_SINGLE`. For
`T_SWAP_VAR`, the kernel sig closes the trader's asset-A side with
a cleartext `delta_in_total` outflow term in the same slot
`T_AXFER_VAR` uses for `burned_amount`. The asset-B receipt
parallels `T_AXFER_VAR`'s BTC payment — bound out-of-kernel.

```
kernel_msg = SHA256(
    "tacit-kernel-v1"                        # reused from CXFER + T_AXFER_VAR
    || asset_id_in(32)                        # ONLY asset-A in the closure
    || asset_input_count_LE(1)                # value = 0x01 (single trader input)
    || asset_input_outpoint                   # txid_BE(32) || vout_LE(4) of vin[1]
    || C_change_or_sentinel(33)               # change commit (well-formed 33B compressed-secp
                                              # point with prefix 0x02 or 0x03), OR the
                                              # NO-CHANGE SENTINEL (33 bytes of 0x00) if the
                                              # input is fully consumed into delta_in + tip.
                                              # The sentinel is NOT a valid SEC1 encoding;
                                              # implementations MUST special-case the all-zero
                                              # byte pattern BEFORE invoking the secp decoder.
                                              # Treat the sentinel as the additive identity
                                              # (point at infinity) for the verifier equation.
                                              # into delta_in + tip with no change
    || delta_in_total_LE(8)                   # = delta_in + tip_amount (cleartext outflow to pool + settler).
                                              # Occupies the same slot T_AXFER_VAR puts burned_amount_LE
                                              # in; this is the value leaving the trader's commit space
                                              # to the AMM virtual reserves and the settler tip UTXO.
)
```

Kernel sig verifies under:
```
P = C_change_or_sentinel − C_in_secp + delta_in_total · H_secp
require kernel_sig verifies under P.x_only()
```

Trader's signing key for the kernel sig is the **excess scalar**
in the standard CXFER sense:
```
excess = r_change − r_in        # both known to the trader
```
- `r_in` is the blinding the trader chose when their input UTXO
  was created (already in the trader's wallet).
- `r_change` is a **fresh** blinding for the change commit.
  Rerandomization on every spend matches CXFER discipline and gives
  forward-privacy: the change UTXO is not linkable to its parent
  via blinding reuse.
- If there is no change (input fully consumed into `delta_in_total`),
  the envelope carries the **no-change sentinel** (33 bytes of 0x00)
  in the `C_change_secp` slot, special-cased to the additive
  identity in the verifier. `r_change = 0` (no change blinding to
  derive); kernel sig verifies under
  `(delta_in_total · H_secp − C_in_secp).x_only` with excess = `−r_in`.

**Cryptographic reuse with T_AXFER_VAR.** T_SWAP_VAR is
**structurally parallel** to T_AXFER_VAR — same `tacit-kernel-v1`
domain tag, same single-asset excess-scalar closure shape, same
m=2 bulletproof wire format, same BIP-340 kernel sig construction.
Implementations can share most code paths. Two structural
differences worth calling out (the crypto is sound either way; the
divergence is in what each kernel-msg lists):

1. **Output-commitment count.** T_AXFER_VAR's kernel_msg includes
   `output_commitments_concat(2 × 33B) = C_recip || C_change`
   (both maker outputs, same asset). T_SWAP_VAR's kernel_msg
   includes only `C_change_or_sentinel(33)` — the receipt commit
   is on asset-B and lives out-of-kernel (bound by intent_sig +
   bulletproof range). This is the cross-asset adaptation: where
   T_AXFER_VAR balances "one maker input → two maker outputs in
   the same asset," T_SWAP_VAR balances "one trader input → one
   trader change output + cleartext outflow to pool + cleartext
   tip" all on asset-A, plus an asset-B receipt bound separately.
2. **Cleartext outflow slot.** T_AXFER_VAR carries `burned_amount =
   0` (the maker isn't burning anything; the BTC payment is bound
   via SIGHASH_SINGLE out-of-kernel). T_SWAP_VAR carries
   `delta_in_total = delta_in + tip_amount` in the same slot — the
   trader IS sending cleartext value out of their commit space, to
   the pool's virtual reserves and the settler tip UTXO.

The crypto invariants are identical: excess-scalar Schnorr sig
over a single-asset Pedersen closure. The cleartext-outflow term
just shifts which side of the equation the "H_secp · cleartext"
appears.

**Asset-B side (receipt) — bound out-of-kernel.** The receipt
commit `C_receipt_secp` lives on asset-B (the asset the trader is
receiving). It is bound by four mechanisms, in lieu of a kernel
sig:

1. **`intent_sig`** binds `C_receipt_secp` directly (see "Intent-msg
   construction" below) — the trader authorises this specific
   receipt commit at the pinned `receipt_scriptPubKey`.
2. **Published `r_receipt` opening** — the envelope publishes the
   blinding scalar `r_receipt`; the indexer verifies
   `C_receipt_secp == delta_out · H_secp + r_receipt · G_secp`
   directly. This is the **load-bearing binding**: it
   cryptographically pins the commit's value to the curve-derived
   `delta_out`, preventing the inflation attack where a trader
   constructs `C_receipt_secp` with an arbitrary value and later
   spends it claiming that inflated amount. Without this, asset-B
   conservation breaks across the cross-asset boundary.
3. **The m=2 bulletproof** over `(C_change_or_sentinel, C_receipt_secp)`
   proves both commits open to values in `[0, 2^64)`. With the
   r_receipt binding above the bulletproof's range gate is
   technically redundant for `C_receipt_secp` (which is already
   pinned to `delta_out ∈ [0, 2^64)` by curve construction), but
   the m=2 wire format is kept identical to T_AXFER_VAR for
   implementation reuse.
4. **The indexer's curve recompute** enforces the pool-side
   movement: `R_B_post = R_B_pre − delta_out`. With the receipt-
   commit binding above, this completes asset-B conservation:
   `delta_out` exits pool reserves and enters the trader's receipt
   commit with the same cleartext value.

Asset-side balance (trader's full picture across both assets):
- **Asset-A in:** `amount_in` from `C_in_secp` (input UTXO).
- **Asset-A out:** `change_amount = amount_in − delta_in_total` to
  `C_change_or_sentinel` + `delta_in` to AMM virtual reserves +
  `tip_amount` to settler tip UTXO (cleartext).
- **Asset-B in:** `delta_out` from AMM virtual reserves to
  `C_receipt_secp` (cleartext; verified via curve).
- **Asset-B out:** none.

The kernel sig closes only the asset-A side because that's where
Pedersen blinding-scalar arithmetic actually balances. Pool-side
movement (asset-A inflow and asset-B outflow into the virtual
reserves) is enforced by indexer recompute. This split is the key
simplification vs. `T_SWAP_BATCH`: no in-circuit cross-asset curve
proof, no Groth16. The curve evaluation is a public arithmetic
recompute under public `R_A_pre`, `R_B_pre`, `delta_in`, `fee_bps`.

### Intent-msg construction

```
intent_msg = SHA256(
    "tacit-amm-swap-var-v1"
    || pool_id(32)
    || direction(1)
    || delta_in_LE(8)
    || delta_in_min_LE(8)
    || delta_in_max_LE(8)
    || delta_out_LE(8)
    || min_out_LE(8)
    || tip_amount_LE(8)
    || tip_asset(1)
    || expiry_height_LE(4)
    || trader_pubkey(33)
    || asset_input_outpoint                   # binds to vin[1]
    || receipt_scriptPubKey                   # pinned vout[1] target
    || C_receipt_secp(33)                     # binds the asset-B receipt commit
                                              # (out-of-kernel-sig — see "Kernel-msg construction")
    || C_change_or_sentinel(33)               # binds the asset-A change commit
                                              # (also in kernel-sig closure; bound here for replay-protection
                                              # against settler swapping commits between two intents
                                              # the trader signed for different fills)
)
```

`intent_sig` is the trader's BIP-340 sig under `trader_pubkey`'s
x-only form. The intent_sig binds the trader's authorisation for
this specific fill — including the chosen `delta_in`, the settler's
tip terms, the specific `vin[1]` outpoint, AND both output commits.
Binding `C_receipt_secp` here is what enforces the receipt-side
balance in lieu of a kernel sig: a settler who substituted a
different `C_receipt_secp` at broadcast time would invalidate the
`intent_sig`. Replay-protection is
inherent (the outpoint is single-spend on Bitcoin).

### Receipt-address blinding

Same scheme as CXFER §5.4 receipt blinding and T_AXFER §5.7.6:

```
r_receipt = HMAC-SHA256(
    trader_privkey,
    "tacit-amm-swap-var-receipt-v1" || pool_id || asset_input_outpoint
)
receipt_address = P2WPKH( derive_pubkey(trader_privkey, "tacit-amm-swap-var-recv-v1"
                                        || pool_id || asset_input_outpoint) )
```

The trader's privkey alone is sufficient to recover the receipt
UTXO during a wallet restore. The chain observer sees only the
fresh P2WPKH at `vout[1]`; the receipt is unlinkable from the
trader's prior wallet activity without the privkey-derived
keystream.

This is the **tacit-unique on-chain receipt recovery** property —
no off-chain state required, full UTXO restoration from seed.

### Indexer validation algorithm

```
on T_SWAP_VAR envelope at confirmation depth ≥ FINALITY_DEPTH:

    require envelope.opcode == 0x32
    require envelope_version == 0x01
    require pool_id is registered (confirmed POOL_INIT exists; AMM.md §"POOL_INIT")
    require direction ∈ {0, 1}
    require delta_in_min ≤ delta_in ≤ delta_in_max
    require delta_in > 0                  // nonzero fill
    require delta_in_max ≤ trader's input commitment's max-representable u64

    // Reserves freshness gate
    pool = lookup_running_pool_state(pool_id, immediately_before = (settlement_block, tx_index))
    require pool.R_A == R_A_pre AND pool.R_B == R_B_pre
        // Trader-observed reserves must match the pool's RUNNING state
        // immediately before this tx_index, INCLUDING the effects of any
        // earlier-tx_index AMM operations in this same block (per the
        // canonical-ordering rule at AMM.md §"Indexer determinism rules":
        // AMM envelopes apply in (tx_index, vin[0] outpoint) order).
        // Without this in-block accumulation, two T_SWAP_VARs targeting
        // the same pool in the same block could both pass freshness
        // against the pre-block snapshot and double-dip the same reserves
        // — each curve-computing delta_out against a stale (R_A, R_B)
        // that ignores the first swap's effect, with the trader getting
        // more output than the curve would give at true post-first-swap
        // depth.
        //
        // Practical effect: within one block, only the FIRST same-pool
        // T_SWAP_VAR (lowest tx_index) typically passes freshness; later
        // ones must use updated reserve views or be rejected. Settlers
        // serialise multi-fill flow across blocks, or the dapp can post
        // a single larger fill and accept the deeper slippage.
        //
        // Alternative considered: ±N tolerance window. Rejected because
        // the curve's per-fill output is nonlinear in (R_A, R_B), so a
        // tolerance window admits ambiguous outcomes. Strict equality is
        // unambiguous; rejection is cheap (no new sig needed, just
        // rebroadcast).
        //
        // Reorg interaction: pool state advances at depth ≥ 3 blocks
        // (AMM.md §"Reorg safety"), so the running-state lookup is
        // canonical only after that depth. Indexer at depth < 3 holds
        // T_SWAP_VAR pending; finality applies the running-state check
        // at depth-3 confirmation.

    // Curve recompute (no proof, pure indexer arithmetic)
    if direction == 0:                    // A → B
        γ_num = 10000 − fee_bps           // u16, fee_bps from pool genesis
        γ_den = 10000
        num   = (u256) R_B_pre · γ_num · delta_in
        den   = (u256) R_A_pre · γ_den + (u256) γ_num · delta_in
        delta_out_expected = (u64) (num / den)
        R_A_post = R_A_pre + delta_in
        R_B_post = R_B_pre − delta_out_expected
    else:                                  // B → A
        // symmetric; swap (R_A, R_B) and (delta_in_total) roles
        γ_num, γ_den as above
        num   = (u256) R_A_pre · γ_num · delta_in
        den   = (u256) R_B_pre · γ_den + (u256) γ_num · delta_in
        delta_out_expected = (u64) (num / den)
        R_A_post = R_A_pre − delta_out_expected
        R_B_post = R_B_pre + delta_in

    require delta_out == delta_out_expected
    require delta_out >= min_out
    // **Receipt-binding check** — cryptographically binds C_receipt_secp
    // to delta_out via direct opening with the trader-published r_receipt.
    // Without this, the asset-B receipt commit is unbound and a trader
    // can construct it to commit to any value in [0, 2^64), creating
    // asset-B out of thin air at spend time. The check makes T_SWAP_VAR
    // conservation-preserving on the cross-asset side.
    require C_receipt_secp == delta_out · H_secp + r_receipt · G_secp
    require R_A_post > 0 AND R_B_post > 0
        // Reserve-floor: constant-product curve cannot drain a side
        // completely given any finite input — `delta_out_expected =
        // ⌊R_B · γ · Δ / (R_A · γ_den + γ · Δ)⌋` is strictly less than
        // R_B for finite Δ, so R_B_post = R_B − delta_out_expected
        // remains positive by curve construction. The explicit
        // `> 0` requirement is belt-and-suspenders against arithmetic
        // bugs in the floor-division.
        //
        // Note: `MINIMUM_LIQUIDITY` (AMM.md §"POOL_INIT") is denominated
        // in `lp_asset_id` LP-share base units (1000 shares locked at
        // POOL_INIT), NOT in asset-A or asset-B reserve units. It cannot
        // be used as a reserve floor here. The LP-share supply S floor
        // is enforced separately at LP_REMOVE; T_SWAP_VAR doesn't
        // change S.

    // Sigs
    require intent_sig verifies under trader_pubkey over intent_msg
    require kernel_sig verifies under
            (C_change_or_sentinel − C_in_secp + delta_in_total · H_secp).x_only
            where delta_in_total = delta_in + tip_amount.
            C_change_or_sentinel is the trader's published C_change_secp
            (a well-formed 33-byte compressed-secp point with prefix 0x02
            or 0x03 and on-curve x) if a change UTXO is present at vout[2].
            If the envelope carries the NO-CHANGE SENTINEL (33 bytes of
            0x00, special-cased BEFORE SEC1 decoding), substitute the
            point at infinity (additive identity) in the verifier equation
            and require that vout[2] is absent (no asset UTXO emitted).
    require bulletproof verifies over
            (C_change_or_sentinel, C_receipt_secp) — m=2, same wire format as
            CXFER §3.3.4 and T_AXFER_VAR's range_proof.
            (C_receipt_secp's binding to delta_out is enforced by the
            published-r_receipt opening check above; the bulletproof's
            range gate on it is technically redundant but kept for
            wire-format parity with T_AXFER_VAR. C_change_or_sentinel's
            range gate is load-bearing: it proves the change value
            (amount_in − delta_in_total) is non-negative, which is what
            prevents the trader from over-spending their input commit.)

    // Tip mechanics (skip if tip_amount == 0)
    if tip_amount > 0:
        require vout[3] exists
        require vout[3].asset == tip_asset
        require vout[3].amount_commit opens to tip_amount under r_tip
            (r_tip published per AMM.md §"Tip mechanics" for T_SWAP_BATCH;
             T_SWAP_VAR uses the same opening convention with domain tag
             "tacit-amm-swap-var-tip-v1")

    // Reorg & expiry
    require settlement_block_height < expiry_height

    // Apply state transition
    pool.R_A = R_A_post
    pool.R_B = R_B_post
    pool.fee_growth += accrued_fee   // see "LP fee accrual" below
    mark_outpoint_consumed(vin[1].outpoint)
    emit_receipt_utxo(vout[1], C_receipt_secp, asset_id_out)
    if change_present: emit_change_utxo(vout[2], C_change_secp, asset_id_in)
```

### Change UTXO

A change UTXO at `vout[2]` is emitted iff the trader's input
commitment opens to a value strictly greater than `delta_in +
tip_amount`. The change commitment uses a **fresh** blinding
`r_change ≠ r_in` (CXFER discipline — every spend rerandomises so
the change UTXO is not blinding-linkable to its parent):

```
C_change_secp = (amount_in − delta_in − tip_amount) · H_secp + r_change · G_secp
```

The trader publishes `C_change_secp` in the envelope payload (33B);
the indexer does NOT derive it from `C_in_secp`. The kernel-sig
closure proves the trader knows `excess = r_change − r_in` such
that `C_change_secp − C_in_secp + delta_in_total · H_secp =
excess · G_secp` — which closes the asset-A balance equation
without revealing either blinding.

The trader recovers `r_change` later via the same HMAC-keystream
construction used for receipt blinding (`tacit-amm-swap-var-change-v1`
domain tag, keyed by `trader_privkey`).

**Whole-input case (`amount_in == delta_in + tip_amount`):** no
change output; the trader's input is fully consumed into the
receipt + tip. The envelope's `C_change_secp(33)` field carries the
**NO-CHANGE SENTINEL**: 33 bytes of 0x00. This byte pattern is
NOT a valid SEC1 compressed-point encoding (prefix 0x00 is not a
defined SEC1 compressed-point form, and SEC1's only "point at
infinity" convention is a single byte 0x00 — the 33-byte all-zero
pattern is a protocol-specific sentinel that conforming
implementations MUST special-case BEFORE invoking the secp
decoder). In the verifier equation, substitute the additive
identity (point at infinity). The bulletproof's m=2 first slot is
the additive identity, which opens trivially to value 0 with
blinding 0 and passes the range proof. `vout[2]` MUST be absent.
The intent_msg's `C_change_or_sentinel` slot carries the 33-byte
sentinel byte pattern, signed under `intent_sig`.

The kernel-sig verification alone enforces `amount_in ==
delta_in_total` in this case: the closure
`(identity − C_in + delta_in_total · H_secp).x_only` equals
`((delta_in_total − amount_in) · H_secp − r_in · G_secp).x_only`,
which only has a valid discrete log under `G_secp` (allowing
the sig to verify) when `delta_in_total − amount_in = 0`. Excess
in this case is `excess = −r_in`. No additional cleartext-amount
opening is required.

### LP fee accrual

Same model as `T_SWAP_BATCH` (AMM.md §"Protocol fee mechanism"):
the `γ = (10000 − fee_bps) / 10000` multiplier on net A inflow
keeps `fee_bps`-fraction of each fill inside the pool, growing
`k = R_A · R_B` slightly. LP-share holders capture the growth at
their next `T_LP_REMOVE` or `T_PROTOCOL_FEE_CLAIM`.

Implementation note: each `T_SWAP_VAR` contributes its `γ`
retention to `k = R_A · R_B` identically to a `T_SWAP_BATCH`
contribution; crystallization (minting protocol-fee LP shares) is
deferred to LP events via the Uniswap V2 lazy `mintFee` model
(AMM.md §"Accrual model: Uniswap V2 lazy mintFee"). Any LP-event
walks the combined `k`-growth since the last fee-event and mints
accordingly, counting `T_SWAP_VAR` and `T_SWAP_BATCH` deltas
uniformly. The "per-fill vs per-batch" distinction is only about
WHEN `k` updates land on chain, not about WHEN fees crystallize —
both opcodes feed the same lazy accrual.

### Self-broadcast (no settler)

Setting `tip_amount = 0` and `vin[2..] = []` produces a
**self-broadcast** swap — the trader signs and broadcasts directly,
no relay needed. The settler's vin[0] envelope-bearing input is
provided by the trader (Taproot script-path spend of an
self-controlled UTXO). The kernel-sig flow is unchanged; the
trader is both "trader" and "settler" for the duration of the swap.

Self-broadcast saves the settler tip but requires the trader to
hold BTC for the tx fee. Same trade-off as self-CXFER vs. relayed
CXFER (SPEC §5.2).

### Settlement flow

V1 ships **two coordination modes** under the same on-chain wire
format:

- **Single-Δ mode** — trader signs exactly one candidate `delta_in`.
  Simple, ~800B intent-pool footprint, but requires a re-sign
  round-trip when the pool moves enough that the chosen Δ falls
  outside `min_out` between intent-post and broadcast. Default for
  self-broadcast and for small fills where pool drift is unlikely.
- **Tick-fan mode** — trader pre-signs **K candidate intents** at
  log-spaced ticks across `[delta_in_min, delta_in_max]`. Settler
  picks the tick whose `delta_out` best matches current depth and
  broadcasts that one candidate; the other K−1 candidates are
  discarded. ~K× intent-pool footprint, but eliminates the re-sign
  loop in the common case (pool movement small enough that some
  tick remains satisfiable). Default for relayed swaps in the
  reference dapp.

**The on-chain wire format is identical in both modes.** Tick-fan
is purely an off-chain coordination layer — the broadcaster
selects ONE candidate intent + its bulletproof + its commits, and
puts that single tick's data into the T_SWAP_VAR envelope. The
indexer sees one well-formed T_SWAP_VAR with one `delta_in`, one
`C_receipt_secp`, etc. There is no on-chain trace of the
unselected ticks.

#### Trader-signed Δ load-bearing invariant

In both modes, every candidate intent the trader signs binds a
**specific** `delta_in`. The trader's `C_receipt_secp` is
constructed against a specific `delta_out`, which is the curve
evaluation of a specific `delta_in` against specific
`(R_A_pre, R_B_pre)`. If a settler substituted any other
`delta_in`, the resulting on-chain `delta_out` would differ and
the trader-pre-signed `C_receipt_secp` would no longer open to
that amount — the receipt UTXO would be **unspendable** by the
trader (the indexer-recorded `C_receipt_secp` opens to the
trader-intended value, but the pool actually paid out a different
`delta_out`, breaking the curve-recompute check at the validator).

The tick-fan mode lets the settler choose *which* of the trader's
pre-signed Δs to broadcast; it does NOT let the settler
synthesise a Δ the trader didn't sign for.

#### Single-Δ flow (relayed)

1. Trader observes pool reserves at block H, picks `delta_in` and
   `delta_out` deterministically from the curve, derives
   `r_receipt`, builds `C_receipt_secp`, picks fresh `r_change`,
   builds `C_change_secp`, computes `excess = r_change − r_in`,
   constructs `intent_msg` binding all of the above, and signs
   `intent_sig` under `trader_pubkey`.
2. Trader broadcasts the intent off-chain to settlers via the
   reference worker's intent-pool relay (or any P2P channel):
   `(intent_msg, intent_sig, C_in_secp, C_change_secp, C_receipt_secp,
   r_receipt, excess, bulletproof)`.
3. Settler picks up the intent, verifies pool state at block H or
   H+1 still matches the trader's signed `(R_A_pre, R_B_pre)` and
   `delta_out ≥ min_out` against the curve at that state, assembles
   the Bitcoin tx, builds the kernel sig from the `excess` scalar
   (the trader transmits `excess`, NOT `r_in`), adds settler-side
   BTC funding inputs and tip-opening, broadcasts.
4. Indexer validates at confirmation depth.

If the pool moves between intent-post and broadcast such that
`delta_out_expected < min_out` under the new reserves, the settler
**discards the intent and re-solicits** a fresh sig from the
trader at the new pool state. One re-sign round trip per pool-
movement event.

#### Tick-fan flow (relayed; V1 default for non-self-broadcast)

1. Trader observes pool reserves at block H. Picks
   `delta_in_min = Y`, `delta_in_max = X`, and a tick count
   `K ∈ {2, 4, 8, 16}` (`K = 8` is the dapp default — see
   "Tick schedule" below for the trade-off).
2. Trader computes the K **deterministic ticks**:
   ```
   tick_k = ⌊Y · (X/Y)^(k / (K−1))⌋    for k ∈ {0, 1, …, K−1}
   ```
   — log-spaced across `[Y, X]`. `tick_0 = Y`, `tick_{K−1} = X`,
   intermediate ticks geometrically spaced (gives roughly uniform
   slippage steps under constant-product curves).
3. For each tick `k`:
   - Compute `delta_in_k = tick_k`, `delta_out_k =
     ⌊R_B · γ · tick_k / (R_A · γ_den + γ · tick_k)⌋` (or
     symmetric for B→A).
   - Use the **tick-independent** `r_receipt` (HMAC-derived from
     `(trader_privkey, "tacit-amm-swap-var-receipt-v1", pool_id,
     asset_input_outpoint)` — same scalar across all K ticks; see
     "Receipt-address blinding" above).
   - Build `C_receipt_secp_k = delta_out_k · H_secp + r_receipt · G_secp`
     (commit varies per tick because `delta_out_k` varies; blinding
     is shared across the fan).
   - Use the **tick-independent** `r_change` (HMAC-derived from
     `(trader_privkey, "tacit-amm-swap-var-change-v1", pool_id,
     asset_input_outpoint)` — same scalar across all K ticks).
   - Build `C_change_secp_k = (amount_in − tick_k − tip_amount) ·
     H_secp + r_change · G_secp` (or the no-change sentinel if
     `amount_in == tick_k + tip_amount`).
   - Compute `excess = r_change − r_in` (tick-independent, derived
     once per fan).
   - Construct `intent_msg_k` binding `delta_in_k`, `delta_out_k`,
     `C_receipt_secp_k`, `C_change_secp_k`, plus shared fields
     (`pool_id`, `direction`, `R_A_pre`, `R_B_pre`,
     `delta_in_min`, `delta_in_max`, `min_out`, `tip_amount`,
     `tip_asset`, `expiry_height`, `trader_pubkey`,
     `asset_input_outpoint`, `receipt_scriptPubKey`).
   - Sign `intent_sig_k` under `trader_pubkey`.
   - Build per-tick `bulletproof_k` (m=2 over
     `C_change_secp_k`, `C_receipt_secp_k`).
4. Trader pushes the **fan** to the intent-pool relay:
   `(shared_fields, [for k in 0..K-1: (delta_in_k, delta_out_k,
   C_change_secp_k, C_receipt_secp_k, excess_k, bulletproof_k,
   intent_sig_k)])`. The fan is one intent record in the relay's
   index, keyed by `(asset_input_outpoint)` — settlers can fetch
   any tick.
5. Settler observes pool state at broadcast time, scans the fan
   for the tick whose `delta_out_k` satisfies `min_out` at the
   live reserves AND maximises trader value (= largest
   `delta_out_k` while still passing the freshness gate against
   the trader's signed `R_A_pre`/`R_B_pre`). Settler picks tick
   `k*` and broadcasts a T_SWAP_VAR envelope containing **only
   tick k\*'s data**. The other K−1 ticks remain in the relay
   (or are expired with the fan).
6. Indexer validates the on-chain T_SWAP_VAR exactly as for the
   single-Δ flow — it sees one Δ, one C_receipt, one bulletproof,
   one intent_sig. The fan structure is invisible on chain.

If pool movement is severe enough that NO tick in the fan
satisfies `min_out` against the live reserves, the settler
discards the fan and re-solicits from the trader (re-sign round
trip, same as single-Δ mode). For K = 8 with reasonable tick
spacing, this is rare in practice.

#### Tick schedule

The K-tick schedule above is **deterministic given
(K, delta_in_min, delta_in_max)**, so trader and settler agree
on the tick values without coordination. Conforming
implementations MUST use this exact schedule:

```
tick_k = ⌊delta_in_min · (delta_in_max / delta_in_min)^(k / (K-1))⌋
         for k ∈ {0, 1, …, K-1}, K ∈ {2, 4, 8, 16}
```

`K = 8` is the recommended default (covers 8 candidate Δs across
the trader's range with ~21 % geometric spacing between
adjacent ticks — close to typical AMM slippage steps at
moderate trade sizes). `K = 2` is the minimum useful fan (just
the bounds Y and X). `K = 16` adds redundancy at the cost of
2× intent-pool footprint vs K = 8.

The trader chooses K at intent-post time; the relay propagates
the chosen K to settlers as part of the off-chain intent-record
metadata. **K does NOT appear in the on-chain T_SWAP_VAR
envelope** — the broadcast tx contains exactly one tick's data
and is byte-identical to a single-Δ broadcast. K is purely an
intent-pool coordination parameter. K = 1 reduces to the single-Δ
flow (the tick is exactly the trader's chosen `delta_in`, equal
to both `delta_in_min` and `delta_in_max`).

#### Off-chain intent-pool record format (informative)

The reference worker's intent-pool relay accepts T_SWAP_VAR fans
in this off-chain format (NOT a Bitcoin envelope):

```
intent_pool_record = {
    pool_id:              32-byte hex,
    direction:            0 | 1,
    R_A_pre, R_B_pre:     u64,
    delta_in_min:         u64,
    delta_in_max:         u64,
    min_out:              u64,
    tip_amount:           u64,
    tip_asset:            0 | 1,
    expiry_height:        u32,
    trader_pubkey:        33-byte hex,
    asset_input_outpoint: { txid: 32-byte, vout: u32 },
    C_in_secp:            33-byte hex,
    receipt_scriptPubKey: variable,
    excess:               32-byte hex,                  // = r_change − r_in
                                                        // tick-independent (shared across fan)
    r_receipt:            32-byte hex,                  // tick-independent, HMAC-derived
                                                        // from trader_privkey (shared across fan).
                                                        // Published in the on-chain envelope of
                                                        // the chosen tick to bind C_receipt to
                                                        // delta_out.
    K:                    u8,                           // tick count ∈ {2, 4, 8, 16}
    ticks: [                                            // length K
        {
            delta_in:           u64,                    // = tick_k
            delta_out:          u64,                    // = curve(tick_k)
            C_change_secp:      33-byte hex (or NO-CHANGE SENTINEL),
            C_receipt_secp:     33-byte hex,
            bulletproof:        ~700-byte hex,
            intent_sig:         64-byte hex,
        },
        ...
    ]
}
```

The relay indexes records by `asset_input_outpoint` (one open fan
per UTXO at a time). Settler GETs a record, picks a tick `k*`,
extracts `(delta_in_{k*}, delta_out_{k*}, C_change_secp_{k*},
C_receipt_secp_{k*}, excess_{k*}, bulletproof_{k*}, intent_sig_{k*})`
plus the shared fields, and constructs the on-chain T_SWAP_VAR
envelope from that single tick's data. Wire-format details for
the relay are dapp/worker implementation choices, not normative
protocol surface.

#### Self-broadcast path

Trader observes pool, picks specific Δ, signs intent + builds
kernel sig themselves, broadcasts. Effectively `K = 1`. No fan
overhead for self-broadcasts since there's no settler to delegate
to. Pool-movement handling is the same — if the pool moves
between trader-sign and on-chain confirmation such that the
freshness gate rejects, the trader rebroadcasts with fresh state.

### Reorg safety

Standard Bitcoin finality. The "pool state must match `(R_A_pre,
R_B_pre)` one block before settlement" rule (validator algorithm
above) is the freshness gate. If a reorg invalidates the chain
between intent-broadcast and confirmation, the `T_SWAP_VAR` tx may
itself reorg out; standard Bitcoin reorg handling applies.

**Critical: pool state at depth ≥ 3.** AMM.md's reorg discipline
(`T_SWAP_BATCH` advances pool state at depth ≥ 3 blocks) applies
to `T_SWAP_VAR` too. A `T_SWAP_VAR` settled at block H modifies
the canonical pool state only after H + 3 confirmations.
Intermediate observers (dapp UI, mempool watchers) MAY display
"pending" reserves with the swap's effect applied, but indexer-
canonical reserves do not advance until depth.

This is the same discipline as `T_SWAP_BATCH` — the AMM is one
state machine; both opcodes feed it.

---

## Privacy model

`T_SWAP_VAR` has a different privacy posture from `T_SWAP_BATCH`.
The trade-offs:

| Property | `T_SWAP_BATCH` | `T_SWAP_VAR` |
|---|---|---|
| Trade size (Δ, Δ_out) | Hidden (only batch aggregate public) | **Public** (cleartext on chain) |
| Trader's pre-trade wallet balance | Hidden (Pedersen + BP) | Hidden (input UTXO commit, inheriting prior CXFER's confidentiality posture — see caveat below) |
| Trader's post-trade wallet balance | Hidden | Hidden (change/receipt commits) |
| Trader identity (pubkey on chain) | Public (in batch envelope) | Public (`trader_pubkey` field) |
| Receipt UTXO address | Blinded (fresh) | **Blinded (fresh)** |
| Linkability across multiple swaps | Hidden if `n_intents ≥ 2` in each batch | Linkable if trader reuses `trader_pubkey` |
| Sandwich attack surface | Resistant (batch-auction uniform price) | Standard AMM (mempool-visible) |
| Settlement latency | 2–4 s (two-round-trip) | One block (single tx) |

**The privacy regression vs `T_SWAP_BATCH` is the trade size.** The
chain observer learns exactly how much the trader put in and got
out. This is the standard AMM disclosure (Uniswap, Curve, etc.
all leak per-trade amounts).

**Caveat on the "wallet balance stays confidential" claim:** the
trader's pre-trade wallet balance is hidden behind the Pedersen-
binding assumption — recovering `amount_in` from `C_in_secp`
alone would require breaking discrete-log over a 33-byte
commitment. **However**, that confidentiality is inherited from
the input UTXO's CXFER history: if the trader's input UTXO came
from a prior CXFER whose `r_in` is known to any party (e.g., the
prior CXFER's counterparty under ECDH-derived blinding), that
party can open `C_in_secp` and learn `amount_in` directly. The
T_SWAP_VAR envelope adds no new privacy beyond the input's
existing CXFER posture; it does NOT strengthen confidentiality
against an adversary who already could deanonymize the input.
For maximal privacy, traders should compose the input UTXO
through the mixer before swapping (anonymity set substitution),
then T_SWAP_VAR, then post-compose the receipt back through the
mixer for forward unlinkability.

**Mitigations available to `T_SWAP_VAR` traders:**

1. **Fresh `trader_pubkey` per swap.** Mandatory dapp default: the
   dapp derives a fresh ephemeral pubkey per intent. This prevents
   the trivial cross-swap linkability that comes from pubkey reuse.
2. **Receipt UTXO at fresh address.** Already mandatory (see
   "Receipt-address blinding"). Means the trader's receiving
   address is unlinkable from the input UTXO's owner-history.
3. **Mixer post-composition.** After a `T_SWAP_VAR` settles, the
   trader can move the receipt UTXO through the SPEC §5.10–§5.11
   mixer for the receipt asset's `lp_asset_id`. This breaks the
   forward linkability between the public swap and any future use
   of the received tokens.
4. **Self-broadcast.** Removes the worker/settler from the
   observability story for that trade — but the chain trace is
   identical, so this is more about removing one middleman than
   any cryptographic gain.

**Dapp UX requirements (normative):** dapp implementations of
`T_SWAP_VAR` MUST:

- Default to fresh `trader_pubkey` per intent.
- Surface a "trade size is public" callout before broadcast, with
  a link to `T_SWAP_BATCH` ("private mode") as the alternative for
  privacy-sensitive flow.
- Offer one-click "mix this receipt" after settlement (composing
  the receipt UTXO into the mixer pool for `lp_asset_id_receipt`).

---

## Why `T_SWAP_VAR` and not a generalized `T_SWAP`

Same justification structure as the variable-amount amendment's
"Why a new opcode" rationale (`SPEC-VARIABLE-AMOUNT-AMENDMENT.md`
§"Why exactly one asset input"):

1. **Layout semantics differ.** `T_SWAP_VAR`'s tx layout
   interleaves the trader's receipt at `vout[1]` and change at
   `vout[2]`, with the optional tip at `vout[3]` — distinct from
   `T_SWAP_BATCH`'s N-trader contiguous receipt layout
   (`vout[1..N]`). A distinct opcode declares the layout
   unambiguously.

2. **Validation rules differ.** `T_SWAP_VAR` has no Groth16
   verification, no batch-membership constraint, no qualifying-set
   fixed-point. The validator algorithm is a fundamentally
   different (much shorter) function. Separating opcodes keeps
   the validator dispatch clean.

3. **Privacy posture differs.** As enumerated in the Privacy model
   table above. Two distinct opcodes signal two distinct trader
   experiences; one combined opcode would force every trader to
   navigate a private/public flag and force every dapp to render
   the trade-off explicitly. Separation lets the dapp's "swap"
   button default to `T_SWAP_VAR` and surface `T_SWAP_BATCH` as an
   explicit opt-in.

4. **Cryptographic primitives differ.** `T_SWAP_VAR` uses CXFER
   N=2 (same as `T_AXFER_VAR`); `T_SWAP_BATCH` uses a 123-public-
   signal Groth16 circuit over BabyJubJub. No shared primitive
   beyond the Pedersen secp commitment format.

---

## Backwards-compatibility statement

`T_SWAP_VAR` is **purely additive**. It introduces a new opcode
(`0x32`) that V1 indexers must learn to parse and validate; V1
indexers that don't know about it would treat it as an unknown
opcode and ignore the envelope — failing the pool-state advance,
not corrupting it.

This amendment does NOT modify:

- The `T_SWAP_BATCH` opcode (`0x2F`) or its Groth16 circuit.
- The `T_LP_ADD` / `T_LP_REMOVE` opcodes.
- The pool-state derivation rules in AMM.md §"Pool state".
- The fee mechanism or `lp_asset_id` derivation.
- Any wire format outside the new `T_SWAP_VAR` envelope.

It DOES require:

- A new opcode dispatch branch in the indexer's validator.
- 1 new BIP-340 domain tag (`tacit-amm-swap-var-v1`) for intent
  signing. Kernel-msg construction reuses CXFER's existing
  `tacit-kernel-v1` tag with no extension needed.
- 4 new HMAC keystream domains
  (`tacit-amm-swap-var-receipt-v1` for receipt-blinding,
  `tacit-amm-swap-var-recv-v1` for receipt-address derivation,
  `tacit-amm-swap-var-change-v1` for change-blinding,
  `tacit-amm-swap-var-tip-v1` for settler-tip blinding).
- Dapp UX updates to render the two-paths choice (T_SWAP_VAR
  default, T_SWAP_BATCH opt-in).

---

## Test plan (informative — non-normative)

End-to-end signet rehearsal:

1. POOL_INIT a fresh pool with `(asset_A, asset_B)`, fee_bps = 30.
2. LP_ADD seed liquidity (e.g., 1e6 base units each side).
3. Self-broadcast `T_SWAP_VAR` A→B with `delta_in_min = 1000`,
   `delta_in = 5000`, `delta_in_max = 10000`, `min_out` set just
   below the curve's expected output. Verify:
   - Indexer accepts the tx.
   - Pool reserves update correctly.
   - Receipt UTXO appears at the deterministic blinded address.
   - Change UTXO carries the correct commitment.
   - Bulletproof verifies; kernel sig verifies.
4. Relayed `T_SWAP_VAR` via the reference worker — settler picks
   `Δ` within the range. Verify same as (3) plus the tip UTXO at
   `vout[3]` opens correctly to `tip_amount`.
5. Multi-fill: send 3 self-broadcast `T_SWAP_VAR` fills in three
   blocks. Verify pool reserves walk correctly and `k = R_A · R_B`
   grows monotonically.
6. Reorg safety: broadcast a `T_SWAP_VAR` and a competing
   `T_SWAP_BATCH` in the same block; cause a 1-block reorg.
   Verify indexer rolls back pool state cleanly.
7. Stale reserves: broadcast a `T_SWAP_VAR` with `R_A_pre` /
   `R_B_pre` matching block H − 2 instead of H − 1. Indexer
   rejects.
8. Slippage: broadcast a `T_SWAP_VAR` with `min_out` set above the
   curve's actual output. Indexer rejects.
9. Range bounds: broadcast with `delta_in > delta_in_max`.
   Indexer rejects.
10. Receipt recovery: wipe the trader's local app state; restore
    from seed. Verify the trader's receipt UTXO is rediscoverable
    via the HMAC keystream alone.

Cross-impl parity:

11. Dapp builds `T_SWAP_VAR` envelope; worker validates it.
12. Worker builds `T_SWAP_VAR` envelope; dapp validates it.
13. Kernel-msg byte-parity check (dapp vs worker) for the same
    canonical inputs.

Adversarial:

14. Replay attack: rebroadcast a previously-confirmed `T_SWAP_VAR`
    tx. Bitcoin rejects (vin[1] already spent); indexer never sees it.
15. Sandwich attempt: a malicious settler observes the trader's
    intent in the mempool, broadcasts a competing `T_SWAP_VAR`
    (or `T_SWAP_BATCH`) in the same block that moves the pool's
    spot. Verify the original trader's `min_out` floor catches it
    and the indexer rejects the original swap (post-sandwich
    `delta_out_expected < min_out`).
16. Curve fudge: settler broadcasts with `delta_out` higher than
    the recomputed curve value. Indexer rejects.

---

## Domain-tag additions

Add to AMM.md §"Versioning hooks built into the protocol":

```
"tacit-amm-swap-var-v1"           → T_SWAP_VAR intent_msg domain
"tacit-amm-swap-var-receipt-v1"   → T_SWAP_VAR receipt-blinding HMAC keystream
"tacit-amm-swap-var-recv-v1"      → T_SWAP_VAR receipt-address derivation
"tacit-amm-swap-var-change-v1"    → T_SWAP_VAR change-blinding HMAC keystream
                                      (fresh r_change derivation for forward privacy
                                      and on-chain recovery of the change UTXO)
"tacit-amm-swap-var-tip-v1"       → T_SWAP_VAR settler-tip blinding HMAC keystream
```

Add to SPEC.md §3 *opcodes table*:

- `0x32` `T_SWAP_VAR` — per-trade variable-amount AMM swap
  (§5.16.3). Reuses CXFER N=2 cryptography from `T_AXFER_VAR`.
  Public per-fill amounts; opt-in alternative to `T_SWAP_BATCH`
  (`0x2F`).

---

## What this amendment explicitly does NOT specify

Out of scope, left for future amendments:

- **Range-LP support.** `T_SWAP_VAR` settles against full-range
  pools only. V2-AMM range-LP opcodes (`0x33`–`0x36`, reserved in
  AMM.md) would need a `T_SWAP_VAR_RANGE` variant that walks tick
  liquidity per-fill — separate amendment.
- **Multi-hop routing.** `T_SWAP_VAR` is one pool per tx. A trader
  wanting A → B → C must chain two `T_SWAP_VAR`s, or use the
  dapp's router which composes them off-chain. A future
  `T_SWAP_VAR_PATH` could atomically settle multi-hop routes in
  one tx; not in V1 scope.
- **Limit orders.** `T_SWAP_VAR` accepts `[Y, X]` range + `min_out`
  but is not a limit order in the orderbook sense (a maker order
  resting until taken). For limit-order semantics, use the
  variable-fill bid amendment's maker-quoted intents directly.
- **Cross-pool atomic swaps.** A single tx settling against two
  different AMM pools (e.g., for arbitrage) is not specified.
  Settlers can chain two `T_SWAP_VAR` txs at the cost of two
  Bitcoin fees.
- **Adaptor-sig delegation for settler-chosen `delta_in`.** The
  V1 ships the simpler "trader signs a specific delta_in,
  re-sign on movement" flow. Adaptor-sig delegation (settler
  chooses delta_in within the range without a re-sign) is a
  cryptographic enhancement that could be added later without
  breaking V1 wire format.
- **Confidential per-fill amounts.** A future variant could put
  `delta_in` and `delta_out` inside Pedersen commitments with a
  curve-feasibility proof in Groth16 — recovering
  amount-confidentiality at the cost of the per-fill proof. This
  is a meaningful circuit design exercise; not in V1.

---

## Open questions for round-2 review

1. **Settler tip in `tip_asset = output asset` (asset_B for A→B).**
   The current spec requires `tip_asset == direction.input` (the
   asset the trader is paying in). Should we also allow paying tip
   in the output asset (taken from `delta_out` before delivering
   the receipt)? Symmetric with `T_SWAP_BATCH`'s tip flexibility.

2. **Fresh-pubkey-per-intent enforcement.** Dapp UX guidance vs.
   indexer-enforced. Should the indexer reject a `T_SWAP_VAR` whose
   `trader_pubkey` matches a prior `T_SWAP_VAR`'s pubkey within
   some lookback window? Conservative: leave it to dapp discipline.

3. **Optimal default `K` for tick-fan mode.** The spec recommends
   `K = 8`; choices are `{2, 4, 8, 16}`. Empirical signet measurement
   under typical pool volatility will inform whether to lift the
   default (more re-sign-loop-avoidance, larger relay footprint) or
   lower it (smaller footprint, more re-signs). Pure tuning, not a
   correctness question.

(Resolved in this round:
- **Settler-chosen Δ coordination** — V1 ships the **tick-fan mode**
  (trader pre-signs K candidate Δs at deterministic log-spaced
  ticks; settler picks one). On-chain wire format is identical to
  single-Δ. Eliminates re-sign loops in the common case without
  cryptographic novelty. True Schnorr-adaptor delegation (settler
  picks any Δ in `[Y, X]` continuously) remains a v1.1 enhancement
  for traders who want a single intent-record footprint at any
  K-tick resolution; not blocking for V1.
- Strict-reserves-match gate kept as normative.
- Receipt-binding via trader-signed specific Δ locked for V1.
- `MINIMUM_LIQUIDITY` post-state check dropped as a unit-mismatch —
  replaced with `R_A_post > 0 ∧ R_B_post > 0` which the curve
  already guarantees.)

---

## Integration checklist for landing in `SPEC.md`

- [ ] §5.16 AMM block extended with §5.16.3 `T_SWAP_VAR`.
- [ ] §3 opcode table adds `0x32 T_SWAP_VAR`.
- [ ] §3 BIP-340 domain-tag table adds the four new tags above.
- [ ] §5.5 validator dispatch extended with `T_SWAP_VAR` branch.
- [ ] AMM.md "Two AMM trader paths" section reference updated from
      "reserved" to "specified in §5.16.3".
- [ ] Reference dapp `tacit.js` implements:
      - `kind: 'amm-var'` candidate path in `planBuy` and
        `planBuyExactOut`.
      - `buildSwapVarEnvelope()` for both self-broadcast and
        relayed paths.
      - Fresh-pubkey-per-intent default.
      - "Trade size is public" UX callout.
      - One-click mixer post-composition.
- [ ] Reference worker:
      - `T_SWAP_VAR` indexer-validator dispatch branch.
      - Intent-pool relay for `T_SWAP_VAR` intents (similar to the
        existing bid-intent relay).
- [ ] Cross-impl test vectors: 5 canonical envelopes shared
      between dapp and worker (kernel-msg + intent-msg byte parity).
- [ ] Signet rehearsal: items (1)–(16) from the test plan, all
      green.
- [ ] Backwards-compat replay test: confirm V1 pre-amendment
      `T_SWAP_BATCH` envelopes are still processed correctly by
      the extended indexer.

---

## Sign-off checklist

- [ ] Round-1 peer review
- [ ] Round-2 peer review
- [ ] Reference dapp implementation
- [ ] Reference worker / indexer implementation
- [ ] Signet e2e validation
- [ ] Cross-impl parity tests
- [ ] Tacitscan parity confirmation
- [ ] Crypto review (post-merge — the cryptographic primitives are
      all reused from CXFER and T_AXFER_VAR, both of which have
      independent review; T_SWAP_VAR adds no new primitives but
      introduces new domain tags whose binding should be reviewed)
- [ ] Merge into `SPEC.md` and mark `✅ Merged` in `AMENDMENTS.md`
