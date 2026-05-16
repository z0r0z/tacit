# T_SLOT_MINT / T_SLOT_BURN / T_SLOT_ROTATE deployment notes

Self-custody slot wrapper (SPEC-CBTC-ZK-AMENDMENT, opcodes `0x43` /
`0x44` / `0x45`) — operational checklist for shipping the cBTC.zk slot
wrapper to signet first, then mainnet after a clean signet pass.

The slot wrapper adds atomic mint / redeem / transfer of wrapped BTC
where the mixer note's `r_leaf` IS the spending key of the backing
P2TR UTXO. No federation, no oracle threshold, no co-signer at
redemption.

## Pre-deploy

1. **Branch clean, all tests green.**
   ```sh
   git status   # should be clean
   cd tests && npm run test:fast
   ```
   Expect 0 failures. The slot suite alone (`slot-wrapper.test.mjs`,
   77 checks) covers wire-format round-trip for all three opcodes,
   `K_btc = recipient_commit − denom·H = r_leaf·G` identity,
   P2TR scriptpubkey shape, and decoder rejection of malformed inputs.

2. **Offline rehearsal passes.**
   ```sh
   cd tests && node slot-rehearsal-signet.mjs
   ```
   Expect `32 passed, 0 failed.` Verifies the BIP-341 key-path sighash
   + Schnorr-sign-with-r_leaf path end-to-end against synthetic txs —
   the same algorithm a Bitcoin full node will run on the live spend.
   Add `VERBOSE=1` for per-tx printout, `SEED=<hex64>` for deterministic
   identities across runs.

3. **Spec amendment merged first.** `spec/amendments/SPEC-CBTC-ZK-AMENDMENT.md`
   should land on `main` separately from the worker/dapp implementation so
   anyone reading the wire format isn't reading a dirty diff. Implementation
   PR then merges with the spec already in place.

4. **Re-read the load-bearing pieces.** Three surfaces materially affect
   runtime behavior — confirm each still reads sound:
   - Worker T_SLOT_MINT / BURN / ROTATE cron-side validation —
     `worker/src/index.js:11020–11242`. The MINT branch must verify
     `tx.vout[0].scriptpubkey == slotScriptPubKey(slotXOnly(K_btc))` and
     `tx.vout[0].value == denomination` before accepting any leaf.
   - Dapp builders `buildSlotMintEnvelope` / `buildSlotBurnEnvelope` /
     `buildSlotRotateEnvelope` — `dapp/tacit.js:6757–6899`. The mint
     builder derives `K_btc` from `recipient_commit` and returns the
     `slotScriptPubKey` that the caller must place at vout[0] in the
     funding tx.
   - BIP-341 key-path signer pair: `tapSighashKeyPath` +
     `signTaprootKeyPathInputWithKey` — `dapp/tacit.js:4668–4740`. The
     redeem flow signs with `r_leaf` (the mixer's secret scalar) NOT
     `wallet.priv`. Witness layout: `[sig64]` for SIGHASH_DEFAULT,
     `[sig64||0x01]` for SIGHASH_ALL.

## Order of operations

**Worker first, then dapp.** Reverse order would leave old-worker
indexers writing pre-amendment entries (which entirely lack slot
recognition) that would have to be back-filled. Worker is also
forward-compatible — pre-amendment indexers see opcodes `0x43`–`0x45`
as unknown envelopes (SPEC §4.1 forward-compat) and just skip them, so
deploying the worker first is safe even if old dapp clients are still
in circulation.

### 1. Worker deploy

```sh
cd worker
npx wrangler deploy
```

Watch for:
- Successful upload of `src/index.js`
- KV namespaces still bound (`UPLOAD_KV` + `REGISTRY_KV`)
- Cron trigger still wired (`*/5 * * * *`)
- No new env vars required (the slot wrapper reuses the existing mixer-
  pool init + nullifier KV namespaces — keys `slot:<network>:…` are a
  fresh prefix that won't collide)

### 2. Optional KV cleanup (signet only — first deploy)

If signet KV has stale `slot:` entries from earlier branches (pre-amendment
prototypes), wipe them so the indexer rebuilds with the canonical schema.
Skip on mainnet — no production data exists there yet.

```sh
# List stale entries (safe — read-only)
npx wrangler kv:key list --binding=REGISTRY_KV --prefix=slot:

# Wipe if any are present
npx wrangler kv:key list --binding=REGISTRY_KV --prefix=slot: | \
  jq -r '.[].name' | xargs -I {} npx wrangler kv:key delete --binding=REGISTRY_KV {}
```

Then trigger a rescan starting from the block where the amendment deploys:
```sh
curl -X POST 'https://tacit-pin.rosscampbell9.workers.dev/rescan?from=<signet-deploy-block>&network=signet'
```

### 3. Dapp deploy

Static bundle — same surface as every other dapp ship:
- `dapp/index.html`
- `dapp/tacit.js`
- `dapp/prf-wallet.js`
- `dapp/vendor/tacit-deps.min.js`

**Re-build vendor bundle first** only if dependencies changed (this
amendment didn't touch them, but verify):
```sh
cd build && npm run build
```

**Pin to IPFS** (production):
```sh
cd dapp
ipfs add -r .
```
Update DNS / domain mapping to the new CID.

**Or push to host** (Render / static):
```sh
git push origin <branch>
# then trigger deploy via host webhook or merge to main
```

## Network-tag handling

The slot opcodes carry an explicit 1-byte `network_tag` to prevent
cross-network replay even when an attacker manages to mint the same
`asset_id` on two networks:

| `network_tag` | meaning |
|---|---|
| `0x00` | mainnet |
| `0x01` | signet |
| `0x02` | regtest |

The dapp derives this from `NET.name` at envelope build time; the
worker derives it from the URL-side `?network=` parameter at cron
scan time. A mismatch causes the worker decoder to skip the envelope
(see `worker/src/index.js` ~line 11155, `if (sm.network_tag !==
expectedNetTag) continue`). No live state moves until both sides
agree.

If you operate a dapp build that targets signet by default but lets
users flip to mainnet, the existing `tacit-network-v1` localStorage
key drives `NET.name` — no slot-specific config needed.

## Post-deploy verification (signet)

The offline rehearsal (`slot-rehearsal-signet.mjs`) validates everything
up to the broadcast boundary. To exercise the live path on signet:

### Step S-1 — Worker recognizes a slot mint

1. With the post-deploy worker, run the rehearsal once locally and copy
   the `mintOut.payload` bytes + `mintOut.slotScriptPubKey` from a
   `VERBOSE=1` run.
2. Construct (or have a signet-funded LP construct) a Bitcoin tx with:
   - `vout[0] = (value=denomination, script=slotScriptPubKey)`
   - `vout[1] = OP_RETURN || PUSHDATA(<envelope payload>)`
   - `vout[2] = change to LP`
3. Broadcast on signet.
4. After ≥3 confirmations + the next cron tick (≤5 min), GET
   `https://tacit-pin.rosscampbell9.workers.dev/mixer-leaves?network=signet&asset_id=…&denomination=…`
   and confirm the leaf appears with the canonical leaf-commitment from
   the envelope.

### Step S-2 — Slot redeem (T_SLOT_BURN)

1. With the mint's `slotRecord` in hand, build a `buildSlotBurnEnvelope`
   payload off the corresponding mixer Groth16 proof (per SPEC §5.22).
2. Construct a Bitcoin tx that:
   - Input 0: spends the mint tx's vout[0] (the slot UTXO).
   - vout[0]: pays the redeemer's wallet (P2WPKH or P2TR — any standard
     output type).
   - vout[1]: `OP_RETURN || PUSHDATA(<burn envelope>)`.
3. Sign input 0 with `signTaprootKeyPathInputWithKey(tx, 0, prevouts,
   r_leaf, 0x00)`. Witness must be a single 64-byte element.
4. Broadcast. After confirmation + cron tick, the worker's
   `slot:<…>:<x-only>` entry flips `status: "live"` → `status: "redeemed"`
   and the nullifier appears under `nullifier:<…>`. Re-attempting the
   same redeem produces a structurally valid tx that the dapp validator
   rejects as double-spend.

### Step S-3 — Slot rotation (T_SLOT_ROTATE)

1. Build `buildSlotRotateEnvelope` with the live slot's `slotRecord` as
   `oldSlotRecord` and fresh `newSecret` / `newNullifierPreimage`.
2. Construct a tx that:
   - Input 0: spends the old slot UTXO.
   - vout[0]: pays to the **new** slot scriptpubkey at the same
     denomination value.
   - vout[1]: `OP_RETURN || PUSHDATA(<rotate envelope>)`.
3. Sign input 0 under the OLD `r_leaf`. Broadcast.
4. After confirmation: the old slot's KV record flips to `status:
   "rotated"`, the new slot's KV record appears as `status: "live"`
   with `rotation_predecessor_nullifier` populated. The mixer leaves
   count increments by exactly one (new leaf in) and the nullifier set
   increments by exactly one (old leaf consumed) — net supply zero.

## Rollback

Both worker and dapp are atomic deploys:
- **Worker rollback:** `npx wrangler rollback` restores the previous
  version. New-shape `slot:<…>` keys in KV become silently unused (the
  pre-amendment worker doesn't read them); they don't corrupt anything.
- **Dapp rollback:** point DNS back at the previous IPFS CID, or
  `git revert` and re-deploy. Old dapp clients pick up the rolled-back
  bundle on next reload. Slot UTXOs minted under the new dapp remain
  spendable by anyone who saved the `slotRecord` JSON (the rotation /
  burn flow is just a Bitcoin Schnorr key-path spend under `r_leaf` —
  any signer can drive it from the persisted secrets).

KV state changes are forward-only — rolling back the worker doesn't
delete the new-shape slot keys. They'll be ignored by the old worker's
indexer; the dapp re-derives slot status from `recipient_commit`
independently, so rollback doesn't strand any user's slot.

## Mainnet promotion

**Only after** at least one full week of clean signet behavior:
- ≥5 successful T_SLOT_MINT operations
- ≥3 successful T_SLOT_BURN redemptions
- ≥1 successful T_SLOT_ROTATE transfer
- One reorg observed at the depth-3 boundary (signet has frequent
  ~2-3 block reorgs; verify the slot's `status` field correctly
  reverts on a reorg that orphans the mint tx)
- Funding-input policy decided for the production minter UX (whose
  signet sats fund the LP-side input on every mint? — see "Known
  v1 limitations" below)

Mainnet `wrangler deploy` doesn't need a separate flag — the worker
indexes both signet and mainnet from the same cron tick. The dapp's
`NET.name === 'mainnet'` runtime check determines which URL prefix it
queries and which `network_tag` byte it stamps into every envelope.

## Known v1 limitations (document for users)

- **Lost-note permanence.** If the holder of a slot loses the
  `(secret, ν)` pair, the backing BTC is permanently unspendable. This
  is the structurally-most-trustless tradeoff the amendment explicitly
  accepts — same property native Bitcoin has, parallels WETH-on-Ethereum.
  The dapp must surface this clearly in the slot-mint UI before commit.

- **Funding-input source.** The funding tx that creates the slot UTXO
  consumes some Bitcoin-side UTXO whose value covers the
  `denomination` + fees. v1 expects this input to come from the
  minting user's own wallet (i.e. they're wrapping their own BTC).
  An LP-mediated mint flow (someone-else-funds-the-slot in exchange
  for the user's tac payment) is a future iteration.

- **No GET /slots endpoint yet.** The worker writes `slot:` KV entries
  but doesn't yet expose a `GET /slots?network=…&asset_id=…` listing.
  Dapp clients can scan their own `slotRecord` JSON (persisted at mint
  time) and check on-chain status via `/mixer-leaves` + `/mixer-nullifiers`.
  A direct slot listing is a small follow-up (`server/src/index.js` would
  add ~30 lines using `slotRegistryPrefix`).

- **Worker dependency for slot-status display.** Without the worker, the
  dapp treats every slot as `status: unknown` and falls back to direct
  Bitcoin-side checks (does the UTXO at the derived P2TR address still
  exist?). The dapp's redeem path is structurally complete without the
  worker — only the UI's `status` chip needs it.

## Surfaces that did NOT change

- Existing CETCH (0x21), T_MINT (0x24), T_BURN (0x25), CXFER (0x23),
  T_AXFER (0x26), T_PETCH (0x27), T_PMINT (0x28), T_DROP (0x2B),
  T_DCLAIM (0x2C), T_DEPOSIT (0x40), T_WITHDRAW (0x41), T_POOL_INIT
  (0x42) opcodes.
- `/assets`, `/assets/:id/listings`, `/assets/:id/atomic-intents`,
  `/mixer-leaves`, `/mixer-nullifiers`, `/petch-assets`, all marketplace
  + mixer endpoints.
- Wallet seed/key recovery flows.
- Holdings, Send, Market, Activity, Mixer tabs (other than any new slot
  UI bits paired with this deploy).

If a user reports a regression on any of those surfaces, it's almost
certainly unrelated to this amendment — investigate independently.
