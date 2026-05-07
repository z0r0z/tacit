# tacit signet smoke checklist

Manual end-to-end walkthrough for release validation. The automated test suite
in this directory pins primitives, wire format, validator soundness, and dApp ↔
test-mirror parity — but it's all offline against synthesised txs. This
checklist exists to catch the things automation can't:

- **Wire format actually round-trips through Bitcoin** — txs broadcast, confirm,
  and parse back identically.
- **mempool.space API contract drift** — JSON shape changes that would silently
  break envelope decoding or holdings recovery.
- **External wallet integration** — Xverse / UniSat / Leather actually sign
  and broadcast as the dApp expects.
- **Recovery from chain alone** — the §6 promise that a wallet with only its
  privkey can recover full balance, with no localStorage.

Run before each tagged release. Cost: ~30 min, ~50k signet sats from the
faucet (no value).

## Prerequisites

- Working signet sats supply (>= 50k). Use the dApp's built-in `/drip` button
  if balance is low, or any signet faucet (`signetfaucet.com`).
- `dapp/vendor/tacit-deps.min.js` is up-to-date (`cd build && npm run build`).
- All offline tests pass (`cd tests && npm test`).
- A second browser profile / private window for the recipient role in CXFER.

## Step 0 — KAT fail-closed gate

1. Load the dApp.
2. Open DevTools → Network → reload — confirm `tacit-deps.min.js` is fetched
   from the same origin (no CDN).
3. Modify `tacit-deps.min.js` locally to corrupt one byte of a noble export
   (e.g. via a service-worker stub).
4. Reload the dApp.
5. **Expected:** the page renders the red "tacit refuses to start" banner
   instead of the wallet UI.

If this passes, the `runStartupKAT()` defense is wired correctly.

## Step 1 — Etch a fixed-supply asset (CETCH, mint_authority = 0)

1. On the Wallet tab, set network to **signet**, ensure burner key has been
   exported + acknowledged.
2. Etch tab → ticker `SMOKE`, decimals `0`, supply `1000`, mintable
   **unchecked**, image URI optional.
3. Click "Etch & broadcast". Approve the JIT funding popup if prompted.
4. **Expected on-chain:**
   - Two txs: commit (P2WPKH → P2TR + change) and reveal (P2TR script-path
     spend → P2WPKH dust at vout 0).
   - Reveal `vin[0].witness` is `[schnorr_sig(64), envelope_script, control_block]`.
   - Envelope script bytes 0–4 after the `OP_FALSE OP_IF` push are `TACIT`.
   - First payload byte is `0x21` (T_CETCH).
   - Last 32 bytes of the CETCH payload (`mint_authority`) are all-zero.
5. **Verification:** copy the reveal txid, open `https://mempool.space/signet/tx/<txid>`,
   inspect witness. Use `xxd` on `vin[0].witness[1]` to confirm magic + opcode.
6. **dApp side:** the etched asset appears in Holdings tab with the correct
   balance and ticker. The opening (supply, blinding) is in localStorage.

## Step 2 — Etch a mintable asset (CETCH with mint_authority)

Same as Step 1, but **mintable checked**. Confirm:

- Reveal envelope's last 32 bytes of CETCH payload (`mint_authority`) equals
  the wallet's x-only pubkey (= `wallet.priv` → `getPublicKey(true)` → `[1..33]`).
- Holdings tab shows a "Mint" affordance for this asset (mintable variant).

## Step 3 — Mint additional supply (T_MINT)

1. From Holdings → click Mint on the asset etched in Step 2.
2. Mint amount: `500`. Approve broadcast.
3. **Expected on-chain:**
   - Two more txs: a fresh commit + reveal pair.
   - Reveal envelope opcode = `0x24` (T_MINT).
   - Payload's `etch_txid` matches Step 2's reveal txid.
   - Payload's `asset_id` matches `sha256(etch_txid_BE || 0x00000000)` (vout=0_LE).
   - `issuer_sig` (last 64 bytes of payload) verifies under `mint_authority`
     from Step 2's CETCH envelope, **bound to** `commit_anchor` =
     `commit_tx.vin[0].outpoint`.
4. **dApp side:** Holdings balance for this asset increases by 500.
5. **Replay-rejection sanity:** in DevTools, manually copy the T_MINT envelope
   bytes and try to re-broadcast them via a fresh Taproot input you control.
   The dApp's validator (and any conforming indexer) must reject — the
   `commit_anchor` of your fresh tx differs from what the original issuer
   signed (SPEC §5.3).

## Step 4 — Transfer (CXFER) to a second wallet

1. Open dApp in a second browser profile / private window. Note the address
   (`tb1q…`) and pubkey (33-byte hex).
2. Back in the original browser → Transfer tab → asset = SMOKE (Step 1),
   recipient pubkey = the second wallet's pubkey, amount = 250.
3. Click "Transfer & broadcast". Note the share-link the dApp surfaces.
4. **Expected on-chain:**
   - Two txs: commit + reveal.
   - Reveal envelope opcode = `0x23` (T_CXFER).
   - Reveal `vin.length` = 2 (commit P2TR + 1 asset input from the wallet's
     SMOKE supply).
   - Envelope contains 2 outputs (recipient + sender change), each with
     33-byte commitment + 8-byte amount_ct.
   - `kernel_sig` verifies under `E'.x_only()` where
     `E' = (Σ output commitments) − (Σ input commitments)`.
   - Aggregated bulletproof at the end (~754 bytes for m=2).
5. **Recipient side:** paste the share-link into the second browser's "Import
   share-link" modal. Holdings tab should populate the SMOKE balance = 250.
6. **Sender side:** Holdings shows SMOKE balance = 750 (change auto-recovered
   via `tacit-change-v1` derivation).

## Step 5 — Recipient recovery from privkey alone

Critical test for SPEC §6.

1. Recipient browser: Wallet tab → Export key → copy hex.
2. Clear all localStorage for the dApp origin (`localStorage.clear()` in
   DevTools console).
3. Reload. Wallet card asks for new wallet — choose "Import existing".
4. Paste the hex from step 1, set a passphrase.
5. **Expected:** Holdings tab populates SMOKE = 250 within a few seconds,
   recovered via the `tacit-blind-v1` ECDH derivation against the sender's
   pubkey at `vin[1].witness[1]`. No share-link reimport needed.

If this fails, the recovery walker is broken — chain-only recovery is the
core SPEC §6 promise.

## Step 6 — Burn (T_BURN)

1. Sender browser → Holdings → Burn on SMOKE.
2. Burn amount: `100`. Approve.
3. **Expected on-chain:**
   - Reveal envelope opcode = `0x25` (T_BURN).
   - `burned_amount` field (8-byte LE u64 right after asset_id) = `100`.
   - 1 output (sender change with N=1) carrying remaining 650 SMOKE.
   - `kernel_sig` verifies under `E' = burn·H + Σ_out − Σ_in`.
4. **dApp side:** Holdings shows SMOKE = 650.

## Step 7 — Burn-everything (T_BURN with N=0)

1. Sender → Burn all remaining SMOKE (650).
2. **Expected on-chain:**
   - T_BURN envelope with `N = 0` (no commitment outputs, no rangeproof).
   - `burned_amount` = 650.
   - Reveal tx still has at least one output (sat change to sender).
3. **dApp side:** SMOKE removed from Holdings.

## Step 8 — Disclosure publish + consumer verify

For the asset etched in Step 2 (still mintable, balance > 0):

1. Holdings → "Prove balance ≥ K" → choose K = 100.
2. dApp computes the bulletproof and POSTs to the worker's
   `/assets/:asset_id/disclosures` endpoint.
3. **Expected on worker:** 200 OK response with disclosure record.
4. **Consumer-side verification:** in any other browser, fetch
   `${WORKER_BASE}/assets/${asset_id}/disclosures?network=signet`.
5. Run the disclosure record through `verifyDisclosure(record, fetchTx)` (the
   reference verifier in `dapp/tacit.js`). **Expected:** `{ ok: true }`.
6. Tamper one byte of the rangeproof in the response; re-run. **Expected:**
   `{ ok: false, reason: 'rangeproof does not verify against C_sum − K·H' }`.

## Step 9 — Listing publish + claim

1. Holdings → "List for sale" on a UTXO. Set price (sats), expiry, maker
   address (use the wallet's bc1 address derived from the ext wallet, or the
   tacit P2WPKH address as fallback).
2. **Expected on worker:** opening + listing stored, both sigs verified by the
   worker before persisting.
3. From a second browser, fetch `/assets/:asset_id/listings`.
4. POST to `/assets/:asset_id/listings/:txid/:vout/claim` from the second
   browser → 200 OK + claim record.
5. POST a second claim from a *third* taker pubkey → 409 with `claim` info.

## Step 10 — Atomic intent (open) round-trip

The atomic-intent open path was 100% broken in production for an unknown
stretch because `handleAtomicIntentPost` read `ax.assetInputCount` (camelCase)
against a `decodeAxferPayload` returning `asset_input_count` (snake_case) — JS
silently returned `undefined` and the worker rejected every valid maker post
with `"assetInputCount must be 1 ... (got undefined)"`. Offline tests never
exercised the handler end-to-end, only the message-byte parity. Hit the live
flow on every release until we have a fixture-driven worker integration test.

**Setup.** You need two browser profiles: maker (with a SMOKE balance from
Step 4) and taker (with ≥ 60k signet sats and an empty atomic-intents tab).

1. **Maker — open the intent.**
   1. Holdings → choose a SMOKE UTXO → "Sell atomically (open intent)".
   2. Set amount = 100, price = 30000 sats, expiry = +1 day.
   3. dApp constructs:
      - A commit tx funding a P2TR (script-path) output that holds the taker's
        eventual sat payment.
      - An unsigned AXFER reveal: 1 asset input (the chosen UTXO), 1 tacit
        output (taker's commitment).
   4. Approve the commit broadcast. Note the `intent_id` the dApp surfaces.
   5. **Expected on worker** (Network tab):
      - `POST /assets/:asset_id/atomic-intents?network=signet` → 200.
      - Response body's `intent.asset_input_count` is omitted (the worker
        stores the AXFER opaquely), but `intent.envelope_script_hex` is the
        full AXFER script. Decode `payload[33]` (the byte after asset_id) — it
        must be `0x01`.
   6. **Regression sentinel:** if the response is `400 {"error":
      "asset_input_count must be 1 for atomic intent (got undefined)"}`,
      the field-name fix has been reverted. Stop the release.
   7. **Expected on-chain:** commit tx confirms; reveal is NOT broadcast yet.
2. **Taker — discover + claim.**
   1. Discover tab → atomic intents list shows the intent with maker's price
      + expiry + ticker.
   2. Click "Reserve". The dApp pre-flights a confirmed P2WPKH sat UTXO of
      value ≥ `price_sats` from the wallet, signs the v2 claim message
      (`'tacit-axintent-claim-v2'` || asset_id || intent_id || taker_pub ||
      taker_utxo_txid_BE || taker_utxo_vout_LE), and POSTs
      `/atomic-intents/:intent_id/claim` with `taker_utxo`. → 200 with 5 min TTL.
   3. **Regression sentinels:**
      - If the wallet has *no* single confirmed UTXO ≥ price, the dApp must
        refuse client-side with a clear "consolidate or fund first" message,
        not POST and let the worker reject.
      - If a malicious client POSTs without `taker_utxo`, worker → 400.
      - If `taker_utxo.value < intent.price_sats`, worker → 400 with the
        exact value mismatch.
      - If `taker_utxo` is not P2WPKH(hash160(taker_pubkey)), worker → 403.
   4. **Expected:** a second taker (different pubkey) tries to claim → 409
      with `claim.expires_at`.
3. **Maker — fulfil.**
   1. Maker's intents tab now shows "Reserved by `02…`". Click "Fulfil".
   2. dApp computes the partial reveal: rangeproof + ECDH-encrypted blinding
      for taker (XOR keystream of `r` against
      `tacit-axintent-blinding-v1` derivation).
   3. POST `/atomic-intents/:intent_id/fulfil` → 200.
   4. **Verify** `enc_recipient_blinding` is exactly 64 hex chars. The dApp
      must NOT send a cleartext `recipient_blinding` field — older clients did
      and leaked the amount; the worker now rejects those, but check the
      Network tab to confirm the dApp isn't regressing.
4. **Taker — take + broadcast.**
   1. Taker's intents → "Take". dApp fetches
      `/atomic-intents/:intent_id/fulfil`, decrypts blinding under taker's
      privkey + maker's pubkey ECDH.
   2. dApp completes the AXFER reveal: signs the sat-payment input under
      taker's key, attaches the maker-supplied script-path witness for the
      asset input. Broadcasts.
   3. **Expected on-chain:**
      - Reveal tx has 2 inputs (commit P2TR + taker sat input), 2 outputs
        (taker's tacit commitment + maker's sat payment).
      - Reveal envelope opcode = `0x26` (T_AXFER).
      - Envelope payload byte after asset_id (the `asset_input_count` byte) = `0x01`.
      - `kernel_sig` verifies; aggregated bulletproof at end (~688 bytes for m=1).
   4. **Maker side:** sat balance increases by 30000 (minus fees) after
      confirmation.
   5. **Taker side:** Holdings shows SMOKE = 100, recoverable from chain alone.
5. **Cancel path (separate intent).**
   1. Maker opens a second intent with no taker activity.
   2. Click "Cancel" → DELETE `/atomic-intents/:intent_id` with `cancel_sig`.
   3. **Expected:** worker → 200, intent disappears from Discover. The commit
      P2TR's sat output remains spendable by the maker via the cancellation
      path of the script-path tree.

## Step 11 — Mempool.space API contract sanity

1. In DevTools, watch the Network panel during a normal scan.
2. Confirm the dApp hits these endpoints:
   - `GET /address/{addr}/utxo` — array of `{ txid, vout, value }`
   - `GET /tx/{txid}` — has `vin[].witness` as hex strings array, `vout[].scriptpubkey` as hex
   - `POST /tx` — accepts hex, returns txid
3. If any of these now return a different shape, the dApp's parser may silently
   break. The unit tests can't catch this — only a live run can.

## Reporting failures

When any step fails:

1. Capture the broadcast tx hex from DevTools (the dApp logs commit + reveal
   hex to the console).
2. Capture the validator state for the failing UTXO: in DevTools, run
   `await validateOutpoint(txid, vout, new Map(), getTx)` and copy the
   `validatedSet`.
3. File an issue with: step number, expected vs observed, captured artifacts,
   `commit txid:vout` of the funding outpoint.

## What this checklist does NOT cover

- **Mainnet** — same checklist applies but the cost is real BTC. Run it on
  signet first, every release; on mainnet only after a clean signet pass.
- **Hardware wallet signing** — out of scope per SPEC §10 (v1.x+ feature).
- **Multi-recipient CXFER (m=4, m=8)** — validator accepts these, the dApp
  builder doesn't currently emit them. When that ships, add a step here.
- **Range-listing settlement path** — the listing flow at Step 9 stops at
  publish + claim; the buyer-pays-then-maker-cxfers handshake is off-chain
  coordination. For the atomic-settlement variant see Step 10.
