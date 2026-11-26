# A pledged Bitcoin desk for stuck TAC

**Option A.** A fast-bridge provider can trade its stuck Bitcoin TAC for a pledger's tracked Bitcoin TAC. The existing
Bitcoin desk settles the exchange. The provider can burn the tracked payout over the regular bridge and replenish its
Ethereum inventory. Each pledger names their own wallet's tracked outpoints, sets a price and miner-fee limit, and
serves the desk from their own installation. A holder sees the exact payout and discount before locking a note.

The example pledge starts empty. The desk checks that the operator's wallet can open each note and that the reflection
tracks it. It carries the pledge forward only to tracked change from its own funded locks. The operator can withdraw a
root between swaps. The daemon checks both ends of the configured discount range on the actual amounts, including any flat
fee. It checks the signed Bitcoin lock, take and refund against the miner-fee cap before storing or sending each pair.
The wallet uses the provider's existing pool-exit reader when validating a holder's notes.

### What the provider holds after 20 fast bridges

Start with 1,000 TAC available on Ethereum. Each bridge pays out 100 TAC and brings in 100 TAC on Bitcoin. Eighteen receipts
return at par. Two receipts need the desk. Its 5% quote pays 95 tracked TAC for each 100 stuck TAC. Each row assumes
the available swaps settle and the provider bridges their payouts home before the next request.

| Tracked TAC pledged at start | Ethereum TAC at end | Provider's stuck Bitcoin TAC | Pledger's stuck Bitcoin TAC | Pledger's tracked TAC left |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 800 | 200 | 0 | 0 |
| 95 | 895 | 100 | 100 | 0 |
| 190 | 990 | 0 | 200 | 0 |

The difference is who holds the stuck TAC. The pledger in the last row pays 190 tracked TAC for 200 stuck TAC and bears
the resale risk. The 5% discount and two stuck receipts are scenario assumptions. Bitcoin fees, bridge fees, the time to
return tracked TAC and a market for the stuck notes all affect the realized result. Quotes are indicative until funded.
A stopped holder can leave a desk refund untracked. A miner-fee cap set too low can delay settlement beyond a refund window.

### Verification

These offline suites use Node 22 and the existing locked packages in `tests/`, `worker/` and `worker-relay/`.

```sh
node --require ./tools/noweb.cjs tests/btcswap-pledge.test.mjs
node --require ./tools/noweb.cjs tests/btcswap-sim.test.mjs
node --require ./tools/noweb.cjs tests/btcswap-reflect.test.mjs
node --require ./tools/noweb.cjs tests/fastbridge-exit-note.test.mjs
```

The pledge suite exercises limits, restart behavior and the table above. The existing reflection test folds the joint lock
and the holder's claim. The exit test replays the recorded November 7 mainnet pool exit through the live-wallet reader.

Bitcoin Core 29.1 also confirmed both claims on a private Signet. The test etches a disposable asset, pledges one of
two equal-sized desk notes, completes the swap through the desk API, validates both resulting notes and checks that the
other desk note remains unspent. The following commands use Bitcoin Core on `PATH`.

```sh
dir=$(mktemp -d)
bitcoind -datadir="$dir" -signet -signetchallenge=51 -networkactive=0 -listen=0 -txindex=1 -fallbackfee=0.00005 -daemonwait
BTCSWAP_SIGNET_DIR="$dir" node --require ./tools/noweb.cjs tests/btcswap-pledge-signet.mjs
bitcoin-cli -datadir="$dir" -signet stop
```

The private Signet test supplies reflection status and uses a test asset. Mainnet settlement, a live Ethereum mint,
a 256-transfer holder history and the achievable resale price were not tested. [Desk operation](../btcswap-desk/README.md)
