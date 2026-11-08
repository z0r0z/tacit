# TAC

TAC is Tacit's native token, born on Bitcoin. It was issued once with a fixed supply of 21,000,000 and no
mint authority. Balances are confidential and receives are stealth by default, and a shielded pool gives full
privacy. On Ethereum, which adds its markets and programmability, TAC is an ERC-20 that only the confidential
pool can mint, from TAC proven to have left Bitcoin ([SPEC §7.3](../SPEC.md#73-tac),
[deployment details](./DEPLOYMENTS.md#tac)). Verify the fixed supply and the ERC-20 yourself at
[tacit.finance/verify.html](https://tacit.finance/verify.html): the page reads Bitcoin, IPFS and Ethereum in
your browser and recomputes every check, with no Tacit server or indexer asked.

## What TAC does

- **Private payments, on Bitcoin and on Ethereum.** On Bitcoin, TAC's amounts are hidden by default, and the
  shielded pool hides who paid whom as well. On Ethereum, one signed permit takes TAC onto the
  [Tacit chain](./TACIT-BLOCKS.md), a validity rollup, which needs no ETH. There a payment to anyone costs about a
  cent of TAC and lands in about a minute. A balance there is a number of shares of the chain's pool. Every payment leaves
  0.002 TAC in the pool and every withdrawal 0.1% (at least 0.002 TAC), so each share is worth a little more after
  each one. The same TAC moves between the two chains by proof, and into the private pool to swap, farm and borrow.
  [tacit.finance/tac](https://tacit.finance/tac/).
- **Pays for gas.** A public swap or pool entry can be paid in TAC (or the token being spent) instead of ETH.
  The holder signs one order and a solver submits it through
  [TacitGasRelay](https://etherscan.io/address/0x000000197E8f0B64463B2010e568fF42090Af88d), which takes its fee
  in TAC. The contract is immutable and calls only the routers it was deployed with.
- **Pays for proofs.** A holder who wants a private wrap proved fast signs an order with a TAC permit. Any
  prover can claim it through [ProofMarket](https://etherscan.io/address/0x0000000033Dd45B1686Ba37e5F6e4ABDdaC17609)
  and is paid in TAC the moment the pool accepts the proof, so anyone with a prover can earn TAC
  ([tacit prove](https://tacit.finance/prove/#tab=bitcoin)).
- **Collateral.** [Borrow TACD (a dollar) or TACE (ether) against TAC](https://tacit.finance/vault/) and keep
  the TAC: no interest, one fee when you borrow, and prices that move slowly. The fee goes to the reserve.
- **Cheaper exits.** The dapp lowers the relayed exit fee for holders from 0.30% to 0.25% / 0.20% / 0.15% at
  100 / 1,000 / 10,000 TAC, counting private TAC notes, the public TAC on the wallet's own Ethereum account and
  TAC in a connected wallet. The relay's cost floor still applies, so small exits pay the floor either way.
- **Boosted points.** Hold 100 / 1,000 / 10,000 public TAC at the address that sends a points activity and its
  points are multiplied by 1.25× / 1.5× / 2×. The tier is the lowest balance the address held over the previous
  24 hours (7,200 blocks), so buying just before an activity and selling after earns nothing. Only the public
  ERC-20 counts. It applies to every points activity (ETH wraps, EVM pool deposits, zRouter and zSwap ETH swaps,
  zSwap bets and markets, .wei names, wstETH bond posts and cUSD mints, on Ethereum, Base and Robinhood Chain)
  from block 26061220 on.
- **A vote.** Holders vote on how the protocol's governed parts are run (see [Governance](#governance)).

## Trading TAC

[tacit.finance/trade/tac](https://tacit.finance/trade/tac/) prices every place TAC trades and quotes the best way to trade an amount:

- **The Bitcoin order book**, in sats: listings (taken whole) and standing bids. A sale to a bid settles when its bidder is online;
  a sale can also be listed at your price.
- **The Precision pool** on Ethereum (TAC/ETH, 0.30% fee), the deepest. It records a price tape on chain (5-minute and 4-hour
  candles), read with `eth_call` and no indexer, which is the page's Ethereum chart. It is a chart, not an oracle: it shows executed
  prices with fees, and one small trade can move a candle's high or low.
- **The Tacit pool**, the AMM inside the confidential pool: one set of reserves, swapped publicly through
  [TacitPublicAmm](./DEPLOYMENTS.md) (amounts visible) or privately with shielded notes.
- **Uniswap v4 and other pools.** Three hookless ETH/TAC pools exist on Uniswap v4 (fees of 15%, 30% and 40%) and hold no liquidity
  today. zQuoter, which finds routes on Uniswap v2/v3, Sushi, Curve and v4's standard fee tiers, does not look at fees that high, so the
  page reads those pools itself.
- **zSwap's order boards** (Swapboard v1 and v2, Dutchboard, Floorboard). The page reads every TAC order on them and fills one, or the
  best several in a single `snwap` through zSwap's Swapbol executor. It uses them on its own when they take the whole amount and pay 1%
  more than the pools. Orders made out to one account are not offered. `dapp/zboards.js` has the reading and the calldata, and
  `tests/zboards-fork.mjs` places and fills orders on all four boards on a mainnet fork.

An order can be **split across the Precision pool and the Tacit pool in one transaction**, which pays more once it is large enough
to move either price. zRouter's own legs cannot do this with ETH (each forwards the whole transaction value, and the Precision route
requires its input to equal that value), so the split is a single `snwap` whose executor is Multicall3: its `aggregate3Value` gives
each pool its exact share, and one minimum bounds the total received. The page splits only when the extra output is worth the extra
gas, tests the transaction once without sending it, and falls back to one pool if that fails. `dapp/evm-trade-venues.js` has the
quoting and the calldata, and `tests/tac-split-fork.mjs` runs both directions on a mainnet fork.

## Where usage flows

- **Fees paid in TAC are never sold.** The relay moves any TAC it collects to the protocol reserve, the ops
  multisig, once it reaches 100 TAC. The one-time fee on TACD and TACE loans goes to the reserve too.
- **10% of the relay's fee income goes to buybacks.** Every pass the relay sends a tenth of the ETH-value
  of the fees it earned (ETH and the tokens it converts) to TacBuyback, before gas and proving are paid
  from the rest. It keeps a small float for its next settles, so a share it cannot spare yet is carried
  and paid as soon as it can. The relay's own books, the wallets and every buy are on the
  [relay page](https://tacit.finance/relay/).
- **Buybacks.** [TacBuyback](https://etherscan.io/address/0x6919cbEf0e70AFFA02Ae02c86c532A137154f250) holds
  ETH sent to it and buys TAC on the public TAC/ETH market, on the Tacit public pool or the TAC/ETH Precision
  pool, whichever quotes better. The TAC goes straight to the reserve; the contract never holds it.
  - Each buy is at most 0.25 ETH, at most one every 6 hours, and at most 1% of that pool's ETH liquidity, so
    buys stay small and grow with the market.
  - The contract is immutable and has no owner. Its ETH can only become TAC for the reserve or be returned
    to the reserve.
  - A keeper submits buys privately and holds off when a buy would be too small to be worth the gas.
- **The reserve is not sold.** Reserve TAC is used for liquidity, rewards and grants.

## Governance

Governance oversees everything the ops multisig controls: the treasury and reserve, CollateralEngine
(collateral ratios, price feeds, the cUSD stability fee), FarmManager (reward weights), the airdrop guardian
and pool succession. The **Protocol** view in the dapp's Govern tab shows each of these with live on-chain
values, who holds the role, and anything queued to change, with a button to propose a change to it.

- **Proposing** takes proof of at least 100 TAC. Proposals and final results are pinned to IPFS.
- **Voting.** Bitcoin TAC holders vote by proving a balance tier (1 / 10 / 100 / 1,000 / 10,000 / 100,000 TAC)
  without revealing the exact balance. Holders of the public ERC-20 vote by signing with their Ethereum
  wallet, and their exact balance counts.
- **Snapshots.** Weight is fixed when a proposal opens: TAC counts only if it was held then and not yet
  spent, so TAC moved afterwards cannot vote again.
- **Execution.** Results are advisory. The ops multisig carries out passed proposals, and each one's page links
  the multisig transaction that did it, checked on-chain, or shows it as still awaiting execution.

The same data is available at `GET https://api.tacit.finance/governance/oversight?network=mainnet`, and
proposals at `/governance/proposals`.

## Integrating the ERC-20

A checklist for listing it (quoting, routing, prices, metadata) is in the
[integrator playbook](./INTEGRATOR-PLAYBOOK.md#3c-listing-the-tac-erc-20).

- **Identity.** TAC on Ethereum is [`0xA1313eb9f3A445606D9583bcAc3ebeB56a858279`](https://etherscan.io/address/0xA1313eb9f3A445606D9583bcAc3ebeB56a858279).
  Its `MINTER()` is the confidential pool
  [`0x000000000Ed1eabD231Be41d93b719056F7febFC`](https://etherscan.io/address/0x000000000Ed1eabD231Be41d93b719056F7febFC),
  its `ASSET_ID()` is the Bitcoin asset id `0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b`,
  and the pool's `canonicalTokenFor(ASSET_ID)` returns it. Every Tacit canonical token is named "Tacit Token",
  so identify TAC by this address, or by those three reads, never by name or symbol alone.
- **Units.** 18 decimals over Bitcoin TAC's 8: the pool mints and burns whole multiples of `1e10`, and a wrap
  of any other amount reverts.
- **Supply.** Only the pool mints TAC, when a TAC note leaves it (a proven withdrawal) or when its public AMM
  pays a swap out of TAC already in the pool's reserve, and it burns TAC when TAC is wrapped back in. Every
  TAC in the pool came from Bitcoin, through a bridge burn the pool pays once or a fast-lane spend of a
  reflected note ([SPEC §6.3](../SPEC.md#63-two-ways-bitcoin-value-reaches-ethereum)), so the ERC-20 supply
  stays within the 21,000,000 etched. [verify.html](https://tacit.finance/verify.html) checks the token's code,
  its wiring to the pool and the etch, its supply and wTAC's backing from your browser; `node tools/verify-live.mjs`
  checks the same and the pool's own code and keys ([what it checks](./VERIFY-LIVE.md)).
- **Behaviour.** A standard ERC-20: no transfer fee, rebasing, hooks, pause, blacklist or owner. It supports
  EIP-2612 `permit` (name `Tacit Token`, version `1`), and the canonical Permit2 contract holds a standing
  maximum allowance from every holder, so Permit2 signatures need no approval transaction.
- **wTAC.** [`0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf`](https://etherscan.io/address/0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf)
  wraps TAC one-for-one where an escrowed ERC-20 is needed (farm rewards); `deposit` and `withdraw` move
  exactly the amount given.
- **Lineage.** The pool is immutable, and so is the token's minter. A later pool in the V1 lineage
  ([SPEC §8](../SPEC.md#8-deployment-lineage)) mints its own canonical tokens; TAC held as this ERC-20 can
  always be wrapped into this pool and exited to Bitcoin from it.

## Addresses (Ethereum)

| | Address |
| --- | --- |
| TAC ERC-20 | [`0xA1313eb9f3A445606D9583bcAc3ebeB56a858279`](https://etherscan.io/address/0xA1313eb9f3A445606D9583bcAc3ebeB56a858279) |
| wTAC | [`0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf`](https://etherscan.io/address/0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf) |
| TacitGasRelay | [`0x000000197E8f0B64463B2010e568fF42090Af88d`](https://etherscan.io/address/0x000000197E8f0B64463B2010e568fF42090Af88d) |
| ProofMarket | [`0x0000000033Dd45B1686Ba37e5F6e4ABDdaC17609`](https://etherscan.io/address/0x0000000033Dd45B1686Ba37e5F6e4ABDdaC17609) |
| TacBuyback | [`0x6919cbEf0e70AFFA02Ae02c86c532A137154f250`](https://etherscan.io/address/0x6919cbEf0e70AFFA02Ae02c86c532A137154f250) |
| TacBuyback keeper | [`0x1eeb713E6EAfbcFADb217664d53CF8DBDEc45fda`](https://etherscan.io/address/0x1eeb713E6EAfbcFADb217664d53CF8DBDEc45fda) |
| Reserve (ops multisig) | [`0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2`](https://etherscan.io/address/0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2) |
| PointsDistributor | [`0x000000C918e44A3a443937fA7594eA4f7C95D6b9`](https://etherscan.io/address/0x000000C918e44A3a443937fA7594eA4f7C95D6b9) |

Source: [`TacBuyback.sol`](../contracts/src/TacBuyback.sol), the keeper
[`buyback-keeper.js`](../worker-relay/src/buyback-keeper.js), the points boost
[`tac-holder-boost.js`](../worker-relay/src/lib/tac-holder-boost.js).
