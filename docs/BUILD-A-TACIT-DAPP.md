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
  applies the effects. There is no admin, no pause, no upgrade.
- A **memo** is emitted per created leaf: the note's opening, encrypted to its owner. It is the only way a
  wallet recovers its notes from a seed. Lose the memo and lose the note.
- You do not need to prove anything yourself. The **relay** proves and settles for a fee carved from the op,
  and it never sees a spending key.

Everything else is detail.

## 2. Three things that surprise everyone

**You cannot send a note directly to someone else.** A note's `owner` is `keccak(nk ‖ dom)` — a hash, not a
public key. Whoever can compute an output's owner necessarily knows its `nk`, and `nk` *is* spend authority.
So a sender either keeps the ability to spend, or mints a note nobody can ever spend. Third-party payments go
**stealth lock → claim**: the sender locks to a one-time pubkey derived from the recipient's static address,
and the recipient's claim mints a note under an `nk` only they choose. `OP_TRANSFER` is for self-sends —
merges and consolidation. `dapp/confidential-stealth.js` has the payment path.

**Values are `u64` in-system units, not wei.** Each asset has a `unitScale`; the in-system value is
`amount / unitScale`, and the amount must divide exactly. ETH is 18-dec with `unitScale = 1e10`, so the pool
sees 8 decimals. Get this wrong and the deposit is unconsumable — the guest never sees `unitScale` and
reproduces the deposit id from the value alone.

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
wallet. `account(walletPriv)` is synchronous and returns `{ address, priv, pubHex }`. If you would rather
drive an injected wallet, use the `build*` variants — they return `{ to, calldata, amount }` and broadcast
nothing.

### Read a balance

```js
const acct  = tacit.account(walletPriv);          // { address, priv, pubHex } — sync
const funds = await tacit.balance(scanPriv);      // notes recovered from logs + memos, grouped by asset
```

`scanPriv` is the wallet's scan scalar as `0x`-hex or bytes. Each note carries
`{ asset, value, blinding, secret, cx, cy, owner, leafIndex, path, root }` — `path`/`root` are the membership
witness a spend needs. **Rescan immediately before spending**: a witness goes stale as soon as anyone else
settles.

### Wrap ETH in (step 1 — a plain tx, no proof)

```js
const w = await tacit.wrap({ walletPriv, amountWei: 10n ** 16n, ticker: 'cETH' });
// signs + broadcasts from the derived account; w.txHash is the deposit tx
```

Injected-wallet variant:

```js
const w = tacit.buildWrap({ walletPriv, amountWei: 10n ** 16n, ticker: 'cETH' });
await provider.request({ method: 'eth_sendTransaction', params: [{
  to: w.to, from: myAddress, value: '0x' + BigInt(w.amount).toString(16), data: w.calldata,
}]});
```

Only `commit = keccak(Cx ‖ Cy ‖ owner)` goes on-chain. Keep `w.note` and `w.memo` — that is the note.

### Turn the deposit into a note (step 2 — one proof)

```js
const res = await tacit.submitWrapSettle({ built: w });   // once the wrap tx is mined
```

The guest checks the deposit is registered, so this fails until the wrap tx has landed.

### Spend

```js
// self-send / merge — recipientPubHex must be your own
await tacit.transfer({ walletPriv, notes, recipientPubHex: acct.pubHex, amount: 5_000_000n, fee: 100n });

// exit to a public address
await tacit.unwrap({ note: notes[0], walletPriv, recipient: '0xabc…' });

// pay someone else (stealth lock; they claim it)
await tacit.stealthSend({ walletPriv, notes, recipientPubHex, amount: 5_000_000n });
```

Fees: by default the relay proves *and* submits, and the fee must clear its gas-priced floor
(`tacit.quoteOpFee(...)`, or `GET /confidential/quote?asset=cETH`). `selfRelay: true` with `fee: 0n` has the
relay prove but **you** submit and pay gas — note that the relay still receives the witness either way; what
you avoid is the fee and having the relay's address on the transaction. Removing the relay entirely means
proving locally (native-gnark on CPU — no GPU, no network payment; see
`ops/INTEGRATION-simple-wrap-send-claim-eth.md`).

Each of these returns once the settle lands; pass `waitOpts` to tune the polling.

## 6. Relay API

Base `https://api.tacit.finance`. Everything below is public; nothing needs a key.

| endpoint | |
|---|---|
| `POST /confidential/submit` | `{ type, op, memos, mode?, feeAsset? }` → `{ jobId }`. `mode: 'prove'` returns a proof for you to submit yourself; default `'settle'` has the relay submit it. |
| `GET /confidential/status?id=` | `pending` → `proving` → `settled` \| `failed` |
| `GET /confidential/quote?asset=cETH` | `{ ticker, assetId, relayFeeEligible, staticFloorUnits, gasAwareFloorUnits }` — floors are in the asset's **in-system units**, not wei. `asset` takes a ticker or a `0x` asset id. |
| `GET /confidential/index?from=&limit=` | the pool's event stream plus the stealth lock set, in chain order behind one cursor — recover a key's notes and locks without running a scanner |
| `GET /health` | liveness |

Submits are rate-limited per IP and the queue is bounded; a rejected submit is backpressure, not failure.

**What the relay learns.** It never sees a spending key — only opening sigmas — and can only earn the
proof-bound fee. But it does see your IP, and for an `OP_SWAP` it sees that swap's amounts, because the guest
computes the clearing and therefore must read them. Everything else (who you are, your balance, your other
notes) stays hidden. Note that `selfRelay` does **not** change this — the relay still proves, so it still
sees the witness. If a trade size matters to you, prove locally.

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
| `UnknownRoot` | stale membership witness — rescan |
| `NullifierAlreadySpent` | the note was already spent |
| `MemoLeafMismatch` | memo count or order does not match `pv.leaves` |
| settle says `failed` with a guest assert | the witness is malformed; the assert text names the field |
| relay rejects the submit | fee below the floor, or the queue is full |

A failed proof costs the relay, not you, and moves no state. A settle either applies completely or reverts.

## 9. Further

- [`docs/DEPLOYMENTS.md`](./DEPLOYMENTS.md) — every live address and vkey
- [`ops/INTEGRATION-simple-wrap-send-claim-eth.md`](../ops/INTEGRATION-simple-wrap-send-claim-eth.md) — the
  full ETH-only handoff, with the stealth path in depth
- [`SPEC.md`](../SPEC.md) — canonical wire formats
- [`audit/AUDITS.md`](../audit/AUDITS.md) — the review history
