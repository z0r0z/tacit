# EVM farm rewards — unified escrow + mint, Synthetix-superset

Bring the EVM `FarmController` to a single primitive that serves **both** day-1 use cases over the existing
confidential, unlinkable receipt (`(shares, rps_entry)` in a shielded note). The reward-per-share accumulator is
unchanged — it doesn't care where `rate` came from — so both modes share the cross-chain receipt.

## Two modes (chosen by the reward asset's registration)

- **Escrow mode** (Bitcoin parity, refundable). `rewardAsset` is an **escrow-backed** pool asset. The creator
  funds a treasury upfront (or in tranches); harvest pays reward notes drawn from it; leftover refunds. This is
  the MasterChef/Synthetix fixed-budget program — `notify` once + `recover` = MasterChef; `notify` each period =
  Synthetix.
- **Mint mode** (inflationary). `rewardAsset` is the controller's **pool-minted** debt asset
  (`cdp_debt_asset_id(controller)`). Harvest mints the reward note fresh (the protocol emits its own token).
  No treasury, no refund — un-minted = un-inflated.

The mode is **derived from `rewardAsset.poolMinted`** (escrow-backed ⇒ escrow; pool-minted ⇒ mint), so there's
no separate flag to keep coherent.

## Controller / pool split

- **Controller** (`FarmController`): the rps **policy** + the `notify` orchestration + the `recover` trigger.
  Holds only global state (`rate`, `rps`, `totalShares`, `periodFinish`) — nothing per-owner.
  - `notifyRewardAmount(reward, duration)` — Synthetix roll: `rate = (reward + remaining·rate)/duration`,
    `periodFinish = now + duration`. Escrow mode also calls `pool.fundFarm(...)` to pull `reward` of the reward
    asset into the treasury. Creator-only.
  - `_accrue()` — accrue rps up to `min(now, periodFinish)`, only while `totalShares > 0`.
  - `onCdpMint` bond/harvest — the existing rps bounds (`rps_entry == rps` at bond; `reward·PRECISION ≤
    shares·(rps − rps_entry)` at harvest; `totalShares` untouched on harvest).
  - `onCdpClose` unbond — `lockUntil` gate + `totalShares -= w`.
  - `recover(to)` — escrow mode, after `periodFinish + RECOVER_GRACE`, reclaim the unspent treasury via
    `pool.recoverFarm(...)`. (Grace mirrors Bitcoin's ~1008-block / ~7-day window.)
- **Pool** (`ConfidentialPool`): the **custody** — the escrow treasury + the note minting + the treasury bound.
  - `farmConfig[controller] = rewardAsset` (set when the controller registers; pins which treasury a harvest draws).
  - `farmTreasury[controller]` — the per-farm escrowed budget not yet distributed.
  - `fundFarm(rewardAsset, amount)` (controller-gated) — pull `amount` of `rewardAsset` underlying from the
    creator → `escrow[rewardAsset] += amount`, `farmTreasury[controller] += amount`.
  - In `_settle`, for a harvest CdpMint of an **escrow-mode** controller: require `farmTreasury[controller] ≥
    debtValue`, decrement it, THEN call `controller.onCdpMint` (the rps bound). Mint-mode farms skip this.
  - `recoverFarm(rewardAsset, to, amount)` (controller-gated) — release `amount` from `escrow` + `farmTreasury`,
    transfer the underlying to `to`.

## The escrow invariant (the security crux)

For every escrow-mode reward asset:

```
escrow[rewardAsset]  ==  Σ outstanding reward notes' value  +  Σ farmTreasury[controller]
```

Maintained with equality by every transition:
- **fund**: `escrow += reward`, `farmTreasury += reward`.  (both up by reward)
- **harvest**: mint a reward note (value v); `farmTreasury -= v`; `escrow` unchanged → outstanding `+= v`.
- **unwrap a reward note** (value v): `escrow -= v`; outstanding `-= v`.  (treasury unchanged)
- **recover** (amount t): `escrow -= t`; `farmTreasury -= t`.  (outstanding unchanged)

So the escrow always exactly backs the outstanding reward notes plus the recoverable remainder — a farm can
never distribute or recover more than it funded, and `recover` can never reach into another farm's backing
(`farmTreasury` is per-controller). The harvest value `v == debtValue` (the guest's opening sigma binds the
reward note to `reward`, and the CdpMint carries `debtValue == reward`), so the public `debtValue` is a sound
proxy for the confidential note's value in the treasury accounting.

## Guest change

`OP_FARM_HARVEST` currently mints the reward note under `cdp_debt_asset_id(controller)` (the mint-mode asset).
Add the farm's **`reward_asset`** as a witnessed field so escrow-mode farms emit the reward note under the
escrow-backed asset; the opening sigma's asset binds to it. Mint mode keeps `debt_asset` (the default when
`reward_asset == debt_asset`). One field + one branch; re-prove pins the new settle vkey.

## Cross-chain

- **Deterministic fixed-budget farms** (a single `notify` with a fixed duration ⇒ rate+window are a pure
  function of init params) can be mirrored on both chains with a synced `rps` → a position note bridges and
  harvests on either side. This is the cross-chain primitive Bitcoin already supports.
- **Synthetix top-ups + mint mode** are non-deterministic / EVM-local programmability. Those farms don't mirror
  to Bitcoin; Tacit presents both through one farm UI. (No change to the Bitcoin guest in v1.)

## v1 scope + phases

1. **Controller v2** (`FarmController.sol`) — `notifyRewardAmount`, period-clamped `_accrue`, `recover`,
   mode-aware orchestration; keep the bond/harvest/unbond bounds. + forge tests. *(self-contained)*
2. **Pool treasury** (`ConfidentialPool.sol`) — `farmConfig`/`farmTreasury`, `fundFarm`, the escrow-mode harvest
   bound in `_settle`, `recoverFarm`; uphold the invariant. + forge tests.
3. **Guest** — `OP_FARM_HARVEST` reward-asset field; `farm_execute` + the dapp builder updated.
4. **Dapp** — `notifyRewardAmount` (create/fund) + `recover` UX; the farm tile shows mode + period + treasury.
5. **Validate + re-prove** — `farm-execute` (both modes), forge full suite, coordinated re-prove (new settle
   vkey), pin.

Mint mode is the lighter path (controller-only, no pool/guest change); escrow mode is the multi-surface one but
is the Bitcoin-parity payoff.
