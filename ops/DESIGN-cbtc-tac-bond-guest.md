# DESIGN — cBTC.tac confidential bond (Tacit-native, guest-enforced) — guest hand-off

> **STATUS: DECISION TAKEN — private Tacit-native confidential bond.** The (TAC, tETH) bond is a
> *confidential* Tacit LP note, and the lien + mint/redeem/slash are enforced in the **proof system**
> (there is no contract to hold a confidential note), so they are **settle-guest ops → deploy-gated →
> must ride this re-prove** (the `PROGRAM_VKEY` is rotating anyway). Companion to the collateral
> economics in `spec/amendments` §5.47/§5.52 and the strategy memory (BOND_RATIO 2.5×, IL-aware floor,
> tETH-primary, dual-TWAP oracle, asset-settled liquidation). Same hand-off shape as
> [`DESIGN-cbtc-sats-lock-reflection.md`](./DESIGN-cbtc-sats-lock-reflection.md) and
> [`DESIGN-adaptor-swap-guest.md`](./DESIGN-adaptor-swap-guest.md).
>
> **Two separable pieces — and the second is the one to get right before the prove:**
> 1. **The structural core (§1–§4)** — the lien, the mint↔cBTC.tac binding, the redeem-burns-exact, the
>    slash-removes-both, position single-use. **Oracle-INDEPENDENT, freezable + native-testable now.** The
>    one new cxfer-core primitive (`bond_position_leaf`) is **implemented + KAT'd (cxfer-core green)**.
> 2. **The price / ratio / health (§5, THE CRUX)** — what caps the mint and what makes a position
>    slashable. This is price-dependent, it is the part most dangerous to freeze into an immutable vkey,
>    and it **can't activate until a live TAC/tETH market exists** for the oracle. §5 specifies a
>    **forward-compatible** way to freeze the guest *without* freezing the oracle — read it before the prove.

## The model

```
issuer LP's (TAC, tETH)  ──OP_LP_ADD──▶  bond LP note  (a normal confidential note)
        │
        ▼  OP_BOND_MINT: spend the bond note (ν), append a BONDED POSITION (lien) + mint cBTC.tac,
        │               the mint amount capped by the price/ratio gate (§5)
   cBTC.tac note  ──(moves as a normal Tacit asset: transfer / LP / swap / bridge — existing ops)──▶
        │
        ├─ OP_BOND_REDEEM: burn the EXACT minted cBTC.tac (ν) + spend the position (ν) ──▶ free the bond LP
        └─ OP_BOND_SLASH:  position unhealthy (§5) ──▶ spend the position (ν) + push the bond LP into
                           liquidation (asset-settled bid / AMM-remove), proceeds cover the cBTC.tac
```

The bond note lives in a **separate bonded-position set**, NOT the note tree — so no `OP_TRANSFER` /
`OP_LP_REMOVE` can touch it; only redeem/slash can, each spending the position once. cBTC.tac itself is
just a Tacit asset (existing conventions); only the **bond lifecycle** is new guest logic.

## 1. The op-set (settle guest)

New op codes (current ops run 0–11, adaptor reserves 12–14): `OP_BOND_MINT = 15`,
`OP_BOND_REDEEM = 16`, `OP_BOND_SLASH = 17`.

### OP_BOND_MINT (15)
Witness: the bond LP note (membership in `spendRoot` + `ν_bond` + opening), the position fields
`(cbtc_asset, minted_amount:u64, issuer, position_nonce)`, the minted cBTC.tac note + path, and the
**price/ratio attestation** (§5). Validate:
- bond membership + `ν_bond` (the normal spend checks, reused);
- the **ratio gate** (§5): `minted_amount` ≤ the attested capacity for this bond;
- the cBTC.tac note opens to `minted_amount` (an opening sigma — value stays hidden, OP_OTC pattern).
Effect: `ν_bond` → spent set; append `bond_position_leaf(bond_Cx, bond_Cy, cbtc_asset, minted_amount,
issuer, position_nonce)` to the **bonded set**; append the cBTC.tac note to the note tree; insert the
position nullifier (spend-once).

### OP_BOND_REDEEM (16)
Witness: the bonded position (membership in the bond-set root + `ν_position` + the position fields), the
cBTC.tac note(s) being burned (membership + `ν` + opening), the released bond note + path. Validate:
- position membership + `ν_position` (spend-once);
- **conservation: the burned cBTC.tac sums to EXACTLY `minted_amount`** (the position's bound amount) —
  no partial under-burn frees the bond, no over-burn is required;
- the released note re-commits the SAME bond commitment the position bound (no substitution).
Effect: `ν_position` + the cBTC.tac `ν`s → spent set; append the bond note back to the note tree (issuer
reclaims the LP). No price needed — redeem is pure conservation.

### OP_BOND_SLASH (17)
Witness: the bonded position (+ `ν_position`), the **health attestation** (§5: the position is
under-collateralized), and the liquidation routing (the bond LP → an asset-settled bid / AMM-remove).
Validate:
- position membership + `ν_position`;
- the **health gate** (§5): the attested bond value < `minted_amount · LIQ_THRESHOLD`;
- the bond LP is routed to liquidation (existing `OP_LP_REMOVE` / asset-settled bid `0x5E`), and the
  proceeds are bound to cover the position's cBTC.tac (insurance floor covers a residual shortfall).
Effect: `ν_position` → spent set; the bond leaves the bonded set into liquidation. The issuer does NOT
get the bond back (the slash penalty) — this is the incentive that keeps positions over-collateralized.

## 2. The bonded-position set + state

A dedicated accumulator (a second instance of the existing keccak-tree + nullifier machinery, like the
adaptor lock-set) — the bonded-set root + the position-spent root join the committed state roots
(`PublicValues`), carried by the contract like the note/nullifier roots. Putting the bond in a *separate*
set is what makes the lien structural: a bonded note simply isn't in the tree any normal spend reads.

## 3. The structural invariants (freezable, native-testable — §1's non-price half)
1. **No inflation.** cBTC.tac enters only via `OP_BOND_MINT`, which consumes a bond note and binds the
   minted amount into the position; redeem burns *exactly* that amount to free the bond; slash removes the
   bond and routes it to cover the cBTC.tac. So every cBTC.tac in existence is backed by either a live
   bonded position or its liquidation proceeds.
2. **The bond is spend-restricted.** It lives in the bonded set, not the note tree — no transfer/LP-remove
   reaches it; only redeem/slash, each spending `ν_position` once (redeem XOR slash, never both).
3. **No substitution / no redirect.** Redeem must reproduce the exact `bond_position_leaf` (so it frees
   the bond that was bonded, burns the cBTC.tac that was minted) — the relayer can't swap either side.
4. **Issuer-bound.** The position binds `issuer`; redeem returns the bond to the issuer, slash denies it.

These four hold **without any price** — they're conservation + binding, the cxfer-core core below.

## 4. cxfer-core testable core
- **`bond_position_leaf(bond_Cx, bond_Cy, cbtc_asset, minted_amount, issuer, position_nonce) -> [u8;32]`
  — IMPLEMENTED + KAT'd (cxfer-core).** The bonded-set leaf; `BOND_POSITION_DOMAIN`-tagged so it's
  disjoint from the note tree (a bonded note is never normal-spendable) and from the adaptor lock set.
  KAT: determinism + every-field binding (no substitution/redirect/amount-tamper) + domain separation.
- The mint/redeem/slash VALIDATION is **main.rs assembly of existing primitives** (`keccak_merkle_verify`,
  `nullifier`, `verify_opening_sigma`, the u128 conservation sum) — same as the adaptor ops — plus §5's
  attestation check. No new cxfer-core soundness logic beyond the leaf + §5.
- Adversarial coverage in the box fixtures: under-burn-frees-bond rejects, bond-substitution rejects,
  double-spend of `ν_position` rejects, redeem-XOR-slash, a normal transfer of a bonded note rejects.

## 5. THE CRUX — price / ratio / health, and how to freeze the guest WITHOUT freezing the oracle

The mint cap (§1 `OP_BOND_MINT`) and the slash trigger (§1 `OP_BOND_SLASH`) are the *only* price-dependent
checks, and they are the part most dangerous to bake into an immutable vkey — the dual-TWAP, the
BOND_RATIO band, the IL-aware floor, the liquidation threshold are **economic policy that must be tunable
as the market matures**, and the oracle itself **can't be validated until a live TAC/tETH market exists**.
Freezing a specific price computation now risks a forced migration the moment the policy needs to change.

**Resolution: the guest verifies a relay-attested price/capacity; it does NOT compute or hardcode the
oracle.** Reuse the *existing* relay-anchor trust (the same relay that anchors Bitcoin state / the TAC
oracle — not a new trust surface):
- `OP_BOND_MINT` reads an attestation `(bond_commitment, max_mint, anchor)` signed by the **pinned relay
  key**; the guest verifies the signature + that `minted_amount ≤ max_mint` + that the attestation binds
  *this* bond and a recent anchor. The relay computes `max_mint` from the dual-TWAP (TAC/BTC anchor ×
  the pool's TAC/tETH TWAP) ÷ BOND_RATIO — **off-guest, evolvable**.
- `OP_BOND_SLASH` reads an attestation `(position, unhealthy, anchor)` similarly; the guest enforces the
  slash-mechanics, the relay made the health call.

**What this freezes vs. keeps soft:**
- **Frozen (safe):** the *structure* (§1–§4) and the *interface* — "verify a relay-signed capacity/health
  over this exact position + a recent anchor, then enforce the arithmetic/conservation." This is the same
  trust you already accept for the relay anchor.
- **Soft (post-deploy, no guest change):** the price source, the dual-TWAP, BOND_RATIO + its band, the
  IL-aware floor, LIQ_THRESHOLD — all live in the relay's `max_mint`/`unhealthy` computation. Tune them
  as the market matures; the vkey never sees them.

**Trust + hardening (the cBTC.tac analog of cBTC.zk's vault-custody §4, NOT deploy-gated):** this makes
the relay the oracle-trust + a mint-liveness dependency (it could censor a mint or mis-price). Mitigations,
post-deploy: (a) the relay attests the *price + inputs* and the guest re-derives `max_mint` from the
reserves it already proves over (moves the ratio arithmetic into the guest, leaving only the TAC/BTC
price attested — a smaller trust); (b) threshold/MPC the relay key + slashing; (c) a dispute/override
window on slashes. Pick + document the launch oracle posture the same accept-and-document way as the
reorg / vault-custody cruxes. **The structural guest (§1–§4) is forward-compatible with any of these.**

## 6. Public values + contract
- The bonded-set root + the position-spent root join the committed state roots (guest advances, contract
  carries — like the note/nullifier roots and the adaptor lock-set).
- The relay-attestation verification key: reuse the existing relay anchor key (no new immutable) if
  possible; else a pinned `BOND_ORACLE_KEY` constructor arg.
- **No new asset machinery:** cBTC.tac is a canonical/Tacit asset; mint appends its note, redeem/slash
  move it — the pool's existing multi-asset path carries it. The deploy locks only the vkey(s) + roots.

## 7. Why it rides this re-prove + the live-market gate
The bond ops are settle-guest logic, so they must be in the proven `PROGRAM_VKEY` **before** this deploy
or adding them later is a live-pool migration. But cBTC.tac **can't activate** until a live TAC/tETH
market feeds the oracle. So the **inert-bake pattern** (as for cBTC.zk + the adaptor): freeze the
structural ops + the relay-attestation interface into this vkey now; the relay's price logic + the market
+ the liquidation venue activate post-deploy with **no guest change**. The one thing to settle before the
prove is §5's freeze line — confirm the attestation interface is the right immutable surface, since
*that* is what the vkey commits to.

## Coordination + remaining
- **Guest (rides this re-prove):** `main.rs` dispatch for ops 15–17 (reads → existing checks + §5
  attestation → effects), the bonded-set/position-spent accumulators, the `bond_position_leaf` appends.
- **cxfer-core (DONE this pass):** `bond_position_leaf` + `BOND_POSITION_DOMAIN` + KAT.
- **Relay/app (post-deploy, gated on a live TAC/tETH market):** the dual-TWAP `max_mint`/health
  attestation service, the asset-settled liquidation routing, the insurance floor, the issuer/redeemer UX.
- **Decision before the prove:** the §5 attestation interface (the immutable surface) + whether to put
  the ratio arithmetic in-guest (price-only attestation) or fully in the relay (capacity attestation).
