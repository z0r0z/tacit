# Box runbook — C-2 (auth_pubkey/owner separation) + M-6, then the reprove

Execute on the prover box (reliable reflection/eth-reflection builds + reprove). Settle-guest pieces validate
locally in ~10s; reflection/eth-reflection pieces need the box. Landed already: C-1 (3450db66), bearer/cBTC
owner-zero dispatch (0df2b11e), H-2 eth-guest groundwork (5678f6ed).

## The invariant to establish
Every native leaf's `owner` field is ONE thing: the spend label `H(nk)` (or 0 for a bearer note). Authorization
(who may operate a position/receipt/lock) is a SEPARATE `auth_pubkey` (BIP-340) committed in that leaf and its
sigma/intent context. No spendable minted note may carry a pubkey (or any non-`H(nk)`) owner.

## C-2 — settle guest (main.rs) output sites
For EACH op that mints a spendable note, witness `out_owner` (the recipient's `H(nk)`), BIND it into the op's
existing authorizing signature message (so a settler cannot redirect it), and use it in the output leaf. The
auth_pubkey stays as the signer. Sites (auditor's table):
- OP_FARM_HARVEST (4886): reward note → `out_owner`; add to `evm_lp_harvest_owner_msg`.
- OP_FARM_UNBOND (4984): LP-return note → `out_owner`; add to `evm_lp_unbond_owner_msg`.
- OP_ADAPTOR_CLAIM (3733): claimed output → `out_owner`; bind in the recipient claim sig (currently `recipient`).
- OP_WRAP_CDP_MINT (4159) / OP_CDP_MINT: debt (cUSD) note → `out_owner`; bind in the debt opening-sigma ctx.
- OP_CDP_CLOSE (4329): each released collateral leg → `out_owner`; bind in the close authorization.
- OP_CDP_TOPUP (4633/4689): replacement collateral → `out_owner`.
- OP_LP_BOND: the bonded receipt is auth-bearing (keep auth_pubkey) but any change/output note → `out_owner`.
Confirm OP_CDP_MINT native-leg debt and OP_STEALTH_CLAIM already use a spendable owner (auditor says yes) — leave.

## C-2 — CDP (the intricate one; DONE elsewhere: harvest/unbond/adaptor-claim landed 85fffdca/dceb6723)
`owner` is currently the position identity for EVERY leg (`(controller32,nonce,owner)`, `(rate_snapshot,nonce,
owner)`, the collateral `(cx,cy,owner)`, the debt `(d_cx,d_cy,owner)`) AND is published in `CdpMint.owner`.
Separate them across OP_CDP_MINT / OP_WRAP_CDP_MINT / OP_CDP_CLOSE / OP_CDP_LIQUIDATE / OP_CDP_TOPUP:
- Position legs + the published `CdpMint.owner` (keeper reconstruction) → an `auth_pubkey` (BIP-340). Keep it as
  the position identity; the close/topup/liquidate authorization signs under it.
- The DEBT (cUSD) note → a witnessed `debt_owner = H(nk)`, spendable, and DO NOT publish it (keep it out of
  `CdpMint` / PV so a position's legs don't link through a shared published owner).
- Released collateral at CLOSE → a FRESH `H(nk)` chosen at close time, bound in the close signature (not the
  mint-time owner). TOPUP's replacement collateral likewise binds its H(nk) via the topup sig.
- The position nullifier stays its dedicated leaf-bound form (like farm_receipt_nullifier) — not native_nu.
Validate: mint→close→spend the debt note; mint→close→spend released collateral; liquidate pays seized legs as
withdrawals (already sound per the auditor) — confirm the debt burn reconstructs the H(nk) debt leaf.

## C-2 — refund paths (auditor: bind the output owner)
`adaptor_refund_msg` and `stealth_refund_msg` bind `(o_cx,o_cy,fee)` but NOT the refund note's owner → a settler
can redirect the refund. Add the refund `out_owner` (H(nk)) to both messages and mint the refund leaf to it.
OP_ADAPTOR_REFUND (~the locker-sig site) + OP_STEALTH_REFUND.

## C-2 — auth-bearing leaves (positions/receipts/locks)
These commit `auth_pubkey` and are consumed by their op via a dedicated nullifier + the auth sig. Their ν must be
LEAF-BOUND (owner-independent) — the bearer dispatch already covers owner==0, but if any position/receipt leaf
was routed through native_nu with a pubkey owner, switch that specific ν to `nullifier(leaf)` and keep the
auth_pubkey purely for the signature. Sites to audit: adaptor_lock (3604), stealth_lock (5152), CDP position
nullification (close/liquidate/topup), farm receipt (unbond). The input-side comments already say "owner==H(nk)"
at 3604/5152 — verify those locked-note inputs really carry H(nk) owners (they should, post-fix) or bearer 0.

## C-2 — reflection farm folds (cxfer-core)
fold_harvest / fold_lp_unbond mint reward/LP notes the SAME way → apply the identical `out_owner` change on the
Bitcoin (Track-B) side, mirrored in dapp/confidential-pool.js and the fixtures. NOTE: the farm reflection folds
already have a guest↔JS mirror DIGEST_MISMATCH (reflection_harvest/farm_lifecycle) — reconcile that FIRST
(likely a stale generator / missing farm-state fields), then layer the owner change so the fixture regen is clean.

## C-2 — round-trip tests (REQUIRED by the auditor)
Per mint→exit→spend chain, one executable test that (1) produces the exit proof and (2) spends the exit note.
Cover native, deposit (owner-0 bearer), and btcHomed inputs. Put them where the guest OP handlers can be driven
(the exec harness), since cxfer-core unit tests don't exercise main.rs dispatch.

## M-6 — swap-batch receipt range (reflection guest)
Add a guest-side BP+ range proof over the secp receipt commitments in `fold_swap_batch` (swap_batch.rs ~404-455),
same primitive OP_SWAP change uses (bpp_range verify). Bounds each receipt to u64 independent of the out-of-bundle
circom. Regen reflection_swapbatch fixture (needs the head zkey) + a red-case test (a `(n−k, honest+k)` receipt
pair must now be rejected).

## Reprove sequence (all three ELFs rotate)
1. Reconcile the reflection fixture board to green (farm mirror + the earlier regen batch) — pre-box parity gate.
2. Build eth-reflection ELF → derive ETH_REFLECTION_VKEY → re-pin in reflect.rs (H-2 completion: reflection side
   surfaces the committee roots + drops the genesis pin; contract chains lastEthSyncCommitteeRoot).
3. Build reflection ELF → BITCOIN_RELAY_VKEY.  4. Build settle ELF → PROGRAM_VKEY.
5. confidential-reprove-apply.sh reconciles (3)+(4); eth [u32;8] re-pin is manual (fast-reprove.sh header).
6. Parallel native-gnark prove + forge *ProofReal green/red + the new round-trip + M-6 red-case tests.
7. Re-bundle for the auditor's re-review of the changed surface.

## Auditor refinements to pin (re-review round 2026-08-22)
- **Owner-zero allow-list (supersedes "owner-zero forbidden on spendable leaves").** ONLY cBTC mint (5096) and the
  scan-free burn-deposit MAY emit owner==0 bearer leaves. EVERY CDP/farm/adaptor/stealth OUTPUT must carry an
  H(nk) owner (never 0). Keep the witness stream OWNER-INDEPENDENT: always read the 32-byte nk slot, ignore it
  when owner==0 (already true for native_input/native_nu after the dispatch — do the same at every inline site,
  so the serializer/dapp never desync on the first bearer note). LEAF REUSE: two identical leaves share a ν and
  the second is unspendable — owner-zero makes collisions likelier (a locker reusing (cx,cy)); dedupe in the
  guest or document as a dapp constraint.
- **cBTC privacy.** owner-zero ν is publicly computable and the lock (cx,cy) is public, so the first spend links.
  Fix: pre-commit `keccak(cx‖cy‖owner)` in the cBTC LOCK envelope so the owner is an H(nk) fixed at lock time
  (front-runner still can't redirect), OR have the dapp mint-and-reshield in one settle. Document either way.
- **CDP keeper reconstruction.** The CDP position leaf + published `CdpMint.owner` exist for keepers → publish
  `auth_pubkey` there; keep the collateral notes' H(nk) owner OUT of the leaf AND the public values (today the
  published owner links all of a position's collateral legs). Released collateral at CLOSE goes to a FRESH H(nk)
  chosen at close time and bound in the close signature.
- **Refund sigs.** `adaptor_refund_msg` and `stealth_refund_msg` bind (o_cx,o_cy,fee) but NOT the output owner —
  add the output owner, or a settler redirects the refund. (Harvest/unbond owner-msgs: reward_owner already added.)
- **farm_receipt_leaf** changes the Bitcoin-side leaf too (byte-identical per the comment) — coordinate the leaf
  change with the reflection farm folds explicitly under the vkey rotation.
- **H-2** must ALSO pin the carried finalized-header root (or slot), not just the committee root — once the store
  may sit at a later slot, an attacker-chosen-execution-root bootstrap returns. `head > prev_head` stays. (Add
  lastEthFinalizedSlot to the contract chain alongside lastEthSyncCommitteeRoot; PV-surface finalizedSlot.)
- **M-6** BP+ aggregation is {1,2,4,8}; SWAP_BATCH_N_MAX = 16 → plan TWO range proofs (or pad to a power of two).
- **M-3** phantom-output live-set bloat: Merkleizing fixes memory not cost — ALSO require a declared CXFER
  output's `vout` to EXIST in the tx and be P2TR, so bloat costs real dust.

## Order
M-6 (contained) → C-2 settle outputs (validate locally) → C-2 reflection folds + fixtures → H-trio (liveness
doc) → coordinated 3-ELF reprove. C-2 is the GO-blocker; do it first after M-6.
