# R-1 consensus review + R-2 re-anchor finding

Scope: `contracts/src/lib/BitcoinLightRelay.sol` (R-1) and `ConfidentialPool._anchorReflection` (R-2).
Both are immutable, consensus-critical, pre-deploy-gating.

---

## R-1 — per-branch difficulty targets: **GO**

### The fix under review

The relay replaced the single global `epochTarget[epoch]` with `mapping(bytes32 => uint256) blockTarget`
— the target each block was mined at, on its own branch. Within an epoch a block inherits
`blockTarget[prev]`; at a boundary (`height % 2016 == 0`) it derives a fresh target from its **own**
branch via `_retargetTarget(parentTarget, _epochStartTsFrom(prev, epoch-1), blockTimestamp[prev])`.
The `prev != tip` bar on boundary crossings is gone, so any branch can cross.

### What I checked, and what holds

**Bitcoin-equivalence of the derivation.** `_epochStartTsFrom(prev, e)` walks to height `e*2016`, the
first block of the completed epoch; `lastTs` is `prev`, its last block. This reproduces Bitcoin Core's
`nHeightFirst = pindexLast->nHeight - (2016-1)` exactly, **including the off-by-one time-warp quirk**.
The clamp, the `MAX_TARGET` cap, and the compact round-trip match `CalculateNextWorkRequired`.

Verified against real data, not just synthetically: `test_advanceTip_crosses_real_mainnet_471_to_472_boundary`
drives the eight **real mainnet headers** across the 951552 boundary through the **production `advanceTip`
path with real PoW**, and asserts the derived target is Bitcoin's actual `0x17020f79 → 0x1702068f`.
This strictly supersedes the old `retarget()`-based test (which only checked the arithmetic in isolation).

**Can a branch derive a cheaper target?** No, and it would not help if it could. The epoch-start timestamp
is a stored header's, constrained by median-time-past below and the `+2h` future-drift bound above, so the
timespan cannot be stretched freely; the clamp caps the gain at 4× regardless. More decisively,
`cumWork += _workFromTarget(expectedTarget)` uses the **derived** target — an easier target yields
proportionally *less* work per block, so fork choice never rewards it. This closes the concern the audit's
B-1 raised. Covered by `test_advanceTip_diverging_branches_derive_different_targets`, which also asserts a
crossing carrying the *other* branch's nBits reverts `InvalidPoW`.

**Can the epoch-start walk land on the wrong block, or off the end?** The walk counts down from
`blockHeight[fromBlock]` following `blockParent`. Contiguity is guaranteed by `advanceTip`'s `++height`
chaining. If it could run past the genesis anchor it would read `blockTimestamp[0] == 0`, yielding a
clamped 4×-easier target — but it cannot: the walk only runs for `epoch != genesisEpoch`, and every block
of a non-genesis epoch sits above the anchor, so it must have been submitted through `advanceTip`. The
genesis epoch uses the deployer-seeded `epochStartTimestamp` fallback. Both paths covered
(`test_advanceTip_genesis_epoch_crossing_uses_seeded_epoch_start`,
`test_advanceTip_non_genesis_crossing_walks_full_epoch`).

**Median-time-past across a reorg.** `_medianTimePast` walks `blockParent` from the submitted block's own
parent, so it is already branch-local; a reorg does not perturb it. Unchanged by this fix.

**Fork rejoin vs. diverge.** `blockTarget` is keyed by block hash, so two branches sharing a prefix share
those entries (identical values — same parent, same derivation) and diverge exactly where the hashes
diverge. No aliasing.

**Equal-work tie.** `cumWork > tipWork` is strict, so first-seen wins and the removed boundary bar does not
introduce tip flapping. Asserted in `test_advanceTip_within_epoch_reorg_heaviest_wins`.

**Ground truth preserved.** Both `advanceTip` and `verifyBlock` still require `bits == _targetToCompact(expectedTarget)`
— exact canonical nBits, not an equal-decoding alias — and production PoW is unchanged. `_verifyPow` was
extracted as `virtual` solely so `MockPowLightRelay` can exercise branching with synthetic headers;
production never overrides it.

### Two real defects found and fixed during review

1. **`DeployTestnet.s.sol` bricked the signet relay.** `initTestnetGenesis` seeded `epochTarget` but never
   `blockTarget[tipHash]`, so under the R-1 change the *first* `advanceTip` would read `blockTarget[prev] == 0`
   and revert `UnknownEpoch` — permanently. Fixed by seeding the anchor's `blockTarget`. This is exactly the
   class of regression the fix's storage change invites; worth checking any other genesis path before deploy.
2. **Dead epoch-start cache.** `advanceTip` still wrote `epochStartTimestamp[epoch]` for the winning chain,
   but after the fix nothing reads it outside `genesisEpoch`. Removed — it was per-advance gas for a value
   that, if it ever *had* been read, would have been the wrong (winner-at-the-time) branch's.

### Vestigial surface: **removed**

`retarget()`, `epochTarget`, `currentEpoch`, `PROOF_LENGTH`, `_epochStartTs`, and the `Retarget` event are
now unreachable from consensus — `advanceTip` crosses boundaries itself and `verifyBlock` reads `blockTarget`.
Removed rather than kept: on an immutable contract a live-but-unread `retarget()` that still writes
`epochTarget`/`currentEpoch` is a standing invitation to a future reader wiring back to a stale value.
There is now **no path by which a stale per-epoch target can be read**. `epochStartTimestamp` is retained
(genesis-epoch fallback) and documented as genesis-only.

### Residual risks (accepted, not blocking)

- **Boundary-crossing gas: 4.85M** (measured with cold storage via `vm.cool`; ~2015 cold SLOADs dominate).
  ~16% of a 30M block, and it is the one advance that cannot be batched away. Previously this walk lived in
  `retarget()`; it now sits in `advanceTip`. Safe, but the relay-advancing job needs a gas budget that
  tolerates a ~5M call every 2016 blocks, and it must not be capped below that. **Operational item.**
- `_epochStartTsFrom` is `O(2016)` and permissionless. It is not a griefing vector (the caller pays), but
  it is the relay's worst case.

### Verdict: **GO**

Coverage went 23 → 27 tests; full suite 813/814 (the one failure is an RPC 500 in a fork test, unrelated).

---

## R-2 — reflection re-anchor: **implemented differently than briefed; see below**

### The brief, and why it does not work

The handoff asked for a tolerant `prev` check plus a **guest** change proving the batch rewinds the
reflection accumulators to the ancestor and re-folds the canonical branch. I did not implement that,
because it cannot be made sound — and the blocker is **not** the guest.

The reflection guest is already **stateless**: `read_scan_prior_state()` reads a *claimed* prior state from
private input, and the contract's `priorDigest == knownReflectionDigest` check is the only thing binding it.
So the guest could prove any rewind asked of it, at no soundness cost. The problem is on the contract side:

**Folding is not a pure state transition.** `_applyRelayProof` performs effects a rewind cannot undo:

- `knownBitcoinRoot[r.bitcoinPoolRoot] = true` — a monotone mapping, never cleared. An orphaned pool root
  stays permanently valid for membership proofs (`bitcoinRootsUsed`, and the `btcHomed` spend path).
- `cbtcLockVBtc` / `cbtcLockSpent` / `cbtcLockRedeemed` — one-way lifecycle flags gating engine escrow.
- `_autoRegisterFromMeta` asset registrations, `pendingBtcCall` entries.
- **Decisively:** any `bridge_mint` already paid out on Ethereum against a bridge-burn that the reorg
  orphaned. That value is gone.

Rewinding the digest and roots while those persist does not restore "as if never folded the orphaned
branch" — it resumes onto a state that still contains orphaned burns, converting a visible halt into silent
inflation. A reorg deeper than `REFLECTION_CONFIRMATIONS` is *already* a fund-safety event; the permanent
halt is the correct fail-closed response to it, not the bug.

I corrected the code comment at `ConfidentialPool.sol:189`, which previously implied the tolerant version
was merely pending a reprove cycle. It is not pending; it is not achievable that way.

### What IS safe, and is the real follow-up

There is one sound relaxation, and it needs **no guest change and no reprove**:

> Accept `prev` == a canonical ancestor of `lastReflectionBlockHash` **when no effect was folded above it.**

Most Bitcoin blocks carry no Tacit effects, so in the overwhelmingly common case the orphaned span folded
*nothing* and rewinding to the fork point is a genuine no-op — no irreversible effect to undo.

Concrete shape:

1. Track `uint256 lastEffectfulReflectionHeight`, advanced on an attest only when the batch actually changed
   state (spent/burn/pool roots or `cbtcBackingSats` changed, or any of the lock / meta / btc-call arrays
   non-empty).
2. In `_anchorReflection`, accept `prev` if `prev == lastReflectionBlockHash`, **or** if
   `_isTipOrRecentAncestor(prev, lastReflectionBlockHash)` (reuses the existing bounded walk; the relay
   retains orphan parent links, so this walks the orphaned branch back to the fork point) **and**
   `HEADER_RELAY.blockHeight(prev) >= lastEffectfulReflectionHeight`.
3. Relax the `bitcoinHeight >= lastRelayHeight` monotonic guard to permit the bounded rewind. This is safe:
   `digest()` commits `height`, so the `priorDigest` chain — not `lastRelayHeight` — is the actual
   anti-replay. `lastRelayHeight` is a redundant belt.

The height comparison in (2) is sufficient, not merely heuristic: `prev` is constrained to be an ancestor of
`lastReflectionBlockHash`, so any effectful block at a height `<= prev`'s is a common ancestor of both
branches and therefore canonical — never orphaned.

**Why it is not in this change:** it needs one storage slot, an added `blockHeight` method on `IRelay`, and
the effect-detection comparisons. `ConfidentialPool` has **92 bytes** of EIP-170 headroom. It does not fit,
and reclaiming bytes elsewhere in a pool this close to the limit is its own reviewed change. Squeezing
consensus-critical logic into the last 92 bytes under-validated is exactly what the brief said not to do.

### The fix available **now**, at zero code cost

`REFLECTION_CONFIRMATIONS` is a **constructor immutable**, bounded by `MAX_REFLECTION_CONFIRMATIONS = 144`,
and every deploy script currently defaults it to **6**. At 6, a 7-block reorg bricks reflection permanently.

Raising it at the pending redeploy is the entire mitigation, and costs no bytes and no reprove:

| value | brick needs a reorg deeper than | added bridge latency |
|---|---|---|
| 6 (current) | 6 blocks | ~1 h |
| 12 | 12 blocks | ~2 h |
| 18 | 18 blocks | ~3 h |

For calibration: the deepest Bitcoin reorg since 2015 is **4 blocks**. A reorg beyond ~12 would be a
protocol-level event under which halting is the behaviour you want anyway.

**DECISION (deploy owner): keep 6.** The added bridge latency was judged not worth the margin, and the
residual is accepted knowingly: a reorg deeper than 6 blocks permanently bricks the cross-chain lane (the
Ethereum-native pool is unaffected). Recorded in the sign-off ledger under §7 Known boundaries.

For the record, my recommendation and the second reviewer's was **12** — it moves the brick threshold clear
of anything Bitcoin has produced in a decade for ~1 h of added latency. The knob remains a ctor immutable,
so this is revisitable at any future redeploy, and it composes with the effect-free re-anchor above if that
lands later. Nothing else in this change depends on the value.

### Reprove coordination

**None required.** No guest change, no ELF/vkey rotation, no fixture regeneration. The R-1 relay change is
contract-only, and R-2 as resolved here is a deploy-parameter decision plus a comment correction. If the
effect-free re-anchor is taken up later it remains contract-only — still no reprove.

---

## Definition of done — status

| item | status |
|---|---|
| R-1 written GO/NO-GO consensus review | **GO** (above) |
| R-1 expanded real/mock reorg coverage | 5 new tests + a real-mainnet boundary crossing; 23 → 27 |
| R-1 regressions found | 2 fixed (`DeployTestnet` brick, dead epoch cache) |
| R-2 guest+contract re-anchor | **Not shipped — unsound as briefed.** Analysis + safe alternative above |
| R-2 reprove-coordination note | Not applicable — no guest change |
| Builds clean, non-fork suite green | 813/814 (1 unrelated RPC failure) |
| EIP-170 headroom | unchanged (pool 92 B, router 29 B) |
