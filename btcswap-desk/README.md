# Bitcoin-to-Bitcoin swap desk

TAC whose history the bridge's proof does not follow (a note whose lineage passes a Bitcoin shielded-pool exit, for one) cannot be
burned to Ethereum. The desk swaps it, on Bitcoin, for the same amount less a fee of TAC the proof does follow; the holder then
bridges with the ordinary one-transaction burn. No provider on Ethereum is involved.

The swap is two Bitcoin locks, so neither side can be left half-paid (`dapp/btcswap.js`):

1. The holder locks its note to the desk's key plus an adaptor point T, refundable to the holder after `csvHolder` blocks.
2. The desk checks that lock on the chain and locks tracked TAC to a MuSig2 key of both parties (`dapp/musig2.js`), refundable to
   the desk after `csvDesk` blocks.
3. The holder checks the desk's lock (key, opening, that the proof follows it) and claims it by key path; the desk's half of that
   signature is adapted to T, so the claim the holder publishes gives the desk t. A key-path claim keeps the note tracked.
4. The desk reads t from the claim and opens the holder's lock.

## Run

```
cp btcswap-desk/config.example.json btcswap-desk/config.json
BTCSWAP_DESK_KEY=<64 hex> node btcswap-desk/server.mjs --dry-run    # answers /info and /quote, advances nothing
BTCSWAP_DESK_KEY=<64 hex> node btcswap-desk/server.mjs
```

Node 22, from the repository root. The key's P2WPKH address holds the desk's TAC and the sats that fund its transactions; fund it
with TAC the proof follows (the Bridge tab says which notes those are) and a few hundred thousand sats. `/info` shows the tracked
TAC on hand. Keep `dataDir` on a persistent disk: each swap record is its safety state (the signing sessions above all).

## HTTP

| | |
|---|---|
| `GET /info` | key, asset, limits, fee, timelocks, tracked TAC on hand |
| `POST /quote {amount}` | a quote: what the holder locks, what the desk locks back |
| `POST /offer {quoteId, offer}` | the holder's confirmed lock |
| `GET /swap/<id>` | the swap's phase and, once confirmed, the desk's lock |
| `POST /swap/<id>/nonce`, `/sign` | the claim's two signing rounds, signed by the holder's key |

## What the desk risks

A holder who stops after the desk locks costs the desk its lock until `csvDesk` runs; the refund is a script-path spend, so that TAC
comes back untracked. Such TAC is still TAC on Bitcoin (it sells into the shielded pool as well as any).
