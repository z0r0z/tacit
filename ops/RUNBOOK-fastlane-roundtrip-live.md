# RUNBOOK — live fast-lane round-trip + reverse bridge (next session, turnkey)

The one contiguous live chain that **verifies the fast lane on-chain** AND **ships the reverse bridge**:
`wrap → crossOut settle → 0x65 mint → attest → fast-spend`. Everything below is wired to this session's
validation deploy. Budget ~2–3 hr (several groth16 cycles + a signet maturity wait). Builds #11/#12 happen
inline. Folds into the alpha re-prove (A0, `PLAN-unified-twochain-rollout.md`).

## Wired inputs (from the 2026-06-17 validation re-prove)
| | value |
|---|---|
| Validation pool (Sepolia) | `0xdcFccAf30a6f2aad28e66ea9470e768B934ADb8F` |
| PROGRAM_VKEY / BITCOIN_RELAY_VKEY | `0x0073ee38…` / `0x003281ea…` |
| SP1_VERIFIER (v6.1.0 leaf) | `0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2` |
| HEADER_RELAY / CANONICAL_FACTORY | `0xEbBb986E…` / `0x631c77ce…` |
| ETH wallet (deployer/settler, funded) | `0xD5B75Ea6dfC22E234ecA88e5C75f5E1972b2C6E1` (`~/.tacit-validation/eth.json`) |
| Signet wallet (funded) | `tb1qjpjvtvjyqskr8p356smwjvzwj96spkzwdh7zwp` (`~/.tacit-validation/signet.json`) |
| Box / Sepolia RPC | vast `40707240` ssh8.vast.ai:27240 (`~/.ssh/vast_prover`) · `https://ethereum-sepolia-rpc.publicnode.com` |

## Prereqs (gates — check FIRST)
- [ ] `vastai start instance 40707240`; ELFs intact (`/root/work/confidential/target/.../{confidential-pool-prover,reflection-prover}` shas `8e6d4c95…`/`1723762e…`); re-derive vkeys (`derive_vkeys`) == above.
- [ ] **Relay advancing:** `cast call 0xEbBb986E… 'tip()(bytes32)'` must change over ~10 min (it was stalled at `0x6da483f8…`). If stalled, the attest (step 5) blocks — start/poke the header relayer first.

## The chain
1. **Register a wrap asset + wrap a note** (seeds an EVM note; validates `PROGRAM_VKEY` on-chain). Deploy a
   MockERC20 (or reuse a Sepolia test token), `registerWrapped` it on the pool, then `wrap(asset, amount,
   cx, cy, owner)` with a real opening; build the wrap witness (`scripts/build-ceth-wrap.mjs` pattern) →
   box `groth16` → `settle()` on `0xdcFccAf3`. Result: an EVM note in the tree at a known leaf.
2. **crossOut settle (ETH→BTC)** — the #10 CLI, now with the REAL wrapped note. Patch
   `gen-cxfer-crossout-fixture.mjs` to use the wrapped note's `{value, blinding, cx, cy, owner}` + its real
   membership path vs the pool's `currentRoot()` (replace the synthetic tree). `exec_crossout.rs MODE=groth16`
   → `settle()` → `crossOutCommitment[claimId]` set + `CrossOutRecorded`. **Record the real `claimId` + the
   crossOut's `cx,cy,owner`.**
3. **Build #11 + broadcast the `0x65`** on signet. Write the headless `buildAndBroadcastEnvelope` (extract the
   commit/reveal from a tacit.js per-envelope flow, e.g. the burn flow ~`tacit.js:23638`) driven by
   jsdom + tacit.js(signet) + the signet wallet (model: the `*-onchain-e2e-signet.mjs` harnesses). Then
   `makeCrossoutBroadcaster({buildAndBroadcastEnvelope}).broadcastCrossoutMint({assetId, claimId, cx, cy,
   owner})` with step-2's values (the `0x65` note `cx,cy,owner` MUST equal the crossOut's `destCommitment`).
   Wait **6+ signet confs**.
4. **Build #12a — reflection fold + attest.** Extend `scripts/build-reflection-bootstrap-fixture.mjs` to mark
   the `0x65` tx as a `crossout_mint` (decode `0x65` → the note) so `fold_crossout` runs; `run-bitcoin-prove.sh`
   (`POOL=0xdcFccAf3`, genesis anchor `0x68e5030c…` / current matured tip) → `attestBitcoinStateProven`.
   Result: `BITCOIN_RELAY_VKEY` verified on-chain + the minted note ∈ `bitcoinPoolRoot` (`knownBitcoinRoot`).
5. **Fast-spend the btcHomed note (THE LIVE FAST-LANE PROOF).** The minted note is now a member of a
   `knownBitcoinRoot` → build a btcHomed settle (swap/leaf) spending it: `spendRoot = the attested Bitcoin
   root`, per-input `check_btc_nonmembership` (the existing crosslane fixtures are the witness template),
   box `groth16` → `settle()` → records `bitcoinConsumed[ν]` + advances `bitcoinConsumedCount`. **This is the
   on-chain fast lane for a real asset.** (Or `bridge_mint` it back via `exec-bridgemint.rs` for the full
   ETH→BTC→ETH round-trip — #12b.)
6. **Verify:** asset id preserved at every hop; value conserved; `bitcoinConsumed` set; the next attest's
   `consumedCount` gate satisfied; the reverse reflection retires the source note (Ethereum-senior void).

## Then
Fold the round-trip guest deltas (reverse-bridge op-binding, if any) into the **alpha re-prove (A0)** with
mainnet config. Stop the box when done (`vastai stop 40707240`; state persists).
