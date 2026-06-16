# tacit AMM — protocol overview and canonical section map

The tacit AMM is a constant-product (`x·y=k`) market maker whose pools
hold confidential balances. Reserves are public (so anyone can quote and
verify clearing), while individual trader and LP amounts are hidden
behind dual-curve Pedersen commitments. Pools live on Bitcoin as a
sequence of envelopes an indexer folds into deterministic pool state;
the same fold reconstructs pool state for the Ethereum bridge.

This document holds the protocol-level model (pool state, accrual,
commitments, forward compatibility) and maps every other normative
section to the file that defines it. **For byte-precise wire layouts and
the pool_id preimage, `spec/amm/wire-formats.md` is authoritative.**

## Pool state

A pool is identified by its `pool_id` and tracked as a reserve record.

`pool_id` is the canonical, un-squattable identifier derived in
`spec/amm/wire-formats.md` §"Pool ID derivation":

```
pool_id = SHA256("tacit-amm-pool-v1" || asset_A_min || asset_B_max
                 || fee_bps_LE || capability_flags
                 [ || protocol_fee_address || protocol_fee_bps_LE ]   # iff fee enabled
                 [ || arbiter_quorum_root ])                          # iff capability_flags & 0x04
```

Two POOL_INITs over the same pair with different `fee_bps`,
`capability_flags`, or protocol-fee config are distinct canonical pools.

The folded reserve record carries:

| field | meaning |
|---|---|
| `asset_a`, `asset_b` | canonical (lex-min, lex-max) asset ids |
| `reserve_a`, `reserve_b` | public reserves; `k = reserve_a · reserve_b` |
| `total_shares` | outstanding LP shares (incl. the MINIMUM_LIQUIDITY lock) |
| `protocol_fee_bps` | creator-set LP-fee skim, 0..1000 bps (0 = disabled) |
| `k_last` | `√k` checkpoint for lazy fee accrual; advanced at LP events only |
| `protocol_fee_accrued` | LP shares owed to the protocol-fee recipient, uncrystallized |
| `backed` | reserve floor used by the bridge's no-inflation accounting |

Indexers fold envelopes into this record deterministically; the set of
all pool records is committed by a registry digest/root so reconstructed
state cannot be forged. The bridge re-runs the identical fold to anchor
Ethereum-side pool state against the proven Bitcoin root.

Pool launch rules: `MINIMUM_LIQUIDITY = 1000` shares are locked to a NUMS
recipient at POOL_INIT (`vout[1]`); variant-0 `LP_ADD` is rejected for
the first `AMM_INITIAL_LP_LOCK_BLOCKS = 6` blocks so a mispriced seed can
be corrected before naive LPs are exposed. See `wire-formats.md` for the
POOL_INIT envelope and the MINIMUM_LIQUIDITY burn-output construction.

## Accrual model (protocol fee mechanism)

Trading fees accrue to LPs implicitly via reserve growth (`k` rises as
fees stay in the pool). On top of that, a pool creator may set a
**protocol fee** — a skim of LP-fee growth, expressed in basis points of
that growth (`protocol_fee_bps`, max 1000 = 10%). It is open to any
creator who launches a pool, not a protocol-governance-only lever; it is
how a creator earns from the pool they bootstrap.

The skim is crystallized lazily, mirroring the established lazy-mintFee
construction: at each liquidity event the protocol fee owed since the
last checkpoint is minted as new LP shares to `protocol_fee_accrued`:

```
new_shares = floor( total_shares · bps · (√k_now − √k_last)
                    / ((10000 − bps) · √k_now + bps · √k_last) )
```

`k_last` advances **only at liquidity events** (POOL_INIT, LP_ADD,
LP_REMOVE), never on swaps — so an LP's own deposit is never taxed as
fee growth. Crystallization happens **before** an LP event's share math,
then `k_last` is reset to the post-event `k`. The accrued shares are
withdrawn by the recipient with `T_PROTOCOL_FEE_CLAIM`, which onboards an
LP-share note of `lp_asset_id(pool_id)` for `protocol_fee_accrued` and
resets the accumulator.

This model is implemented and tested in
`contracts/sp1/confidential/cxfer-core` (`protocol_fee_shares`,
`crystallize_protocol_fee`, `fold_protocol_fee_claim`) and mirrored in
the worker indexer; the `T_PROTOCOL_FEE_CLAIM` envelope is in
`wire-formats.md`.

## Hybrid commitments (secp256k1 + BabyJubJub)

Every confidential amount is committed on **two** curves at once: a
secp256k1 Pedersen commitment (Bitcoin's curve — lets reserve and tip
conservation be checked with the same field Bitcoin signs over) and a
BabyJubJub commitment (efficient inside the Groth16 batch circuit over
the BN254 scalar field). A 169-byte cross-curve sigma (`xcurve_sigma`,
Camenisch–Stadler with a shared amount scalar and a 128-bit Fiat–Shamir
challenge) binds the two so a value cannot differ across curves. The
secp half plus challenge are defined in `cxfer-core`; the BabyJubJub
half is verified in the reflection bin. See `wire-formats.md` §"Groth16
public-input vector" for how receipts enter the batch proof.

## Forward compatibility

`capability_flags` (1 byte in POOL_INIT, always committed to `pool_id`)
is the protocol's hook for opt-in pool behaviors — the closest analogue
to pluggable hooks, but as protocol-defined feature bits, not executable
code. Assigned bits: `0x01` (gated LP_ADD via range attestation), `0x02`
(`POOL_CAP_SOLO_INTENT_ALLOWED`). `0x04` (`POOL_CAP_ARBITER_AUTHORITY`)
is reserved; bits `0x08..0x80` are reserved for follow-up amendments.

Optional fields are appended to the `pool_id` preimage **iff** their
capability/feature is enabled (the protocol-fee suffix and the arbiter
quorum root both follow this rule) — a feature that is off is absent
from the preimage, never present-as-zero, so enabling it yields a
distinct pool. Indexers fail closed on an asserted capability bit they
do not implement: they cannot derive the `pool_id` or enforce the
behavior, so they decline to onboard the pool. New ops are introduced by
amendment, and the reflection bridge fold treats any unrecognized op as
skip-not-act, so adding capability ahead of a matching fold can only
stall a pool's bridge state, never corrupt it.

## Where each normative section is defined

Sections referenced elsewhere as `AMM.md §"…"`:

- **Envelope byte layouts, POOL_INIT, T_LP_REMOVE, Kernel-msg
  construction, Tip mechanics, Groth16 public-input vector, Pool ID
  derivation, Arbiter attestation block** → `spec/amm/wire-formats.md`.
- **Ceremony governance, POOL_INIT vk/ceremony pinning, trust model** →
  `spec/amm/ceremony.md`.
- **Failure modes** (worker offline, settler races, reorg during batch
  confirmation, indexer disagreement, equivocation, cBTC bridge halt,
  RTT griefing) → `spec/amm/failure-modes.md`.
- **Dapp / indexer integration** (pool discovery, intent posting,
  LP_ADD/REMOVE, attest consumption, settler selection) →
  `spec/amm/dapp-checklist.md`.
- **Per-op extensions** → the amendments: swap-route
  (`SPEC-SWAP-ROUTE-AMENDMENT`), variable-amount swap
  (`SPEC-SWAP-VAR-AMENDMENT`, `SPEC-VARIABLE-AMOUNT-AMENDMENT`), batched
  trade (`SPEC-TRADE-BATCH-AMENDMENT`), LP-bond yield farms
  (`SPEC-AMM-FARM-AMENDMENT`), confidential-token / cBTC.tac
  (`SPEC-CBTC-TAC-AMENDMENT`), orderbook channel
  (`SPEC-ORDERBOOK-CHANNEL-AMENDMENT`), blinded-pubkey
  (`SPEC-BLINDED-PUBKEY-AMENDMENT`).
- **Uniform clearing, Indexer determinism rules (incl. rounding),
  Preconfirmation layer (2-RTT) and its UX mitigations, Expiry
  semantics, Receipt recovery, Intent authentication is out-of-circuit,
  LP shares, LP privacy via mixer composition, Curation-MEV
  mitigation** → the indexer implementation is authoritative:
  `worker/src/index.js` with the conformance validator
  `tests/amm-validator.mjs` and the dual-implementation `cxfer-core`
  fold. These are consolidated into this document as they are migrated
  out of code; until then a behavior is what the validator accepts.
