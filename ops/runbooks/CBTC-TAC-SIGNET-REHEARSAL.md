# cBTC.tac signet rehearsal (v1 lien model)

End-to-end signet validation of the §5.47 lien-based cBTC.tac flow:
T_LP_ADD → T_CBTC_TAC_DEPOSIT → T_CBTC_TAC_WITHDRAW → (optional)
T_CBTC_TAC_FORCE_CLOSE → T_CTAC_LIEN_CLAIM → T_LP_REMOVE.

This runbook walks through the operator-side staging needed to exercise
the full lifecycle against a live signet worker + Bitcoin signet chain.
Everything from the dapp + worker side is automated by the harness at
`tests/cbtc-tac-onchain-e2e-signet.mjs`; the operator's job is funding
+ assembling the pre-staged state.

## Prerequisites

- `.local/cbtc-tac-signet-test-wallets.json` (generate via
  `node tests/gen-cbtc-tac-signet-wallets.mjs` if absent)
- Funded depositor + recipient signet addresses (see "Funding" below)
- Worker reachable at `https://tacit.finance` (signet endpoint)
- One canonical (cBTC.zk-L, TAC) AMM pool registered on signet

## Step 0 — funding

The harness needs:

| Address | Role | Minimum sats | Why |
|---|---|---|---|
| Depositor | runs deposit + withdraw | ~300_000 | slot K_btc backing (~100k) + T_CETCH commit + T_LP_ADD commit + DEPOSIT commit + WITHDRAW commit + buffer |
| Recipient | (optional) receives transfer | ~20_000 | dust + receive-fee |

Faucets:
- https://signet.bublina.eu.org/
- https://alt.signetfaucet.com/
- https://signetfaucet.com/

Confirm funding lands by polling `https://mempool.space/signet/api/address/<addr>`
until `chain_stats.funded_txo_sum >= 300000` for depositor.

## Step 1 — CETCH a test TAC asset

```sh
TAC_RECIPIENT_PUB=$(node -e "process.stdout.write(require('./.local/cbtc-tac-signet-test-wallets.json').depositor.pub_hex)")
# Use the dapp UI or a CLI tool to T_CETCH a fresh asset with:
#   ticker: TAC
#   supply: 10_000_000_000  (10B base units — plenty for the test)
#   recipient: $TAC_RECIPIENT_PUB
```

Record the resulting `asset_id` (CETCH commit returns it):

```sh
echo '{"tacAssetIdHex": "<resulting asset_id hex>"}' \
  > .local/cbtc-tac-signet-state.json
```

## Step 2 — mint a cBTC.zk slot

Via the dapp UI's "Mint slot" section, or programmatically with the
slot-mint builder. Slot denomination: `100_000_000` sats (1 BTC tier, =
cBTC.zk-L canonical denom).

The slot mint produces:
- K_btc UTXO at `(mintTxid, 0)` holding `slot_denom_sats`
- A slot record in localStorage with `r_btc`, `r_pedersen`, `leafCommitmentHex`

Persist the slot record's `leafCommitmentHex` into the state file:

```sh
jq '.slotLeafHashHex = "<slot leaf hash>" | .slotMintTxid = "<mint txid>"' \
  .local/cbtc-tac-signet-state.json > /tmp/state.json
mv /tmp/state.json .local/cbtc-tac-signet-state.json
```

## Step 3 — T_LP_ADD on a (cBTC.zk-L, TAC) pool

Two sub-cases:

### 3a. Pool does not yet exist — POOL_INIT

Use the dapp's `AMM POOL_INIT` builder (`buildAndBroadcastLpAddPoolInit`)
with:
- asset_a = cBTC.zk-L canonical asset_id (the slot's asset_id from Step 2)
- asset_b = TAC asset_id from Step 1
- delta_a = the slot UTXO's full amount (after spending it as cBTC.zk input)
- delta_b = TAC amount such that the implied price meets the 2× target
- fee_bps = 30, capability_flags = 0

The POOL_INIT mints founder LP shares to the depositor's recipient pub.

⚠ **Don't use the rehearsal's depositor cBTC.zk slot as the LP input.**
Mint a SECOND cBTC.zk slot via Step 2 and use THAT slot's BTC for the LP
deposit. Otherwise you've spent the slot you needed for the rehearsal.

### 3b. Pool already registered — variant 0 LP_ADD

Use `buildAndBroadcastLpAdd` (variant 0) with the existing pool's pair.
Provide cBTC.zk + TAC inputs proportional to current pool reserves.

Record the LP-share UTXO outpoint + amount + blinding:

```sh
jq '.lpShareUtxo = {
  txid: "<lp_add reveal txid>",
  vout: 0,
  amount: "<minted lp shares>",
  blinding: "<lp share blinding hex>"
} | .lpShareAssetIdHex = "<pool lp_asset_id>"' \
  .local/cbtc-tac-signet-state.json > /tmp/state.json
mv /tmp/state.json .local/cbtc-tac-signet-state.json
```

## Step 4 — verify state file

```sh
cat .local/cbtc-tac-signet-state.json
```

Should look like:

```json
{
  "tacAssetIdHex": "abc123...",
  "slotLeafHashHex": "def456...",
  "slotMintTxid": "789abc...",
  "lpShareUtxo": {
    "txid": "fed321...",
    "vout": 0,
    "amount": "100000000",
    "blinding": "deadbeef..."
  },
  "lpShareAssetIdHex": "cab987..."
}
```

## Step 5 — run the E2E harness

```sh
node tests/cbtc-tac-onchain-e2e-signet.mjs
```

The harness will:
1. Pre-flight (wallet funded, slot record exists, LP-share UTXO present)
2. Build + broadcast T_CBTC_TAC_DEPOSIT envelope (no bond consumption)
3. Wait 60s for confirmation
4. Verify position state is `active` via worker
5. Verify lien is attached at `lpShareUtxo` outpoint via `/ctac/lien`
6. Build + broadcast T_CBTC_TAC_WITHDRAW envelope (spends slot K_btc)
7. Wait 60s for confirmation
8. Verify lien is released (no lien at lpShareUtxo outpoint)
9. Verify depositor BTC balance increased by slot_denom_sats (minus fees)

Expected output (last 5 lines):

```
✓ LIEN RELEASE VERIFIED: bond LP-share UTXO ...is no longer liened
depositor BTC balance: ... sats (had ... before)
=== smoke test complete ===
```

## Step 6 — extension scenarios

### 6a. Force-close path

After Step 5's deposit but BEFORE the cooperative withdraw, simulate
TAC price collapse by swapping cBTC.zk → TAC into the canonical pool
until the LP-share BTC value drops below `1.2× slot_denom_sats`. Then
call `T_CBTC_TAC_FORCE_CLOSE`:

```sh
# Via dapp force-close builder (or curl-construct the envelope)
node -e "
import('./dapp/tacit.js').then(async (dapp) => {
  // load wallet, ensure privkey
  const r = await dapp.buildAndBroadcastCbtcTacForceClose({
    targetLeafHashHex: '<slot leaf hash>',
    ammSwapMinBtcOut: 0n,                          // unused in v1
    liquidatorPayoutPubHex: null,                  // unused in v1
  });
  console.log(r);
});
"
```

Verify via `/ctac/lien` that lien transitioned to `state: claim-pool`.
Verify via `/ctac/state` that `claim_pool_lp_shares` increased.

### 6b. LIEN_CLAIM path

A cBTC.tac holder (the depositor, since they minted the cBTC.tac at
Step 2) burns shares to claim from the now-non-empty claim pool:

```sh
node -e "
import('./dapp/tacit.js').then(async (dapp) => {
  const r = await dapp.buildAndBroadcastShareSlashClaim({
    cbtcTacUtxos: [{ utxo: { txid: '<deposit reveal txid>', vout: 0 },
                     amount: <slot_denom_sats>,
                     blinding: '<mint blinding hex>' }],
    recipientPubHex: null,                         // null = wallet.pub
  });
  console.log(r);
});
"
```

Verify the synthetic LP-share UTXO at `(reveal_txid, 0)` is recognised
by `commitmentForUtxo` (via `/asset/utxo?txid=...&vout=0`).

### 6c. T_LP_REMOVE the claimed shares

Use the standard LP_REMOVE builder against the synthetic UTXO from 6b.
Recovers proportional cBTC.zk + TAC.

## Step 7 — clean up

If you want to reset for a fresh rehearsal:

```sh
rm .local/cbtc-tac-signet-state.json
# Re-fund + re-stage from Step 1.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Deposit rejected silently | LP-share UTXO not recognised as TAC-paired pool LP | Check `/amm/pools` for the pool record; verify lp_asset_id matches |
| `lien-state probe failed` in Step 8 | `/ctac/lien` endpoint not deployed yet | Confirm worker has the §5.47 lien endpoints (commit `1d6ce39+`) |
| `insufficient sats for ... commit` | Funding insufficient or unconfirmed | Wait for confirmation, or top up |
| Position stuck in `deposit-pending` | Worker didn't process the envelope | Check worker logs; usually a TWAP/oracle issue (need ≥1 TAC trade events) |

## Rehearsal sign-off

Rehearsal is considered complete when:
- [ ] Step 5 produces "smoke test complete" output
- [ ] Step 6a force-close succeeds (claim pool > 0 after)
- [ ] Step 6b LIEN_CLAIM mints a synthetic LP-share UTXO
- [ ] Step 6c T_LP_REMOVE on the synthetic UTXO yields proportional cBTC.zk + TAC
- [ ] All txs visible on `mempool.space/signet`
- [ ] No worker errors during the cron pass after each step
