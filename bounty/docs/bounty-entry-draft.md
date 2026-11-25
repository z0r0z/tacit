# Stuck TAC recovery desk — option A

**Entry status: design/prototype for review; not production-ready.**  
**Requested reward address:** `0x564B2D23Fe4E4d08128B024CFA81E7D86EEc521A` This entry reuses Tacit's existing Bitcoin-to-Bitcoin swap desk rather than changing the live bridge.

## Proposal

A holder with a Bitcoin TAC note that the regular Ethereum reflection proof cannot carry offers it to a separately funded recovery desk. The desk pays a tracked Bitcoin TAC note at a disclosed, bounded discount. The holder can then use the existing bridge with the tracked output. The desk claims the holder's stuck input through the existing two-lock, MuSig2/adaptor-signature swap flow.

The upstream desk implementation is in `btcswap-desk/` and `dapp/btcswap-desk.js`; its page currently has no production desk endpoint configured (`DESK = null`), and the desk is built but not running. This proposal is therefore for a deliberately opt-in, separately funded desk—not a claim that a public recovery service is already operating.

## Safety and operating assumptions

- The operator explicitly funds a segregated desk inventory of Bitcoin TAC notes whose lineage is classified exactly `tracked`.
- The desk independently checks input validity, spend status, and lineage. Unknown, unread, or ambiguous classifications fail closed; only notes accepted by the stuck-note policy may be offered.
- Quotes state the fee/haircut, minimum output, amount limits, expiry, and confirmation/timelock margins. The desk refuses if inventory or fee funding is insufficient.
- Open swaps and locked value are capped. Swap phases are persisted and idempotent; note selection is serialized; each swap uses its own signing keys.
- No shared custody key is introduced. The live pool, deployed contracts, reflection proof, verifying key, and existing page/provider wire formats remain unchanged. No new dependencies are required by the lab tests.

## Numerical example: provider inventory after N bridges

Assume a provider starts with 10,000 TAC of Ethereum-side lendable inventory and completes ten bridges of 1,000 TAC each. Five received Bitcoin notes are stuck and five are bridgeable. The recovery desk has enough tracked inventory for all five stuck notes and charges 1% (10 TAC) per recovered 1,000 TAC note. Ignore other costs, delay, defaults, and liquidity constraints.

| After 10 bridges | No recovery desk | With recovery desk |
|---|---:|---:|
| Starting lendable inventory | 10,000 TAC | 10,000 TAC |
| Ending lendable inventory | 5,000 TAC | 9,950 TAC |
| Value lost to five stuck notes | 5,000 TAC | 50 TAC fees |

The five clean notes round-trip normally in both cases. Without recovery, the five stuck notes strand 5,000 TAC. With the desk, they return 4,950 TAC net of fees. This is an illustrative scenario, not a market quote or liquidity guarantee. The executable model uses integer 8-decimal TAC base units.

## Evidence and tests

The lab CI runs its offline integer accounting tests and Signet configuration safety check, then checks out the upstream Tacit repository at pinned commit `e4bb9297880502d5b8a341383b0baf69eefff509` and runs the upstream simulated-chain Bitcoin desk and reflection/key-path tests. Those upstream tests exercise the actual holder/desk state machines with constructed Bitcoin transactions in a simulated chain, including success, timeout/refund, untracked or insufficient desk inventory, signing authorization/replay protection, per-swap keys, and reflection-model key-path behavior.

Evidence and test details: [upstream simulation report](upstream-sim-evidence.md), [technical review](technical-review.md), [Signet runbook](signet-e2e-runbook.md), [CI workflow](../.github/workflows/stuck-tac-bounty-tests.yml).

## Risks and untested work

Inventory can run out; lineage or chain data can be stale or disagree; a holder or desk can disappear; reorgs, fee pressure, restart bugs, or uneconomic pricing can strand capital. The mitigations above reduce but do not eliminate these risks.

**Not tested:** a live Signet end-to-end swap; a maintainer-confirmed Signet TAC asset/pool mapping and funded test inventory; a newly generated SP1 reflection proof settled by the deployed Ethereum verifier; real Bitcoin reorgs or explorer disagreement; production liquidity, monitoring, and operator runbooks. No mainnet funds or production secrets were used.

**Review limitation:** the lab is not an upstream implementation PR, and the desk is not activated. Before calling this production-ready, obtain the correct Signet deployment details and run the full stuck-input → tracked-output → holder-claim → desk-claim → bridge-review path.