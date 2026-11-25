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

Use Node 22 from the repository root, with the existing packages installed in `worker/` and `worker-relay/`. Each pledger runs one
desk with their own key and persistent `dataDir`. The key's P2WPKH address holds its tracked TAC and the ordinary Bitcoin
coins that pay miner fees. Keep the swap records backed up, including their signing sessions.

### Pledge tracked TAC

The example starts with an empty `pledge.outpoints` array and quotes zero capacity. Add the `txid:vout` of each
confirmed transfer note you want to pledge at this key, then restart. The desk checks ownership, spend status and the
reflection's tracked set. Its own confirmed, tracked TAC change can fund another swap. Removing a root freezes any
change it helped fund. You can explicitly pledge a change outpoint on its own. `GET /info` shows aggregate capacity
and the price limits. The outpoints stay in the config and the local journal.

- `quote.feeBps` and `quote.flatFee` set the discount. In the example the holder supplies 100 TAC and receives 95 tracked TAC.
  The desk checks the effective discount, including the flat fee, against both `pledge.minDiscountBps` and `pledge.maxDiscountBps`
  at quote time and again before signing the Bitcoin lock. One basis point is 0.01%.
- `pledge.maxMinerFeeSats` caps the actual total miner fee of each of the desk's commit/reveal pairs. Keep ordinary BTC coins
  available for both the lock and its eventual take or refund. A pair above the cap waits. A funded swap retains its fee cap
  through restarts. A low cap during congestion can delay a take past the holder's refund time.
- To pause new business, empty the array and leave the desk running to finish existing swaps. Existing configs that omit
  `pledge` use the original wallet-wide inventory policy.

To offer the desk on your own installation, proxy the same-origin prefix `/btcswap-desk/` to the daemon, stripping
the prefix (`/btcswap-desk/info` maps to `/info`). Add your page's origin to `origins`. Open `/tac/?desk=1` on that
installation and select a note the regular bridge cannot carry. The page displays the input, payout and discount before
the holder locks Bitcoin. Returning to the same installation resumes a pending swap.

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

The bounty write-up gives the balance examples, assumptions and test commands. [Stuck TAC desk entry](../docs/STUCK-TAC-PLEDGED-DESK.md)
