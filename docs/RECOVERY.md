# Recovering a wallet from its key

This chapter is for integrators. It says what a wallet can find again from its private key alone, what needs a saved
record, how to run the recovery, and what the client checks so that a note is never sealed in a way it cannot be opened.

Everything here is read-only against public chain data. Nothing is signed or sent.

## What comes back from the key alone

A confidential note reaches its owner through one of two channels:

1. **A memo** sealed to the owner's key and published with the note's leaf. The owner scans the pool's `LeavesInserted`
   events, opens every memo it can, and the leaf hash authenticates the result.
2. **A derivation** the owner can repeat from its key plus public chain data. The wallet computes the candidate note and
   accepts it only when the recomputed leaf, deposit id or receipt equals a value the chain holds.

| What | Channel | Needs besides the key |
| --- | --- | --- |
| Notes made by transfer, swap, LP, farm harvest and unbond, CDP debt and release, stealth claim and refund | memo | nothing |
| Wrap deposit notes (any wrap index) | derivation: `deriveNote(key, asset, index)` matched to the pool's `Wrap` deposit ids | nothing |
| Change of a send-and-unwrap | memo, and a fallback derivation from the spent parent note | the settle transaction's calldata (RPC) |
| Bridge-mint destination notes (a Bitcoin burn re-minted here) | derivation: owner from `deriveNote(key, asset, destIndex)`, blinding from the burn nullifier | the amount, if it is not m × 10^k for m below 100 |
| cBTC bearer notes | derivation: blinding from the key and the lock's funding prevout | the wallet's Bitcoin history (public esplora) and the pool's recorded lock value |
| Farm positions opened with `lpBond` or `farmBond` | derivation: receipt key and nonce from the key and an anchor note, matched to the manager's `Bonded` events | nothing |
| CDP positions opened with the derived owner key | derivation: owner from the key and a key nonce, matched to the position's settle calldata | nothing |
| Stealth locks the wallet sent | a tail sealed to the sender's own key on the lock memo | nothing |
| Stealth locks addressed to the wallet | memo | nothing |

## What needs a saved record

| What | Why | What to save |
| --- | --- | --- |
| A farm position opened under a random receipt key (older builds) | its key is not derived from anything the chain or the wallet key holds | `{ lpAsset, shares, receiptLeaf, owner, nonce, ownerPriv }`; restore it with `importFarmPosition` |
| A CDP position opened under a random owner key (older builds and scripts) | same | the position descriptor with `positionOwnerPriv` |
| A stealth lock sent by a build that did not append the sender tail | the refund key was random and never published | the `onBuilt` result of `stealthSend` |
| The destination note of a cross-out to Bitcoin | the note is owned by the destination key the sender chose, on Bitcoin; the wallet can recompute the blinding, but only the holder of that key can spend it | the destination key and the returned `destBlinding` |
| A bridge-mint note of an amount that is not m × 10^k for m below 100 | the amount is hidden in the commitment | the amount, passed as `bridgeAmounts` |

`ux.recover` reports each of these as unresolved rather than guessing.

## Running recovery

```js
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';
const tacit = makeConfidentialPoolUx({ secp, keccak256, sha256, network: 'mainnet' });

const r = await tacit.recover({ walletPriv });
// r.notes            unspent notes, each with { value, asset, blinding, secret, path, root, source }
// r.cbtc             the cBTC bearer notes among them
// r.farmPositions    live farm positions, ready for farmHarvest / farmUnbond
// r.cdpPositions     CDP position descriptors, ready for closeCdp
// r.sentLocks        stealth locks the wallet sent: fields + refundPriv + lPath + spent (true / false / null)
// r.receivedLocks    stealth locks the wallet can claim
// r.diagnostics      what was scanned and what could not be resolved
```

`source` is absent for a note found through its memo, and otherwise names the channel: `wrap`, `change`,
`bridge-mint` or `cbtc`.

`balance(walletPriv)` returns the same `{ notes, byAsset, poolStats }` it always did, and now also lists the wrap,
bridge-mint and cBTC notes. It skips the walks that read transaction calldata, so it stays cheap enough to poll.

Options: `{ toBlock, deep: false }` skips the calldata walks (change notes), `{ cbtc: false }` skips the Bitcoin history
read, `{ bridgeAmounts: [units…] }` adds amounts to try for bridge-mint notes, `{ btcHistory }` supplies the wallet's
Bitcoin history (`{ anchors: [{ txid, vout }], lockOutputs: [{ txid, vout }] }`) instead of reading esplora, and
`{ events }` reuses an event stream you already fetched (from `fetchEvents({ include: ['wraps', 'cdp', 'bonds'] })`).

### Reading the diagnostics

`diagnostics.coverage` is the summary: for each category, whether it was scanned, and `complete: true` only when no
category raised an error. The detail sits beside it:

- `notes`: counts per channel, `pendingWraps` (deposits whose note is not in the tree yet), `derivedAlreadySpent`
  (notes a derivation found that are already spent), and `emptyMemoLeavesNotAttributed`, the leaves with an empty memo
  that nothing explained. Other holders' seed-derived notes are in that count, so it is a ceiling on what is missing, not
  a list of it.
- `farm`: Bonded events seen, receipts derived, derived receipts the manager no longer holds (`derivedClosed`), and
  receipts nothing derived (other holders', or random-key positions that need `importFarmPosition`).
- `locks`, `cdp`, `cbtc`, `bridge`, `change`, `wrap`: what each walk tried and found, and `errors` for any that failed.

### Farm positions under a random key

```js
await tacit.importFarmPosition(record);            // checks the record against the chain, then stores it
const positions = await tacit.farmPositions({ walletPriv });   // now includes it, with imported: true
```

The record is accepted only when the receipt leaf reproduces from `(manager, lpAsset, shares, owner, nonce)`, `ownerPriv`
is the private key of `owner`, the leaf is in the pool tree, and the manager holds it live for that pool. Harvest and
unbond then use the stored key. The record holds a private key: keep the backup as carefully as the wallet key.

## Memo integrity

A note whose memo cannot be opened is a note the wallet cannot find. Two checks close that:

- **At submit.** For every output sealed to a key the wallet holds, the recovery guard opens the sealed memo with that key
  and requires it to authenticate against the output's leaf and to open to the same owner and value the output describes.
  A memo that is well formed but sealed for something else is refused before the op is queued. Outputs sealed to someone
  else's key cannot be opened here and are checked for shape only; seed-derived outputs carry no memo and are skipped.
- **After settle.** The memo the pool emitted for each relayed leaf is compared byte for byte with the one sealed here. If a
  relay emitted a different memo, the sealed one is kept in local storage under the settle's transaction hash, and
  `balance` applies it on that device.

The wrap index matters for the derived channel. A wrap note's secret and blinding come from `(key, asset, index)`, so two
deposits on one index share them, and the same index with the same amount is a deposit id the pool already holds.
`nextWrapIndex` takes the first index no deposit of this wallet and asset has used. The recovery walk tries indexes upward
from 0 and stops after 24 unused in a row, so an index left far behind a gap of more than 24 is not reached by the walk.

## Cost

- One event pass over the pool from its deploy block, in windows of 500 blocks (the tightest range cap seen on public
  nodes): one `eth_getLogs` call per window, about 60 for the first month of history. `recover` fetches the pool's note events, `Wrap`,
  `CdpPositionInserted` and the farm manager's `Bonded` in that one pass. Pass `events` to avoid fetching twice.
- Wrap and bridge-mint walks are local hashing over that stream. The bridge-mint walk tries the amounts m × 10^k for m
  below 100 (about 1,900 per burn nullifier and destination index, plus any `bridgeAmounts`); it runs only for leaves with an empty memo and is remembered per session.
- The cBTC scan reads the wallet's Bitcoin history from public esplora mirrors (queried by script hash, so no address is
  sent) and one `eth_call` per candidate lock output. The result is cached for ten minutes.
- The calldata walks (change notes, CDP positions, stealth lock memos) fetch one transaction per settle involved.
- Positions and locks are checked for liveness with `eth_call` and `eth_getStorageAt` reads.
