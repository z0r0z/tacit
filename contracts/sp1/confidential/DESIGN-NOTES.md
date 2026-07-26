# Design notes — intentional postures (not bugs)

Two properties of this system are deliberate design decisions, repeatedly surfaced by audits as
"findings." They are documented here so reviewers can see them as chosen tradeoffs rather than defects, and
so the operational invariant that keeps one of them safe is written down where it won't be forgotten.

---

## 1. Relay fees are an open settlement bounty (fee → `msg.sender`)

**What it is.** Every `FeePayment` in a settle is paid to `msg.sender` — whoever lands the transaction — not to
a recipient bound in the user's authorization. The fee *amount* and *asset* are bound into each op's
authorization and conservation kernel; the *recipient* is not.

**Why it's intentional.** This is an open-bounty model: any party who can land a valid proof earns the fee.
That maximizes settlement liveness — the user is not dependent on one specific relay being available, and a
stalled relay does not strand the user's operation. Binding the fee to a specific relay recipient would trade
that liveness for front-run resistance, and would require a `PublicValues`/contract change.

**The residual and its mitigation.** A searcher can copy a valid settle's calldata and land it first, capturing
the fee; the honest relay's transaction then reverts on the already-consumed nullifier/deposit and wastes gas.
The user's *principal and output destinations are never at risk* — only the relay's fee moves, and only to
another party who successfully settled. This is mitigated operationally: the production relay submits via a
private endpoint (Flashbots), so the proof is not exposed in the public mempool before it lands.

**Reviewer guidance.** This is the same item flagged as M-01 / H-02 across audits. It is a deliberate
liveness-vs-front-run tradeoff, not a theft-of-principal or inflation bug. If a future design prefers
relay-bound fees, the change is: read a relay recipient in the guest, bind it into every fee-bearing
authorization, and emit the fee as an ordinary `Withdrawal(assetId, relayRecipient, fee)` — deleting the
`FeePayment` path rather than adding bytecode.

---

## 2. One live *funded* generation per lineage (the C-01 invariant)

**What it is.** A `ConfidentialPool` is immutable, but the protocol supports *generations*: a successor pool can
resume from a predecessor's Bitcoin-reflection digest (seeded resume) rather than re-bootstrapping Bitcoin
history from genesis. All single-use claim state — `nullifierSpent`, `bridgeMinted`, `bitcoinConsumed`,
`cbtcMinted`, `knownBitcoinRoot`, `knownReflectionDigest` — is **local to each pool contract**.

**The consequence.** Two pools that share a reflection lineage each start those maps empty, so the *same*
Bitcoin note / burn / root can pass both pools' one-shot checks. One Bitcoin retirement can therefore
authorize a claim in each pool. This is real at the state-machine level (see
`test/ConfidentialCrossGenReplay.t.sol`).

**Why it is not a live exploit under correct operation.** A duplicate claim only *profits* the attacker if the
second pool has value to extract:
- **Escrow-backed assets** (e.g. tETH): the second unwrap draws `escrow[assetId]`; a drained pool reverts
  `InsufficientEscrow`.
- **Pool-minted assets:** the canonical ERC-20 is keyed by *pool address*, so a second-generation mint is a
  *different, abandoned* token contract — no shared supply, no liquidity, no market.

So a duplicate landing in a drained/abandoned predecessor yields nothing usable, while the live pool's own
`nullifierSpent`/`bridgeMinted` guards prevent any double-claim *within* it. The failure only becomes a real
inflation vector if **two funded pools share a lineage concurrently**.

**The invariant (operational, load-bearing).**

> Never fund, re-activate, or accept bridge activity on a pool that shares a live pool's reflection lineage.
> Migrate only by draining the predecessor to zero (all escrow, all redeemable positions, all note liability)
> *before* the successor accepts value. At any moment, at most one funded generation exists per lineage.

The current mainnet pool `0x…0f5DE1` resumed from a predecessor that has been **drained**; the invariant
holds.

**Why there is no in-contract fix.** The predecessor is immutable and still recognizes the deployment-agnostic
Bitcoin notes/burns; no change to a *new* pool can make the *old* one reject a shared-lineage claim. A true
consensus fix requires committing a generation domain (`chainId ‖ pool ‖ generation`) into the Bitcoin
bridge-burn envelope, fast-lane retirement, and reflected records — a new Bitcoin protocol version with a hard
generation cutover, not a `ConfidentialPool` patch. That is deliberate future work for any scenario requiring
migration-without-drain or concurrent generations; until then, the operational invariant above is the control.

## 3. Nullifier binds the full authenticated leaf — two invariants that keep it sufficient

`ν = keccak(note_leaf ‖ "spent")` binds the note's FULL membership leaf — `btc_note_leaf(asset,Cx,Cy,auth_key)`
for a Bitcoin-homed note, `leaf(asset,Cx,Cy,owner)` for a native note. This closes the post-burn bridge-mint
freeze: a same-commitment clone that differs in asset, `auth_key`, or leaf domain has a different ν, and
reproducing a Bitcoin note's exact leaf requires its `auth_key`, whose spend requires the BIP-340 signature the
attacker does not hold.

The one residual — a native note's `owner` is an unauthenticated, copyable label, so ν gives no per-occurrence
uniqueness for native-domain leaves — is UNREACHABLE only because of two properties that MUST hold for every
future op and vkey. They are load-bearing invariants, not incidental facts:

1. **No op may publish a native note's blinding `r`.** Spending a native clone needs `r` (for the opening
   sigma / conservation kernel), and native commitments are never published on the ETH lane (`pv.leaves`
   carries hashes, not points). If any future op revealed a native note's opening, its ν could be poisoned by a
   copied-`owner` clone — reopening the freeze against native-domain leaves.
2. **No public-opening note class may become burn-deposit-eligible.** Burn-deposit notes use the NATIVE leaf
   domain on the Bitcoin side (`leaf(asset,Cx,Cy,0)`), a real cross-domain coupling. This is safe today ONLY
   because the provenance opcode allowlist (`lib.rs:1402` `canonical_output_vout`) admits only the CXFER/AXFER
   family and EXCLUDES the public-opening receipts (`T_SWAP_VAR` 0x32, `T_SWAP_ROUTE`). Admitting a
   public-opening class into provenance would let an attacker mint a native ETH note with `owner=0`, spend it,
   and freeze that bridge mint. Two sibling allowlists in the same file — `canonical_bid_output_vout`
   (`:1420`) and `canonical_amm_output_vout` (`:1438`, which admits 0x31 `T_PROTOCOL_FEE_CLAIM`, a
   publicly-recomputable opening per M-01) — are deliberately NOT provenance-eligible; the walk imports
   `canonical_output_vout` alone, and both siblings carry a "NOT PROVENANCE-ELIGIBLE" warning.

Both are protecting the pool by construction today; they are written here so the next vkey preserves them by
intent, not by rediscovery. Duplicate native occurrences are additionally value-conserved (creating one is a
conserving CXFER, 2v in for 2v out), so the residual is at worst a griefing/liveness surface, never a mint.
