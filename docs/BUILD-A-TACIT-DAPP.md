# Build a Tacit dapp

The smallest thing that actually works against the live V1 confidential pool, and the shape to grow it in.

Written for someone who has never touched this codebase. Nothing here needs a build step, a framework, or a
node backend. A starting skeleton lives next to this file at [`dapp-template/index.html`](./dapp-template/index.html)
— open it in a browser and it runs.

---

## 1. The model, in six lines

- Your balance is a set of **notes**. A note is `(asset, value, blinding, owner)`; only its Pedersen
  commitment `C = value·H + blinding·G` is public.
- The pool stores **leaves** — `keccak(assetId ‖ Cx ‖ Cy ‖ owner)` — in an append-only Merkle tree.
- Spending a note publishes a **nullifier**, never the leaf. Spend twice and the second settle reverts.
- Every spend is one **SP1 proof** against the pool's immutable `PROGRAM_VKEY`. The pool verifies it and
  applies the effects. The pool has no proxy, no upgrade path and no pause switch, and no key that can move
  escrow, freeze an exit or redirect a payout. It has exactly one privileged call: its **lineage steward**
  (the ops multisig on mainnet) can, once, deploy the pool's successor generation (`createNextGen`), which
  retires this generation to exit-only (see "Generations" in [`DEPLOYMENTS.md`](./DEPLOYMENTS.md)).
  `pool.successor()` reads zero while the generation is active.
- A **memo** is emitted per created leaf: the note's opening, encrypted to its owner. It is the main way a
  wallet recovers its notes from a seed. A few kinds of note carry an empty memo because their opening
  re-derives from the wallet key instead (wrap deposits by index, bridge-mint destinations, cBTC bearer
  notes). The notes a wallet mints for itself (change, LP shares, swap outputs, released collateral, claim and
  refund notes, farm rewards) also re-derive from the key and a public anchor of the settle, so they are found
  again even if a memo was lost; a note sent to someone else has only its memo.
- You do not need to prove anything yourself. The **relay** proves and settles for a fee carved from the op.
  It receives the witness of the op you hand it, but never your wallet key or any note's blinding, so it can
  prove the op you authorized and cannot build a different one (exactly what it sees is in §6).

Everything else is detail.

## 2. Three things that surprise everyone

**You cannot send a note directly to someone else.** A note's `owner` is `keccak(nk ‖ dom)` — a hash, not a
public key. Whoever can compute an output's owner necessarily knows its `nk`; spending needs `nk` together
with the note's blinding, and the sender who builds an output knows both.
So a sender either keeps the ability to spend, or mints a note nobody can ever spend. Third-party payments go
**stealth lock → claim**: the sender locks to a one-time pubkey derived from the recipient's static address,
and the recipient's claim mints a note under an `nk` only they choose. `OP_TRANSFER` is for self-sends —
merges and consolidation. `dapp/confidential-stealth.js` has the payment path.

**Values are `u64` in-system units, not wei.** Each asset has a `unitScale`; the in-system value is
`amount / unitScale`, and the amount must divide exactly. ETH is 18-dec with `unitScale = 1e10`, so the pool
sees 8 decimals. Get this wrong and the deposit is unconsumable — the guest never sees `unitScale` and
reproduces the deposit id from the value alone.

**The Bitcoin lane is not symmetric with the Ethereum one.** Wrapping, sending, swapping and exiting on the
EVM side are fully live. The Bitcoin side has two current limits worth knowing before you design around it:
a generation-bound note (`T_CXFER_BOUND`, 0x39) is now discovered by the wallet scanner, but *spending* one
on the Ethereum fast lane still needs its Bitcoin source registered with the reflection, which is
operator-assisted today. Nothing in this guide's flows depends on either.

**A wrap is two steps.** `pool.wrap(...)` is a plain transaction that escrows funds and registers a *pending
deposit* — no proof. The deposit becomes a spendable note only when an `OP_WRAP` settle consumes it. The
first step works with nothing but an RPC; the second needs the relay.

## 3. What you are building against

Ethereum mainnet, gen5 (live 2026-09-18). Source of truth is
[`contracts/deployments/1-createx.json`](../contracts/deployments/1-createx.json) — read it, don't trust this
table, and re-read it after any redeploy.

| | |
|---|---|
| ConfidentialPool | `0x000000000Ed1eabD231Be41d93b719056F7febFC` |
| ConfidentialRouter | `0x000000005dA3E3B73726af3c774Deeb9472D4992` |
| CollateralEngine | `0x000000003f608BDdF0ca45934003ffb9DbDF70DB` |
| Relay API | `https://api.tacit.finance` |
| Deploy block | `25998736` |

Asset ids (the pool keys by id, not by token address):

| asset | id | unitScale |
|---|---|---|
| ETH (cETH) | `0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34` | `1e10` |
| cBTC | `0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8` | `1e10` |
| cUSD | `0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d` | `1e10` |
| TAC | `0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b` | `1e10` |

ETH is registered under its Bitcoin-side (tETH) link id — that is not a mistake; it is what keeps a bridged
note and a wrapped note the same confidential asset. cBTC's id is a protocol constant; cUSD's is
`keccak("tacit-cdp-debt-v1" ‖ engine)` and **changes with every engine redeploy**.

## 4. Reuse the dapp modules — do not reimplement the crypto

This is the single highest-leverage decision. `dapp/` is a set of plain ES modules with no build step and no
framework. Import them directly.

```js
import { makeConfidentialPoolUx } from './dapp/confidential-pool-ux.js';
import * as secp from '@noble/secp256k1';
import { keccak_256 as keccak256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';

const tacit = makeConfidentialPoolUx({ secp, keccak256, sha256, network: 'mainnet' });
```

That one object gives you the read path, the op builders, and the relay client. The pieces underneath, if you
need them individually:

| module | what it owns |
|---|---|
| `confidential-pool.js` | leaves, nullifiers, commitments, the Merkle/IMT accumulators |
| `confidential-pool-ux.js` | account, balance, and the `wrap` / `transfer` / `unwrap` builders |
| `confidential-relay.js` | `/confidential/submit`, `status`, `waitForSettle` |
| `confidential-indexer.js` | seed-only note recovery from the pool's logs |
| `confidential-recovery-guard.js` | seals memos and refuses to submit an unrecoverable output |
| `bulletproofs-plus.js` | BP+ range proofs, `randomScalar` |
| `confidential-stealth.js` | the third-party payment path (lock → claim) |
| `confidential-deployments.js` | addresses, asset register, `relayBase` |

The recovery guard is not optional politeness. `assertOutputsRecoverable` is what stops you shipping an op
whose outputs nobody can ever spend, and it has caught exactly that in production.

## 5. The four flows

One thing to know first: **Tacit derives its own EVM account from the wallet seed** (per network, via
`evm-account.js`). You fund that address once; after that every call below signs itself and needs no injected
wallet. `account(walletPriv)` is synchronous and returns `{ address, priv }`: the derived EVM address and its
key (`0x`-hex), which is a different key from the wallet's confidential identity. The confidential public key
(`pubHex`, the value `recipientPubHex` takes) comes from `identity(walletPriv)`, which returns
`{ priv, pubHex, owner, secret }`. If you would rather drive an injected wallet, use the `build*` variants — they return `{ to, calldata, amount }` and broadcast
nothing.

### Read a balance

```js
const acct  = tacit.account(walletPriv);          // { address, priv } — the derived EVM account, sync
const me    = tacit.identity(walletPriv);         // { priv, pubHex, owner, secret } — the confidential identity, sync
const funds = await tacit.balance(scanPriv);      // notes recovered from logs + memos, grouped by asset
```

`scanPriv` is the wallet key as `0x`-hex or bytes (the same value `identity` takes). `value` is a `BigInt`.
Each note carries `{ asset, value, blinding, secret, cx, cy, owner, leafIndex, path, root }` — `path`/`root` are the membership
witness a spend needs. The pool accepts every root its note tree has ever had, so a witness does not expire
when someone else settles; it stays valid for as long as the pool's tree does. Rescan before spending anyway,
so that every input's path is taken against one root (an op carries a single `spendRoot`), notes spent since
are dropped, and new notes are picked up.

### Recover everything from the key

`balance` lists spendable notes. To bring back a whole wallet from its key alone (notes made by wraps, bridge mints and
cBTC locks, farm positions, CDP positions, stealth locks) use `recover`:

```js
const r = await tacit.recover({ walletPriv });
// r.notes, r.cbtc, r.farmPositions, r.cdpPositions, r.sentLocks, r.receivedLocks
// r.diagnostics.coverage says what was scanned; r.diagnostics lists what could not be resolved
```

It reads chain state and public Bitcoin history only and sends nothing. What each operation needs, the positions that need
a saved record (`importFarmPosition`), and the cost are in [`RECOVERY.md`](./RECOVERY.md).

If you assemble ops yourself, mint every self-owned output from `tacit.deriveOutput(walletPriv, anchor, role, index)`
(`{ nk, blinding, blindingHex }`) instead of fresh randomness: `anchor` is the first spent note's nullifier (or the
consumed deposit id, receipt leaf, lock nullifier or closed position's nullifier for the ops that have no spent note),
`role` is one of the fixed names in `OUTPUT_ROLES` (`confidential-recovery.js`), and `index` counts outputs of that role. Keep outputs meant for
another party on fresh randomness. The anchors and roles each built-in op uses are listed in the recovery chapter.

### Wrap ETH in (step 1 — a plain tx, no proof)

```js
const w = await tacit.wrap({ walletPriv, amountWei: 10n ** 16n, ticker: 'cETH' });
// signs + broadcasts from the derived account; w.txHash is the deposit tx
```

Injected-wallet variant:

```js
const index = await tacit.nextWrapIndex({ walletPriv, ticker: 'cETH' });   // first index no deposit has used
const w = tacit.buildWrap({ walletPriv, amountWei: 10n ** 16n, ticker: 'cETH', index });
await provider.request({ method: 'eth_sendTransaction', params: [{
  to: w.to, from: myAddress, value: '0x' + BigInt(w.amount).toString(16), data: w.calldata,
}]});
```

Only `commit = keccak(Cx ‖ Cy ‖ owner)` goes on-chain. Keep `w.note` and `w.memo` — that is the note.

`index` selects which deterministic note the wrap creates: `(nk, blinding)` are derived from your key, the
asset and `index`. The same asset, value and index produce the same deposit id, which the pool rejects
(`DepositExists`); reusing an index with a different value reuses the note's `nk` and blinding, which makes
the two notes linkable to anyone who can see both. `tacit.wrap`, `tacit.routerWrap` and `tacit.wrapAndSend`
take the next unused index themselves when you leave `index` out (it comes back on the result); pass one to pin
it. `tacit.buildWrap` and `tacit.buildWrapTransferOp` are synchronous and default to `index = 0`, so give them
the index from `tacit.nextWrapIndex(...)` and record it with the wrap.

### Turn the deposit into a note (step 2 — one proof)

```js
const res = await tacit.submitWrapSettle({ built: w });   // once the wrap tx is mined
```

The guest checks the deposit is registered, so this fails until the wrap tx has landed.

### Wrap and split in one transaction (`wrapAndSend`)

`tacit.wrapAndSend` does steps 1 and 2 together for your own wallet. The wrap and the settle land in one transaction, the
deposit is consumed instead of ever becoming a note, and the proof splits it into the amount you choose plus change. Each output has its own
derived key, so the two are not linkable to each other. You skip the second proof and the separate transfer a plain wrap needs to split.

```js
const r = await tacit.wrapAndSend({ walletPriv, amountWei: 10n ** 16n, ticker: 'cETH', recipientPubHex: me.pubHex, amount: 500_000n });
```

`recipientPubHex` must be your own. The call refuses any other recipient: a native note's owner is `keccak(nk ‖ dom)`, so a note owned
by someone else's pubkey could never be spent, and the deposit would be lost. To pay another person, use the stealth path below. The name
describes the one-transaction shape, not a way to pay a third party.

### Spend

```js
// self-send / merge — recipientPubHex must be your own
await tacit.transfer({ walletPriv, notes, recipientPubHex: me.pubHex, amount: 5_000_000n, fee: 100n });

// exit to a public address
await tacit.unwrap({ note: notes[0], walletPriv, recipient: '0xabc…' });

// pay someone else (stealth lock; they claim it)
await tacit.stealthSend({ walletPriv, notes, recipientPubHex, amount: 5_000_000n });
```

**Paying someone else, and what the receiver needs.**
- **Address.** `recipientPubHex` is the receiver's static spend pubkey, the confidential account's public key. A 0x address does not work:
  it is a hash of a pubkey, so a sender cannot derive the pubkey from it, and the pool has no registry from a 0x address to a pubkey.
  The receiver's `tacit1…` address carries the key, and a name can stand in for that address (next item).
- **Names.** A receiver can publish their `tacit1…` address as the `finance.tacit` text record of a `.wei`, `.gwei` or `.eth` name
  (`.base.eth` is not read), and the send tab accepts the name in the recipient field. `dapp/confidential-names.js`
  (`makeConfidentialNames({ call, send, secp, keccak256 })`) is the same code for your own dapp:
  `resolveName(name)` returns `{ name, address, key, source, node }`, where `key` is the Ethereum-lane key to pass as `recipientPubHex`;
  `primaryName(address)`, `planPublish` and `publish` cover the receiver's side. Behaviour to keep:
  - Lookups read Ethereum mainnet only, whatever network the page is on, and are never cached; look the name up at send time and pin the key for that send.
  - The record must decode strictly: bech32m prefix `tacit`, a 101-byte payload (`[0x00][flags][spend][scan][Ethereum-lane key]`, 33 bytes each after the two header bytes), the Ethereum-lane flag (`0x02`) set, and a valid secp256k1 point in the last 33 bytes. Otherwise the send is refused with the reason.
  - A missing or invalid record, or a name whose resolver answers with an off-chain lookup (no CCIP-read), is refused; a bare 0x account address is never accepted as a private-send recipient.
  - Show the sender `name → tacit1…` before anything is signed, so a changed record is visible.
  - `.eth` resolvers are read directly on the name's own node, or through a parent's wildcard resolver; the record can only be written from here when the resolver sits on the name's own node.
  - Publishing: the primary name is the first of `.wei`, `.gwei`, `.eth` whose reverse record names the wallet and whose forward record points back at it. `planPublish` returns the current and new values, `publish` skips the transaction when they are equal and otherwise simulates `setText` (`eth_call`) before asking the wallet to send. The record is public, so it links the name to the address for everyone.
- **Recovery.** The lock's memo is sealed to the receiver's key. From the key alone, `tacit.recover({ walletPriv })` lists it under
  `receivedLocks`, and the note the claim mints is derived, so it comes back too. The receiver needs no saved record.
- **Claim by the deadline.** A lock carries a deadline (about 90 days by default), after which the sender can refund. Show incoming locks
  with their claim-by date, and prompt the receiver to claim well before it.
- **Memos must open.** A lock whose memo cannot be opened cannot be found by the receiver. Run the memo check on the sender side before sending.
- **Sender side.** The refund key of a lock is fresh randomness. Keep what `onBuilt` returns; locks sent by a build without the sender tail cannot be refunded from the key alone.
- **Discovery cost.** A fresh restore walks the lock events from the pool's deploy block. `/confidential/index` speeds it up, and is not required.

Fees: by default the relay proves *and* submits, and the fee must clear its gas-priced floor
(`tacit.quoteOpFee(...)`, or `GET /confidential/quote?asset=cETH`). `selfRelay: true` with `fee: 0n` has the
relay prove but **you** submit and pay gas — note that the relay still receives the witness either way; what
you avoid is the fee and having the relay's address on the transaction. Removing the relay entirely means
proving locally (native-gnark on CPU — no GPU, no network payment; see
`ops/INTEGRATION-simple-wrap-send-claim-eth.md`).

Each of these returns once the settle lands; pass `waitOpts` to tune the polling. A `selfRelay` settle is sent
from the wallet's derived account (`account(walletPriv)`), which must hold ETH for gas; `tacit.submitSettle` is
the same step for a proof you fetched yourself with `mode: 'prove'`.

Two checks worth keeping. After a relayed settle the client compares the memos the pool emitted with the ones
it sealed (`verifyEmittedMemos`) and throws, keeping the sealed memos locally, if they differ. And `unwrap` with
`wait: true` can report `settled` from the relay's acknowledgement or from the note leaving the wallet scan, so
confirm an exit by the recipient's balance (or the settle receipt) rather than by that status alone.

Which ops need a fee: an op that carries a fee leg (`transfer`, `unwrap`, LP ops, routes) must offer at least
the floor from `GET /confidential/quote` or the relay refuses it at submit; the static cUSD floor is
30,000,000 units. Ops that are fee-less by design (`wrap`, `cbtcmint`, `bridgemint`, adaptor and stealth locks,
`cdptopup`) relay for free within a daily budget. Pool founding cannot be relayed at all: it needs
`createPairAndSettle`, so use `selfRelay: true`.

### Bitcoin-backed cBTC and CDPs

Proven on mainnet: lock real BTC, mint a cBTC note, borrow cUSD against it, repay, and release the BTC.

**Lock → escrow → mint.**

1. Lock BTC in a self-custody output: a Bitcoin transaction whose output 1 carries the lock envelope
   (`dapp/cbtc-lock.js`). Keep the funding input explicit; the dapp's sats helpers pick the largest plain coin.
2. Post the wstETH escrow that backs it: `CbtcEscrowHelper.postEscrowWithETH(outpoint)` (about 320k gas). The
   outpoint key is `outpointKey(reverse(txid), vout)`, and the escrow must cover the lock's value.
3. Wait for reflection to fold the lock block. Reflection only folds blocks at least 24 behind the header
   relay's tip, so plan on roughly 3 hours from the lock's first confirmation. `GET /reflection/status` shows
   `attestedHeight`; the mint works once `pool.cbtcLockVBtc(outpoint)` reads the locked amount.
4. Mint: `await tacit.mintCbtc({ walletPriv, outpoint, vBtc, blinding })`. It is fee-less and relayed. The
   note is a **bearer** note (owner 0): whoever holds its blinding can spend it, and the blinding is derived
   from your key plus the lock's funding anchor. A lock can be minted once. A second mint reverts
   `CbtcLockMismatch` (`0xafff2f20`).

**Open and close a CDP** (`tacit.defiActions(walletPriv).openCdp / closeCdp`):

- `rateSnapshot` must be `1e27` (`0x33b2e3c9fd0803ce8000000`). The UI's all-zero "fee-free" default reverts
  `BadSnapshot` (`0x610f890f`) on the deployed engine.
- A collateral leg is either a bearer note (`owner` and `nk` both zero) or an owned note
  (`owner = note.owner`, `nk = note.secret`). Its membership path comes from
  `tacit.indexer.buildTree(leaves).rootAndPath(index)`.
- cUSD has 8 decimals. Collateral must stay above 150% of debt, and liquidation starts at 130%.
- **Persist the position record before you submit.** The position owner key, the debt blinding and the debt
  note's `nk` exist nowhere else. Losing them strands the position.
- To close, burn debt notes worth at least the position's debt (an excess is burned, not refunded), pass the
  position's index and path from `tacit.cdpPositionTree()`, and give a fresh blinding and `nk` per released
  leg (persist them first). The released collateral comes back as an owned note.

Verified on mainnet against the deployed pool: open
[`0x6da330c1…3229`](https://etherscan.io/tx/0x6da330c161f236030ef83ce5c9c77268c735a52e7f9789c7ebceaccb479b3229),
close
[`0x23851ea3…232e`](https://etherscan.io/tx/0x23851ea3ec4c0434940a1120505b0efe1878023e3d6faac9cea41ad14e44232e).

### Earn TAC: the launch farms

Proven on mainnet: bond an LP-share note into the FarmManager, harvest the reward as a wTAC note, unbond, and
redeem the reward to plain TAC. The full integrator chapter (cards, flows, monitoring, governance bounds) is
[`FARMS.md`](./FARMS.md); this is the smallest working loop.

| | |
|---|---|
| FarmManager | `0x000031C47Cb61faB1CE2790a69625FABB71EDE24` |
| Reward | wTAC `0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf` (1:1 ERC20 wrapper of TAC) |
| Pools | TAC/cETH 50, cETH/cUSD 30, cETH/cBTC 20 (weights; stake asset = the pair's LP-share id) |

```js
// 1. Read the program (dapp/confidential-farm-program.js; also GET /farm/program?network=mainnet)
const farm    = makeConfidentialFarmProgram({ rpc, config: tacit.cfg });   // or tacit.farmProgram()
const program = await farm.program();               // epoch (rate, periodFinish, treasury, outstanding) + pools[] (weight, totalShares)

// 2. Bond an LP note. The receipt IS the position; its owner key signs every later harvest and unbond.
const ownerPriv    = '0x' + hex(secp.utils.randomPrivateKey());     // fresh per position
const receiptOwner = '0x' + hex(secp.getPublicKey(ownerPriv.slice(2), true).subarray(1));
const nonce        = '0x' + hex(crypto.getRandomValues(new Uint8Array(32)));
await store.put({ controller, lpAsset, shares: note.value, receiptOwner, ownerPriv, nonce });   // BEFORE submit
await tacit.defiActions(walletPriv).bondFarm({ controller, nonce, lpAsset, legs: [leg(note)],   // leg(note): the {cx, cy, value, index, path, blinding, owner, nk} shape in FARMS.md
  spendRoot: note.root, receiptOwner });

// 3. Show pending, then harvest (see FARMS.md for the receipt witness); the reward lands as a wTAC note.
const pending = await farm.pending(receiptLeaf);    // { units, tac }: units is a decimal string in 1e-8 TAC

// 4. Unbond returns the LP note; harvest first, unharvested reward is forfeited. tacit.farmUnbond refuses
//    while more than 0.001 TAC is pending unless you pass forfeitPending: true.
// 5. Redeem: tacit.unwrap(wTAC note) -> WrappedTac.withdraw(amount, to) -> TAC ERC20.
```

Three things to get right:

- **The receipt key is the position.** A position is one LP note bonded whole, and only its receipt-owner key can
  harvest or unbond it. Persist it before you submit, and use a
  fresh key per position. A lost key strands the shares. The SDK's own path derives the key instead:
  `tacit.farmBond({ walletPriv, controller, lpNote })` (and `tacit.lpBond`) derive the receipt key from the wallet
  key and the note they spend, so `tacit.farmPositions({ walletPriv })` finds the position again from the chain and
  the key alone, and `tacit.farmHarvest` / `tacit.farmUnbond` sign with it.
- **Bond shares and harvest amounts are public** in the manager's events. Notes, receipts and payout destinations
  stay unlinked, until you unwrap to an address.
- **Harvest before you unbond, and claim close to `pending`.** A harvest re-stamps the position, so anything
  unclaimed in it is forfeited to the treasury surplus.

`tacit.lpBond` adds liquidity and bonds in one settle (enabled per pool by `farmControllers[poolId]`) and has been
driven live against this manager; call it with `selfRelay: true` (it carries no relay fee leg), as the Earn tab does.

**One key, many processes.** Every note sealed to a key shows up in that key's scan, including notes another
process created. Two scripts sharing a wallet key will pick each other's notes as inputs. Give each process its
own key, or keep an explicit leaf-ownership list and check a note's leaf and nullifier right before you submit.
Sign settles from a dedicated account, never from a key the relay or a keeper uses; two senders on one nonce
sequence make each other's transactions late or stuck.

## 6. Relay API

Base `https://api.tacit.finance`. Everything below is public; nothing needs a key.

| endpoint | |
|---|---|
| `POST /confidential/submit` | `{ type, op, memos, mode?, feeAsset? }` → `{ jobId }`. `mode: 'prove'` returns a proof for you to submit yourself; default `'settle'` has the relay submit it. |
| `GET /confidential/status?id=` | `pending` → `proving` → `settled` \| `failed`; a `mode: 'prove'` job ends at `proven` and carries the proof |
| `GET /confidential/quote?asset=cETH` | `{ ticker, assetId, relayFeeEligible, staticFloorUnits, gasAwareFloorUnits }` — floors are in the asset's **in-system units**, not wei. `asset` takes a ticker or a `0x` asset id. |
| `GET /confidential/index?from=&limit=` | the pool's event stream plus the stealth lock set, in chain order behind one cursor — recover a key's notes and locks without running a scanner |
| `GET /farm/program?network=mainnet`, `GET /farm/health` | the launch farms' emission schedule and a solvency verdict, read from the manager on chain |
| `GET /health` | liveness |

Submits are rate-limited per IP and the queue is bounded; a rejected submit is backpressure, not failure. Fee-less
relayed settles share a daily free budget (`429`, code `free_budget`) and prove-only jobs a daily prove budget (`429`,
code `prove_budget`); past either, attach a fee above the floor or prove and settle locally.

**Request bodies are capped** (`MAX_REQUEST_BYTES`, 32 MiB by default). Over that you get a `413` — on the
declared `Content-Length` before the body is read, or mid-stream for a chunked body. Every real op is far
below it; if you hit it, you are almost certainly sending something you did not mean to.

**What the relay sees.** It proves the op you hand it, so it receives that op's witness: for every spent note
its commitment, owner, leaf index, membership path and its per-note nullifier key `nk` (which lets it compute
that note's nullifier); the op's outputs (commitments, owners, range proof), public legs (recipient, value,
fee, deadline) and the authorization for them, which is an opening sigma or a transfer kernel; and the sealed
memos. It does not receive your wallet key, your seed or any note's blinding (the op builders return only the
sigma `(R, z)`).

**What the relay can do with it.** Spending a note takes `nk` and the note's blinding: the guest checks
`owner == keccak(nk ‖ dom)`, and a Schnorr proof of knowledge of the blinding over the op's context. That proof
commits to the exact recipient, value, fee and deadline (`OP_UNWRAP`), or to every input commitment, output
commitment and output leaf plus the fee (`OP_TRANSFER`'s kernel). So the relay can prove the op you
authorized, unchanged, and earn the fee you set on it; it cannot redirect an output, raise the fee or spend the
same note some other way, and it can decline to relay. Other ops bind their own sigma or kernel in the same way; this guide
traces `OP_TRANSFER` and `OP_UNWRAP` in detail.

**What the relay learns.** Your IP, which notes an op spends and creates and how they link (inputs to
outputs within one op), and the nullifier of each note it proves. For an `OP_SWAP` it also sees that swap's
amounts, because the guest computes the clearing and therefore must read them. It does not see notes an op does
not touch, and it is not given your wallet identity or balance. `selfRelay` does **not** change any of this —
the relay still proves, so it still sees the witness. If the link between an op's inputs and outputs, or a
trade size, matters to you, prove locally.

`OP_SWAP_BLIND` is the op that removes even that: clearing is proven by an in-guest Groth16 circuit, so the
box never reads an amount. It is **armed in the deployed guest and proven correct against it**, but not yet
reachable through the relay — enabling it is a batching and pricing exercise, since the pairing is a fixed
cost amortised across a batch's intents. See
[`ops/DESIGN-swap-batch-queue.md`](../ops/DESIGN-swap-batch-queue.md). Until then, relayed swaps are
`OP_SWAP` and the paragraph above is the honest description.

## 7. Iterating on the design

The template ships as one file with zero dependencies — the live pool and relay panels are plain `fetch`,
and the dapp-module imports are commented at the wiring point for when you need them. So you can throw its
look away entirely without touching its logic. Two conventions worth keeping:

- **Tokens on `:root`, nothing hardcoded.** The live dapp's palette is cream `#f4eee3`, ink `#171717`, orange
  `#ff9818`, monospace, dashed dividers. Swap the token values and the whole thing re-skins.
- **Keep the op builders and the renderer apart.** Every builder returns a plain `{ op, leaves, outputs,
  memos }`; the UI only ever renders that. It is what lets `tacit.js` be a thin renderer over the same
  modules, and it is why a redesign never risks the crypto.

## 8. When something breaks

| symptom | cause |
|---|---|
| `AmountNotAligned` | amount not divisible by `unitScale` |
| `DepositNotPending` | the wrap tx is not mined yet, or the deposit was already consumed |
| `UnknownRoot` | the `spendRoot` is not a root this pool has ever had: a witness built from another pool or network, from an incomplete log fetch, or from a block that was since reorged out — rescan |
| `NullifierAlreadySpent` | the note was already spent |
| `DepositExists` | this asset, amount and wrap index is already a deposit the pool holds; take the next index (`nextWrapIndex`) |
| `MemoLeafMismatch` | memo count or order does not match `pv.leaves` |
| settle says `failed` with a guest assert | the witness is malformed; the assert text names the field |
| relay rejects the submit | fee below the floor, or the queue is full |
| `413 request body exceeds …` | body over `MAX_REQUEST_BYTES` (32 MiB default) |
| farm `OverClaim` | harvest claimed more than the position's accrued reward; read `pending` at build time |
| farm `NoLivePosition` | the receipt is not bonded (wrong nonce, shares or owner, or already unbonded) |
| farm `WrongStakeAsset` | the note is not an LP-share asset the manager has a pool for |
| farm `Locked` | unbond before the pool's `unlockAt` (the launch pools have no lock) |

A failed proof costs the relay, not you, and moves no state. A settle either applies completely or reverts.

## 9. Further

- [`INTEGRATOR-PLAYBOOK.md`](./INTEGRATOR-PLAYBOOK.md) — what a trustless integration looks like: farm zap, key-only recovery, self-settle checklist
- [`docs/DEPLOYMENTS.md`](./DEPLOYMENTS.md) — every live address and vkey
- [`docs/FARMS.md`](./FARMS.md) — the TAC launch farms: cards, flows, monitoring and governance bounds
- [`ops/INTEGRATION-simple-wrap-send-claim-eth.md`](../ops/INTEGRATION-simple-wrap-send-claim-eth.md) — the
  full ETH-only handoff, with the stealth path in depth
- [`SPEC.md`](../SPEC.md) — canonical wire formats
- [`ops/DESIGN-swap-batch-queue.md`](../ops/DESIGN-swap-batch-queue.md) — how swap batching and
  `OP_SWAP_BLIND` reach production across the API, relayer and dapp
- [`audit/AUDITS.md`](../audit/AUDITS.md) — the review history
