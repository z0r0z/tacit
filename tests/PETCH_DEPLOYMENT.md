# T_PETCH / T_PMINT deployment notes

Permissionless fair-launch (SPEC §5.8 / §5.9) — operational checklist for
shipping the `feature/petch` branch to signet first, then mainnet after a
clean signet pass.

## Pre-deploy

1. **Branch clean, all tests green.**
   ```sh
   git checkout feature/petch
   git status   # should be clean
   cd tests && npm run test:fast
   ```
   Expect 270+ tests across 19 files, 0 failures. The petch-pmint suite
   alone covers depth-gating, tx_index ordering, cap-overflow, reorg
   simulation, and decoder-shape contracts.

2. **Spec PR merged first.** SPEC.md changes (§5.8, §5.9, §10 KV-cap note)
   should land on `main` separately from the implementation so anyone
   reading the wire format isn't reading a dirty diff. Implementation PR
   then merges with the spec already in place.

3. **Re-read the audit fixes.** Six changes that materially affect runtime
   behavior — confirm each still reads sound:
   - Worker cron-side T_PMINT validation (asset_id derivation + parent-T_PETCH + height window) — `worker/src/index.js` ~line 3960
   - KV key now embeds `(height, tx_index, txid)` — `pmintKeyFor` at `worker/src/index.js:226`
   - Slim `creditedOnly` response carries `cap_overflow_txids` — `worker/src/index.js` ~1761
   - Dapp `validateOutpoint` tags failures as `'pending'` vs `'invalid'` via `pmintStatusOut` — `dapp/tacit.js` ~3740
   - `_scanHoldingsImpl` routes pending T_PMINTs to `h.pending` (recovery runs) instead of `h.inflated` — `dapp/tacit.js` ~4106
   - `buildAndBroadcastPmint` now calls `registerAsset` so freshly-minted UTXOs render with the correct ticker — `dapp/tacit.js` ~4836

## Order of operations

**Worker first, then dapp.** Reverse order would leave old-worker indexers
writing pre-fix entries (no tx_index, no validation) that would persist
under the new dapp's reads. KV is forward-compatible (the new key shape
is a superset; old keys without tx_index lex-sort below new ones at the
same height because the padding makes the missing segment shorter), but
the cleaner sequence is to make the worker the leader.

### 1. Worker deploy

```sh
cd worker
npx wrangler deploy
```

Watch for:
- Successful upload of `src/index.js`
- KV namespaces still bound (`UPLOAD_KV` + `REGISTRY_KV`)
- Cron trigger still wired (`*/5 * * * *`)
- No new env vars required (this feature uses existing infrastructure)

### 2. Optional KV cleanup (signet only — first deploy)

If signet KV has stale T_PETCH/T_PMINT test entries from earlier branches
(pre-audit-fix), wipe them so the indexer rebuilds with the new schema.
Skip on mainnet — no production data exists there yet.

```sh
# List stale entries (safe — read-only)
npx wrangler kv:key list --binding=REGISTRY_KV --prefix=petch:
npx wrangler kv:key list --binding=REGISTRY_KV --prefix=pmint:

# Wipe if any are present and from old schema
npx wrangler kv:key list --binding=REGISTRY_KV --prefix=petch: | \
  jq -r '.[].name' | xargs -I {} npx wrangler kv:key delete --binding=REGISTRY_KV {}
npx wrangler kv:key list --binding=REGISTRY_KV --prefix=pmint: | \
  jq -r '.[].name' | xargs -I {} npx wrangler kv:key delete --binding=REGISTRY_KV {}
```

Then trigger a rescan:
```sh
curl -X POST 'https://tacit-pin.rosscampbell9.workers.dev/rescan?from=<signet-block-where-feature-deploys>&network=signet'
```

### 3. Dapp deploy

The dapp is a static bundle:
- `dapp/index.html`
- `dapp/tacit.js`
- `dapp/prf-wallet.js`
- `dapp/vendor/tacit-deps.min.js`

**Re-build vendor bundle first** (only if dependencies changed; this
feature didn't touch them, but verify):
```sh
cd build && npm run build
```

**Pin to IPFS** (production):
```sh
cd dapp
ipfs add -r .   # captures the updated CID
```
Update DNS / domain mapping to the new CID.

**Or push to host** (Render / static):
```sh
git push origin feature/petch
# then trigger deploy via the host's webhook or merge to main
```

## Post-deploy verification (signet)

Run the new sections of `tests/signet-smoke.md`:

### Step 11 — Public-mint deploy (T_PETCH)

1. Etch tab → "etch · public mint (fair launch)" panel.
2. Fill: ticker `FAIR`, decimals `0`, cap `1000`, per-mint `100`.
3. Confirm the divisibility hint reads "10 mints will reach the cap".
4. Click "Deploy public-mint asset".
5. After ≤5 min, Discover tab shows the new asset under "fair launch · public-mint assets" with `0 / 1000` minted, progress bar empty, Mint button enabled.

### Step 12 — Mint claim (T_PMINT)

1. Click "Mint 100 FAIR" on the Discover petch tile. Approve confirm + funding.
2. **Immediately** check Holdings tab for the deployed asset.
   - **Audit-fix-#1 verification:** the new UTXO must show under a
     **purple "⏳ N mints pending cap-credit" banner**, NOT the red
     "⚠ Inflation attempt detected" warning. Pre-fix this was the bug;
     this is the gate that proves the fix is live.
   - The asset card must show the `⚡ public mint` badge inline with the
     ticker (audit fix A). The Cap row shows `1000 FAIR · per mint 100`.
3. Wait for ≥3 confirmations + the next cron tick (≤5 min).
4. Refresh Holdings. The pending banner disappears; the UTXO promotes to
   normal balance. Discover petch tile updates to `100 / 1000` minted.

### Step 13 — Same-block tx_index ordering (audit fix #2)

This is the hardest scenario to set up manually but the most consequential:

1. Open two browser profiles, each with a wallet of its own. Both attempt
   to mint the **last available cap slot** in the same Bitcoin block (use
   a near-cap asset created in Step 12).
2. After confirmation, the wallet that broadcast with the **lower
   tx_index** in the block (typically the one that confirmed first
   in mempool) sees the credited UTXO; the other sees a permanently-
   `cap_overflow` mint that never promotes from the inflated tier.
3. Pre-audit-fix: this could be wrong (txid lex order winning instead
   of tx_index). Post-fix: tx_index always wins.

Hard to engineer reliably — accept that the unit tests in
`tests/petch-pmint.test.mjs` cover the same invariant under controlled
conditions ("same-block ordering uses tx_index even when txid order
disagrees").

### Step 14 — Deployer-same-block defense (audit fix #4)

1. Open the dapp DevTools console. Construct a T_PMINT envelope manually
   that targets a fresh T_PETCH at the SAME block height as the etch
   (programmatically — call `buildAndBroadcastPmint({etchTxidHex})`
   in the same block window as the deploy).
2. After both confirm, refresh Discover.
3. **Expected:** `/petch-assets` shows `0 / cap` minted. The cron's
   parent + height-window check rejected the same-block T_PMINT at index
   time. Pre-fix: the cap counter would have incremented even though the
   dapp's wallet validator correctly refused the UTXO.

## Rollback

Both worker and dapp are atomic deploys:
- **Worker rollback:** `npx wrangler rollback` restores the previous version.
- **Dapp rollback:** point DNS back at the previous IPFS CID, or `git revert` and re-deploy. Old dapp clients pick up the rolled-back bundle on next reload.

KV state changes are forward-only — rolling back the worker doesn't
delete the new-shape pmint keys. They'll be ignored by the old worker's
loader (it doesn't have `loadCanonicalPmints`), but `/petch-assets` calls
will 404 until the worker rolls forward again. No data corruption.

## Mainnet promotion

**Only after** at least one full week of clean signet behavior:
- ≥10 successful T_PETCH deploys
- ≥50 successful T_PMINTs across at least 3 distinct deploys
- At least one cap-fill scenario observed end-to-end
- Reorg behavior observed at least once (signet has frequent ~2-3 block
  reorgs; verify pending mints handle the depth-3 boundary correctly)

Mainnet `wrangler deploy` doesn't need a separate flag — the worker
indexes both signet and mainnet from the same cron tick. The dapp's
`NET.name === 'mainnet'` runtime check determines which URL prefix it
queries.

## Known v1 limitations (document for users)

- **Pending mint window.** Freshly-broadcast T_PMINTs surface as "pending cap-credit" until 3 Bitcoin confirmations + the next cron tick. Typical wait: 25–35 minutes on mainnet, 2–5 minutes on signet.
- **Worker dependency for cap correctness.** Without the worker, the dapp accepts T_PMINT UTXOs on structural invariants alone (no cap-overflow rejection). SPEC §10 documents this.
- **KV.list 1000 cap.** Single-page list; assets accruing > 1000 confirmed mints under-count cumulative_minted. SPEC §10 documents the patch path.
- **Reorg cleanup.** Orphaned T_PMINT events linger in KV after reorgs; the depth-≥3 gate masks most cases but a deep reorg (rare) could leave stale entries that aren't auto-cleaned.

## Surfaces that did NOT change

- Existing CETCH (0x21), T_MINT (0x24), T_BURN (0x25), CXFER (0x23), T_AXFER (0x26) opcodes.
- `/assets`, `/assets/:id/listings`, `/assets/:id/atomic-intents`, all marketplace endpoints.
- Wallet seed/key recovery flows.
- Holdings, Send, Market, Activity tabs (other than the new petch UI bits).

If a user reports a regression on any of those surfaces, it's almost
certainly unrelated to this feature — investigate independently.
