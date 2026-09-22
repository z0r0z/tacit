# ERC20 airdrop pipeline (MerkleDistributor)

A general pipeline for a public-ERC20 airdrop: fetch holders of any ERC20 or ERC721, apply a per-source rate, merge
into one tree, deploy a `MerkleDistributor`, fund it.

The live TAC airdrop does not use this pipeline. It is the `TacAirdrop` contract, built with `tools/airdrop-tree.mjs`
and documented in [`docs/AIRDROP.md`](../../docs/AIRDROP.md). The two use different leaf encodings.

## Pipeline

```
fetch-holders.mjs  →  compose-airdrop.mjs  →  build-merkle.mjs  →  DeployMerkleDistributor.s.sol  →  fund
   (per source)        (strategy + merge)       (root + proofs)         (deploy, optional fund)       (send token)
```

`compose-airdrop.mjs` fetches each source by address (cached under `raw/`), so normally only the config changes.
All amount math is exact BigInt, with decimals handled per source.

## 1. Config

One entry per source. `rate` is **TAC per 1 whole source token** (ERC20) or **per NFT** (ERC721):

| Goal | Config |
|---|---|
| 1:1 | `"type":"erc20","decimals":18,"rate":"1"` |
| 1000 TAC per token | `"rate":"1000"` |
| 0.01 TAC per token | `"rate":"0.01"` |
| 100 TAC per NFT | `"type":"erc721","rate":"100"` |
| flat 250 TAC per holder | `"type":"erc721","flat":"250"` (balance-blind) |

Per-source options: `decimals` (required for ERC20 unless in the cached snapshot), `minTokens` (drop dust holders),
`cap` (max TAC per account), `exclude` (addresses to drop; the zero address, `0xdead` and the source contract are
dropped automatically), `chain`, `fromBlock`, `toBlock`, `refetch`, or `raw` to supply a snapshot file instead of
fetching. Top-level: `budget` (TAC ceiling; the run fails if the total exceeds it), `scaleToBudget` (scale every
allocation so the total is exactly the budget), `minAllocation` (drop merged leaves below N TAC), `tacDecimals`
(default 18).

An account in several sources is summed into one claim.

See `airdrop.config.example.json`. Run:

```bash
ETHERSCAN_API_KEY=... node tools/airdrop/compose-airdrop.mjs my-airdrop.config.json tools/airdrop/snapshot.json
# prints the per-source breakdown and TOTAL_ALLOCATION (raw): the funding target
```

To fetch one source by hand:

```bash
ETHERSCAN_API_KEY=... node tools/airdrop/fetch-holders.mjs --address 0xTOKEN --type erc721 --out raw/cool.json
```

## 2. Build the tree

```bash
node tools/airdrop/build-merkle.mjs tools/airdrop/snapshot.json tools/airdrop/out.json
# out.json: { root, total, count, claims: [{ index, account, amount, proof }] }; publish the claims for the UI
```

`total` must equal the composer's `TOTAL_ALLOCATION`. It is the deploy's `TOTAL_ALLOCATION` and the exact amount to
fund.

Leaf: `keccak256(abi.encodePacked(uint256 index, address account, uint256 amount))`; nodes hash the sorted pair.
`MerkleDistributorParity.t.sol` pins the builder to `MerkleDistributor.claim`.

## 3. Deploy

```bash
TOKEN=0x<erc20> \
MERKLE_ROOT=0x<out.json root> \
TOTAL_ALLOCATION=<out.json total, raw> \
CLAIM_DEADLINE=<unix seconds; sweep opens here> \
OWNER=0x<sweep authority> \
forge script contracts/script/DeployMerkleDistributor.s.sol --rpc-url $RPC --broadcast
```

| Variable | Default | Meaning |
|---|---|---|
| `OWNER` | the broadcaster | the only privileged role: `sweep(to)` after the deadline. It cannot touch a claim |
| `FUND` | false | transfer `TOTAL_ALLOCATION` from the broadcaster in the same run and assert the balance covers it |
| `MIN_CLAIM_WINDOW` | 14 days | reject a deadline closer than this; 0 bypasses it for a deliberately short drop |

## 4. Funding

No claim succeeds until the contract's balance reaches `EXPECTED_TOTAL`: the first claim checks
`balanceOf(this) >= EXPECTED_TOTAL` and latches `opened`, and until then every claim reverts `NotFunded`. So:

- Fund the full `TOTAL_ALLOCATION` before publishing proofs. A partial transfer opens nothing.
- To rehearse a claim, deploy a separate small distributor whose own tree is the small set, fund it, claim, and sweep
  it after a short deadline.
- After `CLAIM_DEADLINE` the owner sweeps the remainder and can redeploy with a corrected root. A modest first
  deadline keeps a redo cheap.

```bash
cast send $TOKEN "transfer(address,uint256)" $DISTRIBUTOR <TOTAL_ALLOCATION raw> --rpc-url $RPC --account admin
cast call $DISTRIBUTOR "EXPECTED_TOTAL()(uint256)" --rpc-url $RPC
cast call $TOKEN "balanceOf(address)(uint256)" $DISTRIBUTOR --rpc-url $RPC   # must be >= EXPECTED_TOTAL
```

Topping up an already-funded distributor only raises its balance; the excess is swept with the remainder.

## Notes

- Snapshots are reproducible by log replay to a pinned `toBlock`. Pin `toBlock` in the config so a re-run yields the
  same root.
- The fetcher needs only a free Etherscan key. A token with more than 10k transfers in one block warns about possible
  incompleteness; narrow the block range if so.
