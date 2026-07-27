# Adversarial review checklist for new / changed settle-guest ops

Every item below is derived from a bug that **actually shipped or nearly shipped in this repo**, not from generic
ZK advice. Run this against each op before it goes into a vkey. The vkey is immutable once deployed.

The framing question for the whole document:

> **For every value-bearing field this op reads: what binds it? If the answer is "the prover supplies it", what
> stops the prover supplying a different one?**

FARM-01 failed exactly this question. `OP_FARM_UNBOND` read `lp_asset = r32()` and minted a note of that asset,
while `farm_receipt_leaf` (v1) did not commit the staked asset — so a receipt bonded with a worthless token could
be unbonded as cETH, drawing pool-wide escrow. The Bitcoin lane had pinned the asset in `FarmRewardState.lp_asset`
since day one; the EVM lane re-witnessed it. **The two lanes disagreed on the trust model and only one was right.**

---

## A. Asset binding (cross-asset inflation)

Hit twice: the reflection prover's asset-preservation bug, then FARM-01. This is the most expensive class here —
it converts a worthless asset into a backed one 1:1 in *Tacit units*, and unit scales differ wildly per asset
(a junk 18-dec token and cETH both use `unitScale 1e10`, so 1 junk token → 1 ETH).

- [ ] Every output leaf's asset is **derived from**, or **asserted equal to**, the asset proven by an input's
      membership leaf — never a second independent `r32()`.
- [ ] For multi-input ops: each input's asset comes from **its own** membership leaf. A single witnessed `asset`
      applied to all inputs is the FARM-01 shape with more leverage.
- [ ] Any structure re-derived across ops (receipt leaf, position leaf, lock leaf) **commits the asset**, so a
      later op cannot re-label it. If it does not, the later op must not be free to choose.
- [ ] Conservation is summed **per asset**, not in aggregate. An op touching two assets asserts `asset_a != asset_b`
      and sums each independently (see `OP_OTC` / `OP_BID`).
- [ ] `registerWrappedAuto` is permissionless — assume the attacker controls a registered asset with any decimals.

## B. Authorization and destination binding

Real bugs: CDP-CLOSE-OWNER-001 (nullified a position with no owner signature), the farm `dest_spk` gap, the
adaptor OTC claim missing its opening sigma.

- [ ] Every op that spends, nullifies, or redirects value names its authorization: knowledge of the blinding `r`
      (bearer), an opening sigma over `intent_context`, or an explicit BIP-340 signature.
- [ ] **Every user-visible destination is inside the authorization transcript** — withdrawal `recipient`,
      `destCommitment`, `dest_spk`, stealth/adaptor claim targets, liquidation `liquidator`, and the **fee**.
      A delegated box/relayer must not be able to move value to itself or a third party.
- [ ] Publishing a preimage is **not** authorization. A public receipt/position leaf gates *membership*; the
      *spend* still needs a signature. (This was CDP-CLOSE-OWNER-001 exactly.)
- [ ] Deadlines are inside the sigma and folded into `min_deadline`, so a box cannot stretch or sit on them.
- [ ] Where the attacker is the legitimate owner, ask what the signature actually constrains. In FARM-01 the
      owner *did* sign `lp_asset` — and simply signed the asset they wanted. **An owner signature over a
      prover-chosen field binds nothing.**

## C. Conservation and range

Real bug: the mod-`n` fee-wrap (make `fee > value` so `Σout ≡ value − fee mod n`).

- [ ] Reuse `verify_kernel_with_fee_bound` verbatim for n-in/m-out shapes. It binds the output **leaves**, which
      is what stops a delegated prover relabelling an output owner. Do not hand-roll conservation on a new op.
- [ ] Every kernel-with-fee op either bounds outputs with an explicit BP+ range, or re-opens the input to a
      cleartext `u64` first. Without one of those the mod-`n` wrap is reachable.
- [ ] `fee < value` asserted, and change is range-proven — not merely computed.
- [ ] Conservation-free value entry (bridge_mint, cbtc_mint, farm reward) is gated by an **external** proof of
      backing, and that gate is named in review.

## D. Public-values discipline

- [ ] Any field the **contract** acts on is either constrained in-guest or independently re-checked on-chain.
      Three fields currently rely on the contract: farm `reward_asset`, `cbtcMints.outpoint/vBtc`, and the AMM
      `*Pre` reserves. **A contract-only refactor that drops one of those re-creates a mint-anything bug** —
      mark them `GUEST-COUPLED` if you touch them.
- [ ] New value-bearing `PublicValues` fields are added to the `btcHomed` enumeration in
      `ConfidentialPool._settle`, either barred or gated with the source ν recorded. The suite pins the encoded
      width so this fails loudly.
- [ ] Zero is not a skip. A root of `0` must not silently disable a membership/non-membership check — the
      empty-spent-root bypass was exactly this. Sentinels are non-zero.

## E. Cross-lane coherence

- [ ] Any structure shared with the Bitcoin lane (`farm_receipt_leaf`, nullifiers, note leaves) changes on
      **both** sides in the same commit, or the lanes silently diverge.
- [ ] When the two lanes model the same thing differently, **the stricter one is probably right** — reconcile
      rather than assuming the looser one is fine. (FARM-01.)
- [ ] `cxfer-core` is shared by the settle, reflection, and eth-reflection guests: a change there rebuilds
      **all three** ELFs. Diff every sha256 after rebuild; do not assume dead-code elimination kept one stable.

## F. Ship discipline

- [ ] `elf-vkey-pin.json` updated in the **same commit** as any ELF change — all affected vkeys, not just the
      obvious one.
- [ ] Real-proof fixtures regenerated for every op whose witness layout changed. A witness-order change with a
      stale serializer fails *at prove time*, silently, per-op.
- [ ] Host serializer (`exec-*.rs`) field order matches the guest's read order exactly, including new fields
      inserted mid-struct.
- [ ] JS mirrors updated: dapp leaf/serializer helpers **and** `worker/src/index.js`.
- [ ] `verify-pool-size.sh` green — the pool ships ~20 bytes under EIP-170.

### Cross-lane consume alignment (invariant held by CONVENTION, not construction)

Cross-lane no-double-spend rests on `bitcoin_consumed_sources.len() == nullifiers.len()` (`main.rs`) plus the
per-op convention that both vectors are appended **in the same order**, so every btcHomed spend records its
authenticated source and native-leaf ops (`OP_BID`, `OP_CDP_CLOSE`, `OP_LP_BOND`, `OP_CDP_TOPUP`, …) cannot spend
a burn-deposit note out of a Bitcoin pool root without a BIP-340 signature. This is enforced by discipline, not
a type-level guarantee — a new op that pushes a nullifier **outside** `input_leaf_authed` breaks it silently.

- [ ] Any op that adds/changes an input path pushes its nullifier via `input_leaf_authed` (which appends the
      aligned source), OR is a pure native-leaf op that pushes NO Bitcoin consume source — never a mix that
      misaligns the two vectors.
- [ ] For a btcHomed input, the source pushed to `bitcoin_consumed_sources` is the FULL authenticated leaf
      (`btc_note_leaf(asset,Cx,Cy,auth_key)`), not the asset or commitment alone.

---

## Applying this to the four queued ops

| Op | Sharpest question |
|---|---|
| `OP_WRAP_LP` / `OP_WRAP_SWAP` | Is the wrapped asset bound to the `deposit_id` (as `OP_WRAP` does), or re-witnessed? §A |
| LP change outputs | Is the change note's asset the input's asset, and is change range-proven? §A, §C |
| Multi-note LP/swap inputs | Does **each** input's asset come from its own membership leaf? §A — highest risk in the set |
| Quantized fee ladder | Does the ladder leave headroom for gas spikes? Fixes fingerprinting, **not** M-01's unbound `msg.sender`. |

Also re-run the on-chain LP-add proportionality bound (`_ckProp`, M-03) against the new partial-add and
multi-input shapes: change notes should not perturb reserve deltas, but that is an assumption until tested.
