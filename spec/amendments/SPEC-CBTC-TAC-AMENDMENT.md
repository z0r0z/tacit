# SPEC §5.34–§5.46 Amendment — cBTC.tac (Canonical Wrapped Bitcoin)

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
> **Governance: scoped + bounded.** The protocol ships fully
> operational with fixed default parameters; no governance vote is
> required for any operation. A SUBSET of parameters can optionally
> be tuned by TAC DAO governance within pre-defined safety bands
> (§5.46). Adjustments outside the bands — and changes to load-
> bearing mechanics (slashing, conservation invariants, settlement
> atomicity, cryptographic primitives) — require a formal SPEC
> amendment, not a vote. Hard limits are enumerated explicitly. The
> design principle: mechanical defaults work without any governance,
> bounded adjustability provides flexibility, hard limits prevent
> governance-attack surface from compromising the trust model.

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

## Governance principles

The protocol is designed for **bounded governance**: mechanical
defaults that work without any votes, narrowly-scoped parameter
adjustments within safety bands when TAC holders choose to engage,
and hard limits that prevent governance attacks on load-bearing
mechanics. Three reasons this shape is the right choice:

1. **Minimal blast radius by default.** Without any governance
   activity, the protocol is fully operational using fixed-at-launch
   parameters. There is no proposal to game, no vote to capture, no
   multisig to compromise as a precondition for normal operation.
   Governance is opt-in, not required.

2. **Honest peg semantics.** cBTC.tac is market-priced, not peg-
   defended. There is no "central bank" to intervene if the market
   price diverges from the implied backing. The market discovers
   the actual exchange rate; arbitrage with the deposit/withdraw
   path keeps it close to 1:1 with BTC under normal conditions.
   Governance has no role in pricing.

3. **Composability with bounded surprise.** Downstream protocols
   can integrate cBTC.tac knowing the mechanism is bounded — even
   under maximally-active governance, parameters can only move
   within explicit safety bands, and load-bearing mechanics (slashing,
   conservation, settlement) cannot be touched. Hard limits are
   enumerated explicitly in §5.46.5.

Most parameters are fixed at launch (constants in §5.41) or derived
formulaically from chain-observable state. A subset is tunable by
TAC DAO governance within safety bands (§5.46.2). Load-bearing
mechanics are immutable without a formal SPEC amendment (§5.46.5).

---

## §5.34 cBTC.tac asset

### 5.34.1 Definition

cBTC.tac is a standard tacit-protocol asset, **per-denomination
variant** (one asset_id per backing-slot denomination tier), with:

- `asset_id`: deterministically derived from the backing cBTC.zk
  slot's `denom_sats`:
  ```
  cBTC.tac@denom.asset_id = SHA256("tacit-cbtc-tac-variant-v1"
                                    || denom_sats_LE_u64)
  ```
  No pre-registration ceremony or per-variant CETCH is required; the
  asset_id is implied by the denom alone. Within a denomination tier,
  all cBTC.tac UTXOs are fully fungible regardless of which specific
  cBTC.zk slot backs each share. Across tiers, the variants are
  distinct assets; cross-tier mobility routes through AMM pools.
- `decimals`: 8 (matching BTC's satoshi granularity)
- `ticker`: per tier. Default canonical: `cBTC.tac` (100,000-sat
  tier — the cBTC.zk default tier). Other tiers carry suffixed
  tickers per the dapp's canonical manifest: `cBTC.tac.10k`
  (10,000-sat), `cBTC.tac.k` (1M-sat), `cBTC.tac.10M`, and
  `cBTC.tac.1BTC` (100M-sat).
- `wrapper convention`: `tacit_wrapper.kind = "protocol_bonded"` per
  `SPEC-WRAPPER-AMENDMENT.md`, with `underlying.chain = "bitcoin"`,
  `underlying.asset = "native"`, `underlying.unit = "satoshi"`

Each variant transfers via standard `T_AXFER_VAR`, trades via
standard tacit AMM and orderbook, and is amount-private at the share
level (per tacit's Pedersen-commit asset machinery). All supply,
backing, and insurance formulas in §5.34.2–§5.34.4 below are stated
per tier — each (asset_id, tier) is accounted independently.

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
  depositor_recovery_commit: PedersenCommit, // Pedersen on (recovery_pubkey,
                                             // blinding); opened at withdraw
                                             // to route bond + insurance payout
                                             // (§5.36.5)
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
   depositor_recovery_commit  33 bytes (blinded-pubkey commit per §5.36.7;
                                    BIP-340 tweak construction
                                    `commit = recovery_pubkey + blinding · G`.
                                    The commit is itself a valid BIP-340
                                    Schnorr verification key AND a valid P2TR
                                    output key — never opened on chain. Closes
                                    cross-deposit clustering via repeated
                                    cleartext recovery pubkeys.)
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

  // Slot ownership proof (binds target_leaf_hash + envelope's bind_hash)
  require groth16_verify(MIXER_WITHDRAW_VK, envelope.proof.slot_part,
                         public_signals=[leaf_record.recipient_commit,
                                         leaf_record.nullifier_hash,
                                         bind_hash, /* etc. */])

  // Collateralization check (§5.41 — fixed INITIAL_BOND_RATIO = 2.0)
  P = TWAP_TAC_per_BTC(at_block = confirm_height − REORG_SAFETY_DEPTH)
  bond_value_BTC = bond_amount_TAC / P
  bond_ratio = bond_value_BTC / slot_denom_sats
  require bond_ratio ≥ INITIAL_BOND_RATIO

  // Aggregate exposure caps (§5.41 — chain-derived formulas, per tier)
  prospective_total_BTC = aggregate_BTC_backing(slot_denom_sats) + slot_denom_sats
  require prospective_total_BTC × P ≤ MAX_POOL_FRAC × TAC_BTC_pool_TAC_depth
  require slot_denom_sats ≤ MAX_SINGLE_POSITION_BTC

  // Effects
  position[target_leaf_hash] := {
    slot_leaf_hash:            target_leaf_hash,
    slot_K_btc:                leaf_record.K_btc,
    slot_denom_sats:           slot_denom_sats,
    mint_amount:               mint_amount,
    bond_amount_TAC:           bond_amount_TAC,
    bond_TAC_outpoint:         deposit_bond_to_escrow(bond_source_outpoint),
    depositor_recovery_commit: depositor_recovery_commit,  // opened at withdraw
    initial_TWAP_at_deposit:   P,
    initial_ratio:             bond_ratio,
    state:                     "active",
    deposit_height:            H,
  }
  leaf_state[target_leaf_hash] := "deposited"
  spend(bond_source_outpoint)
  mint_asset_utxo(asset_id = ctacVariantAssetId(slot_denom_sats),
                  pedersen_commit = mint_recipient_commit,
                  amount = mint_amount)
  emit deposit_event(target_leaf_hash, mint_amount, bond_amount_TAC)
```

The slot's `K_btc` UTXO is **not spent** at deposit time — the slot
remains in the depositor's self-custody under lien (recovered at
withdraw via the depositor's `r_btc`, see §5.37). The validator
records `K_btc` from the leaf record to monitor for INV-1 slash
detection (§5.39).

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
  || depositor_recovery_commit
  || mint_amount_LE
  || mint_recipient_commit
)
```

`bind_hash` is included in the MIXER_WITHDRAW_VK public signals
(per §5.11.x bind-squared construction), binding the slot-ownership
proof to this specific envelope's full field set. A mempool observer
who lifts the proof and rebroadcasts with a substituted field fails
verification.

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

### 5.36.5 Privacy posture — fungibility-driven, not envelope-driven

The deposit envelope is intrinsically tied to the depositor: it
references a specific `target_leaf_hash`, consumes a specific TAC
bond UTXO, and (after the depositor signs the Bitcoin reveal tx
with `r_btc` at withdraw time) is publicly linked to the depositor's
wallet via the slot's `K_btc` mapping. **This linkage is
structural** — `K_btc` must remain publicly monitorable so any
indexer can detect INV-1 slash conditions (§5.39). Hiding the
deposit step at the protocol-envelope layer (e.g., via a
rotation-on-every-deposit construction) does not break this link,
because the Bitcoin chain graph reveals the rotation spend
directly and the slot registry maps every `K_btc` to its
`leaf_hash` publicly.

The privacy posture of cBTC.tac is therefore **not** about hiding
who deposited. It is about **fungibility-driven downstream
unlinkability**: cBTC.tac is a bearer instrument whose holders
are anonymous, and value flows downstream of the mint event are
amount-private (Pedersen) and amount-rerandomized at every transfer
and AMM hop. The address-break happens **after** the deposit, not
inside it.

#### 5.36.5.1 The canonical flow

```
Alice's BTC ─wrap─▶ K_btc_A ─deposit─▶ position[L_A]
                                          │
                                          └─ mints cBTC.tac at
                                             mint_recipient_commit
                                             (Pedersen — recipient hidden)
                                                  │
   (amount-private T_AXFER_VAR transfers)         │
                                                  ▼
                                          downstream holder Bob
                                          (no on-chain identifier
                                          tying Bob to position[L_A])
                                                  │
                                          ┌───────┴───────┐
                                          ▼               ▼
                                 sell on AMM       LP into the
                                 cBTC.tac → TAC    canonical
                                 → sats             cBTC.tac/TAC
                                 (amount-private)   pool (LP share is
                                                    itself a tacit asset
                                                    and CAN be deposited
                                                    into a mixer pool
                                                    per AMM.md §...)
```

Per §5.37.5 line 740–744, "a holder who acquired cBTC.tac and
wants their pure-BTC exposure but holds no specific depositor's
`r_btc` simply sells their cBTC.tac on the market and buys cBTC.zk
(or whatever asset they actually want)." The canonical "use the AMM"
exit decouples downstream holders from the depositor entirely.

#### 5.36.5.2 What the envelope deliberately hides

- **Mint recipient.** `mint_recipient_commit` is a Pedersen commit;
  the recipient of the fresh cBTC.tac UTXO is unidentifiable from
  the envelope alone.
- **Recovery pubkey.** `depositor_recovery_commit` (this amendment's
  one protocol-level privacy fix over the round-1 design) is a
  Pedersen commit on `(recovery_pubkey, blinding)`. The recovery
  pubkey only appears at `T_CBTC_TAC_WITHDRAW` time. A user who
  deposits multiple positions cannot be clustered by repeated
  cleartext recovery pubkey — the recovery_pk is hidden until
  the closing event.
- **Bond amount.** `bond_commit` is Pedersen-committed on the wire;
  `bond_amount_TAC_LE` is cleartext because it binds the asset-spend
  proof's public input, but the future bond-source-obfuscation
  amendment (§5.36.6) can lift this.

#### 5.36.5.3 What the envelope reveals (and why)

- **`target_leaf_hash`** — names the specific slot under lien.
  Required so the validator can monitor `K_btc` for slash detection
  and so the depositor can later present the same position for
  withdrawal. Structurally bound to the public slot registry
  anyway.
- **`slot_denom_sats`** — names the tier; required for tier-routed
  validation and the variant `asset_id` derivation.
- **`bond_source_outpoint`** — names the specific TAC UTXO being
  consumed. Wallet-clusterable. Dapp mitigation: source the bond
  from a per-deposit staking subkey (`dapp/tacit.js:72139–72151`).

A protocol-only observer reading these fields can derive: "Wallet
holding `bond_source_outpoint` bonded slot `target_leaf_hash` to
mint cBTC.tac at amount-hidden commit." That's the inherent leak
at the deposit layer.

#### 5.36.5.4 Where the address-break actually happens

| Step | Privacy property |
|---|---|
| Wrap (`T_SLOT_MINT`) | Public chain-graph link from depositor wallet → `K_btc`. Bitcoin-level fact, structural. |
| Deposit (this opcode) | Position record tied to `target_leaf_hash`. Recovery pubkey Pedersen-hidden, mint recipient Pedersen-hidden. Bond source is a public UTXO. |
| Transfer (`T_AXFER_VAR`) | **Address-break starts here.** Amounts hidden by Pedersen; Bitcoin chain shows a dust-UTXO edge (wallet visibility) but no value. After one or more hops to fresh recipients, downstream holders are statistically untraceable to the mint event. |
| AMM swap (`T_SWAP_VAR` / `T_SWAP_BATCH` on the cBTC.tac/TAC canonical pool) | Amount-private settlement against pool reserves. The chain observer sees "the pool processed N swaps in this block;" individual swap amounts are hidden in T_SWAP_BATCH and per-trade in T_SWAP_VAR (cleartext Δ, amount-private inputs/outputs). |
| LP into canonical pool (`T_LP_ADD`) | Produces an LP-share UTXO at a fresh recipient_commit. LP shares are normal tacit assets and CAN be deposited into the LP-share mixer pool for full SNARK unlinkability (AMM.md §"Mixer-composable LP shares"). |
| Withdraw (the depositor's recovery path) | The depositor reveals `(recovery_pubkey, blinding)` to open `depositor_recovery_commit` and spends `K_btc` under their `r_btc`. The depositor's withdrawal is publicly tied to the original deposit; this is fine — the depositor is the same identity throughout. Downstream holders DON'T withdraw; they exit via the AMM. |

#### 5.36.5.5 Dapp implementation: the "private zap" pattern

The reference dapp SHOULD bundle the wrap-to-cBTC.tac flow into a
single atomic Bitcoin reveal tx that maximizes the available
privacy primitives. Recommended construction:

1. **Fresh subkeys throughout.** Derive a per-zap staking subkey
   (`dapp/tacit.js:deriveStakingSubkey`) for the bond source, the
   recovery commit, and the mint recipient — three distinct
   subkeys per deposit. The main wallet never holds the deposit's
   intermediate state.
2. **Wrap → buy bond → deposit, atomic.** Use the §5.36.4 auto-buy
   mode envelope-bundle so the BTC funding, the bond AMM swap, and
   the deposit all settle in one reveal tx. The user signs once;
   the chain shows a single transaction with all three operations
   bound together.
3. **Mint to a fresh recipient.** `mint_recipient_commit` opens to
   a Pedersen commit at a per-zap subkey, not the user's main
   wallet pubkey.
4. **Immediate rerandomization (optional but recommended).**
   Bundle a follow-up `T_AXFER_VAR` that transfers the freshly-
   minted cBTC.tac UTXO to a second per-zap subkey. The output
   commit's blinding is independent of the mint commit's, so the
   second UTXO is statistically unlinkable to the mint event at
   the Pedersen layer.
5. **For LP zaps:** bundle `T_LP_ADD` after the deposit; the LP-share
   UTXO opens at yet another per-zap subkey. The LP-share itself
   is mixer-poolable (per AMM.md), so users seeking maximum LP
   privacy can subsequently deposit the LP share into the
   LP-share mixer pool and withdraw to a fresh recipient — at
   which point the LP claim is fully unlinkable to any specific
   deposit event.
6. **Funding-source hygiene.** Communicate to the user that the
   BTC funding source is the structural privacy floor. The dapp
   should surface a clear "use a fresh BTC wallet for maximum
   privacy" hint at the wrap step, and SHOULD support funding
   from a fresh address by default rather than the user's
   primary spending UTXO.

The protocol's job is to provide the privacy-preserving primitives
(amount privacy, fungibility, mixer-composable LP shares, Pedersen-
committed recovery routing). The dapp's job is to compose them so
the user's default action is the most private one available.

### 5.36.6 Reserved — bond-source obfuscation (future)

The current `bond_amount_TAC_LE` is cleartext in the envelope (binds
the asset-spend proof). A future amendment MAY upgrade the bond-
spend circuit to range-prove `bond_amount_TAC ∈ [floor, ceiling]`
from a Pedersen-committed amount, breaking the link to the specific
bond UTXO's amount. Defer to a follow-up amendment that ships
alongside range-proof-friendly bond accounting.

### 5.36.7 Blinded-pubkey recovery commit (normative)

`depositor_recovery_commit` is a single-generator additive blinding
of the depositor's recovery secp256k1 pubkey — mechanically identical
to a BIP-341 Taproot key tweak:

```
depositor_recovery_commit  =  depositor_recovery_pubkey  +  blinding · G
```

Where `G` is the secp256k1 generator and `blinding` is a uniformly
random 32-byte scalar `∈ [1, SECP_N − 1]`. The commit is a compressed
secp256k1 point (33 bytes). The depositor MUST retain
`(recovery_pubkey, blinding)` — typically derived deterministically
from the wallet seed (see §5.36.7.1 below) so recovery from the seed
alone is sufficient even after local-state loss.

#### 5.36.7.1 Recommended derivation

```
blinding =  HMAC-SHA256(
              wallet.priv,
              "tacit-cbtc-tac-recovery-blinding-v1"
              || network_tag
              || target_leaf_hash
            )  reduced mod SECP_N
recovery_pubkey  =  derived per the standard tacit staking-subkey
                    derivation (e.g., dapp/tacit.js:deriveStakingSubkey)
                    using a recovery-specific subkey domain
```

Both `recovery_pubkey` and `blinding` are deterministic functions of
`(wallet.priv, target_leaf_hash)`. A user who restores from seed
recovers both, and can therefore reconstruct
`tweaked_sk = (recovery_sk + blinding) mod SECP_N` to spend any UTXO
paid to `P2TR(x_only(depositor_recovery_commit))`.

#### 5.36.7.2 Verifying authorization signatures

Every position-mutating envelope across this amendment (TOP_UP,
SPLIT, BOND_RELEASE, DEPOSIT_ATOMIC, WITHDRAW_ATOMIC, lien-edge
opcodes — see §5.46–§5.49) carries a `depositor_sig` field signed
over `bind_hash`. The validator verifies these via standard BIP-340
Schnorr against the commit:

```
BIP340_verify(
  pubkey  = x_only(position.depositor_recovery_commit),
  msg     = bind_hash,
  sig     = depositor_sig
)
```

The depositor signs with `tweaked_sk = (recovery_sk + blinding) mod
SECP_N`. The verifier treats the commit as a normal Schnorr
verification key — no special handling, no opening, no extra envelope
fields. This is identical to how Taproot output keys are verified for
key-path spends.

#### 5.36.7.3 Paying to a position's recovery

Any protocol-emitted payout to a position's depositor (bond return,
insurance claim, force-close settlement) addresses the commit's P2TR:

```
script_pubkey  =  OP_PUSHNUM_1 || OP_PUSHBYTES_32
               || x_only(position.depositor_recovery_commit)
```

The depositor's tweaked secret unlocks it via key-path Schnorr.

#### 5.36.7.4 Privacy property

The recovery pubkey NEVER appears on chain in cleartext under this
scheme. The commit appears in (a) the deposit envelope, (b) the
position record, (c) the P2TR output script of any payout to that
position. All three references are the same 33-byte (or 32-byte
x-only) commit — which is computationally indistinguishable from a
fresh random secp256k1 pubkey for any adversary not given the
blinding. Cross-position clustering by repeated recovery pubkey is
structurally impossible: each position uses a fresh derivation, and
identical underlying pubkeys would still produce distinct commits
under distinct blindings.

#### 5.36.7.5 Soundness

- **Binding** of the commit to `(recovery_pubkey, blinding)`: standard
  discrete-log assumption. Given `commit`, an adversary cannot
  produce a different `(recovery_pubkey′, blinding′)` opening without
  solving DLOG.
- **BIP-340 unforgeability** under the commit-as-pubkey: identical to
  Taproot key-path security. The depositor must possess
  `tweaked_sk = recovery_sk + blinding` to sign. An adversary who
  recovers either `recovery_sk` alone OR `blinding` alone cannot
  forge — they need both (or the sum directly), which DLOG protects.
- **Recovery atomicity**: the bond-return Bitcoin output is locked to
  the commit's P2TR; only the depositor can spend it. If the
  depositor loses their wallet seed, the bond is permanently
  unrecoverable (same property native Bitcoin already has).

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
   bond_return_commit      33 bytes (compressed Pedersen point;
                                     names the TAC bond-return UTXO that
                                     materializes at reveal_tx.vout[1])
   bind_hash               32 bytes
   proof_length            2 bytes
   groth16_proof           VAR bytes (asset-spend over the cBTC.tac UTXOs)
```

**Bond return.** The reveal Bitcoin tx MUST produce a TAC-asset UTXO at
`vout[1]` that opens to `Pedersen(position.bond_amount_TAC, freshBlinding)`
and matches `bond_return_commit`. The output script is
`P2TR(x_only(position.depositor_recovery_commit))` at `DUST` sats —
the recovery commit is a BIP-340 / P2TR output key directly per §5.36.7,
spendable by the depositor under their tweaked recovery secret. The
depositor stores `freshBlinding` locally so the recovered bond UTXO is
spendable via the standard T_AXFER_VAR / CXFER path. Indexers recognize
the UTXO via `commitmentForUtxo` returning `(bond_return_commit,
position.tac_asset_id)`.

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

  // Return bond to the recovery commit's P2TR (per §5.36.7 — the commit
  // is itself a BIP-340 / Taproot output key; the depositor spends under
  // tweaked secret = (recovery_sk + blinding) mod n)
  // Full bond returned — no protocol-level withdrawal fee; depositor
  // compensation comes from holding cBTC.tac that earns its share of
  // insurance pool growth, plus AMM LP fees if they LP'd cBTC.tac pools.
  pay_TAC(position.depositor_recovery_commit, position.bond_amount_TAC)

  // Pay insurance claim if requested
  if insurance_claim_TAC > 0:
    pay_TAC(position.depositor_recovery_commit, insurance_claim_TAC)
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
  || bond_return_commit
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

> **v1 amendment — early-SLASH semantics.** The mechanism described
> below (paired TAC→cBTC.zk AMM swap, protocol-owned
> `redemption_reserve_BTC` UTXO, 50 bps liquidator reward, paired
> WITHDRAW that draws from the reserve) requires Bitcoin script
> primitives (covenants / OP_CAT) that are not deployed on mainnet.
> Every covenant-free realisation either reduces to a federated signer
> or lets a griefer steal the reserve.
>
> **v1 redefines T_CBTC_TAC_FORCE_CLOSE as a permissionless EARLY SLASH
> on ratio breach:** when `current_ratio < LIQUIDATION_RATIO` at confirm
> time, the bond TAC moves to the existing pooled insurance reserve
> (same path as `SLASH_DETECTED`, §5.39), the position transitions to
> `force-slashed`, and cBTC.tac holders are made whole via
> `T_SHARE_SLASH_CLAIM` (§5.39.4). The depositor's `K_btc` is never
> touched by the protocol — they retain custody. `cBTC.tac` supply is
> NOT debited; the outstanding shares represent a pro-rata claim on the
> augmented insurance pool.
>
> **No liquidator reward in v1** — cBTC.tac holders' own interest in
> securing their backing is the implicit incentive. The
> `liquidator_payout_pk` and `amm_swap_min_BTC_out` envelope fields are
> reserved (committed in `bind_hash`) but have no on-chain effect.
>
> **Redemption_reserve_BTC** is therefore unused in v1. §5.38.5
> (post-force-close redemption via reserve draw) does not apply —
> holders against `force-slashed` positions use `T_SHARE_SLASH_CLAIM`
> instead, identical to the rugged-position path.
>
> The validator-algorithm pseudocode in §5.38.4 below describes the
> covenant-based design retained for the follow-up amendment when
> trustless protocol-owned UTXOs become possible. The shipped v1
> behaviour is summarised above.

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

### 5.41.4 Governance scope

The protocol ships fully operational with the constants above
fixed at their default values. **No governance vote is required
for any operation.**

A subset of these parameters can OPTIONALLY be tuned by TAC DAO
governance within pre-defined safety bands (§5.46). Adjustments
outside the bands, or changes to load-bearing mechanics (slashing,
conservation invariants, settlement atomicity, cryptographic
primitives), require a formal SPEC amendment — not a vote.

This gives the protocol both immutability for safety-critical
properties and tunable flexibility for risk parameters that may
need to adapt to market conditions over years. The hard limits
are enumerated in §5.46.5.

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
- Used as collateral in cUSD.tac CDP (per SPEC-CUSD-TAC-AMENDMENT)
- LP'd into other AMM pools (e.g., cBTC.tac.lp/cUSD.tac pool —
  though this is a niche product surface)
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

## §5.45 Robustness mechanics

Three additions that deepen the protocol's resilience under stress.
Each is mechanical (no governance decision required to trigger),
chain-derived from observable state, and well-precedented in
production DeFi.

### 5.45.1 Stability fee

A continuous fee on bonded TAC, accruing per block to the insurance
pool. Funds the protocol's defensive reserve over time without
requiring governance to distribute revenue.

```
fee_per_block(position) = position.bond_amount_TAC × STABILITY_FEE_BPS / 10000 / BLOCKS_PER_YEAR
```

Where `BLOCKS_PER_YEAR = 52596` (Bitcoin's ~10-minute block target),
and `STABILITY_FEE_BPS = 25` (0.25% APR) by default.

Accrual is computed lazily — the indexer doesn't update every
position every block. Instead, at any event touching a position
(top-up, withdraw, force-close), the accrued fee since
`position.deposit_height` (or last event height) is computed and
moved from the bond to `insurance_pool_TAC`:

```
on event touching position[L] at block H:
  elapsed_blocks = H - position[L].last_fee_event_height
  accrued_fee_TAC = position[L].bond_amount_TAC × STABILITY_FEE_BPS × elapsed_blocks
                  / 10000 / BLOCKS_PER_YEAR
  insurance_pool_TAC += accrued_fee_TAC
  position[L].bond_amount_TAC -= accrued_fee_TAC
  position[L].last_fee_event_height = H
```

At healthy withdraw, the operator receives `bond_amount_TAC` after
all accrued fees have been deducted. The fee acts like a slow
demurrage on idle bond capital.

Economic effect: a 1-year-open 1 BTC position with 800,000 TAC bond
accrues 2,000 TAC of fees (0.25% × 800,000) to the insurance pool.
Modest enough not to deter long-duration positions, meaningful in
aggregate as TVL scales.

### 5.45.2 Liquidation penalty

An additional charge taken from the bond on `T_CBTC_TAC_FORCE_CLOSE`,
moved to the insurance pool. Discourages risky positions near the
liquidation threshold and funds defensive reserves.

```
on T_CBTC_TAC_FORCE_CLOSE:
  // [existing logic: rate-limit, health check, etc.]

  // Take penalty BEFORE AMM swap (in TAC, direct to insurance pool)
  penalty_TAC = position.bond_amount_TAC × LIQUIDATION_PENALTY_BPS / 10000
  insurance_pool_TAC += penalty_TAC

  // Remaining TAC swapped for BTC
  swap_TAC_input = position.bond_amount_TAC - penalty_TAC
  swap_BTC_output = amm_swap(TAC → cBTC.tac_canonical,
                             amount=swap_TAC_input,
                             min_out=envelope.amm_swap_min_BTC_out)

  // [existing logic: liquidator reward, reserve credit, position close]
```

Default `LIQUIDATION_PENALTY_BPS = 200` (2% of bond).

Net effect at force-close: 2% of bond goes to insurance pool, ~98%
swapped for BTC. Of the BTC output, 0.5% is liquidator reward and
the remainder credits redemption_reserve. The 2% penalty plus the
LIQUIDATION_RATIO buffer (1.2x means 20% over par) means the system
nets a 22% defensive buffer per force-close in expectation. Strong
solvency reinforcement.

### 5.45.3 Aggregate recovery mode

System-level invariant that triggers tighter rules when aggregate
collateralization degrades. Inspired by Liquity's recovery mode —
prevents one cascading position from dragging the system below
solvency.

The aggregate collateralization ratio:

```
aggregate_ratio(H) = (total_bonded_TAC × TWAP_TAC_per_BTC(H))
                  / total_cBTC.tac_supply
```

Trigger: `aggregate_ratio < AGGREGATE_RECOVERY_RATIO = 1.5x`

Effects when triggered:

1. **Effective liquidation threshold tightens** from `LIQUIDATION_RATIO`
   (1.2x) to `AGGREGATE_RECOVERY_RATIO` (1.5x). All positions below
   1.5x become force-closeable. This aggressively de-risks the
   collateral pool.
2. **`PAUSE_NEW_DEPOSITS` triggers** (§5.41.3). No new positions
   open while the system is in recovery.
3. **Withdrawals, force-closes, slash claims continue normally** —
   exits are never blocked.

Exit condition: `aggregate_ratio ≥ AGGREGATE_RECOVERY_RATIO`
sustained for `RECOVERY_EXIT_BLOCKS = 100` consecutive blocks. The
sustained-recovery requirement prevents oscillation around the
threshold.

The recovery mode is automatic from chain-observable state — no
vote, no manual trigger. It activates and deactivates based purely
on the aggregate_ratio crossing the threshold with the appropriate
direction and persistence.

### 5.45.4 Combined effect on per-share value

The three mechanics interact additively:

- **Stability fee**: insurance pool grows linearly with time × TVL
  even in absence of any rugs. Per-share insurance creeps upward.
- **Liquidation penalty**: insurance pool gains 2% per force-close
  event. Stress events build defensive buffer.
- **Recovery mode**: prevents per-share value from degrading below
  the aggregate floor; tightens parameters under stress.

Over a multi-year horizon with normal-volatility markets, this
produces a steady upward drift in cBTC.tac's intrinsic value above
1 BTC (insurance accrual exceeds rug losses in expectation). Under
stress, the recovery mode prevents catastrophic value loss.

### 5.45.5 Parameter additions to §5.41

New constants:

```
STABILITY_FEE_BPS         = 25      (0.25% APR on bond_amount_TAC)
LIQUIDATION_PENALTY_BPS   = 200     (2% of bond at force-close)
AGGREGATE_RECOVERY_RATIO  = 1.5     (recovery mode trigger)
RECOVERY_EXIT_BLOCKS      = 100     (sustained recovery before exit)
BLOCKS_PER_YEAR           = 52596   (~Bitcoin block target)
```

All have safety bands defined in §5.46.2 if tuned by governance.

---

## §5.46 Scoped TAC DAO governance

The protocol ships with fixed parameters that work without any
governance. This section defines **optional** governance hooks that
allow TAC holders to tune parameters within pre-defined safety
bands without re-introducing the broad governance-attack surface
we deliberately avoided.

The design principle: **mechanical defaults + bounded adjustability**.
TAC holders can refine risk parameters, but they cannot rescind
slashes, change settlement atomicity, or alter the fundamental
trust model. Hard limits are enumerated and enforced at the
validator level.

> **Day-1 governance posture.** Governance under §5.46 activates
> at the same time as cBTC.tac itself, per the joint activation
> conditions in `SPEC-GOVERNANCE-AMENDMENT.md` §6.11. The
> protocol-wide governance framework and the cBTC.tac wrapper ship
> together, with shared ceremony coordination. From launch onward,
> TAC holders have the OPTION to submit proposals tuning parameters
> within the safety bands of §5.46.2; they're not required to.
>
> The launch defaults (§5.41) are chosen to be conservatively safe
> across a wide range of TAC volatility and BTC price conditions.
> Most positions opened in the first months should never need
> governance intervention — the bands are wide enough to absorb
> normal market conditions. Governance is available for refinement
> as real-world data accumulates, not as a launch dependency.
>
> Hard limits (§5.46.5) remain immutable regardless. Even on day 1,
> governance cannot rescind slashing, change conservation
> invariants, alter settlement atomicity, or modify cryptographic
> primitives. Parameter adjustments stay within safety bands by
> validator enforcement.

### 5.46.1 Why TAC holders are the right governance class

TAC holders bear the protocol's economic risk: their TAC backstops
cBTC.tac via the bond mechanism, their LP positions feed the
oracle, their treasury funds protocol operations. Aligning the
governance class with the risk-bearing class is the cleanest
distribution-of-authority shape.

### 5.46.2 Tier A — Slow governance (14-day timelock)

These parameters affect the risk profile of new positions.
Adjustable within safety bands; changes apply prospectively only
(existing positions retain their fractionalize-time parameters).

| Parameter | Default | Safety band |
|---|---|---|
| `INITIAL_BOND_RATIO` | 2.0 | [1.5, 5.0] |
| `WARNING_RATIO` | 1.5 | [1.2, 2.5] |
| `LIQUIDATION_RATIO` | 1.2 | [1.1, 2.0] |
| `AGGREGATE_RECOVERY_RATIO` | 1.5 | [1.3, 2.5] |
| `STABILITY_FEE_BPS` | 25 | [0, 200] |
| `LIQUIDATION_PENALTY_BPS` | 200 | [0, 500] |
| `LIQUIDATOR_REWARD_FRACTION` | 0.005 | [0.001, 0.02] |
| `MAX_POOL_FRAC` | 0.10 | [0.05, 0.20] |
| `MAX_BONDED_FRAC_OF_TAC_FDV` | 0.25 | [0.10, 0.30] |
| `MAX_SINGLE_POSITION_BTC` | 10 BTC | [1 BTC, 50 BTC] |
| `TWAP_WINDOW` | 180 blocks | [60, 1440] |
| `MAX_FORCE_CLOSES_PER_BLOCK` | 5 | [1, 20] |
| `VOTE_TENURE_BLOCKS` | 100 | [6, 4032] |

Adjustments outside these bands require a formal SPEC amendment
(i.e., a hard fork), not a governance vote.

### 5.46.3 Tier B — Fast governance (24-hour timelock)

Emergency-tunable parameters for responding to acute conditions.
Shorter timelock balances safety response against governance
capture risk.

| Parameter | Default | Notes |
|---|---|---|
| Manual pause trigger | off | Forces `PAUSE_NEW_DEPOSITS` regardless of automatic conditions |
| Manual pause release | n/a | Lifts a manually-set pause (automatic conditions still apply) |
| `STALE_PRICE_BLOCKS` | 1000 | [100, 10000] |
| Oracle fallback source | primary | Switch to a designated backup AMM if primary becomes manipulated |

### 5.46.4 Tier C — Treasury / distribution (14-day timelock)

Decisions about accumulated reserves with no purely-mechanical
default destination. Tier C proposals MUST specify:

- **Exact destination**: a single deterministic recipient
  (Pedersen commitment, address, or escrow keyed by content hash).
  No discretionary multisig allocation; no recipient set to "TBD".
- **Exact amount**: precise TAC quantity or precise share of
  current pool balance, computable at vote-completion block.
  No "up to X" approvals.
- **One-shot only**: each proposal authorizes exactly one transfer.
  No recurring allocations, no streaming, no continuous spends
  without per-period re-approval.
- **No discretionary execution windows**: the transfer must execute
  within a bounded window after timelock expiry (e.g., 100 blocks);
  otherwise the proposal expires and must be re-proposed.

This tight scoping is deliberate: discretionary treasury spend is
the corner where DeFi governance most reliably fails (Frax,
MakerDAO post-RAI). Constraining each proposal to a single,
explicit transfer removes the surface area where mission creep,
unconscious spending, and capture dynamics emerge.

| Decision | Default absent governance | Notes |
|---|---|---|
| Insurance pool residue (if accumulated > 12 months without claim) | Remains in pool indefinitely | Tier C can propose redirecting to specific public-good destination |
| TAC fee accrual destination | Accrued to insurance pool by default | Tier C can propose alternate destination per the constraints above |
| New wrapper variant onboarding | Each requires its own SPEC amendment | Not a Tier C decision; protocol-amendment-level |

### 5.46.5 Hard limits — IMMUTABLE, cannot be changed by governance

These are load-bearing for the trust model. Changing any of these
requires a formal SPEC amendment plus coordinated deployment, NOT
a governance vote:

- **Cryptographic primitives**: Pedersen commit construction,
  Groth16 verification keys, Poseidon₂ specification, secp256k1
  hardness assumption.
- **Conservation invariants**: INV-POOL, INV-MINT, INV-1 from
  SPEC-CBTC-ZK-AMOUNT-AMENDMENT §5.28.
- **Slashing mechanics**: rug detection rules (INV-1 break →
  SLASH_DETECTED), bond destination (insurance pool, not
  rerouted by governance), per-share insurance computation.
- **Atomic settlement**: T_CBTC_TAC_WITHDRAW must atomically burn
  cBTC.tac + spend K_btc in one Bitcoin tx. No governance can
  decouple these.
- **Retroactivity prohibition**: a governance change to any Tier A
  parameter applies ONLY to new positions confirmed after the
  timelock expires. Existing positions retain their original
  parameters until natural close.
- **Opcode assignments**: 0x43–0x4E reservations are fixed by SPEC.
- **The trust model itself**: governance can't change "cBTC.tac is
  TAC-bonded" into something else. That would be a new wrapper
  variant under a different suffix.

### 5.46.6 Voting mechanism

Standard TAC-weighted on-chain governance:

- **Vote weight**: TAC balance at proposal-snapshot block, INCLUDING
  TAC backing the holder's LP positions in canonical AMM pools.
  The LP-derived TAC is computed by summing across ALL confirmed
  AMM pools for the (cBTC.tac, TAC) and (cBTC.zk, TAC) asset pairs
  (regardless of fee_bps tier or capability_flags). For each such
  pool, the holder's contribution is
  `(holder_lp_balance / pool_lp_supply) × pool_tac_reserve` at the
  snapshot block. The total vote_weight = direct_TAC_balance +
  Σ over canonical pools (LP-derived TAC). This means LPs vote with
  their full TAC economic exposure across all pool variants.
- **Minimum-balance tenure requirement** (anti-flash-mint defense):
  for both direct TAC balance AND each LP balance contributing to
  vote weight, the validator uses the MINIMUM balance held
  continuously over the window `[snapshot_block − VOTE_TENURE_BLOCKS,
  snapshot_block]`. Default `VOTE_TENURE_BLOCKS = 100`
  (~17 hours at Bitcoin's 10-min block target). This blocks the
  LP-flash-mint attack: an attacker who briefly LPs into the
  canonical pool at snapshot-block to inflate their voting weight
  finds their effective LP balance computed against the minimum
  they held continuously, which was zero before the flash-mint.
  Even without flash loans on Bitcoin today, this is the targeted
  defense against any future tacit lending primitive that could
  enable atomic borrow-LP-vote-unwind sequences.
- **Snapshot block timing**: proposal-snapshot block is the block at
  which the proposal envelope confirms. All balance reads (direct
  TAC + LP positions + circulating-supply denominator) sample at
  this height.
- **Reorg-aware vote semantics**: vote envelopes bind to
  `(proposal_id, voter_pubkey, snapshot_block_hash)`. A reorg that
  reorganizes the snapshot block invalidates the proposal and any
  votes against it; the proposal must be re-submitted under a new
  snapshot. This prevents replay of votes onto a different snapshot
  block state.
- **Proposal threshold**: 0.5% of circulating TAC at the
  proposal-snapshot block to submit a valid proposal.
- **Quorum**: ≥ 5% of circulating TAC AT THE PROPOSAL-SNAPSHOT BLOCK
  must participate. Pinning the supply denominator to snapshot time
  prevents attackers from inflating supply between proposal and
  vote-tally to fail quorum.
- **Approval threshold**: 60% of votes cast in favor.
- **Timelock**: per tier (14 days slow, 24 hours fast). Timelock
  starts at vote completion, not proposal submission.
- **Veto safety valve**: 67% supermajority can veto any pending
  proposal during its timelock window (prevents 50.1% capture).

**LP-aligned governance is a structural property.** LPs in the
canonical AMM pools are the participants whose actions directly
produce the oracle's TWAP signal. They have the strongest economic
incentive for oracle integrity (manipulating the price hurts their
own LP returns) and the best information about market conditions
(swap flows visible to them directly). Counting their TAC-side
LP exposure as voting weight auto-aligns oracle stewardship with
the people most affected by oracle decisions. No special "LP-only
vote class" is needed — the LP economic stake naturally amplifies
in oracle-relevant proposals.

The voting envelope format and validator logic are specified in
`SPEC-GOVERNANCE-AMENDMENT.md` (the protocol-wide governance
framework). This amendment defines the SCOPE of governance over
cBTC.tac parameters (which params, what bands, what tiers, how
vote weight is computed); the governance amendment defines the
voting MECHANISM (T_GOV_PROPOSAL / T_GOV_VOTE / T_GOV_VETO /
T_GOV_EXECUTE envelopes, snapshot mechanics, tally rules, state
machine).

cBTC.tac and the governance framework ship together at launch.
Both amendments' activation conditions must be met simultaneously:
ceremonies complete, code deployed, bootstrap thresholds satisfied
(per cBTC.tac §5.42, governance §6.11). From launch onward, all
parameters in §5.46.2 / §5.46.3 / §5.46.4 are at their default
values AND eligible for governance refinement.

cBTC.tac registers as a target amendment per SPEC-GOVERNANCE-AMENDMENT
§6.1.1, with `amendment_id = SHA256("SPEC-CBTC-TAC-AMENDMENT-v1")`.
The governable parameter set (§5.46.2 + §5.46.3 + §5.46.4), safety
bands, and vote-weight rule (§5.46.6) are read directly from this
amendment's spec text.

The protocol works fully without any governance vote ever happening.
Governance is opt-in usage for TAC holders, not a runtime
dependency. If no proposal ever passes, the protocol operates
indefinitely at launch defaults.

### 5.46.7 Existing-position protection (retroactivity rule)

A governance change to any Tier A parameter applies prospectively
only. Concretely:

```
on T_CBTC_TAC_DEPOSIT at block H:
  // Resolve parameters from governance state as of block H
  resolved_params = governance_params_at(H)
  position[target_leaf_hash].params_snapshot = resolved_params
  // ... rest of validator
```

All subsequent operations on the position use
`params_snapshot`, not the current-block parameters. If governance
later raises `INITIAL_BOND_RATIO` from 2.0 → 3.0, existing 2.0x
positions remain valid and can withdraw normally; new positions
must meet the 3.0x bar.

This is critical for user trust: operators can rely on the rules
under which they opened their position. Governance cannot
retroactively make their position liquidatable.

### 5.46.8 What happens if governance never activates

The protocol is fully operational without any governance vote.
Defaults are conservative and well-precedented. cBTC.tac can run
indefinitely with zero governance participation — all parameters
stay at their launch values, all mechanics execute as specified.

Governance is an OPTIONAL adjustment layer, not a required
operational dependency.

---

## §5.47 v1 lien model — trustless collateral without covenants

The original §5.36 / §5.38 design assumed a "deterministic escrow
address" for bond TAC (§5.35.1 line 232-234: *"no spending key — moves
only via tacit envelope state transitions"*). Implementing that
trustlessly on current Bitcoin requires covenant primitives (OP_CAT
or similar) that are not deployed on mainnet — without them, every
"protocol-owned UTXO spendable only via paired envelope" construction
either reduces to a federated signer or lets a griefer steal the
reserve.

v1 ships a covenant-free alternative: **the bond is an LP-share UTXO
of a (cBTC.zk-variant, TAC) AMM pool, held in the depositor's own
wallet, locked by a tacit-protocol-level lien.** The lien is enforced
by validator coordination (the same trust model that gives all tacit
assets value) — workers refuse to recognise any spend of a liened
UTXO, recipients refuse to accept tacit-invalid UTXOs, and the bond
is therefore economically immobile without the protocol's consent.

### 5.47.1 Why LP-shares (not raw TAC)

- **Fee yield while bonded** — the LP shares stay in the canonical
  AMM pool earning swap fees the whole time the position is open.
  Strict improvement over the original spec (where bond TAC sat
  inert at the depositor's recovery address) and over MakerDAO
  (where ETH in the vault earns nothing).
- **Natural BTC anchoring** — half the LP's value is the cBTC.zk
  side, which tracks BTC 1:1. Under a TAC death-spiral, the cBTC.zk
  half of the LP retains BTC value even as the TAC side erodes;
  cBTC.tac holders inherit this when they claim.
- **No new asset type** — uses tacit's existing LP-share machinery
  (`ammDeriveLpAssetId`, `T_LP_REMOVE`, etc.) without new primitives.

### 5.47.2 KV schema

```
ctac-lien:<lp_utxo_txid>:<lp_utxo_vout>     → {
  position_leaf_hash, lp_share_amount, lp_asset_id, pool_id,
  state: 'depositor' | 'claim-pool',
  attached_at_height, attached_at_txid,
  claim_pool_transferred_at_height?, claim_pool_transferred_reason?
}
ctac-pos-lien:<position_leaf_hash>          → "<lp_utxo_txid>:<lp_utxo_vout>"  (reverse index)
ctac-claim-pool                             → u64 (total LP shares pooled across all
                                                   force-closed / rugged positions)
```

### 5.47.3 Enforcement point

Lien enforcement lives in a single helper: `commitmentForUtxo` (the
worker's universal asset-UTXO resolver). It refuses any outpoint
whose lien is in `depositor` or `claim-pool` state, throwing as if
the UTXO doesn't exist. Every downstream consumer (`T_LP_REMOVE`,
`T_AXFER_VAR`, `T_SWAP_VAR`, `T_CXFER`, and every future asset-spend
opcode) hits this helper and automatically refuses liened spends.

The cBTC.tac handlers that legitimately need to read liened UTXOs
(`T_CBTC_TAC_DEPOSIT`, `T_CBTC_TAC_WITHDRAW`, `T_CBTC_TAC_FORCE_CLOSE`,
`T_CTAC_LIEN_CLAIM`, `T_CTAC_LIEN_SPLIT`) pass `skipLienCheck: true`
to bypass.

### 5.47.4 Lifecycle

```
   DEPOSIT (T_CBTC_TAC_DEPOSIT, 0x49)
       │
       │ attach lien (state: 'depositor')
       │
       ▼
    [active]  ◄────────── self-rescue via TAC recovery (no envelope)
       │
       ├─── cooperative ──── T_CBTC_TAC_WITHDRAW (0x4A) ──→ [withdrawn]
       │                       releases lien (delete);
       │                       slot K_btc spent by depositor;
       │                       cBTC.tac burned
       │
       ├─── partial ────── T_CTAC_LIEN_SPLIT (0x4F) ───→ [active, smaller lien]
       │                       depositor splits liened UTXO;
       │                       lien inherits onto one chosen output
       │                       (must still satisfy 2x collateralization)
       │
       ├─── force-close ── T_CBTC_TAC_FORCE_CLOSE (0x4B) ──→ [force-slashed]
       │                       LP-share BTC value < 1.2x slot;
       │                       lien transferred to claim pool;
       │                       state flips to 'claim-pool'
       │
       └─── rug ────────── SLASH_DETECTED (cron) ────────→ [rugged]
                              depositor spent K_btc outside protocol;
                              lien transferred to claim pool;
                              state flips to 'claim-pool'
```

### 5.47.5 T_CTAC_LIEN_CLAIM (opcode 0x4C, repurposed)

cBTC.tac holders claim pro-rata LP shares from the claim pool by
burning cBTC.tac shares. The wire format is the original
`T_SHARE_SLASH_CLAIM` (0x4C) layout; the semantics rebind
`claim_TAC` → `claim_LP_shares` and the recipient_commit names the
new LP-share UTXO. Math:

```
expected_lp_claim = claim_pool_LP_shares × share_burn_amount
                  / outstanding_cBTC.tac_supply
```

The claim mints a synthetic LP-share UTXO at `recipient_commit`.
The holder can then `T_LP_REMOVE` it for cBTC.zk + TAC at current
pool ratios, or hold it for AMM fee yield.

### 5.47.6 T_CTAC_LIEN_SPLIT (opcode 0x4F, new)

Lets the depositor split a liened LP-share UTXO into multiple
outputs while preserving the lien on one chosen output. Wire format:

```
T_CTAC_LIEN_SPLIT
   opcode                    1 byte  (0x4F)
   network_tag               1 byte
   position_leaf_hash       32 bytes (the liened position)
   source_outpoint          36 bytes (the liened LP-share UTXO being split)
   output_count              1 byte  (N, 2..8)
   for i in 0..N:
     output_amount_LE        8 bytes (u64; REVEALED — v1 splits are not
                                       amount-private to preserve the
                                       Pedersen balance check without
                                       requiring aggregated range proofs)
     output_blinding        32 bytes (REVEALED — opens the commit)
     output_commit          33 bytes (Pedersen commit; verified against
                                       (amount, blinding) tuple)
   lien_inherit_index        1 byte  (which output inherits the lien)
   depositor_sig            64 bytes (BIP-340 Schnorr over bind_hash
                                      under x_only(position.depositor_recovery_commit)
                                      per §5.36.7)
   bind_hash                32 bytes
```

Validator checks:
- Position exists + is `active`; lien exists + is `depositor` state.
- Source outpoint matches the lien record.
- Each output's revealed `(amount, blinding)` opens the declared commit.
- Sum of revealed amounts equals the lien's `lp_share_amount`.
- Inheriting output's amount × current LP-share BTC value still
  satisfies `INITIAL_BOND_RATIO × slot_denom_sats` at reorg-safe TWAP.
- Depositor's Schnorr sig verifies under
  `x_only(position.depositor_recovery_commit)` (§5.36.7).

Effects: source lien deleted; new lien attached at
`(reveal_tx.txid, lien_inherit_index)` with the smaller amount;
position record updated; aggregate `total_bonded_TAC` counter
decremented by the split-off portion. The unliened outputs are
freely spendable by the depositor.

### 5.47.7 Comparison to the original §5.36 / §5.38 design

| Aspect | Original spec | v1 lien model |
|---|---|---|
| Bond asset | Raw TAC at "protocol escrow address" | LP-share at depositor's wallet, liened |
| Escrow mechanism | Covenant ("no spending key") | Worker-enforced lien (social) |
| Fee yield while bonded | None | AMM swap fees on the LP shares |
| Force-close mechanism | AMM swap into `redemption_reserve_BTC` UTXO | Lien transfer to claim pool counter |
| Liquidator reward | 50 bps of swap output | None in v1 (cBTC.tac holders' self-interest) |
| Holder payout asset | BTC sats from reserve | LP shares (claimant can `T_LP_REMOVE`) |
| Trust assumption | Bitcoin script covenants | Validator coordination (same as all tacit assets) |
| Mainnet-shippable today | No (no OP_CAT) | Yes |

The economic invariants (2× initial collateral, 1.2× liquidation
threshold, pro-rata holder claim on slashed bond) are preserved.
The custody mechanism changes from covenant-based to coordination-based.

### 5.47.8 Reserved opcodes

`0x4D` and `0x4E` remain reserved per the existing comment block
(`SPEC-CBTC-ZK-AMOUNT-AMENDMENT` machinery). `0x4F` is allocated to
`T_CTAC_LIEN_SPLIT`. The original `T_SHARE_SLASH_CLAIM` constant
name at `0x4C` is preserved for wire-format parity; the
`T_CTAC_LIEN_CLAIM` identifier is exported as an alias.

---

## §5.48 atomic LP_ADD + DEPOSIT (`T_CBTC_TAC_DEPOSIT_ATOMIC`)

**Status:** ✅ shipped (worker + dapp + wire-parity tests). Follow-up addition
to §5.47 lien model providing one-tx bootstrap UX for depositors who don't
already hold canonical-pool LP shares.

**Motivation.** v1's `T_CBTC_TAC_DEPOSIT` (§5.47) requires the depositor
to already hold an LP-share UTXO of a TAC-paired pool. Bootstrap UX:
new depositors must (a) `T_LP_ADD` to create LP shares, wait for
confirmation, then (b) `T_CBTC_TAC_DEPOSIT` referencing that UTXO —
two cascading on-chain txs. This amendment collapses that into a single envelope:
provide cBTC.zk + TAC as raw asset inputs; the worker simultaneously
creates the LP shares (incrementing pool reserves) AND attaches the lien
on the resulting LP UTXO AND mints cBTC.tac. One commit/reveal pair
instead of two.

### 5.48.1 Opcode allocation

`T_CBTC_TAC_DEPOSIT_ATOMIC = 0x57` (next free after the drafted governance
opcodes 0x50–0x53 and cUSD.tac opcodes 0x54–0x56 — see SPEC.md §1.1
opcode table).

### 5.48.2 Wire format

```
T_CBTC_TAC_DEPOSIT_ATOMIC
   opcode                       1 byte   (0x57)
   network_tag                  1 byte
   target_leaf_hash            32 bytes  (the cBTC.zk slot's leaf hash)
   slot_denom_sats_LE           8 bytes  (u64)
   pool_id                     32 bytes  (the TAC-paired pool to LP into)
   delta_cbtc_zk_LE             8 bytes  (u64; cBTC.zk amount being LP'd)
   delta_tac_LE                 8 bytes  (u64; TAC amount being LP'd)
   share_amount_LE              8 bytes  (u64; LP shares minted to depositor — derived from pool curve)
   cbtc_zk_input_outpoint      36 bytes  (UTXO being consumed for cBTC.zk side)
   cbtc_zk_input_commit        33 bytes  (Pedersen commit of cBTC.zk input)
   tac_input_outpoint          36 bytes  (UTXO being consumed for TAC side)
   tac_input_commit            33 bytes  (Pedersen commit of TAC input)
   lp_share_commit             33 bytes  (Pedersen commit of the new LP-share UTXO,
                                          recipient P2TR = x_only(depositor_recovery_commit))
   depositor_recovery_commit   33 bytes  (blinded-pubkey commit per §5.36.7; BIP-340-
                                          spendable / P2TR output key; never opened)
   mint_amount_LE               8 bytes  (u64; cBTC.tac to mint; must equal slot_denom_sats)
   mint_recipient_commit       33 bytes  (Pedersen commit for new cBTC.tac UTXO)
   bind_hash                   32 bytes  (per §5.48.4)
   proof_length                 2 bytes  (u16 LE)
   groth16_proof               VAR bytes (asset-spend over both inputs + slot-ownership over target_leaf_hash)
```

### 5.48.3 Validator algorithm

```
on T_CBTC_TAC_DEPOSIT_ATOMIC:
  require envelope.network_tag matches local network
  require slot target_leaf_hash is live (existing §5.47 deposit check)
  require position[target_leaf_hash] does not exist
  require mint_amount == slot_denom_sats == leaf_record.denom_sats
  require anti-systemic pauses are clear (§5.41.3)

  // Input validation (both sides)
  cbtc_zk_input  := commitmentForUtxo(cbtc_zk_input_outpoint, skipLienCheck=true)
  tac_input      := commitmentForUtxo(tac_input_outpoint, skipLienCheck=true)
  require cbtc_zk_input.commitment == cbtc_zk_input_commit
  require tac_input.commitment == tac_input_commit
  // Neither input may already be liened (would double-encumber)
  require ctacGetLien(cbtc_zk_input_outpoint) is null
  require ctacGetLien(tac_input_outpoint) is null

  // Pool lookup + reserve math
  pool := ammPoolGet(pool_id)
  require pool exists and is validated
  require one side of pool is TAC (asset_a == TAC_AID or asset_b == TAC_AID)
  require cbtc_zk_input.asset_id is the non-TAC side
  require tac_input.asset_id == TAC_AID
  // Compute LP shares from pool curve (mirrors §5.46.6 ammLpAddShares variant 0)
  computed_shares := floor(min(delta_cbtc_zk × S / R_cbtc_zk,
                                delta_tac     × S / R_tac))
  require share_amount == computed_shares  // strict; no slop

  // Collateralization check at TWAP
  twap := ctacTwapSatsPerTac(at = confirm_height - REORG_SAFETY_DEPTH)
  lp_value_sats := ctacLpShareValueSats(pool_id, share_amount, twap).valueSats
  require lp_value_sats >= INITIAL_BOND_RATIO × slot_denom_sats

  // Aggregate caps (§5.41.2)
  require aggregate-MAX_POOL_FRAC check passes (existing §5.47 logic)

  // Effects — atomically:
  //   1. Consume both inputs (standard asset-spend nullification)
  //   2. Update pool reserves: R_cbtc_zk += delta_cbtc_zk, R_tac += delta_tac
  //   3. Update pool.lp_total_shares += share_amount
  //   4. Create LP-share UTXO at (this_tx.txid, 0) with commit lp_share_commit
  //   5. Create cBTC.tac mint UTXO at (this_tx.txid, 1) with commit mint_recipient_commit
  //   6. Attach lien on (this_tx.txid, 0) for position target_leaf_hash
  //   7. Record position (mirrors §5.47 deposit)
  //   8. Update aggregate counters (bonded_sats, bonded_lp_shares, agg_lp_value_sats)
```

### 5.48.4 bind_hash construction

```
bind_hash = SHA256(
  "tacit-ctac-deposit-atomic-v1"
  || network_tag
  || target_leaf_hash
  || slot_denom_sats_LE
  || pool_id
  || delta_cbtc_zk_LE || delta_tac_LE || share_amount_LE
  || cbtc_zk_input_outpoint || cbtc_zk_input_commit
  || tac_input_outpoint || tac_input_commit
  || lp_share_commit
  || depositor_recovery_commit
  || mint_amount_LE || mint_recipient_commit
)
```

### 5.48.5 Tx layout

```
vin[0] = commit P2TR (script-path with T_CBTC_TAC_DEPOSIT_ATOMIC envelope)
vin[1] = cBTC.zk_input_outpoint (asset-spend kernel sig + Groth16)
vin[2] = tac_input_outpoint (asset-spend kernel sig + Groth16)
vout[0] = LP-share UTXO at lp_share_commit
          (DUST P2TR to x_only(depositor_recovery_commit) per §5.36.7)
vout[1] = cBTC.tac mint UTXO at mint_recipient_commit
          (DUST P2TR to x_only(depositor_recovery_commit) per §5.36.7)
```

### 5.48.6 UX surface

Dapp adds an "atomic deposit" toggle to the cBTC.tac deposit section.
When enabled:
- Depositor picks slot + provides cBTC.zk + TAC inputs
- Pool selector defaults to the deepest TAC-paired pool with the slot's
  cBTC.zk variant on the other side
- Single click → single Bitcoin tx → atomic position open

When disabled (default): the v1.0 flow (depositor must pre-LP, then
deposit referencing existing LP UTXO).

### 5.48.7 Backwards compatibility

`T_CBTC_TAC_DEPOSIT_ATOMIC` is purely additive — `T_CBTC_TAC_DEPOSIT`
(0x49) continues to function unchanged. Depositors with existing LP
UTXOs use 0x49; new depositors with raw cBTC.zk + TAC use 0x50.

### 5.48.8 Implementation scope

- Worker: new envelope decoder + handler; ~250 LOC. Reuses existing
  ammLpAddShares math + ctacLpShareValueSats + lien helpers.
- Dapp: new wire primitives + builder; ~300 LOC. Builds tx with 2 asset
  inputs instead of 0.
- Tests: cross-impl wire parity + handler integration tests + signet
  E2E variant; ~200 LOC.
- Total: ~750 LOC + ~1 day of careful work.

### 5.48.9 Output blinding derivation (seed-recovery)

Both output Pedersen blindings are HMAC-derived from the depositor's
private key so the position recovers from priv key + chain data alone
after a localStorage wipe. No client-side state is required to find,
verify, or spend either output.

LP-share blinding (`vout[0]`):
```
r_lp_share_secp = HMAC-SHA256(
  recipient_privkey,
  "tacit-amm-receipt-secp-v1"
  || pool_id
  || cbtc_zk_input_outpoint      // == vin[1] outpoint, in-envelope
  || lp_asset_id                  // == deriveLpAssetId(pool_id)
)  mod n_secp
```
This is the same derivation as a standard variant-0 `T_LP_ADD` output —
the LP-share is recovered through the existing AMM LP_ADD scanner branch
when pool_id is supplied by the envelope.

cBTC.tac mint blinding (`vout[1]`):
```
r_mint_secp = HMAC-SHA256(
  recipient_privkey,
  "tacit-cbtc-tac-atomic-mint-v1"
  || target_leaf_hash
  || cbtc_zk_input_outpoint      // anchor matches the LP-share derivation
)  mod n_secp
```
Domain tag is distinct from the AMM receipt scheme so the mint blinding
cannot collide with any LP-share blinding. The standard (non-atomic)
`T_CBTC_TAC_DEPOSIT` mint UTXO uses the same domain and helper with
`anchor = bondSourceOutpoint` (the bonded LP-share input outpoint).

Both derivations use rejection sampling: if the base HMAC reduces to
zero mod the group order, retry with a one-byte counter suffix. Required
once per 2²⁵⁶ calls; preserves the unconditional hiding property of
Pedersen commitments.

---

## §5.49 atomic WITHDRAW + LP_REMOVE (`T_CBTC_TAC_WITHDRAW_ATOMIC`)

**Status:** ✅ shipped (worker + dapp + wire-parity tests). Symmetry-mirror
of §5.48: one envelope that closes a cBTC.tac position, removes the freed
LP shares from the pool, and pays out BTC + cBTC.zk + TAC to the depositor.

### 5.49.1 Motivation

Cooperative withdraw under §5.47 frees the LP-share UTXO (lien deleted)
but leaves the depositor holding LP shares. To fully exit back to raw
cBTC.zk + TAC, they'd then need a separate `T_LP_REMOVE` tx — UX cost.
`T_CBTC_TAC_WITHDRAW_ATOMIC` collapses both into one tx.

### 5.49.2 Opcode allocation

`T_CBTC_TAC_WITHDRAW_ATOMIC = 0x58`.

### 5.49.3 Wire format

```
T_CBTC_TAC_WITHDRAW_ATOMIC
   opcode                   1 byte   (0x58)
   network_tag              1 byte
   target_leaf_hash        32 bytes
   slot_denom_sats_LE       8 bytes
   burn_count               1 byte   (M, 1..16)
   burn_nullifiers         M × 32 bytes
   burn_commits            M × 33 bytes  (must Pedersen-sum to burn_amount)
   burn_amount_LE           8 bytes  (must = position.mint_amount = slot_denom_sats)
   lp_share_amount_LE       8 bytes  (must = position lien.lp_share_amount)
   recv_cbtc_zk_commit     33 bytes  (Pedersen commit for cBTC.zk LP_REMOVE output)
   recv_tac_commit         33 bytes  (Pedersen commit for TAC LP_REMOVE output)
   bind_hash               32 bytes
   proof_length             2 bytes
   groth16_proof           VAR bytes  (asset-spend over cBTC.tac UTXOs + LP UTXO)
```

### 5.49.4 Validator algorithm

```
on T_CBTC_TAC_WITHDRAW_ATOMIC:
  require envelope.network_tag matches local network
  position := positions[target_leaf_hash]
  require position exists and position.state == "active"
  require burn_amount == position.mint_amount == slot_denom_sats
  require lp_share_amount == position.bond_amount_tac

  // SAFETY GATE 1: slot K_btc must be spent in this tx
  require tx.vin contains (position.slot_mint_txid, 0)

  // SAFETY GATE 2: lien LP-share UTXO must be spent in this tx
  lien := liens[position.lien_outpoint]
  require lien exists and lien.state == "depositor"
  require tx.vin contains lien.outpoint

  // LP_REMOVE math against current pool reserves
  pool := pools[position.bond_pool_id]
  require pool is verified
  require pool side mapping consistent with TAC asset_id
  delta_cbtc := lp_share_amount × R_cbtc / pool.lp_total_shares
  delta_tac  := lp_share_amount × R_tac / pool.lp_total_shares
  require delta_cbtc > 0 and delta_tac > 0

  // Effects (atomic)
  pool.reserve_cbtc -= delta_cbtc
  pool.reserve_tac  -= delta_tac
  pool.lp_total_shares -= lp_share_amount
  position.state := "withdrawn"
  position.atomic_withdraw := true
  outstanding_cBTC.tac_supply -= burn_amount
  total_bonded_lp_shares -= lp_share_amount
  total_bonded_sats -= slot_denom_sats
  aggregate_lp_value_sats -= position.initial_lp_value_sats
  delete lien
  emit withdraw_event(target_leaf_hash, burn_amount)
```

### 5.49.5 Tx layout

```
vin[0]   = commit P2TR (script-path with envelope)
vin[1]   = slot K_btc UTXO (key-path Schnorr under r_btc — SAFETY GATE 1)
vin[2..M+1] = cBTC.tac UTXOs (asset-spend kernel sigs)
vin[M+2] = liened LP-share UTXO (worker bypasses lien check for this
           outpoint via skipLienCheck — SAFETY GATE 2 requires it spent)
vout[0]  = BTC payout (slot_denom_sats minus fees) to recipientAddr
vout[1]  = cBTC.zk UTXO at recv_cbtc_zk_commit (DUST P2WPKH to depositor)
vout[2]  = TAC UTXO at recv_tac_commit (DUST P2WPKH to depositor)
```

### 5.49.6 commitmentForUtxo resolution

`commitmentForUtxo` recognises vout[1] as `(recv_cbtc_zk_commit, position.slot_asset_id)` and vout[2] as `(recv_tac_commit, TAC_ASSET_ID)`. The depositor can then spend these as ordinary asset UTXOs.

### 5.49.7 Backwards compatibility

`T_CBTC_TAC_WITHDRAW_ATOMIC` is additive — the existing
`T_CBTC_TAC_WITHDRAW` (0x4A, §5.47) continues to function. Depositors who
want to keep the LP-share UTXO (for AMM fee yield) use 0x4A; those who
want to fully exit back to raw assets use 0x58.

### 5.49.8 Output blinding derivation (seed-recovery)

The two LP_REMOVE proceeds (`vout[1]` cBTC.zk side, `vout[2]` TAC side)
both use the standard AMM receipt-blinding scheme:

```
r_leg_secp = HMAC-SHA256(
  recipient_privkey,
  "tacit-amm-receipt-secp-v1"
  || pool_id
  || lp_share_input_outpoint     // outpoint of vin[N-1], the bond UTXO
  || canonical_asset_id           // canonA or canonB per pool ordering
)  mod n_secp
```

Pool_id is NOT present in the withdraw envelope (the envelope binds the
position via `target_leaf_hash`, and pool identity is implicit from the
LP-share input's asset_id). A wallet recovering from priv key + chain
alone reads pool_id from the local position record; if that record is
gone, pool_id can be fetched from the worker via `/ctac/lien/<leaf>` (an
authenticated indexer lookup, NOT trustless) before deriving the leg
blinding. The withdraw proceeds otherwise behave as ordinary asset UTXOs
post-recovery.

---

## Test coverage (actual)

Shipped + green at time of writing (333 unit tests + signet round-trip).

**Unit / cross-impl parity** (`tests/cbtc-tac-*.test.mjs`):

- `cbtc-tac-wire.test.mjs` — 174/174 pass. Encoder/decoder round-trip
  for all cBTC.tac opcodes: `T_CBTC_TAC_DEPOSIT` (0x49), `T_CBTC_TAC_WITHDRAW`
  (0x4A), `T_CBTC_TAC_FORCE_CLOSE` (0x4B), `T_CTAC_LIEN_CLAIM` (0x4C),
  `T_CTAC_LIEN_SPLIT` (0x4F), `T_CBTC_TAC_DEPOSIT_ATOMIC` (0x57),
  `T_CBTC_TAC_WITHDRAW_ATOMIC` (0x58). Verifies bind-hash byte-determinism
  across dapp + worker, decoder rejects on every adversarial mutation
  (wrong opcode, wrong length, malformed points, zero amounts, zero
  proofs, bind-hash tampering, count out of range), canonical-manifest
  validator covers tier shape edge cases.
- `cbtc-tac-state.test.mjs` — 146/146 pass. Worker handler state
  transitions for all opcodes; pause-mode logic (stale TWAP, bootstrap
  pending, AMM pause, aggregate recovery); pre-deposit aggregate caps
  (MAX_POOL_FRAC, MAX_BONDED_FRAC_OF_TAC_FDV); §5.45.1 stability fee
  accrual; lien index + claim pool transitions; cron-driven FORCE_CLOSE
  rewire to v1 lien model.
- `cbtc-tac-recovery.test.mjs` — 13/13 pass. Pins the §5.48.9 / §5.49.8
  HMAC blinding derivation: LP-share + cBTC.tac mint + LP_REMOVE legs.
  Verifies builder ↔ scanner parity, domain-tag separation, anchor
  uniqueness, priv-key sensitivity, Pedersen commits open against
  recovered blindings.

**Signet round-trip** (`tests/cbtc-tac-signet-prestage.mjs`):

End-to-end on real Bitcoin signet, fresh wallet, fresh assets, fresh
pool, fresh slot. Six confirmed phases:

1. T_CETCH — TACO asset (10B base units, TAC stand-in)
2. T_CETCH — WAGMI asset (100B base units, cBTC.zk stand-in)
3. T_SLOT_MINT — cBTC.zk slot at 500k-sat denom
4. T_LP_ADD (POOL_INIT variant) — (WAGMI, TACO) pool with 1B/1B reserves
5. T_CBTC_TAC_DEPOSIT_ATOMIC — 1 envelope, 1 tx: cBTC.zk + TAC inputs →
   LP-share + cBTC.tac mint outputs. Confirmed block 304921.
6. T_CBTC_TAC_WITHDRAW_ATOMIC — 1 envelope, 1 tx: burn cBTC.tac +
   LP-share input → BTC payout + cBTC.zk + TAC LP_REMOVE outputs.
   Confirmed block 304923. Payout 498,298 sats (500k slot − fees).

The prestage script is resumable via `.local/cbtc-tac-prestage-state.json`
and persists the full slot record + atomic position record so subsequent
phases can be re-driven from a fresh process without redepositing.

**Wallet seed-recovery regression check** (`tests/wallet-seed-recovery-signet.mjs`):

Read-only against the AMM full-e2e harness state. 12 PASS, 0 fail. Confirms
that wiping localStorage and importing only the depositor's priv key
recovers all AMM-derived UTXOs (CETCH/CXFER/LP_ADD/LP_REMOVE/SWAP_VAR/
FEE_CLAIM) and the cBTC.tac mint UTXOs (now HMAC-derived per §5.48.9).
cBTC.zk slot UTXOs remain in the "slot-record-required" category — the
recovery secret + nullifier preimage cannot be derived from priv key
alone by design.

> Operator note: signet tests using `scanHoldings` should set a custom
> API base to mempool.space directly via the `tacit-custom-api-v1`
> localStorage key. The CF worker proxy is ~25× slower than direct for
> uncached signet routes (~16s vs ~0.6s per request), which blows the
> 90s scan timeout. The three live signet test files
> (`cbtc-tac-signet-prestage.mjs`, `cbtc-tac-onchain-e2e-signet.mjs`,
> `wallet-seed-recovery-signet.mjs`) ship with this bypass pre-wired.

**Coverage gaps (open work, NOT shipped)**:

- Non-atomic T_CBTC_TAC_DEPOSIT / T_CBTC_TAC_WITHDRAW lifecycle on
  signet (covered by tests/cbtc-tac-onchain-e2e-signet.mjs but not
  re-run after the HMAC-blinding switch in this amendment).
- T_CBTC_TAC_FORCE_CLOSE on-chain rehearsal (worker handler covered by
  unit tests; envelope cron-rewire covered; chain-side adversarial
  scenarios pending).
- SLASH_DETECTED full path on signet (depositor rugs K_btc, worker fires
  slash after REORG_SAFETY_DEPTH). Unit-tested; signet rehearsal pending.
- T_SHARE_SLASH_CLAIM pooled-insurance distribution on signet.
- Pre-deposit cap rejection on signet (worker enforces; unit test
  green; chain-replay pending).
- Per-pool AMM ceremony (placeholder VK CIDs in atomic-deposit builder
  pending the per-pool ceremony — atomic envelopes can be reproved once
  the canonical pool's verifying key is pinned).

---

## Test plan (aspirational, deeper coverage)

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

## §5.50 lien top-up (`T_CBTC_TAC_TOP_UP`)

**Status:** ✅ wire spec frozen. Worker handler + dapp builder + scanner
branch pending.

### 5.50.1 Motivation

Under §5.47 v1 lien model, a position's collateral ratio is fixed at
deposit time (initial bond) and drifts only with TWAP. A depositor
facing a TAC price decline today has no in-band response: their only
options are (a) close the position via `T_CBTC_TAC_WITHDRAW` and
re-deposit with more collateral (requires holding the full minted
cBTC.tac, which they may have transferred or sold), or (b) ride out the
ratio decline and risk SLASH if the position underwater-triggers.

This is strictly worse UX than MakerDAO, where depositors can lock
additional collateral against an open vault at any time without
unwinding. `T_CBTC_TAC_TOP_UP` closes that gap: spend the current bond
LP-share + additional LP-share(s) of the same pool, produce one
combined LP-share UTXO with the lien transferred, position record
updated to reflect the larger bond.

cBTC.tac is untouched — no mint, no burn. Pure collateral-strengthening.

### 5.50.2 Opcode allocation

`T_CBTC_TAC_TOP_UP = 0x59`

### 5.50.3 Wire format

```
opcode                  1 byte    (0x59)
network_tag             1 byte    (0x00 mainnet, 0x01 signet, 0x02 regtest)
target_leaf_hash        32 bytes  (position being topped up)
old_bond_outpoint       36 bytes  (current bond UTXO; vin[1])
old_bond_commit         33 bytes  (Pedersen point of current bond)
old_bond_amount_LE      8 bytes   (opens old_bond_commit)
add_count               1 byte    (1..15 additional inputs)
for i in 0..add_count-1:
  add_outpoint[i]       36 bytes  (vin[2+i])
  add_commit[i]         33 bytes
  add_amount_LE[i]      8 bytes
new_bond_commit         33 bytes  (combined LP-share commit)
new_bond_amount_LE      8 bytes   (sum = old + Σ add)
new_bond_blinding       32 bytes  (opens new_bond_commit; recoverable via §5.50.8)
depositor_sig           64 bytes  (Schnorr over bind_hash under
                                   x_only(position.depositor_recovery_commit) per §5.36.7)
bind_hash               32 bytes
```

No ZK proof — all amounts + blindings are revealed (same privacy model
as `T_CTAC_LIEN_SPLIT`). Pedersen balance enforces conservation
homomorphically against the on-chain input commits resolved by the
worker.

### 5.50.4 bind_hash construction

```
bind_hash = SHA256(
  "tacit-ctac-topup-v1"
  || network_tag
  || target_leaf_hash
  || old_bond_outpoint || old_bond_commit || old_bond_amount_LE
  || u8(add_count)
  || add_outpoint[0] || add_commit[0] || add_amount_LE[0]
  || ...
  || add_outpoint[add_count-1] || add_commit[add_count-1] || add_amount_LE[add_count-1]
  || new_bond_commit || new_bond_amount_LE || new_bond_blinding
)
```

### 5.50.5 Tx layout

```
vin[0] = commit P2TR (script-path with T_CBTC_TAC_TOP_UP envelope)
vin[1] = old bond LP-share UTXO (currently liened)
vin[2..1+add_count] = additional LP-share UTXOs (same lp_asset_id, unliened)
vout[0] = new combined LP-share UTXO at new_bond_commit
          (DUST P2TR to x_only(position.depositor_recovery_commit) per §5.36.7;
           gets the transferred lien)
```

### 5.50.6 Validator algorithm

Refuse the envelope (return without state change) if any of:

1. Decoder rejects (length, opcode mismatch, network tag wrong, etc.)
2. Position lookup fails OR `position.state !== 'active'`
3. `ctacGetPositionLien(target_leaf_hash)` returns `null` OR the lien's
   outpoint doesn't match `old_bond_outpoint`
4. `add_count == 0` OR `add_count > 15`
5. Source UTXO not actually spent in `tx.vin` (replay-safety gate —
   prevents synthetic-output attacks identical to §5.47 LIEN_SPLIT)
6. Any `add_outpoint[i]` is currently liened (`ctacGetLien` returns
   non-null with `state === 'depositor'`) — refuse top-up with already-
   committed collateral
7. Any `add_outpoint[i]` resolves to a different `asset_id` than the
   position's `bond_lp_asset_id`
8. Pedersen balance: `pedersen(new_bond_amount, blinding_implicit_via_homomorphy)`
   must equal `old_bond_commit + Σ add_commit[i]` (point-wise)
9. Asset balance: `new_bond_amount = old_bond_amount + Σ add_amount[i]`
10. Each commit opens to its declared amount (use the on-chain UTXO's
    commit for the consumed inputs, NOT the envelope's `_commit` fields
    — the envelope-declared commits are bind-only)
11. Schnorr sig over `bind_hash` verifies under
    `x_only(position.depositor_recovery_commit)` (§5.36.7)

State effects on success:

```
ctacDeleteLien(env, network, old_bond_outpoint.txid, old_bond_outpoint.vout)
for i in 0..add_count-1: (no-op — these were unliened)
ctacPutLien(env, network, tx.txid, 0, {
  ...old_lien,
  lp_share_amount: new_bond_amount,
  attached_at_height: h,
  attached_at_txid: tx.txid,
  topup_from_outpoint: old_bond_outpoint,
})
ctacPutPositionLien(env, network, target_leaf_hash, tx.txid, 0)

position.bond_lp_share_amount = new_bond_amount
position.bond_source_outpoint = (tx.txid, 0)
position.last_topup_height = h
// bond_amount_tac is revalued LAZILY by callers (ctacLpShareValueSats
// at withdraw / SLASH / cap-check), so we don't snapshot it here.
ctacAddTotalBondedTac(env, network, +Σ add_amount[i])
ctacPutPosition(env, network, position)
```

### 5.50.7 commitmentForUtxo resolution

The new combined LP-share at `(tx.txid, 0)` resolves to
`(new_bond_commit, position.bond_lp_asset_id)`. The handler attaches the
lien on this output, so a downstream `T_LP_REMOVE` against it is
blocked (the lien check fires in the standard LP-share commit path).

### 5.50.8 Output blinding derivation (seed-recovery)

The combined LP-share blinding is HMAC-derived from the depositor's
private key so the position recovers from priv + chain alone after a
localStorage wipe:

```
r_topup_secp = HMAC-SHA256(
  recipient_privkey,
  "tacit-ctac-topup-bond-v1"
  || target_leaf_hash
  || old_bond_outpoint
)  mod n_secp
```

Anchor is the old bond outpoint (unambiguous chain witness — exactly one
top-up envelope can spend any given liened UTXO). The recovery branch
in `scanHoldings` decodes the envelope, derives the blinding, opens the
`new_bond_commit` against `(new_bond_amount, r_topup_secp)`.

### 5.50.9 Backwards compatibility

Additive. Existing positions without top-up activity remain valid; the
worker's existing handlers (`T_CBTC_TAC_WITHDRAW`, `T_CTAC_LIEN_SPLIT`,
SLASH_DETECTED) read `position.bond_lp_share_amount` and
`position.bond_source_outpoint` as before — the top-up handler updates
both atomically.

---

## §5.51 partial bond release (`T_CBTC_TAC_BOND_RELEASE`)

**Status:** ✅ wire spec frozen. Worker handler + dapp builder + scanner
branch pending.

### 5.51.1 Motivation

Symmetric inverse of §5.50: a position whose ratio is well above the
liquidation threshold can release some bonded LP-shares back to the
depositor without unwinding the cBTC.tac mint. Matches MakerDAO's
"withdraw excess collateral" UX.

Risk floor: post-release ratio MUST still satisfy
`INITIAL_BOND_RATIO_THOUSANDTHS` at current TWAP. Releasing below that
ratio is refused — releases must leave the position safely above the
liquidation threshold, NOT just above the slash threshold.

### 5.51.2 Opcode allocation

`T_CBTC_TAC_BOND_RELEASE = 0x5A`

### 5.51.3 Wire format

```
opcode                  1 byte    (0x5A)
network_tag             1 byte
target_leaf_hash        32 bytes
old_bond_outpoint       36 bytes  (current bond UTXO; vin[1])
old_bond_commit         33 bytes
old_bond_amount_LE      8 bytes
new_bond_commit         33 bytes  (smaller liened LP-share at vout[0])
new_bond_amount_LE      8 bytes   (> 0; < old_bond_amount)
new_bond_blinding       32 bytes  (opens new_bond_commit; recoverable via §5.51.8)
release_commit          33 bytes  (unliened LP-share at vout[1])
release_amount_LE       8 bytes   (= old_bond_amount - new_bond_amount; > 0)
release_blinding        32 bytes  (opens release_commit; recoverable via §5.51.8)
recipient_pk            33 bytes  (compressed; release goes to this key)
depositor_sig           64 bytes  (Schnorr over bind_hash under
                                   x_only(position.depositor_recovery_commit) per §5.36.7)
bind_hash               32 bytes
```

No ZK proof — same model as §5.50.

### 5.51.4 bind_hash construction

```
bind_hash = SHA256(
  "tacit-ctac-release-v1"
  || network_tag
  || target_leaf_hash
  || old_bond_outpoint || old_bond_commit || old_bond_amount_LE
  || new_bond_commit || new_bond_amount_LE || new_bond_blinding
  || release_commit || release_amount_LE || release_blinding
  || recipient_pk
)
```

### 5.51.5 Tx layout

```
vin[0] = commit P2TR (script-path with T_CBTC_TAC_BOND_RELEASE envelope)
vin[1] = old bond LP-share UTXO (currently liened)
vout[0] = new smaller liened LP-share at new_bond_commit
          (DUST P2TR to x_only(position.depositor_recovery_commit) per §5.36.7)
vout[1] = release LP-share at release_commit (DUST P2WPKH to recipient_pk)
```

### 5.51.6 Validator algorithm

Refuse if any of:

1. Decoder rejects
2. Position lookup fails OR `position.state !== 'active'`
3. Position lien doesn't match `old_bond_outpoint`
4. `new_bond_amount == 0` OR `release_amount == 0` (use full withdraw
   for the all-out case; use top-up to add more — release is strictly
   non-trivial partial)
5. `old_bond_amount != new_bond_amount + release_amount`
6. Source UTXO not actually spent in `tx.vin` (replay-safety gate)
7. Pedersen balance: `old_bond_commit == new_bond_commit + release_commit`
   (point-wise sum, mod 2²⁵⁶)
8. Each output commit opens to its declared amount
9. Post-release collateralization check:
   ```
   lp_value_after = ctacLpShareValueSats(pool_id, new_bond_amount, twap)
   ratio_after = lp_value_after * 1000 / slot_denom_sats
   refuse if ratio_after < CTAC_INITIAL_BOND_RATIO_THOUSANDTHS
   ```
   Note: uses `INITIAL` not `LIQUIDATION` — release must leave the
   position in deposit-acceptable territory, not just outside slash.
10. Schnorr sig over `bind_hash` verifies under
    `x_only(position.depositor_recovery_commit)` (§5.36.7)
11. Aggregate pause: refuse if `ctacComputePauseStatus()` returns
    `aggregate_recovery` — during global stress depositors cannot
    extract collateral from the system

State effects on success:

```
ctacDeleteLien(env, network, old_bond_outpoint.txid, old_bond_outpoint.vout)
ctacPutLien(env, network, tx.txid, 0, {
  ...old_lien,
  lp_share_amount: new_bond_amount,
  attached_at_height: h,
  attached_at_txid: tx.txid,
  release_from_outpoint: old_bond_outpoint,
})
ctacPutPositionLien(env, network, target_leaf_hash, tx.txid, 0)
position.bond_lp_share_amount = new_bond_amount
position.bond_source_outpoint = (tx.txid, 0)
position.last_release_height = h
ctacAddTotalBondedTac(env, network, -release_amount)
ctacPutPosition(env, network, position)
```

### 5.51.7 commitmentForUtxo resolution

`vout[0]` → `(new_bond_commit, position.bond_lp_asset_id)` with lien.
`vout[1]` → `(release_commit, position.bond_lp_asset_id)` unliened —
the recipient can freely `T_LP_REMOVE` or transfer it.

### 5.51.8 Output blinding derivation (seed-recovery)

```
r_new_bond_secp = HMAC-SHA256(
  recipient_privkey,
  "tacit-ctac-release-bond-v1"
  || target_leaf_hash
  || old_bond_outpoint
)  mod n_secp

r_release_secp = HMAC-SHA256(
  recipient_privkey,
  "tacit-amm-receipt-secp-v1"
  || pool_id
  || old_bond_outpoint
  || lp_asset_id
)  mod n_secp
```

The release blinding piggybacks on the standard AMM receipt scheme so a
recipient who is not the depositor (cross-key release) can still recover
the unliened output via the existing AMM scanner branch when the
recipient's privkey produces the matching commit.

### 5.51.9 Backwards compatibility

Additive. The post-release ratio refusal at `INITIAL_BOND_RATIO` (vs.
`LIQUIDATION_RATIO`) is intentionally stricter than the slash threshold
— it prevents users from releasing into a barely-collateralized state
that would slash on the next TWAP tick. Operators can tune
`CTAC_RELEASE_RATIO_THOUSANDTHS` independently if a different floor
becomes desirable post-launch (default == `INITIAL_BOND_RATIO`).

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
   fee on the canonical cBTC.tac/TAC AMM pool. The default LP-fee
   accrues to LPs (standard Uniswap-V2 path). The pool MAY ALSO
   pin a **protocol-fee skim** on top, with the recipient address
   set to the **insurance-pool sentinel** defined in AMM.md
   §"Insurance-pool sentinel (cBTC.tac/TAC canonical pool)":

   - `protocol_fee_address = 0x01 || SHA256("tacit-amm-protocol-fee-insurance-v1")`
   - `protocol_fee_bps` set modestly (recommended 100–250 bps =
     1–2.5% of LP-fee growth, NOT the 1000 cap).

   When the sentinel is pinned, `T_PROTOCOL_FEE_CLAIM` is
   permissionless (no claim_sig verification) and applies a
   synthetic LP_REMOVE inline: the TAC side of the redeemed
   reserves credits `insurance_pool_TAC`, and the cBTC.tac side
   burns `outstanding_cBTC.tac_supply` (anti-dilutive: raises
   `per_share_insurance_TAC` for remaining holders). See AMM.md
   for the full validator algorithm; this amendment is the
   accounting authority for the `insurance_pool_TAC` credit and
   the `outstanding_cBTC.tac_supply` debit that result. The
   canonical pool's launcher SHOULD choose the sentinel at
   POOL_INIT to align the protocol-fee stream with cBTC.tac
   solvency rather than route it to any individual pubkey.

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
