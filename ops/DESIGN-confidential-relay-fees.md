# Confidential relay fees — gasless privacy across the pool

## Goal

Make third-party **relaying an option for every confidential action**, not just the gasless
exit. A user who proves an op should be able to hand it to a relay box that submits
`ConfidentialPool.settle()` and pays the gas, so the user never broadcasts from their own
address (the EOA that pays gas is otherwise public metadata linking them to pool activity).
The relay is compensated from a fee carved out of the op, bound in the user's own proof so it
is non-custodial — the box can neither redirect the user's value nor change the fee. `fee = 0`
always preserves the self-settle path (the user submits and pays their own gas), so relaying is
strictly opt-in.

## Prior art (what the fee model follows)

| System | Model | Fee taken from | Token | Self-pay |
|---|---|---|---|---|
| Fixed-denom mixer | single-denomination set | output (withdrawal) | pool asset | yes |
| Association-set pool | fixed-denom + ASP | output, `relayFeeBPS` ≤ `maxRelayFeeBPS` | pool asset | yes (direct / ragequit) |
| General note/UTXO (**our shape**) | shielded note tree | spent shielded value | user-chosen token, advertised rate, gas-priced; paid as a shielded note | yes |
| Shielded L2 | hidden state + fee contracts | input-side `tx_fee` | single fee asset / arbitrary | sponsored or self |

(The named systems behind each row are compared in [cf/README.md](../cf/README.md).)

Common invariants in all of them: the fee comes out of the value being moved in that same
asset (the user just nets less); recipient + relayer + fee are bound into the proof's public
signals so the relay is trustless; the fee is capped; and there is always a `fee = 0` self-pay
path.

The fixed-denomination mixers carve from the **output** because their output *is* the single
liquid pool asset. The general note/UTXO model pays the relay in a token the user
already holds, decoupled from any output leg. So:

- **Withdrawal-shaped ops** (one spent value → one received asset): fee from the **output**, as
  fixed-denom mixers do.
- **Swap-shaped ops** (input and output assets differ): fee from the **input** token — it
  exists and is valued before execution, the user holds it, and it is independent of slippage.
  (Named prior-art comparison: [cf/README.md](../cf/README.md).)

## Decisions

- **Fee side by op class** — withdrawal-shaped → output leg; swap-shaped → input leg; single
  asset → moot. (Table below.)
- **Pricing** — `max(minFee, ceil(feeBps · value))`, the model the gasless exit already ships;
  the floor covers the per-settle gas cost. (A gas-priced quote — `worker/src/relay-quote.js` —
  sits on top of this floor as the relayer's competitive lever.)
- **Fee payout** — a public `FeePayment` to `msg.sender` (the box wants a usable balance). A
  shielded-note payout to a relay's shielded address is a possible follow-up for operator-side
  privacy.
- **No on-chain fee cap** — the user signs the exact fee in their own opening sigma, so unlike
  a relayer-supplied `relayFeeBPS` model there is no third-party fee to bound on-chain.
- **`fee = 0` ⇒ no leg**, byte-identical to the audited fee-free path.

## Fee mechanisms

Three shapes cover every op; all bind the fee into the proof so the box cannot alter it.

1. **Note-value split** (typed-amount, single asset) — the spent note opens to gross `value`;
   emit `withdrawal(value − fee)` (or a `value − fee` output note) + `FeePayment(fee)`. The
   gasless exit (`OP_UNWRAP`) is this.
2. **Input-take** (swap-shaped) — the input note opens to gross `amount_in`; only
   `amount_in − fee` enters the AMM math; emit `FeePayment(input_asset, fee)`. `OP_SWAP_ROUTE`
   is this.
3. **Kernel public-fee** (hidden-amount transfer) — conservation becomes `Σin = Σout + fee`, so
   the kernel verifies against `Σin − Σout − fee·H` (the `fee·H` is the public value leaving via
   the FeePayment). Value conservation itself binds the fee — a padded fee leaves an `H`-term
   the Schnorr cannot satisfy. Needs a `verify_kernel_with_fee` in cxfer-core (additive; `fee = 0`
   reduces to today's `verify_kernel`).

## Per-op rollout

| Op | Shape | Fee side | Mechanism | Status |
|---|---|---|---|---|
| `OP_UNWRAP` | withdrawal | output | note-split | **shipped** |
| `OP_SWAP_ROUTE` | swap (1→1) | input asset | input-take | **done** (guest+host+dapp+test) |
| `OP_TRANSFER` | private payment | same asset | kernel public-fee | **done** (guest+host+dapp+test) |
| `OP_SWAP` (batch) | swap (N intents) | input, **per intent** | input-take | **done** (guest+host+dapp+test) |
| `OP_LP_ADD` | 2 inputs → share | input leg (A) | input-take | **done** (guest+host+dapp+test) |
| `OP_LP_REMOVE` | share → 2 outputs | output leg (A) | output-split | **done** (guest+host+dapp+test) |
| `OP_OTC` | 2-party | each party's received leg | output-split per party | **done** (guest+host+dapp+test) |
| `OP_BID` | buyer/seller | seller's received payment | output-split | **done** (guest+host+dapp+test) |
| `OP_BRIDGE_BURN` (ETH→BTC) | burn → BTC mints | burned asset | kernel public-fee | **done** (guest+host+dapp+test, relay-wired) |
| `OP_CDP_MINT` (confidential) | collateral notes → debt note | minted debt note | output-split | **done** (guest+dapp+harness+allowlist; box-validated) |
| `OP_FARM_HARVEST` | claim yield | the reward note | output-split | **done** — *pay the relay out of yield* (box-validated) |
| `OP_FARM_UNBOND` | withdraw stake | released share note | output-split | **done** (box-validated) |
| `OP_FARM_BOND` | stake | — (no spendable output) | **fee-less** (relay-routed) | **done** — routed, box-subsidized (recouped via harvest) |
| `OP_CDP_CLOSE` | reclaim collateral | first released leg | output-split | **done** (guest+dapp+harness+allowlist; box-validated) |
| `OP_ADAPTOR_REFUND` | reclaim lock (timeout) | refunded note | kernel public-fee | **done** (guest+harness+allowlist; box-validated) |
| `OP_ADAPTOR_LOCK` / `OP_ADAPTOR_CLAIM` / `OP_CDP_TOPUP` | lock / claim / add collateral | — | **fee-less** (relay-routed) | **done** — routed; fee on the follow-up spend |

**The frontier is closed.** The relay allowlist now reads `wrap, unwrap, transfer, swap, route, lp,
otc, bid, bridgeburn, cdpmint, farmbond, farmharvest, farmunbond, adaptorlock, adaptorclaim,
adaptorrefund, cdpclose, cdptopup` — every confidential op is relay-*routed* (box-settled, no user
EOA), and every op that *produces spendable value* carries a funded fee. The fee-less ones are exactly
the value-*locking* / on-ramp ops (`wrap`, `farmbond`, `adaptorlock`, `cdptopup`) plus the two that
*must* stay fee-less: `adaptorclaim` (its kernel IS the cross-chain t-reveal and must stay zero-value —
the fee rides the follow-up spend of the claimed note) and the public `wrap`. This routes the full
**cUSD saver lifecycle** (stake → harvest → unbond) and the **borrower lifecycle** (mint → top-up →
close), so a user can do every DeFi action without broadcasting from their own address past the deposit.

Notes:
- **Batch swap** charges the fee **per intent** (each trader covers their own relay fee from their
  own input leg); in the common single-intent case it is simply "the trader pays." Carving per
  intent keeps gross flows / clearing price net-of-fee and needs no batch-fee policy.
- **LP remove** cannot pay in the spent LP-share asset (a relay does not want shares), so it is
  the one withdrawal-shaped op that carves from an output leg; pick the canonical-low asset A.
- **OTC** is symmetric: each party may carve a fee from the asset it RECEIVES (taker from `v_a`,
  maker from `v_b`), both default 0 — so either or both can fund the relay with no "who pays" policy.
- **BID** carves a single fee from the **seller's** received payment (the seller is the online
  filler that arranges the relay); the buyer's offline pre-signed sigma is untouched. The resting
  (multi-fill) seller path threads the same fee.
- **Context note:** the opening-sigma ops (route/swap/lp/otc/bid) append `fee` to the intent
  context unconditionally, so the context digest at `fee=0` differs from the pre-fee guest by a zero
  scalar — harmless (a re-prove rotates the vkey and the dapp mirror appends the same field), but a
  test that hand-rolls the context must append `fee` too. The transfer kernel is the exception:
  `fee=0` is byte-identical there (`fee·H` is the identity point).

## Frontier — resolved on inspection

The remaining off-allowlist ops were investigated; most of the "frontier" dissolves, and the parts
that don't are deferred for a concrete technical reason rather than for effort:

- **`bridge_burn` (ETH→BTC) — RESOLVED.** Kernel-shaped, so it took `verify_kernel_with_fee`
  verbatim (Σin ETH burned = Σout BTC minted + fee, fee paid in the burned asset on ETH). Added to
  the relay allowlist + both settle-loop harness maps, so it is now box-relayable end to end.
- **Confidential CDP mint — RESOLVED (box-validated).** The note-collateral mint (spend a collateral
  NOTE, e.g. cBTC → mint a cUSD debt note) is the form the "cBTC-backed cUSD" narrative needs, and it
  is relayable. The fee is carved from the minted debt note: the note opens to `debt_value − fee`, the
  settler is paid `fee` in the debt asset, and the **position still records the gross `debt_value`** so
  the controller's health check is untouched (an origination-fee model). Bound in the
  `tacit-cdp-mint-debt-v1` context; `fee = 0` self-settles and a bond (`debt_value == 0`) requires
  `fee == 0`. Landed: guest fee leg (cargo-checked), the `cdpMintDebtSigma` mirror, a new
  `exec-cdpmint.rs` harness, and the `cdpmint` allowlist + settle-loop entries. Because CDP has no
  self-contained JS build/verify and its proof is a Forge fixture, the e2e gate is the coordinated
  re-prove + `ConfidentialCdpCbtcSettle` — the box-in-the-loop step (the serializer must carve the
  debt note to `debt_value − fee` and the harness ELF path must match the relay loop's build).
  *(The public `zapETHToCdpMint` mint stays a user-sent on-ramp like `wrap` — nothing to privately
  relay there.)*
- **CDP close — RESOLVED.** Carves the fee from the first released collateral leg (output-split): the
  note opens to `value − fee`, the basket membership + controller keep the gross value. Guest leg
  (cargo-checked), the `cdpCloseReleaseSigma` mirror, an `exec-cdpclose.rs` harness, the `cdpclose`
  allowlist entry. **CDP top-up — RESOLVED** as fee-less relay-routing (it adds collateral, no output).
- **Adaptor — RESOLVED; the "fundamentally different design" turned out unnecessary.** The claim
  genuinely can't carry a fee — its kernel over `(L_C − O_C)` IS the t-reveal channel and must stay
  zero-value — but it doesn't *need* one: the recipient pays the relay on the **funded follow-up spend**
  of the claimed note, so the fee lives there, not on the atomic swap. The **refund** reveals no `s`,
  so its kernel is plain conservation and takes `verify_kernel_with_fee` directly (locker reclaims
  `L − fee`). Lock has no spendable output → fee-less. All three are relay-routed (allowlist +
  `exec-adaptor{lock,claim,refund}.rs`); refund + its kernel-fee are guest-landed (cargo-checked,
  byte-identical to the old kernel at `fee=0`, so the adaptor JS tests pass unchanged).
- **Farm — RESOLVED** (see the table): bond/harvest/unbond routed; harvest pays the relay out of yield.

Net: **the frontier is closed.** Every confidential op is relay-routed, every value-producing op is
funded, and the only fee-less ops are the ones that *should* be (value-locking / on-ramp, plus the
adaptor claim whose fee correctly rides the follow-up spend). What remains is purely the box-in-the-loop
gate every guest change shares — the coordinated re-prove (rotating vkeys + regenerating fixtures) and,
for the dormant lanes (farm, CDP/cUSD), their on-chain activation/deploys.

## Privacy narrative covered

"Wrap → hold/send cBTC-backed cUSD privately via a relayer → bridge" is now end-to-end private after
the on-ramp: **wrap** (the public entry, address revealed like any deposit) → **confidential CDP
mint** against a cBTC note → cUSD (relayed, funded) → **transfer / swap / route** the cUSD (relayed,
funded) → **bridge_burn** to BTC (relayed, funded). Every step after the initial deposit can be
relayed with a non-custodial, conservation-bound fee, so the user never broadcasts from their own
address past the on-ramp.

## Verification (this branch)

- `cxfer-core`: `verify_kernel_with_fee` + `relay_fee_kernel_tests` (2 tests) — honest fee accepted;
  padded / understated / zero-on-a-fee'd-transfer rejected; `fee=0` ≡ `verify_kernel`.
- Guest `cargo check`: clean with every fee leg (incl. `bridge_burn`, the confidential `cdp_mint`, and
  `farm_harvest` / `farm_unbond`). `farm-settle-parity.mjs` passes (its hand-rolled harvest/unbond
  contexts updated to the new `[reward, fee]` / `[shares, fee]` amounts).
- **Confidential CDP mint** (box-validated): guest `cargo check` clean; the CDP derivation KATs
  (`confidential-cdp.mjs`) still pass (the `cdpMintDebtSigma` change doesn't touch them). CDP has no
  self-contained JS build/verify mirror, so its e2e gate is the re-prove + `ConfidentialCdpCbtcSettle`.
- `tests/confidential-relay-fee.mjs` (11 checks): a positive-fee round-trip through the JS mirror for
  transfer / route / swap / lp_add / lp_remove / otc / bid / bridge_burn, each asserting the fee
  leg(s) + a tamper rejection where applicable, AND a per-op **conservation KAT** — the fee leg is
  tied to a real value reduction (a pool-reserve delta or a net note), proving the fee is drawn purely
  from the user's own value (no inflation, no counterparty/pool drain). OTC additionally asserts each
  party's fee comes only from what the counterparty gave (no cross-party drain).
- Regression (the `fee=0` default path): `confidential-transfer-roundtrip`, `confidential-route-op`,
  `confidential-swap-op`, `confidential-lp-op`, `confidential-swap-clearing`, `confidential-otc-op`,
  `confidential-bid-op`, `confidential-bid-resting`, `confidential-bid-recovery`,
  `confidential-bid-fold` all pass.

Box KAT + the coordinated re-prove remain the final gate, as for any guest change.

## Fold / re-prove coordination

When this folds in with the parallel cUSD-fee work, the re-prove's apply step must keep the `*ProofReal`
struct mirrors consistent — but note the relay-fee change is **struct-additive only via the existing
`FeePayment[] fees`** array (which the PublicValues + the harness `sol!` mirrors already carry, since
`OP_UNWRAP` used it). So:
- The relay work adds **no new PublicValues field** — it only *populates* `fees`. The `*ProofReal`
  mirrors need nothing new from the relay side.
- The CDP/farm sigma-context changes (`[debtValue, fee]`, `[reward, fee]`, `[shares, fee]`) are
  opening-sigma **challenge** changes, invisible to the PublicValues structs.
- The cUSD-fee fields (`rateSnapshot` / `repaid` on `CdpMint` / `CdpClose`) are orthogonal — the relay
  carve leaves `debtValue`/`reward` **gross** and never touches `rateSnapshot`/`repaid`. The fold keeps
  both sets of fields; `assemble.js` is unchanged. The re-prove rotates the vkeys and regenerates the
  fixtures for both changes together.

## Running the relayer (operations)

The relayer hits `ConfidentialPool.settle()` **directly** (box EOA → `cast send POOL settle(...)`); the
`FeePayment` legs pay `msg.sender`. `ConfidentialRouter.sol` is *not* in the relay path — it is the
user-sent wrap-and-settle / zap on-ramp and forbids fee legs (it settles as `msg.sender == router` and
sweeps any mis-built fee back to the caller). So the two paths are orthogonal: direct settle (relayed,
fee'd) vs router (user-sent on-ramp, fee-free).

- **Gasless cross-chain entry — both cross-chain mints are now relay-routed** (`exec-bridgemint.rs`,
  `exec-cbtcmint.rs`), fee-less: their destination notes are pre-committed (the burn declaration / the
  cBTC lock), so they can't carry a fee — but routing them means a user **brings only BTC and needs ZERO
  ETH for gas**. The fee rides the FIRST spend of the minted note (in cBTC / the bridged asset), or is
  bundled with it (see "Self-funding cross-chain entry" below). `cbtc_mint` was added precisely for this
  no-ETH UX (its lock is public, so the win is gasless entry, not extra privacy). Only `cdp_liquidate`
  stays unrelayed — by design (permissionless, liquidator-profit). *(The cBTC.zk peg also needs a
  slashable escrow; that's posted by the locker or a third-party backer via permissionless `postEscrow` —
  a market role, separate from relay.)*
- **Gas-priced quote + profitability guard** (`worker/src/relay-quote.js`, tested): the fee is bound in
  the user's proof, so a relayer can't change it at settle time — competition is at the QUOTE level. The
  optimal quote is gas-priced (`fee = settleGas × gasPrice × (1+margin)`, converted to the fee asset),
  not bps-of-value (which overcharges whales / undercharges dust). `passesFloor`/`isProfitable` gate
  relayed submits; the initial relayer undercuts by setting a low/zero margin (or `subsidize:true` to run
  fee=0 as a loss-leader). Wired as an optional `feeGate` on `makeConfidentialSettler` — absent ⇒ ungated.
- **`TacitRelayer.sol` (optional, permissionless)**: `relaySettle(calls, feeAssets, minOut, recipients, bps)`
  batches many settles in one tx, **atomically forwards the earned fees** split `bps`-wise across
  `recipients` (so a relayer can share a cut with an **affiliate** — the wallet/front-end that routed the
  flow), and reverts unless they clear `minOut` — an on-chain profitability guard the EOA path lacks.
  Ownerless + immutable, holds no funds between calls, uses Solady (`SafeTransferLib` +
  `ReentrancyGuardTransient`). Open to ANY relayer (each keeps their own fees). NOT required — a single EOA
  covers every op and adds the same privacy — but it's the execution layer for an open relayer market
  (`worker/src/relay-quote.js` is the gas-priced pricing half; a staked relayer registry is a fast-follow).

### Self-funding cross-chain entry (BTC → cBTC with zero ETH, fee paid in cBTC)

A user with only BTC can enter and pay the relay in cBTC, in one tx, with no ETH:
1. The box proves **`cbtc_mint`** (fee-less) against the recorded lock — it appends the cBTC bearer note at
   the next free leaf, moving the tree root to `R'` (deterministic, so `R'` is known in advance).
2. The box proves a tiny **`transfer`** that spends that just-minted cBTC note **against `R'`** and carries
   a relay fee in cBTC (the user keeps `v_btc − fee`, the relay gets `fee`).
3. The box calls `TacitRelayer.relaySettle([mintProof, transferProof], [CBTC], [minFee], [relayer], [10000])`: the mint
   settles first (root → `R'`), then the transfer settles against `R'`, emitting the cBTC `FeePayment` to
   the contract, which `relaySettle` forwards to the relayer — reverting if it's below `minFee`.

Net: **BTC → cBTC, zero user ETH, relay paid in cBTC, atomic.** It's two proofs (the transfer must prove
membership AFTER the mint, so they can't share one proof) batched into one on-chain tx by `relaySettle`.
The same shape funds any pre-committed-destination entry (`bridge_mint`): mint fee-less, then a bundled
fee'd spend. The cBTC.zk escrow stays a separate backer role (the BTC peg's insurance), not a relay step.

The allowlist (`confidential-settle.js`) + `harness_for` are the operational "what this box can prove"
manifest (kept in sync, not a security gate). For an open market they become per-relayer config.

## Per-op wiring (each landing)

For each op the change is the same three-part pattern:
1. **Guest** — read `fee` from the witness, carve it per the op's mechanism, bind it into the
   op's intent context (append to the sigma scalar array; transfer binds via conservation), emit
   `FeePayment`. Verify with `cargo check`; add/extend a KAT.
2. **Witness order** — the box harness (`exec-*.rs`) and the dapp op serializer must write `fee`
   in the **same slot** the guest reads it. For `OP_SWAP_ROUTE` that slot is immediately after
   `amount_in`, before the input sigma.
3. **Dapp mirror** — clone `quoteUnwrapFee`/`buildUnwrap` (`confidential-pool-ux.js`) into the
   op's builder: quote the fee, thread the post-fee amount through the op math, append `fee` to
   the JS `intentContext` in the identical position, surface "receive X (fee Y)" + a self-settle
   toggle. The worker allowlist already carries all these op types — no worker change.

## Re-prove

A guest change rotates `PROGRAM_VKEY`; it rides the standard coordinated re-prove + redeploy.
No new ceremony — the proving keys are unaffected.
