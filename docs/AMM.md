# The pool's AMM

One set of reserves, two ways to trade it. A swap or a liquidity position can be **public**, a plain Ethereum
transaction with no proof, or **private**, a note and a proof. Both move the same pool, so liquidity is never
split between them.

The app: [tacit.finance](https://tacit.finance/#card=swap), the front page's Swap and Earn tabs. The short version, on the site: [tacit.finance/build/#amm](https://tacit.finance/build/#amm). The rules: [`SPEC.md` §5.5](../SPEC.md#55-amm).
The contracts: [`DEPLOYMENTS.md`](./DEPLOYMENTS.md).

## The pool

A pool is a constant-product curve over two assets and a fee tier. Its id is `keccak256(lo, hi, feeBps)` with the
two asset ids sorted, so `(A, B)` and `(B, A)` are one pool. A pool with a protocol-fee switch is a separate pool with its own id. The reserves and the share total are public and sit in
one place, `ConfidentialPool.pools(poolId)`.

Any asset the pool holds can be paired: ETH (tETH), TAC, cBTC, cUSD, any ERC-20 registered with the pool, and
tokens issued on Bitcoin ([below](#one-pool-bitcoin-included)).

## Two doors

| | Public | Private |
| --- | --- | --- |
| Call | `TacitPublicAmm.swapPublic`, from any wallet or contract | a settle that carries an `OP_SWAP` or `OP_SWAP_ROUTE` |
| Proof | none | one SP1 proof |
| Lands | in your transaction | when the proof is settled |
| In | tokens or ETH from your wallet | a note |
| Out | tokens or ETH to any address | a note |
| Visible | the sender and the amounts | the reserve change, not whose notes |
| Combines with | any other call in the same transaction | the ops in the same proof: a route of up to four pools |

Public in and private out also exists: `OP_WRAP_SWAP` turns a public deposit into the swap's output note, and
`OP_WRAP_LP` turns two public deposits into an LP-share note.

## Public swaps

```
swapPublic(assetIn, assetOut, feeBps, amountIn, minAmountOut, deadline, to)
```

- **No proof, so no proving wait.** The swap clears against the live reserves inside the transaction. The pool
  checks that the product of the reserves never falls, so the payout is bounded by the curve whatever the caller
  passes. `quoteSwap(assetIn, assetOut, feeBps, amountIn)` returns exactly what the swap pays.
- **Atomic with other calls.** `swapPublic` is an ordinary synchronous call, so anything that can call a contract
  can put it in one transaction with other calls, and the transaction either does all of it or none. The repository
  has several: the [swap card](../dapp/swap/) (the front page's Swap tab) takes any token through another pool to the asset, and the asset to any token, in one transaction;
  an order can be [split across the Precision pool and the Tacit pool](./TAC.md#trading-tac) in one transaction; and
  `ConfidentialRouter` has the swap, the liquidity add and the shielding of the position as single calls
  (`swapPublicPathWithPermit2`, `zapETHIntoLP`, `zapTokenIntoShieldedLP`, `zapETHIntoFarm`).
- **Bounds.** `minAmountOut` and `deadline` are the caller's. ETH goes in as `msg.value`; an ERC-20 needs an
  approval to `TacitPublicAmm`, or a permit through the router. Amounts are whole multiples of the asset's
  `unitScale` (TAC: `1e10`).

## Private swaps

A private swap spends a note of one asset and receives a note of the other. The proof checks that the input is a
member of the note tree, marks it spent, clears the swap at the pool's price, enforces the trader's minimum output
and keeps the product of the reserves from falling. Anyone can submit it: the relay proves it for a fee that is
bound inside the proof, or you prove and settle it yourself.

- **It clears at the live reserves.** The proof names the reserves it was built against, and the pool accepts it
  only while those are still the live ones. If another trade, public or private, moves them first, the settle is
  refused, nothing is spent, and the app builds a fresh quote. A public swap never waits on this: it reads the
  reserves in its own transaction.
- **What it hides.** Which note was spent and who holds the output. Reserves are public, so a lone swap moves them
  by its own amounts. Swaps that share an `OP_SWAP` batch clear at one price and move the reserves once, and
  `OP_SWAP_BLIND` keeps trade sizes from the SP1 prover and the chain as well, with the batcher that builds the batch
  seeing them ([`SPEC.md` §5.6](../SPEC.md#56-prover-blind-swaps)).

## Liquidity

| | Public position | Private position |
| --- | --- | --- |
| Held as | a balance in `lpShares[poolId][address]` | an LP-share note |
| Add | `createPairAndAddLiquidityPublic`, one transaction | `OP_LP_ADD` (two notes in), `OP_WRAP_LP` (two deposits in) |
| Remove | `removeLiquidityPublic` | `OP_LP_REMOVE` |
| Visible | the holder and the size | neither |

Both kinds of share count in one `totalShares`: the public balances, the shares held in notes and the 1,000 shares
the first add locks forever. A public position can be turned into a private one in place with
`shieldShares(poolId, shares, commit)`, which burns the public shares into a pending deposit that an `OP_WRAP`
settle consumes into a note. The share total does not change, only the form of the claim.

**Yield.** A swap's fee stays in the reserves. Shares do not rebase; each share's claim on the reserves grows. On a pool
without a protocol-fee switch, every swap pays the same fee into the same reserves, so a private position earns
from public trading and a public one from private trading. Removal pays the pro-rata share of the reserves live at the settle, and a trade that lands
first cannot block it. LP-share notes can also be bonded into a farm, which earns TAC ([`FARMS.md`](./FARMS.md)).

**What stays visible.** The reserves, the share total and the change an add or a removal makes when it settles. The
position itself, whose it is and what it is worth, is a note.

## One pool, Bitcoin included

A Tacit note is the same commitment on both chains, and the pool holds the notes of every asset that reaches it:

| Asset | Where it comes from | In the pool |
| --- | --- | --- |
| BTC | a self-custody lock on Bitcoin, with a bond behind it | cBTC, minted 1:1 |
| TAC and other Tacit tokens | issued on Bitcoin | a note, with an ERC-20 the pool mints |
| ETH | Ethereum | tETH, the same asset on both chains |
| ERC-20s | Ethereum | a wrapped note, one registration away |

Each chain proves its state to the other, so a bridge waits for a proof and never for a signature
([`BRIDGE.md`](./BRIDGE.md)). A note burned on Bitcoin is minted in the pool, and a note crossed out of the pool is
minted again on Bitcoin. A Bitcoin note bound to the pool can also be spent in the pool directly, with no bridge
step first ([`SPEC.md` §6.3](../SPEC.md#63-two-ways-bitcoin-value-reaches-ethereum)). A bridged note and a wrapped
one of the same asset are one asset, so they trade in the same pool.

## Read it yourself

```
cast call $POOL "pools(bytes32)(bool,bytes32,bytes32,uint256,uint256,uint32,uint256)" $POOL_ID
cast call $PUBLIC_AMM "quoteSwap(bytes32,bytes32,uint32,uint256)(uint256)" $ASSET_IN $ASSET_OUT 30 $AMOUNT
```

`pools` returns `(init, assetA, assetB, reserveA, reserveB, feeBps, totalShares)` in in-system units, where a value
is the amount divided by `unitScale`. `assets(assetId)` gives the scale, and [`DEPLOYMENTS.md`](./DEPLOYMENTS.md) has
the addresses.

## Source

| | |
| --- | --- |
| Pool, reserves and shares | [`ConfidentialPool.sol`](../contracts/src/ConfidentialPool.sol) |
| Public swap and liquidity | [`TacitPublicAmm.sol`](../contracts/src/TacitPublicAmm.sol) |
| Swaps and zaps in one call | [`ConfidentialRouter.sol`](../contracts/src/ConfidentialRouter.sol) |
| The last step of a swap from any token into tacUSD or tacBTC | [`TacitAmmRoute.sol`](../contracts/src/TacitAmmRoute.sol) |
| Private swap and liquidity ops | [`dapp/confidential-swap.js`](../dapp/confidential-swap.js), [`dapp/confidential-lp.js`](../dapp/confidential-lp.js) |
