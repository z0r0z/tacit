# Confidential router — dapp wiring plan

Wiring the on-chain `ConfidentialRouter` (one periphery contract: wrap / private-payment / public-AMM / zaps,
pinned to the pool + canonical Permit2 + the zRouter aggregator) into the dapp.

## The architectural split that drives the phasing

The router pulls input from `msg.sender`, so **every router tx is user-sent** (the user pays gas and signs the
permit to the router). The worker box's only role is to produce an SP1 proof — never to submit the router tx.
That cleaves the router entrypoints into two classes:

- **Proof-free** — the router call needs no proof:
  - `wrapWithPermit` / `wrapWithPermit2` / `wrapETH` — create a pending deposit; the note is minted by a
    later settle (the existing relay flow).
  - `swapPublicWithPermit` / `…Permit2` / `…ETH`, plus `swapPublicPathWithPermit2` /
    `swapPublicETHPath` — transparent lane, one-hop or multihop, output to a caller-chosen `to`.
  - `zapETHIntoLP` — public LP (cold start).
  - `zapETHToShieldedNote` / `zapETHIntoShieldedLP` — create a `wrap`/`shieldShares` DEPOSIT; the confidential
    note materializes via a follow-up settle on the existing relay.
  → ship with **zero box change**.
- **Atomic-settle** — the router call embeds `(publicValues, proof)`:
  - `wrapAndSettleWithPermit` / `…Permit2` / `…ETH`, `zapETHToPayment` — wrap + settle in one tx.
  - `wrapAndMintCusdWithPermit` / `…Permit2` / `wrapETHAndMintCusd`, plus `zapETHToCdpMint` /
    `zapTokenToCdpMintWithPermit2` and canonical-asset variants — collateral on-ramp + OP_CDP_MINT in one tx.
  - `zapETHIntoFarm` / `zapTokenIntoFarm` — zap + shield + bond (OP_LP_BOND) in one tx.
  → need a new **prove-only** box mode: the box returns `{publicValues, proof}` (instead of proving AND
    submitting), the dapp splices them into the router calldata, the user broadcasts.

## Reused vs new

Reused: `confidential-pool-ux.js` `buildWrap` pattern (commit / depositId / memo / opening-sigma in
`confidential-pool.js`), `evm-tx.js` `signEip1559` (and its `secp.sign` for EIP-712 digests),
`cross-chain-asset-resolver.js` `_evmAssetId`, the memo/indexer recovery, and `confidential-invoice.js` for
payment commits + the pre-signed consume sigma. New: EIP-2612 + Permit2 (Single/Batch) EIP-712 signing,
zRouter quoting + calldata, and the prove-only worker mode.

## Phases

### Phase 1 — proof-free core (no box) — IN PROGRESS
- `dapp/confidential-router.js`: router/Permit2/zRouter addresses, `_evmAssetId`, EIP-2612 + Permit2 signing,
  calldata builders for `wrapWithPermit/Permit2/ETH`, one-hop + multihop `swapPublic*`,
  `addLiquidityPublicWithPermit2`, and plain zRouter swaps.
- Exact-out UX for the public AMM has both dapp quoting helpers (`publicAmountInForExactOut` /
  `quotePublicPathExactOut`) and refunding router helpers (`swapPublicExactOutWithPermit2`,
  `swapPublicETHExactOut`, plus multihop variants). The pool remains exact-input; the router reads live
  reserves, derives the needed input, spends only that amount, and refunds/does not pull the caller's excess
  `maxAmountIn`. If reserves move beyond the caller's max, the router reverts before spending.
- `router` + `permit2` fields in `CONFIDENTIAL_POOL_UX` config (set after the next pool+router deploy).
- `tests/confidential-router.mjs` — selector + ABI-encoding (cross-checked vs `cast calldata`) + permit
  signature recovery + `_evmAssetId` cross-check (native id == cETH config id).
- Foundational, box-independent, highest confidence.

### Phase 2 — private payment (box prove-only)
- Add a prove-only path to the worker + a `waitForProof` client; wire `confidential-invoice` →
  `wrapAndSettle*` / `zapETHToPayment` (recipient commit + pre-signed consume sigma → box proves the consume →
  embed → user broadcasts). Validate end-to-end on the box.
- The same prove-only path now also covers single-tx CDP open UX: `wrap*AndMintCusd` for direct collateral and
  `zap*ToCdpMint` for route-then-collateralize flows. The router adds a light `cdpMints.length > 0` intent
  guard; the pool + proof remain the trust boundary for the actual debt/collateral semantics.

### Phase 3 — zRouter zaps
- zRouter ABI + quoting (V2/V3/V4/Curve/zAMM), exact-in (cold-start `zapETHIntoLP`) + exact-out (deterministic)
  calldata; the shielded-deposit zaps with the existing relay as the follow-up settle.

### Phase 4 — farm zaps
- Deterministic-shares pre-derivation + the OP_LP_BOND prove path (the bond op builder exists in
  `confidential-farm.js` but has no prove/relay type) + `zapETHIntoFarm` / `zapTokenIntoFarm`. Validate the
  bond on the box. Most complex.

## Deploy dependency

The router + an ERC20 test asset must be deployed/registered before a live ERC20-permit round-trip (the Sepolia
pilot currently registers only native cETH). `DeployConfidentialPool` already deploys the router
(`DEPLOY_ROUTER`, pinned Permit2 + zRouter); set `cfg.router` from that broadcast.
