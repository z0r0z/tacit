# signet airdrop dryrun

End-to-end dry run for an ERC-20-holder-style airdrop on Bitcoin signet. Exercises the same code paths a mainnet drop will use — CETCH a token, build snapshot, pin to IPFS, announce, fund treasury, simulate recipient tips + claims, fulfil from treasury, verify on-chain credits.

Uses an innocuous default ticker (`PINE`) so a casual signet observer can't tell the snapshot announcement is a tacit airdrop test.

## What you need

Three signet wallets, each with a few thousand signet sats:

| wallet | role | min sats |
|---|---|---|
| **issuer** | CETCHes the test token, sends supply → treasury via CXFER | 50,000 |
| **treasury** | signs fulfilment CXFERs to recipients | 50,000 |
| **tip funder** | pretends to be each recipient's BTC wallet for the tip step | `N × 1000 + 1000` |

Signet sats from any faucet: `https://signet.bublina.eu.org/` or `https://alt.signetfaucet.com/`.

## Run it

**Option A — deterministic keys from one SEED (lets you re-run against the same funded addresses):**

```bash
SEED=$(openssl rand -hex 32) N=5 node tests/signet-dryrun.mjs
```

First run prints the three derived bech32 addresses. Fund them, press Enter, watch it work. Save the SEED so subsequent runs land at the same addresses.

**Option B — bring your own privkeys:**

```bash
ISSUER_PRIV=hex64 TREASURY_PRIV=hex64 TIP_FUNDER_PRIV=hex64 N=5 node tests/signet-dryrun.mjs
```

**Option C — smoke test the wiring without broadcasting:**

```bash
SEED=01… DRY_RUN=1 N=3 node tests/signet-dryrun.mjs
```

Prints what each phase would do without touching the network.

## What it does, phase by phase

1. **Preflight.** Derive the three addresses, print them, wait for you to fund + press Enter. Best-effort balance check before continuing.
2. **CETCH.** Mint a fresh `PINE` token (8 decimals, 10 PINE supply) from the issuer wallet. Waits 60s for indexer pickup. Skip via `SKIP_CETCH=1 ASSET_ID=<hex>` if you already have a test token.
3. **Generate recipients.** N synthetic recipients with random eth_addresses + tacit pubkeys. Each gets 100 base units of PINE (0.000001 PINE at 8 decimals — tiny, you have plenty of supply).
4. **Build + pin + announce.** Computes the merkle root, POSTs `/pin-airdrop-snapshot` to the worker, POSTs `/drop-announce` so the dapp's Claim tab would discover it.
5. **Fund treasury.** Issuer wallet CXFERs `N × per_recipient × 1.1` of PINE to the treasury. Waits 60s for confirmation.
6. **Simulate recipients.** For each leaf: build canonical_claim_msg → sign with eth privkey (EIP-191 + ECDSA recovery) → tip funder sends `TIP_SATS` to treasury, captures txid → POST claim to `/airdrops/:root/claims` with funding_txid.
7. **Drive fulfilment.** Switch active wallet to treasury. Pull queue, batch up to 7, broadcast via `buildAndBroadcastCXferMulti` (same call the daemon makes). DELETE fulfilled tuples from queue.
8. **Verify.** For each recipient, set wallet to their tacit privkey, scan holdings, assert balance == expected. Prints pass/fail per leaf.

Exit code 0 = all recipients verified. Non-zero = something failed; check logs.

## Config knobs

| env var | default | purpose |
|---|---|---|
| `SEED` | (unset) | If set, derives ISSUER_PRIV / TREASURY_PRIV / TIP_FUNDER_PRIV deterministically |
| `ISSUER_PRIV` | (unset) | 64-hex; required if no SEED |
| `TREASURY_PRIV` | (unset) | 64-hex; required if no SEED |
| `TIP_FUNDER_PRIV` | (unset) | 64-hex; required if no SEED |
| `WORKER_BASE` | live shared worker | Override if running your own worker |
| `N` | 5 | Number of synthetic recipients |
| `TICKER` | `PINE` | Token ticker — keep innocuous, you'll announce it publicly on signet's worker |
| `DECIMALS` | 8 | Match your production mainnet TAC |
| `SUPPLY` | 1,000,000,000 | Total CETCH supply in base units (10 PINE at 8 dec — plenty for `N×100` test) |
| `PER_RECIPIENT` | 100 | Per-claim amount in base units (0.000001 PINE) |
| `TIP_SATS` | 1000 | Per-recipient tip — small for signet |
| `SKIP_CETCH` | (unset) | Set with `ASSET_ID` to reuse an existing asset |
| `ASSET_ID` | (unset) | Existing asset_id_hex to test against |
| `DRY_RUN` | (unset) | Set to 1 to print phases without broadcasting |

## What this validates

- ✅ Snapshot building, merkle commitment, IPFS pin, discovery announce
- ✅ Recipient eth_sig generation + worker queue intake
- ✅ Funding_txid binding (worker rejects duplicates, daemon would verify)
- ✅ Treasury → recipient CXFER fulfilment
- ✅ Recipient wallet's ECDH recovery of confidential amounts
- ✅ End-to-end live signet round-trip

## What this does NOT cover

- Mainnet fee dynamics (signet fees are minimal; mainnet can swing 5-100 sat/vB)
- Real-user MetaMask UX (synthetic recipients sign in-process)
- The dapp's Claim tab UI flow (script POSTs to worker directly)
- Auto-fulfil daemon background process (script does fulfilment inline)
- The launch checklist + Fund: TAC / Fund: sats button paths (script does everything programmatically)

For the dapp UI paths, follow the manual signet walkthrough in `tests/signet-smoke.md` after this dryrun confirms the protocol layer works.

## Cleanup

Run-state lives in:
- 3 signet wallets you funded — sats remain after the run (recoverable if you keep the SEED)
- 1 CETCH'd asset on signet (innocuous, expires from worker discovery after 7 days unless re-announced)
- 1 IPFS pin (no expiry; harmless)
- N claim records in the worker KV (auto-expire after 90 days)

Nothing destructive. Re-run as many times as you want with the same SEED.
