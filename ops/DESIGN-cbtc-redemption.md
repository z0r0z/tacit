# DESIGN — cBTC redemption: trustless atomic cBTC↔BTC swap (the hard peg)

> **STATUS: the redemption layer for fungible cBTC — and it reuses the adaptor work wholesale.** A fungible
> cBTC holder can't unlock a stranger's self-custody lock, so redemption is an **atomic swap**: the holder
> burns cBTC ⇄ a locker unlocks their BTC, bound by an **adaptor signature (PTLC)** and matched by the
> cross-chain orderbook. Trustless, 1:1, no custodian, no mediator — Tacit's niche. Companion to
> `DESIGN-cbtc.md` (it fixes that doc's glossed fungibility/redemption), built on `dapp/adaptor-signature.js`
> + `dapp/adaptor-swap.js` + `dapp/cross-chain-orderbook.js` (all built + tested) and the `OP_ADAPTOR_*`
> guest ops (specced, ride the re-prove).

## 1. Why redemption is a swap (the fungibility consequence)

cBTC is fungible because every unit is backed by the **aggregate** pool of self-custody locks
(`cbtcBackingSats`) + insured by the buffer — no unit is tied to a specific lock. The flip side: a holder
**holds no locker's key**, so they can't redeem by unlocking BTC themselves. Redemption must therefore
**pair a redeeming holder with an exiting locker** — and those two are natural counterparties:
- **Holder `H`:** has fungible cBTC, wants real BTC.
- **Locker `L`:** locked BTC + minted cBTC + sold it; to **close out** they must retire an equal cBTC and
  unlock their BTC. They *want* to hand BTC to a holder in exchange for retiring cBTC.

So redemption = `H` gives cBTC (burned) ⇄ `L` gives BTC (their lock, unlocked to `H`). Both want it.

## 2. The atomic mechanism (adaptor / PTLC — the existing primitive)

It's a cBTC↔BTC atomic swap, the exact shape `dapp/adaptor-swap.js` implements:
- `L` builds the Bitcoin tx spending their lock to `H`, **adaptor-locked to `T = t·G`** (incomplete —
  needs `t`).
- `H`'s **cBTC burn** in the Tacit pool is bound to the same `T` (`OP_ADAPTOR_CLAIM`/redeem op): completing
  it **reveals `t`** (`t = σ·(s − s̃)`, the adaptor `s`-exposure already specced).
- `H` claims `L`'s BTC by revealing `t`; `L` extracts `t` from that and completes the unlock-to-`H`.
- **Atomic:** either `H` gets BTC *and* the cBTC is burned, or neither happens. No trusted party.

`L`'s lock is plain self-custody (their key) — the redemption just spends it to `H` via an adaptor-signed
tx, no special lock script. (The covenant endgame replaces the adaptor with a script-enforced redemption.)

## 3. The matching (the cross-chain orderbook — also built)

`dapp/cross-chain-orderbook.js` already matches cross-chain offers + composes `makeAdaptorSwap` per fill.
Redemption is one market on it:
- **Redeem offers** (`H`: cBTC → BTC) and **close offers** (`L`: lock-BTC → retire cBTC) posted at par (1:1
  for redemption; a small fee/spread is the locker's incentive + the arbitrage that pins the peg).
- Matched by amount + price; each fill drives an atomic adaptor swap (§2). Partial fills supported (the
  orderbook already does grid partials).

## 4. Conservation (the supply ⇄ backing identity)

Each redemption: cBTC **supply ↓** (`H`'s burn) and **backing ↓** (`L`'s lock spent to `H`) by the **same**
amount. `cbtcBackingSats` and the cBTC supply move together, so the §fungibility invariant
(`supply ≤ backing`) is preserved across redemption — exactly as it is across mint.

## 5. The peg (hard, trustless)

- **A 1:1 redemption floor.** Any holder can force `cBTC → BTC` at par by matching a closing locker — no
  slippage, no custodian. That floor is what makes it a *hard* peg, not a market-hope.
- **Locker arbitrage pins from both sides.** cBTC < 1 BTC → lockers buy cheap cBTC + close (retire + unlock)
  for a profit → demand ↑, supply ↓. cBTC > 1 BTC → new lockers mint + sell → supply ↑. The redemption
  swap is the rail this arbitrage runs on.
- **The buffer covers the dishonest exit.** A locker who *rugs* (spends their lock elsewhere instead of
  redeeming) drops `cbtcBackingSats`; the `CbtcBuffer` buys + covers. So redemption (honest exit) and the
  buffer (dishonest exit) are the two halves — both keep `supply ≤ backing`.

## 6. Liveness — honest about the counterparty

The hard redemption needs an **exiting locker** to match. In steady state there's always churn (lockers
enter + exit), so liquidity exists. The **always-available fallback** is the market: `H` sells cBTC on a
DEX (to a closing locker or anyone), with solvency guaranteed by the provable backing + the buffer. So:
- **Primary (trustless, hard 1:1):** adaptor-matched redemption.
- **Fallback (always-on, soft):** market sale + the buffer's solvency guarantee.
A "bank run" (everyone redeems, no one locks) degrades to the market price + the buffer — never to
insolvency, because the backing is real and proven.

## 7. What it reuses vs. what's new
- **Reused (built + tested):** `adaptor-signature.js` (BIP-340-faithful PTLC), `adaptor-swap.js` (the swap
  state machine), `cross-chain-orderbook.js` (matching + partial fills).
- **Guest (rides the re-prove):** the `OP_ADAPTOR_*` settle ops so the cBTC **burn reveals `t`** in-proof
  (`DESIGN-adaptor-swap-guest.md`) — the redemption is their first concrete consumer. The Bitcoin-side
  unlock is a normal adaptor-signed spend (validator/wallet, no guest change).
- **New (app orchestration):** a thin `cbtc-redemption` module = the cross-chain orderbook wired to the
  cBTC↔BTC market + the lock/unlock plumbing. Small, on top of the existing primitives.

## 8. Net
cBTC redemption is **a cBTC↔BTC atomic swap** — the adaptor primitive pointed at the system's own exit. It
gives fungible cBTC a **hard, trustless, 1:1 redemption** with no custodian and no mediator, ties off the
fungibility story (mint → aggregate backing + buffer → atomic redemption), and reuses the entire
adaptor/orderbook stack. The covenant endgame later turns the adaptor-matched unlock into a script-enforced
one, dropping even the counterparty need.
