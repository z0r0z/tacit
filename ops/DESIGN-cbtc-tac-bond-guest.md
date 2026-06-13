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
>    and it **can't activate until a live TAC/tETH market exists** for the oracle. **DECIDED: HYBRID —
>    relay-attested capacity BOUNDED by the live AMM reserves** — built + KAT'd (cxfer-core, 71 green):
>    `verify_bond_mint` re-derives the capacity ceiling from the live (TAC,tETH) reserves via
>    `bond_spot_capacity_ceiling` and rejects a `max_mint` above it, so the relay's only un-bounded input
>    is the single exogenous TAC/BTC scalar. The TWAP/ratio stays relay-side (tunable post-deploy).

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
Effect: `ν_bond` → spent set; append `bond_position_leaf(bond_asset, bond_Cx, bond_Cy, cbtc_asset,
minted_amount, issuer, position_nonce)` to the **bonded set** — binding `bond_asset` (the LP-share id) so
redeem can't relabel the released note to a dearer asset; append the cBTC.tac note to the note tree;
insert the position nullifier (spend-once).

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

## 4. cxfer-core testable core — DONE this pass (cxfer-core 71 green)
- **`bond_position_leaf(bond_asset, bond_Cx, bond_Cy, cbtc_asset, minted_amount, issuer, position_nonce)`.**
  The bonded-set leaf; binds `bond_asset` (the LP-share id — so redeem can't relabel the released note to a
  dearer asset, a relabel-inflation the dispatch draft caught); `BOND_POSITION_DOMAIN`-tagged so it's
  disjoint from the note tree (a bonded note is never normal-spendable) and from the adaptor lock set. KAT:
  determinism + every-field binding (incl. the anti-relabel `bond_asset`) + both disjointness checks.
- **`BondMintAttest` + `verify_bond_mint` + `bond_spot_capacity_ceiling` + `verify_bond_slash_health`**
  (+ the `BOND_ATTEST_*` domains + `BOND_ORACLE_PUBKEY_X` placeholder) — the §5 hybrid price gate over
  `bip340_verify`. KATs: the ceiling fair-LP arithmetic (+ overflow/zero fail-closed); a real BIP-340
  sign/verify round-trip; the trustless guard (a `max_mint` above the live-reserve ceiling, and shrunken
  live reserves, both reject *with a valid sig*); + field-tamper / wrong-key rejections.
- The mint/redeem/slash *op VALIDATION* is **main.rs assembly of these primitives + existing ones**
  (`keccak_merkle_verify` membership, `nullifier` spend-once, `verify_opening_sigma` value-binding, the
  u128 conservation sum) — same composition style as the adaptor ops. No further new cxfer-core soundness
  logic beyond the leaf + the §5 verifiers above.
- Adversarial coverage of the *assembled ops* lands in the box fixtures: under-burn-frees-bond rejects,
  bond-substitution rejects, double-spend of `ν_position` rejects, redeem-XOR-slash, a normal transfer of
  a bonded note rejects.

## 5. THE CRUX — price / ratio / health, and how to freeze the guest WITHOUT freezing the oracle

The mint cap (§1 `OP_BOND_MINT`) and the slash trigger (§1 `OP_BOND_SLASH`) are the *only* price-dependent
checks, and they are the part most dangerous to bake into an immutable vkey — the dual-TWAP, the
BOND_RATIO band, the IL-aware floor, the liquidation threshold are **economic policy that must be tunable
as the market matures**, and the oracle itself **can't be validated until a live TAC/tETH market exists**.
Freezing a specific price computation now risks a forced migration the moment the policy needs to change.

**DECIDED — HYBRID: relay-attested capacity, BOUNDED by the live AMM reserves. BUILT + KAT'd
(cxfer-core 71 green).** The price ratio *is* the AMM (the (TAC,tETH) reserves), so the guest does NOT
trust the relay's number blindly: it re-derives the capacity ceiling from the LIVE pool reserves at the
SAME price/ratio the relay attests, and the relay's only un-bounded input shrinks to the single exogenous
TAC/BTC scalar (the part no pool can give, since neither bond leg is BTC). Built over `bip340_verify`:
- `OP_BOND_MINT` → **`verify_bond_mint(att: &BondMintAttest, minted, share, total_shares, reserve_tac,
  band_bps, sig, BOND_ORACLE_PUBKEY_X)`**. The relay signs `att = (bond ‖ asset ‖ max_mint ‖
  sats_per_tac_num ‖ sats_per_tac_den ‖ ratio_bps ‖ anchor)`. Accept iff: the pinned relay signed it,
  `minted ≤ max_mint`, **and** `max_mint ≤ bond_spot_capacity_ceiling(share, total_shares, reserve_tac,
  …)` — the fair-LP value of the bonded share, `2·(share/total)·reserve_tac`, priced + ratio'd + widened
  by `band_bps` for legit TWAP-vs-spot drift (u128-checked, fail-closed). KAT: at/under-cap accept; a
  `max_mint` ABOVE the live-reserve ceiling rejects *even with a valid sig*; halved live reserves reject;
  field-tamper + wrong oracle key reject.
- `OP_BOND_SLASH` → **`verify_bond_slash_health(position_leaf, anchor, sig, BOND_ORACLE_PUBKEY_X)`**:
  accepts iff the relay signed the exact `position_leaf` is slashable at `anchor`. (Slash is the relay's
  health call — bounding it against spot the same way is a follow-up; a wrongful slash is recoverable
  via the dispute window, unlike an over-mint.) KAT: wrong position / anchor / key each reject.

**Why the hybrid (your point — the ratio is the AMM):** the (TAC,tETH) reserves dominate the bond
valuation and are **guest-enforced from on-chain state**, not trusted to the relay; a rogue/buggy relay
cannot authorize a mint beyond what *live* reserves justify without also moving the visible pool. The
relay supplies only the **time-averaging** (the TWAP the guest can't cheaply compute, since that needs
reserve history not in one proof) **and the single TAC/BTC anchor**, both within the spot `band_bps`.
What's frozen: the fair-LP identity + the bound arithmetic (a stable formula, not policy). What stays
soft (relay-side, tunable post-deploy): the TWAP, BOND_RATIO + band, IL-floor, LIQ_THRESHOLD.
**Still to finalize before the prove:** `BOND_ORACLE_PUBKEY_X` (placeholder) + the `anchor` recency rule
+ `band_bps` (frozen-conservative vs attested). Fully-trustless (no relay) needs a cBTC.zk-anchored pool
+ TWAP-in-proof — the documented later upgrade; the structural guest is forward-compatible with it.

**What this freezes vs. keeps soft:**
- **Frozen (safe):** the *structure* (§1–§4) and the *interface* — "verify a relay-signed capacity/health
  over this exact position + a recent anchor, then enforce the arithmetic/conservation." This is the same
  trust you already accept for the relay anchor.
- **Soft (post-deploy, no guest change):** the price source, the dual-TWAP, BOND_RATIO + its band, the
  IL-aware floor, LIQ_THRESHOLD — all live in the relay's `max_mint`/`unhealthy` computation. Tune them
  as the market matures; the vkey never sees them.

**Trust + hardening (the cBTC.tac analog of cBTC.zk's vault-custody §4, NOT deploy-gated):** the hybrid
already does mitigation (a) — the guest re-derives the capacity from the **live reserves it proves over**,
so the relay's residual trust is just the single **TAC/BTC scalar** (mis-price within `band_bps`) plus
mint-liveness (it could censor). Further hardening, post-deploy: bound even that scalar against a
cBTC.zk-anchored pool (fully trustless, needs that pool + TWAP-in-proof); threshold/MPC the relay key +
slashing; a dispute/override window on slashes. Pick + document the launch posture the accept-and-document
way (as the reorg / vault-custody cruxes). **The structural guest (§1–§4) is forward-compatible with all.**

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
- **cxfer-core (DONE this pass, 71 green):** `bond_position_leaf` + `BOND_POSITION_DOMAIN`; the §5 hybrid
  gate `BondMintAttest` + `verify_bond_mint` + `bond_spot_capacity_ceiling` + `verify_bond_slash_health`
  (+ `BOND_ATTEST_*` domains + `BOND_ORACLE_PUBKEY_X`); KATs for all of it.
- **Relay/app (post-deploy, gated on a live TAC/tETH market):** the dual-TWAP `max_mint`/health
  attestation service (signs the `BondMintAttest` with the bond-oracle key the guest pins), the
  asset-settled liquidation routing, the insurance floor, the issuer/redeemer UX.
- **Decided:** the §5 interface = **hybrid (relay capacity bounded by live AMM reserves)**. **Still to
  finalize before the prove:** `BOND_ORACLE_PUBKEY_X` (the pinned relay key), the `anchor` recency rule,
  and `band_bps` (frozen-conservative vs attested). Fully-trustless pricing (bound the TAC/BTC scalar via
  a cBTC.zk-anchored pool + TWAP-in-proof) remains the documented later upgrade.

## Appendix A — `main.rs` op-dispatch draft (ops 15–17)

> **DRAFT, not yet in the live guest.** This composes the tested cxfer-core primitives in the OP_LP /
> OP_OTC idiom; it is **untestable locally** (SP1 `io::read` plumbing → validated by box-execute
> fixtures) and is **coupled to a matching `ConfidentialPool.sol` ABI** (the new PublicValues fields +
> gates below), which is the guest+contract owner's coordinated step. Kept here (not dropped into the
> fund-critical guest) so it's reviewable without leaving `main.rs` in a contract-incoherent state.
> Writing it surfaced the `bond_asset` relabel gap (now fixed in `bond_position_leaf`).

**New pinned constants (bake into `PROGRAM_VKEY`, finalize before the prove):** `TAC_ASSET_ID`,
`TETH_ASSET_ID` (the bond pool pair — the §5 ceiling is TAC-denominated, so the valuation is only sound
for this pair), plus `BOND_ORACLE_PUBKEY_X` (§5). `band_bps` = a frozen-conservative const or attested.

**New PublicValues fields (the coordinated contract ABI):**
`bytes32[] bondedPositions` (append to the contract's bonded-set), `bytes32[] positionsSpent` (mark in the
position-spent set), `BondSettlement[] bonds` = `{poolId, reserveTac, totalShares}` the mint's ceiling
used — **the contract gates these == the live (TAC,tETH) pool reserves** (else a prover supplies
fake-high reserves → inflated ceiling → over-mint). The guest reads a `bonded_set_root` input alongside
`spend_root` for redeem/slash membership. The contract also counts a bond-mint as **authorized cBTC.tac
supply** in the reserve floor (like `bridge_mint`).

### OP_BOND_MINT (15)
```rust
// pair + pool, pinned to (TAC,tETH); reserves are gated by the contract via BondSettlement
let asset_a = r32(); let asset_b = r32(); let fee_bps: u32 = io::read();
assert!(bitcoin::be_bytes_lte(&asset_a, &asset_b) && asset_a != asset_b, "bond_mint: non-canonical pair");
assert!((asset_a==TAC_ASSET_ID && asset_b==TETH_ASSET_ID)||(asset_a==TETH_ASSET_ID && asset_b==TAC_ASSET_ID),
        "bond_mint: not the (TAC,tETH) bond pool");
let pid = pool_id(&asset_a, &asset_b, fee_bps); let lp_asset = lp_share_id(&pid);
let r_a_pre: u64 = io::read(); let r_b_pre: u64 = io::read(); let shares_pre: u64 = io::read();
let reserve_tac = if asset_a==TAC_ASSET_ID { r_a_pre } else { r_b_pre };
// the bonded LP-share note (membership + ν + opening binds `share`)
let (s_cx,s_cy,s_pt)=r_commitment(); let issuer=r32(); let s_idx:u64=io::read(); let s_path=r_path();
let share:u64=io::read(); let s_r=decompress(&r33()).unwrap(); let s_z=scalar_reduce_be(&r32());
// the minted cBTC.tac note (opens to minted_amount) + the position nonce
let cbtc_asset=r32(); let (m_cx,m_cy,m_pt)=r_commitment(); let minted:u64=io::read();
let m_r=decompress(&r33()).unwrap(); let m_z=scalar_reduce_be(&r32()); let nonce=r32();
// §5 capacity attestation + band + relay sig
let att=BondMintAttest{ bond_cx:s_cx,bond_cy:s_cy,cbtc_asset, max_mint:io::read(),
  sats_per_tac_num:io::read(), sats_per_tac_den:io::read(), ratio_bps:io::read(), anchor:r32() };
let band_bps:u32=io::read(); let att_sig=r_n::<64>();
let ctx=intent_context(b"tacit-bond-mint-v1",&chain_binding,&lp_asset,&cbtc_asset,
  &[(s_cx,s_cy,issuer),(m_cx,m_cy,issuer)],&[share,minted,att.max_mint]);
// spend the LP-share note
let s_lf=leaf(&lp_asset,&s_cx,&s_cy,&issuer);
assert!(spend_root!=[0u8;32] && keccak_merkle_verify(&s_lf,s_idx,&s_path,&spend_root), "bond_mint: share membership");
let s_nu=nullifier(&s_cx,&s_cy);
if bitcoin_spent_root!=[0u8;32]{ check_btc_nonmembership(&s_nu,&bitcoin_spent_root); }
assert!(verify_opening_sigma(&s_pt,share,&s_r,&s_z,&ctx), "bond_mint: share opening");
assert!(minted>0 && verify_opening_sigma(&m_pt,minted,&m_r,&m_z,&ctx), "bond_mint: mint opening");
// §5 HYBRID gate: relay capacity bounded by the LIVE reserves (contract gates reserve_tac/shares_pre)
assert!(verify_bond_mint(&att,minted,share,shares_pre,reserve_tac,band_bps,&att_sig,&BOND_ORACLE_PUBKEY_X),
        "bond_mint: §5 capacity gate");
// effects
nullifiers.push(s_nu);
bonded_positions.push(bond_position_leaf(&lp_asset,&s_cx,&s_cy,&cbtc_asset,minted,&issuer,&nonce));
leaves.push(leaf(&cbtc_asset,&m_cx,&m_cy,&issuer));
bonds.push(BondSettlement{ poolId:pid.into(), reserveTac:U256::from(reserve_tac), totalShares:U256::from(shares_pre) });
```

### OP_BOND_REDEEM (16) — pure conservation, no price
```rust
// reproduce the EXACT bonded position (binds bond_asset, so the released note can't be relabeled)
let bond_asset=r32(); let bond_cx=r32(); let bond_cy=r32(); let cbtc_asset=r32();
let minted:u64=io::read(); let issuer=r32(); let nonce=r32();
let pos=bond_position_leaf(&bond_asset,&bond_cx,&bond_cy,&cbtc_asset,minted,&issuer,&nonce);
let p_idx:u64=io::read(); let p_path=r_path();
assert!(bonded_set_root!=[0u8;32] && keccak_merkle_verify(&pos,p_idx,&p_path,&bonded_set_root), "bond_redeem: position membership");
let pos_nu=nullifier(&bond_cx,&bond_cy); // position spent-once marker (bonded set), distinct domain
// burn cBTC.tac notes summing to EXACTLY `minted`
let ctx=intent_context(b"tacit-bond-redeem-v1",&chain_binding,&cbtc_asset,&bond_asset,&[],&[minted]);
let n_burn:u32=io::read(); let mut burned:u128=0;
for _ in 0..n_burn {
  let (cx,cy,pt)=r_commitment(); let o=r32(); let idx:u64=io::read(); let path=r_path();
  let amt:u64=io::read(); let r=decompress(&r33()).unwrap(); let z=scalar_reduce_be(&r32());
  let lf=leaf(&cbtc_asset,&cx,&cy,&o);
  assert!(keccak_merkle_verify(&lf,idx,&path,&spend_root), "bond_redeem: burn membership");
  let nu=nullifier(&cx,&cy);
  if bitcoin_spent_root!=[0u8;32]{ check_btc_nonmembership(&nu,&bitcoin_spent_root); }
  assert!(verify_opening_sigma(&pt,amt,&r,&z,&ctx), "bond_redeem: burn opening");
  nullifiers.push(nu); burned += amt as u128;
}
assert!(burned == minted as u128, "bond_redeem: must burn exactly the minted amount");
positions_spent.push(pos_nu);
leaves.push(leaf(&bond_asset,&bond_cx,&bond_cy,&issuer)); // release the bond LP to the issuer
```

### OP_BOND_SLASH (17) — relay health + liquidation routing (sketch; flags the LP-remove integration)
```rust
// reproduce the position; gate the slash on a relay HEALTH attestation (§5); route the LP to liquidation
let bond_asset=r32(); let bond_cx=r32(); let bond_cy=r32(); let cbtc_asset=r32();
let minted:u64=io::read(); let issuer=r32(); let nonce=r32();
let pos=bond_position_leaf(&bond_asset,&bond_cx,&bond_cy,&cbtc_asset,minted,&issuer,&nonce);
let p_idx:u64=io::read(); let p_path=r_path();
assert!(keccak_merkle_verify(&pos,p_idx,&p_path,&bonded_set_root), "bond_slash: position membership");
let anchor=r32(); let h_sig=r_n::<64>();
assert!(verify_bond_slash_health(&pos,&anchor,&h_sig,&BOND_ORACLE_PUBKEY_X), "bond_slash: health gate");
positions_spent.push(nullifier(&bond_cx,&bond_cy));
// LIQUIDATION (flag — reuse the OP_LP_REMOVE machinery): the bonded LP note is removed from the pool
// (reserves decrease, the legs become fresh A/B notes owned by the LIQUIDATION sink, not the issuer),
// then routed to an asset-settled bid / auction whose proceeds cover the position's cBTC.tac; the
// insurance floor covers a residual shortfall. The issuer does NOT get the bond back (the slash penalty).
// This is the heaviest integration — it composes OP_LP_REMOVE's reserve-decrease + the liquidation
// venue; specify the coverage-binding + the sink owner with the guest+contract owner.
```

**Adversarial box fixtures to add with the dispatch:** under-burn-frees-bond rejects; a relabel of the
released note (different `bond_asset`) rejects (now leaf-bound); `ν_position` double-spend (redeem then
slash, or twice) rejects; a fake-high reserve (gated by `BondSettlement` vs the live pool) rejects;
a normal `OP_TRANSFER`/`OP_LP_REMOVE` of a bonded note rejects (it isn't in the note tree).
