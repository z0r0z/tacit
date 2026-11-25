# Technical review: stuck-TAC recovery

## Executive conclusion

The first idea was a provider daemon loop that sells stuck Bitcoin TAC for sats, spends those sats to buy bridgeable TAC, and runs the existing bridge-home tool. Inspection of upstream code revealed a more direct existing mechanism: the Bitcoin-to-Bitcoin swap desk.

The desk's documented protocol is:

1. Holder locks a note whose lineage cannot be followed by the Ethereum reflection proof.
2. Desk validates the holder lock and locks tracked TAC for the holder, less its configured fee.
3. Holder claims the desk's tracked TAC through the joint key-path/adaptor signature.
4. Desk extracts the adaptor secret and claims the holder's stuck note.
5. Holder bridges the received tracked note to Ethereum using the existing bridge.

This is materially better than a sell-for-sats loop: it avoids dependence on order-book depth, bid/ask spread, market-maker APIs, and the uncertain ability to reacquire the exact tracked class. It is also already represented by upstream code rather than requiring a new swap protocol.

## Upstream evidence inspected

- `docs/STUCK-TAC-BOUNTY.md`: bounty explicitly accepts option A, a desk for stuck TAC, and points to `btcswap-desk/` and `dapp/btcswap-page.js`.
- `btcswap-desk/README.md`: describes a two-lock Bitcoin-to-Bitcoin exchange and its timelock/refund risk.
- `btcswap-desk/server.mjs`: wires the desk to the wallet, chain adapter, inventory, reflection tracking, durable store, and HTTP server. It supports `--dry-run`.
- `dapp/btcswap-desk.js`: `makeBtcSwapDesk` checks holder lineage, chooses only desk notes marked `tracked`, serializes note selection, persists swap phases, and handles the claim/refund flow.
- `dapp/btcswap-page.js`: client-side holder flow exists, but `DESK` is currently `null`, so no production desk endpoint is configured there.
- `fastbridge-lp/README.md`: explicitly says rebalancing is not performed by the daemon today; it describes manual bridging and the inventory/bridge-home scripts.
- `fastbridge-lp/lib/refill.mjs`: replenishes the provider from a treasury allowance or public TAC sent to its address; it does not solve stuck Bitcoin-note lineage.

## Recommended prototype direction

Prototype the desk path, not the order-book loop, as the primary candidate:

- Start in signet/test fixtures; never use a production key or mainnet funds for tests.
- Keep desk inventory separate from the provider's operational swap inventory.
- Only select desk outputs whose reflection tracking result is exactly `tracked`. Unknown, unread, bound, or untracked outputs must be excluded.
- Preserve the upstream minimum/maximum amount, fee floor, quote expiry, confirmation tiers, and timelock margins.
- Keep the desk disabled unless an operator explicitly configures its URL and enables it.
- Use durable state, per-swap serialization, idempotent step handling, and alerts for `lost`, `refunding`, unread claims, or prolonged open swaps.
- Do not use treasury allowance or central custody as a substitute for desk inventory.
- Never bridge the stuck note itself. Bridge only the tracked note received from the desk.

## Economic model

Let:
- (S_0) be the provider's initial Ethereum-side lendable TAC.
- (a_i) be the TAC amount paid out by the provider for bridge (i).
- (u_i) be the Bitcoin-side TAC received, potentially untracked.
- (f_i) be the desk fee/haircut paid to obtain tracked TAC.

Let `C` be the set of clean notes that return through the ordinary bridge and `T` the set of stuck notes accepted by the desk. Without recovery, Ethereum-side lendable inventory after (N) bridges is:

`S(N) = max(0, S0 - sum(a_i) + sum(i in C, u_i))`

With a funded desk, and assuming every stuck note can be swapped and its tracked output successfully bridged back, the inventory becomes:

`S_recovered(N) = max(0, S0 - sum(a_i) + sum(i in C, u_i) + sum(i in T, max(0, u_i - f_i)))`

This is an accounting upper bound, not a liquidity guarantee. Desk capacity, counterparty completion, fees, confirmations, proof availability, and the holder's bridge costs constrain realized recovery.

The executable model in `sim/rebalance-model.mjs` uses explicit inputs and never assumes a live market price.

## Main risks and mitigations

| Risk | Mitigation / stop condition |
|---|---|
| Desk lacks enough tracked TAC | Quote refuses; no partial promise beyond available tracked notes |
| Holder abandons after desk locks | Bounded open sessions and desk timelock refund; quantify locked inventory at risk |
| Holder note is not actually stuck or is already spent | Re-derive lineage and chain status from trusted chain reads; reject ambiguous states |
| Desk accidentally selects untracked note | Require exact `tracked` classification; fail closed on missing tracking data |
| Duplicate spends after restart | Durable records, idempotent phases, atomic storage and restart tests |
| Reorg or stale explorer data | Confirmation thresholds, independent reads, retry without advancing on disagreement |
| Fee/price makes swap uneconomic | Explicit fee schedule and minimum output floor; no automatic floor reductions |
| Mainnet key or funds exposed during testing | Signet/test fixtures only; no secrets in repo or logs |

## Existing upstream tests and validation added in this lab

The upstream repository already contains focused, offline/simulated tests for the desk; the lab now has a GitHub Actions workflow at `.github/workflows/upstream-btcswap.yml` that checks out upstream `main`, installs its exact lockfile dependencies with `npm ci`, and runs:

- `node tests/btcswap-sim.test.mjs` — ten scenarios covering a completed swap, early claim, refusal of untracked desk inventory, unreachable desk refund, insufficient desk inventory, holder timeout/refund, signing-session authorization/replay protection, per-swap keys, malformed/immature offers, and witness/output binding.
- `node tests/btcswap-reflect.test.mjs` — checks that the tracked desk output and holder key-path claim are folded as live by the reflection model and that the adaptor secret is recovered.

The first GitHub Actions run completed green on 2026-11-25: upstream dependencies installed, `btcswap-sim.test.mjs` passed, and `btcswap-reflect.test.mjs` passed. The run is recorded at https://github.com/ryzaki369-cyber/tacit-stuck-tac-lab/actions/runs/45581204444. The lab's own `tests/rebalance-model.test.mjs` is also included in CI. Workflow runs #3 and #4 both passed all steps, including the local accounting model, upstream desk simulation, and reflection/key-path compatibility tests.

## What is not yet proven

- The upstream simulation and reflection/key-path tests have passed in GitHub Actions; this does not establish a signet end-to-end deployment.
- I have not executed a signet end-to-end swap.
- I have not generated or verified a real reflection proof for the desk output.
- I have not tested Bitcoin reorgs, explorer disagreement, server crash/restart during every signing phase, or a live Ethereum mint.
- I have not measured real order-book depth or a provider's market-specific haircut.
- The local simulation tests accounting only; it does not prove the cryptographic protocol.

## Bounty fit

This lab currently supports a design/prototype review of option A. It is not yet a complete bounty submission. Before proposing upstream changes, the next validation step is to add a signet integration test proving: stuck input accepted, tracked output paid, holder claims it, desk takes the input, and the output passes the existing bridge review.
