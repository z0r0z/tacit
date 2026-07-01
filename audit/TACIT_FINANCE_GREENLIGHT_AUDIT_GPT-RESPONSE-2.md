# Maintainer response — GPT greenlight audit, round 2 (bundle @ `e90a1ba`)

Second pre-reprove greenlight pass over the immutable surface. Four findings — **all four valid, all fixed.**
This round concentrated on the delegated-proving authorization seam the README flagged as priority, and it
paid off: it found two genuine launch-blockers in the EVM-lane farm receipt spends.

| # | Finding | Severity | Verdict | Disposition |
|---|---------|----------|---------|-------------|
| 1 | Farm receipt spends omit Bitcoin spent-set nonmembership → cross-lane double-spend | Critical | **Real** | **Fixed** (guest) |
| 2 | EVM farm receipt spends lack receipt-owner authorization | High | **Real** | **Fixed** (guest + JS + fixtures) |
| 3 | `LP_ADD` doesn't bind pool identity (first-add fee-tier redirect) | Medium | **Real** | **Fixed** (guest + JS + fixtures) |
| 4 | Protocol-fee recipient not on-curve-validated (trap-pool fee lock) | Low | **Real** | **Fixed** (guest) |

Commit: `d9849c0`. The fixes change the settle guest's signed transcript (and #2 adds a witness field), so
they ride the coordinated re-prove — the settle `program_vkey` rotates and the `*_groth16.json` proofs
regenerate from the committed guest on the box. `cxfer-core` 151/151, guest builds, all affected JS suites
green, farm + lp fixtures regenerated, and the new owner signatures round-trip-verify under BIP-340.

## #1 — Farm receipt fast-lane spends omit Bitcoin spent-set nonmembership — FIXED

Confirmed and serious. `farm_receipt_nullifier` is shared byte-identically between the Bitcoin reflection
farm folds and the EVM settle guest (`cxfer-core` `farm_receipt_leaf`/`farm_receipt_nullifier`). Every other
Bitcoin-homed value-note spend in the settle guest gates its nullifier with
`check_btc_nonmembership(&nu, &bitcoin_spent_root)` (≈20 sites), but `OP_FARM_HARVEST` and `OP_FARM_UNBOND`
pushed the receipt nullifier without it — so a receipt already harvested/unbonded on Bitcoin (present in the
reflected `bitcoin_spent_root`) could be replayed on Ethereum, double-spending the reward/principal across
lanes. **Fixed:** both handlers now apply the identical conditional gate (`if bitcoin_spent_root != 0`)
before pushing the receipt nullifier. Guest-only; the Ethereum-only fixtures (`bitcoin_spent_root == 0`)
short-circuit the check, so no fixture change.

## #2 — EVM farm receipt spends lack receipt-owner authorization — FIXED

Confirmed. The Bitcoin lane requires a BIP-340 owner signature on harvest/unbond
(`lp_harvest_owner_msg`/`lp_unbond_owner_msg`); the EVM lane had none — it only verified the *output* note's
opening sigma, whose blinding is chosen by whoever assembles the witness. Under delegated proving the box has
the receipt preimage + path, so it could nullify the victim's receipt and re-mint the reward/principal to a
commitment it controls (the leaf `owner` is bearer-only — spend authority is knowledge of the blinding, not
the leaf field). **Fixed:** both ops now require a BIP-340 signature under the receipt owner over a new
EVM-lane message (`evm_lp_harvest_owner_msg` / `evm_lp_unbond_owner_msg`, distinct domains from the Bitcoin
lane) that binds the receipt, amounts, the output commitment (the dest a box could substitute — the EVM
analogue of the Bitcoin lane's `reward_r` + `dest_spk`), and harvest's advanced-receipt nonce. The receipt
owner is `id.owner = pub(id.priv)`, so the wallet signs and a box cannot. Threaded through the guest, the
two box harnesses, the JS builder/caller, a JS message mirror, and the exec-fixture builder; the regenerated
fixtures' owner sigs verify under BIP-340 (byte-compatible with the guest's `bip340_verify`, the same
primitive `OP_CDP_CLOSE` uses).

## #3 — `LP_ADD` omits pool identity — FIXED

Confirmed for first-adds. The `tacit-lp-add-v1` context bound assets + the three notes + deltas but not the
derived `pid`/`lp_asset`. For a non-empty pool the user's share-note sigma pins the pool (d_shares depends on
that pool's live reserves), but a first add mints `d_shares = isqrt(d_a·d_b)` — independent of any pool — so a
box could redirect the liquidity into a different same-pair fee tier / protocol-fee config and strand it.
**Fixed:** bound a synthetic `(lp_asset, pid, share_owner)` tuple into the context (`pid` commits
`fee_bps` + `protocol_fee_recipient` + `protocol_fee_bps`). `OP_LP_BOND` is not affected — its bonded shares
land in a FarmController that only accepts its pool's LP asset, so the pool is controller-gated.

## #4 — Protocol-fee recipient not validated — FIXED

Confirmed (defensive). A nonzero-protocol-fee pool could be created with an off-curve recipient x-only key;
per-swap fee carves then mint stealth locks claimable only by BIP-340 under that key — permanently
unclaimable with `deadline = u64::MAX`. Self-inflicted by the pool creator, but permissionless creation makes
it a trap. **Fixed:** `OP_SWAP` now decompresses the recipient's x-only key and fails the swap closed if it
isn't on-curve (mirroring the stealth-lock owner check), so no value is ever carved into an unclaimable lock.

## Net
All four are fixed in the guest with JS mirrors + fixtures regenerated and verified; they fold into the
coordinated re-prove. The two cross-component farm blockers (#1, #2) were the substantive finds — the
delegated-proving + cross-lane focus surfaced exactly the class that a per-op review misses. Surface is
greenlight-ready for the re-prove + testnet pending that re-prove.
