# TAC

TAC is Tacit's native token. It was issued once on Bitcoin with a fixed supply of 21,000,000 and no mint
authority, and it is bridged to Ethereum as an ERC-20 minted only against a proven Bitcoin-side burn
([SPEC §7.3](../SPEC.md#73-tac), [deployment details](./DEPLOYMENTS.md#tac)).

## Holding TAC

- **Boosted points.** Hold 100 / 1,000 / 10,000 TAC in the same wallet you use on Tacit and each points
  activity earns 1.25× / 1.5× / 2× your share of that day's TAC reward pool. The tier is the lowest balance
  the wallet held over the previous 24 hours (7,200 blocks), so buying just before an activity and selling
  after earns nothing. It applies to every points activity (ETH wraps, cBTC collateral posts, cUSD mints and
  zRouter ETH swaps on Ethereum, Base and Robinhood) from block 26061220 on.
- **Cheaper private exits.** The dapp lowers the relayed exit fee for TAC holders from 0.30% to 0.25% /
  0.20% / 0.15% at the same tiers, counting shielded TAC, the public TAC on the wallet's own Ethereum account
  and TAC in a connected Ethereum wallet. The relay's cost floor still applies, so small exits pay the floor either way.
- **Governance.** Holders vote on how the protocol's governed parts are run (see [Governance](#governance)).

## Where usage flows

- **Relay fees paid in TAC are never sold.** The relay moves any TAC it collects to the protocol reserve,
  the ops multisig, once it reaches 100 TAC.
- **A quarter of the relay's ETH surplus goes to buybacks.** Relay fees first pay for gas and proving. A
  quarter of any ETH left over is sent to TacBuyback.
- **Buybacks.** [TacBuyback](https://etherscan.io/address/0x6919cbEf0e70AFFA02Ae02c86c532A137154f250) holds
  ETH sent to it and buys TAC on the public TAC/ETH market, on the Tacit pool or the TAC/ETH Precision pool,
  whichever quotes better. The TAC goes straight to the reserve; the contract never holds it.
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
- **Voting** is by proving a balance tier (1 / 10 / 100 / 1,000 / 10,000 / 100,000 TAC) without revealing the
  exact balance. It is available to Bitcoin TAC holders today.
- **Snapshots.** Weight is fixed when a proposal opens: TAC counts only if it was held then and not yet
  spent, so TAC moved afterwards cannot vote again.
- **Execution.** Results are advisory. The ops multisig carries out passed proposals, and each one's page links
  the multisig transaction that did it, checked on-chain, or shows it as still awaiting execution.

The same data is available at `GET https://api.tacit.finance/governance/oversight?network=mainnet`, and
proposals at `/governance/proposals`.

## Addresses (Ethereum)

| | Address |
| --- | --- |
| TAC ERC-20 | [`0xA1313eb9f3A445606D9583bcAc3ebeB56a858279`](https://etherscan.io/address/0xA1313eb9f3A445606D9583bcAc3ebeB56a858279) |
| TacBuyback | [`0x6919cbEf0e70AFFA02Ae02c86c532A137154f250`](https://etherscan.io/address/0x6919cbEf0e70AFFA02Ae02c86c532A137154f250) |
| TacBuyback keeper | [`0x1eeb713E6EAfbcFADb217664d53CF8DBDEc45fda`](https://etherscan.io/address/0x1eeb713E6EAfbcFADb217664d53CF8DBDEc45fda) |
| Reserve (ops multisig) | [`0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2`](https://etherscan.io/address/0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2) |
| PointsDistributor | [`0x000000C918e44A3a443937fA7594eA4f7C95D6b9`](https://etherscan.io/address/0x000000C918e44A3a443937fA7594eA4f7C95D6b9) |

Source: [`TacBuyback.sol`](../contracts/src/TacBuyback.sol), the keeper
[`buyback-keeper.js`](../worker-relay/src/buyback-keeper.js), the points boost
[`tac-holder-boost.js`](../worker-relay/src/lib/tac-holder-boost.js).
