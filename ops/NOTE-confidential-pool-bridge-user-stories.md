# NOTE — Confidential Pool + Bridge User Stories

Purpose: product-facing summary of what the `ConfidentialPool` and bridge abstractions provide to Tacit users.

## Thesis

Tacit should feel like one private asset layer whose value can settle on Bitcoin or Ethereum. Users hold Tacit assets and notes, not chain-specific wrappers. The confidential pool provides hidden-amount, unlinkable notes; the bridge/reflection layer moves those notes between lanes without turning them into separate assets or trusting an operator.

In one line:

> I hold private Tacit assets, spend or trade them wherever liquidity is best, and inspect Bitcoin/Ethereum lane details only when I care about finality, fees, or auditability.

## User Stories

### Private holder

As a user, I can hold TAC, tETH, cBTC, cUSD, or another Tacit asset as confidential notes, so observers cannot see my amounts or link my deposit to my later spend.

The pool combines amount privacy and unlinkability in one object: a note is a hidden-value Pedersen commitment, and spends prove membership without revealing which note was consumed.

### Private sender

As a user, I can send hidden-amount assets to another user without revealing the amount or linking the recipient's new note to my input note.

The `transfer` operation spends `n` notes into `m` notes while proving membership, range, and conservation.

### Public-to-private on-ramp

As a user, I can wrap public value into a confidential Tacit note, then later unwrap it back to a public payout.

`wrap` creates a note from public escrow or pool-minted value; `unwrap` spends a note to the public boundary.

### Cross-chain holder

As a user, I see one Tacit asset balance even if some notes settle on Bitcoin and some settle on Ethereum.

The app should merge balances by `asset_id`, with lane breakdown available as an auditable detail rather than the primary model.

### Bridge user

As a user, I can move value between Bitcoin and Ethereum without trusting a custodian, multisig, or bridge operator.

Movement is source-consuming: burn/nullify on the source lane, mint one corresponding note on the destination lane, and use the shared nullifier to prevent double-spend across lanes.

### Ethereum fast-lane user

As a user, I can settle confidential transfers, swaps, and matched trades quickly on Ethereum while preserving the Tacit note model.

The Ethereum `ConfidentialPool` gives fast settlement for Ethereum-homed notes; Bitcoin-homed value can bridge or enter fast-lane flows according to the current re-prove/deploy gates.

### Trader / LP

As a user, I can express intent at the asset level, not the chain level: swap TAC to tETH, provide liquidity, or fill an order, and let routing pick the venue.

LP positions and orders remain chain-located, but the user-facing view can unify balances, liquidity, and open orders by asset, pool, venue, and order id.

### DeFi user

As a user, I can use confidential assets in higher-level DeFi: swaps, LP, OTC/BID, farms, cBTC, and cUSD CDPs.

The important product point is that these are not separate privacy systems. They compose over the same note substrate and proof discipline.

## Capabilities

- Hidden balances: asset amounts are commitments, not public balances.
- Unlinkable spends: spending proves membership without revealing which note was consumed.
- Multi-asset privacy: TAC, tETH, cBTC, cUSD, and future assets use one pool model.
- Arbitrary amounts: the unified pool avoids a denomination ladder.
- One seed / one identity: one wallet unlock derives Bitcoin and EVM lanes.
- One asset identity: `asset_id` binds Bitcoin, EVM canonical ERC20, and confidential-note forms.
- Trustless bridge semantics: movement is proof-gated and source-consuming, not operator-attested.
- Canonical public face: assets can exit to deterministic ERC20s for public Ethereum DeFi.
- Unified portfolio UX: balances merge by asset, with lane/finality visible as detail.
- Composable DeFi: transfer, swap, LP, OTC/BID, farm, cBTC, and cUSD share the same substrate.

## Product Evaluation

This abstraction is strong because it compresses several separate concepts into one user model:

- mixer privacy;
- confidential transfer;
- wrapped asset bridge;
- public ERC20 exit;
- cross-chain routing;
- private DeFi.

The user should not need to choose "mixer vs bridge vs wrapped token vs private transfer." They should interact with a Tacit asset note and let the system route settlement.

The main risks are operational and UX-related rather than conceptual:

- proving latency until batching matures;
- relay freshness and re-prove discipline;
- clear lane/finality display;
- dapp wiring that does not leak protocol complexity into basic workflows;
- honest status separation between built, deployed, and designed-but-not-yet-built surfaces.

## Abstraction Check

The pool/bridge/routing layer is internally consistent around one rule: every cross-boundary movement must be source-consuming and replay-scoped. Confidential notes are spent by membership/nullifier proofs, bridge movement is burn/nullify-then-mint, orderbook offers and cancels bind `chainBinding`/`bookId`, and route intents bind the exact selected plan hash plus taker key, deadline, nonce, and minimum output.

The trustless line is strongest for the confidential pool, OP_SWAP_ROUTE guest, and source-consuming bridge/reflection checks. It is weaker where we are still in design or staging: cross-chain orderbook matching needs production watcher/finality policy, adaptor-swap settlement orchestration, and live lane fee/finality UX before it should be described as fully built.

Status summary:

- Built locally: signed cross-chain offers/cancels, exact-input orderbook quoting/fills, venue ranking, bounded same-lane AMM multihop planning for Bitcoin/Ethereum venue snapshots, route intent signing, Bitcoin AMM native broadcast-request handoff (`T_SWAP_VAR` / `T_SWAP_ROUTE`), public-EVM route transaction construction, confidential-EVM AMM OP_SWAP_ROUTE construction, route relay submission, worker queue support, and settle-loop route/prove-only dispatch.
- Proved on box: the route fixture executes against the pinned confidential guest and produces a locally verified Groth16 proof artifact.
- Designed, not fully built: live cross-venue production routing, cross-chain orderbook settlement watchers, cross-lane maker/taker UX, and end-to-end production deployment of route settle/prove loops.

## Source Docs

- `spec/SPEC-CONFIDENTIAL-POOL.md`
- `ops/ARCH-tacit-chain-abstraction.md`
- `ops/STATUS-confidential-system.md`
- `ops/PLAN-abstraction-shipping.md`

## Implementation Note — Cross-Venue Routing / Cross-Chain Orderbook

The first shippable implementation surface is a pure quote/planning layer:

- `dapp/cross-chain-orderbook.js` exposes `quoteExactIn(...)`, a non-mutating exact-input sweep plan across posted cross-chain offers. It consumes best-price offers first, supports partial-depth previews, and preserves exact-multiple fill discipline so no rounding value leaks into a fill. It also has a signed production path: `postSigned(...)` / `cancelSigned(...)`, with BIP-340 signatures over maker pubkey, price, lanes, expiry, min fill, nonce, `chainBinding`, and `bookId`.
- `dapp/cross-venue-router.js` exposes a generic venue router. It can rank same-lane constant-product AMM venues (`btc-amm`, `evm-confidential-amm`, `evm-public-amm`), accepts both EVM-style and Bitcoin registry-style pool snapshots, composes bounded multihop same-lane AMM routes, and ranks cross-lane orderbook routes behind one `bestExactIn(...)` / `quoteExactIn(...)` API.
- `dapp/cross-venue-execution.js` binds a selected route to taker consent (`routePlanHash(...)`, `signRouteIntent(...)`) and revalidates cross-chain orderbook plans immediately before filling. A stale/cancelled orderbook quote fails before any mutation. It turns Bitcoin AMM quotes into native broadcast-request handoffs (`buildAndBroadcastSwapVarSelfFulfill` for one hop, `buildAndBroadcastSwapRoute` for multihop), turns public-EVM one-hop AMM quotes into `ConfidentialRouter` Permit2 swap transactions when explicit asset metadata/scaling is supplied, and turns one-hop or multihop confidential-EVM AMM quotes into `OP_SWAP_ROUTE` operations that can be submitted to the settle/prove queue.
- `worker/src/confidential-settle.js` now accepts `route` as a first-class confidential op type, matching the relay/client contract. Route jobs can run in settle mode or prove-only mode.
- `contracts/sp1/confidential/harnesses/exec-route.rs` is the standalone route harness, and `contracts/sp1/eth-reflection/prover-host/src/bin/exec_route.rs` packages the same OP_SWAP_ROUTE stdin writer inside the active prover-host crate. `scripts/confidential-settle-loop.sh` maps `type=route` to that harness and honors prove-only jobs by acking `publicValues`/`proof` instead of sending `settle(...)`.
- `tests/cross-venue-router.mjs` covers venue selection, orderbook sweeping, lane-aware routing, and partial-depth behavior. `tests/cross-venue-execution.mjs` covers route-intent binding, stale orderbook rejection, public-EVM transaction building, confidential-AMM operation normalization against the native route verifier, and guarded relay submission. `tests/confidential-settle.mjs` pins worker acceptance of `route` jobs.

Box validation on 2026-06-21 against `/root/work/confidential/target/.../confidential-pool-prover`:

- `MODE=execute cargo run --release --bin exec_route` passed with `ROUTE_OK cycles=557487 pv_bytes=1856 hops=2 amount_in=10000`.
- `MODE=groth16 cargo run --release --bin exec_route` produced and locally verified a Groth16 proof with vkey `0x00516e622d8fa554b8ef2c6cee2c3436aafda1a33b39f86a131072a7ae52e0ea`, writing `route_pv.hex` and `route_pb.hex`.

The current execution layer handles cross-chain orderbook fills, Bitcoin AMM native handoff requests, public-EVM AMM transaction building, confidential-EVM AMM multihop route-op construction, route submission to the settle/prove queue, and box-side OP_SWAP_ROUTE proof artifact generation. The remaining work is production integration: live Bitcoin broadcast wiring from the handoff, live route settlement rehearsal, finality-aware orderbook watchers, relayer/runbook hardening, and UI lane disclosure.
