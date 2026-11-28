# Upstream swap-desk simulation: evidence and limits

## Finding

The upstream repository already contains an integration harness for the actual Bitcoin-to-Bitcoin desk state machine. Reimplementing it in this lab would duplicate better-tested code.

The CI workflow in the lab checks out the upstream `z0r0z/tacit` repository at a pinned commit and runs:

- `node tests/btcswap-sim.test.mjs`
- `node tests/btcswap-reflect.test.mjs`

The first test imports the real `dapp/btcswap-holder.js` and `dapp/btcswap-desk.js` implementations through `tests/lib/btcswap-world.mjs`. The world uses a virtual clock and simulated Bitcoin chain, constructs real commit/reveal transactions with the upstream transaction builders, and resolves notes using Tacit's real note validator. Holder and desk stores are exercised through JSON-like serialization. This is materially stronger than a hand-written phase-only mock.

## Existing scenario coverage

The upstream `tests/btcswap-sim.test.mjs` covers:

1. Full swap: holder gets the desk's note; desk claims the holder's note; adaptor secret is recovered; nonce secret is wiped.
2. Holder claims before the proof has reflected the desk lock; the holder's note remains in the tracked flow.
3. Desk inventory that the proof does not follow is rejected; holder refunds.
4. Desk unreachable; holder refunds after the timelock.
5. Insufficient tracked desk inventory; desk locks nothing and holder refunds.
6. Holder goes silent after desk lock; desk refunds and late signing is rejected.
7. Signing authorization, replay/idempotency, and rejection of a second signature for the same session.
8. Per-swap desk keys are distinct.
9. Desk offer validation rejects wrong openings, wrong amount, wrong joint lock, insufficient timelock margin, and a desk key equal to the holder key.
10. Signature sighash binding rules distinguish key-path and P2WPKH ALL signatures from unsupported forms.

The separate `tests/btcswap-reflect.test.mjs` builds the desk lock and holder MuSig2 key-path claim, folds them through the JavaScript reflection indexer model, verifies which notes remain live, and recovers the adaptor secret from the claim signature.

## What this proves

- The production desk/holder JavaScript state machines can complete the simulated protocol using real constructed Bitcoin transactions.
- Core offer validation, note lineage policy, signing-session checks, timeout/refund branches, and key-path claim behavior have regression coverage.
- The reflection-model test agrees with the expected live-note result for the synthetic test transactions.

## What it does not prove

- The simulator is not Bitcoin consensus or a Signet node; it does not replace a real network test.
- The reflection test uses the JavaScript indexer/model, not a newly generated SP1 proof settled by the deployed Ethereum verifier.
- The simulation asset is synthetic in the swap-world test. The reflection test uses the TAC asset identifier in its synthetic fixture, but that still is not a live Signet TAC deployment.
- No production desk is activated, no live TAC inventory is funded, and no mainnet or Signet transaction is broadcast by this lab.
- Real-world mempool policy, fee pressure, reorgs, explorer disagreement, operator monitoring, and production restart behavior still need separate verification.

## CI evidence

Lab workflow run #17 completed successfully on 2026-11-25, including the local accounting model, offline Signet configuration guard, upstream Bitcoin swap simulation, and reflection/key-path compatibility test:

https://github.com/ryzaki369-cyber/tacit-stuck-tac-lab/actions/runs/45591896566

The workflow checks out upstream Tacit at pinned commit `e4bb9297880502d5b8a341383b0baf69eefff509` for reproducibility.
