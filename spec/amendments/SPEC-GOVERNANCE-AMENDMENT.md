# SPEC §6 Amendment — Protocol-wide Governance Framework

> **STATUS: DRAFT** (2026-05-17). Specifies the generic governance
> voting infrastructure used by amendments that opt into bounded
> governance (currently `SPEC-CBTC-TAC-AMENDMENT.md` §5.46; future
> amendments may also opt in under the same framework). Provides
> envelope formats for proposal, vote, veto, and execute — plus the
> snapshot + tally + timelock + execution state machine.
>
> Adds four new envelope opcodes:
> - `T_GOV_PROPOSAL` (`0x50`) — submit a proposal for a parameter
>   change in a target amendment.
> - `T_GOV_VOTE` (`0x51`) — cast a yes/no vote on a pending proposal.
> - `T_GOV_VETO` (`0x52`) — vote toward a 67% veto threshold during
>   timelock window.
> - `T_GOV_EXECUTE` (`0x53`) — permissionlessly execute a passed
>   proposal after timelock expiry.
>
> **Design principle**: this amendment provides only the voting
> *mechanism*. Each target amendment (cBTC.tac, future cBTC.amm,
> etc.) defines what parameters are governable, what the safety
> bands are, what tier the parameter falls into, and how vote
> weight is computed. This amendment is the substrate; target
> amendments are the policy.
>
> **No governance over this amendment itself.** The voting wire
> format, state machine, snapshot mechanics, and tally rules
> defined here are themselves immutable — no governance proposal
> can change governance itself. Changes require a formal SPEC
> amendment (hard fork).
>
> **Trust profile**: governance is opt-in for the target amendments
> that reference it. The protocol's mechanical operation does not
> depend on governance ever being active. A target amendment with
> dormant governance operates at its fixed launch parameters
> indefinitely.

---

## Motivation

Tacit's design ethos is **mechanical-first, governance-optional**.
Most protocol operation runs on deterministic rules with no human
discretion. But for parameters that may need refinement across
years of operation — risk ratios, fee tiers, exposure caps — a
bounded governance layer adds adaptability without compromising
the core trust model.

Three considerations shape this amendment:

1. **Shared infrastructure**: multiple amendments (cBTC.tac today,
   AMM/marketplace/mixer parameters in the future) benefit from a
   single voting framework. Defining envelope formats and tally
   logic once means consistent UX, easier audit, and shared
   off-chain tooling.

2. **Bounded scope**: governance only adjusts parameters within
   safety bands defined per target amendment. Hard limits (slashing
   mechanics, conservation invariants, cryptographic primitives,
   etc.) remain immutable. The framework enforces this at the
   validator level — proposals targeting out-of-band values or
   immutable mechanics are rejected.

3. **Survival under hostile/dormant governance**: each target
   amendment must work fully without any governance activity. This
   amendment cannot create new operational dependencies — if no
   proposal ever passes, every target amendment continues to
   operate at its launch defaults indefinitely.

---

## §6.1 Generic governance model

### 6.1.1 Target amendments

A "target amendment" is a SPEC amendment that opts into governance
by:

- Enumerating its **governable parameters** with default values
  and safety bands
- Assigning each parameter to a **tier** (slow / fast / treasury)
- Defining **vote-weight computation** (typically TAC-weighted with
  LP-derived TAC contribution)
- Enumerating its **hard limits** (immutable invariants no
  governance can change)

The target amendment's spec is the canonical reference. This
governance amendment provides the voting mechanism that target
amendments invoke.

Target amendment identifier: a deterministic 32-byte hash of the
target amendment's canonical name (e.g.,
`amendment_id = SHA256("SPEC-CBTC-TAC-AMENDMENT-v1")`).

### 6.1.2 Parameter namespace

Each governable parameter has a deterministic identifier:

```
param_id = SHA256("tacit-gov-param-v1" || amendment_id || param_name)
```

Where `param_name` is the ASCII string of the parameter's name in
the target amendment (e.g., `"INITIAL_BOND_RATIO"`).

This is collision-resistant across amendments and stable as
amendments are added.

### 6.1.3 Tiers

Three tiers, set per parameter by the target amendment:

| Tier | Vote period | Timelock | Use |
|---|---|---|---|
| **Slow (A)** | 7 days | 14 days | Risk parameters, structural params |
| **Fast (B)** | 24 hours | 24 hours | Emergency response, pause triggers |
| **Treasury (C)** | 7 days | 14 days | One-shot reserve allocations |

Vote period = window during which `T_GOV_VOTE` envelopes are
accepted. Timelock = window between vote close and earliest
execution (also the veto window).

Total proposal lifetime ≈ tier window + timelock. For Tier A:
7 + 14 = 21 days from submission to executable.

### 6.1.4 Vote-weight delegation

Vote weight is computed per target amendment's specification. This
amendment provides the framework call:

```
compute_vote_weight(voter_pubkey, snapshot_block, amendment_id) → u64
```

The validator looks up the target amendment's vote-weight rule and
invokes it with the voter and snapshot block. For cBTC.tac, this
returns `direct_TAC + Σ LP-derived TAC` per §5.46.6.

Each amendment is responsible for defining a vote-weight rule that
returns deterministically computable weights from chain state at
the snapshot block.

---

## §6.2 T_GOV_PROPOSAL — submit a proposal

### 6.2.1 Wire format

```
T_GOV_PROPOSAL
   opcode                 1 byte   (0x50)
   network_tag            1 byte
   amendment_id           32 bytes (target amendment hash; §6.1.1)
   param_id               32 bytes (parameter being changed; §6.1.2)
   tier                   1 byte   (0=Slow, 1=Fast, 2=Treasury)
   new_value              VAR bytes (parameter-specific encoding; see
                                     target amendment's wire format)
   new_value_length       2 bytes  (u16 LE; length of new_value)
   proposer_pubkey        33 bytes (Pedersen commit; vote weight
                                    proof required at proposal time)
   proposer_weight_proof  VAR bytes (Groth16 proving the proposer
                                     holds ≥ PROPOSAL_THRESHOLD_FRAC
                                     of TAC at this block)
   description_hash       32 bytes (SHA256 of off-chain proposal
                                    description; pin via IPFS or
                                    similar to surface human-readable
                                    rationale)
   bind_hash              32 bytes
```

### 6.2.2 Validator algorithm

```
on T_GOV_PROPOSAL at block H:
  require envelope.network_tag matches local network
  require amendment_id is registered in the protocol's amendment
    registry (i.e., this amendment opts into governance)
  require param_id is in the target amendment's governable set
  require tier matches the parameter's declared tier in the target
    amendment
  require new_value parses cleanly as the parameter's expected type
    (target amendment's wire format dictates this)
  require new_value is within the target amendment's safety band
    for this parameter
  require proposer_pubkey is well-formed
  require groth16_verify(GOV_PROPOSAL_VK, proposer_weight_proof,
                         public_signals=[proposer_pubkey,
                                          H, amendment_id])
    that proposer's vote_weight at H ≥
    PROPOSAL_THRESHOLD_FRAC × circulating_TAC_at(H)

  // Effects
  proposal_id = SHA256("tacit-gov-proposal-v1" ||
                       amendment_id || param_id ||
                       new_value || bind_hash || H)
  proposals[proposal_id] = {
    amendment_id, param_id, tier, new_value,
    proposer: proposer_pubkey,
    snapshot_block: H,
    snapshot_block_hash: <hash of block H>,
    description_hash,
    state: "voting",
    vote_period_end: H + tier_vote_period_blocks(tier),
    timelock_end: H + tier_vote_period_blocks(tier) +
                  tier_timelock_blocks(tier),
    yes_votes: 0,
    no_votes: 0,
    veto_votes: 0,
    yes_voter_set: ∅,
    no_voter_set: ∅,
    veto_voter_set: ∅,
  }
  emit proposal_created_event(proposal_id, amendment_id, param_id)
```

`PROPOSAL_THRESHOLD_FRAC = 0.005` (0.5% of circulating TAC).

### 6.2.3 bind_hash construction

```
bind_hash = SHA256(
  "tacit-gov-proposal-v1"
  || network_tag
  || amendment_id || param_id
  || tier
  || new_value
  || proposer_pubkey
  || description_hash
)
```

---

## §6.3 T_GOV_VOTE — cast yes/no vote

### 6.3.1 Wire format

```
T_GOV_VOTE
   opcode               1 byte   (0x51)
   network_tag          1 byte
   proposal_id          32 bytes (from T_GOV_PROPOSAL effects)
   snapshot_block_hash  32 bytes (copied from proposals[proposal_id]
                                  for reorg replay protection)
   vote_choice          1 byte   (0=no, 1=yes)
   voter_pubkey         33 bytes
   voter_weight_proof   VAR bytes (Groth16 proving voter holds
                                   vote_weight as of snapshot block;
                                   includes minimum-balance tenure
                                   over VOTE_TENURE_BLOCKS window)
   voter_weight_LE      8 bytes  (u64; public weight, must match
                                  proof)
   bind_hash            32 bytes
```

### 6.3.2 Validator algorithm

```
on T_GOV_VOTE at block H:
  require envelope.network_tag matches local network
  require proposal_id exists in proposals
  P := proposals[proposal_id]

  // Reorg protection: snapshot must still be the same block hash
  require envelope.snapshot_block_hash == P.snapshot_block_hash

  // Vote period must be open
  require P.state == "voting"
  require H ≤ P.vote_period_end

  // Voter not already voted on this proposal
  voter_committed = SHA256(proposal_id || voter_pubkey)
  require voter_committed ∉ (P.yes_voter_set ∪ P.no_voter_set)

  // Vote weight proof verifies minimum-balance tenure
  require groth16_verify(GOV_VOTE_WEIGHT_VK, voter_weight_proof,
                         public_signals=[voter_pubkey, voter_weight,
                                          P.snapshot_block,
                                          P.amendment_id])
    that voter holds AT LEAST `voter_weight` according to the
    target amendment's vote-weight rule, with minimum-balance
    tenure (over VOTE_TENURE_BLOCKS window ending at snapshot)

  // Effects
  if vote_choice == 1:
    P.yes_votes += voter_weight
    P.yes_voter_set.add(voter_committed)
  else:
    P.no_votes += voter_weight
    P.no_voter_set.add(voter_committed)

  emit vote_cast_event(proposal_id, voter_pubkey, vote_choice,
                       voter_weight)
```

### 6.3.3 bind_hash and reorg semantics

```
bind_hash = SHA256(
  "tacit-gov-vote-v1"
  || network_tag
  || proposal_id
  || snapshot_block_hash
  || vote_choice
  || voter_pubkey
  || voter_weight_LE
)
```

The vote envelope binds to `snapshot_block_hash`. If a reorg
invalidates the proposal's snapshot block (changes its hash), the
vote becomes invalid because the bind_hash no longer matches.
This prevents votes from being replayed against a different
snapshot block state.

If the reorg is deep enough to remove the proposal entirely, the
proposal is dropped from indexer state along with all its votes.
A re-proposal under a new snapshot block is required to continue.

### 6.3.4 Minimum-balance tenure

The vote-weight Groth16 statement asserts the voter's minimum
balance over the window
`[snapshot_block − VOTE_TENURE_BLOCKS, snapshot_block]` is at least
`voter_weight`. This blocks flash-mint vote inflation: a voter who
briefly acquired TAC just before snapshot finds their effective
weight bounded by their pre-acquisition minimum.

Default `VOTE_TENURE_BLOCKS = 100` (~17 hours). The target amendment
specifies the actual value per its vote-weight rule.

---

## §6.4 T_GOV_VETO — veto vote during timelock

### 6.4.1 Wire format

Same as `T_GOV_VOTE` but with `opcode = 0x52`. Vote choices reduced
to a single "veto-yes" (1) — there's no "veto-no" (abstention is
the default). Voters who oppose vetoing simply don't submit a
`T_GOV_VETO` envelope.

```
T_GOV_VETO
   opcode               1 byte   (0x52)
   network_tag          1 byte
   proposal_id          32 bytes
   snapshot_block_hash  32 bytes
   voter_pubkey         33 bytes
   voter_weight_proof   VAR bytes
   voter_weight_LE      8 bytes
   bind_hash            32 bytes
```

### 6.4.2 Validator algorithm

```
on T_GOV_VETO at block H:
  // Same envelope validity checks as T_GOV_VOTE
  require envelope.network_tag matches local network
  P := proposals[proposal_id]
  require envelope.snapshot_block_hash == P.snapshot_block_hash

  // Veto window: between vote close and timelock expiry
  require P.state == "timelocked"  // means votes passed; in timelock
  require H ≤ P.timelock_end

  // Voter not already vetoed
  voter_committed = SHA256(proposal_id || voter_pubkey)
  require voter_committed ∉ P.veto_voter_set

  require groth16_verify(GOV_VOTE_WEIGHT_VK, voter_weight_proof,
                         public_signals=[voter_pubkey, voter_weight,
                                          P.snapshot_block,
                                          P.amendment_id])

  P.veto_votes += voter_weight
  P.veto_voter_set.add(voter_committed)

  // Check veto threshold
  if P.veto_votes ≥ VETO_THRESHOLD_FRAC × circulating_TAC_at_snapshot:
    P.state = "vetoed"
    emit proposal_vetoed_event(proposal_id, P.veto_votes)
```

`VETO_THRESHOLD_FRAC = 0.67` (67% supermajority).

### 6.4.3 Why veto is a separate envelope

A voter who voted "yes" can still cast a `T_GOV_VETO` if new
information emerges during the timelock window. The two are
independent — vote vs veto are decisions made at different
moments with potentially different information.

The asymmetric thresholds (60% to pass + 67% to veto = 27% gap
where proposals are passable-but-vetoable) is deliberate. It
means a marginal majority can govern, but a vocal supermajority
can stop egregious proposals during timelock.

---

## §6.5 Vote close + tally transitions

Between vote period end and execution, the indexer transitions the
proposal through states:

```
on every block H:
  for each proposals[P] where state == "voting":
    if H > P.vote_period_end:
      total_weight = P.yes_votes + P.no_votes
      quorum_required = QUORUM_FRAC × circulating_TAC_at_snapshot

      if total_weight < quorum_required:
        P.state = "expired_no_quorum"
      else if P.yes_votes < APPROVAL_FRAC × total_weight:
        P.state = "expired_below_threshold"
      else:
        P.state = "timelocked"
        emit proposal_passed_event(P)

  for each proposals[P] where state == "timelocked":
    if H > P.timelock_end:
      P.state = "executable"
      emit proposal_executable_event(P)
```

`QUORUM_FRAC = 0.05` (5% of circulating TAC at snapshot must
participate). `APPROVAL_FRAC = 0.60` (60% of votes cast in favor).

Note: these transitions are indexer-internal state events derived
from chain observations, not user envelopes. No envelope is
required to advance state from voting → timelocked → executable.

---

## §6.6 T_GOV_EXECUTE — apply a passed proposal

### 6.6.1 Wire format

```
T_GOV_EXECUTE
   opcode               1 byte   (0x53)
   network_tag          1 byte
   proposal_id          32 bytes
   bind_hash            32 bytes
```

Permissionless — anyone can submit. Typically a keeper / searcher
running automated execution after timelock expiry.

### 6.6.2 Validator algorithm

```
on T_GOV_EXECUTE at block H:
  require envelope.network_tag matches local network
  P := proposals[proposal_id]
  require P exists
  require P.state == "executable"

  // Execution window: 100 blocks after timelock expiry
  require H ≤ P.timelock_end + EXECUTION_WINDOW_BLOCKS

  // Apply parameter change to target amendment's state
  target_amendment_state[P.amendment_id].params[P.param_id] = P.new_value
  target_amendment_state[P.amendment_id].params_history.add({
    param_id: P.param_id,
    new_value: P.new_value,
    effective_block: H,
    proposal_id: proposal_id,
  })

  P.state = "executed"
  emit proposal_executed_event(P)
```

`EXECUTION_WINDOW_BLOCKS = 100` (~17 hours). If not executed in
window, the proposal expires:

```
for each proposals[P] where state == "executable":
  if H > P.timelock_end + EXECUTION_WINDOW_BLOCKS:
    P.state = "expired_unexecuted"
```

### 6.6.3 Retroactivity prohibition

The execution effects ONLY apply to operations confirming at block
≥ H (where H is the T_GOV_EXECUTE confirm block). Operations
already in flight (in mempool or pending Bitcoin tx) at block H
that have already passed validator checks under the prior
parameter values complete under the prior parameters.

For cBTC.tac: positions opened at block < H retain their
fractionalize-time parameters as recorded in
`position.params_snapshot`. New positions confirming at block ≥ H
inherit the updated parameter value.

This retroactivity prohibition is the single most important
user-protection guarantee in the design. It is enforced at the
target amendment's validator level, not at this amendment's
execution level.

---

## §6.7 State machine

```
                                                ┌──────────────────┐
       ┌──────────┐    vote period ends         │ expired_no_quorum│
       │ voting   │──── (no quorum) ────────────▶│  (terminal)      │
       └──────────┘                               └──────────────────┘
            │
            │ vote period ends
            │ (quorum + ≥60% yes)
            ▼
       ┌─────────────┐    veto reaches 67%         ┌─────────┐
       │ timelocked  │──── during timelock ────────▶│ vetoed  │
       └─────────────┘                               │(terminal)│
            │                                       └─────────┘
            │ timelock expires
            │ (no veto)
            ▼
       ┌──────────────┐   execute envelope         ┌──────────┐
       │ executable   │──── confirms in window ────▶│ executed │
       └──────────────┘                              │(terminal)│
            │                                       └──────────┘
            │ execution window expires
            ▼
       ┌─────────────────────┐
       │ expired_unexecuted  │ (terminal)
       └─────────────────────┘
```

Terminal states are immutable. A vetoed or expired proposal cannot
be revived; a new proposal must be submitted with a new
snapshot_block.

---

## §6.8 Voter participation infrastructure

### 6.8.1 On-chain voting cost

Each vote envelope is a tacit envelope embedded in a Bitcoin
transaction. Bitcoin transaction fees are non-zero (typically
$2-20 depending on network conditions). For votes with low
expected value-per-voter, the on-chain cost may exceed the
voter's stake.

This naturally biases participation toward larger holders. For
small-holder participation, three off-chain mechanisms can be
layered ON TOP of this amendment without modification:

1. **Vote aggregation / delegation**: a voter signs an off-chain
   message authorizing a delegate to vote on their behalf. The
   delegate aggregates many signatures and submits a single
   on-chain T_GOV_VOTE that batches them. Requires a Groth16
   batched-weight-proof circuit (deferred future amendment).

2. **Vote relayer market**: a voter signs an off-chain vote with
   a relayer-payment authorization. Relayers compete to broadcast
   votes in exchange for a TAC tip. The on-chain envelope verifies
   both the voter signature and the relayer payment.

3. **Off-chain governance "soft consensus"**: voters signal
   preferences via signed off-chain messages aggregated by
   community infrastructure (similar to Snapshot for Ethereum
   protocols). Soft consensus does not directly bind on-chain
   state but informs whether on-chain proposals get submitted.

This amendment specifies only the on-chain mechanism. Off-chain
infrastructure is a separate concern that does not require
protocol changes.

### 6.8.2 Voter education

The `description_hash` field in T_GOV_PROPOSAL points to off-chain
human-readable rationale (typically pinned via IPFS). Dapps should
surface description content to voters via a deterministic
content-addressing scheme so all voters see the same rationale.

---

## §6.9 Opcode allocations

Add to §3 *opcodes table*:

- `0x50` `T_GOV_PROPOSAL` — submit a parameter-change proposal (§6.2)
- `0x51` `T_GOV_VOTE` — cast yes/no vote on a proposal (§6.3)
- `0x52` `T_GOV_VETO` — vote toward 67% veto threshold during
  timelock (§6.4)
- `0x53` `T_GOV_EXECUTE` — apply a passed proposal after timelock
  (§6.6)

---

## §6.10 Parameter summary

All values in this section are fixed at amendment activation and
cannot be changed via governance (this amendment doesn't govern
itself).

```
PROPOSAL_THRESHOLD_FRAC   = 0.005   (0.5% of circulating TAC to propose)
QUORUM_FRAC               = 0.05    (5% participation required for validity)
APPROVAL_FRAC             = 0.60    (60% of votes cast must be yes)
VETO_THRESHOLD_FRAC       = 0.67    (67% supermajority to veto)
VOTE_TENURE_BLOCKS        = 100     (~17h minimum-balance tenure for vote weight)
TIER_A_VOTE_PERIOD_BLOCKS = 1008    (~7 days)
TIER_A_TIMELOCK_BLOCKS    = 2016    (~14 days)
TIER_B_VOTE_PERIOD_BLOCKS = 144     (~24 hours)
TIER_B_TIMELOCK_BLOCKS    = 144     (~24 hours)
TIER_C_VOTE_PERIOD_BLOCKS = 1008    (~7 days)
TIER_C_TIMELOCK_BLOCKS    = 2016    (~14 days)
EXECUTION_WINDOW_BLOCKS   = 100     (~17 hours after timelock to execute)
```

These constants are protocol-level — changing them requires a
formal SPEC amendment, not a governance vote.

---

## §6.11 Activation

This amendment activates jointly with its target amendment(s) at
launch. All four conditions must hold:

1. The Groth16 circuits for `GOV_PROPOSAL_VK` and
   `GOV_VOTE_WEIGHT_VK` are generated via a trusted setup ceremony.
2. Worker and dapp implementations of T_GOV_PROPOSAL / VOTE / VETO
   / EXECUTE are deployed and verified.
3. At least one target amendment is in production with governable
   parameters defined (currently SPEC-CBTC-TAC-AMENDMENT).
4. The ceremony output (verification keys + multi-party
   attestations) is anchored on chain via standard tacit ceremony-
   attestation mechanism. Indexers verify the multi-party signatures
   and accept the keys before processing T_GOV_PROPOSAL envelopes.

Day-1 governance: target amendments are governance-active from
their own activation block. At that block, governable parameters
initialize to their declared defaults in indexer-tracked state,
and T_GOV_PROPOSAL envelopes are immediately acceptable. The first
proposal that confirms can modify any in-band parameter via the
normal proposal → vote → execute lifecycle.

There is no "dormant phase" or separate post-launch activation
event. The protocol ships with governance live; whether anyone
chooses to use it is an organic engagement question.

---

## §6.12 Parameter state and reads

Each target amendment has indexer-tracked governance state, all
initialized at amendment activation:

```
governance_state[amendment_id] = {
  params: { param_id → current_value },  // initialized to declared
                                          // defaults at activation
  params_history: [ { param_id, value, effective_block, proposal_id } ],
}
```

Parameter reads always go through this state:

```
read_param(amendment_id, param_id):
  return governance_state[amendment_id].params[param_id]
```

At activation block, `params` is populated from the target
amendment's declared defaults. Subsequent T_GOV_EXECUTE envelopes
that confirm modify specific entries and append to `params_history`
with the effective block.

### 6.12.1 Initial state

For SPEC-CBTC-TAC-AMENDMENT at its activation block:

```
governance_state["SPEC-CBTC-TAC-AMENDMENT-v1"].params = {
  INITIAL_BOND_RATIO: 2.0,
  WARNING_RATIO: 1.5,
  LIQUIDATION_RATIO: 1.2,
  STABILITY_FEE_BPS: 25,
  LIQUIDATION_PENALTY_BPS: 200,
  AGGREGATE_RECOVERY_RATIO: 1.5,
  LIQUIDATOR_REWARD_FRACTION: 0.005,
  MAX_POOL_FRAC: 0.10,
  MAX_BONDED_FRAC_OF_TAC_FDV: 0.25,
  MAX_SINGLE_POSITION_BTC: 10_000_000_00, // sats
  TWAP_WINDOW: 180,
  MAX_FORCE_CLOSES_PER_BLOCK: 5,
  VOTE_TENURE_BLOCKS: 100,
  STALE_PRICE_BLOCKS: 1000,
  // ... etc per §5.41 and §5.46.2 listings
}
```

These are immediately readable by cBTC.tac validator logic from
activation. They're also immediately modifiable via the standard
governance proposal → vote → execute lifecycle.

### 6.12.2 Read consistency under in-flight proposals

A parameter read at block H returns `params[param_id]` as of block
H. A proposal that EXECUTES at block H' > H produces a change that
applies only to operations confirming at blocks ≥ H' (retroactivity
prohibition per §6.6.3). Operations whose validator pass occurred at
block < H' continue under the prior value.

For cBTC.tac specifically: a position opened at block 100 records
`position.params_snapshot` containing the values at block 100. Even
if governance changes `INITIAL_BOND_RATIO` at block 500, the
position at block 100 continues to operate under its snapshot
values until natural close.

### 6.12.3 Hard limits stay outside governance state

Parameters listed in §5.46.5 (cBTC.tac hard limits) are NOT in
`governance_state.params`. They're hardcoded in validator logic and
not addressable by T_GOV_PROPOSAL. Slashing rules, conservation
invariants, settlement atomicity, cryptographic primitives,
retroactivity prohibition, and opcode assignments are not
parameters — they're protocol mechanics, changeable only via
formal SPEC amendment.

---

## Test plan

1. **Proposal submission lifecycle**: submit proposal → confirm
   state transitions through voting → timelocked → executable →
   executed. Verify each block-window transition fires correctly.

2. **Quorum failure**: submit proposal, cast votes totaling < 5%
   of TAC supply, verify expires as `expired_no_quorum` at vote
   period end.

3. **Approval threshold failure**: submit proposal, get quorum but
   approval rate < 60%, verify expires as `expired_below_threshold`.

4. **Veto path**: submit proposal, pass with 60% yes, then cast
   veto votes totaling ≥ 67% during timelock — verify state
   transitions to `vetoed` and execution is blocked.

5. **Execution path**: submit proposal, pass, wait timelock, submit
   T_GOV_EXECUTE — verify parameter change applies correctly to
   target amendment state.

6. **Execution window expiry**: proposal passes, no T_GOV_EXECUTE
   confirms within EXECUTION_WINDOW_BLOCKS — verify
   `expired_unexecuted` state.

7. **Tenure check**: voter who held TAC for < VOTE_TENURE_BLOCKS
   submits vote — verify rejection (or vote weight capped at
   minimum balance over tenure window).

8. **Reorg invalidation**: simulate reorg of proposal's snapshot
   block — verify proposal dropped from indexer state, votes
   invalidated.

9. **Cross-amendment isolation**: proposal targeting one amendment
   cannot affect another amendment's state.

10. **Out-of-band rejection**: proposal with `new_value` outside
    target amendment's safety band — verify rejected at T_GOV_PROPOSAL.

11. **Hard-limit rejection**: proposal targeting a parameter not
    in the target amendment's governable set — verify rejected.

12. **Retroactivity check**: governance change applies, then verify
    existing positions still operate under their original
    parameters (target amendment's params_snapshot retention).

---

## Open questions

1. **Trusted setup ceremony for governance circuits**: the Groth16
   circuits used for proposer-weight and voter-weight proofs need
   a ceremony. Should this be a separate ceremony per circuit, or
   combined with the existing mixer ceremony? Recommend separate
   to isolate cryptographic risk.

2. **Voter rotation key derivation**: should governance use the
   wallet's primary key, or a derived governance-specific key?
   Derived key gives compartmentalization (compromise of wallet
   doesn't immediately compromise vote). Defer to wallet UX.

3. **Cross-amendment proposal batching**: a multi-parameter
   proposal that touches several target amendments in one
   atomic application. Useful for coordinated rebalancings.
   Defer; v1 supports single-parameter proposals only.

4. **Time-of-execution semantics for time-sensitive parameters**:
   e.g., if STABILITY_FEE_BPS changes mid-position-lifetime, does
   the new fee apply only to future accrual or retroactively?
   Per §6.6.3 retroactivity prohibition: only future accrual.
   Should this be made even more explicit per-parameter?

5. **Off-chain delegation infrastructure**: this amendment lays the
   substrate but doesn't spec the delegation envelope. Useful for
   small-holder participation. Future amendment.

---

## Summary

This amendment defines the protocol-wide governance framework:
generic envelopes for proposal/vote/veto/execute, a clean state
machine (voting → timelocked → executable → executed/vetoed), and
delegation of vote-weight + safety-band semantics to target
amendments.

The framework is **opt-in**: target amendments must explicitly
declare their governable parameters, safety bands, tier
assignments, and vote-weight computation rules. Amendments that
don't opt in operate without governance interaction. Amendments
that do opt in remain fully operational at their fixed launch
defaults until governance activates.

The framework's own parameters and mechanics are **immutable**:
governance cannot govern itself. Changes to the voting wire
format, tally rules, or state machine require a formal SPEC
amendment.

The trust model is bounded:
- Hard limits in each target amendment cap the worst-case impact
  of any single proposal
- Retroactivity prohibition protects existing positions
- 67% veto threshold prevents 50.1% capture
- Minimum-balance tenure blocks flash-mint vote inflation
- Reorg-aware vote binding prevents replay attacks

Each constraint is enforced at the validator level, not at the
proposal-submission level. A maximally-active hostile governance
can move parameters within safety bands; it cannot touch the
load-bearing mechanics (slashing, conservation, settlement,
cryptographic primitives).
