# Tacit V1 — Feature Overview

What the Tacit protocol and dapp deliver: a private, cross-chain DeFi suite behind a
single self-custodial key.

## The core model

One self-custodial identity (a key) gives a user a **private balance held as bearer
notes** in a Merkle pool — value is owned by knowledge of a blinding factor, not an
on-chain address. Everything below happens *inside* that shielded pool, with deposits and
withdrawals as the only public boundary. The same identity spans **Bitcoin and Ethereum**
trustlessly via the zk reflection bridge, so a balance is never chain-siloed.

## What users can do

### Move value privately
- **Confidential transfer** — n-in / m-out hidden-amount sends within the pool.
- **Send-to-address (stealth)** — non-interactive payments to someone who has never
  interacted: one-time stealth addresses, the recipient scans and claims. This is also the
  airdrop primitive — batch many recipients in a single proof.
- **Invoices** — recipient-generated payment requests (the secure "send to a name" path,
  since notes are bearer).

### Trade and earn privately (confidential DeFi)
- **AMM swaps** with hidden amounts, on *both* chains, with minimum-output slippage
  protection and signed deadlines. The guest aggregates multiple intents into one net
  reserve move, so an individual trade size hides within the batch.
- **Multi-hop routes** with an end-to-end output floor.
- **Liquidity provision** — add/remove liquidity confidentially.
- **OTC** — atomic two-party fixed-price swaps (no slippage by construction).
- **Auctions / partial-fill bids** — pre-signed price and grid, walk-away semantics.
- **CDP vaults** — lock cBTC collateral, mint **cUSD**, top-up / close / liquidate, with
  live-oracle pricing. A stability-fee and a savings-rate (TSR) engine are built in and
  governance-activatable.
- **Yield farms** — bond positions, harvest rewards, unbond; rewards are escrow-backed.

### Bridge both directions, trustlessly
- **BTC → ETH** (tETH, and cBTC for real-BTC 1:1 backing).
- **ETH → BTC** (reverse reflection).
- **Adaptor swaps** — cross-chain conditional swaps.
- **Fast lane** — Bitcoin-homed value spendable on Ethereum.

### Pay no gas, expose no EOA
- **Every operation can be relayed gaslessly.** The relay fee, recipient, and expiry are
  bound *inside the proof*, so a relayer can neither redirect a payout, pad a fee, nor
  submit a stale proof. Users never need a gas-funded account to transact privately. The
  protocol also ships affiliate-split relayer infrastructure.

## The privacy you get

- **Hidden:** amounts, sender↔recipient linkage inside the pool, position sizes, and
  individual trade sizes (via batching).
- **Public by nature:** the deposit/withdraw boundary (the funding source and amount in,
  the recipient and amount out) — inherent to any shielded pool — and the fact that a
  cross-chain exit surfaces on both chains. This is ordinary public-DeFi metadata.

## The trust model

Value rules are enforced by a zero-knowledge proof that the on-chain contracts verify: no
unbacked mint, no double-spend, every spendable output authorized by its owner, and
conservation preserved across fees, partial fills, and refunds. The contracts are
**immutable**, so the rules cannot be changed out from under users.

## What it looks like, fully realized

A user opens the dapp, holds one shielded balance that works across Bitcoin and Ethereum,
and can:

- send and receive privately — to addresses, names, or airdrops,
- swap, route, and provide liquidity on a confidential AMM,
- borrow cUSD against cBTC collateral,
- farm yield,
- run OTC trades and auctions,

— all gasless, all amount-private, all without trusting a custodian or a relayer. It is, in
effect, a private cross-chain DeFi suite behind a single key.

## Launch posture

- V1 launches **capped** (a dapp-level pilot, not an on-chain limit) and is designed so
  users can always exit permissionlessly and re-enter an upgraded pool — graceful
  deprecation, never a brick.
- Some capabilities are **dormant by design** (the cUSD stability fee and the savings rate)
  — present, inert, and governance-gated until enabled.
