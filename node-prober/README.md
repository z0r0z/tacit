# node-prober

Probes community Ethereum and Bitcoin read nodes, signs what it finds, and serves the signed list the pages read and the status behind `/nodes/`.
Design notes: what a useful node is, how probes judge it, and what the pages may do with one.

## What it does

- **Registry.** An operator signs an ad (`dapp/nodes-list.js` `signAd`, or `node tools/nodes-ad.mjs`) with its own key and posts it to `POST /nodes/ad`.
  Endpoints must be https names (no addresses, no ports but 443 and 8443), must answer a plain read from the site's origin (CORS) and be Ethereum
  mainnet / an esplora, and must not resolve to a private address (checked at connect time). One operator per endpoint. Ads last at most 30 days.
- **Probes** (`src/probes.mjs`), a few an hour at random times, in the wire format the pages use. The right answer is what two sources share, our
  node counting as one; no agreement is no verdict, never a mark against the operator.
  Ethereum: head and the block hash 12 deep against the references' (freshness), random block and receipt, random 5,000 / 9,999-block windows of
  the pool's logs, `eth_getProof` thousands of blocks back, state at an old block (archive), and honeypots (a receipt, a block and events that do not exist).
  Bitcoin: tip and the block 3 deep, a random old block's random transaction, an old address's history (index), and honeypots (a made-up txid, a height ahead of the tip).
  A node that alone contradicts our node and the references on a settled fact, or finds what does not exist, is a **hard fail** and a strike: three in
  30 days takes it off the list for a week.
- **Scores** (`src/score.mjs`): per role per day, `BASE * uptime * correct^2 * freshness`, nothing under 80% uptime, with a hard fail, or unjudged.
  Weight for the pages: nothing in the first 24 hours (shadow), then 0.1 rising to 1.0 over 14 clean days, times reliability; zero if it has not
  answered well in three hours. Endpoints on one /24 or ASN count once; across an operator's machines the second counts a quarter, the rest a twentieth;
  an endpoint behind a fronting service (Cloudflare ranges) is shown and not listed.
- **Signed documents.** Every probe record, the list (`GET /nodes/list`, 30 minute life) and the status (`GET /nodes/status`) are Schnorr-signed by
  `PROBER_KEY`. The pages pin the public key; a document that does not verify is ignored.
- **Relay** (`POST /nodes/relay`): how a page reaches a community host without a CSP entry for it. Listed nodes only, public-data reads only
  (`ethPublic` / `btcPublic` in `dapp/nodes-list.js`), rate limited, nothing logged. The operator sees this service's address, not the visitor's; this
  service sees the (public) question.
- **Points: off.** `GET /nodes/credits?day=N` is empty and says `enabled: false` unless `POINTS_ENABLED=1`. Switching it on needs the points service's
  campaign (feed URL, schedule, pocket) to be configured too; credit ids are `pn:day:<day>:<address>`, from published scores only, capped at 5% of a
  day's points per payee. Nothing in the proof-mining or ceremony pots changes.

## Run

    PROBER_KEY=<hex> STATE_PATH=/data/state.json PORT=10000 node node-prober/src/index.mjs

Env: `PROBER_KEY` (required), `STATE_PATH`, `PORT`, `POINTS_ENABLED` (0), `PROBE_INTERVAL_SECS` (1200), `PROBER_VANTAGE`.
Tests: `node --test tests/node-prober.test.mjs tests/community-nodes.test.mjs tests/nodes-page.test.mjs`.
