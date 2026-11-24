# Stuck TAC bounty: bring the fast bridge's TAC on Bitcoin back into use

Fast bridge providers lend private TAC on Ethereum and take TAC on Bitcoin in return. Two kinds of TAC on Bitcoin cannot go home over
the regular bridge, so a provider that takes them cannot lend that value again. This bounty is for a way to put that TAC back to
work, or to price it so providers can take it safely.

| | |
|---|---|
| **Reward** | **300 TAC** (about $245 at today's $0.82), to the Ethereum address you name in your pull request, once the entry is merged. Community pledges add to it (section 6). |
| **Closes** | 2026-12-16 |
| **Enter by** | a pull request to [`z0r0z/tacit`](https://github.com/z0r0z/tacit) titled `stuck TAC: <your name>` |
| **Questions** | an issue on the same repo titled `stuck TAC: question`, so every entrant sees the answer |

## 1. The problem

A provider carries TAC from Bitcoin to Ethereum over the regular bridge ([`docs/BRIDGE.md`](BRIDGE.md)) to lend it again. The
bridge's burn proof can only carry some notes:

- **TAC that left Bitcoin's shielded pool** (a pool exit, opcode `0x6d`). The proof walks a note's history back through its
  transfers to the etch; it does not follow a history through the pool.
- **TAC with more than 255 transfers behind it.** The proof is bounded (`ncx > 256` in
  [`cxfer-core/src/burn_deposit.rs`](../contracts/sp1/confidential/cxfer-core/src/burn_deposit.rs)), and splitting a note does not
  reset it: each part inherits the whole history and the split itself.

What follows ([`docs/FAST-BRIDGE.md`](FAST-BRIDGE.md), "Which notes a provider can take"): a provider that takes any TAC the validator
accepts (`anyTac`) ends up holding Bitcoin TAC it cannot bring home, so its Ethereum-side capacity shrinks with every such bridge. A
provider that screens refuses these notes, and the holder is left with a note the regular bridge cannot carry either. In a count on
2026-11-22, 230 of 4,546 unspent TAC notes (about 5%) were over the history limit, with pool exits not counted.

What works today: a round trip through Ethereum resets a note's history, because a note minted by a cross-out is tracked from birth.
Stuck TAC cannot start that trip. TAC on Bitcoin is still TAC there: it can be held, listed on the Bitcoin order book, or swapped.

## 2. The goal

A provider (or a holder) can turn stuck Bitcoin-side TAC into TAC that can be lent on Ethereum, or can price and hold it safely, so
fast bridge capacity stops draining. Any one of these is a valid entry; do one well. Mixed entries are welcome.

- **A. A desk for stuck TAC.** Swap stuck TAC for tracked TAC on Bitcoin at a clear, bounded discount, funded by pledged tracked
  TAC. Start from [`btcswap-desk/`](../btcswap-desk) and [`dapp/btcswap-page.js`](../dapp/btcswap-page.js) (built, not running).
- **B. A rebalance loop for the provider daemon** ([`fastbridge-lp/`](../fastbridge-lp)). Sell stuck Bitcoin TAC on the order book
  at a floor and bring the proceeds back as Ethereum-side inventory, automated, with limits and alerts.
- **C. A pricing and policy rule.** A provider takes stuck TAC only at a fee that covers its expected haircut, by class (clean, long
  history, pool exit). Classes are told apart today by `lineageScreen` in [`dapp/fast/wire.js`](../dapp/fast/wire.js) and
  `policy.screen` in [`dapp/fastbridge-el.js`](../dapp/fastbridge-el.js).
- **D. A design, with tests and no deploy,** for a rule in the reflection proof that accepts pool exits and longer histories. That
  needs a new pool generation, so it is a design entry and is not merged to the live system.

## 3. What does not move

- The live pool, the proof's verifying key and every deployed contract stay as they are.
- Ads, quotes, requests and replies stay compatible with the pages and providers already running: new fields are optional, and an
  old page or provider keeps working unchanged.
- No one's funds are held under one key, and a provider never sells below a floor it can read in its own config.
- No new dependencies, no remote resources, no minified code. Outside code is read in full before it is merged.

## 4. What to submit

A pull request with: a one-page description of what it does and what it assumes; the code and tests (offline where they can be, on a
fork or signet for the chain parts); numbers showing what a provider holds after N bridges with and without it; and the risks you
see. Say plainly what you did not test.

## 5. How entries are judged

In this order: it works as described on realistic inputs; it is safe by default (nothing is sold or spent without a stated limit);
it is simple; it fits how providers run today; the write-up is clear. One entry is merged and takes the reward in full; two entries
that fit together may both be merged, and the reward is then shared.

## 6. Pledges

Anyone can add to the reward by commenting on the issue with an amount of TAC, paid once the entry is merged. A holder of stuck TAC
can also pledge to **sell** it through the winning entry at its floor: that is a commitment to use the result, not a payment, and it
shows the entry real demand. Rewards are paid in TAC that can move.
