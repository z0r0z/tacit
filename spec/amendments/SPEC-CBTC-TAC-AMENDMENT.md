# SPEC §5.34–§5.44 Amendment — cBTC.tac (Canonical Wrapped Bitcoin)

> **STATUS: DRAFT** (2026-05-17). Defines `cBTC.tac`, tacit's
> canonical fungible wrapped-Bitcoin asset. Users mint cBTC.tac via
> an LP-shaped deposit (cBTC.zk slot + TAC) and burn it to recover
> their underlying assets. The TAC contribution serves as over-
> collateralization, making the system trustless without federation:
> any operator who tries to rug their slot's backing Bitcoin loses
> their TAC contribution to a shared insurance pool, which uniformly
> compensates outstanding cBTC.tac holders.
>
> Companion to:
> - `SPEC-CBTC-ZK-AMENDMENT.md` (whole-slot trustless wrapper —
>   defines `cBTC.zk`, the entry-path asset)
> - `SPEC-CBTC-ZK-AMOUNT-AMENDMENT.md` (fractionalize/reconsolidate
>   wire format and validator machinery)
> - `SPEC-CBTC-ZK-FUNGIBILITY-AMENDMENT.md` (SPLIT/MERGE/NOTE for
>   cBTC.zk denomination flexibility)
>
> Adds three new envelope opcodes:
> - `T_CBTC_TAC_DEPOSIT` (`0x49`) — LP-shaped mint: cBTC.zk + TAC → cBTC.tac
> - `T_CBTC_TAC_WITHDRAW` (`0x4A`) — LP-shaped burn: cBTC.tac → cBTC.zk + TAC
> - `T_CBTC_TAC_FORCE_CLOSE` (`0x4B`) — permissionless liquidation when
>   a position's TAC collateral ratio falls below threshold
>
> Plus one indexer-internal state event (NOT an opcode):
> - `SLASH_DETECTED` — automatic state transition triggered by INV-1
>   break (slot's K_btc spent without matching T_SLOT_BURN). Moves
>   the position's TAC contribution to the shared insurance pool.
>
> **Trust profile.** cBTC.tac is **not** trustless — it is
> over-collateralized in TAC. The trust model is "TAC stays valuable
> enough relative to BTC that bonded slots remain over-margined."
> Same shape as MakerDAO (DAI), Liquity (LUSD), or any over-
> collateralized DeFi construction. **Not** the same shape as WETH on
> Ethereum: WETH's contract holds ETH and cannot be drained outside
> protocol; cBTC.tac shares are economic claims backed by slashable
> collateral. For trustless pure-BTC self-custody, use cBTC.zk.
>
> **No governance.** Every parameter in this amendment is either
> fixed at launch or formulaically derived from chain-observable
> state. There is no DAO, no voting, no proposal mechanism, no
> emergency multisig. Mistakes can only be fixed by a formal SPEC
> amendment (i.e., a hard fork) with deployed worker + dapp updates.
> This is the minimum-blast-radius choice — Uniswap V2-style
> immutability for the wrapper.

---

## Motivation

The cBTC.zk wrapper (`SPEC-CBTC-ZK-AMENDMENT.md`) is the maximally-
trustless wrapped-Bitcoin construction available on Bitcoin today
without covenants. Its trade-off: ownership is unit-granular at fixed
denominations. A user holding a 1 BTC slot cannot trade 0.37 BTC of
their position; they must use the SPLIT/MERGE/ROTATE primitives to
move at slot granularity.

This is fine for whole-coin holders and atomic-trade UX, but it
doesn't compose with standard AMM, lending, and marketplace patterns
that expect amount-granular fungible assets. The DeFi product
ecosystem (pooled liquidity, sub-denomination trading, BTC-paired
markets) requires a fungible wrapped BTC asset.

cBTC.tac is that asset. Mechanically:

1. A user wraps BTC into a cBTC.zk slot (existing primitive).
2. The user **deposits** their cBTC.zk slot + an over-collateralizing
   amount of TAC into a position.
3. The position **mints** cBTC.tac tokens to the user, equal to the
   BTC value of the deposited slot.
4. cBTC.tac is a standard tacit asset — fungible, amount-private,
   AMM-poolable, marketplace-listable, used as any other tacit asset.
5. When the user wants their BTC back, they **withdraw**: burn the
   cBTC.tac tokens, recover their cBTC.zk slot, recover their TAC
   contribution.

The TAC contribution is the trust mechanism. If the user attempts to
spend their slot's underlying Bitcoin UTXO outside the protocol
(rug), their TAC is slashed and moves to a pooled insurance reserve
that compensates all outstanding cBTC.tac holders uniformly. The
slash mechanism makes rugging economically irrational under typical
TAC market depth.

The wrapper looks LP-shaped to users — "deposit two assets, receive
a share token; burn the share, recover the two assets" — which
matches widely-understood DeFi mental models. Mechanically the
"position" is a per-user mint/burn against the global cBTC.tac
supply, with its TAC contribution serving as bond. cBTC.tac itself
is a regular tacit asset; it is not the LP token of any AMM pool.
(Users may LP cBTC.tac into AMM pools downstream — those LP tokens
are separate from cBTC.tac itself.)

---

## Why no governance

Three reasons:

1. **Minimal blast radius.** A protocol with no governance has no
   governance-attack surface. There is no proposal to game, no
   voting to capture, no multisig to compromise. The protocol is
   defined by its code; changes require a formal amendment with
   community-coordinated deployment.

2. **Honest peg semantics.** cBTC.tac is market-priced, not peg-
   defended. There is no "central bank" to intervene if the market
   price diverges from the implied backing. The market discovers
   the actual exchange rate; arbitrage with the deposit/withdraw
   path keeps it close to 1:1 with BTC under normal conditions.

3. **Composability.** Downstream protocols (AMMs, lending, etc.) can
   integrate cBTC.tac knowing its mechanics will never change under
   them. No "the DAO voted to change the collateral ratio" risk.

Every parameter is either fixed at launch (constants) or derived
formulaically from chain-observable state (formulas). The full list
is in §5.41.

---

## §5.34 cBTC.tac asset

### 5.34.1 Definition

cBTC.tac is a standard tacit-protocol asset with:

- `asset_id`: a 32-byte identifier (deterministic, derived from
  the protocol's canonical wrapper-asset namespace; specific value
  fixed at activation per §5.42)
- `decimals`: 8 (matching BTC's satoshi granularity)
- `ticker`: `cBTC.tac`
- `wrapper convention`: `tacit_wrapper.kind = "protocol_bonded"` per
  `SPEC-WRAPPER-AMENDMENT.md`, with `underlying.chain = "bitcoin"`,
  `underlying.asset = "native"`, `underlying.unit = "satoshi"`

It transfers via standard `T_AXFER_VAR`, trades via standard tacit
AMM and orderbook, and is amount-private at the share level (per
tacit's Pedersen-commit asset machinery).

### 5.34.2 Supply

Total cBTC.tac supply at any block H equals:

```
outstanding_supply(H) = Σ unspent cBTC.tac UTXO amounts
                     = mint_total(H) - burn_total(H)
```

Where `mint_total(H)` is the cumulative amount minted by all
`T_CBTC_TAC_DEPOSIT` envelopes confirmed up to height H, and
`burn_total(H)` is the cumulative amount burned by
`T_CBTC_TAC_WITHDRAW` and `T_SHARE_SLASH_CLAIM` envelopes.

### 5.34.3 Aggregate backing

The system maintains:

```
aggregate_BTC_backing(H) = Σ unspent K_btc UTXOs of active positions
aggregate_TAC_collateral(H) = Σ unspent TAC in active position bonds
insurance_pool_TAC(H) = Σ TAC moved to insurance pool via SLASH_DETECTED
```

The invariant the system enforces by construction:

```
INV-MINT: mint_amount ≤ BTC_value(deposited_slot)
                       AND bond_TAC ≥ INITIAL_BOND_RATIO × mint_amount × TWAP
```

(At deposit time, the bond is over-collateralized at the initial
ratio, and the minted cBTC.tac never exceeds the BTC value of the
backing slot.)

### 5.34.4 Per-share intrinsic value

The implied fair value of one cBTC.tac unit (informative, not
protocol-enforced):

```
fair_value_per_share_BTC(H) = (aggregate_BTC_backing(H)
                              + insurance_pool_TAC(H) / TWAP_TAC_per_BTC(H))
                            / outstanding_supply(H)
```

Under healthy conditions (no rugs, well-margined positions),
`fair_value_per_share_BTC ≈ 1.0`. After rugs that triggered insurance
payouts, fair value rises slightly above 1 (the over-collateral
insurance exceeds the lost backing). The market price discovers the
actual exchange rate.

---

## §5.35 Position model

### 5.35.1 Position structure

A "position" is the per-deposit accounting record maintained by the
indexer:

```
position[target_leaf_hash] := {
  depositor_recovery_pubkey: PubKey,   // where withdraw payout goes
  slot_leaf_hash:            32 bytes, // the deposited cBTC.zk slot
  slot_K_btc:                33 bytes, // the slot's Bitcoin UTXO key
  slot_denom_sats:           u64,      // BTC value at deposit
  mint_amount:               u64,      // cBTC.tac minted (= slot_denom_sats)
  bond_amount_TAC:           u64,      // TAC locked as collateral
  bond_TAC_outpoint:         OutPoint, // location of the TAC escrow
  initial_TWAP_at_deposit:   u64,      // TAC/BTC price at deposit
  initial_ratio:             f64,      // bond_TAC × TWAP / slot_denom_sats
  state:                     "active" | "withdrawn" | "force-closed" | "rugged",
  deposit_height:            u32,
}
```

The position is keyed by `target_leaf_hash` (the cBTC.zk slot's
mixer leaf). The bond's TAC UTXO is locked at a deterministic escrow
address derived from the position record (no spending key — moves
only via tacit envelope state transitions).

### 5.35.2 Relationship to underlying assets

A position holds:
- **BTC backing**: the Bitcoin UTXO at `slot_K_btc`. Self-custody by
  the depositor (their `r_btc`). The depositor retains BIP-340
  Schnorr key-path spending authority over the Bitcoin UTXO at all
  times — there is no federation, no multisig, no co-signer.
- **TAC collateral**: the TAC UTXO at `bond_TAC_outpoint`. Locked at
  a protocol-controlled escrow; cannot be spent except via valid
  withdraw, force-close, or slash envelopes.

The cBTC.tac tokens minted by the deposit circulate as standard
tacit-asset UTXOs. They are not tied to a specific position — they
are fungible global supply.

---

## §5.36 T_CBTC_TAC_DEPOSIT — LP-shaped mint

### 5.36.1 Wire format

```
T_CBTC_TAC_DEPOSIT
   opcode                 1 byte   (0x49)
   network_tag            1 byte
   target_leaf_hash       32 bytes (the cBTC.zk slot's leaf hash;
                                    must be in `live` state with
                                    BTC UTXO confirmed at K_btc)
   slot_denom_sats_LE     8 bytes  (u64; copied from leaf record for binding)
   bond_amount_TAC_LE     8 bytes  (u64; TAC amount locked as collateral)
   bond_source_outpoint   36 bytes (TAC UTXO consumed for the bond)
   bond_commit            33 bytes (Pedersen commit of the TAC bond UTXO)
   depositor_recovery_pk  33 bytes (where withdraw payout will go)
   mint_amount_LE         8 bytes  (u64; cBTC.tac to mint;
                                    must equal slot_denom_sats)
   mint_recipient_commit  33 bytes (Pedersen commit for the new cBTC.tac UTXO)
   bind_hash              32 bytes (per §5.36.3)
   proof_length           2 bytes  (u16 LE)
   groth16_proof          VAR bytes (asset-spend over bond_source_outpoint
                                     + slot-ownership over target_leaf_hash)
```

### 5.36.2 Validator algorithm

```
on T_CBTC_TAC_DEPOSIT:
  require envelope.network_tag matches local network
  require target_leaf_hash references an existing cBTC.zk slot leaf
  require leaf_state[target_leaf_hash] == "live"
  require slot_denom_sats == leaf_record.denom_sats
  require Bitcoin UTXO at slot_K_btc is unspent (chain observation)
  require mint_amount == slot_denom_sats
  require position[target_leaf_hash] does not exist

  // TAC bond sourcing
  require bond_source_outpoint references unspent TAC UTXO
  require bond_commit == utxo.pedersen_commit
  require groth16_verify(ASSET_SPEND_VK, envelope.proof.bond_spend_part,
                         public_signals=[bond_commit, bond_amount_TAC])

  // Slot ownership proof
  require groth16_verify(MIXER_WITHDRAW_VK, envelope.proof.slot_part,
                         public_signals=[leaf_record.recipient_commit,
                                         leaf_record.nullifier_hash,
                                         /* etc. */])

  // Collateralization check (§5.41 — fixed INITIAL_BOND_RATIO = 2.0)
  P = TWAP_TAC_per_BTC(at_block = confirm_height − REORG_SAFETY_DEPTH)
  bond_value_BTC = bond_amount_TAC / P
  bond_ratio = bond_value_BTC / slot_denom_sats
  require bond_ratio ≥ INITIAL_BOND_RATIO

  // Aggregate exposure caps (§5.41 — chain-derived formulas)
  prospective_total_BTC = aggregate_BTC_backing + slot_denom_sats
  require prospective_total_BTC × P ≤ MAX_POOL_FRAC × TAC_BTC_pool_TAC_depth
  require slot_denom_sats ≤ MAX_SINGLE_POSITION_BTC

  // Effects
  position[target_leaf_hash] := {
    depositor_recovery_pubkey: depositor_recovery_pk,
    slot_leaf_hash: target_leaf_hash,
    slot_K_btc: leaf_record.K_btc,
    slot_denom_sats: slot_denom_sats,
    mint_amount: mint_amount,
    bond_amount_TAC: bond_amount_TAC,
    bond_TAC_outpoint: deposit_bond_to_escrow(bond_source_outpoint),
    initial_TWAP_at_deposit: P,
    initial_ratio: bond_ratio,
    state: "active",
    deposit_height: H,
  }
  leaf_state[target_leaf_hash] := "deposited"
  spend(bond_source_outpoint)
  mint_asset_utxo(asset_id = cBTC.tac,
                  pedersen_commit = mint_recipient_commit,
                  amount = mint_amount)
  emit deposit_event(target_leaf_hash, mint_amount, bond_amount_TAC)
```

### 5.36.3 bind_hash construction

```
bind_hash = SHA256(
  "tacit-cbtc-tac-deposit-v1"
  || network_tag
  || target_leaf_hash
  || slot_denom_sats_LE
  || bond_amount_TAC_LE
  || bond_source_outpoint
  || bond_commit
  || depositor_recovery_pk
  || mint_amount_LE
  || mint_recipient_commit
)
```

### 5.36.4 Auto-buy TAC mode

For users who hold only BTC and want to mint cBTC.tac, the dapp can
construct an atomic flow combining:

1. `T_SLOT_MINT` — wrap BTC into a fresh cBTC.zk slot.
2. `T_AMM_SWAP` — swap a portion of the wrapped value via the
   canonical TAC/cBTC.zk AMM pool, producing a TAC UTXO of the
   required bond size.
3. `T_CBTC_TAC_DEPOSIT` — deposit the slot + freshly-swapped TAC.

All three envelopes can be packaged into one Bitcoin reveal
transaction. The user signs one Bitcoin tx and one envelope-bundle;
the protocol executes the entire mint flow atomically.

Slippage on the AMM swap is bounded by a `min_out_TAC` parameter
provided in the T_AMM_SWAP segment (standard tacit AMM mechanics);
if slippage exceeds the user's tolerance, the entire bundle fails
and the user's BTC is refunded via standard tacit commit-reveal
refund machinery.

The bond_ratio TWAP is sampled at `confirm_height − 6` (§5.41
constant), so the user's own auto-buy swap (in the same Bitcoin tx)
is excluded from the TWAP — the user cannot inflate their own bond
valuation.

---

## §5.37 T_CBTC_TAC_WITHDRAW — LP-shaped burn

### 5.37.1 Wire format

```
T_CBTC_TAC_WITHDRAW
   opcode                  1 byte   (0x4A)
   network_tag             1 byte
   target_leaf_hash        32 bytes (the position being closed)
   burn_count              1 byte   (M ∈ [1, 16]; cBTC.tac UTXOs being burned)
   burn_nullifiers         M × 32 bytes
   burn_commits            M × 33 bytes
   burn_amount_LE          8 bytes  (u64; total cBTC.tac amount burned;
                                     must equal position.mint_amount)
   burn_balance_proof      VAR bytes (bulletproof: Σ amounts = burn_amount)
   insurance_claim_TAC_LE  8 bytes  (u64; optional pooled insurance claim
                                     for the burner; per §5.39.3)
   bind_hash               32 bytes
   proof_length            2 bytes
   groth16_proof           VAR bytes (asset-spend over the cBTC.tac UTXOs)
```

The reveal Bitcoin transaction MUST simultaneously spend the slot's
`K_btc` UTXO (the depositor signs under their `r_btc`). The
withdraw envelope and the BTC spend bind together atomically.

### 5.37.2 Validator algorithm

```
on T_CBTC_TAC_WITHDRAW:
  require envelope.network_tag matches local network
  require position[target_leaf_hash] exists
  require position[target_leaf_hash].state == "active"
  require burn_amount == position.mint_amount

  // Per-burn validity (standard tacit asset-spend)
  for i in 0..burn_count:
    utxo := lookup_asset_utxo(burn_commits[i])
    require utxo is not None
    require utxo.spent == false
    require utxo.asset_id == cBTC.tac
    require utxo.pedersen_commit == burn_commits[i]
    require burn_nullifiers[i] ∉ spent-set[cBTC.tac]

  // Amount validation
  require bulletproof_verify(burn_balance_proof, burn_commits, burn_amount)

  // Bitcoin tx atomicity check
  require reveal_tx.vin[0].prevout.script_pubkey
        == P2TR(position.slot_K_btc)
  // The depositor's r_btc signs this input; their KEY-PATH Schnorr sig
  // is verified by Bitcoin's consensus. The protocol checks that the
  // reveal tx properly spends the slot UTXO.

  // Optional insurance claim from the pool
  if insurance_claim_TAC > 0:
    current_per_share_insurance_TAC :=
      insurance_pool_TAC / outstanding_cBTC.tac_supply
    expected_insurance_TAC := burn_amount × current_per_share_insurance_TAC
    require insurance_claim_TAC == expected_insurance_TAC
    // Burner claims their proportional slice of pooled insurance.
    // Claiming is optional — if insurance_claim_TAC = 0, the slice
    // remains in the pool for other holders.

  // Ownership proof
  require groth16_verify(ASSET_SPEND_VK_M, envelope.proof,
                         public_signals=[burn_commits, burn_amount])

  // Effects
  // Burn the cBTC.tac UTXOs
  for i in 0..burn_count:
    mark_asset_utxo_spent(burn_commits[i])
    spent-set[cBTC.tac].add(burn_nullifiers[i])
  outstanding_cBTC.tac_supply -= burn_amount

  // Return bond to depositor
  // (full bond is returned — there is no withdrawal fee at the
  // protocol level; depositor compensation comes from holding
  // cBTC.tac that earns its share of insurance pool growth, plus
  // any AMM LP fees if they LP'd into cBTC.tac pools)
  pay_TAC(position.depositor_recovery_pubkey, position.bond_amount_TAC)

  // Pay insurance claim if requested
  if insurance_claim_TAC > 0:
    pay_TAC(position.depositor_recovery_pubkey, insurance_claim_TAC)
    insurance_pool_TAC -= insurance_claim_TAC

  // The slot's BTC has been spent in reveal_tx (depositor signed
  // the input under r_btc); the BTC is now in whatever output
  // structure the depositor chose. No protocol involvement.

  position[target_leaf_hash].state := "withdrawn"
  leaf_state[target_leaf_hash] := "redeemed"
  emit withdraw_event(target_leaf_hash, burn_amount)
```

### 5.37.3 bind_hash construction

```
bind_hash = SHA256(
  "tacit-cbtc-tac-withdraw-v1"
  || network_tag
  || target_leaf_hash
  || burn_count
  || burn_nullifiers
  || burn_commits
  || burn_amount_LE
  || insurance_claim_TAC_LE
)
```

### 5.37.4 Atomicity guarantees

The withdraw envelope and the Bitcoin spend of `K_btc` are bound
into a single Bitcoin reveal transaction. The protocol verifies:

- The reveal tx spends `K_btc` at vin[0]
- The reveal tx commits to the withdraw envelope via standard
  commit-reveal binding

If either binding fails, the entire reveal is invalid and the
position remains active. The depositor cannot grab their BTC without
burning their cBTC.tac, and they cannot burn their cBTC.tac without
spending their BTC. The withdrawer (typically the same party as
the depositor, but can be anyone holding both the cBTC.tac and the
depositor's `r_btc`) recovers both in one atomic step.

### 5.37.5 Withdrawer ≠ depositor

cBTC.tac is freely transferable. A user who acquires cBTC.tac from
the market and wants to redeem it for BTC has two options:

1. **Pick any active position whose mint_amount equals their cBTC.tac
   balance, AND have the depositor's `r_btc` cooperation** — runs
   T_CBTC_TAC_WITHDRAW. The depositor's bond TAC returns to the
   depositor's recovery pubkey (per their original deposit
   commitment); the withdrawer gets the slot's BTC.

2. **Trigger T_CBTC_TAC_FORCE_CLOSE on a position** — works only if
   that position is below the LIQUIDATION_RATIO. This doesn't
   require the depositor's `r_btc`; it forces TAC-to-BTC swap and
   reserves the BTC for the system. See §5.38.

The first path is "cooperative unwind" and is the normal flow when
the depositor wants out. The second path is "forced unwind" for
under-collateralized positions.

A holder who acquired cBTC.tac and wants their pure-BTC exposure but
holds no specific depositor's `r_btc` simply sells their cBTC.tac on
the market and buys cBTC.zk (or whatever asset they actually want).
This is the canonical "use the AMM" path — direct redemption is for
the depositor; secondary holders trade through markets.

---

## §5.38 T_CBTC_TAC_FORCE_CLOSE — automatic liquidation

### 5.38.1 Trigger condition

When `position[L].current_ratio < LIQUIDATION_RATIO`, anyone may
submit a `T_CBTC_TAC_FORCE_CLOSE` envelope. The envelope is
permissionlessly executable — typically a searcher running
automated software.

```
current_ratio(L, at_block H) =
  position[L].bond_amount_TAC / TWAP_TAC_per_BTC(H − REORG_SAFETY_DEPTH)
  / position[L].slot_denom_sats
```

### 5.38.2 Wire format

```
T_CBTC_TAC_FORCE_CLOSE
   opcode                  1 byte   (0x4B)
   network_tag             1 byte
   target_leaf_hash        32 bytes
   liquidator_payout_pk    33 bytes (BTC payout address for liquidator reward)
   amm_swap_min_BTC_out_LE 8 bytes  (slippage protection)
   bind_hash               32 bytes
```

No share-buyout proofs — the burn of outstanding cBTC.tac happens
implicitly through pool accounting, not envelope-level share
consumption. cBTC.tac shares are linkability-private and cannot be
linked to specific positions; the pooled model handles this.

### 5.38.3 Cascade rate-limit

To prevent TAC price crashes from triggering simultaneous force-
closes that themselves accelerate the crash (positions dump TAC into
AMM → TAC price further down → more positions liquidatable):

```
FORCE_CLOSES_PER_BLOCK ≤ MAX_FORCE_CLOSES_PER_BLOCK
```

`MAX_FORCE_CLOSES_PER_BLOCK = 5` (fixed constant per §5.41). When
more positions qualify simultaneously, they are prioritized by
lowest `current_ratio` (most at-risk first) and queued to subsequent
blocks. Positions in the warning band can use the queue delay to
self-rescue via voluntary cooperative withdraw before being force-
closed.

### 5.38.4 Validator algorithm

```
on T_CBTC_TAC_FORCE_CLOSE:
  require envelope.network_tag matches local network
  require position[target_leaf_hash] exists
  require position[target_leaf_hash].state == "active"
  require force_closes_this_block < MAX_FORCE_CLOSES_PER_BLOCK
  require this envelope is the next-highest-priority eligible
    liquidation at this block (lowest current_ratio first)

  // Health check
  ratio := current_ratio(target_leaf_hash, H)
  require ratio < LIQUIDATION_RATIO

  // AMM swap the bond TAC → BTC, depositing BTC into redemption reserve
  swap_TAC_input := position.bond_amount_TAC
  swap_BTC_output := amm_swap(TAC → cBTC.zk_canonical,
                              amount=swap_TAC_input,
                              min_out=envelope.amm_swap_min_BTC_out)

  // Accounting
  liquidator_reward_BTC := LIQUIDATOR_REWARD_FRACTION × swap_BTC_output
  reserve_credit_BTC := swap_BTC_output − liquidator_reward_BTC

  redemption_reserve_BTC += reserve_credit_BTC
  pay_BTC_at(envelope.liquidator_payout_pk, liquidator_reward_BTC)

  // Position closed; depositor's K_btc returns to their custody
  // (we never had it). The reserve_credit_BTC is what backs the
  // outstanding cBTC.tac that was minted from this position.
  position[target_leaf_hash].state := "force-closed"
  leaf_state[target_leaf_hash] := "force-closed"
  force_closes_this_block += 1
```

### 5.38.5 Post-force-close redemption

After force-close, the cBTC.tac that was minted from this position
is still in circulation. The `redemption_reserve_BTC` pool now backs
this circulating supply. When any cBTC.tac holder runs
`T_CBTC_TAC_WITHDRAW` against ANY active position whose mint_amount
matches their burn_amount, the system redeems them normally — but
if the chosen position is the force-closed one, the BTC comes from
`redemption_reserve_BTC` rather than from the depositor's K_btc.

In practice the dapp routes withdraws to the lowest-friction path,
which prefers active depositor-cooperative positions over reserve
draws. Force-closed positions are drawn-down by automated keepers
who arbitrage the system to keep reserves liquid.

### 5.38.6 Solvency under partial liquidation

The 20% buffer between LIQUIDATION_RATIO (1.2) and the breakeven
point (1.0) means the AMM swap typically realizes ≥ slot_denom_sats
of BTC even with 10-15% slippage in thin pools. If extreme TAC crash
causes realized output to fall short, the shortfall is borne by the
aggregate (per-share fair value drops slightly below 1.0 BTC,
absorbed by other positions' over-collateral and any insurance pool
balance). The system never enters an unrecoverable state — it just
runs at slightly degraded backing until equilibrium re-establishes.

---

## §5.39 Rug detection and pooled insurance

### 5.39.1 Rug detection (INV-1 break)

Indexers monitor the Bitcoin UTXO at every active position's
`K_btc`. A rug is detected when:

```
For some position[L] in state == "active":
  the Bitcoin UTXO at position[L].slot_K_btc has been spent (chain observation)
  AND no matching T_CBTC_TAC_WITHDRAW envelope referenced this position
  AND no matching T_CBTC_TAC_FORCE_CLOSE envelope referenced this position
  AND the spend has been buried under REORG_SAFETY_DEPTH (6 blocks)
```

The REORG_SAFETY_DEPTH grace window protects honest depositors whose
legitimate withdraw was reorged out — they have 6 blocks to re-
broadcast before slashing fires.

### 5.39.2 SLASH_DETECTED state event (NOT an envelope opcode)

On confirmed rug detection, the indexer fires an automatic state
transition. There is no user envelope — this is a pure consensus
event derived from chain observation:

```
SLASH_DETECTED(target_leaf_hash):
  require position[target_leaf_hash].state == "active"
  require rug_detected_at_depth(target_leaf_hash, REORG_SAFETY_DEPTH)

  // Move bond TAC to global insurance pool
  insurance_pool_TAC += position[target_leaf_hash].bond_amount_TAC

  position[target_leaf_hash].state := "rugged"
  leaf_state[target_leaf_hash] := "rugged"
  emit slot_rugged_event(target_leaf_hash, bond_TAC_seized)
```

There is no per-position share tracking. The insurance pool is one
global pool. All outstanding cBTC.tac shares share uniformly in it.

### 5.39.3 Pooled insurance value

At any block H:

```
per_share_insurance_TAC(H) = insurance_pool_TAC(H) / outstanding_cBTC.tac_supply(H)
```

This is the implicit TAC backing every cBTC.tac share carries above
its nominal 1:1 BTC backing. After a rug:

- Backing decreases by `position.slot_denom_sats` (lost BTC)
- Insurance pool increases by `position.bond_amount_TAC` (slashed TAC)

Because `bond_amount_TAC × TWAP ≥ INITIAL_BOND_RATIO × slot_denom_sats`
(= 2× slot_denom_sats in BTC equivalents), the slash insurance
generally exceeds the lost backing. The aggregate per-share fair
value tends to increase slightly after rugs — honest holders are
net-positive from the over-collateral payout.

### 5.39.4 T_SHARE_SLASH_CLAIM — optional pooled insurance claim

cBTC.tac holders may at any time burn some of their shares (or
include burn alongside a normal withdraw via §5.37.2's optional
field) to extract their proportional slice of the insurance pool.
There is no claim window — claims happen any time, against current
pool state.

When invoked standalone (not as part of a withdraw):

```
T_SHARE_SLASH_CLAIM
   opcode               1 byte   (0x4C; see opcode table §5.44)
   network_tag          1 byte
   share_count          1 byte   (M ∈ [1, 16])
   share_nullifiers     M × 32 bytes
   share_commits        M × 33 bytes
   share_burn_amount_LE 8 bytes  (u64)
   share_balance_proof  VAR bytes (bulletproof)
   claim_TAC_LE         8 bytes  (u64; must equal
                                  share_burn_amount × per_share_insurance_TAC)
   recipient_commit     33 bytes
   bind_hash            32 bytes
   proof_length         2 bytes
   groth16_proof        VAR bytes
```

Validator: standard tacit asset-spend over the cBTC.tac shares, plus
the constraint that `claim_TAC` matches the current pool ratio
exactly (not under, not over).

Effects: burn the shares, debit `insurance_pool_TAC` by `claim_TAC`,
pay `claim_TAC` to `recipient_commit`.

### 5.39.5 Why pooled (and not per-position)

Tacit asset transfers are linkability-private. When Alice sells
cBTC.tac to Bob via T_AXFER_VAR, Bob's resulting UTXO has fresh
Pedersen blindings; it cannot be linked back to the position whose
deposit originally minted Alice's share. Per-position share tracking
is therefore impossible without breaking either privacy or
fungibility.

The pooled model accepts this constraint and turns it into a
feature: every share holder is uniformly insured against any rug,
regardless of which position they happen to be downstream of. A rug
is a uniform "minor inflation" event on the insurance pool side,
exactly proportional to the bond's over-collateralization.

---

## §5.40 Price discovery oracle

### 5.40.1 Canonical TWAP source

```
TWAP_TAC_per_BTC(window=180 blocks, sampled_at=H − REORG_SAFETY_DEPTH)
  = volume-weighted_avg([
      observations from canonical TAC/cBTC.zk-CANONICAL AMM pool,
      observations from canonical TAC/cBTC.zk-CANONICAL orderbook fills,
      observations from canonical TAC/cBTC.tac AMM pool (post-activation)
    ] within window)
```

Where `cBTC.zk-CANONICAL` is `cBTC.zk-L` (1 BTC denomination) for
bootstrap; once the cBTC.tac/TAC AMM pool has sufficient depth, it
contributes the dominant signal.

### 5.40.2 Manipulation resistance

The 180-block window provides natural manipulation resistance.
Sustaining a 10% TWAP deviation requires holding the AMM pool at
that deviation against arbitrage for the full window — empirically
this requires capital ≥ pool_depth × 5-10x for the ~30 minutes the
window spans.

Outlier rejection: observations more than 3 standard deviations from
the prior 1000-observation rolling mean are discarded.

Per-position exposure cap (§5.41): no single position may represent
more than MAX_SINGLE_POSITION_BTC of backing — limits the leverage a
manipulator gets from triggering a single liquidation.

### 5.40.3 Stale-price refusal

If no price observation has been recorded in the canonical sources
for STALE_PRICE_BLOCKS (1000 blocks ~= 7 days), the indexer refuses
new deposit envelopes and pauses force-closes. Existing positions
remain in their last computed state until the oracle recovers.

---

## §5.41 Fixed parameters and chain-derived formulas

All values are fixed at activation. There is no governance mechanism
to change them. A change requires a formal SPEC amendment + worker +
dapp deployment.

### 5.41.1 Constants

```
INITIAL_BOND_RATIO         = 2.0       (collateralization at deposit)
WARNING_RATIO              = 1.5       (UI surfaces warning to depositor)
LIQUIDATION_RATIO          = 1.2       (force-close trigger)
LIQUIDATOR_REWARD_FRACTION = 0.005     (50 bps of swap output)
TWAP_WINDOW                = 180 blocks (~30 min)
REORG_SAFETY_DEPTH         = 6 blocks  (~60 min)
MAX_FORCE_CLOSES_PER_BLOCK = 5         (cascade dampening)
STALE_PRICE_BLOCKS         = 1000      (~7 days, oracle freshness)
MAX_SINGLE_POSITION_BTC    = 10 BTC    (single-position exposure cap in BTC)
AMM_POOL_FEE_BPS           = 30        (cBTC.tac/TAC AMM swap fee)
```

### 5.41.2 Formulaic limits

```
MAX_POOL_FRAC                    = 0.10
  Total bonded BTC ≤ 10% × current TAC/cBTC.zk pool TAC depth.
  This formula caps aggregate exposure as a function of observable
  pool depth. No parameter to tune — system grows with the pool.

MAX_BONDED_FRAC_OF_TAC_FDV       = 0.25
  Total bond TAC × current TAC price (in BTC) ≤ 25% × TAC FDV in BTC.
  Caps bonded exposure as a fraction of TAC's broader market value.
  Protects against systemic cBTC.tac dependence on TAC.
```

### 5.41.3 Anti-systemic pauses (automatic, formulaic)

```
PAUSE_NEW_DEPOSITS if any of:
  - oracle stale (no observations for STALE_PRICE_BLOCKS)
  - TWAP coefficient of variation > 0.30 over last 1000 obs (high vol)
  - aggregate slash event > 5% of bonded supply in last 100 blocks
  - MAX_POOL_FRAC or MAX_BONDED_FRAC_OF_TAC_FDV cap would be exceeded
```

These conditions are evaluated every block from chain-observable
state. No governance vote, no manual intervention. When the
condition clears, deposits resume automatically. Withdraws,
force-closes, and slash claims continue regardless of pause state —
the system always allows users to exit existing positions.

### 5.41.4 Why no governance

Every parameter above is either:

- A safety constant chosen conservatively at launch (1.2, 1.5, 2.0,
  6, 30, etc.) where the cost of having it slightly suboptimal is
  much lower than the risk of having a governance attack on it.
- A formula reading directly from chain state (pool depth, TAC FDV)
  with no human-set knob.

If a parameter turns out to be wrong, the fix is a SPEC amendment
with new constants + deployed indexer/dapp update + coordinated
activation. This is more expensive than a governance vote but it's
also more honest — the protocol is what the code says, not what a
vote could decide.

---

## §5.42 Activation

### 5.42.1 Bootstrap from cBTC.zk

This amendment requires `SPEC-CBTC-ZK-AMENDMENT.md` (whole-slot
trustless wrapper) to be live and producing organic price discovery
before cBTC.tac can activate. Bootstrap conditions:

1. The whole-slot orderbook for `cBTC.zk-L` (or whichever
   `cBTC.zk-CANONICAL` is chosen) has produced ≥ 1000 confirmed
   trades.
2. The coefficient of variation of price observations over the
   bootstrap window is < 0.15 (price discovery has converged).
3. A canonical TAC/cBTC.zk AMM pool exists with TAC depth ≥
   1,000,000 TAC (~$150k at $0.15 TAC).
4. Worker and dapp implementations of T_CBTC_TAC_DEPOSIT,
   T_CBTC_TAC_WITHDRAW, T_CBTC_TAC_FORCE_CLOSE,
   T_SHARE_SLASH_CLAIM are deployed and verified.

Until all four conditions hold, T_CBTC_TAC_DEPOSIT envelopes are
refused by indexers. cBTC.zk operates standalone.

### 5.42.2 No governance to activate

Activation is not a vote. It is a chain-observable condition. Once
the bootstrap conditions are satisfied AND the implementation is
deployed across the network, the first valid T_CBTC_TAC_DEPOSIT
envelope to confirm marks the activation point.

### 5.42.3 Graceful degradation

If at any point cBTC.tac operation stops being viable (TAC
volatility too high, pool depth too thin, systemic slash events),
the automatic pause conditions in §5.41.3 trigger. New deposits
refused; existing positions continue normally to natural unwind via
withdraw or force-close. The system never enters an unrecoverable
state — it just falls back to "cBTC.zk only" until conditions
clear.

---

## §5.43 Default product surface: `cBTC.tac.lp`

cBTC.tac is the protocol-level wrapped-BTC asset. For day-to-day
holding, the dapp recommends users hold the LP token of the canonical
cBTC.tac/TAC AMM pool — branded `cBTC.tac.lp` — rather than raw
cBTC.tac. This is a pure product / UX recommendation, not a protocol
distinction. There is no new opcode and no new validator logic for
cBTC.tac.lp; it is the standard LP token of one specific AMM pool,
produced by tacit's existing AMM machinery.

### 5.43.1 Why default to cBTC.tac.lp

Holding cBTC.tac.lp instead of raw cBTC.tac gives users:

- **AMM-fee yield**: 30 bps × pool volume accrues to LPs proportionally.
- **Full fungibility, amount privacy, composability**: cBTC.tac.lp is
  a standard tacit-asset LP token, behaves identically to any other
  AMM LP token (T_AXFER_VAR transfers, marketplace listings,
  derivative AMM pools).
- **Same underlying trust profile as cBTC.tac**: the wrapper-layer
  guarantees (bonded TAC over-collateralization, slashable rugs,
  pooled insurance) are unchanged. Holding the LP token of the pool
  is exposure to cBTC.tac's collateralization plus the TAC side.

This is the same pattern as Curve's 3CRV (LP token of a USDC/USDT/DAI
pool that has become the de facto "yield-bearing stablecoin
exposure" in DeFi). Users prefer 3CRV over raw USDC because of the
yield; the same dynamic is expected for cBTC.tac.lp vs raw cBTC.tac.

### 5.43.2 Risks added by holding cBTC.tac.lp vs raw cBTC.tac

The LP layer introduces standard AMM-LP risks on top of the wrapper
layer:

- **Impermanent loss**: TAC/BTC price moves cost the LP relative to
  holding the two assets separately. Users sensitive to BTC-price
  tracking should hold raw cBTC.tac instead.
- **Pool slippage at redeem**: redeeming the LP token returns
  proportional cBTC.tac + TAC at the current pool ratio. If a user
  needs precisely 1 BTC of cBTC.tac, they may need to swap through
  the pool to fully convert their LP redemption — incurring slippage.
- **AMM-specific attacks**: sandwich attacks, pool-depth drain
  scenarios, MEV. Standard for any AMM LP position.

These are well-understood DeFi risks. The dapp surfaces them clearly
at the LP-into-pool step so users can choose with full information.

### 5.43.3 Three-tier product self-selection

The protocol now offers three distinct BTC-wrapper products by user
preference:

| Variant | Trust profile | Granularity | Yield |
|---|---|---|---|
| `cBTC.zk` | Trustless self-custody (no co-signer, no bond) | Whole-slot at fixed denominations | None inherent; can list on orderbook |
| `cBTC.tac` | TAC-bonded (slashable, pooled insurance) | Amount-granular fungible | None inherent; can LP into pools |
| `cBTC.tac.lp` | Inherits cBTC.tac + AMM-LP exposure | Amount-granular fungible | AMM swap fees, IL exposure |

Users self-select based on what they value:
- Max trustlessness, BTC-only exposure → `cBTC.zk`
- Fungible BTC exposure, want simple holding → `cBTC.tac`
- Fungible BTC exposure with yield → `cBTC.tac.lp`

The dapp can recommend a default (cBTC.tac.lp for new users
optimizing for yield, cBTC.zk for trustless purists, cBTC.tac for
clean BTC tracking) while exposing all three.

### 5.43.4 Composability

cBTC.tac.lp is a normal tacit asset. It can be:

- Transferred privately via T_AXFER_VAR
- Listed on the marketplace
- Used as collateral in cUSD CDP (per SPEC-CUSD-CDP-AMENDMENT)
- LP'd into other AMM pools (e.g., cBTC.tac.lp/cUSD pool — though
  this is a niche product surface)
- Held in cold storage as long-term BTC exposure with passive yield

The composability comes from being a standard LP token, not from any
cBTC-specific machinery. Future products (lending markets, perp
DEXes, etc.) can integrate cBTC.tac.lp on the same basis as any
other tacit AMM LP token.

### 5.43.5 No protocol enforcement

The protocol does not mandate that cBTC.tac.lp be the default or
even that users use the canonical AMM pool. Anyone can LP cBTC.tac
into any pool (e.g., a third-party cBTC.tac/cUSD pool). The
"canonical" cBTC.tac/TAC pool is canonical by social convention and
dapp default — chain rules treat it identically to any other AMM
pool.

This preserves the no-governance property: there is no protocol
authority over which pools exist, which is canonical, or what LP
tokens to brand. The dapp makes a product choice; the protocol
provides the substrate.

---

## §5.44 Opcode table

Add to §3 *opcodes table*:

- `0x49` `T_CBTC_TAC_DEPOSIT` — mint cBTC.tac from cBTC.zk + TAC (§5.36)
- `0x4A` `T_CBTC_TAC_WITHDRAW` — burn cBTC.tac, recover cBTC.zk + TAC (§5.37)
- `0x4B` `T_CBTC_TAC_FORCE_CLOSE` — permissionless liquidation (§5.38)
- `0x4C` `T_SHARE_SLASH_CLAIM` — claim against pooled insurance (§5.39.4)

(`0x48` reserved by `SPEC-CBTC-ZK-FUNGIBILITY-AMENDMENT.md` for
`T_SLOT_NOTE`.)

---

## Test plan

1. **Healthy lifecycle.** Wrap BTC → cBTC.zk → deposit (mint
   cBTC.tac) → transfer cBTC.tac around → withdraw (burn) → recover
   cBTC.zk → unwrap to BTC. Verify all balances, fee accruals, and
   atomic-tx properties.

2. **Auto-buy mint.** Single Bitcoin tx that wraps + AMM-swaps +
   deposits. Verify atomicity (all succeed or all fail), correct
   TWAP sampling (pre-swap, depth-6), slippage refusal works.

3. **Force-close path.** Deposit, simulate TAC price crash via AMM
   manipulation, trigger T_CBTC_TAC_FORCE_CLOSE. Verify swap
   executes, liquidator reward paid, BTC reserve credited, position
   marked force-closed.

4. **Cascade rate-limit.** Simulate 50 positions simultaneously
   becoming liquidatable. Verify only MAX_FORCE_CLOSES_PER_BLOCK
   execute per block, ordered by lowest ratio first, others queued.

5. **Rug detection + slash.** Deposit, operator (depositor) spends
   K_btc unilaterally on Bitcoin. Verify SLASH_DETECTED fires after
   REORG_SAFETY_DEPTH confirmations, bond moves to insurance pool,
   per_share_insurance_TAC updates correctly.

6. **Pooled insurance claim.** Multiple rugs accrue to pool. Holders
   submit T_SHARE_SLASH_CLAIM. Verify uniform per-share payout, pool
   drains correctly, supply decrements.

7. **Combined withdraw+claim.** Holder withdraws cBTC.tac AND claims
   pooled insurance in one envelope. Verify both effects apply
   atomically.

8. **Exposure caps bind.** Attempt deposit that would push aggregate
   bonded BTC above MAX_POOL_FRAC × pool depth. Verify rejection
   with informative error.

9. **Pre-activation refusal.** Attempt deposit before bootstrap
   conditions. Verify refusal with bootstrap-pending error.

10. **Pause condition triggers.** Each of §5.41.3 conditions
    independently. Verify new deposits refused, existing operations
    continue.

11. **Reorg-stable TWAP.** Bitcoin reorg of depth 1-5 doesn't change
    bond_ratio decision for previously-confirmed deposits. Reorg of
    depth 7+ would; system enters re-derivation state.

12. **Manipulation resistance.** Attempt to manipulate TWAP via
    large AMM swap, verify swap cost exceeds gain from manipulated
    deposit.

---

## Open questions

1. **TAC staking integration.** Bonded TAC is locked anyway. If a
   TAC staking module exists or is added, bonded TAC could
   participate in staking rewards distribution without new TAC
   minting (purely redistribution from existing yield streams).
   Adds depositor compensation; no new trust assumption. Defer to
   when staking module exists.

2. **Withdrawer-funded bond return.** Currently the bond returns
   to the original depositor's recovery_pubkey. A future flow could
   let a third-party withdrawer (who acquired cBTC.tac on the
   market) pay the original depositor in TAC to "buy out" the bond
   position. Adds protocol surface; consider for v1.x.

3. **Reserve draining mechanism.** Force-closed positions deposit
   their swap output into redemption_reserve_BTC. The reserve is
   used to back cBTC.tac that was minted from those positions but
   stays in circulation. A formal mechanism for keepers to "drain"
   the reserve by closing matched-supply outstanding shares would
   keep the reserve from growing indefinitely. Sketch in this
   amendment is informal; consider formalizing in v1.x.

4. **AMM pool fee accrual.** This amendment defines a 30 bps swap
   fee on the canonical cBTC.tac/TAC AMM pool, but doesn't specify
   where the fees go. Options: to AMM LPs (standard), to insurance
   pool (additional safety buffer), split (e.g., 75/25). Defer to
   AMM amendment that handles pool-level fee distribution.

5. **Cross-tier deposits.** Currently a deposit consumes one
   cBTC.zk slot at one denomination. Allowing batch deposits of
   multiple slots (e.g., 1×L + 3×M = 1.3 BTC of mint_amount in one
   envelope) would improve UX. Defer.

6. **Partial withdraws.** Currently a withdraw fully closes a
   position. Partial withdraw (burn X% of mint_amount, get X% of
   slot value + X% of bond) would require slot fractionalization
   on the Bitcoin side, which Bitcoin can't natively do without
   covenants. Could use SLOT_SPLIT to pre-split a slot before
   deposit. Defer to UX-level dapp work, no protocol change.

---

## Summary

cBTC.tac is tacit's canonical fungible wrapped-Bitcoin asset.
Minted via LP-shaped deposits (cBTC.zk slot + TAC over-collateral),
burned to recover both. Each cBTC.tac unit is approximately 1:1
with BTC by value, market-priced, backed by aggregate active-slot
BTC + pooled TAC insurance.

The TAC over-collateralization is the trust mechanism: rugs are
slashed, slashed TAC flows to a pooled insurance reserve that
uniformly compensates all outstanding cBTC.tac holders. Force-close
liquidates positions that fall below collateral threshold,
maintaining aggregate solvency.

No federation, no oracle (price discovered on-chain), no governance
(all parameters fixed or chain-formulaic), no peg defense (market
prices it). The protocol is what the code says.
