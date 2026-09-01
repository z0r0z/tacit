# Reprove fixture/harness issues — new generation (program_vkey 0x00711089…, bitcoin_relay_vkey 0x00df2757…)

Tracking every real issue found while regenerating the `*_groth16.json` real-proof fixtures for this
generation. All of these are pre-existing bugs in the `harnesses/exec-*.rs` test-harness layer (or, in one
case, a stale fixture) — never regressions from this generation's guest/contract changes, which are
comment-only in `main.rs`/`cxfer-core/lib.rs`.

**Correction to an earlier entry in this file:** an earlier version of this doc claimed the `cdp_liquidate`
fixture was "hand-built with fake, inconsistent data that was never actually validated against the guest."
That claim was wrong and was made before verifying it. A direct check (computing `nkToOwner(nk)` with the
real JS mirror and comparing against the fixture's `owner` field) showed the fixture's cryptographic data was
valid all along. The real bug was in the harness, not the fixture — see item 1 below.

## Root cause pattern

Every `harnesses/exec-*.rs` file hand-serializes an `SP1Stdin` byte stream that must match, field-for-field
and in the exact same order, what the guest (`contracts/sp1/confidential/src/main.rs`) reads for that op.
A missing field, or a field written out of order, desyncs everything read after it — producing either a
nonsense assert failure deep in the guest (e.g. "native spend: owner must commit to the nullifier key",
which is NOT actually about the nk/owner pair being invalid — it fires whenever the byte stream has drifted
and garbage lands in the nk slot), a `witness field length` panic (`r_n<N>()` in main.rs, when a
wrong-length chunk lands where a fixed-size read expects `N` bytes), or a silent guest halt before
`io::commit` (EMPTY public values).

## Fixed — harness bugs (byte-stream desync)

1. **`exec-gap.rs`** — three separate bugs sharing this one file (it multiplexes several ops via a runtime
   `GAP_OP` env var):
   - `GAP_OP=17` (OP_CDP_LIQUIDATE): each debt note's serialization stopped after `sigZ` and never wrote
     `nk` at all, even though the guest reads it last (`main.rs` ~4507, after `sig_z`). The fixture's
     `nk`/`owner` pair was independently verified valid.
   - `GAP_OP=12` (OP_ADAPTOR_LOCK): missing `refundPub` (guest reads it right after `recipient`) AND
     missing `nk` (guest reads it right after the spent note N's merkle path, before `nSigR`). Both fields
     were present in the fixture, just never written.
   - `GAP_OP=13` (OP_ADAPTOR_CLAIM): missing `outOwner` and the recipient's 64-byte `recipientSig`, both
     read by the guest right after `kernelS` (main.rs ~3734-3744, the recipient BIP-340 authorization check
     added to close a self-claim theft path). Without them the guest read garbage into the signature check,
     producing "adaptor-claim: recipient BIP-340 authorization" — a real-looking but spurious failure.
2. **`exec-unwrap.rs`** (OP_UNWRAP) / **`exec-sendunwrap.rs`** (OP_SEND_AND_UNWRAP): both wrote the native
   input's `nk` too early (right after the merkle path), when the guest's `input_leaf_authed` helper reads
   `nk` LAST — after value/recipient/fee/deadline/opening-sigma. Fixed by moving the write to the correct
   position in each.
3. **`exec-mixed.rs`**: its OP_UNWRAP leg had the identical "nk written too early" bug as `exec-unwrap.rs`,
   never carried over when this multi-op harness was written. Fixed.
4. **`exec-stealthlockbatch.rs`** (OP_STEALTH_LOCK batch): missing BOTH `refundPub` and `nk` per lock
   (present in the fixture, never written). The single-op sibling `exec-stealthlock.rs` had these correct;
   the batch variant was written independently and dropped both fields.
5. **`exec-wrapcdpmint.rs`** (OP_WRAP_CDP_MINT): missing `debtOwner` on the debt commitment (guest reads it
   between `d_cy` and `d_sig_r`; present in the fixture as `debtOwner`, never written).
6. **`exec-swap.rs`** (OP_SWAP): wrote a spurious `treasuryNotes` commitment block for the protocol-fee-skim
   path that the guest never reads (it derives that note's commitment itself in-guest); the extra bytes
   desynced the CP-04 memo-hash tail whenever a fee-switch pool was used. Removed.
7. **`exec-farm.rs`** (OP_FARM_BOND / HARVEST / UNBOND, multiplexed via `FARM_OP`): three missing fields,
   one per sub-op — `nk` per leg (bond), `rewardOwner` (harvest), `lpOwner` (unbond). The single-op sibling
   harnesses (`exec-farmbond.rs` etc.) already had these correct; this combined harness didn't mirror them.
8. **`exec-fastlane.rs`** (OP_TRANSFER, Bitcoin-homed): wrote a bogus per-input `secret`/nk field the guest
   never reads on the authenticated (Bitcoin-homed) path, AND never supplied the per-input 64-byte BIP-340
   signature `verify_btc_input_auths` requires. Fixed: removed the bogus field, added the signature loop.
9. **`exec-crosslane.rs`** (OP_TRANSFER, cross-lane non-membership test): the fixture sets a non-zero
   `bitcoinSpentRoot`, which makes the batch Bitcoin-homed (`batch_authenticated = true`) — so every input
   must be authorized by a BIP-340 signature, not a native `nk`. The harness was writing a bogus `secret`
   field (the fixture doesn't even have one — it has `sig`) and never supplied the required per-input
   signature. This is the SAME bug class as `exec-fastlane.rs` (#8), not a separate design question — fixed
   the same way: removed the bogus field, added the per-input `sig` write after `fee`.

## Fixed — stale fixture (not a harness bug)

10. **`bridgemint_op.json`**: the committed fixture predated a guest schema change — it was missing
    `sourceClass`, `spentTxid`, and `spentVout` entirely (top-level and nested), fields the harness and
    guest both expect. Root cause: the fixture was committed once and never regenerated after main.rs's
    OP_BRIDGE_MINT read order grew those fields. Fixed by regenerating from the existing, up-to-date
    generator (`tests/gen-cxfer-bridgemint-fixture.mjs`), which already produces the correct current schema.

## Verified correct — no changes needed

All remaining harnesses were audited field-by-field against the guest's actual read order (including
per-fixture key-set diffing to catch missing fields) and found correct: exec-adaptorrefund.rs,
exec-batchtransfer.rs, exec-bid.rs, exec-bridgeburn.rs, exec-bridgemint.rs (harness itself was fine — only
its fixture was stale, see #10), exec-bridgestealthmint.rs, exec-cbtcmint.rs, exec-cdpclose.rs,
exec-cdpliquidate.rs, exec-cdpmint.rs, exec-cdptopup.rs, exec-farmbond.rs, exec-farmharvest.rs,
exec-farmunbond.rs, exec-lp.rs, exec-lpbond.rs, exec-lpremove.rs, exec-otc.rs, exec-prove.rs, exec-route.rs,
exec-stealthclaim.rs, exec-stealthlock.rs, exec-stealthrefund.rs, exec-swapblind.rs, exec-wrap.rs,
exec-wraplp.rs, exec-wrapswap.rs, exec-wraptransfer.rs.

## Dead code, not fixed (unreachable via any current op registry entry)

`exec-gap.rs` also contains `op == 8` (OP_LP_REMOVE) and `op == 19` (OP_CDP_TOPUP) branches. Neither is
reachable — `scripts/parallel-ng-prove.sh`'s `OPS` registry only ever invokes this binary with
`GAP_OP=12|13|17`; LP_REMOVE and CDP_TOPUP each have their own dedicated, already-verified-correct harnesses
(`exec-lpremove.rs`, `exec-cdptopup.rs`). Not audited for correctness since nothing exercises them; worth
deleting in a follow-up cleanup pass rather than carrying dead, unverified code in the crate.

## Infra: OOM-driven "Killed" failures on box C (not a code bug)

`swapbatch`/`mixed`/`bridgestealthmint`/`stealthclaim`/`stealthrefund` were killed mid-groth16-proof on box C
(47.47.180.74). Root cause: `parallel-ng-prove.sh` defaults to `N=10` concurrent groth16 jobs; each real
groth16 wrap (15.97M bn254 constraints) peaks well past 14-19GB RSS during the gnark witness+proof phase, so
10 concurrent jobs can exceed the box's real memory even though `/sys/fs/cgroup/memory.max` reports `max`
(the container's own cgroup isn't the actual constraint — this is a host/VM-level OOM). Fix: re-run the
killed ops with lower concurrency (`N=2` or `N=3`) or serially, not a code change.

## Status

All 13 confirmed harness/fixture bugs are fixed in source and rebuilt against the correct new-generation ELF
(`elf_sha256` 170504091f44…). Several fixes were confirmed via `MODE=execute` runs (sendunwrap, stealthlockbatch,
swap, crosslane all returned clean `*_OK`/`WROTE_PV` results — no panics). A full clean re-run of the entire
op suite (all ~34 ops, groth16 mode, reduced concurrency) is still needed to give a final consolidated
pass/fail tally before this generation is considered fixture-complete for deploy.
