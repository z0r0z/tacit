# Cross-lane day-one punch-list — tETH + TAC

Ordered critical path to get **tETH + TAC moving between Bitcoin and Ethereum via the confidential-pool
cross-lane**. Rationale + the rollout framing live in `PLAN-confidential-cross-chain.md §12`; this is the
actionable checklist. Status: ✅ built · 🟡 buildable now (non-blocked) · 🔴 operational/blocked.

## The honest shape

The **EVM half is built** — the contract ABI is cross-chain-final and the settle guest already carries
`bridge_mint`/`bridge_burn`. The day-one gate is the **Bitcoin side + the operational loop**, not new
EVM logic. The biggest genuinely-unbuilt piece is the **ETH→Bitcoin `CrossOut` consumer** (Bitcoin
validators minting the destination note). The dapp + indexer are asset-agnostic, so the app-layer
day-one is config, not code.

## Layer status

| Layer | Status | Notes |
|---|---|---|
| Contract (`ConfidentialPool.sol`) | ✅ | cross-chain-final ABI: `bridge_mint`/`bridge_burn`, `crossOut`, `localAssetOf`+`_resolveAsset`, `bridgeMinted` (one-mint-per-claimId), no-inflation floor. NOT prod-deployed. |
| Settle guest | ✅ | `bridge_mint`/`bridge_burn` are gen-1 ops in the proven settle vkey (`0x00c11f48`). |
| Reflection guest | 🟡 | REFLECT-1 fixed + re-confirmed conservation-enforcing; re-prove artifacts need committing + pinning. |
| Indexer / worker | ✅ | asset-agnostic (auto-indexes any asset), cross-chain resolution present. Needs cross-lane env config. |
| Dapp asset config | ✅ | TAC cross-lane config **staged** (`CROSSLANE_DEPLOYMENTS`, inert/gated). tETH = legacy mixer, untouched. |
| Dapp bridge UX (cross-lane) | 🟡 | asset-aware routing + `bridge_mint`/`bridge_burn` witness builders (mint builder + test exist; finalize). |
| Reflection loop (operational) | 🔴 | the prover running + attesting Bitcoin state, **both directions**. |
| **Bitcoin-side `CrossOut` consumer (ETH→BTC)** | 🔴 | **the main unbuilt piece** — validators honor `CrossOutRecorded` → mint the Bitcoin note. |
| HEADER_RELAY | 🔴 | deploy + wire. |
| Pool deploy | 🔴 | fresh-deploy at the current vkey (Sepolia → mainnet). |

## Critical path (in order)

1. **Close the reflection gate** 🟡 — commit the REFLECT-1 re-prove artifacts + pin the conservation-
   enforcing reflection vkey (`readiness-gate.sh` reflection-soundness PASS). → reflection ready.
2. **Fresh-deploy the confidential pool** 🔴 — at the current settle vkey, + HEADER_RELAY. → pool live.
3. **Stand up the reflection loop Bitcoin→ETH** 🔴 — prover running + `attestBitcoinStateProven` wired +
   worker env (`REFLECTION_GENESIS_HEIGHT`, `REFLECTION_PROVE_URL`/`SUBMIT_URL`). → **`bridge_mint` works
   (Bitcoin→ETH)**.
4. **Build the Bitcoin-side `CrossOut` consumer** 🔴 — the ETH→Bitcoin direction: Bitcoin validators /
   indexer honor `CrossOutRecorded` and mint the destination Tacit note. → **`bridge_burn` round-trips
   (ETH→Bitcoin)**. *(largest new build)*
5. **Register tETH + TAC cross-chain links** 🔴 — on the deployed pool, the canonical ERC20s committing
   to their ids (`ASSET_ID == crossChainLink`). → assets recognized cross-chain.
6. **Flip on dapp + worker** 🟡 — set `CROSSLANE_DEPLOYMENTS[net].pool`, mark TAC `live:true`, wire the
   asset-aware bridge UI; worker cross-lane config. → **tETH + TAC cross-lane day-one**.

## Buildable now (before the operational loop)

- ✅ TAC cross-lane config staged (`CROSSLANE_DEPLOYMENTS`, gated off).
- 🟡 Asset-aware cross-lane bridge UX in the dapp (routing layer), gated behind `_crosslaneConfigured()`.
- 🟡 Finalize the `bridge_mint`/`bridge_burn` dapp witness builders (mint builder + `tests/confidential-
  bridge-mint.mjs` exist; close the burn side + add a round-trip node test).
- 🟡 Worker cross-lane config scaffolding (env keys, gated).

## Blocked / operational (the real day-one gates)

- 🔴 The **Bitcoin-side `CrossOut` consumer** (ETH→BTC mint) — the main new build.
- 🔴 The reflection loop running (both directions) + the fresh pool deploy + HEADER_RELAY — box/operational.

## "Add more assets by turn"

Once the cross-lane is live, a new asset is **config, not code**: a `CROSSLANE_DEPLOYMENTS` entry +
`registerAsset(kind:'bridge'|'crosslane')` + the on-chain cross-chain link. The indexer auto-indexes it;
no guest, contract, or indexer change. (See `PLAN-confidential-cross-chain.md §12`.)
