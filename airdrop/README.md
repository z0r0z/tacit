# TAC airdrop snapshot

Token-holder snapshots that fixed the initial TAC distribution.

The two CSVs are Etherscan token-holder exports for the
Ethereum-rooted zOrg DeFi DAO contracts whose holders received
the initial TAC airdrop. zOrg has operated as a DeFi protocol on
Ethereum for over a year.

- [`export-tokenholders-for-contract-0x00a6ba94bbb5474725515de88fe04f854f2dcb12.csv`](./export-tokenholders-for-contract-0x00a6ba94bbb5474725515de88fe04f854f2dcb12.csv)
- [`export-tokenholders-for-contract-0xe9b1cfea55baa219e34301f2f31b9fd0921664ed.csv`](./export-tokenholders-for-contract-0xe9b1cfea55baa219e34301f2f31b9fd0921664ed.csv)

Each row is `(address, balance)` at the snapshot block. The CSVs are
the same shape Etherscan exports — directly consumable by the dApp's
**Drops** flow (`T_DROP` / `T_DCLAIM`, SPEC §5.12–5.13) for snapshot
verification.

The distribution carried real economic cost on both sides. zOrg
eligibility was earned through ETH spending — share purchase, protocol
fees, or LP farming on Ethereum — so airdrop recipients had skin in
the game before any TAC was minted. Fulfillment then paid Bitcoin
fees to broadcast the on-chain envelopes, so the distribution side
also burned real value through Bitcoin's fee market.

TAC has traded on the open DeFi market since the airdrop, and the
asset is etched on Bitcoin via the public-mint `T_PETCH` /
`T_PMINT` mechanism with a fixed 21M-base-unit cap. An active OTC
market for TAC settles at [tacit.finance](https://tacit.finance)
through the protocol's atomic asset-vs-BTC settlement primitives
(`T_AXFER` / `T_AXFER_VAR` and the atomic-intent flow).

See [`WHITEPAPER.md`](../WHITEPAPER.md) §13 for TAC's role in the
protocol; see [`SPEC.md`](../SPEC.md) §5.12–5.13 for the on-chain
snapshot-eligibility primitive.
