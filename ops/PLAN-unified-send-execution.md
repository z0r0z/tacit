# PLAN — Unified Send execution (fold the Bitcoin lane into the dispatch)

Status: design. No code yet. This is the deliberate follow-up to the asset-first Send box
(confidential-send-tab.js) that today routes Bitcoin-lane assets to the mature Bitcoin send
via a handoff card. The goal: make the dormant `dapp/confidential-unified-send.js` actually
execute every lane in one box, driven by tested drivers — WITHOUT a big-bang rewrite of the
live Bitcoin send.

## Why staged, not big-bang

The EVM lane is already inline and atomic. The Bitcoin lane is a live, fund-sensitive flow
(silent-payment derivation, UTXO funding, PSBT signing, broadcast). The risk is not the
routing — `confidential-unified-send.js` is written and its `dispatchSend`/`resolveLeg`
logic is clean — it's the *drivers* the dispatch calls. So the plan is: extract each driver
as a small, independently-testable seam, verify on signet, then flip the handoff into inline
execution. One lane at a time.

## The dispatch contract (already built)

`makeUnifiedSend(deps)` in `confidential-unified-send.js` needs six injected deps:

- `parseRecipient(raw, {network, chainHint})` — EXISTS (tacit.js:49610).
- `currentNetworkName()` — EXISTS.
- `isCrosslaneConfigured(network)` — EXISTS as `_crosslaneConfigured` (tacit.js).
- `getPoolUx()` → ux | null — the confidential-pool ux (or null when gated). Trivial.
- `buildAndBroadcastCXferMulti({assetIdHex, recipients, ...})` — EXISTS (tacit.js:27610).
  This is the SAME function the current Bitcoin token send already uses. Low risk.
- `sendSats({parsed, amountSats, opts})` → `{txid}` — DOES NOT EXIST as a single callable.
  This is the one genuinely new seam. `parsed` is the resolved leg: either
  `{path:'sats-p2wpkh', address}` or `{path:'sats-sp', scanPub, spendPub}`.

The dispatch already handles: recipient parsing, the ambiguous-pubkey case, the EVM gate,
`resolveLeg` per asset lane, and the EVM wrap-or-transfer two-phase path. So the work is the
`sendSats` seam plus UI, not the routing brain.

## Work items

### 1. Extract `sendSats` (the only new driver)

Wrap the existing Bitcoin send machinery into one function:

```
async function sendSats({ parsed, amountSats, opts }) {
  // sats-p2wpkh: send straight to parsed.address
  // sats-sp:     derive the one-time P2TR output via senderComputeSilentPaymentOutput
  //              (tacit.js:5094), then send to that scriptPubKey
  // → fund UTXOs, build+sign+broadcast, return { txid }
}
```

Reuse, do not reimplement: the wallet's `sendSats(toAddress, sats)` (tacit.js:2294) already
funds+signs+broadcasts a plain send; the silent-payment case just computes the destination
scriptPubKey first via `senderComputeSilentPaymentOutput`. Keep `ensureSatsFunded` /
fee-estimation in the path they already live in. This seam should be a thin adapter, ~40 lines.

Test on signet: (a) P2WPKH send, (b) silent-payment send that the recipient's scan detects.

### 2. Wire `makeUnifiedSend` in tacit.js

Instantiate once with the six deps; expose the instance (e.g. pass `dispatchSend` into the
Send tab via the existing `helpers` bag, alongside `resolveRecipient`/`openBridge`). No new
globals if avoidable.

### 3. Unified asset list (span all lanes)

The dropdown must list: pool assets (already via `ux.assets`) + Bitcoin-native tacit assets
(from `scanHoldings`) + a sats entry. Build one normalized descriptor list:

```
{ kind:'pool', assetId, ticker }   // EVM lane
{ kind:'btc',  assetId, ticker }   // Bitcoin-native CXFER
{ kind:'sats' }                    // plain BTC
```

`laneOfAsset` in the dispatch already consumes exactly this shape. Group by lane in the
<select> (optgroups) so the box reads asset-first.

### 4. Flip the handoff into inline execution

Replace the `#csend-btc-handoff` card with the same To/amount row, and on submit call
`dispatchSend({ wallet, recipientRaw, asset, amount, opts })`. Per-lane UI nuances:

- **btc asset**: offer the shielded/stealth-address recipient option (parseRecipient already
  yields `cxfer-stealth` vs `cxfer-pubkey`); amounts are the asset's own units.
- **sats**: recipient is a bech32 or silent-payment address; amount in sats.
- **pool**: unchanged (the inline path today).

Amount decimals differ per lane — reuse each lane's existing unit handling; do NOT unify into
one decimal assumption.

### 5. Handle the two soft-fail shapes the dispatch returns

`dispatchSend` returns `{ ok:false, ambiguous, candidates }` (pubkey valid on both chains →
show a Bitcoin/Ethereum chooser) and `{ ok:false, blocked }` (EVM gated → the existing
inert message). Wire both into the status line; they are already modeled, just surface them.

## Non-goals / guardrails

- No new crypto. Every lane calls an existing, tested builder; `sendSats` is an adapter, not
  a new signer.
- Keep the mature Bitcoin transfer tab as-is during rollout — the unified box delegates to the
  same drivers, so both can coexist until the unified box is signet-proven, then the subtab can
  become a thin alias or drop.
- Ship behind the same gates: EVM lane stays `_crosslaneConfigured`-gated; nothing flips live
  without the pool deploy.

## Sequence

1. `sendSats` adapter + signet tests (P2WPKH + silent payment).  ← the only real risk, do first
2. Wire `makeUnifiedSend`; expose `dispatchSend` to the Send tab.
3. Unified asset list + optgroup dropdown.
4. Flip handoff → inline; wire ambiguous/blocked results.
5. Signet dry-run across all three lanes; then retire/alias the Bitcoin subtab.
</content>
