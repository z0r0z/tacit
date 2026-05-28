# SPEC §6 Amendment — cUSD.tac (TAC-Bonded USD-Pegged Stablecoin)

> **STATUS: DRAFT** (2026-05-17). Defines `cUSD.tac`, tacit's
> canonical USD-pegged stablecoin. Mechanically parallel to
> `cBTC.tac` (per `SPEC-CBTC-TAC-AMENDMENT.md`): users open a
> position by locking a `cBTC.zk` slot + a (TAC, tETH) LP bond and
> minting cUSD.tac against the slot's BTC value at oracle-derived
> USD price. The oracle is the on-chain `cBTC.tac/cUSD.tac` AMM pool
> TWAP, externally anchored via arbitrage through the cBTC.zk → BTC
> redemption chain. No attester-based oracle infrastructure required.
>
> Companion to:
> - `SPEC-CBTC-ZK-AMENDMENT.md` (whole-slot trustless wrapper —
>   provides the slot primitive used as collateral)
> - `SPEC-CBTC-TAC-AMENDMENT.md` (TAC/tETH-bonded fractional cBTC —
>   provides the other side of the canonical oracle AMM pool)
> - `SPEC-GOVERNANCE-AMENDMENT.md` (governance framework — cUSD.tac
>   parameters opt into bounded governance per §6.13)
>
> Adds three new envelope opcodes:
> - `T_CUSD_TAC_DEPOSIT` (`0x54`) — open cUSD.tac position by locking
>   slot + TAC bond, mint cUSD.tac
> - `T_CUSD_TAC_WITHDRAW` (`0x55`) — close position by burning
>   cUSD.tac, recover slot + bond
> - `T_CUSD_TAC_FORCE_CLOSE` (`0x56`) — permissionless liquidation
>   when collateral ratio drops below threshold
>
> Plus reuses `T_SHARE_SLASH_CLAIM` (`0x4C`) for pooled slash insurance
> (defined in SPEC-CBTC-TAC-AMENDMENT §5.39.4; extended to handle
> cUSD.tac shares).
>
> **Trust profile.** cUSD.tac is over-collateralized in cBTC.zk slot
> BTC + a bond that evolves to the same **(TAC, tETH) LP** bond as
> cBTC.tac (`SPEC-CBTC-TAC-COLLATERAL-AMENDMENT.md` §5.52 — half-
> exogenous, risk-priced by a governable IL-aware ratio). USD peg is maintained by external arbitrage
> through the redemption chain (cUSD.tac → cBTC.tac → BTC → real
> USD via off-tacit markets). Same MakerDAO-shape soundness as
> cBTC.tac, with USD targeting instead of BTC targeting.
>
> **Architectural simplification vs. earlier drafts.** This amendment
> supersedes the earlier `SPEC-CUSD-CDP-AMENDMENT.md` which used an
> attester-based BTC/USD oracle (§6.1 T_PRICE_ATTEST) and a per-user
> DLC with oracle-threshold co-signer. The unified AMM-oracle
> architecture eliminates the attester infrastructure entirely:
> price discovery happens organically via the cBTC.tac/cUSD.tac
> AMM pool, anchored by external BTC/USD markets through
> arbitrage. No attester ceremony, no FROST signing rounds, no
> adaptor-sig DLC complexity.

---

## Motivation

Tacit needs a USD-pegged stablecoin for:
- Pricing other tacit assets in familiar units
- Stable-value transactions (payments, settlements)
- Composability with downstream protocols expecting USD-denominated values

The standard CDP-shape design (MakerDAO, Liquity) gives this:
lock BTC collateral, mint USD-pegged tokens against oracle-priced
backing, liquidate when undercollateralized.

The architectural question is *what oracle*. Earlier drafts proposed
an attester-based BTC/USD oracle with bonded LP-staked attesters,
threshold-signing price feeds, slashable misbehavior detection,
etc. — substantial infrastructure (~600 lines of spec, separate
trusted-setup ceremony, ongoing operational complexity).

This amendment uses a simpler approach: **the on-chain
cBTC.tac/cUSD.tac AMM pool is the oracle**. External arbitrageurs
anchor the pool's price to real-world BTC/USD markets by trading
through the redemption chain:

```
cUSD.tac → (AMM swap) → cBTC.tac → (withdraw) → cBTC.zk slot
                                        → (slot burn) → real BTC
                                                          → (external market) → USD
```

If cUSD.tac trades below $1 on tacit:
- Arbitrageur buys cheap cUSD.tac
- Swaps via AMM → cBTC.tac → BTC
- Sells BTC for real USD externally
- Pockets the difference
- Their buying pressure raises cUSD.tac toward $1

If cUSD.tac trades above $1 on tacit:
- Arbitrageur mints new cUSD.tac via T_CUSD_TAC_DEPOSIT
- Sells on AMM at premium
- Pockets the spread
- Their selling pressure lowers cUSD.tac toward $1

This is the same external-arbitrage mechanism that maintains DAI's
peg against ETH-USD reality — except tacit's redemption chain
routes through cBTC.tac and the slot wrapper instead of through
direct ETH custody. Peg robustness scales with the cBTC.tac/cUSD.tac
pool's depth: deeper pool = tighter peg.

The same (TAC, tETH)-bonded mechanics that power cBTC.tac power cUSD.tac.
Operators bond TAC, slashable on rug; force-close liquidates under-
collateralized positions; pooled insurance compensates holders for
any rug events. The structural symmetry with cBTC.tac means most
of the validator and dapp infrastructure can be shared.

---

## Governance principles

Same as cBTC.tac (`SPEC-CBTC-TAC-AMENDMENT.md`): mechanical defaults
with bounded TAC DAO governance. cUSD.tac registers as a target
amendment under `SPEC-GOVERNANCE-AMENDMENT.md` §6.1.1 with
`amendment_id = SHA256("SPEC-CUSD-TAC-AMENDMENT-v1")`. Governable
parameters (§6.13) operate within safety bands; load-bearing
mechanics (slashing, conservation, settlement, cryptographic
primitives) are immutable.

Day-1 governance per the same activation pattern as cBTC.tac:
cUSD.tac and cBTC.tac and the governance framework launch together.

---

## §6.1 cUSD.tac asset

### 6.1.1 Definition

cUSD.tac is a standard tacit-protocol asset with:

- `asset_id`: deterministic, derived from the protocol's canonical
  wrapper-asset namespace; fixed at activation
- `decimals`: 6 (matching USDC/USDT convention for USD stablecoins)
- `ticker`: `cUSD.tac`
- `wrapper convention`: `tacit_wrapper.kind = "protocol_bonded"`,
  `underlying.asset = "usd"`, `peg.kind = "oracle_priced"`
- Transfers via standard `T_AXFER_VAR`, trades via standard tacit
  AMM and orderbook
- Amount-private at the share level (Pedersen-committed)

### 6.1.2 Supply tracking

```
outstanding_cusd_tac_supply(H) = Σ unspent cUSD.tac UTXO amounts
                              = mint_total(H) − burn_total(H)
```

Where mint_total is cumulative cUSD.tac minted by T_CUSD_TAC_DEPOSIT
envelopes, burn_total cumulative cUSD.tac burned by
T_CUSD_TAC_WITHDRAW, T_CUSD_TAC_FORCE_CLOSE, and T_SHARE_SLASH_CLAIM
envelopes.

### 6.1.3 Aggregate backing

```
aggregate_BTC_backing_cusd(H) = Σ unspent K_btc UTXOs of active
                                  cUSD.tac collateral slots
aggregate_TAC_collateral_cusd(H) = Σ unspent TAC in active cUSD.tac
                                     position bonds
insurance_pool_TAC_cusd(H) = Σ TAC moved to insurance pool from
                               cUSD.tac SLASH_DETECTED events
```

These are tracked separately from cBTC.tac's pools to prevent
cross-contamination of solvency state between the two products.

### 6.1.4 Per-share intrinsic value (informative)

```
fair_value_per_cusd_tac_USD(H) =
  (aggregate_BTC_backing_cusd × BTC_USD_price(H)
   + insurance_pool_TAC_cusd × TAC_USD_price(H))
  / outstanding_cusd_tac_supply
```

Where BTC_USD_price and TAC_USD_price come from the canonical AMM
oracle (§6.7). Under healthy operation with 150% collateralization,
fair value sits at $1.00; the per-share value rises slightly after
rugs (insurance pool grows from over-collateral) and stays at $1
across normal price movements (collateral adjusts but the issued
cUSD.tac per position is fixed at mint time).

The market price discovers actual exchange rate via the
cBTC.tac/cUSD.tac AMM pool plus other cUSD.tac trading venues.

---

## §6.2 Position model

### 6.2.1 Position structure

```
cusd_position[target_leaf_hash] := {
  depositor_recovery_pubkey: PubKey,
  slot_leaf_hash:            32 bytes,
  slot_K_btc:                33 bytes,
  slot_denom_sats:           u64,
  mint_amount_cusd:          u64,            // cUSD.tac minted
  bond_amount_TAC:           u64,            // TAC locked as bond
  bond_TAC_outpoint:         OutPoint,
  initial_btc_usd_TWAP:      u64,            // BTC/USD price at deposit
  initial_collateral_ratio:  f64,            // BTC value / cUSD.tac value at deposit
  state:                     "active" | "withdrawn" | "force-closed" | "rugged",
  deposit_height:            u32,
  last_fee_event_height:     u32,            // for lazy stability fee accrual
  params_snapshot:           PositionParams,  // governance params at deposit-time
}
```

The position structure mirrors cBTC.tac's position structure
(`SPEC-CBTC-TAC-AMENDMENT.md` §5.35.1), with the additional
`initial_btc_usd_TWAP` field for USD-pegged accounting.

### 6.2.2 Collateral composition

A cUSD.tac position is backed by:

- **cBTC.zk slot** (locked) — the slot's underlying BTC UTXO at
  `K_btc` is the primary collateral. The slot's state transitions
  from `live` to `cusd_collateralized` while the position is open.
- **TAC bond** (locked in escrow) — secondary collateral that's
  slashable if the depositor rugs the slot's K_btc. Bond size at
  deposit: `bond_amount_TAC ≥ INITIAL_BOND_RATIO × mint_amount_cusd`
  in TAC at TWAP price.

The slot's `r_btc` remains with the depositor (self-custody;
cBTC.zk is trustless). Rug protection is economic via the TAC bond,
not cryptographic via DLC custody — matching cBTC.tac's design
philosophy.

### 6.2.3 Collateral ratio definition

```
btc_value_USD(position, H) = slot_denom_sats × BTC_USD_price(H)
collateral_ratio(position, H) = btc_value_USD(position, H)
                              / mint_amount_cusd
```

Where `BTC_USD_price(H)` is the canonical oracle (§6.7) at block H.

A position is healthy when `collateral_ratio ≥ LIQUIDATION_RATIO`
(default 1.50, governable per §6.13).

---

## §6.3 T_CUSD_TAC_DEPOSIT — open cUSD.tac position

### 6.3.1 Wire format

```
T_CUSD_TAC_DEPOSIT
   opcode                 1 byte   (0x54)
   network_tag            1 byte
   target_leaf_hash       32 bytes (the cBTC.zk slot used as collateral;
                                    must be in `live` state)
   slot_denom_sats_LE     8 bytes  (u64; copied from leaf record for binding)
   bond_amount_TAC_LE     8 bytes  (u64; TAC bond size)
   bond_source_outpoint   36 bytes (TAC UTXO consumed for bond)
   bond_commit            33 bytes (Pedersen commit of the TAC bond UTXO)
   depositor_recovery_pk  33 bytes (where withdraw payout goes)
   mint_amount_cusd_LE    8 bytes  (u64; cUSD.tac to mint; subject to LTV check)
   mint_recipient_commit  33 bytes (Pedersen commit for the new cUSD.tac UTXO)
   bind_hash              32 bytes
   proof_length           2 bytes  (u16 LE)
   groth16_proof          VAR bytes (slot ownership + TAC asset-spend)
```

### 6.3.2 Validator algorithm

```
on T_CUSD_TAC_DEPOSIT at block H:
  require envelope.network_tag matches local network
  require target_leaf_hash references existing cBTC.zk slot
  require leaf_state[target_leaf_hash] == "live"
  require slot_denom_sats == leaf_record.denom_sats
  require Bitcoin UTXO at slot_K_btc is unspent (chain observation)
  require cusd_position[target_leaf_hash] does not exist

  // TAC bond + slot ownership proofs
  require bond_source_outpoint references unspent TAC UTXO
  require bond_commit == utxo.pedersen_commit
  require groth16_verify(ASSET_SPEND_VK, envelope.proof.bond_spend_part,
                         public_signals=[bond_commit, bond_amount_TAC])
  require groth16_verify(MIXER_WITHDRAW_VK, envelope.proof.slot_part,
                         public_signals=[leaf_record.recipient_commit,
                                          leaf_record.nullifier_hash, ...])

  // Oracle: read BTC/USD from canonical AMM pool TWAP
  P_btc_usd = oracle_btc_usd_TWAP(at_block = H − REORG_SAFETY_DEPTH)
  P_tac_btc = oracle_tac_btc_TWAP(at_block = H − REORG_SAFETY_DEPTH)

  // LTV check: mint_amount ≤ slot_value × LTV_FACTOR
  slot_value_USD = slot_denom_sats × P_btc_usd
  max_mint_USD = slot_value_USD × LTV_FACTOR  // e.g., 0.66 = 150% collateral
  require mint_amount_cusd ≤ max_mint_USD

  // Bond ratio check: bond TAC value ≥ INITIAL_BOND_RATIO × mint_amount in BTC
  bond_value_BTC = bond_amount_TAC × P_tac_btc
  required_bond_BTC = INITIAL_BOND_RATIO × mint_amount_cusd / P_btc_usd
  require bond_value_BTC ≥ required_bond_BTC

  // Aggregate exposure caps
  prospective_total_cusd_USD = outstanding_cusd_tac_supply + mint_amount_cusd
  require prospective_total_cusd_USD × ratio_check ≤ MAX_CUSD_EXPOSURE_CAPS

  // Effects
  cusd_position[target_leaf_hash] = {
    depositor_recovery_pubkey: depositor_recovery_pk,
    slot_leaf_hash: target_leaf_hash,
    slot_K_btc: leaf_record.K_btc,
    slot_denom_sats: slot_denom_sats,
    mint_amount_cusd: mint_amount_cusd,
    bond_amount_TAC: bond_amount_TAC,
    bond_TAC_outpoint: deposit_bond_to_escrow(bond_source_outpoint),
    initial_btc_usd_TWAP: P_btc_usd,
    initial_collateral_ratio: slot_value_USD / mint_amount_cusd,
    state: "active",
    deposit_height: H,
    last_fee_event_height: H,
    params_snapshot: current_governance_params(),
  }
  leaf_state[target_leaf_hash] = "cusd_collateralized"
  spend(bond_source_outpoint)
  mint_asset_utxo(asset_id = cUSD.tac,
                  pedersen_commit = mint_recipient_commit,
                  amount = mint_amount_cusd)
  emit cusd_deposit_event(target_leaf_hash, mint_amount_cusd, bond_amount_TAC)
```

### 6.3.3 bind_hash construction

```
bind_hash = SHA256(
  "tacit-cusd-tac-deposit-v1"
  || network_tag
  || target_leaf_hash
  || slot_denom_sats_LE
  || bond_amount_TAC_LE
  || bond_source_outpoint
  || bond_commit
  || depositor_recovery_pk
  || mint_amount_cusd_LE
  || mint_recipient_commit
)
```

---

## §6.4 T_CUSD_TAC_WITHDRAW — close cUSD.tac position

### 6.4.1 Wire format

```
T_CUSD_TAC_WITHDRAW
   opcode                  1 byte   (0x55)
   network_tag             1 byte
   target_leaf_hash        32 bytes (the cUSD.tac position to close)
   burn_count              1 byte   (M ∈ [1, 16]; cUSD.tac UTXOs being burned)
   burn_nullifiers         M × 32 bytes
   burn_commits            M × 33 bytes
   burn_amount_cusd_LE     8 bytes  (must equal position.mint_amount_cusd
                                     plus accrued stability fee in cUSD.tac)
   burn_balance_proof      VAR bytes
   insurance_claim_TAC_LE  8 bytes  (optional pooled insurance claim)
   bind_hash               32 bytes
   proof_length            2 bytes
   groth16_proof           VAR bytes
```

The reveal Bitcoin tx MUST simultaneously spend the slot's K_btc
UTXO under the depositor's r_btc (atomic with the cUSD.tac burn).

### 6.4.2 Validator algorithm

```
on T_CUSD_TAC_WITHDRAW at block H:
  // Standard validation: position exists, state active, etc.
  // [see T_CBTC_TAC_WITHDRAW in SPEC-CBTC-TAC-AMENDMENT §5.37.2 for
  //  parallel logic on slot consumption and bond release]

  // Compute stability fee accrued
  accrued_fee_cusd = position.mint_amount_cusd × STABILITY_FEE_BPS
                    × (H − position.last_fee_event_height) / BLOCKS_PER_YEAR / 10000

  require burn_amount_cusd ≥ position.mint_amount_cusd + accrued_fee_cusd

  // Bitcoin tx atomicity check
  require reveal_tx.vin[0].prevout.script_pubkey == P2TR(position.slot_K_btc)

  // Optional insurance pool claim
  if insurance_claim_TAC > 0:
    per_share_insurance = insurance_pool_TAC_cusd / outstanding_cusd_tac_supply
    require insurance_claim_TAC == burn_amount_cusd × per_share_insurance
    pay_TAC(depositor_recovery_pubkey, insurance_claim_TAC)
    insurance_pool_TAC_cusd -= insurance_claim_TAC

  // Effects
  burn_cusd_tac_utxos(...)
  outstanding_cusd_tac_supply -= burn_amount_cusd
  pay_TAC(position.depositor_recovery_pubkey, position.bond_amount_TAC)
  // Stability fee accrues to insurance pool
  insurance_pool_TAC_cusd += accrued_fee_in_TAC(accrued_fee_cusd)

  cusd_position[target_leaf_hash].state = "withdrawn"
  leaf_state[target_leaf_hash] = "redeemed"
  emit cusd_withdraw_event(target_leaf_hash, burn_amount_cusd)
```

### 6.4.3 bind_hash construction

```
bind_hash = SHA256(
  "tacit-cusd-tac-withdraw-v1"
  || network_tag
  || target_leaf_hash
  || burn_count
  || burn_nullifiers
  || burn_commits
  || burn_amount_cusd_LE
  || insurance_claim_TAC_LE
)
```

---

## §6.5 T_CUSD_TAC_FORCE_CLOSE — automatic liquidation

### 6.5.1 Trigger condition

When `collateral_ratio(position) < LIQUIDATION_RATIO`, anyone may
submit `T_CUSD_TAC_FORCE_CLOSE` to permissionlessly liquidate.

### 6.5.2 Wire format

```
T_CUSD_TAC_FORCE_CLOSE
   opcode                  1 byte   (0x56)
   network_tag             1 byte
   target_leaf_hash        32 bytes
   liquidator_payout_pk    33 bytes (cUSD.tac payout for liquidator reward)
   amm_swap_min_BTC_out_LE 8 bytes  (slippage protection for TAC → BTC swap)
   bind_hash               32 bytes
```

### 6.5.3 Cascade rate-limit + validator

Same pattern as cBTC.tac force-close (`SPEC-CBTC-TAC-AMENDMENT.md`
§5.38). As with cBTC.tac, the bond → output-asset conversion SHOULD
route through the covenant-free orderbook liquidation venue
(`SPEC-LIQ-BID-AMENDMENT.md`, `T_PREAUTH_BID_ASSET` `0x5E`) settling in
cUSD.tac — a competitive standing-bid auction rather than a reflexive
AMM dump — degrading to early-slash when the bid book is thin. The
liquidator triggers, the indexer:

1. Verifies position state and current_ratio < LIQUIDATION_RATIO
2. Applies cascade rate-limit (priority by lowest ratio, max
   `MAX_FORCE_CLOSES_PER_BLOCK = 5`)
3. Applies liquidation penalty (2% of bond_amount_TAC to insurance
   pool)
4. Swaps remaining bond TAC for cUSD.tac via the canonical AMM
5. Burns `swap_cUSD_output` worth of cUSD.tac from circulation to
   match the position's mint_amount + accrued fee
6. Credits redemption_reserve_cusd with any swap residue
7. Pays liquidator a 50 bps reward in BTC equivalent (50 bps of
   swap output)
8. Position state → "force-closed"; slot state → "force-closed";
   depositor's K_btc returns to private custody

---

## §6.6 Rug detection and pooled insurance

### 6.6.1 INV-1 monitoring

Same as cBTC.tac (`SPEC-CBTC-TAC-AMENDMENT.md` §5.39.1): indexers
monitor the Bitcoin UTXO at every active cUSD.tac position's
`slot_K_btc`. A rug is detected when the UTXO is spent without a
matching T_CUSD_TAC_WITHDRAW or T_CUSD_TAC_FORCE_CLOSE, buried
under `REORG_SAFETY_DEPTH = 6` blocks.

### 6.6.2 SLASH_DETECTED automatic event

Same shape as cBTC.tac §5.39.2:

```
SLASH_DETECTED(cusd_position[L]):
  require cusd_position[L].state == "active"
  require rug_detected_at_depth(L, REORG_SAFETY_DEPTH)

  insurance_pool_TAC_cusd += cusd_position[L].bond_amount_TAC
  cusd_position[L].state = "rugged"
  leaf_state[L] = "rugged"
  emit cusd_slot_rugged_event(L, bond_TAC_seized)
```

### 6.6.3 Pooled insurance value + claims

cUSD.tac holders may claim against the insurance pool via
T_SHARE_SLASH_CLAIM (defined in SPEC-CBTC-TAC-AMENDMENT §5.39.4;
this amendment extends it to support cUSD.tac shares).

```
per_share_insurance_cusd(H) = insurance_pool_TAC_cusd(H)
                            / outstanding_cusd_tac_supply(H)
```

Claims work identically to cBTC.tac: burn cUSD.tac, receive
proportional TAC from the insurance pool. Uniform across all
cUSD.tac holders regardless of which slot rugged.

The cUSD.tac insurance pool is SEPARATE from the cBTC.tac
insurance pool. Each asset has its own pool with its own per-share
backing.

---

## §6.7 Price oracle

### 6.7.1 Canonical AMM-based oracle

cUSD.tac requires two price feeds:

1. **TAC/BTC price**: for bond_ratio computation. Read from the
   canonical TAC/cBTC.zk AMM pool TWAP (same source as cBTC.tac
   per `SPEC-CBTC-TAC-AMENDMENT.md` §5.40).

2. **BTC/USD price**: for LTV check + collateral_ratio computation.
   Read from the canonical cBTC.tac/cUSD.tac AMM pool TWAP. Since
   cBTC.tac ≈ 1 BTC (modulo small AMM dynamics) and cUSD.tac ≈ $1
   (modulo external arbitrage), the pool ratio gives BTC/USD price
   directly.

```
BTC_USD_price(H) = canonical_cBTC.tac_cUSD.tac_AMM_TWAP(at H)
TAC_BTC_price(H) = canonical_TAC_cBTC.zk_AMM_TWAP(at H)
```

### 6.7.2 External anchoring via arbitrage

The cBTC.tac/cUSD.tac pool's BTC/USD ratio is anchored to external
markets through the redemption chain:

```
cUSD.tac → (AMM) → cBTC.tac → (withdraw) → cBTC.zk slot → (burn) → BTC
                                                        → (external) → USD
```

External arbitrageurs profit from any divergence between tacit's
implied BTC/USD rate and external BTC/USD markets, closing the gap
via the redemption chain. The on-chain TWAP captures the
equilibrium price set by this arbitrage.

### 6.7.3 Bootstrap considerations

The cBTC.tac/cUSD.tac pool requires meaningful liquidity for the
oracle to be manipulation-resistant. Bootstrap path:

1. Initial protocol-owned liquidity at launch (e.g., 100k cBTC.tac
   + 6M cUSD.tac at $60k/BTC initial seeding)
2. Open public LP participation immediately
3. Conservative initial parameters (3x bond ratio, 2x liquidation
   ratio) tightening as pool deepens
4. Bootstrap minimum pool depth requirement: ≥ 1M cUSD.tac before
   new deposits accepted at production parameters

If pool depth drops below minimum, `PAUSE_NEW_DEPOSITS` triggers
automatically. Existing positions continue to operate; new mints
refused until depth recovers.

### 6.7.4 Manipulation resistance

Same as cBTC.tac (`SPEC-CBTC-TAC-AMENDMENT.md` §5.40.2):
- 180-block TWAP window naturally resists short-term manipulation
- Outlier rejection: observations > 3σ from rolling mean discarded
- Per-position exposure caps prevent single-actor leverage
- Stale-price refusal: no observations in 1000 blocks pauses deposits

---

## §6.8 Fixed parameters

```
INITIAL_BOND_RATIO         = 1.5     (150% TAC bond vs cUSD.tac value)
WARNING_RATIO              = 1.3     (warning when collateral drops below 130%)
LIQUIDATION_RATIO          = 1.2     (force-close trigger at 120%)
LTV_FACTOR                 = 0.66    (max 66% of slot value can be minted as cUSD.tac)
LIQUIDATOR_REWARD_FRACTION = 0.005   (50 bps of swap value)
LIQUIDATION_PENALTY_BPS    = 200     (2% of bond at force-close → insurance)
STABILITY_FEE_BPS          = 50      (0.5% APR on outstanding cUSD.tac)
AGGREGATE_RECOVERY_RATIO   = 1.4     (system-level recovery mode trigger)
RECOVERY_EXIT_BLOCKS       = 100     (sustained recovery before exit)
TWAP_WINDOW                = 180 blocks (~30 min)
REORG_SAFETY_DEPTH         = 6 blocks
MAX_FORCE_CLOSES_PER_BLOCK = 5
STALE_PRICE_BLOCKS         = 1000    (~7 days, oracle freshness)
BLOCKS_PER_YEAR            = 52596   (Bitcoin block target)
MAX_POSITION_CUSD          = 1_000_000 (1M cUSD.tac per position, ~$1M)
VOTE_TENURE_BLOCKS         = 100
```

All values are fixed at launch defaults. A subset is tunable by
TAC DAO governance within safety bands (§6.13).

---

## §6.9 Robustness mechanics

Parallel to cBTC.tac (`SPEC-CBTC-TAC-AMENDMENT.md` §5.45):

### 6.9.1 Stability fee
Continuous fee on outstanding cUSD.tac per position, accrued lazily
per event:
```
fee_per_block = position.mint_amount_cusd × STABILITY_FEE_BPS
              / 10000 / BLOCKS_PER_YEAR
```
Accrued to insurance pool at every position event (top-up,
withdraw, force-close). At withdraw, depositor must burn
`mint_amount + accrued_fee` cUSD.tac. The accrued fee is converted
to TAC at TWAP and deposited into `insurance_pool_TAC_cusd`.

### 6.9.2 Liquidation penalty
2% of bond_amount_TAC at force-close, taken in TAC before AMM swap,
deposited to `insurance_pool_TAC_cusd`. Discourages near-threshold
positions, builds insurance buffer.

### 6.9.3 Aggregate recovery mode
Triggers when `aggregate_collateral_ratio_cusd < 1.4x`:
```
aggregate_collateral_ratio_cusd = (Σ active position collateral USD value)
                                / outstanding_cusd_tac_supply_USD
```
Effects: liquidation threshold tightens from 1.2x to 1.4x; new
deposits pause; withdraw/force-close continue normally. Exits when
ratio recovers above 1.4x for 100 blocks.

---

## §6.10 Auto-buy integration

Same pattern as cBTC.tac (`SPEC-CBTC-TAC-AMENDMENT.md` §5.36.4):
users holding only BTC can mint cUSD.tac via an atomic flow:

1. T_SLOT_MINT — wrap BTC into cBTC.zk slot
2. T_AMM_SWAP — swap portion of slot value to TAC for bond
3. T_CUSD_TAC_DEPOSIT — open cUSD.tac position with slot + auto-bought bond

All three packaged in one Bitcoin reveal transaction.

---

## §6.11 Activation

cUSD.tac activates jointly with cBTC.tac at launch. Conditions:

1. cBTC.zk infrastructure (base + FUNGIBILITY amendments) live
2. cBTC.tac infrastructure (per SPEC-CBTC-TAC-AMENDMENT) live
3. Canonical TAC/cBTC.zk AMM pool with ≥ 1M TAC depth
4. Canonical cBTC.tac/cUSD.tac AMM pool with ≥ 1M cUSD.tac
   protocol-owned liquidity at activation
5. Worker and dapp implementations of T_CUSD_TAC_* envelopes
   deployed and verified
6. Governance framework (per SPEC-GOVERNANCE-AMENDMENT) live

Until all six conditions hold, T_CUSD_TAC_DEPOSIT envelopes are
refused by indexers.

---

## §6.12 Default product surface: `cUSD.tac.lp`

Parallel to cBTC.tac.lp. For users wanting yield-bearing cUSD.tac
exposure, the recommended default is `cUSD.tac.lp`, the LP token
of the canonical cBTC.tac/cUSD.tac AMM pool. Holding cUSD.tac.lp
provides:

- ~1 USD exposure per unit (modulo pool composition + IL)
- AMM swap fees (30 bps × volume)
- Composability as a standard tacit-asset LP token

Users wanting pure cUSD.tac (clean USD tracking with no IL) hold
raw cUSD.tac. Users wanting yield-bearing exposure hold
cUSD.tac.lp. Same self-selection pattern as cBTC.tac / cBTC.tac.lp.

---

## §6.13 Scoped TAC DAO governance

cUSD.tac registers as a target amendment under
`SPEC-GOVERNANCE-AMENDMENT.md`:

```
amendment_id = SHA256("SPEC-CUSD-TAC-AMENDMENT-v1")
```

### 6.13.1 Tier A — slow governance (14-day timelock)

| Parameter | Default | Safety band |
|---|---|---|
| `INITIAL_BOND_RATIO` | 1.5 | [1.2, 3.0] |
| `LIQUIDATION_RATIO` | 1.2 | [1.1, 2.0] |
| `LTV_FACTOR` | 0.66 | [0.5, 0.85] |
| `STABILITY_FEE_BPS` | 50 | [0, 500] |
| `LIQUIDATION_PENALTY_BPS` | 200 | [0, 500] |
| `AGGREGATE_RECOVERY_RATIO` | 1.4 | [1.2, 2.0] |
| `MAX_POSITION_CUSD` | 1M | [10k, 100M] |
| `TWAP_WINDOW` | 180 blocks | [60, 1440] |

### 6.13.2 Tier B — fast governance (24-hour timelock)

- Manual pause / unpause triggers
- Oracle stale-price threshold
- Cascade rate-limit (max force-closes per block)

### 6.13.3 Tier C — treasury (14-day timelock)

- Insurance pool residue destination (after 12 months unclaimed)
- Stability fee accrual override (if needed)
- Per-proposal scoping per SPEC-GOVERNANCE-AMENDMENT §6.X (exact
  destination, exact amount, one-shot, bounded execution window)

### 6.13.4 Hard limits — IMMUTABLE

- Cryptographic primitives (Pedersen, Groth16, Poseidon, secp256k1)
- Slashing mechanics (INV-1 break → SLASH_DETECTED → insurance pool)
- Conservation invariants
- Atomic settlement (withdraw must atomically burn cUSD.tac + spend
  K_btc)
- Retroactivity prohibition
- Opcode assignments
- The trust model itself (TAC/tETH-bonded, AMM-priced)

---

## §6.14 Opcode table

Add to §3 *opcodes table*:

- `0x54` `T_CUSD_TAC_DEPOSIT` — open cUSD.tac position (§6.3)
- `0x55` `T_CUSD_TAC_WITHDRAW` — close cUSD.tac position (§6.4)
- `0x56` `T_CUSD_TAC_FORCE_CLOSE` — permissionless liquidation (§6.5)

`T_SHARE_SLASH_CLAIM` (`0x4C`) from `SPEC-CBTC-TAC-AMENDMENT.md` is
reused for cUSD.tac insurance claims (with `asset_id` discriminating
between cBTC.tac and cUSD.tac).

No oracle-related opcodes — the previous T_PRICE_ATTEST,
T_ORACLE_JOIN, T_ORACLE_SLASH, T_ORACLE_GRADUATE,
T_ORACLE_EMERGENCY_DKG, T_ORACLE_LEAVE, T_CDP_ADAPTOR_BACKUP
opcodes (0x39–0x42 in earlier drafts) are RETIRED. The AMM-oracle
architecture eliminates the need for them.

---

## Test plan

1. **Healthy lifecycle**: deposit → cUSD.tac in circulation →
   transfer → withdraw → recover slot + bond.
2. **Auto-buy mint**: single Bitcoin tx wrapping + swapping for TAC
   bond + minting cUSD.tac.
3. **Force-close path**: deposit, simulate TWAP drift, liquidation
   executes.
4. **Cascade rate-limit**: 50 positions simultaneously liquidatable,
   verify only MAX_FORCE_CLOSES_PER_BLOCK execute per block.
5. **Rug detection + slash**: deposit, rug, slash fires, insurance
   pool grows.
6. **Pooled insurance claim**: holders burn cUSD.tac for TAC.
7. **AMM-oracle anchoring**: simulate external BTC/USD price moves,
   verify on-chain TWAP follows via arbitrage.
8. **Pool-depth bootstrap gating**: deposits refused when
   cBTC.tac/cUSD.tac pool depth < minimum.
9. **Aggregate recovery mode**: trigger and exit verification.
10. **Stability fee accrual**: long-duration position with correct
    fee → insurance flow at withdraw.
11. **Reorg-stable TWAP**: reorg depth ≤ 5 doesn't change deposits'
    decisions.
12. **Governance integration**: parameter changes apply
    prospectively, existing positions retain snapshot params.

---

## Open questions

1. **Insurance pool sharing**: should cBTC.tac and cUSD.tac share
   one insurance pool (cleaner risk pool) or maintain separate
   pools (less cross-contamination)? V1 ships with separate pools;
   sharing can be added as a future amendment if useful.

2. **Cross-collateralization**: should users be able to use one
   slot as collateral for both a cBTC.tac position AND a cUSD.tac
   position simultaneously? Currently no (one slot = one position
   maximum). Could enable in future if demand justifies.

3. **Initial protocol-owned liquidity sourcing**: how does the
   protocol fund the cBTC.tac/cUSD.tac pool's initial seed? Options:
   (a) launch grant from TAC treasury, (b) initial LP mining
   rewards, (c) pre-launch liquidity bootstrapping auction. Decide
   pre-launch.

4. **External BTC/USD price feeds for arbitrage**: arbitrageurs
   need access to external BTC/USD reference. Could be Coinbase /
   Kraken / Binance public APIs; could be CEX OHLC feeds; could be
   on-chain reference (e.g., a federation-attested off-chain
   oracle for backstop). The protocol itself doesn't read these
   — arbitrageurs do, and they're free to use any reference.

5. **cUSD.tac depeg recovery**: if pool liquidity becomes
   insufficient and cUSD.tac depegs significantly, what's the
   recovery path? Tier B emergency pause + governance proposal
   to restore. Tail-risk; well-bounded by aggregate recovery mode.

6. **Cross-pair AMM oracles**: should other cBTC.tac pairs (e.g.,
   cBTC.tac/cBTC.zk) also contribute to the BTC/USD oracle via
   triangular composition? Could improve oracle robustness but
   adds complexity. Defer.

---

## Summary

cUSD.tac is tacit's canonical USD-pegged stablecoin, mechanically
parallel to cBTC.tac. Users open a position by locking a cBTC.zk
slot + a (TAC, tETH) LP bond and minting cUSD.tac. The peg is
maintained by external arbitrage through the cBTC.tac/cUSD.tac AMM
pool: arbitrageurs trading against external BTC/USD markets anchor
the pool's price to USD reality, and the on-chain TWAP captures
the equilibrium.

The architecture eliminates the need for attester-based oracle
infrastructure. Every oracle the protocol needs is an AMM TWAP
plus external-market arbitrage. The cUSD.tac and cBTC.tac products
share most of their mechanics (bond, slash, force-close, insurance,
recovery mode, governance scope) — they differ only in their output
tokens and the specific AMM pool serving as their oracle.

Trust profile:
- (TAC, tETH) LP over-collateralization (slashable on rug)
- AMM oracle (anchored by external arbitrage)
- No federation, no attesters, no DLC, no oracle ceremony
- Bounded TAC DAO governance with hard limits

This is the cleanest available stablecoin design for a privacy
protocol on Bitcoin without covenants: economic security through
over-collateralization, oracle via AMM, USD anchoring via the
free market.
