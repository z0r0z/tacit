# TAC airdrop runbook (EVM MerkleDistributor)

Point at any public ERC20/ERC721, fetch holders, apply a per-source rate, merge into one tree, deploy, fund.

## Pipeline

```
fetch-holders.mjs  →  compose-airdrop.mjs  →  build-merkle.mjs  →  DeployMerkleDistributor.s.sol  →  top-up
   (per source)        (strategy + merge)       (root + proofs)         (deploy + assert funded)     (send TAC)
```

`compose-airdrop.mjs` auto-fetches each source by address (cached under `raw/`), so day-of you only edit the
config. All amount math is exact BigInt; decimals are handled per source.

## 1. Config

One entry per source group. `rate` = **TAC per 1 whole source token** (ERC20) or **per NFT** (ERC721):

| Goal | config |
|---|---|
| 1:1 | `"type":"erc20","decimals":18,"rate":"1"` |
| 1000 TAC per token | `"rate":"1000"` |
| 0.01 TAC per token | `"rate":"0.01"` |
| 100 TAC per NFT | `"type":"erc721","rate":"100"` |
| flat 250 TAC / holder | `"type":"erc721","flat":"250"` (balance-blind) |

Per-source options: `decimals` (required for ERC20 if not in the cached snapshot), `minTokens` (drop dust
holders), `cap` (max TAC/account), `exclude` (addresses — zero, 0xdead, and the source contract auto-dropped),
`chain`, `fromBlock`, `toBlock`, `refetch`. Top-level: `budget` (TAC ceiling), `scaleToBudget` (proportionally
scale to hit the budget exactly), `minAllocation` (drop merged leaves below N TAC), `tacDecimals` (default 18).

Accounts appearing in multiple sources are **summed into one claim** (no double-allocation).

See `airdrop.config.example.json`. Run:

```bash
ETHERSCAN_API_KEY=... node tools/airdrop/compose-airdrop.mjs my-airdrop.config.json tools/airdrop/snapshot.json
# prints per-source breakdown + TOTAL_ALLOCATION (raw) — note this number, it's the funding target
```

To fetch a single source by hand (optional; compose does it for you):

```bash
ETHERSCAN_API_KEY=... node tools/airdrop/fetch-holders.mjs --address 0xTOKEN --type erc721 --out raw/cool.json
```

## 2. Build the tree

```bash
node tools/airdrop/build-merkle.mjs tools/airdrop/snapshot.json tools/airdrop/out.json
# out.json: { root, total, count, claims:[{index,account,amount,proof}] }  — publish claims for the UI
```

`total` here MUST equal the composer's `TOTAL_ALLOCATION`. That number is the deploy's `TOTAL_ALLOCATION`
**and the exact TAC you must fund** (see §4).

## 3. Deploy

```bash
TOKEN=0x<bridged-TAC-erc20> \
MERKLE_ROOT=0x<out.json root> \
TOTAL_ALLOCATION=<out.json total, raw> \
CLAIM_DEADLINE=<unix; clawback opens here> \
OWNER=0x<ops multisig> \
forge script contracts/script/DeployMerkleDistributor.s.sol --rpc-url $RPC --broadcast
```

`FUND=true` funds from the broadcaster in the same tx and asserts the balance covers `TOTAL_ALLOCATION`.
On mainnet keep funding a separate admin step (§4) and leave `FUND` unset. `MIN_CLAIM_WINDOW` (default 14d)
rejects a deadline closer than that — set short deliberately if you want a fast claw-back-and-redo cycle.

**Owner / sweep authority.** `OWNER` is the only privileged role (clawback after the deadline — it can never
touch a claim). For the production drop set it to the admin wallet:

```
OWNER=0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2
```

**Mainnet parameters (decided):** fund the **full 2,500,000 TAC** up front, `CLAIM_DEADLINE = deploy + 30 days`
(1-month clawback window). So a recipient has a month to claim; after that the admin sweeps the remainder and,
if needed, redeploys with a fresh root.

## 4. Funding — IMPORTANT, answers the 100K-test question

The distributor will not let **anyone** claim until its balance reaches `TOTAL_ALLOCATION` (the `opened`
latch checks `balanceOf(this) >= EXPECTED_TOTAL` on the first claim). So:

- A **100K test top-up against a 2.5MM `TOTAL_ALLOCATION` opens nothing** — every claim reverts `NotFunded`
  until topped to the full 2.5MM. It only proves the deploy + transfer plumbing, not a real claim.
- To actually rehearse a claim, deploy a **separate throwaway distributor** whose tree (and therefore
  `TOTAL_ALLOCATION`) is the small 100K set, fund it 100K, claim, then `sweep` after a short deadline.
- For the production 2.5MM drop, **fund the full 2.5MM before publishing proofs.** Once funded + first claim,
  the drop is open; the balance then legitimately draws down as people claim.
- Clawback is your safety net: after `CLAIM_DEADLINE` the owner `sweep(to)`s the remainder and you can redeploy
  with a corrected root. Keep the first deadline modest (e.g. 30–60d) so a redo is cheap.

Top-up (admin, from the Bitcoin-bridged-TAC admin wallet that holds the public ERC20):

```bash
cast send $TOKEN "transfer(address,uint256)" $DISTRIBUTOR <TOTAL_ALLOCATION raw> --rpc-url $RPC --account admin
# verify:
cast call $DISTRIBUTOR "EXPECTED_TOTAL()(uint256)" --rpc-url $RPC
cast call $TOKEN "balanceOf(address)(uint256)" $DISTRIBUTOR --rpc-url $RPC   # must be >= EXPECTED_TOTAL
```

## Recommended day-1 sequence for the 2.5MM drop

1. Compose with `budget: "2500000"` (and `scaleToBudget: true` if you want to hit 2.5MM exactly regardless of
   holder counts; otherwise it fails loud if your rates overshoot — tune rates/caps and re-run).
2. Build tree; sanity-check `count` and `total`.
3. Deploy the **test** distributor (a 2–5 account hand-made snapshot, ~100K, 1-day deadline); fund 100K; do a
   live claim from one recipient; `sweep` it back. Proves the full path on mainnet.
4. Deploy the **production** distributor (root from step 2, `TOTAL_ALLOCATION` = 2.5MM, 30–60d deadline).
5. Transfer 2.5MM TAC to it from the admin wallet; verify `balanceOf >= EXPECTED_TOTAL`.
6. Publish `out.json` claims to the claim UI. Drop is live.

## Bot-admin funding (one script: bridge TAC → deposit the distributor)

On the rig, the admin bot wallet does the value side in one scripted sequence — no manual transfer step:

1. **Bridge TAC to the public ERC20.** The admin holds Bitcoin-native TAC; the bridge mints the canonical
   public `CanonicalBridgedERC20` to the admin address on the EVM side (mainnet: Ethereum; testnet: Sepolia).
   This is the same bridge_mint path the day-1 bootstrap already drives — the bot just targets the admin
   wallet as the mint recipient and waits for the reflection-gated mint to land.
2. **Deposit into the distributor.** Once the admin's bridged-TAC balance covers `TOTAL_ALLOCATION`, the bot
   `transfer`s exactly that into the deployed distributor and asserts `balanceOf(dist) >= EXPECTED_TOTAL`
   (the same assert `DeployMerkleDistributor` makes with `FUND=true`). That single transfer opens the drop.

Both lanes use the identical script; only the network + bridge endpoints differ:

- **mainnet** — Ethereum L1 + the live BTC relay. Full 2.5MM, 30-day deadline, `OWNER` = the admin wallet above.
- **signet** — Sepolia + the signet relay. This is exactly what the `evm-airdrop` job in
  `tests/run-v1-testnet.mjs` rehearses (it deploys + funds + claims on Sepolia), so the bot's bridge→deposit
  path is proven on signet before the mainnet run.

Keep the bridge and the deposit in the same script so the distributor is never left deployed-but-unfunded
(claims stay closed until funded, but a funded-then-forgotten gap is avoidable). The deposit is idempotent to
re-run: topping an already-funded distributor just raises its balance (harmless; swept later).

## Notes

- Snapshots are reproducible: log-replay to a pinned `toBlock`. Pin `toBlock` in the config so a re-run yields
  the identical root.
- The fetcher needs only a **free** Etherscan key. A token with >10k transfers in a single block warns about
  potential incompleteness (extremely rare for airdrop source tokens); narrow the block range if so.
- Leaf encoding is byte-identical to `MerkleDistributor.claim` (verified by `MerkleDistributorParity.t.sol`).
