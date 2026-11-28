# Stuck TAC Pricing & Policy Rule (Track C)

Adds `dapp/fastbridge-stuck-policy.js` for class-based pricing (`clean`, `long` >255 hops, `pool_exit` / `0x6d`) with explicit fee floors (`minHaircutBps`), dynamic utilization surcharge (`utilizationSlopeBps`), hard stuck-inventory caps (`maxStuckShare` / `maxStuckUnits`), HMAC-bound v2 sealed quotes (`02...`), and anti-bait-and-switch lock screening (`policy.screen(inputs, quote)`).

## Simulation (`scripts/sim-stuck-tac.mjs`, startEth = 10,000 TAC, pLong = 5.06%, pExit = 3.00%)

| N Bridges | Strategy | Filled | Stuck Filled | Refused | Lendable ETH TAC | Stuck BTC TAC | Stuck % | Net PnL (TAC) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 100 | Naive `anyTac: true` | 100 | 7 | 0 | 9,341.3 | 686.0 | 6.8% | -3.8 |
| 100 | Strict screen | 93 | 0 | 7 | 10,024.5 | 0.0 | 0.0% | +24.5 |
| 100 | Track C | 100 | 7 | 0 | 9,378.2 | 686.0 | 6.8% | +33.2 |
| 500 | Naive `anyTac: true` | 500 | 46 | 0 | 4,780.8 | 5,360.0 | 52.9% | -96.1 |
| 500 | Strict screen | 454 | 0 | 46 | 10,120.2 | 0.0 | 0.0% | +120.2 |
| 500 | Track C | 470 | 16 | 30 | 8,709.5 | 1,496.0 | 14.7% | +143.6 |
| 1,000 | Naive `anyTac: true` | 1,000 | 82 | 0 | 1,524.4 | 8,749.0 | 85.2% | -104.2 |
| 1,000 | Strict screen | 918 | 0 | 82 | 10,239.0 | 0.0 | 0.0% | +239.0 |
| 1,000 | Track C | 934 | 16 | 66 | 8,828.3 | 1,496.0 | 14.5% | +262.4 |

## Risks & Untested Scope
- Static `extraBps` can underprice stuck TAC if Bitcoin order-book liquidity thins; mitigated by `minHaircutBps`, `utilizationSlopeBps`, and hard `maxStuckShare`/`maxStuckUnits` caps.
- Offline unit/security tests (`node --test test/stuck-tac-policy.test.mjs`) and the N-bridge simulation were verified locally; live mainnet/signet `/reflection/burndep/trace`, Bitcoin lock broadcasts, Ethereum settlement, and board gossip were not run.
