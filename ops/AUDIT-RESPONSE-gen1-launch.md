# Audit response — gen1 launch readiness

Scope: independent review of the gen1 suite audit, verified against mainnet state and the live
reflection lane on 2026-09-04. Each finding below is marked **adopted**, **corrected**, or
**open**, with the evidence used to decide.

Superseded generations are referred to generically. Enumerating retired pool addresses and their
residual balances serves no operational purpose and is not published here.

---

## 1. Verdict

The audit is largely sound and its configuration findings are correct and worth acting on. One
central operational conclusion is wrong, and acting on it would have cost real money to remediate
a problem that does not exist. Details in §3.

Live suite: pool `0x0000000000047DD77CeCEfE5Dc015EB7bFa9C677`. No redeploy required — confirmed.

---

## 2. Adopted findings

### 2.1 Client and services pointed at a superseded pool — CONFIRMED
Independently reproduced. `dapp/confidential-deployments.generated.js` named a prior generation,
not the live suite. Any wrap, settle or scan built from that config targets a pool that is not
being attested.

Fix: regenerate from the manifest (`tools/sync-deployment-config.mjs`, dry-run by default).
The manifest — `contracts/deployments/1-createx.json` — is the single source of truth; the
generated file is derived, never hand-edited.

### 2.2 Per-generation token addresses hardcoded — ADOPTED
Canonical ERC20s are minter-bound to their generation's pool, and the cUSD asset id is keyed by
that generation's engine. Carrying those constants across a redeploy silently points wraps and
CDP operations at the wrong contracts. Sourcing them from the manifest is the correct fix: it
removes a whole class of cross-generation staleness rather than patching one instance.

### 2.3 External ERC20 wraps advertised but unregistered — CONFIRMED
Verified on-chain against the live pool:

```
USDC    registered = false
USDT    registered = false
wstETH  registered = false
```

The UI offered wraps the pool would reject. Hiding them until registration is the right default:
advertise nothing the contract will not honour.

Registration is permissionless (`registerWrappedAuto`, `crossChainLink = 0`), so this is an
operational step, not a governance one.

### 2.4 Untracked live-contract source and stale public deployments page — ADOPTED
Source for a deployed contract must be committed at deploy time, not after. Adopted without
qualification.

---

## 3. Corrected finding — reflection throughput

**Audit claim:** attested 964764 vs tip 965484; throughput ~7 blocks/hour, "only matches
Bitcoin's rate"; the gap "will not close by itself"; Bitcoin-lane deposits are ~5 days late
until a manual off-worker catch-up batch is run.

**This is incorrect.** Measured from successful on-chain attestations:

```
13:20:23  964722        13:37:11  964752        14:38:11  964770
13:23:35  964728        13:39:47  964758        14:41:23  964776
13:27:35  964734        13:42:47  964764        14:43:59  964782
13:30:47  964740                                14:46:47  964788
13:33:11  964746

span 1.44h · 66 blocks · 45.8 blocks/hour   (Bitcoin produces ~6/hour)
```

45.8/hour is the figure *including* a 55-minute stall (13:42→14:38, see §4). Excluding it, the
sustained rate is ~113–129 blocks/hour. Net closure against a ~6/hour tip is therefore roughly
40–120 blocks/hour, and the remaining gap closes unattended in hours, not never.

**Root cause of the discrepancy:** `964764` is exactly the height at which the lane was wedged by
the §4 defect. The audit sampled during an outage it had not diagnosed and generalised the
resulting rate into a permanent property of the system.

**Consequence had it been actioned:** a manual multi-hundred-block catch-up batch is a large,
paid proof. It was not needed. The correct response was to find the stall, which was a distinct
and cheaper defect.

**Resolved.** On re-measurement the original author reached the same figure (~46 blocks/hour from
two timestamped samples) and withdrew the recommendation. The stated cause was that `7/hour` was a
lifetime average since genesis, which folds in every idle and wedged interval since deploy. That
is a fair account and matches the evidence here.

Two related points from that author stand and are adopted:
- The header relay sitting ~12–18 blocks ahead of the attested height is the feeder's intended
  pacing, not a fault.
- Bitcoin-lane deposits are recognised late until the gap closes — a temporary delay, not a
  structural one.

Standing guidance: characterise lane throughput from two timestamped samples over a quiet
interval. Never from height-over-elapsed-time since deploy, and never across a window containing
a stall — both silently average in outages.

---

## 4. Defect found during this review — cursor drift (fixed)

Not in the audit; found while investigating its throughput figure.

The folder recovers when its cursor is **behind** the chain (idempotent re-ack when the batch's
digest is already on-chain). It had no path for being **ahead** — the state left by an attest that
lands, is acked, and is then dropped by a reorg. The cursor then chains off a prior the pool never
held, so every later attest reverts `StaleReflectionDigest`.

The wedge was not merely a stall, it was **funded**: each 5-minute cycle completed a real groth16
network proof *before* discovering the revert. Observed 9 unusable proofs against 3 usable ones in
a single log window. A transient reorg therefore escalates into a drained prover balance, after
which the lane cannot resume even once the drift is repaired.

No adversary is required. Any competing relayer landing a valid attest first produces the same
revert, and settles are intentionally copyable under the open-bounty relay posture.

**Fix (shipped):** `assembleJob` now returns `priorDigest` — the digest the batch chains off. The
folder pre-flights it against the pool and refuses to prove on mismatch, failing loud and free
instead of loud and expensive. The guard sits after the re-ack path, so ordinary catch-up is
unaffected, and no-ops when `priorDigest` is absent so the two services deploy independently.

**Deliberately not automated:** recovery remains a digest-verified `/reflection/seed` rewind. An
automatic rewind would let the worker rewrite its own canonical cursor from a chain read; a bad or
lagging RPC would then corrupt state rather than stall it. A stall is the safer failure.

---

## 5. Open before alpha

| # | Item | Status |
|---|---|---|
| 1 | Watch for drift recurrence | Guard makes it cheap and visible, not impossible. A repeat confirms the reorg hypothesis; follow-up is ack-after-N-confirmations. |
| 2 | Reflection closes remaining gap | Unattended, hours. No manual batch required (§3). |
| 3 | Fast-lane consume seeds `bitcoinConsumedCount` | **Gate — see §6.1.** |
| 4 | Register external ERC20s, re-sync, rebuild | Operational; §2.3. |
| 5 | Point client/services at the live suite | Scripted, reviewable, dry-run by default. |

---

## 6. Postures carried into alpha

### 6.1 The Bitcoin lane stays closed until its ordering gate clears
`bitcoinConsumedCount` and `crossOutCount` are both `0`. If a `crossOut` lands while the consume
count is still `0`, the reflection fold freezes **permanently** for the pool — recoverable only by
redeploying. One real Bitcoin-homed fast-lane consume must seed the counter first.

No `crossOut` path is exposed in any surface until that has landed. This is procedural, and
deliberately so: the contract-level fixes considered for it were reviewed and found flawed, and a
wrong fix in an immutable contract is worse than a documented sequencing rule.

EVM-side actions — wrap, shielded send, claim, unwrap — never touch that counter and are
unaffected.

### 6.2 The manifest is the only source of deployment truth
Every generation is a fresh, immutable address set. Config is generated from the manifest, never
hand-carried. Any address constant that outlives a redeploy is treated as a defect (§2.2).

### 6.3 Advertise nothing the contract will not honour
A surface may only offer an asset or route the live pool actually accepts. Registration state is
checked against the pool, not assumed from a config file (§2.3).

### 6.4 Never buy a proof that cannot settle
Prover spend is gated on a pre-flight check that the batch can land. Applied to reflection in §4;
the same principle applies to any future paid-proving path.

### 6.5 Recovery stays deliberate, not automatic
State rewinds are digest-verified and explicitly invoked. Self-healing that rewrites canonical
state from a single chain read is rejected: it converts a visible stall into a silent corruption.

### 6.6 Cross-chain exit is not private, and is not described as private
Exiting a shielded note to an L2 publishes the exit, the amount and the recipient on L1. The
capability is "shielded accumulation, then exit anywhere" — never presented to users as private
cross-chain transfer.

### 6.7 Measurement discipline
Operational rates are measured from successful on-chain outcomes over a quiet window, never from
an interval containing a known stall (§3).

---

## 6a. Confidential-pool readiness audit — verification and status

All three blockers independently verified against source and chain. Severity ordering below is by
irreversibility, not by ease of fix.

### The fix order is inverted from the obvious one — read this first

**Blocker 1 is currently the safety interlock for blocker 2.** Settle proofs cannot verify, so no
wrap has ever succeeded on the live pool (`nextLeafIndex = 0`, confirmed) and no funds are at risk.
The moment the prover binaries are fixed, wraps begin succeeding — and every note they mint is
permanently unspendable until blocker 2 is fixed.

Therefore: **dapp first (2 and 3), binaries second, live loop third.** Rebuilding the binaries
first would convert a non-functioning system into a fund-destroying one.

### B1 — shipped prover binaries embed the wrong guest · CONFIRMED
The `exec-*` binaries in `prover-bins-v4` embed a settle guest hashing to `6813ca52…`, which the
pin history records against the superseded `program_vkey 0x0082db7e`. The live pool verifies
against the pinned guest `170504091f…` → `0x00711089`. Every settle proof they produce is rejected.

Cause: at the v4 cut the `exec-*` binaries were carried forward from v3 on the stated reasoning
that `program_vkey` was unchanged. It had rotated afterwards. This is our own error, not an
upstream one.

Fix: rebuild `exec-*` on the box against the pinned ELF, publish v5, bump the Dockerfile, and set
`EXPECT_VKEY` on the Render settle services so a drifted build fails closed instead of silently
proving. The `EXPECT_VKEY`/`ELF_VKEY_PIN` guard already exists for exactly this and was simply not
set — setting it is the durable fix, the rebuild is the immediate one.

### B2 — dapp mints notes the guest cannot spend · CONFIRMED · NOT YET FIXED
Post-F-1 the guest requires `owner = keccak(nk ‖ "tacit-native-owner-v1")` and spends via
`ν = keccak(nk ‖ leaf ‖ "tacit-native-nullifier-v1")`. The dapp sets
`owner = pub.subarray(1,33)` — the x-only wallet pubkey. `nkToOwner` and `nativeNullifier` exist in
`confidential-pool.js`, match the guest byte-for-byte, and are called **nowhere**. Neither half of
the model is wired: not owner creation, not spend nullification.

Consequence: any note the current dapp mints is unspendable forever, since the vkey is immutable.

Design constraints for the fix — a naive version is worse than the bug:

1. `nk` must be **per note**, not per wallet. `deriveNote(seed, assetId, index).secret` is already
   exactly that: per-note, seed-derived, 32 bytes.
2. `nk` rides the memo's existing 32-byte `secret` slot. That slot is already ECDH-sealed to the
   owner and already returned by `openMemo`, so **no memo wire-format change and no migration** —
   and `MEMO_LEN` stays 136. Seed-only recovery is preserved because `nk` is also re-derivable from
   the seed by index.
3. **Only safe for outputs you own** (wrap, change). For a payment to a third party the sender
   builds the leaf and so would know `nk` — which under this model *is* spend authority, leaving the
   sender able to spend the recipient's note forever. Third-party sends must derive `nk`
   recipient-side (ECDH), which is what `confidential-stealth.js` is for. Do not paper over this by
   sealing a sender-chosen `nk`.
4. Land it as one change: owner creation, spend nullifier, indexer/scan matching, and recovery. A
   partial wiring strands funds in the same way the present bug does.

Because there are zero notes on this pool, this can be fixed freely with no migration — a window
that closes the moment B1 is fixed and the first wrap lands.

### B3 — memo ephemeral was a wallet constant · CONFIRMED · FIXED
`ephRand` was `BigInt(id.secret) % n` at all nine assemblers, so every leaf a wallet created
carried the same ephemeral pubkey (all of a user's notes trivially linkable on-chain), and the
wallet-wide secret was sealed into every counterparty's memo — letting one counterparty re-derive
the sender's ephemeral for every other note and open the sender's own change memos.

Fixed: fresh randomness per memo. Nothing depended on reproducibility — memos are sealed
client-side and passed to `settle()` verbatim; no server-side code re-seals. Verified two wraps from
one wallet now carry distinct ephemerals, and the memo still opens to the exact opening.

### Accepted for alpha, with eyes open
Shared wrap / wrap-transfer signing tag (downgrade is a grief, not a theft), transfer kernels not
binding chain id, indefinite witness retention on relay and API, no operator-independent exit in the
client, and settle-fee claimability (mitigated by private submission).

---

## 7. Verification record

| Check | Result |
|---|---|
| Live pool, engine binding, AMM init, router/relayer code | verified on-chain |
| Price adapter returns sane BTC-per-wstETH | verified on-chain |
| External ERC20 registration (USDC/USDT/wstETH) | verified `false` — audit correct |
| Reflection throughput | measured 45.8/h incl. stall; ~113–129/h excl. — audit incorrect |
| Cursor drift, rewind, and post-fix sync | worker `priorDigest` == pool digest after rewind |
| Guard wiring end-to-end | job now carries `priorDigest`; matched on-chain post-deploy |

Test-count note: the audit reports forge 832/832. Earlier records in this repo cite different
totals for differently-scoped runs. Not treated as a discrepancy, but the suite scope should be
stated alongside the count in future reports so the numbers are comparable.
