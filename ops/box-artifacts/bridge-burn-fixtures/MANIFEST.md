# Bridge-burn burn_id parity — box execute-mode fixtures

The reflection guest keys the burn accumulator by the SOURCE-SPECIFIC `bridge_burn_id` (spent outpoint + full
source leaf), not the bare note nullifier ν. The JS assembler previously folded bridge burns under ν, so the
burn-set insert witness targeted the wrong key and the FIRST live bridge-out diverged the guest → reflection
halt. These fixtures prove the fix (`dapp/confidential-pool.js bridgeBurnId` + the reflected / burn-deposit
dispatch) reaches the guest's onboard/skip decision on every burn path.

`reflect-exec` on the box re-folds each block in-guest and MUST land on the listed `newDigest` (DIGEST_MATCH).
Run each against the OLD (pre-fix) assembler-shaped input once to confirm it reproduces the burn-key divergence.

## bridge_burn_id parity
`bridgeBurnId(source_kind, spent_txid, spent_vout, src_leaf)` = keccak(`tacit-bridge-burn-source-v1` ‖ kind(1) ‖
spent_txid(32, internal tx-serialization byte order) ‖ spent_vout(4 BE) ‖ src_leaf(32)). Byte-matched to the
guest `bridge_burn_id` and pinned by the Rust KAT `bridge_burn_id_kat` (lib.rs) ↔ `tests/bridge-burn-id-pin.test.mjs`.

| Fixture | Path | Scenario | Generator | Expected execute outcome | newDigest |
|---|---|---|---|---|---|
| reflected-fresh.json | reflected 0x2B | fresh bridge-out of a live note; env asset == spent asset | `BRIDGEBURN_SCENARIO=reflected gen-reflection-bridge-burn-synth` | DIGEST_MATCH-with-burn — burn recorded under `bridge_burn_id(REFLECTED, outpoint, btc_note_leaf)`, ν nullified, burn set grows — **must-FAIL-on-old-assembler (folds under ν)** | 0x77a4de5e… |
| asset-mismatch.json | reflected 0x2B | env declares a DIFFERENT asset than the note spent | `BRIDGEBURN_SCENARIO=asset-mismatch gen-reflection-bridge-burn-synth` | DIGEST_MATCH-with-skip — note stays nullified, NO bridge-out recorded, no burn witness read | 0x1aca84b0… |
| burn-deposit.json | burn-deposit 0x2B | scan-free onboarding of a never-reflected note | `gen-reflection-burn-deposit` | **box-validated-only** — see note; the guest SKIPS the synthetic provenance (records no burn), so this fixture confirms the writer stream-shape fix (full execute, no desync) but does NOT DIGEST_MATCH-with-fold | js-fold 0x540ccbc3 / guest-skip 0x038fece0 |

## Reflected vs burn-deposit dispatch (mirrored from reflect.rs)
- **Reflected** (`spends.len()==1 && spends[0].nu == env_nu`): key = `bridge_burn_id(BURN_SOURCE_REFLECTED,
  spent_txid, spent_vout, btc_note_leaf(asset, Cx, Cy, auth_key))`. The envelope asset must equal the spent
  note's asset (asset-equality predicate) or the burn is SKIPPED (a cheap same-commitment clone cannot authorize
  a mint against a dear asset). The burn-insert witness is read only when both gates hold.
- **Burn-deposit** (`spends.is_empty()`, provenance-verified): key = `bridge_burn_id(BURN_SOURCE_DEPOSIT,
  burned_txid, burned_vout, leaf(asset, Cx, Cy, 0))`. The SPENT and BURN sides are INDEPENDENT: a ν already in
  the spent set (a collision, or a prior normal spend) does NOT block a fresh burn_id from recording the burn +
  appending the native note; a duplicate burn_id is a membership-gated no-op. The witness carries the cross-lane
  double-mint gate proof (co_is_member/co_value/co_next/co_index/co_path over the burned outpoint) that the guest
  reads between the burn insert and the note append — see the writer note below.

## Stream order (reflect-stdin write_burn_deposit ↔ guest)
The guest reads the burn-deposit witness in this exact order: burnWtxidSiblings, burnCbTxidSiblings, burnedCx,
burnedCy, spentInsert, burnInsert, **the cross-lane co witness** (co_is_member, co_value, co_next, co_index,
co_path), notePath. `write_burn_deposit` was missing the co witness, so the stdin stream ran dry mid
burn-deposit ("input stream empty") — which also broke the BOX recursion prover on every real burn-deposit, not
just this fixture. Both the writer and both assembler paths (`foldBurnDepositTx` live scan +
`assembleBurnDeposit` worker) now emit it via the shared `foldBurnDepositCore`.

## burn-deposit.json — box-validated-only (why it does not DIGEST_MATCH-with-fold)
The guest verifies a burn-deposit's provenance DAG (etch → conserving CXFER → burned note, with PoW headers and
the burn tx's wtxid witness-commitment) read from the burn tx's Taproot witness blob, and SKIPS (records no burn)
if it does not authenticate. This synthetic fixture carries a hand-built provenance blob that the guest rejects
at that gate (guest digest `0x038fece0`, "burn-set UNCHANGED"), while the generator's `assembleBurnDeposit` folds
unconditionally (`0x540ccbc3`). This is a fixture-validity limitation, NOT a code bug — the scan-free onboarding
proof is a real wtxid-committed chain that can't be perfectly synthesised (the same class as the swap-batch
positives needing the real ceremony zkey). What this fixture DID confirm: the writer stream-shape fix — with the
cross-lane co witness now written, the burn-deposit executes fully (5.29M cycles, no "input stream empty" desync),
which was the actual box-recursion-prover bug.

The DEPOSIT-class `bridge_burn_id` keying itself is confirmed WITHOUT this fixture:
- the Rust↔JS KAT pins BOTH the REFLECTED (`0x263546e9…`) and DEPOSIT (`0x430c5fb1…`) digests byte-for-byte;
- the reflected-fresh + asset-mismatch fixtures DIGEST_MATCH against the guest ELF (they exercise the same
  `foldBurn`/burn-set keying, just under the REFLECTED source kind);
- `tests/confidential-bridge-burn-fold.mjs` exercises the DEPOSIT burn_id + spent/burn independence directly.

The LIVE scan path stays at parity: `foldBurnDepositTx` gates the fold on `ctx.valid` (the JS provenance mirror's
verdict), so a real burn-deposit whose provenance the guest rejects is SKIPPED by the assembler too. Only the
worker's `assembleBurnDeposit` folds unconditionally — it is called only for burns the worker separately validated.

## JS-level parity coverage
`tests/confidential-bridge-burn-fold.mjs` asserts each decision directly: the reflected burn keys on
`bridge_burn_id` (not ν), the asset-mismatch skip, the burn-deposit spent/burn independence (fresh burn_id
records despite a pre-spent ν), and the duplicate-burn_id membership-gated no-op.
