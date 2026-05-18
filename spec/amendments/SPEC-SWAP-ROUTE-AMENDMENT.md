# SPEC Amendment — Atomic Multi-Hop AMM Routing (`T_SWAP_ROUTE`)

> Status: ✅ Reference impl shipped (`tests/swap-route.mjs`,
> `tests/swap-route.test.mjs` 24/24 passing). SPEC.md merge pending.
> Pre-ceremony viable: reuses the bulletproof rangeproof + kernel-sig
> stack from `T_SWAP_VAR` (SPEC.md §5.20); introduces no new Groth16
> circuit and no new ceremony coupling.
>
> Adds opcode `T_SWAP_ROUTE` (`0x33`) — atomically settles a
> single-trader N-hop swap that traverses up to `N_HOPS_MAX = 4`
> AMM pools in one Bitcoin transaction. Hop *k*'s output amount
> feeds hop *k+1*'s input amount as a cleartext public delta;
> the trader's Pedersen-committed input UTXO and fresh Pedersen-
> committed receipt UTXO are bound under a single kernel sig that
> closes the route. Uniswap-V2-router parity at the cost of one
> new opcode and one new BIP-340 domain tag.
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

Reference impl: `tests/swap-route.mjs` (`encodeSwapRoute`,
`decodeSwapRoute`). Byte layout (from the impl, normative):

```
version(1)             = 0x01
opcode(1)              = 0x33
n_hops(1)              u8, 2..N_HOPS_MAX (= 4)
trader_input_asset_id (32)
trader_output_asset_id(32)
min_out(8)             u64 LE — slippage gate on the FINAL hop's
                       output (Uni-V2 router semantics: per-hop
                       slippage is NOT enforced; intermediate hops
                       may absorb worse-than-spot pricing as long
                       as the final delivery clears min_out)
expiry_height(4)       u32 LE — refuse if currentHeight > expiry;
                       0 = no expiry
trader_pubkey(33)      compressed secp256k1 — verifies intent_sig

# Per-hop block × N (67 bytes each)
[for hop k ∈ {0, …, n_hops-1}]:
    pool_id(32)
    direction(1)               0 = pool's asset_A is input side,
                               1 = pool's asset_B is input side
    fee_bps(2)                 u16 LE — pool's fee_bps at settle
                               (validator cross-checks vs pool.fee_bps)
    R_A_pre(8)                 u64 LE — pool reserve A pre-hop
    R_B_pre(8)                 u64 LE — pool reserve B pre-hop
    delta_a_net_mag(8)         u64 LE — magnitude of pool's net A
                               change for this hop
    delta_b_net_mag(8)         u64 LE — same for asset B

# Trader chain bindings
trader_input_outpoint:
    txid(32 BE) || vout(4 LE)  — the trader's tacit input UTXO
C_in_secp(33)                  Pedersen commit at that outpoint
C_receipt_secp(33)             fresh receipt commit (trader output)
r_receipt(32)                  receipt blinding (revealed so the
                               recipient can spend the receipt
                               UTXO; mirrors T_SWAP_VAR §5.20)

# Closures
range_proof_len(2)             u16 LE
range_proof(variable)          aggregated BP+ m=2 over
                               (SENTINEL=infinity, C_receipt_secp).
                               Wire-format parity with T_AXFER_VAR /
                               T_SWAP_VAR keeps the verifier hot
                               path identical across opcodes.
kernel_sig(64)                 BIP-340 over kernel_msg
intent_sig(64)                 BIP-340 over route_msg under
                               trader_pubkey
```

**Approximate wire size at N_HOPS_MAX = 4:**
- Per-hop block × 4: 4 × 67 = 268 B
- Trader I/O + outpoint + receipt fields: 36 + 33 + 33 + 32 = 134 B
- Closures (opcode + version + n_hops + asset IO + min_out + expiry
  + trader_pubkey + sigs + length prefix): ~248 B
- BP+ aggregated rangeproof (m=2 over u64): ~657 B
- **Total ≈ 1.3 KB at N=4.** Well under Taproot tap-leaf limits.

Note vs the initial draft (round-0): bridge Pedersen commitments
between hops were dropped — intermediate amounts are public
cleartext per-hop deltas, so a hop boundary needs no Pedersen
encoding beyond the indexer's continuity check
`hop_k.delta_out == hop_{k+1}.delta_in`. Privacy posture is
unchanged from N sequential `T_SWAP_VAR` calls (per-hop deltas
were always public there too); the simpler design saves ~700 B
per envelope at N=4.

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
    || hop_block_concat              # all per-hop blocks back-to-back
    || C_in_secp(33)
    || C_receipt_secp(33)
)

intent_sig = BIP-340(trader_pubkey, route_msg)
```

The trader signs ONCE over the entire route. Indexers verify
`intent_sig` under `trader_pubkey` before any state work.

### Kernel message + signature

The kernel sig closes the trader's net asset flow across the
whole route: the trader pays `delta_in_0` of `trader_input_asset_id`
(hop 0's input side) and receives `delta_out_last` of
`trader_output_asset_id` (hop n_hops-1's output side). Both
deltas are public; intermediate hop deltas balance internally
via the per-hop CFMM check.

```
hops_hash = SHA256(hop_block_0 || hop_block_1 || …)

kernel_msg = SHA256(
    "tacit-kernel-v1"               # reused from CXFER + T_SWAP_VAR
    || trader_input_asset_id(32)
    || trader_output_asset_id(32)
    || asset_input_count_LE(1) = 0x01
    || trader_input_outpoint        # txid_BE(32) || vout_LE(4)
    || C_receipt_secp(33)
    || delta_in_0_LE(8)             # trader's input amount = hop[0]'s
                                    # input-side delta
    || delta_out_last_LE(8)         # trader's output amount =
                                    # hop[n_hops-1]'s output-side delta
    || hops_hash(32)                # binds the exact hop sequence;
                                    # closes the "settler swaps hops
                                    # under same kernel sig" attack
)
```

The kernel-sig verification point is:

```
P = C_receipt_secp − C_in_secp − (delta_out_last − delta_in_0) · H_secp
```

signed by `excess_route = r_receipt − r_in` (modular subtraction in
the secp256k1 scalar field). `(delta_out_last − delta_in_0)` is
encoded mod `SECP_N`; when the route round-trips back to the input
asset at exactly the same value (arbitrage break-even), the H term
collapses to ZERO and the sig closes a pure (r_receipt − r_in)·G
balance.

The two-asset closure (input asset → output asset) is the only
structural difference from `T_SWAP_VAR`'s single-asset closure;
the per-hop CFMM math handles the asset transitions internally.

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

Indexers MUST reject any T_SWAP_ROUTE whose Bitcoin tx layout
deviates from the schema above.

### Validator algorithm

```
on T_SWAP_ROUTE envelope at confirmation depth ≥ FINALITY_DEPTH:

    require envelope.opcode == 0x33
    decode payload; reject on structural error (incl. degenerate
        trader_input_asset_id == trader_output_asset_id)
    require 2 <= n_hops <= N_HOPS_MAX (4)
    if expiry_height != 0:
        require currentHeight <= expiry_height

    verify intent_sig under trader_pubkey over route_msg
    snapshot each touched pool's reserves (so a route that re-visits
        the same pool advances state correctly hop-by-hop)

    # ----- Per-hop iteration -----
    let hop_input_asset = trader_input_asset_id
    let prev_delta_out  = null
    let delta_in_0, delta_out_last

    for hop k ∈ {0, …, n_hops-1}:
        let H = hop[k]
        let snap = poolSnapshot[H.pool_id]
        require snap exists AND snap.tradable == true
        require H.fee_bps == snap.fee_bps
        require H.R_A_pre == snap.reserve_A
        require H.R_B_pre == snap.reserve_B

        # direction → input/output asset + amounts
        let (asset_in, asset_out, R_in, R_out, delta_in, delta_out) =
            H.direction == 0
                ? (snap.asset_A, snap.asset_B, snap.reserve_A, snap.reserve_B,
                   H.delta_a_net_mag, H.delta_b_net_mag)
                : (snap.asset_B, snap.asset_A, snap.reserve_B, snap.reserve_A,
                   H.delta_b_net_mag, H.delta_a_net_mag)
        require delta_in > 0 AND delta_out > 0

        # Asset continuity
        require asset_in == hop_input_asset
        # Amount continuity (for k ≥ 1)
        if k > 0: require delta_in == prev_delta_out

        # Reserve-bound guards (u64 overflow / drain)
        require R_in + delta_in ≤ U64_MAX
        require R_out ≥ delta_out

        # CFMM curve floor identity (with-fee, integer upper bound).
        # Per-trader floor dust can only push the actual delta_out
        # DOWN from the curve; settler attempts to claim a higher
        # delta_out break this identity.
        let gNum = 10000 - snap.fee_bps
        let gDen = 10000
        require delta_out * (R_in * gDen + gNum * delta_in)
              <= R_out * gNum * delta_in

        # Advance snapshot for the next hop's freshness check.
        snap.reserve_in  += delta_in
        snap.reserve_out -= delta_out

        if k == 0: delta_in_0 = delta_in
        delta_out_last  = delta_out
        prev_delta_out  = delta_out
        hop_input_asset = asset_out

    # ----- Final consistency -----
    require hop_input_asset == trader_output_asset_id

    # ----- Min-out gate (terminal-only; Uni-V2 router parity) -----
    require delta_out_last >= min_out

    # ----- Receipt opening -----
    require r_receipt != 0
    require pedersenCommit(delta_out_last, r_receipt) == C_receipt_secp

    # ----- Kernel sig -----
    let P = C_receipt_secp − C_in_secp − (delta_out_last − delta_in_0)·H_secp
    require P != ZERO            # would accept any sig
    require BIP-340 verify(kernel_sig, kernel_msg, P.x_only)

    # ----- Bulletproof m=2 over (SENTINEL, C_receipt_secp) -----
    # Slot 0 is the additive identity (ZERO). Wire-format parity
    # with T_AXFER_VAR / T_SWAP_VAR keeps the verifier hot path
    # identical across opcodes.
    require bulletproofVerify([ZERO, C_receipt_secp], range_proof)

    # ----- Final consistency -----
    require chain_pre_commit == C_out_secp
    require hop_input_asset  == trader_output_asset_id

    # ----- Min-out gate -----
    # ----- All checks pass: apply state transitions atomically -----
    for each touched pool_id:
        commit poolSnapshot[pool_id] to canonical pool state
    consume trader_input UTXO at vin[1]
    credit trader_output UTXO at vout[1]
```

If ANY hop fails the freshness check, fee_bps mismatch, asset/amount
chain check, reserve-bound guard, CFMM curve floor, kernel sig,
intent sig, receipt opening, or bulletproof verification, the entire
envelope is rejected. The Bitcoin tx still confirms (Bitcoin doesn't
care about indexer semantics) but the indexer doesn't update state —
no pool advances, no UTXO credit. Atomic at the indexer-state-
transition layer (mirrors T_SWAP_BATCH / T_TRADE_BATCH posture).

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
- The trader's input blinding (Pedersen-committed on the input
  UTXO; only the trader knows the blinding scalar)

The receipt's blinding `r_receipt` is REVEALED on chain (mirrors
T_SWAP_VAR §5.20 self-fulfill semantics) so the trader can later
spend their receipt UTXO without an extra ECDH key-derivation
step. For a settler-driven follow-up, the receipt blinding can
be ECDH-derived from a trader↔settler shared secret and dropped
from the envelope — out of scope here.

The per-hop deltas are cleartext, identical to what *N sequential
T_SWAP_VAR envelopes* would reveal. The route's privacy posture
is **exactly equivalent** to the sequential path (no privacy
regression); atomicity is the upgrade.

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
delta_in or delta_out of that hop). Adding tips changes the
wire-format closure block AND the kernel-msg preimage, so the
follow-up amendment graduates to a new envelope version
(`version = 0x02`) and rolls a fresh validator branch; the V1
opcode `0x33` envelopes remain unchanged at validator level.

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
