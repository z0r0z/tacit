# Tacit V1 launch farms

How to show, drive and watch the TAC liquidity program from your own dapp.

Written for an integrator who already has the basics from [`BUILD-A-TACIT-DAPP.md`](./BUILD-A-TACIT-DAPP.md)
(notes, the relay, `makeConfidentialPoolUx`). Everything here is live on Ethereum mainnet; addresses are also in
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md).

Names marked **verify** are part of the SDK / API surface that ships alongside this chapter. Check them against
`dapp/confidential-farm-program.js`, `dapp/confidential-pool-ux.js` and the live `/farm/program` response before
you depend on an exact shape.

---

## 1. What the farms are

Liquidity providers on three confidential AMM pairs can **bond** their LP-share notes into one on-chain
program and earn **TAC** for as long as the shares stay bonded.

- One contract, the **FarmManager**, runs all three pools. It is a controller of the confidential pool: the pool
  calls into it from inside a settle, so a bond, harvest or unbond is a normal proof-backed op.
- A position is a **receipt**: a leaf committing `(controller, lpAsset, shares, owner, nonce)`. The receipt is the
  position's key, and the receipt owner's key is what signs a harvest or an unbond.
- Rewards are paid from a treasury escrowed in the pool. Emission is a fixed rate per second, split across pools by
  weight, then across a pool's stakers by shares.
- The reward asset is **wTAC**, a 1:1 ERC20 wrapper of TAC (section 10 explains why). A harvest mints a
  **wTAC note**; redeeming it to plain TAC is a few more steps (section 5).

**Epoch 1:** 99,700 TAC over 90 days from 2026-09-21, about 1,108 TAC per day, ending at unix `1797712559`. No lock
on any pool: you can unbond at any time.

## 2. Addresses

| | |
|---|---|
| ConfidentialPool | [`0x000000000Ed1eabD231Be41d93b719056F7febFC`](https://etherscan.io/address/0x000000000Ed1eabD231Be41d93b719056F7febFC) |
| FarmManager (CREATE3, verified) | [`0x000031C47Cb61faB1CE2790a69625FABB71EDE24`](https://etherscan.io/address/0x000031C47Cb61faB1CE2790a69625FABB71EDE24) |
| wTAC (WrappedTac ERC20) | [`0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf`](https://etherscan.io/address/0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf) |
| TAC ERC20 | [`0xA1313eb9f3A445606D9583bcAc3ebeB56a858279`](https://etherscan.io/address/0xA1313eb9f3A445606D9583bcAc3ebeB56a858279) |
| TacFarmFunder | [`0x7fc40b13c7a99a1d2c41f8b5382978363d18525a`](https://etherscan.io/address/0x7fc40b13c7a99a1d2c41f8b5382978363d18525a) |
| wTAC asset id (reward) | `0x1097c9e552ae4fce2a8c416b93403953fa445a5f2cdae8ced36d9a78cfe40832` |
| Operator (governor once it accepts) | ops multisig `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` |

The three pools. The stake asset is the pair's **LP-share asset id** (30 bps tier); the pool id is the AMM pair
id.

| pid | pair | weight | stake asset (LP-share id) | pool id |
|---|---|---|---|---|
| 0 | TAC / cETH | 50 | `0x17c56713a7e4a5d679a71def3ff9fa186f1556ef757b0ee6b7a3ed8c9249ef99` | `0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00` |
| 1 | cETH / cUSD | 30 | `0xd608b0c3806e782cc213e2d52245c3c2fbef455a10410a1f5ccc61ba45262571` | `0x5925c0c2954c5b11bedd20e444f0cb22f3827f6197814f97d193e7a44e909da7` |
| 2 | cETH / cBTC | 20 | `0x0a0cce175bc483945822c8de3d3926e813269f5e1bbe1f9c853e09ed48b68254` | `0x8359cd1f812e3a9040129e186e1477f60f2188bad1bd6a56e5506b22bf5cd331` |

Read the live values, do not trust this table: the weights can be re-set by governance (section 9), and the
addresses are also in the dapp config's `farm` block (section 3).

**Units.** The reward value unit is `1e-8` TAC (the pool's 8-decimal in-system unit). `wei = units × 1e10`.
The epoch rate is `1,282,150` units per second. Every reward figure from the manager (`pending`, `rate`,
`outstandingReward`, `farmTreasury`) is in units.

## 3. Read the program

The dapp config carries the program (**verify** the exact shape in `confidential-deployments.js`):

```js
cfg.farm = {
  manager, rewardAsset, rewardToken, tac, funder,
  pools: [{ pid, pair, poolId, lpAsset, feeBps, allocPoint, lockSeconds }],
};
cfg.farmControllers[poolId] = manager;   // enables one-click add-and-bond for that pool
```

The live numbers come from one of three places, all equivalent:

```js
// the SDK: reads the manager over your RPC
import { makeConfidentialFarmProgram } from './dapp/confidential-farm-program.js';
const farm = makeConfidentialFarmProgram({ rpc, config: tacit.cfg });   // or tacit.farmProgram()
const program = await farm.program();          // { manager, rewardAsset, gov, pendingGov, epoch, pools[] }
const owed    = await farm.pending(receiptLeaf);   // { units, tac }: decimal strings, units in 1e-8 TAC
const pos     = await farm.position(receiptLeaf);  // { live, shares, pid, unlockAt, pendingUnits, pendingTac, ... }
const inputs  = await farm.aprInputs();        // the numbers an APR figure needs — the price is yours
```

```
GET https://api.tacit.finance/farm/program?network=mainnet
```

A cached JSON summary: `network`, `manager`, `rewardAsset`, `rewardToken`, `gov`, `pendingGov`, `epoch { active,
ratePerSecUnits, ratePerDayTac, periodFinish, remainingSeconds, treasuryTac, outstandingTac, requiredTac,
fundedRunwaySeconds }`, `pools[] { pid, pair, lpAsset, allocPoint, sharePct, totalShares, idle,
tacPerDayForPool, lockSeconds }`, `block`, `stale`, `updatedAt`. The SDK's `farm.program()` returns the same
groups (its `epoch` adds `rate`, `treasuryUnits`, `outstandingUnits`, and its pools carry `poolId`).

Or the contract directly. These are the views the two above are built from:

| view | returns |
|---|---|
| `rate()` / `periodFinish()` / `totalAllocPoint()` | units per second (all pools) / stream end / sum of weights |
| `poolLength()` / `poolInfo(pid)` | `(stakeAsset, totalShares, rps, totalRewardDebt, allocPoint, lastUpdate, lockDuration)` |
| `pidOf(stakeAsset)` | `(pid, exists)` |
| `pending(receiptLeaf)` | reward a live position could claim now, in units (0 if not live) |
| `positions(receiptLeaf)` | `(entryRps, shares, unlockAt, pid, live)` |
| `outstandingReward()` | everything earned by live positions and not yet harvested, in units |
| `gov()` / `pendingGov()` | current governor / proposed governor |
| pool `farmTreasury(manager)` | the reward budget escrowed for the program, in units |

Events: `Bonded(receipt, pid, shares, unlockAt)`, `Harvested(receipt, pid, reward)`,
`Unbonded(receipt, pid, shares)`, `RewardNotified`, `Funded`, `Recovered`, `ConfigQueued`.

## 4. Show the farms

A farm card is four numbers and a warning. Everything below comes from section 3.

| on the card | how |
|---|---|
| pair | `pair` from the program |
| weight share | `allocPoint / totalAllocPoint`, so 50 / 30 / 20 percent at launch |
| live TAC per day for this pool | `rate × 86400 × allocPoint / totalAllocPoint / 1e8` (about 554 / 332 / 222 at launch) |
| staked | `totalShares` of the pool, in LP-share units |
| epoch countdown | `periodFinish − now`; after it, nothing accrues |

**Idle pools.** A pool's slice accrues only while it has stakers. When `totalShares == 0` the slice is not
emitted; it stays in the treasury. Say so on the card ("no stakers, the first LP earns the whole slice"). The
same fact is why per-share yield swings hard on a thin pool: show TAC per day for the pool, then per share.

**APR.** The program gives you the reward side (TAC per day, per pool) and the pool's `totalShares`. Turning that
into a percentage needs a TAC price and a value for one LP share, both of which are yours to source. Do not
present a fixed APR: it moves with every bond and unbond.

**Position row.** For a wallet, list each position with `shares`, `pending` (in TAC, `units / 1e8`), `pid`, and
`unlockAt` (the launch pools have no lock, so this is just the bond time and the position is always unbondable).

## 5. Flows

Like every pool op, these go through the relay: you build and sign, the relay proves and settles. The proven
reference implementations are the scripts the flows below were run from; the mainnet transactions are listed in
section 11.

### One-click add and farm (OP_LP_BOND)

```js
await tacit.lpBond({ walletPriv, controller: cfg.farm.manager, aNote, bNote, feeBps: 30, selfRelay: true });
```

Adds liquidity to the pair and bonds the resulting shares in one settle, so the user never holds an idle LP
note. It is enabled per pool by `cfg.farmControllers[poolId]` and has been driven live against this manager
(section 11). It builds with no relay fee leg, so submit it with `selfRelay: true`: the user's own account
broadcasts the settle and pays its gas, which is what the Earn tab does. The position's receipt key re-derives from
the wallet key and the spent A note (`lpBondPosition`); persist the position record as section 7 says.

### Bond an existing LP note

```js
const ownerPriv    = '0x' + hex(secp.utils.randomPrivateKey());   // a FRESH key per position, never the wallet key
const receiptOwner = '0x' + hex(secp.getPublicKey(ownerPriv.slice(2), true).subarray(1));   // BIP-340 x-only
const nonce        = '0x' + hex(crypto.getRandomValues(new Uint8Array(32)));

await savePosition({ controller, lpAsset, shares: note.value, receiptOwner, ownerPriv, nonce });   // BEFORE submit

await tacit.defiActions(walletPriv).bondFarm({
  controller, nonce, lpAsset,
  legs: [{ cx: note.cx, cy: note.cy, value: String(note.value), index: Number(note.leafIndex),
           path: note.path, blinding: note.blinding, owner: note.owner, nk: note.secret }],
  spendRoot: note.root,
  receiptOwner,
});
```

The LP note is spent; the receipt leaf is created. A position is exactly **one LP note**, bonded whole: to bond
part of a note, **split it first** (a `transfer` to yourself); to bond several notes as one position, merge them
first. Rescan right before you build so that `note.path` and `note.root` are taken together against one root (the pool keeps every root it has had, so an older witness stays valid, but a spend carries a single `spendRoot`).

### Harvest, with a claim button

Show `pending` on the button. The claim is a number you choose, and the manager rejects anything above what has
accrued.

```js
const leaf    = tacit.pool.farmReceiptLeaf(controller32, lpAsset, BigInt(P.shares), P.receiptOwner, P.nonce);
const { leaves } = tacit.indexer.index(await tacit.fetchEvents());
const idx     = leaves.findIndex((l) => l && String(l.leaf).toLowerCase() === String(leaf).toLowerCase());
const tree    = tacit.indexer.buildTree(leaves);
const { path } = tree.rootAndPath(idx);

const pend    = BigInt((await farm.pending(leaf)).units);   // units, read at build time
const reward  = pend - pend / 200n;                     // accrual only grows while proving; keep a small margin
import { randomScalar } from './dapp/bulletproofs-plus.js';
const rb = BigInt(randomScalar()) % secp.CURVE.n || 1n, nk = randomScalar();   // persist BOTH: they open the reward note
const rewardNote = { ...tacit.pool.commitXY(reward, rb), blinding: rb };

await tacit.defiActions(walletPriv).harvestFarm({
  controller, shares: BigInt(P.shares), nonce: P.nonce, harvestNonce: '0x' + hex(randomBytes(32)),
  reward, oldIndex: idx, oldPath: path, lpAsset, rewardAsset: cfg.farm.rewardAsset,
  rewardNote, rewardNk: nk, fee: 0n, spendRoot: tree.root(),
  receiptOwner: P.receiptOwner, receiptOwnerPriv: P.ownerPriv,
});
```

Two rules the button copy should carry:

- **The reward lands as a wTAC note**, not TAC. It is a normal confidential note and sits in the wallet under
  the wTAC asset id.
- **A harvest re-stamps the position.** Whatever is pending and not claimed in that harvest is forfeited. The
  proven runs claimed 99.5% of `pending` read at build time, so a harvest leaves about half a percent behind.
  Claim as close to `pending` as you dare; do not build a "claim half" control.

The reference runs passed `fee: 0n`. If the relay rejects a submit for a fee below its floor, pass a fee from
`GET /confidential/quote` for the wTAC asset (**verify** eligibility for wTAC before you launch).

### Unbond

```js
const ub = BigInt(randomScalar()) % secp.CURVE.n || 1n, nk = randomScalar();   // persist both
const releaseNote = { ...tacit.pool.commitXY(BigInt(P.shares), ub), blinding: ub };

await tacit.defiActions(walletPriv).unbondFarm({
  controller, shares: BigInt(P.shares), nonce: P.nonce, lpAsset,
  oldIndex: idx, oldPath: path, releaseNote, lpNk: nk, fee: 0n, spendRoot: tree.root(),
  receiptOwner: P.receiptOwner, receiptOwnerPriv: P.ownerPriv,
});
```

The whole position's shares come back as an LP-share note. **Warn before submitting:** unharvested reward is
forfeited to the treasury surplus. The safe order is harvest, wait for it to settle, then unbond. If the pool has
a lock, an unbond before `unlockAt` reverts `Locked`; the launch pools have none.

### Redeem rewards to TAC, and to Bitcoin

A wTAC note becomes plain TAC in three hops, each a mainnet-proven step:

1. **Unwrap the note** to the wTAC ERC20: `tacit.unwrap({ note, walletPriv, recipient })`. Public: the
   recipient address and amount appear on-chain.
2. **`WrappedTac.withdraw(amount, to)`** turns wTAC into the TAC ERC20, exactly 1:1.
3. Optional: **wrap the TAC** back into a confidential TAC note (`buildWrap`, ticker `TAC`) if the user wants to
   stay in the pool.

TAC notes then reach Bitcoin over the pool's cross-out round trip; see
[SPEC §6.4](../SPEC.md#64-ethereum--bitcoin). That path is for TAC notes, not wTAC
notes: redeem first.

The SDK wraps all four in one entry: `tacit.farmBond`, `farmHarvest`, `farmUnbond`, `farmRedeem`, plus
`tacit.farmPositions({ walletPriv })` to list positions (**verify** argument shapes in
`confidential-pool-ux.js`). The explicit calls above are the ones proven on mainnet.

A redeem wizard is four screens: pick the wTAC note, confirm the public unwrap to an address, wait for the
ERC20 to arrive (poll `balanceOf`, do not trust a scan), then `withdraw`. Poll the ERC20 balance at each hop.

## 6. What a user sees, end to end

| step | on-chain | private? |
|---|---|---|
| add liquidity | AMM settle | amounts hidden |
| bond | `Bonded(receipt, pid, shares, unlockAt)` | **shares are public**; the LP identity is not linked to the receipt |
| harvest | `Harvested(receipt, pid, reward)` | **amount is public**; the wTAC note's owner is not linked to the receipt |
| unbond | `Unbonded(receipt, pid, shares)` | shares public; the LP note's owner is a fresh key |
| unwrap to an address | wTAC ERC20 transfer | **public**: this is where an address appears |

## 7. Position keys

The receipt owner's key is the only authority over a position. If it is lost, the bonded shares cannot be
unbonded and any pending reward cannot be claimed. Nothing in the protocol, and no operator, can recover it.

- **Use the SDK's deterministic path where you can**: a position opened with `tacit.farmBond` or `tacit.lpBond`
  derives its receipt key from the wallet key and the note it spent, and `tacit.farmPositions({ walletPriv })`
  finds it again from the chain and the key, so a restored wallet needs no stored file. A position opened
  under a random key (the explicit bond above) is not derivable; keep its record (or, once saved,
  `tacit.importFarmPosition(record)` checks it against the chain and stores it).
- **If you hold keys yourself, persist before you submit.** Write `{ controller, lpAsset, shares, receiptOwner,
  ownerPriv, nonce }` durably first, then bond. The reference run writes the file mode `0600` and refuses to
  overwrite an existing one.
- **A fresh key per position.** Never reuse the wallet key as a receipt owner; that would link positions.
- **Also persist per-op secrets:** a harvest's `(reward blinding, nk)` and an unbond's `(blinding, nk)` open the
  notes they create. The wallet's seed scan finds a note through its memo, but keep the secrets until you have seen the note
  in a scan.
- **One key, many processes.** The scan of a wallet key returns every note sealed to it, including notes created
  by another process. Give a farming bot its own key (see BUILD-A-TACIT-DAPP section 5).

## 8. Monitoring

If you host farm cards or run a keeper, watch these. The relay operator runs `tools/farm-monitor.mjs`, which exits
non-zero on a warn or a critical, and `GET /farm/health` returns the same checks as JSON with
`status: ok | warn | critical` (**verify** the check names). The thresholds below are what to alert on in
your own tooling.

| what | condition | severity |
|---|---|---|
| treasury solvency | `farmTreasury(manager) < outstandingReward() + rate × remaining` | **critical**: the treasury no longer backs what the program owes. The manager only starts a schedule it can back, so this should never fire; if it does, stop showing yields and investigate |
| days to finish | `(periodFinish − now) < 14 days` | warn: top up (section 9) before the stream ends |
| idle pool | `poolInfo(pid).totalShares == 0` while the stream is running | warn: that pool's slice is not being earned; show the card as idle |
| governance handover | `pendingGov() != 0` | warn: a governor change is proposed and not accepted yet; the new governor completes it with `acceptGov`, so treat it as an alarm only if it stays pending unexpectedly |
| queued config | a `ConfigQueued` event with no matching execution | info: a re-weight or a new pool is pending, with a 7-day delay |
| relay health | `GET /health`, and the relay wallet's gas runway | warn: bonds, harvests and unbonds stop settling if the relay does |
| reflection lag | `GET /reflection/status` `attestedHeight` vs the header relay tip | warn: farm ops do not depend on it, but the TAC redeem-to-Bitcoin path does |

Two readings that look alarming and are not: the treasury is larger than the schedule needs while pools are idle
(their share stays in it), and `pending` grows every block (that is the point).

## 9. Governance and what it cannot do

The manager has one governor, the **operator**: the ops multisig `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2`, which accepted the role from the deployer in
[`0x6074f810…5f39`](https://etherscan.io/tx/0x6074f810491dff24cf130490ac55f9994c953cf1dab852f180003b7646735f39)
(`gov()` is the multisig and `pendingGov()` is empty). The bounds below are enforced by the contract, not by policy.

| the governor can | but only |
|---|---|
| re-weight a pool, or add a pool | through a **public queue with a 7-day delay** (executable for 14 days after); **one change per 30 days**; an existing pool moves at most **±25% per change and never to zero**; a new pool starts at **≤ 10%** of the total |
| top up the program (`notifyRewardAmount`, or `fundAndNotify` after funding) | rate may be **kept or raised, never lowered** mid-program; the end may only stay or move **later**; duration 7 to 365 days |
| set a lock on a new pool | at most **90 days**, applying only to positions bonded afterwards |
| reclaim treasury (`recover`) | **only after the period ends + 7 days**, and only the **unearned surplus**: everything owed to live positions stays reserved |
| propose a new governor | the new one must accept; the old governor's queued changes die with the handover |

So: a pool's weight only moves within a bounded band, a running program's end date never moves earlier and its rate
never drops, and earned rewards stay claimable. The operator cannot spend a position, move an LP note, or touch a
harvest.

**Top-ups.** `TacFarmFunder.fund(controller, amount)` (or `fundWithPermit(controller, amount, deadline, v, r, s)`)
takes plain TAC, wraps it to wTAC and escrows it into the manager's treasury in one transaction. Anyone may fund
the treasury; only the governor can stream it, via `notifyRewardAmount(reward, duration)`. Alternatively the
governor calls `fundAndNotify(amount, duration)` after holding wTAC.

## 10. FAQ

**Why is the reward wTAC and not TAC?** A confidential-pool-minted asset cannot be the reward of an escrow farm;
only an external registered ERC20 can. wTAC is a plain 1:1 ERC20 wrapper of the TAC ERC20 registered in the pool as
an escrow asset, so a reward is real backed value that the treasury holds. Redeeming is exactly 1:1.

**Why is my reward a note?** A harvest mints a confidential note so the payout is not linked to the position
or to a public address. You choose when, and where, to pay it out publicly (the unwrap in section 5).

**Why can't I claim more than `pending`?** The manager checks the claim against the position's accrued window and
rejects an over-claim (`OverClaim`). The number shown on the button is the ceiling.

**What if I lose the receipt key?** The position is stuck: the shares stay bonded and unclaimable. Nothing can
recover it. This is why section 7 says to persist the key before the bond is submitted.

**What if I lose the wTAC note?** The same as any note: it opens from its memo through the wallet's seed scan. Keep
the harvest's blinding until you have seen the note in a scan.

**Can I bond part of a note?** A position bonds its shares whole. Split the LP note first.

**Does the program end?** Epoch 1 ends at `periodFinish`. A later epoch is a top-up: the governor streams more TAC
through `notifyRewardAmount`, and positions carry over unchanged.

**Is a bond or a harvest private?** Partly. See section 12.

## 11. Verified on mainnet

Every flow above was driven with real proofs against the live manager.

| step | transaction |
|---|---|
| bond | [`0xd5f7d4ad…01c9`](https://etherscan.io/tx/0xd5f7d4ada9fdf15bb7c0a45c130fc1135e790e0871a4bc605305afc81bb901c9) |
| second bond | [`0x898525de…0ce0`](https://etherscan.io/tx/0x898525de2e7d1fdf74ddad8e592e9d54640ff3490bad2a46e6c5e25bbd530ce0) |
| harvest (position 1) | [`0xa5c9b184…dc73`](https://etherscan.io/tx/0xa5c9b1846a3958cbecef501b9331229a6835ca3945f65fdc58bbb1f7a593dc73) |
| unbond (position 2) | [`0x7139528f…c347`](https://etherscan.io/tx/0x7139528fd9513edb4329f4b5dc6e1fd469ce3087f1b408ae6f70c1e80611c347) |
| wTAC note unwrap | [`0xe41ba5f0…2a70`](https://etherscan.io/tx/0xe41ba5f064eddbb0a3548bce63e1240487908796f32f8620b402b3d6228e2a70) |
| `WrappedTac.withdraw` | [`0x2e4e056d…7d34`](https://etherscan.io/tx/0x2e4e056d355bf73b076ee8af67ea7ce771b531c7516275307e71ec82a7c87d34) |
| TAC wrap settle | [`0x6137a80d…02d1`](https://etherscan.io/tx/0x6137a80d323226488463f9a2ed4606c5e2622e129bf79142c3d88b74764a02d1) |

One-click entry (`lpBond`, add liquidity and bond in one settle, self-settled): bond
[`0x1db736a7…414c`](https://etherscan.io/tx/0x1db736a739ffdda1f2cffb685a5caba2ebfcfb454094b66e6e9dbf2db67f414c)
added 1,100 cETH units and 15,711,068 TAC units for 131,446 shares (the manager's total rose by exactly that);
its harvest [`0xb9a500a2…5a85`](https://etherscan.io/tx/0xb9a500a2d49e255e3192cac65d51a7f04952049af4a7eadcadc255f8a9b75a85)
paid 11,057,654 units, equal to the treasury debit; its unbond
[`0xaa3f122e…5a07`](https://etherscan.io/tx/0xaa3f122ed9bce60d085af458486a10b8c229a22623e69b40fb91f6a842a45a07)
returned the shares. Harvest before unbonding: unbond does not pay out reward that has not been harvested, and
`farmUnbond` refuses unless you pass `forfeitPending: true`.

## 12. Privacy

- Stake and reward notes and the receipts are hashes owned by **fresh keys**. Nothing links an LP's identity to
  a receipt, or a receipt to the address a reward is eventually paid to.
- **Bond shares and harvest amounts are public**: they are in the manager's `Bonded` and `Harvested` events.
  Someone watching sees "a receipt bonded N shares in pool 0" and "a receipt harvested M".
- **The final unwrap to an address is public.** That is the step where a payout destination appears. Keep the
  reward as a note, or redeem to a fresh address, if that matters.
- The relay that proves your op sees the witness for it (see BUILD-A-TACIT-DAPP section 6).

## 13. Further

- [`BUILD-A-TACIT-DAPP.md`](./BUILD-A-TACIT-DAPP.md) — the base guide, with a minimal farms example
- [`DEPLOYMENTS.md`](./DEPLOYMENTS.md) — every live address
- [SPEC §6.4](../SPEC.md#64-ethereum--bitcoin) — TAC notes to Bitcoin
- [`contracts/src/FarmManager.sol`](../contracts/src/FarmManager.sol) — the program contract; the governance bounds
  above are constants there
