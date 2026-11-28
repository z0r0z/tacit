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

Node 22 or later, from the repository root. The key's P2WPKH address holds the desk's TAC and the sats that fund its transactions; fund it
with TAC the proof follows (the Bridge tab says which notes those are) and a few hundred thousand sats. `/info` shows the tracked
TAC on hand. Keep `dataDir` on a persistent disk: each swap record is its safety state (the signing sessions above all).

## HTTP

| | |
|---|---|
| `GET /info` | key, asset, limits, fee, timelocks, tracked TAC on hand, discount schedule and cap, pledges (pledged, borrowed, owed, available) |
| `POST /quote {amount, note?}` | a quote: what the holder locks, what the desk locks back, the fee, the discount in basis points and in TAC, the note's class |
| `POST /offer {quoteId, offer}` | the holder's confirmed lock |
| `GET /swap/<id>` | the swap's phase and, once confirmed, the desk's lock |
| `POST /swap/<id>/nonce`, `/sign` | the claim's two signing rounds, signed by the holder's key |
| `POST /pledge {pledgerPub, pledgerXonly, amount, maxDiscountBps, signerUrl?}` | a pledge offer: the joint lock to fund, and the pledger's signing URL |
| `POST /pledge/<id>/lock {lock}` | the pledge's confirmed lock; the pledge is funded once the desk has checked it on the chain |
| `GET /pledges`, `GET /pledges/<id>` | pledges (pledged, drawn, owed, repaid, committed) and standing floors |
| `POST /floor {holderPub, amount, maxDiscountBps, note}` | a holder's standing sell offer: the desk matches it when a quote's discount covers it |

## Pledges

A pledger funds the desk's tracked-TAC inventory without handing the desk their TAC. They lock tracked TAC to a MuSig2 joint
key of their key and the desk's per-pledge key, refundable to them after `csvPledge` blocks (`pledge.csvPledge`, 144). The desk
draws from a pledge only to fund a swap at the agreed discount, and only with the pledger's signature on that draw (the pledger
runs `tools/pledge-signer.mjs`, which checks the amount, the discount and the swap before it signs, and refuses anything else).
A draw is repaid from the desk's owned tracked TAC once the swap it funded has settled, plus the return (`pledge.pledgeReturnBps`,
50bps of the drawn amount). The desk's owned inventory is spent first; a draw is only taken when the desk is short. Undrawn TAC is
reclaimable by the pledger through the script path once the refund opens; the desk never spends an expired pledge.

The desk converts tracked TAC into stuck TAC, so its tracked inventory only drains. A drawn pledge is repaid from the desk's
capital (an operator top-up, or tracked TAC the desk holds beyond the swap), not from the swap's proceeds, which arrive as stuck
TAC. A pledger should treat a draw as a loan to the desk's balance sheet, repaid from its capital. `/info` publishes pledged,
borrowed, owed and available separately, so a pledger can see what the desk holds against what it owes.

## Discount

The discount is the haircut for TAC the bridge cannot follow, per class of stuck note, in basis points (`quote.discountBps`):
clean 0, long-history 150, pool-exit 300, capped at `quote.discountMaxBps` (500). A quote over the cap is refused. The class comes
from the note's history: the desk traces it through `POST /reflection/burndep/trace` when the quote names the note (a quote taken
without a note is the clean rate, and the desk refuses the offer if the note turns out stuck). A holder can also leave a standing
sell offer (`POST /floor`): the desk matches it when a quote's discount covers the floor.

## Provider loop

A fast-bridge provider holding stuck notes offloads them with `tools/provider-offload.mjs`, which quotes each note at the desk
and swaps the ones whose discount is within the provider's floor (`--floor`, from the provider's own config). The swap ends with
a tracked note, which the provider bridges home through its normal fast-bridge flow. The provider's floor is the most discount
it will take; a note over the floor is left alone.

## Signet dry run

The Render service (`worker-relay/render.yaml`, `worker-relay/Dockerfile.btcswap-desk`) runs the desk from
`btcswap-desk/config.render.json`, which is signet. Start it with `--dry-run` first: it answers `/info` and `/quote` and checks
offers, but keeps its swaps in memory and advances none. Then run it live on signet with small amounts: fund the desk's address
with signet TAC and sats, fund a pledge from a signet wallet, and swap a stuck signet note through the Bridge tab. The signet
asset id in `config.render.json` must be filled in first (it is the signet TAC Bitcoin asset id; the mainnet one is `tacAssetId`
in `contracts/deployments/1.json`). A live mainnet desk is not required for this entry.

## What was not tested

The desk has never been deployed to Render, and no live signet run has happened. The trace endpoint has not been called against
the live Tacit API from the desk server, and the pledger signer has not been run as a standalone process against a live desk.
The sim tests (`tests/btcswap-pledge.test.mjs`, `tests/btcswap-numbers.test.mjs`) cover the pledge, discount, floor and provider
flows against a simulated Bitcoin; the reflection's fold of a pledge draw is not covered, and neither is a live signet swap.

## What the desk risks

A holder who stops after the desk locks costs the desk its lock until `csvDesk` runs; the refund is a script-path spend, so that TAC
comes back untracked. Such TAC is still TAC on Bitcoin (it sells into the shielded pool as well as any).
