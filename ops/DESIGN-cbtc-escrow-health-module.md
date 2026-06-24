# cBTC escrow health module (governance-gated margin call)

Status: **scaffolding shipped DORMANT in `CollateralEngine` (v1 launch); enforcement module to be implemented + wired post-launch.**

## Why this exists

A cBTC.zk lock's ETH escrow is sized **once, at mint** (`requiredEscrow = escrowRatioBps · ETH(vBtc)`, Chainlink-priced) and is never re-margined. Because a lock can stay open indefinitely, a sustained ETH-vs-BTC decline can push the escrow below the locked BTC value. At that point the rug deterrent inverts (a locker can forfeit cheap ETH to recover more-valuable BTC) and a rug's buy-and-burn under-covers.

cBTC's **peg is never at risk** from this — it is conservation-backed by real BTC, oracle-free. The exposure is confined to the *rug-insurance* layer. So this module optimizes a deterrent; it is not a solvency mechanism.

Voluntary top-up cannot solve it (a rational locker has no incentive to raise live coverage). The three real levers are: a conservative forward mint ratio, per-lock/total caps + a maintained reserve, and — for proactive prevention — an **enforced margin call**. This doc specs the third.

## Why it ships dormant on day 1 (not added later)

The pool pins `COLLATERAL_ENGINE` **immutably**, and the engine's `setPool` is one-shot. A deployed engine is therefore immutable-in-practice: adding a function later means a new engine, which the pool cannot adopt without a **full generational migration** of all escrow + cUSD state. So the *scaffolding* must exist at launch even though the *policy* is deferred — the same dormant-then-activate pattern used for the cUSD stability fee / TSR.

## What shipped at launch (in `CollateralEngine.sol`)

State (all default to the dormant/zero value):
- `escrowMaintenanceBps` — 0 = dormant; else the health floor in `[100%, escrowRatioBps)`.
- `escrowGraceWindow` — seconds an outpoint must stay flagged before it can be enforced.
- `escrowEnforcementModule` — `address(0)` = no enforcement; else the owner-set, audited module.
- `escrowUnhealthySince[outpoint]` — first-flagged timestamp (cleared by any `postEscrow` top-up).

Surface:
- `checkEscrowHealth(outpoint, vBtc) view → (healthy, have, want)` — informational; always `healthy` while dormant; reverts on a stale/deviating feed (fail-closed).
- `setEscrowHealthParams(maintenanceBps, graceWindow)` (`onlyOwner`, bounded).
- `setEscrowEnforcementModule(module)` (`onlyOwner`; module must be a contract or `address(0)`).
- `flagEscrowUnhealthy(outpoint, vBtc)` / `enforceEscrowToReserve(outpoint, vBtc)` (`onlyEnforcementModule`; revert `EnforcementDisabled` while `escrowMaintenanceBps == 0`).

Remedy shipped: **slash-to-reserve** (`enforceEscrowToReserve`) — identical bound to the rug `slash` (reserve-only, capped, one-shot), gated on flagged + grace-elapsed + still-unhealthy (health re-checked on-chain). The locker's recourse throughout the grace window is to top up (`postEscrow`), which clears the flag.

## Activation runbook (post-launch)

1. Deepen the cBTC/cUSD pools and enable the BTC/USD deviation guard (`setDeviationBound`) so the oracle has a 2nd-source bound before it gates live positions.
2. Implement + audit the **enforcement module** (a standalone contract). Responsibilities:
   - Source each lock's authoritative `vBtc` (see open issue below).
   - Read `checkEscrowHealth`; on unhealthy, call `flagEscrowUnhealthy`; after grace, if still unhealthy, call `enforceEscrowToReserve`.
   - Be permissionless-keeper-driven where possible.
3. `setEscrowHealthParams(maintenanceBps, graceWindow)` — suggest maintenance ~110–120% (below the mint ratio, above full BTC coverage) and a grace window long enough for a locker to react (e.g. 24–72h).
4. `setEscrowEnforcementModule(module)`.

## Trust model / bounds

- Enforcement is **owner-gated twice** (params + module) and dormant until both are set.
- A buggy/compromised module is **bounded**: enforcement only ever moves a *live* lock's escrow to the **protocol reserve** (never to an external address), capped at the outpoint's balance, one-shot, with on-chain health re-check and a grace window. Worst case is griefing honest lockers (escrow → reserve), not theft — and the reserve is itself owner-governed.
- Live-oracle dependency: enabling this puts the oracle in the live-position path (today it only sizes at mint). Mitigated by Chainlink robustness + the deviation guard + a generous maintenance threshold + the grace/top-up cure path. The peg is unaffected regardless.

## Open issues to resolve before activation

- **Authoritative `vBtc` source.** The pool keys `cbtcLockVBtc` internally (not publicly readable), so the module supplies `vBtc` and the engine trusts the (audited) module for it. Removing that trust needs either a pool getter for the per-lock value (watch pool codesize) or folding the check into a future pool capability.
- **Richer remedy: forced exit.** Slash-to-reserve penalizes an uncured locker even though their lock is still honestly backing cBTC. The fairer remedy is a **forced redemption** that retires the lock and returns the escrow — but Ethereum can't force a Bitcoin-side redeem, so it needs a pool-side supply/redemption capability (a pool-v2 item). Slash-to-reserve is the conservative day-1 fallback.
