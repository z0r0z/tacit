# CHECKLIST — cBTC readiness before the ConfidentialPool redeploy

> Forward-looking gate. A bridgeable, confidential, collateral-tokenized BTC (real-BTC-backed
> **cBTC.zk** + collateralized synthetic **cBTC.tac**, see the cBTC.tac collateral strategy) is a
> near-term goal the bridge now positions well. The redeploy that's in flight (Mode B + v1
> multi-asset) **locks the immutable vkeys** — so the one cBTC decision that must be made *before*
> deploy is captured here. Everything else is additive and sequences after v1. Companion to
> [`CHECKLIST-v1-multi-asset-readiness.md`](./CHECKLIST-v1-multi-asset-readiness.md) (the shared enabler)
> and [`ARCH-tacit-chain-abstraction.md`](./ARCH-tacit-chain-abstraction.md).

## The one deploy-gated decision: the reflection value-entry (→ `BITCOIN_RELAY_VKEY`)

The full-scan reflection is conservation-closed — value enters only through a value-entry surface.
The one being built is **cmint-deposit** (issuer-authority); **real-BTC-lock (cBTC.zk) wrap-entry is
deferred** (`SPEC-BITCOIN-REFLECTION-AMENDMENT §6.1`). The two cBTC forms split on this:

- **cBTC.zk (trustless real-BTC)** — the differentiated product (wBTC/tBTC can't do it; Tacit is *on*
  Bitcoin) — needs the reflection to **verify the sats-lock in-guest** (a real output exists, locked,
  unspent). That is a *new value-entry surface*, distinct from the cmint issuer-sig — **guest-level,
  so it's baked into `BITCOIN_RELAY_VKEY` at deploy.**
- **cBTC.tac (collateralized synthetic)** — does **not** need it; it rides cmint + the collateral/peg
  system (app/contract, a later build).

**DECIDED — the sats-lock value-entry rides this reflection re-prove** (real-BTC cBTC.zk prioritized):
design it INTO the in-flight reflection guest (alongside cmint-deposit + asset-preservation) so the
deployed `BITCOIN_RELAY_VKEY` supports it. Same re-prove, no *third* one. The value-entry construction
(the guest hand-off) is [`DESIGN-cbtc-sats-lock-reflection.md`](./DESIGN-cbtc-sats-lock-reflection.md).
The vault-custody construction (how the lock is *released* only on redemption) is the separate open
crux flagged there — it gates the trust level, not the deploy.

## No NEW contract immutable is needed for cBTC

Confirm + rely on this (so the deploy isn't held up for a cBTC contract change):
- cBTC is **just another asset** — `wrap` / `registerMintedAuto` / `_autoRegisterFromMeta` (B6) handle
  it; the canonical ERC20 + bridge + confidential pool carry it with **zero contract change**.
- The **real-BTC backing is verified in the GUEST** (the sats-lock value-entry) + enforced by the
  **Bitcoin-side vault validator** (worker/indexer, additive) — *not* by the Ethereum contract, which
  only trusts the reflection proof (`BITCOIN_RELAY_VKEY`). So the contract deploy locks **only the
  vkey**, nothing cBTC-specific in the constructor.
- Redemption (burn cBTC → unlock sats) is a **cross-out (Mode B) → Bitcoin-vault release** path —
  again guest + Bitcoin-validator, no Ethereum contract immutable.

So the deploy's only cBTC-relevant immutable is `BITCOIN_RELAY_VKEY` = the reflection guest version
(with or without the sats-lock value-entry).

## Already aligned (recognize, no change)

- **Asset-preservation IS the cBTC enabler.** cBTC is the 2nd/3rd Bitcoin-pool asset, so the
  asset-preservation rebuild that already must precede a second Bitcoin asset is exactly what makes
  cBTC bridgeable + conservation-safe. cBTC is the marquee use of the v1 multi-asset readiness.
- **The settle guest (`PROGRAM_VKEY`) needs no cBTC op for v1.** The cBTC.tac peg/mint/liquidate
  op-set is a later, possibly settle-guest-touching build → its own re-prove. Don't fold it into this
  deploy.

## Preconditions (app/AMM-level — not deploy-gated, get in place)

- **tETH live + funded**, and a **TAC/tETH confidential AMM pool.** tETH is the *exogenous* collateral
  leg that de-risks a TAC-only synthetic, and the pool is the on-chain pricing leg the cBTC.tac
  IL-aware ratio needs. Concrete known gap (market-UX eval): stand up the cBTC.tac **pool legs** so the
  collateral basket is priceable in BTC terms.

## Reserve the design space (don't build now)

- The **cBTC.tac peg / liquidation / collateral op-set** — a real system (mint-against-collateral,
  IL-aware ratio, liquidation, redeem). App/contract-layer; ensure the AMM price feeds + a
  collateral-pool primitive aren't foreclosed, but build it after v1.
- A **`btc_lock_slot` custody-kind** in the wrapper registry — extensible; add it with cBTC.zk.

## Bottom line

**DECIDED:** the cBTC.zk sats-lock value-entry **rides this reflection re-prove**, so the deployed
`BITCOIN_RELAY_VKEY` supports trustless real-BTC backing. The remaining pre-deploy work is therefore the
**value-entry design** ([`DESIGN-cbtc-sats-lock-reflection.md`](./DESIGN-cbtc-sats-lock-reflection.md)),
which the guest implementer folds into the re-prove next to cmint-deposit + asset-preservation. No new
contract immutable is needed; the vault-custody construction, the peg system, the pool legs and the
custody-kind are all additive and sequence after v1 — only the value-entry is deploy-gated.
