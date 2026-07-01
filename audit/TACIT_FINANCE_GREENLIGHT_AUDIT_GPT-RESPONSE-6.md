# Maintainer response — GPT greenlight audit, round 6 (bundle @ `bee4c88`)

Sixth pre-reprove pass. Three findings, all real — the High fund-loss and the Medium atomicity bug fixed;
the Low panic footgun hardened.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| F-01 | Unauthenticated Bitcoin `T_PROTOCOL_FEE_CLAIM` — anyone steals a pool's accrued protocol-fee LP shares | High (fund loss) | **Real** | **Fixed** (in-guest recipient auth) |
| F-02 | `T_FARM_INIT` treasury + reward-state insert non-atomic — malformed window strands a funded treasury | Medium | **Real** | **Fixed** (atomic pre-check) |
| Q-01 | `fold_lp_unbond` panic-after-append footgun in `FarmRewardState::unbond` | Low | **Real (latent)** | **Fixed** (guard before append) |

cxfer-core 152/152 (incl. new non-recipient-rejected + bad-sig-rejected claim cases); the guest↔JS
DIGEST_MATCH gate is green (`reflection_protofee` regenerated and matches; the farm fixtures unchanged-match;
only the ceremony-zkey `swapbatch` remains a box-regen item).

## F-01 — Unauthenticated protocol-fee claim — FIXED

Confirmed and serious. `parse_protocol_fee_claim_envelope` discarded the claimer pubkey + the claim
signature, and `fold_protocol_fee_claim` enforced only that the pool was C0-backed, had a fee tier, and that
`claim_amount == protocol_fee_accrued` (+ the public Pedersen opening). The accrued LP-share skim is owed to
the pool's **bound fee recipient** (committed in the `pool_id` preimage), but nothing tied the claim to that
recipient — so any prover could confirm a `0x31` tx claiming the accrued amount to **their own** outpoint-keyed
note, zeroing the recipient's accrual and walking away with bridgeable LP shares. The code even documented the
gap ("the claimer authorization … is the worker's fairness gate, not bridge-soundness") — i.e. it was deferred
to the off-chain worker, which the trustless reflection proof doesn't run.

**Fixed** by moving the authorization in-guest, with **no pool-root digest cascade**:
- The `0x31` envelope now carries the **full claimer pubkey (33B)** + the **LP fee tier (fee_bps)** (202→207B).
- The fold **re-derives `pool_id`** = `pool_id_with_protocol_fee(asset_a, asset_b, fee_bps, claimer, pf_bps)`
  from the claim's claimer + fee tier and the pool's stored asset pair + protocol-fee tier. A match **proves
  the claimer is the bound recipient** — the `pool_id` preimage commits the recipient, and an attacker can't
  supply the real recipient's key to sign. (Re-derivation avoids storing the recipient, so the pool leaf /
  digest / genesis are unchanged.)
- A **BIP-340 sig under the claimer** over `protocol_fee_claim_msg(pool_id, claim_amount, claim_C, claim_blinding,
  dest_spk)` is required — binding the **vout-0 destination scriptPubKey** so the public envelope can't be
  replayed into a front-runner's own outpoint-keyed note (the materialized LP-share note is outpoint-controlled,
  same class as the harvest/refund `dest_spk` binding).

Mirrored byte-for-byte in the JS attester (`foldProtocolFeeClaim` + a new `poolIdWithProtocolFee` keccak
mirror — distinct from the EVM `ammDerivePoolIdFull` sha256 id), the `0x31` parser, the dapp dispatcher, and
the protofee generator (a real claimer keypair → derived `pool_id` → signed claim). New cxfer-core tests
assert a non-recipient claimer and a forged sig are both rejected, and the authorized claim still folds.

## F-02 — `T_FARM_INIT` non-atomicity — FIXED

Confirmed, and a regression-adjacent to round 5's campaign-window fix. The dispatcher ran
`fold_farm_init(...)` (which inserts the funded treasury into `pools`) and then `let _ =
fold_farm_init_rewards(...)` (which round 5 taught to reject `end_height <= start_height`), **ignoring** the
second result. A launcher confirming a funded init with a malformed window (`end == start`) committed the
treasury but **not** the reward accumulator — leaving `pools[farm_id]` present with no `farm_rewards[farm_id]`,
so refund/bond/harvest/unbond all reject as "unknown farm" and re-init is impossible ("farm already
registered"). The funded treasury + farm namespace are stranded.

**Fixed** by pre-validating the window **before** the treasury insert: a malformed `[start, end]` now skips
the **whole** init (treasury + reward-state commit atomically), and the pre-validation makes
`fold_farm_init_rewards` unable to fail on the window after the treasury committed — so the `let _` stays a
clean all-or-nothing. Mirrored in the JS attester. Byte-parity on the valid-window path (the success case is
unchanged), so no fixture/digest change.

## Q-01 — `fold_lp_unbond` panic footgun — FIXED

`fold_lp_unbond` appends the LP-return note (`fold_output`) **before** calling `FarmRewardState::unbond`,
which `assert!(shares > 0)` + `checked_sub(...).expect(...)`. Not currently reachable — a zero-share receipt
can't exist (bond rejects it) and a live receipt's shares are always `<= total_shares` by construction, so
membership + the share-accounting invariant protect it — but it is the exact "panic after a value output
landed" class that bricks the forward-only chain, and the guest is immutable. **Fixed** with a skip-not-panic
guard (`shares == 0 || shares > total_shares → Err`) before the append. Defense-in-depth; no behavior change
on any valid path.

## Net
F-01 (the High fund-loss), F-02 (the Medium strand), and Q-01 (the latent panic) are all closed. cxfer-core
152/152; the guest↔JS DIGEST_MATCH gate is green (protofee regenerated + matches; farm fixtures match; only
the ceremony-zkey `swapbatch` regenerates on the box). Surface is greenlight-ready for the re-prove.
