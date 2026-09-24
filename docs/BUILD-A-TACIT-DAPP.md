# Build a Tacit dapp

The smallest dapp that works against the live confidential pool, and the shape to grow it in. Nothing here
needs a build step, a framework or a backend. A starting skeleton is
[`dapp-template/index.html`](./dapp-template/index.html): open it in a browser and it runs.

The protocol itself is in [`SPEC.md`](../SPEC.md); addresses are in [`DEPLOYMENTS.md`](./DEPLOYMENTS.md).

---

## 1. The model, in six lines

- Your balance is a set of **notes**. A note is `(asset, value, blinding, owner)`; only its Pedersen
  commitment `C = value·H + blinding·G` is public.
- The pool stores **leaves** — `keccak(assetId ‖ Cx ‖ Cy ‖ owner)` — in an append-only Merkle tree.
- Spending a note publishes a **nullifier**, never the leaf. Spend twice and the second settle reverts.
- Every spend is one **SP1 proof** against the pool's immutable `PROGRAM_VKEY`. The pool verifies it and
  applies the effects. The pool has no proxy, no upgrade path, no pause switch and no key that can move
  escrow, freeze an exit or redirect a payout. Its **lineage steward** (the ops multisig) can, once, deploy a
  successor (`createNextGen`), which closes this pool to new value while every exit stays open (see
  [Lineage](./DEPLOYMENTS.md#lineage)). `pool.successor()` reads zero while the pool is active.
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

## 2. Four things that surprise everyone

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

**Bitcoin value arrives two ways.** A bridge burn is re-minted as a note once, and a deployment-bound
Bitcoin note (`T_CXFER_BOUND`) can be spent directly in the fast lane
([SPEC §6.3](../SPEC.md#63-two-ways-bitcoin-value-reaches-ethereum)). Both wait on reflection. None of the
flows in this guide depend on either.

**A wrap is two steps.** `pool.wrap(...)` is a plain transaction that escrows funds and registers a *pending
deposit* — no proof. The deposit becomes a spendable note only when an `OP_WRAP` settle consumes it. The
first step works with nothing but an RPC; the second needs the relay.

## 3. What you are building against

Ethereum mainnet. The source of truth is
[`contracts/deployments/1-createx.json`](../contracts/deployments/1-createx.json); read addresses from it.

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

ETH is registered under its Bitcoin-side (tETH) link id, which keeps a bridged note and a wrapped note the
same confidential asset. cBTC's id is a protocol constant; cUSD's is `keccak("tacit-cdp-debt-v1" ‖ engine)`, so
it belongs to this engine ([SPEC §4.2](../SPEC.md#42-assets-and-units)).

Beyond this fixed set, `ConfidentialPool`'s asset registry is permissionless: anyone can register a new
ERC20 under its own id, and the checks are self-attested by the candidate token contract. Registration is
not a legitimacy or endorsement signal — resolve ids to token addresses only from the table above or from
[`contracts/deployments/1-createx.json`](../contracts/deployments/1-createx.json), and if you build an
asset picker or indexer over `registeredExternalPoolAssets` (`confidential-deployments.js`), do not present
a registered asset as vetted by Tacit.

## 4. Reuse the dapp modules — do not reimplement the crypto

`dapp/` is a set of plain ES modules with no build step and no framework. Import them directly.

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

Keep the recovery guard on: `assertOutputsRecoverable` refuses an op whose outputs nobody could ever spend.

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

To pay a plain 0x address an exact amount out of a larger note, with the rest kept as hidden change, use `tacit.sendUnwrap`; the pattern, fees and privacy limits are in [`PRIVATE-PAYOUT.md`](./PRIVATE-PAYOUT.md).

**Paying someone else, and what the receiver needs.**
- **Address.** `recipientPubHex` is the receiver's static spend pubkey, the confidential account's public key. A 0x address does not work:
  it is a hash of a pubkey, so a sender cannot derive the pubkey from it, and the pool has no registry from a 0x address to a pubkey.
  The receiver's `tacit1…` address carries the key, and a name can stand in for that address (next item).
- **Names.** A receiver can publish their `tacit1…` address as the `finance.tacit` text record of a `.wei`, `.gwei` or `.eth` name
  (`.base.eth` is not read), and the send tab accepts the name in the recipient field. `dapp/confidential-names.js`
  (`makeConfidentialNames({ call, send, secp, keccak256 })`) is the same code for your own dapp:
  `resolveName(name)` returns `{ name, address, key, source, node }`, where `key` is the Ethereum-side key to pass as `recipientPubHex`;
  `primaryName(address)`, `planPublish` and `publish` cover the receiver's side. Behaviour to keep:
  - Lookups read Ethereum mainnet only, whatever network the page is on, and are never cached; look the name up at send time and pin the key for that send.
  - The record must decode strictly: bech32m prefix `tacit`, a 101-byte payload (`[0x00][flags][spend][scan][Ethereum-side key]`, 33 bytes each after the two header bytes), the Ethereum-side flag (`0x02`) set, and a valid secp256k1 point in the last 33 bytes. Otherwise the send is refused with the reason.
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
relay prove while **you** submit and pay gas. The relay still receives the witness; what you avoid is the fee
and the relay's address on the transaction. To keep the witness to yourself, prove the op yourself with its
harness in [`contracts/sp1/confidential/harnesses/`](../contracts/sp1/confidential/harnesses/)
(`exec-<op>.rs`; `MODE=groth16` requests the Groth16 proof from the SP1 prover network and writes
`public_values.hex` and `proof_bytes.hex`), then call `tacit.submitSettle`. See the
[trustless checklist](./INTEGRATOR-PLAYBOOK.md#4-trustless-checklist).

Each of these returns once the settle lands; pass `waitOpts` to tune the polling. A `selfRelay` settle is sent
from the wallet's derived account (`account(walletPriv)`), which must hold ETH for gas; `tacit.submitSettle` is
the same step for a proof you fetched yourself with `mode: 'prove'`.

Two checks worth keeping. After a relayed settle the client compares the memos the pool emitted with the ones
it sealed (`verifyEmittedMemos`) and throws, keeping the sealed memos locally, if they differ. And `unwrap` with
`wait: true` can report `settled` from the relay's acknowledgement or from the note leaving the wallet scan, so
confirm an exit by the recipient's balance (or the settle receipt) rather than by that status alone.

Which ops need a fee: an op that carries a fee leg (`transfer`, `unwrap`, LP ops, routes) must offer at least
the floor from `GET /confidential/quote`, or the relay refuses it at submit. The static cUSD floor is
30,000,000 units. Ops with no fee (`wrap`, `cbtcmint`, `bridgemint`, `farmbond`, adaptor and stealth locks,
`cdptopup`) relay for free within a daily budget. Pool founding cannot be relayed: it needs
`createPairAndSettle`, so use `selfRelay: true`.

### Bitcoin-backed cBTC and CDPs

Lock real BTC, mint a cBTC note, borrow cUSD against it, repay, and release the BTC. The mechanism is
[SPEC §5.7](../SPEC.md#57-cdp-cusd-and-cbtc).

**Lock → escrow → mint.**

1. Lock BTC in a self-custody output: a Bitcoin transaction whose output 1 carries the lock envelope
   (`dapp/cbtc-lock.js`). Keep the funding input explicit; the dapp's sats helpers pick the largest plain coin.
2. Post the wstETH escrow that backs it: `CbtcEscrowHelper.postEscrowWithETH(outpoint)` (about 320k gas). The
   outpoint key is `outpointKey(reverse(txid), vout)`, and the escrow must cover the lock's value.
3. Wait for reflection to fold the lock block. Reflection folds a block only once it is 24 blocks behind the
   header relay's tip, so allow several hours. `GET /reflection/status` shows `attestedHeight`; the mint works
   once `pool.cbtcLockVBtc(outpoint)` reads the locked amount.
4. Mint: `await tacit.mintCbtc({ walletPriv, outpoint, vBtc, blinding })`. It is fee-less and relayed. The
   note is a **bearer** note (owner 0): whoever holds its blinding can spend it, and the blinding is derived
   from your key plus the lock's funding anchor. A lock can be minted once. A second mint reverts
   `CbtcLockMismatch` (`0xafff2f20`).

**Open and close a CDP** (`tacit.defiActions(walletPriv).openCdp / closeCdp`):

- `rateSnapshot` must lie in `[RAY, rate()]`; pass the engine's live `rate()`. While the stability fee is
  dormant that is `1e27` (`0x33b2e3c9fd0803ce8000000`). Anything outside the range, zero included, reverts
  `BadSnapshot` (`0x610f890f`).
- A collateral leg is either a bearer note (`owner` and `nk` both zero) or an owned note
  (`owner = note.owner`, `nk = note.secret`). Its membership path comes from
  `tacit.indexer.buildTree(leaves).rootAndPath(index)`.
- cUSD has 8 decimals. Collateral must stay above 150% of debt, and liquidation starts at 130%.
- **Persist the position record before you submit.** The position owner key, the debt blinding and the debt
  note's `nk` exist nowhere else. Losing them strands the position.
- To close, burn debt notes worth at least the position's debt (an excess is burned, not refunded), pass the
  position's index and path from `tacit.cdpPositionTree()`, and give a fresh blinding and `nk` per released
  leg (persist them first). The released collateral comes back as an owned note.

Proven on mainnet: open
[`0x6da330c1…3229`](https://etherscan.io/tx/0x6da330c161f236030ef83ce5c9c77268c735a52e7f9789c7ebceaccb479b3229),
close
[`0x23851ea3…232e`](https://etherscan.io/tx/0x23851ea3ec4c0434940a1120505b0efe1878023e3d6faac9cea41ad14e44232e).

### Earn TAC: the launch farms

Bond an LP-share note into the FarmManager, harvest the reward as a wTAC note, unbond, and redeem the reward
to plain TAC. The full chapter (cards, flows, monitoring, governance bounds) is [`FARMS.md`](./FARMS.md); this
is the smallest working loop.

| | |
|---|---|
| FarmManager | `0x000031C47Cb61faB1CE2790a69625FABB71EDE24` |
| Reward | wTAC `0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf` (1:1 ERC20 wrapper of TAC) |
| Pools | TAC/cETH 50, cETH/cUSD 30, cETH/cBTC 20 (weights; stake asset = the pair's LP-share id) |

```js
// 1. Read the program (dapp/confidential-farm-program.js; also GET /farm/program?network=mainnet)
const farm    = tacit.farmProgram();   // wraps makeConfidentialFarmProgram with the pool+farm config merged
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

`tacit.lpBond` adds liquidity and bonds in one settle (enabled per pool by `farmControllers[poolId]`). It carries
no relay fee leg, so call it with `selfRelay: true`, as the Earn tab does.

**One key, many processes.** Every note sealed to a key shows up in that key's scan, including notes another
process created. Two scripts sharing a wallet key will pick each other's notes as inputs. Give each process its
own key, or keep an explicit leaf-ownership list and check a note's leaf and nullifier right before you submit.
Sign settles from a dedicated account, never from a key the relay or a keeper uses; two senders on one nonce
sequence make each other's transactions late or stuck.

## 5a. TAC airdrop

A one-shot merkle distributor on Ethereum mainnet that holds 1,000,000 TAC and pays 8,652 recipients 999,999 TAC
between them, one leaf each. A recipient claims public TAC, sends it to another address, or shields it into the confidential
pool in the same transaction. Roles, the guardian's powers and the runbook are in [`AIRDROP.md`](./AIRDROP.md); this chapter is how a dapp shows an
allocation and claims it.

| | |
|---|---|
| `TacAirdrop` | `0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8` (Etherscan-verified) |
| Token | the public TAC ERC20 `0xA1313eb9f3A445606D9583bcAc3ebeB56a858279`, 18 decimals |
| Merkle root | `0x27451b320d5aa9631f7a3fd8adcfa537db8d792dd49aad9ab0951af0c2986a10` |
| Claim deadline | `1797803449` (2026-12-20 21:50:49 UTC): the last second a claim is accepted |
| Client | [`dapp/tac-airdrop.js`](../dapp/tac-airdrop.js); `tacit.tacAirdrop` on the pool ux (`tacit.airdrop` is the stealth airdrop, a different feature) |

**Proof files.** One JSON file per leading address byte: `<xx>.json`, `xx` being the first byte of the lowercase address without `0x`. It holds
`{ root, claims: { <lowercase address>: { index, amount, proof } } }`, with `amount` in wei as a decimal string and `proof` a list of bytes32.
`manifest.json` sits beside them. Every entry is checked against the root, not against the host it came from, so any copy is as good as another.

| Host | URL | For |
|---|---|---|
| the dapp's origin | `/airdrop/v1/proofs/<xx>.json` (`https://tacit.finance/airdrop/v1/proofs/<xx>.json`) | the tacit.finance dapp. It sends no CORS header, so a page on another origin cannot read it |
| jsDelivr, pinned to a commit | `https://cdn.jsdelivr.net/gh/z0r0z/tacit@1b2eedde8490801c9ef4406020530059162e6d47/dapp/airdrop/v1/proofs/<xx>.json` | any page: CORS-enabled and immutable |
| GitHub raw, same commit | `https://raw.githubusercontent.com/z0r0z/tacit/1b2eedde8490801c9ef4406020530059162e6d47/dapp/airdrop/v1/proofs/<xx>.json` | fallback for the same files, CORS-enabled |

The files are public and about 8.7 MB in all (18 to 64 KB each), so you can also serve your own copy from the same paths. A lookup tells the file's host one byte of the
address; the `eth_call` that follows carries the whole address to your RPC.

### Show "you can claim X TAC" without any Tacit code

One `GET`, one keccak and one `eth_call`. This runs as is as an ES module in Node 20 (keccak from any library, here `@noble/hashes`; in a page, import it from wherever you bundle it):

```js
import { keccak_256 } from '@noble/hashes/sha3';

const AIRDROP = '0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8';
const ROOT    = '0x27451b320d5aa9631f7a3fd8adcfa537db8d792dd49aad9ab0951af0c2986a10';
const PROOFS  = 'https://cdn.jsdelivr.net/gh/z0r0z/tacit@1b2eedde8490801c9ef4406020530059162e6d47/dapp/airdrop/v1/proofs';
const RPC     = 'https://ethereum-rpc.publicnode.com';

const hex   = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const bytes = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g) || [], (x) => parseInt(x, 16));
const word  = (n) => BigInt(n).toString(16).padStart(64, '0');
const cat   = (a, b) => Uint8Array.from([...a, ...b]);

// leaf = keccak(keccak(abi.encode(index, account, amount))); every node = keccak of its two children, smaller first
function recompute(index, account, amount, proof) {
  let h = keccak_256(keccak_256(bytes(word(index) + word(BigInt(account)) + word(amount))));
  for (const p of proof) {
    const s = bytes(p);
    h = keccak_256(hex(h) <= hex(s) ? cat(h, s) : cat(s, h));
  }
  return '0x' + hex(h);
}

const ethCall = async (to, data) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};

const tac = (wei) => {                                            // wei -> decimal string, exactly
  const s = BigInt(wei).toString().padStart(19, '0');
  return `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, '');
};

async function claimable(address) {
  const account = address.toLowerCase();
  const res = await fetch(`${PROOFS}/${account.slice(2, 4)}.json`);
  if (!res.ok) throw new Error(`proof file: HTTP ${res.status}`); // all 256 files exist: a 404 is a broken host, not "not in the airdrop"
  const e = (await res.json()).claims[account];                   // { index, amount, proof }
  if (!e) return null;                                            // not in the airdrop
  if (recompute(e.index, account, e.amount, e.proof) !== ROOT) throw new Error('the proof does not match the airdrop root');
  const claimed = BigInt(await ethCall(AIRDROP, '0x9e34070f' + word(e.index))) !== 0n;   // isClaimed(uint256)
  return { index: e.index, wei: e.amount, tac: tac(e.amount), claimed };
}

await claimable('0x1C0Aa8cCD568d90d61659F060D1bFb1e6f855A20');
// { index: 978, wei: '216176408192580000000000', tac: '216176.40819258', claimed: false }
```

The wire facts behind it, for any language:

| | |
|---|---|
| Leaf | `keccak256(keccak256(abi.encode(index, account, amount)))`: three 32-byte words (`index`, `account` left-padded, `amount`), hashed twice |
| Node | `keccak256(a ‖ b)` with the two 32-byte children in ascending order as big-endian numbers |
| Claimed? | `isClaimed(uint256)` `0x9e34070f` ‖ index word, returns a bool word |
| Paused? | `paused()` `0x5c975abb` |
| Open? | the latest block's timestamp is `<= 1797803449`; `CLAIM_DEADLINE()` is `0x42f81580` |
| Funded? | TAC `balanceOf(address)` `0x70a08231` of the airdrop is at least `amount` |
| Contract-side check | `verify(uint256,address,uint256,bytes32[])` `0x6cc1a533` returns whether the contract accepts the proof (a view; says nothing about claimed) |
| `claim` | `0x2e7ba6ef` ‖ `index` ‖ `account` ‖ `amount` ‖ `0x80` ‖ `proof.length` ‖ `proof…`. Anyone may send it; the TAC goes to `account` |
| `claimTo` | `0x4f54d47c` ‖ `index` ‖ `amount` ‖ `0x80` ‖ `to` ‖ `proof.length` ‖ `proof…`. The sender must be the recipient; `to` may not be zero, the airdrop, the TAC token or the pool |
| `claimAndShield` | `0xad8b9781` ‖ `index` ‖ `amount` ‖ `0x80` ‖ `commit` ‖ `proof.length` ‖ `proof…`. The sender must be the recipient; `amount` must be a multiple of `1e10` |
| Claimed event | `Claimed(uint256 indexed index, address indexed account, uint256 amount)`, topic0 `0x4ec90e965519d92681267467f775ada5bd214aa92c0dc93d90a5e880ce9ed026` |
| Errors | `Paused` `0x9e87fac8`, `ClaimWindowClosed` `0xf0f25a33`, `AlreadyClaimed` `0x646cf558`, `BadProof` `0x7ca55c77`, `BadRecipient` `0x67a2cc26`, `AmountNotAligned` `0x9c63840c`, `ZeroCommit` `0x09bf2e90` |

### With the module

`makeTacAirdrop` does the lookup, the local proof check, one batched state read (Multicall3, or one call per value where it is missing), the
calldata, and simulate-then-send for the claims. It has no dependencies of its own: give it a keccak-256 and an `eth_call`.

```js
import { keccak_256 } from '@noble/hashes/sha3';
import { makeTacAirdrop, makeRpcCall, PUBLIC_PROOF_HOSTS } from './dapp/tac-airdrop.js';

const air = makeTacAirdrop({
  call: makeRpcCall({ rpcs: ['https://ethereum-rpc.publicnode.com', 'https://1rpc.io/eth'] }),   // or any ({ to, data, from? }) => eth_call result that throws on a revert
  keccak256: keccak_256,
  proofsBase: PUBLIC_PROOF_HOSTS,      // a string or an ordered list; the default is the dapp's own '/airdrop/v1/proofs'
});
// in the dapp: const air = tacit.tacAirdrop   (from makeConfidentialPoolUx; same-origin proofs, its own RPC list)

const s = await air.status(address);   // never throws
```

`status` returns the allocation and the contract's state (`amountWei` is a decimal string, so the object survives `JSON.stringify`):

| field | |
|---|---|
| `eligible` | the airdrop lists this address, and its proof recomputed to the root and was accepted by the contract's own `verify` |
| `index`, `amountWei`, `amountTac` | the leaf; `amountTac` is the exact decimal, e.g. `'216176.40819258'` |
| `claimed`, `paused`, `open`, `funded` | `isClaimed`, `paused()`, the chain's clock is not past the deadline, the airdrop holds at least `amountWei` |
| `canShield` | `amountWei` is a multiple of `1e10`, so `claimAndShield` will not revert |
| `deadline`, `claimByISO`, `secondsLeft` | unix seconds, ISO 8601, and the time left by the chain's clock |
| `claimable`, `reason`, `message` | `claimable` is true when a claim can go through. `reason` is `null` or the first that applies of `not-deployed`, `not-listed`, `error`, `claimed`, `paused`, `closed`, `unfunded`; `message` is a sentence for it |
| `error` | `{ code, message }` when the read failed (`bad-address`, `shard-fetch`, `rpc`, `bad-response`, `chain-rejects-proof`). Show a retry, never "not eligible" |
| `proof` | the verified bytes32 path |

Claim it. `send` is yours: it takes `{ from?, to, data, value }` and returns the transaction hash. Each helper reads the status first, refuses a claim that cannot go
through, simulates it with `eth_call`, and only then calls `send`:

```js
const me = (await provider.request({ method: 'eth_requestAccounts' }))[0];
const send = ({ from, to, data, value }) => provider.request({ method: 'eth_sendTransaction', params: [{ from: from || me, to, data, value }] });

const r = await air.claim(s.address, { send });                        // public TAC to the recipient; anyone may send this
// or: await air.claimTo(s.address, '0x…', { send });                   // to another address; the wallet must be the recipient's account
await air.waitClaimed(s.address);                                       // polls isClaimed: { claimed: true } or { claimed: false, timedOut: true }
```

The results are `{ txHash, tx, index, amountWei }`. A helper that refuses throws an `AirdropError` whose `code` is the `reason` (`claimed`, `paused`, `closed`, `unfunded`,
`not-listed`, `not-deployed`), one of the read errors above, or one of `bad-address`, `bad-recipient`, `bad-proof`, `simulation-failed` (the contract would revert; `data` holds the revert data),
`no-sender`, `rpc`. The `build*` variants return `{ from?, to, data, value: '0x0' }`
and send nothing: `buildClaim(address)`, `buildClaimTo(address, to)`, `buildClaimAndShield(address, commit)`. `entryFor(address)` returns the verified
`{ account, index, amountWei, proof }`, and `formatTac(wei)` the exact decimal string. On any network without the airdrop (Sepolia, for one) `status` returns
`reason: 'not-deployed'` and reads nothing.

### Shield it (unproven)

`claimAndShield` deposits the whole allocation into the confidential pool as a wrap deposit under a `commit`, and the note is made later by settling that deposit with a proof.
That settle has not been run on mainnet for this contract, so offer `claim` and `claimTo` first; `shieldPlan` refuses unless you pass `allowUnproven: true`.

```js
const plan = await tacit.tacAirdrop.shieldPlan({ walletPriv, address: s.address, allowUnproven: true });
localStorage.setItem('tac-shield', JSON.stringify(plan.record));                       // no secret in it; persist before sending
await tacit.tacAirdrop.claimAndShield(plan, { send });                                  // sent from the recipient's account
// once the transaction is mined:
await tacit.tacAirdrop.settleShield({ walletPriv, record: plan.record });              // checks the deposit is pending on the pool, then submitWrapSettle
```

- **The commit must come from `shieldPlan`.** It is `buildWrap` for the recipient's own wallet key at the next unused wrap index (`nextWrapIndex`). A commit built any other way deposits the TAC
  where no key can spend it, and the pool has no cancel or refund for a pending deposit. Never write one by hand.
- **Keep `plan.record`, never `plan.built`.** `record` re-derives everything from the wallet key. `built` holds the note's secrets: keep it in memory only. Losing the wallet key loses the note.
- **Two keys.** The transaction is sent by the recipient's account (any wallet); the note belongs to the Tacit wallet key, which can be a different one.
- **It can lose a race.** Anyone may `claim` for the recipient at any time. If that lands first, `claimAndShield` refuses (`claimed`) and the recipient already holds plain TAC at their own address; they can wrap it themselves.
- **Only while the dapp's pool is the airdrop's pool.** The airdrop deposits into the pool it was deployed with. `shieldPlan` and `settleShield` refuse (`pool-mismatch`) if the ux is configured for another pool.
- **Dust cannot be shielded.** An amount that is not a multiple of `1e10` wei (`canShield: false`) can still be claimed.
- **Refusals** carry a `code`: `shield-unproven`, `no-ux`, `pool-mismatch`, `asset-mismatch`, `not-aligned`, `bad-commit`, `zero-commit`, `bad-plan`, `bad-record`,
  `wrong-key` (this wallet key does not derive the recorded commit) and `deposit-not-found` (the deposit is not pending on the pool yet; a deposit already consumed returns `{ alreadySettled: true }`).

### Cases to handle

| Case | What you see | Show |
|---|---|---|
| Not in the airdrop | `reason: 'not-listed'` | "This address has no allocation." |
| Already claimed | `claimed: true`, `reason: 'claimed'` | "Claimed." If the user did not do it, someone sent `claim` for them and the TAC is at their own address; if they did, it went to `to` (`claimTo`) or into the pool (`claimAndShield`). The transaction that emitted the `Claimed` event says which |
| Paused | `paused: true` | "Claims are paused." The guardian can pause; try again later |
| Closed | `open: false` | "The claim window closed on `claimByISO`." Nothing can be claimed from the next second |
| Unfunded | `funded: false` | The airdrop holds less than the allocation (the guardian swept it, or funding is short); a claim would revert. Do not offer it |
| Front-run | `claim` or `claimAndShield` refuses with `claimed`, or the wallet's transaction reverts `AlreadyClaimed` | The user has the TAC already. Show their balance |
| A tiny allocation | `amountWei` close to `1e10` | A claim costs the same gas whatever it pays. The smallest allocation is 0.00000001 TAC, 1,097 of the 8,652 are under 0.01 TAC and 4,089 under 1 TAC, so for the smallest ones the gas can exceed the value. Tell the user; a sponsor should set a minimum |
| Could not read | `error` | Retry; try another proof host or RPC. Never show "not eligible" for an `error`. A host that answers 404 for a proof file is not saying the address is unlisted (all 256 files exist), so that is an `error` too |
| Wrong network | `reason: 'not-deployed'`, or `error.code: 'bad-response'` | The airdrop is on Ethereum mainnet only |

- **Gas.** `eth_estimateGas` against the live contract for the largest allocation (13 proof words), where the claim is the first in its 256-index bitmap word and pays the 20k storage set:
  `claim` and `claimTo` about 91k, `claimAndShield` about 112k. Later claims in the same word cost about 17k less. Every claim costs about the same whatever its amount.
- **Deadline.** `CLAIM_DEADLINE` is the last second at which a claim is accepted; from the next second every path reverts. Show `claimByISO` and `secondsLeft`, and prompt well before it: a transaction still pending at the deadline reverts.
- **Confirm from the chain.** A claim has landed when `isClaimed(index)` reads true (`waitClaimed` polls it) and the `Claimed` event is in the transaction's receipt or `eth_getLogs` (`address` the airdrop, `topics: [topic0, '0x' + indexWord]`).
  A wallet's "sent" and a relay's "settled" are not that.
- **Check a proof yourself.** `node tools/airdrop-verify.mjs --contract 0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8 --address 0x… --proofs https://tacit.finance/airdrop/v1/proofs` recomputes the proof
  locally, asks the contract to verify it, and reports whether it is claimable. It sends nothing. `--proofs` also takes a directory (`dapp/airdrop/v1/proofs`) or any host in the table above.

## 5b. Trading: swap, route and liquidity

The AMM is [SPEC §5.5](../SPEC.md#55-amm); the op table (`OP_SWAP`, `OP_LP_ADD`, `OP_LP_REMOVE`,
`OP_SWAP_ROUTE`, `OP_WRAP_LP`, `OP_WRAP_SWAP`) is [SPEC §5.3](../SPEC.md#53-op-table). A pool is identified
by `(assetA, assetB, feeBps)` with `assetA < assetB` as a `BigInt` comparison — every function below
canonicalizes the order itself, so pass either side first.

**Read reserves and quote before you build anything:**

```js
const poolId = tacit.routePoolId(assetA, assetB, feeBps);
const res    = await tacit.poolReserves(poolId);   // null if the pool has never been founded
// { init: true, assetA, assetB, reserveA, reserveB, feeBps, totalShares } — reserveA is the LOW asset's reserve
```

`quoteRoute` and `quoteLpAdd` size a trade or a deposit against those live reserves before you spend
anything:

```js
const q = await tacit.quoteRoute({ asset0: assetA, amountIn, path: [{ assetNext: assetB, feeBps }] });
// { amountOut, assetFinal, hops } — null if a hop's pool is uninitialized
```

**Swap.** There is one swap op, `route()`, walked over a `path` of one or more hops — a single-hop path
is a plain swap. This is what the dapp's own swap tab calls:

```js
const r = await tacit.route({
  walletPriv, inNote, amountIn, path: [{ assetNext: assetB, feeBps }], minOut, selfRelay: false,
});
```

`inNote` must be spent whole: `route`'s change path is not implemented yet, so a partial amount
throws (`partial-spend change is not yet implemented`) rather than returning change. Pre-split the note
with `transfer` first if you need to route less than its full value. A route composes up to four hops in
one settle (`MAX_ROUTE_HOPS = 4`), and its relay type is `'route'`.

**Swap straight from a deposit.** `wrapSwap` skips the note entirely — it consumes a *pending* deposit
(same two-step wrap you already know) and mints the swapped output directly:

```js
await tacit.wrapSwap({ walletPriv, fromTicker: 'cETH', toTicker: 'cUSD', amountWei, feeBps, minOut, fee });
```

There is no membership proof to build (the deposit's value is already public and exact), so `fee` and
`minOut` are the only things worth sizing carefully. `amountWei`/`index` must match whatever the deposit
was actually wrapped with — this recomputes the deposit id, it does not read the deposit back from chain.
Fee-switch pools (a nonzero protocol fee) are not supported here; use `route` against a no-skim pool
instead.

**Add and remove liquidity.**

```js
const quote = await tacit.quoteLpAdd({ assetA, assetB, feeBps, amountA });   // { addA, amountB, fee, init }
await tacit.lpAdd({ walletPriv, aNote, bNote, feeBps, fee: quote.fee });
// or straight from two deposits, no note needed:
await tacit.wrapLp({ walletPriv, aTicker, bTicker, aAmountWei, bAmountWei, feeBps, fee });
// exit:
await tacit.lpRemove({ walletPriv, assetA, assetB, feeBps, shareNote, fee: null });   // null auto-quotes
```

- **Founding a pool** (the first add) needs `selfRelay: true` — the ordinary relay path has no
  `createPairAndSettle` handling, so a relayed first add reverts `PoolNotInit`. Anyone can found a pool;
  there is no permission gate. The first add locks `MINIMUM_LIQUIDITY = 1000` shares forever (SPEC §5.3)
  and must mint more than that or it reverts; `lpRemove` enforces the same floor on the way out, so a
  pool can never be fully drained.
- **Match the ratio.** After the first add, contributing off the pool's current price donates to existing
  LPs; `assertLpInRatio` refuses a contribution beyond a 0.5% donation. `quoteLpAdd`'s `amountB` is already
  rounded to match — use it rather than computing your own.
- **`lpRemove` burns the whole share note.** A partial withdrawal needs the share note split first; there
  is no change-share output for a partial burn. The share note needs its membership witness (`.path`,
  `.root`) — rescan before removing.
- **Size notes to the quote with `ensureExactNote`** rather than rounding by hand: it finds (or splits, via
  a relayed self-send) a note of exactly the amount `quoteLpAdd` asked for.

**Prover-blind batch swaps.** `swapBatched(intent)` queues an intent into `OP_SWAP` and settles it against
others at one uniform clearing price once enough intents arrive (or a short timeout passes) — hiding an
individual trade's size inside the batch. It is real, tested code (`swapBatched`, `swapBatchPending`,
`swapBatchFlush`), available to call, but the dapp's own swap tab does not use it yet; `route` is what
ships today.

## 5c. OTC: a direct two-party trade

`OP_OTC` ([SPEC §5.3](../SPEC.md#53-op-table)) settles a fixed, agreed trade between two parties in one
proof — no pool, no slippage. `dapp/confidential-otc.js` is the real assembler; `dapp/confidential-otc-tab.js`
drives it as a three-message handshake, with no coordinator:

```js
// 1. Maker proposes, from their own note
const maker = otc.buildLeg({ owner: n.owner, nk: n.secret, inAmount: n.value, inR: n.blinding,
                             inLeafIndex: n.leafIndex, inPath: n.path, give: vA, recvValue: vB, recvR, changeR });
const offer = { assetA: n.asset, assetB, vA, vB, chainBinding, spendRoot: n.root, deadline: 0, maker: publicLeg(maker) };
// publicLeg always strips _r (the note blinding — a discrete-log secret, never share it, signed or not).
// It also strips nk UNLESS the leg is already signed: an unsigned leg's nk protects nothing (there is no
// spend to authorize yet) but nobody else needs it either, so it stays local. The real tab persists this
// `maker` object (with its secret _r/nk) between steps 1 and 3 — e.g. localStorage — since a maker's own
// browser is what finalizes in step 3, not a value that survives as a JS variable alone.

// 2. Taker countersigns, from their own note
const taker = otc.buildLeg({ owner: n.owner, nk: n.secret, inAmount: n.value, inR: n.blinding,
                             inLeafIndex: n.leafIndex, inPath: n.path, give: vB, recvValue: vA, recvR, changeR });
const ctx = otc.composeCtx({ assetA: offer.assetA, assetB: offer.assetB, chainBinding: offer.chainBinding,
                             vA, vB, maker: hydrateLeg(offer.maker), taker, deadline: offer.deadline });
otc.signLegs(taker, ctx, 'taker');
const countersign = { ...offer, taker: publicLeg(taker) }; // taker is now SIGNED, so publicLeg keeps its nk

// 3. Maker finalizes and submits — the taker's nk rode in on step 2, no separate channel needed
const ctx2 = otc.composeCtx({ ...countersign, maker, taker: hydrateLeg(countersign.taker) });
otc.signLegs(maker, ctx2, 'maker');
const assembled = otc.assembleOtc({ ...countersign, maker, taker: hydrateLeg(countersign.taker) });
const result = otc.verifyOtc(assembled, { merkleRootFrom: tacit.pool.merkleRootFrom });   // same checks the guest re-runs
await tacit.relay.settle({ type: 'otc', op: otc.toWireOp(assembled), leaves: result.leaves, outputs: [], ephRand: () => 1n });
```

(`publicLeg`/`hydrateLeg` are the two small helpers at the top of `confidential-otc-tab.js` — strip/restore
`amount`'s BigInt-vs-string shape and the secret fields on the way in and out of a shared message.) Each
side may carve its own relay fee out of what it receives (`feeA`/`feeB`), fixed once both legs sign.

**Finalizing genuinely works between two independent strangers — no matcher, no side channel.** The taker's
`nk` rides directly in step 2's countersignature; a signed leg's `nk` cannot forge an opening for any other
context (`cxfer-core::verify_opening_sigma` is a standard, unforgeable Schnorr check over the discrete log
of the note's blinding `r`, which `nk` plays no part in), so there is nothing left for withholding it to
protect once the leg is signed, and the finalizer needs it to complete this exact trade. `_r` is the one
field that must never appear in a shared message, signed or not — `publicLeg` never includes it.

## 5d. Buyer-offline bids

`OP_BID` ([SPEC §5.3](../SPEC.md#53-op-table)) lets a buyer pre-fund an order and go offline: `buildBid`
locks `maxFill · price` of the quote asset against a grid (`minFill`, `maxFill`, `increment`), and any
seller can fill part or all of it later with `fillBid`, no buyer action required at fill time.
`dapp/confidential-bid.js` has both sides, with no shipped UI tab; import it directly as in
[§4](#4-reuse-the-dapp-modules--do-not-reimplement-the-crypto):

```js
import { makeConfidentialBid } from './dapp/confidential-bid.js';
const bid = makeConfidentialBid({ keccak256, pool: tacit.pool });

// buyer, once, then offline
const built = bid.buildBid({ assetA, assetB, minFill, maxFill, price, increment, chainBinding, spendRoot,
                             buyerOwner, nk, fundRSecp, fundLeafIndex, fundPath, bidSecret });

// any seller, any time before the buyer cancels — fillBid takes the built bid first, fill options second
const filled = bid.fillBid(built, { chosenF, sellerOwner, sellerNk, sellerInAmount, sellerInRSecp, sellerInLeafIndex, sellerInPath, nonces, fee });
const result = bid.verifyBid(filled, { merkleRootFrom: tacit.pool.merkleRootFrom });
// one { seedDerived: true } descriptor per emitted leaf — a bid's outputs recover from bidSecret, not a sealed memo
await tacit.relay.settle({ type: 'bid', op: bid.toWireOp(filled), leaves: result.leaves, outputs: result.leaves.map(() => ({ seedDerived: true })), ephRand: () => 1n });
```

`bidSecret` is a dedicated 32-byte secret (not the wallet seed) that derives every per-fill output
blinding; keep it, or re-derive it from the seed and the funding note's commitment
(`tacit.pool.deriveBidSecret(seed, fund.cx, fund.cy)`). A partial fill mints the buyer a refund note for
the unfilled remainder in the same settle; a full fill mints none.

**Hand the bid to a seller yourself — there is no on-chain listing or discovery for it.** The dapp gives
you the cryptography to build, fill and verify a bid; publishing one so a seller can find it is the same
off-band exchange an OTC offer needs. **Recovering a filled bid's outputs also needs its own path**: the
seller never learns the buyer's output blindings, so the ordinary memo scan can't find them —
`recoverBidOutputs({ seed, bid, leafSet })` walks the grid and matches leaves directly. A multi-fill
resting order is the same primitive repeated (`buildRestingBid` / `fillRestingLot` /
`recoverRestingBidOutputs`), cancellable by spending its current head note.

## 5e. Adaptor swaps

`OP_ADAPTOR_LOCK` / `_CLAIM` / `_REFUND` ([SPEC §5.3](../SPEC.md#53-op-table)) lock a note under a
Schnorr adaptor point `T`, so claiming it reveals the discrete log the other leg of a cross-chain swap
needs — the mechanism behind cBTC redemption. `dapp/adaptor-signature.js` has the presign, complete and
extract primitives for both an EVM-side kernel adaptor and a Bitcoin-side BIP-340 adaptor, and
`dapp/adaptor-swap.js` sequences a full two-leg swap on top of them — role assignment, the
initiator-claims-first ordering, and the `farDeadline > nearDeadline` timeout safety margin that keeps the
second claimant from getting stuck holding an unclaimed leg. `dapp/cbtc-redemption.js` and
`dapp/cross-chain-orderbook.js` build cBTC's redemption market on that same state machine.

**None of these assemble the actual on-chain op.** Every one of them takes leg construction as an
injected `(dPriv, msg32, nonce)` (Bitcoin lane) or `(excess, inC, outC, nonce)` (EVM lane) and returns a
signature or kernel response — real, tested cryptography, but not a witness with the concrete
`spendRoot`/note commitments/leaves a settle needs. That builder, for either chain, does not exist yet in
`dapp/`. If you need it: `contracts/sp1/confidential/harnesses/exec-adaptorlock.rs` /
`exec-adaptorclaim.rs` / `exec-adaptorrefund.rs` give the exact stdin field order the guest reads — for a
lock, `asset ‖ locker ‖ recipient ‖ refundPub ‖ amount ‖ Tx ‖ Ty ‖ deadline` followed by the spent note's
membership witness and opening, then the locked output's commitment and opening.

## 5f. Bridging between chains

The normative description is [SPEC §6](../SPEC.md#6-reflection-and-the-bridge); this is the practical
shape of each direction, with a real, fully-settled TAC round trip
([`DEPLOYMENTS.md#tac`](./DEPLOYMENTS.md#tac)) as proof both directions actually work end to end.

**Ethereum → Bitcoin** is one call:

```js
const r = await tacit.crossOut({
  walletPriv, notes, amount, destOwner, destChain: 1,   // destOwner: the recipient's x-only Taproot key
});
```

`notes` must be one asset and sum to exactly `amount + fee` — a bridge burn has no change output, so
pre-split first if you're not sending a note's full value. `destOwner` has to be a real, non-zero x-only
key: an owner label here would mint a note nothing can spend. This settles `OP_BRIDGE_BURN` on the pool;
reflection then recognizes and folds the Bitcoin-side mint once one exists — building and broadcasting that
Bitcoin transaction is a separate step from `crossOut` itself, since it needs its own Bitcoin signing key and
funding UTXO, not something the Ethereum-side call has access to.

`crossOut`'s return carries everything the Bitcoin side needs: `crossOuts[].claimId` (verified against the
real `CrossOutRecorded` event, not just the client-side prediction), `cx`/`cy`, `destOwner`, and `ethBlock`
(the settle's own Ethereum block — see below for what it's for). Two ways to finish the Bitcoin side:

- **`makeCrossoutBroadcaster` (`dapp/crossout-broadcast.js`)**, dependency-injected on your own Bitcoin
  commit/reveal broadcast: `broadcast.completeCrossOutOnBitcoin({ ...r, ...r.crossOuts[0], waitOpts })`
  waits until the crossOut is safely coverable (see below), then broadcasts. Spread the whole `crossOut()`
  result: it carries `ethBlock` **and** `claimIdVerified`, and both are checked. `waitOpts` matches this
  SDK's usual `{ intervalMs, timeoutMs, onUpdate }` convention.
- **`tools/build-crossout-mint.mjs`** — a CLI, build-only: takes the same fields plus a funding UTXO and
  writes the two signed transactions to a file for you to review and broadcast by hand.

**Confirmation depth is the same for both directions of the bridge.** A Bitcoin-side fold — this re-mint, or
a bridge burn's own onboarding — only happens once its block reaches the pool's `REFLECTION_CONFIRMATIONS`
depth (24 on the mainnet pool, roughly four hours of Bitcoin blocks). That's the normal latency either way,
not a sign anything is wrong.

**The two directions differ in what happens if you're early, and it comes down to who can guarantee
uniqueness.** A bridge burn spends a real Bitcoin UTXO, so Bitcoin's own consensus guarantees there is
exactly one valid burn for that coin — reflection can let an unmatched burn sit and complete in any later
batch once its provenance is registered, with no ambiguity about which transaction is the real one. A
crossOut's Bitcoin-side claim has no such built-in uniqueness — nothing on Bitcoin stops more than one
transaction from claiming the same crossOut — so the guest resolves it once, at scan time, against its
current view of Ethereum state, and whichever claim is a member at that moment wins; a later claim for the
same crossOut is a no-op, not a retry. `GET /reflection/eth-state/covers?block=N` answers the one question
that actually matters here — is Ethereum block `N` (a crossOut's own `ethBlock`) already covered by the
reflection worker's current view — so broadcast the reveal only once that says yes, not the instant the
crossOut itself settles. `completeCrossOutOnBitcoin` above checks this for you; building the reveal by hand
should check it too before broadcasting.

**Coverage is only half of "safe to broadcast". The other half is the claimId.** `fold_crossout` hashes
`claim_id` into its membership check, so a reveal built from a claimId that is merely *predicted* — rather
than the one the pool actually recorded — can never fold, and fails exactly as silently as broadcasting too
early. `crossOut()` corroborates its prediction against the real `CrossOutRecorded` event in the settle
receipt and reports the outcome as `claimIdVerified` (with `claimIdNote` saying why, when it could not).
`completeCrossOutOnBitcoin` refuses to broadcast unless that flag is `true`, before it spends so much as a
coverage poll. If you corroborate the claimId yourself, pass `claimIdVerified: true` explicitly. Note that
`ethBlock` is only populated alongside a corroborated claimId, since the two are read together.

### Bitcoin-lane AMM refunds need a fresh key

`T_SWAP_VAR`, `T_SWAP_ROUTE` and the swap-batch fold never skip an op they cannot execute — expired, below
`min_out`, stale reserves, a malformed proof. The vin scan has already nullified the input by then, so
skipping would destroy it. They refund instead, minting a note that commits **the input commitment verbatim**
under the refund output's x-only Taproot key.

A Bitcoin-homed note's nullifier is `keccak(leaf ‖ "spent")` over a leaf of `(asset, Cx, Cy, auth_key)` — with
**no outpoint in it**. That is deliberate: it is what lets the reflection and the settle guest agree on one
nullifier per note. It also means the refund's identity is fully determined by the commitment and the key. So
if the refund pays a key one of the spent inputs was homed at, the refund's nullifier is byte-identical to the
one the scan just spent. The note appends to the tree and reads as live, but it can never be spent. The input
is gone and the refund is unspendable.

Refunding to the address the input came from is the obvious thing to build, and forcing the refund branch is
cheap for anyone else — move the pool's reserves so the proof goes stale, add an input, or wait out the
expiry. So:

- Derive a **fresh** key for every refund output. Never an input's key, never another intent's refund key in
  the same transaction (two refunds under one key collide with each other for the same reason).
- Call `assertFreshRefundKey({ refundSpk, inputAuthKeys, otherRefundSpks })` from `dapp/amm-refund-key.js`
  before you sign. It checks both cases and explains the failure.

**Why the shape is like this, and why the rule lives in your builder.** Two decisions meet here, and each is
right on its own.

The refund commits the input commitment *verbatim* because that makes conservation **syntactic** rather than
proven. The refunded note is the input note's commitment, so there is no arithmetic for a prover to get wrong
or to manipulate — no range proof, no kernel, no prover-chosen blinding. Minting a fresh commitment for "the
same" value would instead require the guest to verify a prover-supplied opening, reintroducing exactly the
class of error a refund exists to avoid.

The leaf omits the outpoint because that is what lets the reflection, which sees a Bitcoin output, and the
settle guest, which sees a spend request, compute the **same** leaf and therefore the same nullifier for the
same note. A note with two identities depending on which lane looked at it would break the cross-lane gate
that stops it being spent on both chains — a far worse property to give up.

Together they fix a note's identity as `(asset, commitment, key)`. A refund pins the asset and the
commitment, so the key is the single degree of freedom, and the protocol asks you to spend it.

And the guest genuinely cannot enforce this at fold time. By the time it folds a refund the Bitcoin
transaction has already confirmed and the input has already been nullified by the vin scan. Refusing would
either halt the lane or strand the very input the refund exists to return — both worse than minting a note
that cannot be spent. Before broadcast is the only moment the choice is still open, which is why the rule
lives in the builder rather than in the program.

### A Bitcoin swap batch of one is not confidential

The Bitcoin-lane batch publishes its net reserve deltas in the envelope, in the clear. That is deliberate and
load-bearing: it is what lets any indexer rebuild the pool's reserves from chain data alone, which is the
basis of the Bitcoin-side AMM. The consequence is that a batch with a single intent has no anonymity set —
the net delta *is* that trade, readable straight off the transaction, with no cryptographic work required.
Amounts are hidden by being mixed with other people's, and one trade mixes with nothing.

`assertBatchAnonymitySet({ nIntents, acknowledgeSingleIntent })` in `dapp/confidential-swapbatch.js` refuses a
single-intent batch unless you say explicitly that you want one; the EVM-lane batcher defaults to a minimum
of four. The fold accepts `n_intents == 1` and always will — it is consensus-valid — so this is a choice the
builder makes on the user's behalf, not something the protocol can decide.

The settle lane does not share this shape: `OP_SWAP_BLIND` proves the excess with a Schnorr proof of
knowledge rather than publishing a residue.

**Bitcoin → Ethereum** is not a single wallet call today. A Bitcoin-side spend into a bridge-burn envelope
(`0x2B`, [SPEC §3.7](../SPEC.md#37-bridge-and-cross-chain-ops)) is what reflection watches for; once it's
confirmed and proven, the pool mints the note once via `OP_BRIDGE_MINT`, keyed by the burn's own id. TAC is
the one asset whose Bitcoin-side transfers reflect unbound already ([SPEC §6.2](../SPEC.md#62-bitcoin--ethereum)),
so a plain Bitcoin-side send needs no separate onboarding step before it can bridge; other assets onboard
through `T_CXFER_BOUND`, a bridge burn, or as AMM/farm/bid outputs first.

**This direction's reveal needs a private-submission relay, not ordinary Bitcoin p2p relay.** The guest
identifies the burned note as the burn tx's own first spent input, and reads its ~161-byte envelope from
that same input's witness — the two can't be split across separate inputs, and the envelope can't be
pre-committed into the note's own home script ahead of time either, since it names that note's own outpoint,
which doesn't exist yet when the note is created. Either way, the witness item carrying the envelope ends up
well over Bitcoin Core's 80-byte standardness cap for witness arguments, so mempool.space / blockstream.info
and other ordinary relay won't carry it — it's still a perfectly valid, minable Bitcoin transaction, just not
a *policy-standard* one. This is a structural property of the current, immutable guest, not a sign of a
badly-built transaction. [MARA Slipstream](https://slipstream.mara.com/docs/) accepts exactly this kind of
non-standard-but-consensus-valid transaction directly into a miner-side queue, which is how every
burn-deposit that has actually landed got broadcast, including the round trip linked above.

`dapp/burndep-broadcast.js` (`makeBurnDepositBroadcaster`) wraps that path: `submitToSlipstream(txHex)` posts
the reveal to MARA's queue, `waitForBurnDepositMined({ txid, checkConfirmed, ... })` polls until an injected,
real chain check (an esplora lookup, or the relay API's own `/chain/tx` — MARA's own queue status is
progress-only, not proof of inclusion) reports it landed, and `registerBurnDeposit({ burnTxidDisplay, bundle })`
posts the provenance to `POST /reflection/burndep` (permissionless — the guest re-verifies everything
in-zkVM regardless, so this is a liveness convenience, not a trust boundary) so the reflection worker's
batch-builder finds it without blindly rescanning every block. `completeBurnDepositToEthereum({ ... })` runs
all three in order, registering only once real confirmation is observed.

The TAC round trip linked above is a real, fully independent-verified example of exactly this: an Ethereum
crossOut, its Bitcoin-side re-mint, a Bitcoin-side return burn, and the mint back on Ethereum — four
separate settled transactions, each hash checked against live chain state before being written down here.

## 5g. Cross-chain messages (EthCallOutbox / T_ETH_CALL)

Two value-free message channels run alongside the value lanes, in opposite directions. `T_BTC_CALL` (0x68) is
a Schnorr-signed Bitcoin transaction authorizing an Ethereum call, surfaced to the pool as a pending call and
fired by the off-pool `BtcCallExecutor`. `T_ETH_CALL` (0x69) is the mirror: `EthCallOutbox.send()` on
Ethereum, folded on the Bitcoin side into an honored-message set.

**They carry no value, by construction.** An outbox record commits `(destChain, ns, sender, payloadHash)` —
no amount, ever — so honoring one authorizes no mint, no note and no transfer. The effect of a fold *is* the
honored-set entry. That is what makes the channel safe to treat as data rather than as money, and it is worth
keeping in mind when deciding what to put behind it.

**The channel is at-least-once with sender-driven retry, not exactly-once.** Two things can cause a
particular Bitcoin transaction's 0x69 to be dropped:

- The prover supplies a bad membership witness for it. The fold is deliberately skip-not-panic — a fabricated
  0x69 costs anyone a Bitcoin transaction to broadcast, and aborting on one would let that person halt the
  lane for everybody. The same tolerance means a genuine message can be silently passed over.
- The batch scanning that block is a forward batch (no Ethereum-state bundle attached). A forward batch
  carries a zero message-set root, so every 0x69 in it fails membership.

Neither is a completeness gate, and that is also deliberate: requiring every message to fold would let one
unfoldable message brick the lane permanently. A Bitcoin transaction is scanned exactly once, so a dropped
message is dropped for that transaction — but **not for that intent**. `msgId` is
`keccak256(outbox ‖ chainId ‖ recordHash ‖ index)` over a monotone index, so calling `send()` again produces a
fresh `msgId` and a fresh fold attempt, even with a byte-identical payload.

**So, practically:** treat the outbox as a retryable channel. After sending, confirm the message landed in the
honored set rather than assuming it did, and re-send if it did not. Do not put a one-shot emergency action, a
governance execution that must fire exactly once, or anything whose timing you cannot control behind it
without a confirm-and-retry loop in front. Anything idempotent — an attestation, a pointer update, a data push
— fits the channel well as it stands.

**Which outbox is honored is fixed in the guest**, not configurable: the reflection program pins
`ETH_CALL_OUTBOX` as a build constant and asserts it on every cycle, so changing it requires a program rebuild
and a new deployment. That is the intended one-way door — it means no operator can redirect the channel at a
different contract — and it is why the outbox address is not surfaced as a settable parameter.

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
the relay still proves, so it still sees the witness. Proving locally keeps the witness — the link between an
op's inputs and outputs, and any trade size — on your own device end to end.

`OP_SWAP_BLIND` keeps amounts out of the SP1 witness: clearing is proven by a Groth16 circuit that the
batch's coordinator produces and the guest verifies. It is enabled in the deployed guest but the relay
does not accept it, so relayed swaps are `OP_SWAP_ROUTE` or `OP_SWAP` and the paragraph above applies ([SPEC §5.6](../SPEC.md#56-prover-blind-swaps)).

## 7. Iterating on the design

The template is one file with no dependencies: the live pool and relay panels are plain `fetch`, and the
dapp-module imports are commented at the wiring point. You can replace its look without touching its logic.
Two conventions to keep:

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

- [`INTEGRATOR-PLAYBOOK.md`](./INTEGRATOR-PLAYBOOK.md) — a trustless integration: farm zap, key-only recovery, self-settle checklist
- [`RECOVERY.md`](./RECOVERY.md) — what a wallet recovers from its key
- [`PRIVATE-PAYOUT.md`](./PRIVATE-PAYOUT.md) — paying a 0x address from a confidential balance
- [`FARMS.md`](./FARMS.md) — the TAC launch farms: cards, flows, monitoring and governance bounds
- [`AIRDROP.md`](./AIRDROP.md) — the TAC airdrop contract and its roles
- [`DEPLOYMENTS.md`](./DEPLOYMENTS.md) — every live address and vkey
- [`SPEC.md`](../SPEC.md) — the protocol specification: envelopes, pool ops, reflection
- [`audit/AUDITS.md`](../audit/AUDITS.md) — the audit reports
