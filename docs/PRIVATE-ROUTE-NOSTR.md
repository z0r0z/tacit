# The private route over Nostr

The private route (docs/EVM-POOL.md, "Private route") carries a wallet's sealed requests to the EVM pool keepers through HTTP forwarders. The same
sealed request, to the relay API (`api.tacit.finance`, `RELAY_API_NOSTR_RELAYS` on the server) as well, can be carried by public Nostr relays, which anyone runs. A request sealed to the keeper's gateway key is ciphertext, so a relay sees
the sender's address and a blob of a few fixed sizes, never what is in it, as a forwarder does.

## Order of roads

A request tries the HTTP forwarders, in random order, then the Nostr relays, then fails. It is never sent directly.

## The messages

Both are ephemeral events (kinds 20000 to 29999: relays pass them on and do not keep them), each signed with a key made for it alone.

- **Request**, kind `21501`. `content` is the sealed envelope, base64. Tags: `["x", <gateway key id>]` (not `p`: relays hold a `p` tag to 32 bytes and
  refuse a 4-byte one, found by testing against real relays), `["t", "tacit-route-v1"]`, `["expiration", <now + 300>]` (NIP-40) and
  `["nonce", <n>, "12"]` (NIP-13: the id has twelve leading zero bits).
- **Reply**, kind `21502`. Tags `["e", <the request's id>]`, `["t", "tacit-route-v1"]`, `["expiration", …]`. `content` is the sealed answer, base64.
  Only the sender's keys open it.

The wallet publishes the request to every relay, asking each for the answer first (a relay holds nothing for a later ask), and takes the first answer that
opens. The keeper (`worker-relay/src/lib/evm-pool-keeper-nostr.js`) listens for requests with its key id, runs each through the same gateway
`POST /sealed` reaches (so the single-use memory, the five-minute window, what is carried and the per-request limits all apply), and publishes the
answer as a reply on the relays it hears them on.

## What each party sees

| | sees |
|---|---|
| a Nostr relay the wallet uses | the sender's address, a blob, its size and the time; never the content |
| the keeper | the relays' addresses and the request |
| the HTTP forwarders | nothing, on this road |

A relay and the keeper that share a log can link a request to an address; using several independent relays makes that harder to arrange. Timing is
the signal that remains.

## Limits

- **Size.** An envelope up to 32 KiB goes by Nostr (every read and nearly every write); a larger one fails on this road. An answer up to 40 KiB goes back by
  Nostr; a larger one is not sent, and the wallet's request fails on this road.
- **Spam.** An envelope costs the keeper a decrypt to refuse, and a sender with a key per request cannot be limited by key. Each request carries the
  proof of work above, at most 16 are handled at once, and everything on this road counts as one sender at the gateway (120 envelopes a minute, a burst of
  30), so a flood on Nostr cannot spend the forwarders' allowance.
- **Replay.** The gateway's single-use memory and five-minute window apply unchanged.
- **Availability.** Public relays rate-limit and drop. The page names three; a request goes to all of them.
- **Latency.** One to three seconds, against a fraction of a second by forwarder.

## Where it lives

- `dapp/route-nostr.js`: the events and the wallet's carrier. `dapp/sealed-request.js` calls it after every forwarder has failed.
- `dapp/private-route.js`: `ROUTE.nostr`, the relays. The carrier loads only when a request needs it, and only where the browser has a WebSocket.
- `worker-relay/src/lib/evm-pool-keeper-nostr.js` and `worker-relay/src/evm-pool-keepers.js`: the keeper's listener, on when
  `EVM_POOL_KEEPER_NOSTR_RELAYS` names relays (`wss://…,wss://…`; `EVM_POOL_KEEPER_NOSTR_BITS` sets the work, 12 by default).
- `tests/route-nostr.test.mjs`: the road end to end against a stand-in relay and the real gateway.

## Adding or changing relays

Name the relays in `EVM_POOL_KEEPER_NOSTR_RELAYS` and redeploy the keepers; add the same hosts to `ROUTE.nostr` and to the `connect-src` of every page that
carries the route (`tests/private-route.test.mjs` fails when one is missing), then build and push. A relay must accept ephemeral events of kinds 21501 and
21502 with an `x` tag, and pass them to subscribers.
