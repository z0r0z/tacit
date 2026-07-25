# CORRECTION (bundle-5 re-audit, 2026-07-25): the asset-only shortcut was WRONG — full-leaf binding required

A bundle-5 audit (verified against code) proved the asset-only consume record is exploitable, because some
reflected notes (T_SWAP_VAR receipts) publish their exact opening (`r_receipt` public), so an attacker
reproduces a VICTIM's commitment C under the attacker's own key K_a. Two leaves `btc_note_leaf(A,C,K_v)` and
`btc_note_leaf(A,C,K_a)` then coexist (LiveUtxoSet forbids only duplicate outpoints), and asset-only
`fold_consumed` retires the VICTIM's outpoint while the attacker's clone stays live → the attacker gets v on
Ethereum + v on Bitcoin, the victim loses v. The "2v backing" argument below was refuted: the attacker funds
only ONE note (the clone) and steals the victim's. **Confirmed remediation (this round):**

- **C-01 (full-leaf, the churn I deferred):** the consume record carries the full `srcLeaf =
  btc_note_leaf(asset,Cx,Cy,auth_key)` (not just asset); `LiveUtxoSet` stores `auth_key` per outpoint;
  `fold_consumed` reconstructs `btc_note_leaf(asset,Cx,Cy,live_auth_key)` and requires
  `keccak(btc_spend_root‖srcLeaf) == recorded`. Now Mode-B can retire only the EXACT authenticated note the
  Ethereum spend signed under — the attacker's clone (K_a), not the victim's (K_v).
- **C-02 / H-01 (bridge burn source identity — bundle-7 re-audit, IMPLEMENTED):** the prior round fixed the
  Mode-B CONSUME path (C-01) but left the BRIDGE burn/mint path keyed by commitment-only ν, so the same
  same-commitment/cross-asset clone attack minted an unburned dear asset (source-membership and burn-membership
  were two different notes joined only by the colliding ν). Now the burn accumulator (`fold_burn`) and the
  mint's burn-set membership key on a SOURCE-SPECIFIC identity:
  `burn_id = bridge_burn_id(source_kind, spent_txid, spent_vout, srcLeaf)` where
  `srcLeaf = btc_note_leaf(asset,Cx,Cy,auth_key)` (reflected) or `leaf(asset,Cx,Cy,0)` (scan-free deposit).
  The reflected-note burn asserts `spends[0].asset == b_asset` and `DetectedSpend` now carries the live
  `auth_key`. `OP_BRIDGE_MINT` + `OP_BRIDGE_STEALTH_MINT` read the spent outpoint, reconstruct `burn_id` from
  the pool-membership-bound `srcLeaf`, and prove `burn_id → destCommitment`. A single witnessed `asset` must
  satisfy both pool-membership AND burn-membership, so the minted asset == the exact burned note's asset; a
  burn of a cheap clone (different asset/key/outpoint ⇒ different `burn_id`) can't authorize it. (The cross-lane
  spent-set + one-mint gate key on ν, which is itself now the full-leaf `keccak(note_leaf‖"spent")` — see the
  header bullet; the "commitment-only ν" phrasing elsewhere in this file is superseded.)
- **CMINT replay (bundle-7):** `verify_cmint_authorized` now requires the reveal's first input to be the exact
  outpoint `(commit_txid, 0)` — a Bitcoin outpoint is spent once, so one issuer signature authorizes exactly
  one supply note (previously only the txid was matched, letting N reveals spend N outputs of one commit tx).
- **F-2 (blind-swap fee floor):** enforced EXACTLY in-guest via `fee_clearing_floor_ok` (cross-multiplied, no
  rounding). **F-3 (fee-lock blinding):** seeded by the swap's first spent-input nullifier (globally unique).
- **M-02:** constructor asserts the SP1 verifier and (if a Bitcoin relay is set) the header relay have code.
- **ν is now over the FULL authenticated leaf (supersedes every "ν stays commitment-only" line below).** The
  single, authoritative definition is `ν = keccak(note_leaf ‖ "spent")` — `cxfer-core::nullifier`
  (`lib.rs:1466`), where `note_leaf` is `btc_note_leaf(asset,Cx,Cy,auth_key)` for a Bitcoin-homed note or
  `leaf(asset,Cx,Cy,owner)` for a native one. Both lanes reconstruct the identical leaf, so a note has exactly
  one ν, and two notes sharing a commitment but differing in asset / auth_key / leaf-domain get DISTINCT ν. The
  matching contract layout is `keccak(leaf ‖ "spent")` (`ConfidentialPool`), mirrored in
  `dapp/confidential-pool.js`. This closed the same-commitment clone at the ν level itself, not just in the
  consume record — so wherever the design below says "ν stays commitment-only (unchanged)" or
  `ν = keccak(Cx‖Cy)`, that is the OLD model and is wrong; read the leaf-based definition here instead.

Everything below the line is the ORIGINAL (superseded) design; the full-leaf variant it marked "deferred" is
now the implemented one, AND ν itself is now leaf-based (above). The "Status (implemented this round)" section
near the end describes the earlier asset-only round and is retained only as history — the header bullets are
authoritative where they differ.

---

# Unified authenticated source identity (fixes C-01, C-02, C-03)

Status: DESIGN + in-progress. Closes the three confirmed criticals from the bundle-4 re-audit, which are
all facets of one missing property: **the authenticated identity of a Bitcoin-homed note (asset + commitment
+ Taproot key) must survive from reflection → ETH spend → consumed record → Mode-B retirement → bridge-mint,
so exactly the note that was authorized on Ethereum is the note retired on Bitcoin.**

## The invariant

For a Bitcoin-homed note spent on the Ethereum lane, define its authenticated identity as its reflected leaf:

```
src_leaf = btc_note_leaf(asset, Cx, Cy, auth_key)     // keccak(asset‖Cx‖Cy‖auth_key‖"tacit-btc-note-v1")
```

Every stage must reference this identity:
- reflection appends the note to the live set under this identity (already: the leaf carries it);
- the ETH spend authenticates it (already: membership of `src_leaf` + BIP-340 by `auth_key`);
- the consumed record carries it;
- Mode-B retires the live outpoint whose identity equals it;
- bridge-mint reconstructs it.

> SUPERSEDED (see header): this section originally kept `ν = keccak(Cx‖Cy)` (commitment-only) as a value
> separate from `src_leaf`. As shipped, ν is itself `keccak(note_leaf‖"spent")` over the full authenticated
> leaf (`lib.rs:1466`), so the authenticated identity and the spent-set key coincide. Treat the paragraph's
> "ν stays commitment-only" as historical.

## C-02 — batch lane mode (do first; self-contained)

Root cause: the per-input `btc_homed` flag is prover-chosen, so a resumed native leaf can be spent via the
unauthenticated branch. A settle has a single `spend_root`, so btcHomed-ness is a **batch** property.

- Guest reads one `btc_homed_batch: u32` (near `spend_root`), commits it in PublicValues (`pv.btcHomed`).
- Contract asserts `pv.btcHomed == (spendRoot ∈ knownBitcoinRoot)` (it already computes the RHS as `btcHomed`).
- The guest's per-input flag is **removed**: `input_leaf_authed(asset,cx,cy,owner, btc_homed_batch, …)` uses
  `btc_note_leaf` + requires a signature for **every** note input iff the batch is btcHomed; native otherwise.
  No mixing, no per-input downgrade. A resumed native leaf in a btcHomed batch no longer reconstructs (the
  guest builds only `btc_note_leaf`), so it fails membership — fail-closed. (Legacy native notes migrate on
  Bitcoin via an explicit versioned path, not by silent downgrade.)

## C-01 — implementation refinement: bind ASSET (no LiveUtxoSet change)

The fund-critical core is the **asset** mismatch. A same-asset/different-key collision is value-conserved:
creating each colliding note costs a full note of that asset (2v backing for 2v extracted — no profit), and a
third-party same-`(v,r)` collision is cryptographically negligible. So binding the **asset** in the consume
record + re-imposing it in `fold_consumed` is the complete fund-safety fix, and it needs **no `LiveUtxoSet`
change** — the set already stores `(outpoint, commitment_hash, asset)`; `fold_consumed` currently discards the
asset (`_asset`). Minimal change:

- New `PublicValues` field `bitcoinConsumedSources: bytes32[]` = the spent asset id per consumed btcHomed
  input, aligned 1:1 with `pv.nullifiers` (in a btcHomed batch every note input is a btcHomed consume).
- Contract: `bitcoinConsumed[nu[i]] = keccak256(pv.spendRoot ‖ pv.bitcoinConsumedSources[i])` (keeps the
  spendRoot binding; still one `bytes32` slot — byte-neutral). Assert the vectors' lengths match.
- `eth_consumed_leaf = keccak(ν ‖ spend_root ‖ asset)`; the eth-reflection guest witnesses `(spend_root,
  asset)` and checks `keccak(spend_root‖asset) == bitcoinConsumed[ν]` storage.
- `fold_consumed`: re-impose `stored_asset == recorded_asset` on the retired outpoint (stop discarding it).
  A cheap different-asset decoy now fails the check — the prover can no longer retire the wrong source.

Binding the full key too (below) is optional defense-in-depth; it is NOT required for fund safety and would
re-introduce the `LiveUtxoSet` + inserter churn, so it is deferred unless the re-audit asks for it.

## C-01 (full variant, deferred) — authenticated source leaf through consume + Mode-B

- **Live set** (`LiveUtxoSet`): entries become `(outpoint, commitment_hash, asset, auth_key)`. Every inserter
  (reflection folds: cxfer, swap_var, swap_route, lp_add share, lp_remove, farm, protocol-fee, crossout,
  swap_batch) already derives `auth_key` for the leaf — pass it to `live.insert`. The root now commits
  `auth_key` (digest changes — expected for the reprove).
- **Consumed record.** For each consumed btcHomed input the guest emits its `src_leaf` in a new
  `pv.bitcoinConsumedSources: bytes32[]`, aligned 1:1 with the recorded `ν` (order-matched to `pv.nullifiers`
  for a btcHomed batch — where every note input is a btcHomed consume). Contract records
  `bitcoinConsumed[nu[i]] = pv.bitcoinConsumedSources[i]` (was `= pv.spendRoot`). Byte-neutral: same
  `bytes32→bytes32` slot.
- **eth_consumed_leaf** = `keccak(ν ‖ src_leaf)` (was `keccak(ν ‖ spendRoot)`). Now distinguishes two
  same-`ν` notes.
- **Mode-B `fold_consumed`.** Given `(ν, src_leaf)`: the prover supplies a source outpoint; the guest looks up
  its live entry `(commitment_hash, asset, auth_key)`, reconstructs `btc_note_leaf(asset, Cx, Cy, auth_key)`,
  and requires it to equal `src_leaf` (and `commitment_hash == commitment_hash(Cx,Cy)`). Retire THAT outpoint,
  fold `ν` into the spent set. A cheap different-asset (or different-key) decoy reconstructs a different leaf →
  rejected. The prover can no longer retire the wrong source.

Why asset-binding is the fund core: a same-commitment/different-asset decoy is cheap (attacker mints asset B
freely) → cross-asset profit; a same-asset/different-key collision costs a full note of the same asset →
value-conserved, no profit. Binding the full `src_leaf` closes both.

## C-03 — bridge-mint and reflected bridge-out use the authenticated leaf

- The **reflected-note bridge-out** (`reflect.rs:645-667`) and **`OP_BRIDGE_MINT` / stealth-mint source
  membership** (`main.rs:736-860`) must reconstruct `btc_note_leaf(asset, Cx, Cy, auth_key)` where `auth_key`
  is derived from the confirmed source output's P2TR scriptPubKey — matching how the note was reflected.
- The **scan-free burn-deposit** path stays native and self-consistent, but must be a *distinct, versioned
  source kind* so the two never silently share a reconstruction. Prefer one shared source-leaf helper used by
  reflection, spend, and mint so the domains cannot drift again.

## H-01 — coordinated bridge_burn contract change (after C-01)

Remove the `btcHomed && crossOuts` revert AND add `crossOuts.length != 0` to the `bitcoinConsumed`
recording condition (else a zero-fee cross-out skips source-retirement — the revert is currently load-bearing
precisely because crossOuts is absent from that gate). Delete the now-dead `BridgeBurnNotEthHomed` error/branch
to stay byte-neutral.

## M-01 — protocol-fee lock

Stage the protocol-fee lock leaves **before** the btcHomed input authorization and include them in the signed
output transcript; and make the fee-lock commitment opening **recipient-reconstructible** from public,
unique tx context (`domain ‖ pool ‖ pre-state ‖ post-state ‖ asset ‖ exact cut`) rather than depending on a
sender-supplied memo — so a trader cannot make its own protocol fee permanently unclaimable. This also fixes
the ordinary (Ethereum-homed) fee-switch path, which the contract's btcHomed bar does not cover.

## Also

- L-01: reject/skip non-P2TR outputs in reflection instead of `unwrap_or([0;32])` (no zero-key leaves).
- L-02: F4 identity-kernel hardening removed (rejected valid zero-excess transfers; guarded a non-exploit).
- H-03: reproducible-artifact discipline is a build/deploy step (locked manifests, rebuilt ELFs, real-proof
  fixtures, deterministic bytecode) — done in the prove/deploy cycle, not the source.

## Status (EARLIER ROUND — asset-only C-01; SUPERSEDED by the full-leaf + leaf-based-ν header)

> This section records the first (asset-only) round: `bitcoinConsumed[ν] = keccak(spendRoot‖asset)` and a
> commitment-only ν. It was superseded — the consume record now carries the full `srcLeaf`
> (`keccak(btc_spend_root‖srcLeaf)`) and ν is itself leaf-based (`keccak(note_leaf‖"spent")`). See the
> CORRECTION header for the authoritative, as-shipped model. Retained only as change history.


- **L-02 ✅** F4 identity-kernel hardening removed.
- **C-02 ✅** Batch lane mode: `batch_authenticated = bitcoin_spent_root != 0` (the contract guarantees a
  btcHomed batch has non-zero `bitcoinSpentRoot`), so every note input in a btcHomed batch takes the
  authenticated `btc_note_leaf`+signature path; per-input prover flags removed. Guest-only, no ABI change.
- **C-01 ✅ (fund-critical)** `input_leaf_authed` records each btcHomed consumed input's asset into
  `pv.bitcoinConsumedSources` (guest asserts 1:1 alignment with `nullifiers`); contract records
  `bitcoinConsumed[ν] = keccak(spendRoot‖asset)`; eth-reflection reflects the slot value opaquely (no change);
  `fold_consumed` re-imposes `keccak(btc_spend_root‖live_asset) == recorded` so a different-asset decoy can't
  be retired. PublicValues gained one `bytes32[]` field (ABI change → fixtures/tests regen).
- **C-03 ✅** `OP_BRIDGE_MINT` + stealth variant reconstruct the source leaf per a self-verifying
  `source_is_btc_note` flag (ordinary reflected = `btc_note_leaf`, scan-free burn-deposit = native); membership
  rejects a wrong class. Reflected bridge-out operates on ν only — no change.
- **H-01 ✅** Removed the `btcHomed && crossOuts` revert (+ dead `BridgeBurnNotEthHomed` error) and added
  `crossOuts` to the `bitcoinConsumed` recording condition, so a btcHomed bridge-burn's source is retired.
- **M-01 ✅** Swap protocol-fee lock uses a deterministic blinding (`protofee_blind` = keccak over public swap
  data) with an in-guest commitment (`pedersen_commit_xy`); the recipient recomputes the opening from public
  data and can always claim — no memo dependence. Removed the prover-chosen commitment + opening sigma.
- **L-01 — kept fail-closed (not divergence — soundness + structure).** A non-P2TR note output yields
  `btc_note_leaf(...,0)`; x-only key 0 is not a valid pubkey, so the note is provably unspendable on the ETH
  lane (no theft, no inflation). `output_p2tr_xonly` returns `None` only for a malformed/malicious tx — the
  honest dapp always sends to P2TR, so this is never hit legitimately. Rejecting/skipping is strictly worse:
  `scan_tx_spends` nullifies the input BEFORE the note-append fold, so skipping the output would strand a
  spent input (spent, no note). The zero-key onboard faithfully reflects "note exists on Bitcoin, no ETH
  authority." Left as-is; a re-audit that still wants a hard reject would require moving the P2TR check ahead
  of the vin scan (skip-not-panic, to avoid a DoS on a malicious tx).

Follow-on (not source review): dapp mirror (new consume-source witness, `source_is_btc_note` flag, C-02
per-input-flag removal, deterministic fee-lock recompute for claim), regenerate fixtures/harnesses (PublicValues
ABI), rebuild ELFs + re-pin + `MODE=execute` parity + redeploy.

## Order of implementation

1. C-02 batch flag (self-contained; also simplifies every op). 2. LiveUtxoSet + auth_key (+ inserters).
3. Consume source emission + contract + eth_consumed_leaf. 4. Mode-B fold_consumed. 5. C-03. 6. H-01. 7. M-01.
Each step compiles + keeps cxfer-core tests green; the whole is re-audited before any rebuild.
