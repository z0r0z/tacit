# TAC BTC→ETH bridge — live runbook

Protocol + tooling + reflection data-plane are proven live. This documents the exact live burn→mint→reverse
sequence and the two integration pieces that gate it.

## Verified (mainnet)
- Redeployed suite (LE reflection anchor) — pool `0x000000000049Cc3f65588E74d9c25B66781da8dB`, all 6 Etherscan-verified.
- Bridge protocol proven vs deployed vkeys (`ConfidentialReflectionBurnDepositProofReal` + full suite); Mode B
  (trustless ETH→BTC via eth-reflection sync-committee recursion) present in the deployed reflection ELF.
- Reflection data-plane live: worker attester (`REFLECTION_ATTEST=1`, `REFLECTION_GENESIS_HEIGHT=956244`) +
  continuous box network-prover loop; pool caught up to the relay frontier. `lockstep-advancer.sh` keeps relay
  and reflection in step (never over-advance the relay past the reflection's anchor window).
- Provenance validated read-only for the real 100-TAC note: `tests/tac-bridge-provenance-dag.mjs` traces
  `3e5eaac0:0` through 18 cxfers to C_0 = the real TAC etch (`asset_id = sha256(internal_txid‖vout0)` matches
  `f0bbe868…`), and `verifyProvenanceDag` (the guest's own structural check) PASSES. Conservation is verified by
  `scanHoldings`. So a burn is provably recoverable.

## Integration built this pass
- **Worker submission endpoint** `POST /reflection/burndep?network=mainnet` (box-token gated) — writes the
  holder bundle to `reflection:burndep:{net}:{burnTxidDisplay}`, the exact key the scan attester's
  `getBurnDeposits` reads. **Requires a worker redeploy to go live.**
- `buildAndBroadcastCBurn` exported from `dapp/tacit.js` for headless burn.

## Remaining to build (client-side; no contract/guest change)
1. **Full bundle assembler** — extend `tests/tac-bridge-provenance-dag.mjs` (DAG done) with per-cxfer inclusion
   proofs (block header + merkle path) via `makeBurnDepositAssembler` + the burn-tx wtxid/coinbase proofs, into
   the exact bundle shape `getBurnDeposits`→`enrichBurnDeposit` consumes. The guest re-verifies, so a wrong
   bundle only makes the fold skip (resubmit) — never a loss.
2. **bridge_mint driver** — after the fold appends the burned note, build+submit the `OP_BRIDGE_MINT` settle
   proving membership (dapp `confidential-*.js` builders + box prove).

## Live sequence (once the worker is redeployed with the endpoint)
1. `buildAndBroadcastCBurn(TAC, 30e8)` — burns 30 TAC on Bitcoin (irreversible on BTC; recovered on ETH).
2. Assemble the full bundle for the burn; `POST /reflection/burndep` it.
3. Lockstep-advance the relay over the burn block; the box loop folds it (bundle onboards the burned note).
4. `OP_BRIDGE_MINT` on Ethereum → mints 30 TAC as a confidential note.
5. Reverse: burn the ETH note → `crossOut` → mint 20 TAC back on Bitcoin (Mode A day-1 / Mode B trustless).

## Guardrails
- Never burn until the worker `/reflection/burndep` endpoint is live (else the bundle can't be submitted → the
  burn strands). The burn is recoverable but only once the endpoint + fold path exist.
- Keep relay↔reflection in lockstep (advance the relay in small steps only after the reflection catches up).
