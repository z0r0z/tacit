# SPEC Amendment — Atomic Cross-Surface Settlement (`T_TRADE_BATCH`)

> Status: 📝 Draft (round-1) — **wire format + validator algorithm**
> **spec'd for V1 architectural commitment; reference**
> **implementation deferred** until cross-surface demand justifies
> the engineering work.
>
> Depends on: existing `amm_swap_batch.circom` Groth16 circuit
> (SPEC.md §5.16; ceremony-locked vk applies) + CXFER N=2
> cryptography (deployed in T_AXFER_VAR per
> `SPEC-VARIABLE-AMOUNT-AMENDMENT.md`) + variable-fill bid intents
> (`SPEC-BID-VARIABLE-AMOUNT-AMENDMENT.md` §5.7.7). No new
> cryptographic primitive. No new Groth16 circuit. No new ceremony.
>
> Adds a single opcode (`T_TRADE_BATCH` `0x39`) that settles N AMM
> intents + K orderbook bilateral pairs **atomically in one Bitcoin
> transaction**. Either every leg of the cross-surface batch
> confirms or none does. The AMM portion is verified by the
> existing AMM Groth16 proof against the existing vk; the
> orderbook portion is verified per-pair via the same direct-
> opening + kernel-sig pattern as T_AXFER_VAR; a combined
> chain-side aggregate Pedersen check spans both surfaces and
> guarantees no value is created from thin air across the
> cross-surface boundary.

---

## Motivation

Tacit's two settlement primitives — `T_SWAP_BATCH` (`0x2F`,
batched-uniform AMM) and `T_AXFER_VAR` (`0x37`, pairwise atomic
orderbook fill) — each settle their own surface atomically but
operate as separate Bitcoin transactions. A trader whose intent
spans both surfaces (e.g., "swap 100k sats: route across orderbook
+ AMM optimally") sees their fills land in the same block when the
dapp coordinates well, but at the Bitcoin layer the legs are
independent — one can confirm and the other can fail.

For most retail UX, block-level soft-atomicity (per
`../design/CHANNEL-UX-DESIGN.md`) is sufficient. But three classes of trade
genuinely need Bitcoin-tx-level atomicity:

1. **Cross-surface arbitrage.** A market-maker sees an orderbook
   ask priced above AMM spot. They want to take the orderbook ask
   AND execute the opposing AMM swap in one tx. If either leg
   fails (price moved, MEV, slippage), the whole arbitrage must
   revert — otherwise the maker is left holding half a position.

2. **Multi-hop atomic swaps.** A trader wants A → B → C in one
   shot: A → B via orderbook (where a maker quoted that pair),
   B → C via AMM (where a pool exists). With two separate txs,
   the intermediate B exposes the trader to price risk between
   confirmations. With one atomic tx, the trader's A → C trade is
   guaranteed all-or-nothing.

3. **Atomic settle-and-mix.** A privacy-conscious trader executes
   a swap AND deposits the receipt into the mixer's anonymity set
   in one tx, with no observable on-chain linkage between the
   pre-trade input and the post-mix anonymity pool. Two separate
   txs leak the linkage; one atomic tx does not.

These uses don't require high volume — they require correctness
guarantees. T_TRADE_BATCH provides them by composing existing
primitives in one envelope.

The architectural insight: **the AMM circuit doesn't care about
the rest of the Bitcoin transaction**. The Groth16 proof is a
math statement about per-trader openings + clearing-price
constraints + per-trader receipts; it has no awareness of whether
the tx also contains orderbook inputs or mixer deposits. As long
as the proof's public-input vector matches what the existing
amm_swap_batch.circom vk expects, the proof verifies. So we can
embed an AMM sub-batch in a larger envelope without modifying
the circuit.

The orderbook side has even fewer constraints. Each maker-taker
pair settles via direct opening + per-pair kernel sig (the
T_AXFER_VAR pattern). These are local checks that compose
trivially with each other and with the AMM sub-batch.

The only non-trivial design work is the **combined chain-side
aggregate Pedersen check** that enforces total-asset conservation
across both surfaces — done sloppily, you can have an AMM sub-batch
that passes its Groth16 check AND an orderbook sub-batch that
passes its per-pair conservation, while the combined tx still
fabricates asset value across the cross-surface boundary. Done
correctly, it's a clean extension of T_SWAP_BATCH's existing
chain-aggregate check.

---

## §5.20 `T_TRADE_BATCH` (`0x39`) — atomic cross-surface settlement

(SPEC.md section number tentative; lands as §5.20 after §5.19
T_WRAPPER_ATTEST.)

### Wire format

```
opcode(1)              = 0x39
n_amm_intents(1)       u8, 0..16 (matches T_SWAP_BATCH's N_MAX cap)
n_orderbook_pairs(1)   u8, 0..16 (per-batch orderbook pair cap;
                                  spec-defined, not circuit-defined)
n_assets_touched(1)    u8, 1..16 (distinct asset_ids appearing in
                                  any input or output of this batch)

# ----- AMM sub-batch -----
# Present iff n_amm_intents > 0.
# Wire-identical to T_SWAP_BATCH (§5.16) payload, but with
# its opcode byte and outer headers stripped. The indexer
# extracts the AMM sub-batch and validates it via the
# existing amm_swap_batch.circom vk + standard T_SWAP_BATCH
# validator algorithm.
amm_sub_batch_len(2)    u16 LE, total bytes of the AMM sub-batch
amm_sub_batch(variable) per-AMM-intent block + Groth16 proof bytes
                        (see "AMM sub-batch contents" below)

# ----- Orderbook sub-batch -----
# Present iff n_orderbook_pairs > 0.
ob_pair_count(1)        u8 (duplicates n_orderbook_pairs for
                            framing locality; indexer rejects
                            on mismatch)
[per orderbook pair k ∈ {0, …, K-1}, ordered by maker_intent_id
 ascending byte-order]:
    maker_intent_id(32)         intent_id from §5.7.6.1 / §5.7.7
    maker_listed_outpoint       txid_BE(32) || vout_LE(4)
                                of the maker's pre-signed
                                listed UTXO (vin index encoded
                                later in the Bitcoin tx layout)
    taker_input_outpoint        txid_BE(32) || vout_LE(4)
                                of the taker's input (if asset-
                                paying-taker), or all-zeros if
                                the taker pays in BTC (sats leg)
    fill_amount_LE(8)           u64, the amount of asset filled
                                in this pair (bounded by the
                                maker's [min_fill, max_fill] from
                                their published intent)
    pair_direction(1)           0 = maker pays asset A receives
                                    asset B (e.g., maker sells
                                    TAC for cBTC),
                                1 = maker pays asset A receives
                                    sats (asset-for-sats trade)
    C_maker_change_secp(33)     maker's change commit if partial
                                fill; secp identity sentinel
                                (33 × 0x00) if maker UTXO is
                                fully consumed
    C_taker_receipt_secp(33)    taker's receipt commit
                                (committed value = fill_amount)
    range_proof(~700)           m=2 bulletproof over
                                (C_maker_change, C_taker_receipt)
                                — same wire format as T_AXFER_VAR
    kernel_sig(64)              BIP-340 over kernel_msg (defined
                                below); closes the per-pair
                                asset-side balance under
                                excess_pair = r_taker - r_maker

# ----- Combined chain-side aggregate Pedersen check data -----
# One R_net per distinct asset_id touched in the batch.
# Ordered by asset_id byte-ascending.
[per asset_id_i ∈ {asset_ids_touched}]:
    asset_id(32)                32-byte asset identifier
    R_net_secp(32)              secp256k1 scalar (BE), aggregate
                                blinding residual for this asset

# ----- Cleartext per-pool deltas (AMM portion) -----
# Present iff n_amm_intents > 0; one entry per distinct pool_id
# in the AMM sub-batch.
[per pool_id ∈ {AMM_pools_touched}]:
    pool_id(32)
    delta_A_net_signed(9)       1-byte sign || 8-byte u64 LE
                                (asset-A net flow into pool; for
                                A→B trades positive, for B→A
                                negative)
    delta_B_net_signed(9)       same encoding for asset-B

# ----- Settler tip outputs -----
# Two per AMM-touched asset (asset-A tip + asset-B tip per pool)
# plus per-pair settler tips (orderbook). Layout matches
# T_SWAP_BATCH and T_AXFER_VAR's existing tip mechanisms.
tip_count(1)                    u8
[per tip output]: see §5.16 + §5.7.9 tip mechanic specs

# ----- Outer envelope sig -----
settler_pubkey(33)              compressed secp256k1; the settler
                                broadcasting this combined tx
settler_sig(64)                 BIP-340 over
                                SHA256("tacit-trade-batch-v1"
                                       || all_preceding_fields)
```

**Approximate wire size:**
- AMM sub-batch: ~9.5 KB at N=16 (per T_SWAP_BATCH analysis)
- Orderbook sub-batch: ~900 bytes per pair × K pairs
- Combined aggregate data: ~64 bytes per asset_id × n_assets_touched
- Tip outputs + envelope wrapper: ~500 bytes
- Total at maximum (N=16, K=16): ~25-30 KB envelope

Well under Bitcoin's standard tx-size limits with Taproot
script-path. One full Bitcoin tx per atomic cross-surface batch.

### Bitcoin tx layout (normative)

```
vin[0]                  Settler's envelope-bearing input (Taproot
                        script-path); witness carries the
                        T_TRADE_BATCH payload.

# AMM sub-batch inputs (in intent_id ascending byte-order; M = n_amm_intents)
vin[1 .. M]             AMM trader inputs (signed SIGHASH_ALL over
                        envelope_hash — same discipline as
                        T_SWAP_BATCH §5.16).

# Orderbook maker inputs (in pair-index ascending order, K = n_orderbook_pairs)
vin[M+1 .. M+K]         Orderbook maker tacit asset inputs
                        (each signed SIGHASH_SINGLE|ANYONECANPAY
                        per the maker's pre-signed intent).

# Orderbook taker inputs (asset-paying takers, in pair-index ascending order)
vin[M+K+1 .. M+K+T]     Orderbook taker tacit asset inputs (where
                        the taker pays asset rather than sats).
                        Each signed SIGHASH_ALL by taker over
                        envelope_hash.

# Settler BTC funding
vin[M+K+T+1 ..]         Settler BTC inputs (signed SIGHASH_ALL).

# Outputs
vout[0]                 OP_RETURN(envelope_hash) — 0 sat, 32-byte
                        data, envelope_hash = SHA256(payload).
vout[1 .. M]            AMM trader receipts (per §5.16 layout —
                        dust P2WPKH paying each AMM trader's
                        pre-declared receive script).
vout[M+1 .. M+K]        Orderbook taker receipts (in pair-index
                        ascending order).
vout[M+K+1 .. M+K+K']   Orderbook maker BTC payments (for asset-
                        for-sats pairs; K' ≤ K).
vout[M+K+K'+1 .. M+K+K'+K'']
                        Orderbook maker changes (for partial-fill
                        pairs; K'' ≤ K).
vout[…]                 Aggregated tip outputs (per-asset, per-
                        surface).
vout[final…]            Optional settler BTC change.
```

Indexers MUST reject any `T_TRADE_BATCH` whose layout deviates
from the schema above. The OP_RETURN binding rule (`vout[0]`
data = SHA256(payload)) is the same defense against envelope
swap as T_SWAP_BATCH.

### AMM sub-batch contents

The AMM sub-batch is **bit-identical to a standalone
T_SWAP_BATCH's payload (per SPEC.md §5.16), minus the leading
opcode byte and outer wrappers**. Specifically:

- Per-intent block × N (intent_id, trader_pubkey, C_in_secp,
  C_in_BJJ, xcurve_sigma, min_out, tip, expiry, intent_sig, …)
- Per-receipt block × N (C_out_secp, C_out_BJJ, out_xcurve_sigma)
- R_net_A, R_net_B for the AMM portion (32 + 32 bytes)
- tip_A_amount, tip_B_amount, tip commits, r_tip openings
- Groth16 proof bytes

The Groth16 proof is generated and verified against the **same**
`amm_swap_batch.circom` `vk` used by standalone T_SWAP_BATCH.
The 123-signal public-input vector layout is identical. No
circuit modification, no fresh ceremony.

The AMM sub-batch's R_net_A and R_net_B represent **only the
AMM portion's** aggregate blinding residual — they're a local
quantity for the AMM Pedersen check. The combined chain-side
aggregate check (below) sums them with orderbook contributions.

### Orderbook pair kernel-msg construction

Per pair, the kernel sig closes the asset-side balance via
direct opening of the per-pair commitments:

```
kernel_msg_pair = SHA256(
    "tacit-kernel-v1"                       # reused from CXFER + T_AXFER_VAR
    || asset_id_in(32)                       # asset the maker pays (= asset the taker receives)
    || asset_input_count_LE(1) = 0x01        # always 1 for a pair
    || maker_listed_outpoint                 # txid_BE(32) || vout_LE(4)
    || C_maker_change_or_sentinel(33)        # maker's change commit (or sentinel)
    || C_taker_receipt_secp(33)              # taker's receipt commit
    || burned_amount_LE(8) = 0
)
```

Kernel sig verifies under
`(C_maker_change_or_sentinel + C_taker_receipt_secp − C_maker_listed).x_only`
with excess = (r_change + r_receipt − r_listed_maker) for partial
fills, or (r_receipt − r_listed_maker) when sentinel is used (full
consumption).

This is structurally identical to T_AXFER_VAR's kernel-sig closure
(two outputs same-asset, sums to one consumed input). The
orderbook pair settles cleanly per-pair via this single Schnorr
sig.

**Pair direction = 1 (asset-for-sats trade):** the maker's
receipt is BTC payment (not a tacit-asset commit). Layout
becomes maker-asset-input → taker-asset-receipt + maker-BTC-
payment-vout + maker-change. The kernel sig still closes the
asset-A balance; the BTC payment leg is bound via SIGHASH_SINGLE
on the maker's listed input (same as T_AXFER_VAR §5.7.9).

### Combined chain-side aggregate Pedersen check (the design-precision-critical piece)

For each asset_id_i in n_assets_touched, the indexer verifies:

```
LHS_i = Σ_{j ∈ AMM_inputs, asset(j) == asset_id_i} C_in_secp_j
      + Σ_{k ∈ OB_inputs, asset(k) == asset_id_i} C_in_secp_k

      − Σ_{j ∈ AMM_outputs, asset(j) == asset_id_i} C_out_secp_j
      − Σ_{k ∈ OB_outputs, asset(k) == asset_id_i} C_out_secp_k

      − Δ_pool_net_i · H_secp                 # cleartext pool delta for this asset

      − tip_amount_i · H_secp                  # cleartext tip total for this asset

RHS_i = R_net_secp_i · G_secp

require LHS_i == RHS_i  // for each asset_id_i
```

Where:
- AMM_inputs = per-AMM-intent `C_in_secp` values whose asset matches
- AMM_outputs = per-receipt `C_out_secp` values whose asset matches
- OB_inputs = per-pair maker `C_listed` (consumed via the pair) AND per-pair taker `C_in` if taker pays asset
- OB_outputs = per-pair `C_taker_receipt` AND per-pair `C_maker_change` if non-sentinel
- Δ_pool_net_i = sum over AMM pools touching asset_id_i of the cleartext pool delta (signed: positive = inflow into pool, negative = outflow from pool)
- tip_amount_i = sum of all tip outputs in this asset (both AMM aggregate tips and per-pair settler tips)
- R_net_secp_i = aggregate blinding residual revealed in the envelope; settler computes this from all trader-revealed blindings

**This check is what makes T_TRADE_BATCH safe across surfaces.**
Without it, a malicious settler could construct an envelope where
the AMM sub-batch passes its Groth16 check independently AND each
orderbook pair passes its per-pair conservation independently,
but the combined tx fabricates value by, e.g., reusing a commit
in both surfaces or mis-summing the tip outputs. The combined
check forces the inputs minus outputs minus cleartext flows to
balance exactly to R_net · G_secp per asset.

The R_net values are revealed (each 32 bytes per asset). The
settler computes them by summing all trader blindings from the
opening blobs they collected during settlement (AMM RTT-1
openings + orderbook maker pre-signed openings + taker openings).
Trader blindings stay private to the settler (encrypted opening
blobs); only the per-asset aggregate R_net is published.

### Validator algorithm

```
on T_TRADE_BATCH envelope at confirmation depth ≥ FINALITY_DEPTH:

    require envelope.opcode == 0x39
    require n_amm_intents + n_orderbook_pairs > 0 (non-empty batch)
    require n_amm_intents <= 16
    require n_orderbook_pairs <= 16
    require n_assets_touched <= 16

    decode payload; reject on structural error
    verify settler_sig under settler_pubkey over
        SHA256("tacit-trade-batch-v1" || preceding_fields)

    # Validate AMM sub-batch (if present)
    if n_amm_intents > 0:
        # Extract AMM sub-batch fields
        let amm_payload = decode_amm_sub_batch(payload, amm_sub_batch_len)
        # Validate exactly as a standalone T_SWAP_BATCH (per §5.16)
        verify per-intent sigma cross-curve proofs
        verify per-receipt sigma cross-curve proofs
        verify Groth16 proof against pool.vk for each touched pool
        verify deterministic clearing-solve consistency
        verify R_net_AMM_A, R_net_AMM_B Pedersen identity locally
        verify intent_sig per included AMM intent

    # Validate orderbook sub-batch (if present)
    if n_orderbook_pairs > 0:
        for each pair k:
            verify maker SIGHASH_SINGLE|ACP sig on vin[M+1+k]
            verify per-pair kernel_sig closes asset-side balance
            verify m=2 bulletproof over (C_maker_change_or_sentinel, C_taker_receipt)
            verify maker's intent (referenced by maker_intent_id) is still
                open in the worker's intent pool (not expired, not
                already fully filled)
            verify fill_amount within maker's [min_fill, max_fill]
            verify taker_input_outpoint consumed exactly once across
                all pairs in this batch
            if pair_direction == 1:
                verify SIGHASH_SINGLE binding on BTC payment vout

    # Combined chain-side aggregate Pedersen check (THE CRITICAL CHECK)
    for each asset_id_i in n_assets_touched:
        compute LHS_i = sum of all asset_id_i inputs across both
                        sub-batches, minus all asset_id_i outputs,
                        minus cleartext pool deltas, minus tip totals
        require LHS_i == R_net_secp_i · G_secp

    # Tip mechanics
    for each tip output: verify per §5.16 + §5.7.9 conventions

    # All checks pass: apply state transitions atomically
    for each AMM intent:
        advance pool reserves; credit receipt UTXO; consume input UTXO
    for each orderbook pair:
        consume maker listed UTXO; advance maker fulfilment register;
        credit taker receipt; emit maker BTC payment or change
    emit settler tip UTXOs
```

If ANY check fails, the entire envelope is rejected. The Bitcoin
tx still confirms (Bitcoin doesn't care about indexer semantics)
but the indexer doesn't update state — none of the AMM intents
consume their input from the indexer's perspective; none of the
orderbook pairs settle. Atomic at the indexer-state-transition
layer.

### Cross-surface ordering rule

If a single T_TRADE_BATCH touches the same AMM pool's reserves
that another AMM op also touches in the same block, the
within-block ordering rule from AMM.md §"Indexer determinism
rules" applies: `(tx_index, vin[0] outpoint)` ascending. Same as
how multiple T_SWAP_BATCHes against the same pool would interact
in one block.

Same applies for orderbook intents touching the same maker UTXO:
the first canonically-ordered T_TRADE_BATCH consuming the maker's
input wins; subsequent attempts get UTXO-double-spent at the
Bitcoin layer.

### Reorg safety

Same posture as T_SWAP_BATCH. Pool state advances at depth ≥ 3;
orderbook pair settlements are at standard Bitcoin finality
(depth ≥ 1). Intermediate observers MAY display "settling
(provisional)" / "settled (final)" status based on depth.

---

## Composing with `T_INTENT_ATTEST` (channel layer)

T_TRADE_BATCH is the settlement primitive; T_INTENT_ATTEST is the
intent-pool commitment primitive. They compose naturally:

- During a channel period, intents accumulate in the worker's
  intent pool (orderbook bids/asks + AMM intents).
- Worker periodically broadcasts T_INTENT_ATTEST covering the
  combined scope.
- A settler decides to settle a batch — composes a T_TRADE_BATCH
  envelope by selecting K orderbook pairs to fill + N AMM intents
  to include, runs the deterministic clearing-solve for the AMM
  portion, collects per-intent openings (AMM 2-RTT) + pre-signed
  orderbook intents, assembles, broadcasts.
- The combined T_TRADE_BATCH settles all selected intents in one
  Bitcoin tx, atomically.

The channel layer's UX (per `../design/CHANNEL-UX-DESIGN.md`) extends
naturally: post-settlement summary shows fills across both
surfaces in one view.

---

## Backwards-compatibility statement

T_TRADE_BATCH is **purely additive**. It introduces opcode `0x39`
that V1 indexers must learn to parse; V1 indexers without
T_TRADE_BATCH support treat it as unknown and ignore the
envelope (no indexer-state change). Existing standalone
T_SWAP_BATCH and T_AXFER_VAR opcodes continue to work
identically; settlements via those primitives are unchanged.

This amendment does NOT modify:
- `amm_swap_batch.circom` (the AMM Groth16 circuit, ceremony-
  locked)
- The AMM Phase 2 ceremony or its `vk`
- T_SWAP_BATCH wire format or validator (§5.16 unchanged)
- T_AXFER_VAR wire format or validator (§5.7.9 unchanged)
- T_INTENT_ATTEST or any channel-layer primitive
- Any existing BIP-340 domain tag (CXFER's `tacit-kernel-v1` is
  reused for orderbook pair kernel sigs, same as T_AXFER_VAR)

It DOES add:
- One new opcode (`0x39`)
- One new BIP-340 domain tag (`tacit-trade-batch-v1`) for the
  settler_sig over the outer envelope
- A new indexer validator dispatch branch with the combined
  chain-side aggregate Pedersen check
- Worker / dapp / settler tooling to assemble T_TRADE_BATCH
  envelopes (settler-side complexity — they must coordinate
  AMM RTT-1 openings + orderbook intent assembly in one
  composed envelope)

---

## Test plan (informative — non-normative)

End-to-end signet rehearsal:

1. **AMM-only T_TRADE_BATCH (n_orderbook_pairs = 0).** Should
   behave identically to a standalone T_SWAP_BATCH. Verify the
   AMM Groth16 proof validates against the existing vk; verify
   the combined chain-aggregate check reduces to the standard
   T_SWAP_BATCH aggregate check.
2. **Orderbook-only T_TRADE_BATCH (n_amm_intents = 0).** Should
   behave identically to N independent T_AXFER_VAR txs (but
   atomically). Verify per-pair conservation + the combined
   aggregate check spanning only orderbook flows.
3. **Mixed T_TRADE_BATCH (both non-zero).** A trader's typed
   budget routed across 3 orderbook pairs + 2 AMM intents.
   Verify all 5 fills land atomically.
4. **Cross-surface arbitrage.** Settler composes T_TRADE_BATCH
   with one AMM intent + one orderbook ask matching the
   opposing direction. Verify atomic execution; verify settler
   collects both surfaces' tip outputs.
5. **Atomic settle-and-mix.** Trader's swap + mixer T_DEPOSIT
   in one tx (requires extending the envelope to also bundle a
   T_DEPOSIT sub-section, OR via a separate mixer-aware
   amendment — punt this case to a future amendment if it's not
   trivially composable).
6. **Partial-failure rejection.** A T_TRADE_BATCH where one
   orderbook pair has invalid sig. Verify the entire envelope
   is rejected (no AMM intents settle either).
7. **Cross-surface conservation attack.** A T_TRADE_BATCH where
   each sub-batch's local check passes but the combined chain-
   aggregate is off by 1 base unit. Verify the indexer rejects
   the envelope.
8. **Combined aggregate with multiple assets.** A batch touching
   3 distinct asset_ids. Verify per-asset chain-aggregate check
   closes for each asset.

Cross-impl parity:
9. Dapp builds T_TRADE_BATCH envelope; worker validates.
10. Worker builds envelope; dapp validates.
11. Byte-parity check between dapp + worker canonical hash
    pre-image.

Adversarial:
12. Replay: rebroadcast confirmed T_TRADE_BATCH. Bitcoin rejects.
13. Forged settler sig. Indexer rejects.
14. Swap AMM trader's input commit between two T_TRADE_BATCH
    candidates in the same block. UTXO-double-spend at Bitcoin
    layer; only one wins.

---

## Domain-tag additions

Add to SPEC.md §3 *BIP-340 domain tags*:
- `tacit-trade-batch-v1` — outer envelope settler_sig domain.
  Binds the entire combined envelope under the settler's
  pubkey.

Add to SPEC.md §3 *opcodes table*:
- `0x39` `T_TRADE_BATCH` — atomic cross-surface settlement
  (§5.20). Composes AMM Groth16 verification + orderbook
  per-pair conservation in one envelope; combined chain-aggregate
  Pedersen check enforces cross-surface conservation.

No new HMAC keystream domains. No new cryptographic primitives.

---

## What this amendment explicitly does NOT specify

Out of scope, left for future amendments or operational practice:

- **Settler bundling algorithm.** How a settler decides which
  intents to combine into a T_TRADE_BATCH (matching/routing logic,
  fee optimization, MEV mitigation strategies). Implementation
  choice; not normative.
- **Mixer integration (`T_DEPOSIT` inside T_TRADE_BATCH).** Atomic
  settle-and-mix is the third high-value use case but composing
  the mixer's Groth16 circuit alongside the AMM circuit in one
  envelope needs careful design. Punted to a follow-up amendment
  if real demand emerges.
- **Cross-pool AMM batches in one T_TRADE_BATCH.** Currently each
  AMM sub-batch settles against one pool. Multi-pool AMM
  composition (e.g., 3 hops through 3 different pools atomically)
  would require either multiple AMM Groth16 proofs in one envelope
  or a new multi-pool circuit. Out of scope; punt to v1.x if
  routing UX demands it.
- **Maximum n_orderbook_pairs.** Spec sets 16 as the upper bound
  to mirror N_MAX. Could be raised if orderbook-heavy batches
  become common. Tunable via amendment.

---

## Open questions for round-2 review

1. **Pair-count maximum.** 16 orderbook pairs per T_TRADE_BATCH
   matches the AMM N_MAX. Should it be higher (since orderbook
   pairs don't go through the Groth16 circuit and have lower
   per-pair overhead)? Empirical signet measurement.

2. **Settler tip aggregation.** Currently each surface has its
   own tip mechanism (AMM aggregates per-asset; orderbook is
   per-pair). Should T_TRADE_BATCH expose one unified tip output
   per asset spanning both? Cleaner UX; minor wire-format
   adjustment.

3. **R_net per asset.** The combined aggregate publishes one
   R_net per touched asset_id. For batches touching many assets,
   this grows. Cap on n_assets_touched (currently 16)? Or scale
   freely?

4. **Mixed-direction AMM intents.** A T_TRADE_BATCH includes both
   A→B and B→A AMM intents on the same pool. T_SWAP_BATCH
   handles this via direction signs in the Groth16 public-input
   vector. Verify the same handling works when embedded in
   T_TRADE_BATCH — should "just work" but worth explicit testing.

---

## Implementation status (deferred)

**This amendment ships the spec, not the reference
implementation.** The wire format + validator algorithm + combined
aggregate check math are pinned in V1 so:

- Future indexer implementers have a fixed specification to build
  against.
- The opcode space (`0x39`) is reserved.
- The architectural commitment to cross-surface atomicity is
  on-record from V1.

The reference implementation effort estimate:
- Indexer dispatch + validator: ~1 week
- Worker assembly logic: ~1 week
- Dapp routing across both surfaces in one T_TRADE_BATCH: ~1
  week
- Signet rehearsal (8 test items above): ~few days
- Cross-impl parity tests: ~few days

**Total: ~3-4 weeks** of focused work. Land when cross-surface
demand justifies the effort — likely after a quarter of
operational orderbook + AMM traffic gives signal on whether
sophisticated traders are routing across surfaces (and want
atomicity) vs sticking to one surface.

The deferred implementation does NOT affect V1 launch. Orderbook
+ AMM each ship via their standalone settlement primitives;
cross-surface routing happens at the dapp layer with block-level
soft-atomicity (per `../design/CHANNEL-UX-DESIGN.md`). When T_TRADE_BATCH
reference impl lands, it slots in as an additional dispatch
branch without requiring any change to existing settlement.

---

## Integration checklist for landing in `SPEC.md` (when implementation arrives)

- [ ] §5.20 `T_TRADE_BATCH` added after §5.19 T_WRAPPER_ATTEST.
- [ ] §3 opcode table adds `0x39 T_TRADE_BATCH`.
- [ ] §3 BIP-340 domain-tag table adds `tacit-trade-batch-v1`.
- [ ] §5.5 validator dispatch extended with T_TRADE_BATCH branch.
- [ ] §11 indexer determinism rules extended with combined
      chain-side aggregate check + cross-surface ordering rule.
- [ ] Reference dapp `tacit.js` implements:
      - `kind: 'trade-batch'` candidate path in `planBuy` /
        `planBuyExactOut` for cross-surface routing
      - T_TRADE_BATCH envelope builder for AMM + orderbook
        composition
      - Status surfacing in trader UX (cross-surface settlement
        breakdown)
- [ ] Reference worker:
      - T_TRADE_BATCH indexer dispatch
      - Combined chain-aggregate Pedersen check implementation
      - Settler assembly orchestration (collect AMM openings +
        orderbook intents, compose envelope, sign, broadcast)
- [ ] Cross-impl test vectors: 5 canonical envelopes shared
      between dapp and worker.
- [ ] Signet rehearsal: items 1-14 from the test plan, all
      green.

---

## Sign-off checklist

**Spec (V1):**
- [ ] Round-1 peer review of wire format + validator algorithm
- [ ] Round-2 peer review (especially the combined chain-aggregate
      check math)
- [ ] Crypto review of the combined aggregate check (the one
      precision-critical piece)
- [ ] Merge spec into SPEC.md as §5.20

**Implementation (deferred):**
- [ ] Reference dapp implementation
- [ ] Reference worker / indexer implementation
- [ ] Signet e2e validation
- [ ] Cross-impl parity tests
- [ ] Production deployment
