# DESIGN — atomic create-and-seed for the confidential AMM (public-funded founding + router)

Goal: standard AMM UX (zAMM-style) — **Alice, holding public ERC20s and/or ETH, creates + seeds a
confidential AMM pool on the Ethereum side in one action**, with reserve ratio + depth set atomically and
secure asset-id ordering. tETH (native-ETH asset) must work as either side.

This is a **launch-gen** design (the live pool `0x3D38…` is immutable; this lands in the next ConfidentialPool
gen). All of it is **contract + periphery only — NO guest change, NO reprove.**

## The hard constraint (why it isn't one pure-EVM tx for confidential notes)
A confidential `OP_LP_ADD` is **proof-gated**, and the proof's note-membership is verified against the tree
root **after** the `wrap` inserts the note (the guest can't prove membership of a not-yet-inserted note). So
the confidential-note path is inherently: `wrap()` (pending deposit) → `OP_WRAP` settle (insert) → `lp_add`
settle (spend) = **two box proofs in sequence**, the second bound to the first's resulting root. That can't
collapse to a single EVM tx. It collapses to **one dapp action** (the dapp proves + sequences) — and the
already-landed `createPairAndSettle(assetA,assetB,feeBps,pv,proof,memos)` makes the final create+lp_add step
one atomic tx given the notes are wrapped.

## The unlock: founding liquidity is PUBLIC
Wrap amounts are revealed at the deposit boundary and pool reserves are public. So a **founding** LP's
*contribution* needs no confidential note round-trip — only the LP's *share position* wants hiding. That makes
a true single-tx, proof-free public founding path possible:

```
createPairAndAddLiquidityPublic(bytes32 assetA, bytes32 assetB, uint32 feeBps,
                                uint256 amountA, uint256 amountB, address to) payable
```
- Escrow each leg by its asset kind: native ETH (`underlying==0`) ⇐ `msg.value`; ERC20 ⇐ `safeTransferFrom`;
  pool-minted ⇐ `burn`. (One leg may be tETH/native ETH — `msg.value` covers it; the other an ERC20.)
- `_ensurePair(assetA, assetB, feeBps, false)` — lazy-create the canonical slot (idempotent; ETH works as
  either side; `poolId == guest pool_id(canonical(a,b),feeBps)`).
- `value_X = amountX / unitScale_X` (the wrap-boundary scaling). Set reserves; for an empty pool
  `totalShares = isqrt(value_A·value_B)`, lock `MINIMUM_LIQUIDITY`; else proportional (`min` rule).
- Credit the LP their shares (the share-binding fork below).

### Security (matches the proven invariants)
- **Ordering:** canonical-sort + `poolId` binding (same as `createPairAndSettle`). Order-independent; a
  wrong-asset call just creates an unrelated slot. tETH as either side is safe.
- **escrow == reserves:** founding reserves are backed by the escrow taken in the same call (the wrap-boundary
  invariant), so `unwrap`/`lp_remove` stays fail-closed on escrow.
- **MIN_LIQUIDITY floor** preserved (first-mint locks it → the (pair,fee) slot can't be bricked/drained).
- Front-run-proof: a createPair front-run only registers the empty slot; the first funder sets the ratio.

## The share-binding fork (the one real decision — pick before implementing)
The LP-share position must be bound to the **earned** `dShares` or an LP could later `lp_remove` more than they
funded (drain). Two ways:

**Option A (RECOMMENDED) — public LP-share ledger + opt-in shielding.** The public path credits shares to a
public balance `lpShares[poolId][to]` (ERC20-like), no commitment, **no on-chain secp, no proof**. `totalShares`
= Σ public balances + Σ confidential share-note shares. A separate, proof-gated `shieldShares` op converts a
public balance → a confidential LP-share note when the LP wants position privacy. lp_remove handles both a
public-balance burn (public) and a confidential-note burn (proven, existing path).
- Pros: simplest core (no secp), cheapest gas, true one-tx founding, privacy still available opt-in.
- Cons: a dual LP-share accounting model (public ledger alongside confidential notes); founding LP position is
  public until shielded (acceptable — they chose the public path; the *pool* is still a confidential AMM).

**Option B — on-chain opening sigma binds a confidential share note at mint.** The LP passes
`(shareCx, shareCy, shareOwner, sigR, sigZ)`; the contract verifies the secp Schnorr opening that
`C_share` opens to the public `dShares`, then inserts the share note leaf — confidential from birth, no public
ledger.
- Pros: LP position private immediately; single share model (notes only).
- Cons: needs a **secp256k1 point-ops library in Solidity** (the pool currently has none — all secp is in the
  guest); ~3–4 scalar muls per call (~hundreds of k gas); a fund-critical new verification surface to audit.

Recommendation: **Option A.** It keeps the immutable core minimal and secp-free, gives the exact zAMM one-tx
UX for founding, and preserves confidentiality as an opt-in (`shieldShares`) — privacy of the *LP position* is
separable from privacy of the *pool's trades* (which `OP_SWAP` already hides).

## Router (zRouter-style periphery) — where the batching lives
Keep the core minimal; put UX batching in a permissionless periphery router (no special privileges — it only
calls public entries + relays proofs):
- approvals + ETH handling + multi-pool fan-out;
- the **confidential-note** orchestration: `wrap()` → (dapp/box proves `OP_WRAP`) → `settle` → (proves
  `OP_LP_ADD` vs the resulting root) → `createPairAndSettle`. One dapp action, several txs under the hood.
- the **public** founding: a thin wrapper over `createPairAndAddLiquidityPublic` (one tx).
The router is deployable/iterable independently of the immutable core — same split as zAMM core vs zRouter.

## Swap note
A *payable public swap* (public in → public out vs the public reserves) is possible but reveals the amount,
defeating the confidential AMM's purpose — so `OP_SWAP` stays proof-gated (hidden amount is the product). A
public swap path is a separate opt-in for non-private traders if ever wanted.

## Status / landed
- `createPairAndSettle` + `_ensurePair` + extracted `_settle`: **landed contract-side** (lazy-create the
  confidential-note add atomically; ETH/tETH either side; secure ordering). Compiles. Next-gen (no reprove).
- `createPairAndAddLiquidityPublic` (Option A) + `removeLiquidityPublic` + `swapPublic` + the `lpShares`
  public ledger + `_isqrt`/`_ingestPublic`: **IMPLEMENTED** in ConfidentialPool.sol (next-gen) + tested
  (`test/ConfidentialPoolPublicAmm.t.sol`: create-and-seed → public swap (k↑) → remove-to-floor, proportional
  add, MIN_LIQUIDITY-breach revert — 3/3 green). Founding is proof-free; reserves stay u64-compatible; the
  `lpShares` getter exposes only public positions (confidential note-shares are disjoint, in the tree — no
  downgrade). Confirmed: the public path is independent of the parallel `wrap`→commit-digest privacy revamp.
- `shieldShares` (public LP-share → confidential share note, opt-in privacy): **IMPLEMENTED** (next-gen,
  commit 4d530f4) — reuses OP_WRAP via a pending deposit keyed (lpShareId, shares, commit); no guest change,
  no on-chain EC. `totalShares` unchanged (form change); the share note is OP_LP_REMOVE-only (its asset =
  unregistered lp_share_id, so OP_UNWRAP reverts). Tested (ConfidentialPoolPublicAmm.t.sol).
- The **zRouter-style periphery router** (composes the public add/remove/swap + the wrap→prove→settle
  orchestration + approvals/ETH): **still to implement** (review in the A0 bundle). Permissionless, no
  special privileges — calls the public entries + relays proofs, so deployable/iterable off the immutable core.
