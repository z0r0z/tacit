# Integrator playbook: a trustless integration

A checklist for a team building a trading or earning UI on the confidential pool. It assumes the basics from
[`BUILD-A-TACIT-DAPP.md`](./BUILD-A-TACIT-DAPP.md) and links out for depth: farms in [`FARMS.md`](./FARMS.md),
addresses and lifecycle in [`DEPLOYMENTS.md`](./DEPLOYMENTS.md), op semantics in [`SPEC.md`](../SPEC.md), and
key-only recovery in the [recovery chapter](./RECOVERY.md). [tacit.finance/build](https://tacit.finance/build/) maps every path on one
page.

The goal has two halves that reinforce each other. **The user's key is the whole account**: connecting it should
bring back every balance and position. **The integration adds no trust**: anything the user can do through your
UI they can also verify, and finish, without you.

Names below are the SDK object from `makeConfidentialPoolUx` (`tacit`), and amounts are in-system units (8
decimals) unless a name says Wei.

---

## 1. Zap into a farm

One settle adds liquidity and bonds the resulting shares, so the user never holds an idle LP note.

```js
tacit.lpBond({ walletPriv, controller: tacit.cfg.farm.manager, aNote, bNote, feeBps, selfRelay: true })
```

| requirement | detail |
|---|---|
| Notes | Two **whole** notes, one per side of the pair, each spent in full. Size them first. |
| Ratio | The pool mints `min(S·dA/Ra, S·dB/Rb)` shares (`tacit.pool.lpAddShares`). Anything off the pool ratio is donated to existing LPs, so contribute in ratio. `lpBond` and `lpAdd` refuse a leg that would donate more than 0.5% (`maxDonationBps`, default 50). |
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
`tacit.farmBond({ walletPriv, controller: tacit.cfg.farm.manager, lpNote })` bonds that whole note. Use it when the user
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
| Staged deposits (a note withdrawn into a deposit only its key spends: [3d](#3d-staged-deposits-and-receive-codes)) | the wrap walk finds them as pending deposits at the key's wrap indexes; the transaction that made each (an `activateExit` on the router) tells a staged one from a wallet deposit not yet settled | no |
| Payments to a receive code | memo scan; the memo carries a receive index where a note's `nk` goes, and the `nk` is re-derived from the key and that index | no, but the memo opener must take that form ([3d](#3d-staged-deposits-and-receive-codes)) |
| CDP positions opened with the derived owner (`derivePositionOwnerPriv` in `confidential-recovery.js`, one key nonce per position, as `btc-borrow.js` does) | owner re-derived per key nonce and matched to the position's settle calldata (`recoverCdpPositions`) | no |
| Farm positions opened under a random receipt key (an explicit `bondFarm` with a generated `ownerPriv`) | not derivable | **yes**: keep `{ lpAsset, shares, receiptLeaf, owner, nonce, ownerPriv }` |
| CDP positions opened under a random owner key | not derivable | **yes**: keep the position descriptor with its owner key |
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
- **`wrapAndSend` is for your own wallet.** It wraps and settles in one transaction and splits the deposit into an amount plus change. It refuses a third-party recipient, because that note could never be spent: a note's owner is the hash of an `nk` only its holder knows. Use `stealthSend` to pay someone else, or pay the receive code they gave you from a staged deposit ([3d](#3d-staged-deposits-and-receive-codes)).
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

## 3c. Listing the TAC ERC-20

For a DEX, an aggregator, a lending market, a wallet or a market-data site adding TAC on Ethereum. What TAC is and where it trades are in
[`TAC.md`](./TAC.md#integrating-the-erc-20); this is what to get right.

- **Identify it by address.** TAC is [`0xA1313eb9f3A445606D9583bcAc3ebeB56a858279`](https://etherscan.io/address/0xA1313eb9f3A445606D9583bcAc3ebeB56a858279), symbol `TAC`, 18 decimals.
  Every token the pool mints is named `Tacit Token`, so never match on the name. Three reads confirm it: `MINTER()` is the pool
  `0x000000000Ed1eabD231Be41d93b719056F7febFC`, `ASSET_ID()` is `0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b`,
  and the pool's `canonicalTokenFor(ASSET_ID)` returns the token.
- **The supply is 21,000,000, fixed on Bitcoin.** Only the pool can mint the ERC-20, and only against TAC that came from Bitcoin, so
  `totalSupply()` is the part public on Ethereum right now, never more than the etch. It moves both ways with use: it rises when TAC leaves the
  pool (an exit, or a public swap paid out in TAC) and falls when TAC goes back in (a wrap, or a public swap paid with TAC). For a market-data
  site, the maximum supply is 21,000,000. [verify.html](https://tacit.finance/verify.html) checks the etch, the token's code and wiring, the
  supply bound and wTAC's backing from the reader's own browser.
- **Amounts.** Transfers take any amount. The pool and TacitPublicAmm take only whole multiples of `1e10` (TAC has 8 decimals on Bitcoin)
  and revert `AmountNotAligned` on anything else, so round down to `1e10` before quoting.
- **Nothing non-standard.** No transfer fee, rebasing, hooks, pause, blacklist or owner. EIP-2612 `permit` uses the name `Tacit Token` and
  version `1`. The canonical Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) holds a standing maximum allowance from every holder:
  `allowance(holder, Permit2)` reads `2^256 − 1` with no approval, and a Permit2 flow needs no approval transaction.
- **Metadata and logo.** `contractURI()` (EIP-7572) returns the token's metadata JSON on IPFS. Its hash is bound into the asset id at the
  etch, so it cannot be changed. The logo is [tacit.finance/brand/logo.svg](https://tacit.finance/brand/logo.svg).
- **Quote and route.** TAC/ETH trades on the Precision pool (0.30%) and on the Tacit pool through TacitPublicAmm
  [`0x00000000E36C7EC997CC59DCda9E03673B448119`](https://etherscan.io/address/0x00000000E36C7EC997CC59DCda9E03673B448119).
  `quoteSwap(assetIn, assetOut, 30, amountIn)` returns exactly what `swapPublic(assetIn, assetOut, 30, amountIn, minAmountOut, deadline, to)`
  pays. The asset ids are TAC's `ASSET_ID` and ETH's `0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34`; ETH goes in as
  `msg.value`, and TAC going in needs an `approve` to TacitPublicAmm. [`dapp/evm-trade-venues.js`](../dapp/evm-trade-venues.js) has the
  addresses, quotes and calldata for every venue ([`TAC.md`](./TAC.md#trading-tac)).
- **A pool's spot price is not an oracle.** One trade can move either pool. Collateral needs a price that is costly to move, such as a
  time-weighted average over enough liquidity.
- **wTAC is a separate token.** [`0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf`](https://etherscan.io/address/0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf)
  wraps TAC one for one to escrow farm rewards. List TAC, not wTAC.
- **The Tacit chain holds TAC.** `TacitBlocks` [`0x00000000000a9147ffd8d41d152d730ca5f84e6c`](https://etherscan.io/address/0x00000000000a9147ffd8d41d152d730ca5f84e6c)
  holds the TAC behind private balances on the Tacit chain, a zk-rollup for TAC payments, and `TacitSeats`
  [`0x00000000001f703eae70de3b528213e4802790fb`](https://etherscan.io/address/0x00000000001f703eae70de3b528213e4802790fb) holds the TAC locked
  in leader seats. Both balances are part of `totalSupply()`. See [`TACIT-BLOCKS.md`](./TACIT-BLOCKS.md).
- **Watch `successor()`.** It reads zero today. If the lineage steward deploys a successor pool, that pool mints its own canonical TAC at
  another address. This token keeps working and can still be wrapped into this pool and crossed to Bitcoin, so tell users which TAC they
  hold. See [Lineage](./DEPLOYMENTS.md#lineage).

---

## 3d. Staged deposits and receive codes

A swap from a private note needs the note's key and pins the pool's reserves in one proof, so whoever proves it fast sees the key. A **staged deposit** splits the two. The note is withdrawn into an exit escrow whose recipe wraps exactly that ETH back as the key's own pending deposit at a wrap index (`dapp/confidential-stage.js` `stageNote`; with `amountWei` a fixed size comes out of a larger note and the rest is a hidden change note). That step pins nothing that moves, so the holder's own prover can make it at its own pace and post it with its recipe (`relay.postProof({ exit })`), and the relay never sees the key. The deposit then waits: only an opening proof from the key spends it, it never expires and nothing refunds it. Spending it is an op whose program input holds no secret, so any prover may make it, ahead of the press: a swap (`pressSwap`, OP 33), a payment or split (`buildWrapTransferOp`, OP 27), liquidity (OP 32) or a cUSD borrow (OP 30).

- **Do not "finish" a staged deposit.** A wallet that settles every pending deposit of the key as a plain wrap turns staged ones back into notes, paying a fee for nothing. Split them first: `splitPending(pending)` → `{ staged, waiting }`, where staged ones were made by a transaction to the router calling `activateExit`.
- **The amount is public.** A staged deposit's value is on chain, as a wallet deposit's is; who staged it is not. Stage fixed sizes (0.01, 0.1, 1) so that is all it says.
- **A recipe's leftover and a recipe nobody ran** go to a rescue address made from the Tacit key (`rescueKey(walletPriv)`), never to the user's account, which the activation would then name on chain.
- **Receive codes.** To be paid from someone's staged deposit, a key gives out `tacitrecv1:<pubkey>:<index>:<owner>` (`receiveCode({ walletPriv, index })`, one index per payer). The `nk` behind `owner` is derived from the key and the index and never sent. The payer's memo carries the index where a note's `nk` goes (`memo.receiveSecret(index)`): `openMemo` returns such a note with `receiveIndex` and no secret, and the wallet derives the `nk` and keeps the note only if it hashes to `owner`. **A wallet that opens memos itself must take this form, or it will not see these payments.** Old memos open as before.

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
| **`failed` can still land** | A job's `status: 'failed'` with a non-empty `broadcastHashes` is not final: the settle was broadcast and may still be included, and the relay keeps watching those hashes and corrects the job to `settled` if one lands. Retry an exit against the same terms and escrow within its deadline, so a late landing is not orphaned. A `failed` with no `broadcastHashes` was rejected before it was sent. A `proven` job's status returns the `memos` its proof commits to, which `settle()` must carry exactly. |
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
| A `crossOut()`'s Bitcoin-side mint never folds | `crossOut()` only settles the Ethereum side; the Bitcoin-side reveal is a separate step, and the guest checks it once, at scan time, against its current Ethereum-state view — a claim broadcast before that view includes the crossOut is a permanent miss, not a retry. | Use `broadcast.completeCrossOutOnBitcoin({ ...r, ...r.crossOuts[0] })` (`dapp/crossout-broadcast.js`) — it waits on `GET /reflection/eth-state/covers` before broadcasting, and refuses outright unless `crossOut()` corroborated the claimId against the real `CrossOutRecorded` event (a predicted-but-wrong claimId can never fold either). Spread the whole result: it carries both `ethBlock` and `claimIdVerified`. Building the reveal by hand (`tools/build-crossout-mint.mjs`)? Check that same endpoint yourself first. See [`BUILD-A-TACIT-DAPP.md` §5f](./BUILD-A-TACIT-DAPP.md#5f-bridging-between-chains). |
| A Bitcoin-lane AMM swap refunds and the trader's input vanishes | `T_SWAP_VAR` / `T_SWAP_ROUTE` / the swap-batch fold do not skip an op they cannot execute — the vin scan has already nullified the input, so they REFUND, minting a note that commits the input commitment verbatim under the refund output's x-only key. A Bitcoin-homed note's nullifier is derived from (asset, commitment, key) with **no outpoint**, so refunding to a key one of the spent inputs was homed at reproduces the nullifier that was just spent: the refund is born already-spent and the input is destroyed. The refund branch runs whenever the swap cannot execute: the pool's reserves moved, an input was added, or the expiry passed. | Derive a **fresh** key for every refund output — never an input's, never another intent's in the same transaction. `assertFreshRefundKey` (`dapp/amm-refund-key.js`) enforces both; call it before signing. The guest cannot check this for you: it only ever sees the key the transaction pays to. |
| A Bitcoin swap batch reveals the trade | The Bitcoin-lane batch publishes its net reserve deltas in the clear — deliberately, since that is what lets any indexer rebuild pool reserves from chain data. With a single intent the net delta *is* that trade, readable off the transaction with no cryptographic work. Amounts hide by mixing, and one trade mixes with nothing. | Build batches with a real anonymity set. `assertBatchAnonymitySet({ nIntents, acknowledgeSingleIntent })` (`dapp/confidential-swapbatch.js`) refuses a batch of one unless you ask for it explicitly; the EVM-lane batcher (`dapp/confidential-swap-coordinator.js`) sends a pool's batch once four intents are queued, or six seconds after the first. The fold accepts one and always will, so this is the builder's call. The settle lane is unaffected — `OP_SWAP_BLIND` proves the excess instead of publishing it. |
| An `EthCallOutbox` message never reaches the Bitcoin side | `T_ETH_CALL` (0x69) is a value-free attestation channel — the record commits no amount, so honoring one authorizes no mint, note or transfer. The fold is deliberately skip-not-panic (a fabricated 0x69 must not be able to halt the lane) and there is no completeness gate (one unfoldable message must not be able to brick it), so a given Bitcoin transaction's message can be passed over — and a forward batch, which carries a zero message-set root, drops every 0x69 in it. | Treat the channel as at-least-once with sender-driven retry. `msgId` includes a monotone index, so calling `send()` again yields a fresh id and a fresh fold attempt even for a byte-identical payload. Confirm the honored set rather than assuming; re-send if absent. Idempotent payloads fit as-is — put a confirm-and-retry loop in front of anything that must fire exactly once. See [`BUILD-A-TACIT-DAPP.md` §5g](./BUILD-A-TACIT-DAPP.md#5g-cross-chain-messages-ethcalloutbox--t_eth_call). |
| A burn-deposit (Bitcoin → Ethereum) reveal won't relay | Only the burn-deposit case: its envelope and the never-reflected note it burns are locked to the same Bitcoin input by the guest, which pushes the witness item carrying the envelope well past Bitcoin Core's 80-byte standardness cap — ordinary relay refuses it even though it's fully consensus-valid. An ordinary bridge burn of a reflected note is not affected: its envelope rides a separate commit output spent as `vin[0]`, a standard commit/reveal. | Broadcast a burn-deposit via `makeBurnDepositBroadcaster` (`dapp/burndep-broadcast.js`), which submits to MARA Slipstream instead of p2p relay, then registers the provenance once real confirmation is observed. Broadcast a reflected-note burn with `makeBridgeBurnBroadcaster` (`dapp/bridge-burn-broadcast.js`, or `bridgeBurnToPool` on the pool UX), which builds the standard commit/reveal and refuses a burn the reflection would not record. See [`BUILD-A-TACIT-DAPP.md` §5f](./BUILD-A-TACIT-DAPP.md#5f-bridging-between-chains). |
| A Bitcoin → Ethereum mint needs ETH for gas | It doesn't: the relay settles `OP_BRIDGE_MINT`, and the mint can pay the relay from the minted note. The fee is fixed when the burn is built — the destination commits to the burned value minus the fee. | Commit the destination with `destValueFor({ burnValue, fee })` (or `buildBridgeBurnEnvelope`), then submit with `bridgeMint` (`dapp/confidential-bridge-mint.js`). A zero-fee mint relays within the free daily budget. See [`BUILD-A-TACIT-DAPP.md` §5f](./BUILD-A-TACIT-DAPP.md#5f-bridging-between-chains). |
