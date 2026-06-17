# RUNBOOK — live fast-lane round-trip + reverse bridge (next session, turnkey)

The one contiguous live chain that **verifies the fast lane on-chain** AND **ships the reverse bridge**:
`wrap → crossOut settle → 0x65 mint → attest → fast-spend`. Everything below is wired to this session's
validation deploy. Budget ~2–3 hr (several groth16 cycles + a signet maturity wait). Builds #11/#12 happen
inline. Folds into the alpha re-prove (A0, `PLAN-unified-twochain-rollout.md`).

## Wired inputs (from the 2026-06-17 validation re-prove)
| | value |
|---|---|
| Validation pool (Sepolia) | `0x3D38a00406d97Ba2F5df7d30246b810C90AC7444` (on the canonical-signet relay; supersedes the dead-fork `0xdcFccAf3`/`0x991726A5`) |
| PROGRAM_VKEY / BITCOIN_RELAY_VKEY | `0x0073ee38…` / `0x003281ea…` |
| SP1_VERIFIER (v6.1.0 leaf) | `0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2` |
| HEADER_RELAY (canonical signet) / CANONICAL_FACTORY | `0x70C8022e45728ccdCacA85eF57C74aD9E535cDe7` / `0x631c77ce…` |
| ETH_REFLECTION_VKEY (recursion, box reflect.rs pin) | `[316051978, 39823114, …]` (on-chain `0x0025ad24…`); local committed reflect.rs holds the reverted mainnet placeholder |
| ETH wallet (deployer/settler, funded) | `0xD5B75Ea6dfC22E234ecA88e5C75f5E1972b2C6E1` (`~/.tacit-validation/eth.json`, key at `[0].private_key`) |
| Signet wallet (funded) | `tb1qjpjvtvjyqskr8p356smwjvzwj96spkzwdh7zwp` (`~/.tacit-validation/signet.json`) |
| Box / Sepolia RPCs | vast `40707240` ssh8.vast.ai:27240 (`~/.ssh/vast_prover`) · consensus `ethereum-sepolia-beacon-api.publicnode.com` · execution `sepolia.gateway.tenderly.co` (handles wide eth_getLogs/getProof; publicnode caps ranges) |

## Status (2026-06-18) — steps 1–3 DONE on `0x3D38a004`; step 4 (Mode-B fold) BLOCKED
Verified on-chain on the canonical-signet pool `0x3D38a004`:
- **Step 1 wrap** — done (note in tree; asset `0x2a0f3c…`).
- **Step 2 crossOut settle** — done: `crossOutCommitment[0x64beaad5…] = 0xb588cd2b…` (CrossOutRecorded @ Sepolia block 11081519).
- **Step 3 `0x65` broadcast** — done: reveal tx `c5142fbd…` @ signet block 309292 (leaf == destCommitment, verified).

**Step 4 (reflection fold + attest) cannot complete on this deployment — two blockers found driving it live:**
1. **eth_prove stale-block bug — FIXED** (`eth_prove.rs`): it read `exec_block` from the pinned-genesis
   bootstrap store, so getLogs/getProof hit a block before the crossOut. Now reads the current finalized
   block from `finality_update.finalized_header()`. After the fix getLogs finds the crossOut (1 entry).
2. **Beacon period gap (config):** `get_updates` returns to period 1279 but finality is 1281 — the guest's
   `verify_finality_update` needs the period-1280 update. Use a beacon RPC that serves the full update set.
3. **🔴 Slot 120 `bitcoinConsumedCount` is never ctor-seeded (needs a fresh deploy).** At count 0 the slot is
   absent from the storage trie, so `eth_getProof` yields an exclusion proof the eth-reflection guest rejects
   (`verify_storage_slot_proofs`: got None, expected Some(0x80)). Seeding 0 in the ctor is impossible (zero
   slots aren't stored). Fix = make the guest treat an absent freshness slot as 0 (handle the exclusion proof),
   which rotates the eth-reflection vkey → rebuild reflection-prover → new BITCOIN_RELAY_VKEY → **fresh pool
   deploy** (fold into the alpha re-prove). Until then the live Mode-B fold cannot run on ANY count-0 pool.

## Prereqs (gates — check FIRST)
- [ ] `vastai start instance 40707240`; ELFs intact (`/root/work/confidential/target/.../{confidential-pool-prover,reflection-prover}` shas `8e6d4c95…`/`1723762e…`); re-derive vkeys (`derive_vkeys`) == above. After ANY guest rebuild, **also rebuild the host bins** (`eth_prove`/`bitcoin_prove` `include_bytes!` the ELFs) and confirm `eth_vkey` == the reflect.rs `ETH_REFLECTION_VKEY` pin.
- [x] **Relay tracks canonical signet** (`0x70C8022e`, `tipHeight()` advances via `advance-relay.sh` with `RELAY_ADDRESS=0x70C8022e` + the eth key). The old dead-fork relay `0xEbBb986E` is superseded.

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
