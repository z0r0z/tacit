# Integrator playbook: a trustless integration

A checklist for a team building a trading or earning UI on the confidential pool. It assumes the basics from
[`BUILD-A-TACIT-DAPP.md`](./BUILD-A-TACIT-DAPP.md) and links out for depth: farms in [`FARMS.md`](./FARMS.md),
addresses and lifecycle in [`DEPLOYMENTS.md`](./DEPLOYMENTS.md), op semantics in [`SPEC.md`](../SPEC.md), and
key-only recovery in the [recovery chapter](./RECOVERY.md).

The goal has two halves that reinforce each other. **The user's key is the whole account**: connecting it should
bring back every balance and position. **The integration adds no trust**: anything the user can do through your
UI they can also verify, and finish, without you.

Names below are the SDK object from `makeConfidentialPoolUx` (`tacit`), and amounts are in-system units (8
decimals) unless a name says Wei.

---

## 1. Zap into a farm

One settle adds liquidity and bonds the resulting shares, so the user never holds an idle LP note.

```js
tacit.lpBond({ walletPriv, controller: farm.manager, aNote, bNote, feeBps, selfRelay: true })
```

| requirement | detail |
|---|---|
| Notes | Two **whole** notes, one per side of the pair, each spent in full. Size them first. |
| Ratio | The pool mints `min(S·dA/Ra, S·dB/Rb)` shares (`tacit.pool.lpAddShares`). Anything off the pool ratio is donated to existing LPs, so contribute in ratio. |
| Fee | None. `lpBond` has no relay fee leg, so pass `selfRelay: true`. The relay proves; the wallet's derived account (`tacit.account(walletPriv).address`) sends the settle and pays its gas, so it needs ETH. |
| Enabled by | `cfg.farmControllers[poolId]`. The launch pools are listed in `cfg.farm.pools`. |
| Result | `{ dShares, receiptLeaf, receiptOwner, anchorLeaf, lpAsset, txHash, ... }`. |
| Position key | Derived from the wallet key, the manager, the LP asset and the spent A note (`tacit.lpBondPosition`). Nothing to store. |

Sizing, in order:

```js
const p   = tacit.cfg.farm.pools[0];                                   // { poolId, feeBps, lpAsset, ... }
const res = await tacit.poolReserves(p.poolId);                        // { reserveA, reserveB, totalShares, feeBps }
// assetA is the lower asset id of the pair. fee: 0n because lpBond carves no fee.
const q   = await tacit.quoteLpAdd({ assetA, assetB, feeBps: p.feeBps, amountA, fee: 0n });   // q.amountB rounds up
const shares = tacit.pool.lpAddShares(q.sharesPre, q.addA, q.amountB, q.reserveA, q.reserveB); // expected shares
await tacit.ensureExactNote({ walletPriv, asset: q.assetA, amount: q.amountA, notes });        // splits only if needed
await tacit.ensureExactNote({ walletPriv, asset: q.assetB, amount: q.amountB, notes });
const { notes: fresh } = await tacit.balance(walletPriv);              // ONE scan after sizing
// pick aNote and bNote from `fresh`, then call lpBond
```

- `ensureExactNote` returns the note unchanged when one already has the exact value. Otherwise it settles a
  relayed self-transfer (which pays the relay fee in that asset) and rescans.
- Take **both** notes from the same final scan. The op carries one `spendRoot`, so both membership paths must be
  taken against the same root. A note kept from before a split has a path against an older root.
- Show the expected `shares` before the user confirms. Bond shares are public in the manager's events; the
  identity behind them is not.

On mainnet: bond [`0x1db736a7…414c`](https://etherscan.io/tx/0x1db736a739ffdda1f2cffb685a5caba2ebfcfb454094b66e6e9dbf2db67f414c),
its harvest [`0xb9a500a2…5a85`](https://etherscan.io/tx/0xb9a500a2d49e255e3192cac65d51a7f04952049af4a7eadcadc255f8a9b75a85),
its unbond [`0xaa3f122e…5a07`](https://etherscan.io/tx/0xaa3f122ed9bce60d085af458486a10b8c229a22623e69b40fb91f6a842a45a07)
(see [`FARMS.md`](./FARMS.md) section 11).

**Two-step alternative.** `tacit.lpAdd({ walletPriv, aNote, bNote, feeBps, ... })` mints an LP-share note (partial
contributions are supported; the remainder returns as change), then
`tacit.farmBond({ walletPriv, controller: farm.manager, lpNote })` bonds that whole note. Use it when the user
wants to hold the LP note, or wants to bond part of a larger note (split first). `farmBond` also derives its key
from the wallet key and the note, so it is recoverable the same way.

---

## 2. Unbond and cash out

| step | call | notes |
|---|---|---|
| Find positions | `tacit.farmPositions({ walletPriv })` | Each has `pid`, `shares`, `pendingUnits`, `pendingTac`, `unlockAt`, `receiptLeaf`. |
| Harvest | `tacit.farmHarvest({ walletPriv, position })` | Claims the pending reward as a wTAC note. Wait for it to settle. |
| Unbond | `tacit.farmUnbond({ walletPriv, position })` | Returns the whole LP-share note. Refuses while more than 0.001 TAC of reward is pending, unless `forfeitPending: true`. |
| Remove liquidity | `tacit.lpRemove({ walletPriv, assetA, assetB, feeBps, shareNote })` | Optional. Whole-note burn. |
| Redeem the reward | `tacit.farmRedeem({ walletPriv, note, to })` | Step one of three, below. |

Harvest first, always. Unbonding retires the position and does not pay out reward that was not harvested. A
harvest also re-stamps the position, so anything that accrues between building the harvest and its settle is
not carried over.

**Redeeming the wTAC note to TAC** (`farmRedeem` performs step 1 and returns the rest as data to drive):

1. Relayed unwrap of the wTAC note to an address (public: the address and amount appear on-chain).
2. Wait until the wTAC ERC20 balance of that address has increased. Do not rely on the unwrap's `settled`
   status (section 5).
3. `WrappedTac.withdraw(amount, to)` from that address, which pays TAC 1:1. That address needs ETH for gas.
   Optionally wrap the TAC back into a note.

**Progress and display.** `GET /farm/program?network=mainnet` (cached, no key) and `tacit.farmProgram()` (reads the
manager over your RPC) give the epoch, per-pool weight and totals; `farmProgram().pending(receiptLeaf)` and
`.position(receiptLeaf)` give one position's live reward. `GET /farm/health` returns the solvency, runway and
idle-pool checks. Card and monitoring layouts are in [`FARMS.md`](./FARMS.md) sections 4 and 8.

---

## 3. Position keys and key-only recovery

The user's wallet key is the only thing they should have to keep. Recovery reads chain state and re-derives; it
sends nothing. The full method, result shapes and limits are in the [recovery chapter](./RECOVERY.md); this table
is what the current code derives from the key alone.

| what | how it is found from the key | needs a stored record? |
|---|---|---|
| Notes sealed to the wallet (outputs of relayed ops: change, swaps, LP shares, harvest and unbond notes, claims) | memo scan (`tacit.balance`) | no |
| Wrap notes | re-derived per `(asset, index)` and matched to the pool's public deposit ids; the walk stops after a run of 24 unused indexes | no |
| Farm positions from `lpBond` / `farmBond` | receipt key derived from `(wallet key, manager, LP asset, anchor note)` (`lpBondPosition`), matched against the manager's `Bonded` events; the anchor is a note the wallet spent | no |
| Bridge-mint destination notes | blinding derived from the wallet key and the burn nullifier | no |
| cBTC bearer notes (owner 0, empty memo) | blinding derived from the wallet's Bitcoin funding prevout, so it needs the wallet's Bitcoin history (`balance` and `recover` read it from a public Bitcoin index unless you pass `btcHistory`) | no, but the scan must include that channel |
| Stealth locks received / sent | trial-decrypt of lock memos; the sender's own tail restores its refund key | no |
| Send-and-unwrap change | read from the settle calldata of the spent parent | no |
| Farm positions opened under a random receipt key (an explicit `bondFarm` with a generated `ownerPriv`) | not derivable | **yes**: keep `{ lpAsset, shares, receiptLeaf, owner, nonce, ownerPriv }` |
| A note whose emitted memo differs from the one sealed | the sealed memo | **yes**: the client keeps it locally under the settle's tx hash |
| The destination blinding of a cross-out | returned by `tacit.crossOut` | **yes**: persist it |

`tacit.recover({ walletPriv })` runs the passes together and returns `{ notes, farmPositions, sentLocks,
receivedLocks, cbtc, cdpPositions, diagnostics }`, where `diagnostics.coverage` says what each category scanned and
`diagnostics.unresolved` lists what nothing explained (see the recovery chapter for the exact fields).

Recommended UX:

- **On wallet connect, run one recovery pass** and show a coverage summary: found, spendable, and an
  **unresolved** line for anything the pass could not attribute. Do not present an empty list as "you have nothing"
  when a channel errored or was skipped.
- **Never make device storage the only copy.** Local storage is for speed and for the few records in the table
  above. Everything else must come back after clearing the browser.
- **Offer an export** of the position records the key cannot re-derive, and an import that checks them against the
  chain (`tacit.importFarmPosition(record)` verifies a farm record before storing it).
- **Persist before you submit** any op that creates a random-key position or a value only you know. A failed
  submit then costs nothing; a lost record can cost the position.
- **Verify emitted memos after every relayed settle** and surface a mismatch. `tacit`'s relayed calls do this and
  throw with the sealed memos attached; catch that error and show it rather than a generic failure.
- **Rescan before every spend.** Notes spent elsewhere drop out, and every input needs a path against one root.

---

## 3a. Private payments to another person

- **Address them by pubkey, not a 0x address.** The receiver's confidential spend pubkey is the address. A 0x address is a hash and does not reveal it, and the pool has no registry from one to the other. Use their `tacit1…` address, or a name: the dapp reads the `finance.tacit` text record of a `.wei`, `.gwei` or `.eth` name (Ethereum mainnet only, no off-chain lookups) and pays the Ethereum-side key its `tacit1…` value decodes to. Look the name up at send time, show `name → tacit1…` before signing, and refuse a missing or invalid record. `dapp/confidential-names.js` implements the read, the strict decoder, and publishing a user's address to their verified primary name ([`BUILD-A-TACIT-DAPP.md`](./BUILD-A-TACIT-DAPP.md), "Paying someone else"). To receive by name, show the user a "publish my Tacit address" action, or have them show their `tacit1…` address.
- **A plain 0x address can be paid publicly from your own confidential balance.** Deposit, then pay it with a relayed `sendUnwrap`: the address and the amount are public and only the sender is hidden, weakly. The pattern, fees and limits are in [`PRIVATE-PAYOUT.md`](./PRIVATE-PAYOUT.md).
- **`wrapAndSend` is for your own wallet.** It wraps and settles in one transaction and splits the deposit into an amount plus change. It refuses a third-party recipient, because that note could never be spent. Use `stealthSend` to pay someone else.
- **The receiver recovers from the key alone.** `tacit.recover({ walletPriv })` returns the lock under `receivedLocks`, and the note its claim mints is derived, so it comes back too.
- **Show a claim-by date.** After a lock's deadline (about 90 days by default) the sender can refund. Warn the receiver as it nears.
- **Run the memo check before sending.** A lock with an unopenable memo cannot be found by the receiver.
- **Keep the sender record.** Store what `onBuilt` returns so a refund never depends on rediscovering the lock.

---

## 3b. The TAC airdrop

For a wallet, an aggregator or a swap front-end that wants to show a user's TAC airdrop and deliver it. The contract, the proof files and the client API are in
[`BUILD-A-TACIT-DAPP.md`](./BUILD-A-TACIT-DAPP.md) section 5a; the roles and the guardian's powers are in [`AIRDROP.md`](./AIRDROP.md).

- **Show the balance first, with no wallet.** `status(address)` (`tacit.tacAirdrop.status` in the dapp) needs only an address. It fetches one proof file, recomputes the proof against the pinned root, and reads the contract in one `eth_call`.
  Show `amountTac` and `claimByISO`, and switch on `reason`. An `error` means "could not check", never "not eligible".
- **Offer `claim` and `claimTo`, not shield.** The shield route's last step, settling the deposit into a note with a proof, has not been run on mainnet for this contract. The client refuses to plan it
  unless you pass `allowUnproven: true`.
- **A sponsor can claim for the user.** `claim` can be submitted by anyone, needs no signature from the recipient, and always pays the recipient's own address, so a wallet or a relayer can cover the gas without being able to
  redirect the TAC. `claimTo` and `claimAndShield` need the recipient's own account. A sponsored `claim` uses up the allocation, so it takes away the user's choice to send it elsewhere or shield it: ask first, or sponsor only
  users who asked for it. Skip allocations too small to be worth the gas (a claim costs about 91k whatever it pays; the smallest is 0.00000001 TAC).
- **Never construct a `commit` by hand.** It has to be `buildWrap` for the recipient's own wallet key at an unused wrap index; any other value deposits the TAC where no key can spend it, and the pool cannot cancel a deposit. Use `shieldPlan`.
- **Confirm from the chain.** A claim has landed when `isClaimed(index)` reads true and the `Claimed` event is in the receipt. A wallet's "sent", your own sponsor's log or a relay's "settled" are not that. `waitClaimed` polls the chain.
- **Expect a race.** Anyone can `claim` for a recipient at any time, so a claim you send can find the allocation already claimed. It is refused before sending (`claimed`) or reverts `AlreadyClaimed`. Either way the recipient has the TAC at their own address
  (or where they sent it, if they claimed it themselves): show their balance, not an error.
- **Proof hosts are not trusted.** A proof is checked against the root, so a proof host can withhold a file but cannot forge an allocation. tacit.finance sends no CORS header; from another origin use the pinned CDN and GitHub URLs
  (`PUBLIC_PROOF_HOSTS`, tried in order) or serve your own copy of the files.
- **Do not promise the window.** The guardian can pause claims or sweep the balance at any time, and the window ends at unix `1797803449`. `status` reports `paused`, `funded` and `secondsLeft`; show them.

---

## 4. Trustless checklist

| check | how |
|---|---|
| **Settle it yourself** | `mode: 'prove'` returns `{ publicValues, proof }`; submit with `tacit.submitSettle({ settlerPriv: walletPriv, publicValues, proof, memos })` from the user's own account. `selfRelay: true` on an op does both steps. Proving the op yourself with its harness (`contracts/sp1/confidential/harnesses/exec-<op>.rs`, `MODE=groth16`) and submitting the result removes the relay from the loop entirely. |
| **Self-relay by default where it costs nothing** | Ops with no fee leg (`lpBond`, pool founding) should use `selfRelay: true`. Pool founding cannot be relayed at all: it needs `createPairAndSettle`. |
| **Read chain state yourself** | Pool roots (`currentRoot()`), pair reserves (`pools(bytes32)`), spent flags, the lock set (count and root at storage slots 84 and 85, the `getLockState` callback of `scanLockLeaves`), `successor()`. Use your own RPC, not only a hosted endpoint. |
| **Check the pinned code** | The pool's `PROGRAM_VKEY` and `BITCOIN_RELAY_VKEY` are immutables in the deployed bytecode. Compare them with [`contracts/sp1/confidential/elf-vkey-pin.json`](../contracts/sp1/confidential/elf-vkey-pin.json) and the anchors in [`DEPLOYMENTS.md`](./DEPLOYMENTS.md), and rebuild the ELFs with [`REPRODUCIBLE-BUILDS.md`](./REPRODUCIBLE-BUILDS.md). Every proof is bound to its pool's address, so a different pool is a different deployment. |
| **Witnesses do not go stale** | The pool never prunes a root it has had, so a membership path stays valid. An op carries one `spendRoot`: take every input's path from one scan. |
| **A relay's `settled` is not final** | Confirm from the chain: the settle transaction's receipt and events, the note's nullifier, or the recipient's balance for an exit. Tell the user "submitted" until then. |
| **Know what the relay sees** | Per spent note: commitment, owner, index, path and its nullifier key `nk`; per op: outputs, public legs and the authorizing sigma or kernel; the memos. Never the wallet key, the seed or a note's blinding. It can decline or delay; it cannot redirect an output, raise a fee or spend a note some other way. Before submitting a settle it checks the memos against the proof's memo root. Details in [`BUILD-A-TACIT-DAPP.md`](./BUILD-A-TACIT-DAPP.md) section 6. |
| **Hosted endpoints are conveniences** | `/confidential/index`, `/confidential/quote`, `/confidential/status`, `/farm/program` re-serve or price public state. The index can be rebuilt from logs and calldata (`scanLockLeaves` with `strict: true` checks the result against the pool), and its own `lockSet.verified` says whether it reproduces the pool. Show the user something they can check without you. |
| **Ops multisig powers** | The multisig `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` owns the collateral engine (oracle and CDP parameters, cBTC escrow enforcement inside an immutable minimum grace window) and is the pool's lineage steward. The steward can deploy a successor once; that closes this pool to **new** value while every exit, removal, close, claim and refund stays open. It cannot touch escrow, freeze an exit or redirect a payout. See [Lineage](./DEPLOYMENTS.md#lineage). Watch `successor()` and tell users when it is set. |
| **Farm governance bounds** | Re-weighting is a public 7-day queue, one change per 30 days, at most ±25% per change and never to zero; the rate may be kept or raised, never lowered, and the end only moved later; a lock is capped at 90 days and applies to later bonds only; treasury recovery waits until 7 days after the end and only takes unearned surplus. It cannot spend a position. See [`FARMS.md`](./FARMS.md) section 9. |

---

## 5. Gotchas

| symptom | what is happening | do this |
|---|---|---|
| `unwrap` with `wait: true` says `settled` | The status can come from the relay's acknowledgement or from the note leaving the scan; the result's `txHash` may be null. | Confirm by the recipient's balance (ERC20 `balanceOf` for a token exit) or the receipt. |
| `DepositExists` on a wrap | The same asset, amount and index is a deposit the pool already holds. | Let the wrap take the next index (`nextWrapIndex`), or pass an unused one. |
| Two wraps on one index | A different amount on a used index reuses the note's key material: the notes are linkable, and opening one exposes the other. | Never pin an index a deposit used. Record the `index` returned on the result. |
| `buildWrap` or `buildWrapTransferOp` reuse index 0 | The synchronous builders default to `index = 0`. | Pass `await tacit.nextWrapIndex(...)`. |
| cBTC balance missing | cBTC bearer notes have an empty memo and derive from Bitcoin history. | Make sure that channel ran (it does by default; `btcHistory` supplies your own source) and show it as unresolved if it errored or was skipped. |
| Relayed `lpBond` refused or unpriced | It carries no fee leg for the relay to take. | `selfRelay: true`. |
| Zap mints fewer shares than expected | An off-ratio contribution is donated to existing LPs. | Size B from A with `quoteLpAdd(..., fee: 0n)`. |
| `UnknownRoot` or a membership failure after sizing | A note's path came from an earlier scan than its sibling's. | Rescan once and take every input from it. |
| Harvest shows less than `pending` | A harvest re-stamps the position: accrual during proving is forfeited. | Claim the pending read at build time (the default), keep a small margin if you choose the amount, and do not offer a "claim half" control. |
| Unbond refused | Unharvested reward would be forfeited. | Harvest, wait for it to settle, then unbond. `forfeitPending: true` is for a user who chooses to skip it. |
| A position cannot be found after a restore | It was opened under a random receipt key. | Import the saved record; new positions should use `lpBond` or `farmBond`. |
| Reward is a note, not TAC | The reward is a wTAC note. | Run the three-step redeem in section 2. |
| Two processes, one key | A scan of a key returns every note sealed to it, including another process's. | Give each process its own key, or keep an explicit leaf list. |
| Amount or asset id looks wrong | ETH is registered under its linked id, values are 8-decimal units, and a wrap amount must divide by `unitScale`. | Use the ids in [`BUILD-A-TACIT-DAPP.md`](./BUILD-A-TACIT-DAPP.md) section 3. |
| Lock scan throws | The lock set rebuilt from events does not match the pool's count and root. | Retry or use another RPC. Do not build a claim or refund from a set the pool does not confirm. |
| Airdrop `status` says `error` | A proof host or the RPC did not answer, or a served entry did not verify against the root. | Retry, or add a second host to `proofsBase`. Do not show "not eligible". |
| A claim reverts `AlreadyClaimed` | The recipient, or another sponsor, claimed first. | Read `status` just before sending and treat `claimed` as done: the TAC is with the recipient. |
| A `crossOut()`'s Bitcoin-side mint never folds | `crossOut()` only settles the Ethereum side; the Bitcoin-side reveal is a separate step, and the guest checks it once, at scan time, against its current Ethereum-state view — a claim broadcast before that view includes the crossOut is a permanent miss, not a retry. | Build the reveal with `tools/build-crossout-mint.mjs` (uses the crossOut's own verified `claimId`/`cx`/`cy`), but broadcast it only once the crossOut shows up in `GET /reflection/eth-state`, not immediately after settling. See [`BUILD-A-TACIT-DAPP.md` §5f](./BUILD-A-TACIT-DAPP.md#5f-bridging-between-chains). |
