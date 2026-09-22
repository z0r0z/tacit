# TAC airdrop snapshot

Token-holder snapshots that fixed the initial TAC distribution on Bitcoin.

The two CSVs are Etherscan token-holder exports for the Ethereum-rooted zOrg DeFi DAO contracts whose holders
received the initial TAC airdrop:

- [`export-tokenholders-for-contract-0x00a6ba94bbb5474725515de88fe04f854f2dcb12.csv`](./export-tokenholders-for-contract-0x00a6ba94bbb5474725515de88fe04f854f2dcb12.csv)
- [`export-tokenholders-for-contract-0xe9b1cfea55baa219e34301f2f31b9fd0921664ed.csv`](./export-tokenholders-for-contract-0xe9b1cfea55baa219e34301f2f31b9fd0921664ed.csv)

Each row is `(address, balance)` at the snapshot block, in Etherscan's export format, which is the shape the
Bitcoin claim-pool ops `T_DROP` / `T_DCLAIM` read for snapshot verification (legacy ops,
[SPEC §3.8](../SPEC.md#38-legacy-ops)).

zOrg eligibility was earned through ETH spending (share purchases, protocol fees or LP farming on Ethereum), and
fulfillment paid Bitcoin fees to broadcast the envelopes, so both sides of the distribution carried real cost.
Fulfillment itself ran through one treasury wallet
([`bc1qcpxqqry2k3lt9j8nmmuwxhf0k3hp8h64xwlckq`](https://mempool.space/address/bc1qcpxqqry2k3lt9j8nmmuwxhf0k3hp8h64xwlckq)),
which took in 1,977 claim payments and answered them across 728 Bitcoin transactions — each covering several
claimants at once, the same batching principle `T_AXFER`'s batched takes formalize today.

TAC is the protocol's native asset ([SPEC §7.3](../SPEC.md#73-tac)); the [whitepaper](../whitepaper/WHITEPAPER.md)
describes its role.

The Ethereum-side distribution, through the `TacAirdrop` contract, is separate from this one; its inputs and method
are in [`v1/README.md`](./v1/README.md).
