# SPEC Amendment — Atomic Multi-Hop AMM Routing (`T_SWAP_ROUTE`)

> Status: 📝 Draft (round-1) — **wire format + validator algorithm**
> **sketched**; reference implementation deferred until routing
> UX demand justifies the engineering work. Pre-ceremony viable:
> reuses the bulletproof rangeproof + sigma + kernel-sig stack
> from `T_SWAP_VAR` (SPEC.md §5.20), introduces no new Groth16
> circuit and no new ceremony coupling.
>
> Adds opcode `T_SWAP_ROUTE` (`0x33`) — atomically settles a
> single-trader N-hop swap that traverses up to `N_HOPS_MAX`
> distinct AMM pools in one Bitcoin transaction. The chain
> output of hop *i* feeds the chain input of hop *i+1* via a
> shared per-hop Pedersen commitment; final receipt is the
> trader's output UTXO. Uniswap-V2-router parity (without the
> smart-contract footprint) at the cost of one new opcode and
> one new BIP-340 domain tag.
>
> Distinct from `T_TRADE_BATCH` (`0x39` — drafted): that opcode
> composes AMM ↔ orderbook for cross-surface atomicity; this
> one composes AMM ↔ AMM for multi-pool routing within the AMM
> surface. They are orthogonal and ship-independent.

---

## Motivation

`T_SWAP_VAR` (§5.20) settles a single trader's swap against a
single pool atomically; `T_SWAP_BATCH` (§5.16) settles N traders
against a single pool atomically. Neither composes pools.

A trader who wants A → B → C today has two choices:

1. **Two sequential `T_SWAP_VAR` envelopes.** Hop 1 (A → B) lands
   in one Bitcoin tx; hop 2 (B → C) lands in a second. Between
   confirmations, the trader is exposed to price risk on B, and
   the routing logic must hold an intermediate B-asset UTXO.
   Two commit/reveal pairs ≈ 2× Bitcoin fees.
2. **Wait for a maker to publish a bilateral (A, C) intent on the
   orderbook.** Only works if such an intent exists at acceptable
   price. Not a general router.

The Uniswap V2 router solves this on Ethereum via a smart
contract that wraps N pool calls in one transaction. Tacit's
analog: one envelope that the indexer parses as N atomic
hop steps, each applying its own CFMM math against its own
pool's reserves, with hop *i*'s output Pedersen commitment
reused as hop *i+1*'s input.

The architectural insight: **the existing `T_SWAP_VAR` validator
algorithm is already a single-hop step**. A multi-hop envelope
is just N of those steps chained by Pedersen commitment
identity, with one global trader input + one global trader
output. No new cryptography is needed — only an envelope
framing that lets one Bitcoin tx atomically apply N pool
state transitions.

---

## §5.21 `T_SWAP_ROUTE` (`0x33`) — atomic multi-hop AMM swap

(SPEC.md section number tentative; lands after the most recent
SPEC.md-merged §5.20 entry.)

### Wire format

```
opcode(1)              = 0x33
n_hops(1)              u8, 2..N_HOPS_MAX (default N_HOPS_MAX = 4)
trader_input_asset_id  (32)   first hop's input asset
trader_output_asset_id (32)   last hop's output asset
min_out(8)             u64 LE — slippage gate on the final hop's
                       output (Uni-V2 router semantics: per-hop
                       slippage is NOT enforced; intermediate
                       hops may absorb worse-than-spot pricing
                       as long as the final delivery clears
                       min_out)
expiry_height(4)       u32 LE — refuse if currentHeight > expiry
intent_sig(64)         BIP-340 over route_msg (see below)

# ----- Per-hop block, N copies ordered hop_index ascending -----
[for hop k ∈ {0, …, n_hops-1}]:
    pool_id(32)
    direction(1)               0 = pool's asset_A is input side,
                               1 = pool's asset_B is input side
    fee_bps(2)                 u16 LE — pool's fee_bps at settle
                               (validator cross-checks vs pool.fee_bps)
    R_A_pre(8)                 u64 LE — pool reserve A pre-hop
    R_B_pre(8)                 u64 LE — pool reserve B pre-hop
    delta_a_net_mag(8)         u64 LE — magnitude of pool's net A
                               change for this hop (sign derived
                               from direction)
    delta_b_net_mag(8)         u64 LE — same for asset B

# ----- Trader input commitment (consumed by hop 0) -----
C_in_secp(33)                  trader's input UTXO Pedersen commit
C_in_BJJ(32)                   same hidden amount on BabyJubJub
input_sigma(169)               secp ↔ BJJ binding (§3.10)

# ----- Trader output commitment (produced by hop n_hops-1) -----
C_out_secp(33)                 trader's final receipt commit
C_out_BJJ(32)                  same on BabyJubJub
output_sigma(169)              secp ↔ BJJ binding

# ----- Per-hop bridge commitments, N-1 copies -----
# (Hop k's output is hop k+1's input; one Pedersen pair per
# intermediate boundary, ordered k ascending.)
[for boundary k ∈ {0, …, n_hops-2}]:
    C_bridge_secp(33)          shared output_k = input_{k+1}
    C_bridge_BJJ(32)           same on BJJ
    bridge_sigma(169)          secp ↔ BJJ binding

# ----- Closure -----
kernel_sig(64)                 Mimblewimble balance over the
                               whole route (see kernel_msg below)
bulletproof(variable)          aggregated u64 range proof over
                               (C_in_secp, C_bridge_secp_0,
                                C_bridge_secp_1, …, C_out_secp);
                               m = next_pow_of_2(n_hops + 1) in
                               BP+ aggregation slots
```

**Approximate wire size at N_HOPS_MAX = 4:**
- Per-hop block × 4: 4 × (32+1+2+8+8+8+8) = 268 B
- Trader IO commits + sigmas: 2 × (33 + 32 + 169) = 468 B
- Bridge commits × 3: 3 × (33 + 32 + 169) = 702 B
- Closures (intent_sig + kernel_sig + min_out + expiry + asset_ids
  + opcode/n_hops): ~210 B
- BP+ aggregated rangeproof (m=8): ~789 B
- **Total ≈ 2.4 KB at N=4.** Well under Taproot tap-leaf limits.

### Intent message + signature

```
route_msg = SHA256(
    "tacit-swap-route-v1"
    || trader_pubkey(33)
    || trader_input_asset_id(32)
    || trader_output_asset_id(32)
    || min_out_LE(8)
    || expiry_height_LE(4)
    || n_hops_LE(1)
    || hop_block_concat            # all per-hop blocks back-to-back
    || C_in_secp(33)
    || C_out_secp(33)
)

intent_sig = BIP-340(trader_pubkey, route_msg)
```

The trader signs ONCE over the entire route. Indexers verify
`intent_sig` under `trader_pubkey` before any state work.

### Kernel message + signature

```
kernel_msg = SHA256(
    "tacit-kernel-v1"               # reused from CXFER + T_SWAP_VAR
    || trader_input_asset_id(32)
    || asset_input_count_LE(1) = 0x01    # exactly one trader input
    || trader_input_outpoint        # txid_BE(32) || vout_LE(4)
    || C_out_secp(33)               # trader's final receipt
    || burned_amount_LE(8) = 0      # routes never burn (refer
                                    #  hops produce exact bridges)
)
```

Kernel sig closes under
`(C_out_secp − C_in_secp).x_only`
with `excess_route = r_out_secp − r_in_secp`. The bridge
commitments are *internal* — they cancel pairwise across hops
(hop *k* emits `C_bridge_k_secp`, hop *k+1* consumes it; their
sum drops out of the chain-side aggregate identity). The
kernel sig therefore only needs to close the trader's net
input → output flow.

### Bitcoin tx layout (normative)

```
vin[0]                  Envelope-bearing input (Taproot script-
                        path); witness carries the T_SWAP_ROUTE
                        payload.
vin[1]                  Trader's tacit asset input UTXO (signed
                        SIGHASH_ALL over envelope_hash).

# Outputs
vout[0]                 OP_RETURN(envelope_hash) — 0 sat, 32-byte
                        data, envelope_hash = SHA256(payload).
vout[1]                 Trader's final receipt UTXO (DUST sats,
                        scriptPubKey = trader's receive script).
vout[2 .. ]             Optional settler-fee outputs (see "Tip
                        mechanics" below) and settler change.
```

The bridge commitments (`C_bridge_secp_k`) live ONLY inside
the envelope — they are NOT chain outputs. Each is the
indexer-visible Pedersen commit that closes hop *k*'s output
and opens hop *k+1*'s input within the per-hop CFMM math. They
never appear as UTXOs.

Indexers MUST reject any T_SWAP_ROUTE whose Bitcoin tx layout
deviates from the schema above.

### Validator algorithm

```
on T_SWAP_ROUTE envelope at confirmation depth ≥ FINALITY_DEPTH:

    require envelope.opcode == 0x33
    decode payload; reject on structural error
    require 2 <= n_hops <= N_HOPS_MAX (4)
    require currentHeight <= expiry_height
    require trader_input_asset_id ≠ trader_output_asset_id

    verify intent_sig under trader_pubkey over route_msg
    verify aggregated BP+ rangeproof over all (n_hops + 1) Pedersen
        commits — bounds each hidden amount to u64
    verify input_sigma, output_sigma, and all bridge_sigma
        cross-curve bindings (§3.10)
    verify kernel_sig closes the route (excess_route = r_out − r_in)

    # ----- Per-hop iteration -----
    let chain_pre_commit = C_in_secp
    let hop_input_asset  = trader_input_asset_id
    for hop k ∈ {0, …, n_hops-1}:
        let H = hop[k]
        # (1) pool lookup + state freshness
        let pool = lookupPool(H.pool_id)
        require pool exists AND pool.tradable == true
        require H.fee_bps == pool.fee_bps
        require H.R_A_pre == pool.reserve_A
        require H.R_B_pre == pool.reserve_B
        # (2) direction → input/output asset
        let (asset_in, asset_out, R_in, R_out, delta_in, delta_out) =
            H.direction == 0
                ? (pool.asset_A, pool.asset_B, H.R_A_pre, H.R_B_pre,
                   H.delta_a_net_mag, H.delta_b_net_mag)
                : (pool.asset_B, pool.asset_A, H.R_B_pre, H.R_A_pre,
                   H.delta_b_net_mag, H.delta_a_net_mag)
        require asset_in == hop_input_asset
        # (3) CFMM curve floor identity (with-fee, integer)
        let gNum = 10000 - pool.fee_bps
        let gDen = 10000
        require delta_out * (R_in * gDen + gNum * delta_in)
              <= R_out * gNum * delta_in
        # (4) chain-side commit identity: input_commit − delta_in·H_secp
        #     == output_commit − delta_out·H_secp + (r_in − r_out)·G_secp
        let next_commit = (k == n_hops - 1) ? C_out_secp : C_bridge_secp[k]
        # Per-hop Pedersen identity (closes asset-side balance for this hop):
        require chain_pre_commit − delta_in · H_secp
              == next_commit − delta_out · H_secp
                 + r_hop_excess[k] · G_secp
        # (r_hop_excess[k] is a per-hop excess scalar revealed in the
        #  envelope alongside the hop block; sum of per-hop excesses
        #  matches kernel_sig's excess_route by construction.)
        # (5) advance for next iteration
        chain_pre_commit = next_commit
        hop_input_asset  = asset_out

    # ----- Final consistency -----
    require chain_pre_commit == C_out_secp
    require hop_input_asset  == trader_output_asset_id

    # ----- Min-out gate -----
    let final_delta_out = hop[n_hops-1].direction == 0
        ? hop[n_hops-1].delta_b_net_mag
        : hop[n_hops-1].delta_a_net_mag
    require final_delta_out >= min_out

    # ----- All checks pass: apply state transitions atomically -----
    for hop k ∈ {0, …, n_hops-1}:
        advance pool[k].reserve_in  += delta_in
        advance pool[k].reserve_out -= delta_out
    consume trader_input UTXO at vin[1]
    credit trader_output UTXO at vout[1]
```

If ANY hop fails the curve-floor identity, pool lookup, fresh-
reserves check, or chain-side commit identity, the entire
envelope is rejected. The Bitcoin tx still confirms (Bitcoin
doesn't care about indexer semantics) but the indexer doesn't
update state — no pool advances, no UTXO credit. Atomic at the
indexer-state-transition layer (mirrors T_SWAP_BATCH /
T_TRADE_BATCH posture).

### Within-block ordering rule

If the same pool is touched by multiple T_SWAP_ROUTE / T_SWAP_VAR
/ T_SWAP_BATCH envelopes in the same block, AMM.md §"Indexer
determinism rules" applies: `(tx_index, vin[0] outpoint)`
ascending. Earlier-in-block routes apply their state transitions
first; later routes see the updated reserves.

### Reorg safety

Same posture as T_SWAP_VAR / T_SWAP_BATCH. Pool state advances
at depth ≥ 3; intermediate observers MAY display "settling
(provisional)" status at depths 1–2.

---

## Privacy model

A T_SWAP_ROUTE envelope exposes:
- The full route: every (pool_id, direction, R_A_pre, R_B_pre,
  delta_a_net_mag, delta_b_net_mag) per hop
- The trader's input + output asset_ids
- min_out, expiry_height

It hides:
- The trader's identity (binds to a fresh trader_pubkey per
  intent; not necessarily a wallet's long-term key)
- The trader's input + output blindings (Pedersen-committed)
- The intermediate amounts at each bridge boundary (Pedersen-
  committed; range-proof-bounded but not opened)

The per-hop deltas are cleartext, identical to what *N
sequential T_SWAP_VAR envelopes* would reveal. The amendment
trades amount-confidentiality at intermediate boundaries
(which the trader doesn't have anyway under T_SWAP_VAR) for
atomicity. **No privacy regression vs the status-quo path.**

Confidentiality follow-ups (mixing route output into the
mixer's anonymity set, or batching multiple traders' routes
under a uniform-clearing variant) are out of scope here and
would be follow-up amendments composing T_SWAP_ROUTE with
existing primitives.

---

## Tip mechanics (settler-free V1; settler-driven follow-up)

V1 ships **self-fulfill only**: the trader broadcasts their
own T_SWAP_ROUTE envelope; no settler tips. The trader pays
the Bitcoin tx fee directly.

A follow-up amendment can add settler-driven routing where
the trader signs an *intent* (off-chain), a settler assembles
the envelope and broadcasts, and the trader pays the settler
a tip per hop. The tip mechanic would mirror T_SWAP_VAR's
single-hop tip (a per-hop output spending a fraction of the
delta_in or delta_out of that hop). The wire format reserves
space for a `tip_count` byte at the end of the closure block
for forward-compatibility; V1 envelopes MUST emit `tip_count = 0`.

---

## Backwards compatibility

T_SWAP_ROUTE is **purely additive**. It introduces opcode `0x33`
that pre-amendment indexers see as unknown and ignore (per
SPEC.md §5.5 unknown-opcode forward-compat rule). Existing
T_SWAP_VAR and T_SWAP_BATCH paths are unchanged.

This amendment does NOT modify:
- AMM Groth16 circuits (`amm_lp_add`, `amm_lp_remove`,
  `amm_swap_batch`) — no ceremony coupling whatsoever
- T_SWAP_VAR, T_SWAP_BATCH wire formats or validators
- T_TRADE_BATCH wire format or validator (`0x39` — cross-
  surface atomic settler; orthogonal axis)
- Pool state, LP-share semantics, protocol-fee accrual
- Any existing BIP-340 domain tag (kernel sig reuses
  `tacit-kernel-v1`; sigma generators reuse `tacit-generator-H-v1`
  / `tacit-bp-G-v1` / `tacit-bp-H-v1` / `tacit-bp-Q-v1`)

It DOES add:
- One new opcode (`0x33`)
- One new BIP-340 domain tag (`tacit-swap-route-v1`) for the
  outer route_msg
- A new indexer validator dispatch branch with the per-hop
  chain-side commit identity check
- Dapp / settler tooling to assemble T_SWAP_ROUTE envelopes
  (routing logic — which pools to chain, in what order)

---

## Open knobs for round-2 review

1. **`N_HOPS_MAX` cap.** 4 (typical DEX path length) or 8 (more
   routing flexibility, +1.2 KB envelope). Empirical signet
   measurement once a router emerges; pinned in this round to
   `N_HOPS_MAX = 4` as the conservative default.
2. **Per-hop min_out vs terminal-only.** Spec sets terminal-only
   (Uni-V2 router parity). A paranoid trader can encode
   per-hop floors implicitly by ensuring the route's pricing
   leaves them whole at each step, but the indexer doesn't
   enforce intermediate floors. Could be raised to per-hop if
   trader UX demands.
3. **Distinct pools per hop?** Currently allows the same
   `pool_id` to appear multiple times (e.g., A → B then B → A
   in the same pool to harvest a fee tier difference). Indexer
   applies hops in declared order; no semantic prohibition.
   Could be tightened to "distinct pool_ids" if cycle attacks
   surface.
4. **Bridge commitment range proof scope.** Currently the BP+
   aggregates all (n_hops + 1) commitments. Could trim to just
   `(C_in_secp, C_out_secp)` (the trader-relevant commits) if
   the bridge values are deemed "internal" enough not to need
   their own range bound — but then a malicious trader could
   set a bridge amount > 2^64 and trigger an underflow in the
   next-hop CFMM check. Keep the aggregated form.
5. **Settler-driven routing.** V1 ships self-fulfill only.
   Settler tips per hop add ~80 B per hop and need a per-hop
   tip-Pedersen identity check. Punted to a follow-up amendment.

---

## Test plan (informative — non-normative)

End-to-end signet rehearsal once a reference impl lands:

1. **2-hop A → B → C, distinct pools.** Verify atomic execution;
   verify intermediate B-commit never appears as a chain UTXO;
   verify final delta_out >= min_out gate.
2. **4-hop A → B → C → D → E.** Verify N_HOPS_MAX upper bound;
   measure end-to-end envelope size; confirm BP+ verify time is
   acceptable browser-side.
3. **Cycle hop A → B → A (same pool).** Verify the indexer
   applies the second hop against the first's *post-state*
   reserves (the pool's reserves shifted after hop 0).
4. **Hop with stale reserves.** Trader assembles a route with
   `R_A_pre` matching block N; another T_SWAP_VAR confirms in
   block N+1 that shifts the pool's reserves. T_SWAP_ROUTE in
   block N+2 should reject (R_A_pre mismatch).
5. **min_out violation.** Set min_out higher than the route can
   deliver; verify rejection.
6. **Tampered hop block.** Flip one byte in hop[1]'s pool_id;
   verify intent_sig fails.
7. **Partial-hop failure.** Hop[2] violates curve-floor identity
   (over-claimed delta_out). Verify entire envelope rejected;
   verify hop[0] and hop[1]'s state transitions DO NOT apply.
8. **Disjoint-trader assemble + broadcast.** Verify Bitcoin-tx
   replay protection (rebroadcast same envelope → Bitcoin
   rejects due to consumed input UTXO).

Cross-impl parity:

9. Dapp builds T_SWAP_ROUTE; worker validates.
10. Worker assembles; dapp validates.

---

## Composition with other amendments

- **`T_TRADE_BATCH` (`0x39`, drafted).** Orthogonal. A T_TRADE_BATCH
  could optionally embed N T_SWAP_ROUTE sub-envelopes in its
  AMM sub-batch slot — but that requires extending T_TRADE_BATCH's
  AMM sub-batch from "one AMM op per envelope" to "any AMM
  envelope variant per slot". Defer until both ref impls exist.
- **`T_INTENT_ATTEST` (`0x30`, shipped).** A trader's
  T_SWAP_ROUTE intent (the `intent_sig`-bearing portion of the
  envelope) MAY be submitted to a worker's intent-pool channel
  prior to broadcast for preconfirmation surfacing. The settler-
  driven follow-up amendment formalizes this.
- **Mixer integration.** Atomic route + deposit (`T_DEPOSIT`)
  in one tx would compose naturally if the mixer's Groth16
  circuit doesn't need to be invoked alongside the route's BP+
  proof. Sketched as a follow-up; not in scope here.

---

## What this amendment explicitly does NOT specify

Out of scope, left for future amendments or operational practice:

- **Router strategy.** How the dapp selects which pools to chain
  (path-finding, fee minimization, slippage estimation,
  Dijkstra-style routing). Implementation choice; not normative.
- **Settler-driven routing.** Per-hop tips, intent-pool channel
  hooks for routing intents, paid-settler economics. Follow-up.
- **Multi-trader routing.** Batched routes where N traders share
  a route bundle (Uniswap's `swapExactTokensForTokens` is single-
  trader). Multi-trader route batching is in the same conceptual
  space as T_SWAP_BATCH but for routes; not specified here.
- **Cross-surface routes.** A → B via AMM, B → C via orderbook
  in one tx. That's `T_TRADE_BATCH`'s job, not this amendment's.

---

## Domain-tag additions

Add to SPEC.md §3 *BIP-340 domain tags*:
- `tacit-swap-route-v1` — outer route_msg domain. Binds the
  full multi-hop intent (per-hop blocks + asset IO + min_out +
  expiry) under the trader's pubkey.

Add to SPEC.md §3 *opcodes table*:
- `0x33` `T_SWAP_ROUTE` — atomic multi-hop AMM routing
  (§5.21). Composes existing T_SWAP_VAR per-hop primitives
  (kernel sig + BP+ rangeproof + sigma) under one envelope.
  Indexer applies hops in declared order; atomic at the
  indexer-state-transition layer.

No new HMAC keystream domains. No new cryptographic primitives.

---

## What's in the amendment file vs SPEC.md

This file carries the **draft** wire format + validator algorithm
+ soundness sketch. A reference implementation (dapp builder +
worker decoder + worker validator branch + signet harness)
lands as a follow-up commit pair when routing demand justifies
it. After ref impl + signet bake + cross-impl parity, the
amendment graduates from `📝 Draft` to `✅ Shipped` and the wire
format + validator algorithm sections merge into SPEC.md §5.21.
The amendment file then becomes a historical record (kept for
auditability; SPEC.md is authoritative).
