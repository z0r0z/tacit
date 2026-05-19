# tacit AMM — Phase 2 ceremony governance

Companion to [`AMM.md`](../../AMM.md) covering the full ceremony
specification: scope, contributor flow, beacon construction, bundle
layout, audit walk, and trust statement. AMM.md keeps a concise
summary; this file is the implementer/auditor reference.


The three Groth16-gated opcodes (`T_LP_ADD`, `T_LP_REMOVE`,
`T_SWAP_BATCH`) verify proofs against a per-pool verifying key. The
trust posture of those proofs reduces to the trust posture of the
Phase 2 ceremony that produced the key. This section is the
normative spec for that ceremony — scope, structure, beacon, audit
walk, finalization, and recovery — and is the canonical reference
for the `vk_cid` / `ceremony_cid` fields carried in `POOL_INIT`.

The non-ceremony opcodes (`T_INTENT_ATTEST`, `T_PROTOCOL_FEE_CLAIM`,
`T_SWAP_VAR`) carry no Groth16 dependency and are unaffected by
anything in this section. They ship and operate independently.

## Scope: one bundle, three circuits, shared Phase 1

V1 has three Groth16 circuits compiled from
`dapp/circuits/amm/{amm_lp_add,amm_lp_remove,amm_swap_batch}.circom`.
Constraint counts at lock-in (`build.sh` budget assertion):

| Circuit | Opcode | Constraints |
|---|---|---|
| `amm_lp_add`     | `T_LP_ADD`     | 5,153 (budget 30K) |
| `amm_lp_remove`  | `T_LP_REMOVE`  | 10,369 (budget 30K) |
| `amm_swap_batch` | `T_SWAP_BATCH` (N ≤ 16) | 171,162 (budget 300K) |

`amm_swap_batch` exceeds the mixer's 2^14 ceiling, so the AMM
ceremony's shared Phase 1 is `pot18_final.ptau` (Powers of Tau up
to 2^18 = 262,144 constraints). The artifact is the verified
Polygon Hermez ceremony output truncated to 2^18, retrieved by
SHA-256 digest (`finalize-amm.sh` cross-checks against the pinned
hash before any contribution is accepted). The mixer's separate
`pot14_final.ptau` is unaffected; the two ceremonies share lineage
but not artifacts.

The three circuits each run an independent Phase 2 chain anchored
by `circuit_hash = sha256(r1cs_file)`. All three Phase 2 chains
share **one** Bitcoin-block beacon at finalization, so the AMM
ceremony has a single auditable temporal anchor — not three.

## Drift guard binds the ceremony to source

The ceremony commits to the exact byte-content of each `.circom`
source file AND the compiled `.r1cs` artifact. After ceremony
finalization, any byte change is an irrevocable break: V1 pools'
pinned `vk_cid` values stop verifying. `dapp/circuits/amm/
drift-guard.test.mjs` pins SHA-256 hashes of the four source files
(`bjj_pedersen.circom`, `amm_lp_add.circom`, `amm_lp_remove.circom`,
`amm_swap_batch.circom`), the three `.r1cs` artifacts, and
constraint-count fingerprints (non-linear + linear + wires +
public-input count) from a fresh `circom` recompile. The test
MUST be wired into CI before and after the ceremony.

Intentional edits to a circuit after lock-in require: (1)
acknowledging the change in `dapp/circuits/amm/REVIEW.md`, (2)
updating the pinned hashes in `drift-guard.test.mjs`, (3) running
a fresh Phase 2. There is no incremental-patch path; the unit of
ceremony commitment is the source file, not the diff.

## Phase 2: per-circuit coordinator flow

Each circuit's Phase 2 is a chained contribution graph on the
worker. Endpoints are the same shape as the mixer's (`worker/src/
index.js`):

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/ceremony/init` | `POST` | `CEREMONY_INIT_TOKEN` | Coordinator-only. Uploads initial zkey + r1cs for one circuit. One init per circuit hash. |
| `/ceremony/:circuit_hash/contribute` | `POST` | none | Public. Body is a new zkey descending from the current head. Coordinator verifies descent. |
| `/ceremony/:circuit_hash/stats` | `GET` | none | Returns contribution count + head CID without the zkey body. |
| `/ceremony/:circuit_hash/drain` | `POST` | `CEREMONY_INIT_TOKEN` | Coordinator pauses new contributions in preparation for beacon. |
| `/ceremony/:circuit_hash/finalize` | `POST` | `CEREMONY_INIT_TOKEN` | Coordinator submits the post-beacon zkey + descriptor. Chain locks. |
| `/ceremony/:circuit_hash/reset` | `POST` | `CEREMONY_INIT_TOKEN` | Wipes the chain (pre-finalization recovery). |

Contributors pull the current head zkey by `circuit_hash`, run
`snarkjs zkey contribute` with 32 bytes of local entropy, and POST
the new zkey. The coordinator does no contributor trust check —
anyone can contribute, and each contribution is content-addressed
by its IPFS CID. The chain is `genesis → c_1 → c_2 → … → c_N →
beacon`, with each step's `prev_cid` recorded in
`attestations.json`.

Default participation floor enforced by `finalize-amm.sh` is
`MIN_CONTRIBUTIONS = 1000` per circuit. Coordinator may raise it
per ceremony, never lower it.

## Beacon round

After `/drain` quiesces a chain, the coordinator applies a 10-
iteration MiMC beacon (snarkjs `zkey beacon`) seeded with a
specific Bitcoin block's hash. The beacon block is chosen
prospectively: `finalize-amm.sh` auto-picks `tip - 12` for ≥ 12
confirmations, or accepts an explicit block height passed at the
command line. The block hash is cross-checked across two explorers
(`mempool.space` and `blockstream.info`) before beacon application;
mismatch aborts finalize.

**Same beacon block for all three chains.** A single hash drives
all three `zkey beacon` calls. The AMM ceremony's temporal anchor
is therefore one Bitcoin block, not three.

Beacon application is deterministic given (pre-beacon zkey, block
hash, iteration count = 10). Any observer can reproduce
`final.zkey` from the published pre-beacon zkey, the announced
beacon block height, and the publicly observable Bitcoin block
hash. The `attestations.json` beacon entry records `(prev_cid,
beacon_block_height, beacon_block_hash_hex, beacon_iterations: 10)`.

After all three `/finalize` calls return success, the chains lock:
subsequent `/contribute` returns HTTP 409 (`ceremony has been
finalized`). The coordinator then extracts each circuit's
`verification_key.json` (`snarkjs zkey export verificationkey`)
and stages the audit bundle.

## Canonical bundle layout

The published bundle is a single IPFS directory pinned at
`CANONICAL_AMM_CEREMONY_CID`. Contents:

```
ceremony-bundle-amm/
  pot18_final.ptau                       — shared Phase 1
  amm_lp_add.r1cs
  amm_lp_remove.r1cs
  amm_swap_batch.r1cs
  amm_lp_add/
    final.zkey                           — post-beacon
    pre_beacon.zkey                      — last contribution before beacon
    verification_key.json
    attestations.json                    — genesis → … → beacon chain
  amm_lp_remove/
    final.zkey, pre_beacon.zkey,
    verification_key.json, attestations.json
  amm_swap_batch/
    final.zkey, pre_beacon.zkey,
    verification_key.json, attestations.json
  bundle_manifest.json                   — { circuit_name → { r1cs_sha256, final_zkey_cid,
                                             vk_json_cid, attestations_cid, contribution_count } }
                                           plus beacon_block_height, beacon_block_hash,
                                           pot18_sha256, schema_version
```

The dapp pins **two** constants derived from this bundle:

- `CANONICAL_AMM_CEREMONY_CID` — the bundle directory CID above.
- `CANONICAL_AMM_VK_CID` — a wrapper JSON's CID listing the three
  per-circuit `verification_key.json` CIDs by circuit name.

Both are `null` until the ceremony finalizes. The dapp helper
`_isAmmCeremonyUnlocked()` returns true iff both are non-null. The
worker mirrors the same gating server-side: pre-pin, `T_LP_ADD`,
`T_LP_REMOVE`, and `T_SWAP_BATCH` accept a 256-byte placeholder
proof (testnet only); post-pin, the validator verifies each proof
against the per-pool `vk_cid` resolved against the canonical
wrapper.

## POOL_INIT pinning rule

Every V1 `POOL_INIT` MUST set:

- `vk_cid_len`, `vk_cid` = `CANONICAL_AMM_VK_CID` bytes
- `ceremony_cid_len`, `ceremony_cid` = `CANONICAL_AMM_CEREMONY_CID` bytes

Indexers reject any V1 `POOL_INIT` whose `vk_cid` does not equal
`CANONICAL_AMM_VK_CID` (mirrors the mixer's `CANONICAL_VK_CID`
enforcement at `T_DEPOSIT`). The per-pool fields exist so future
ceremonies (concentrated liquidity, alternative curves) can ship
as additive opcodes pinning their own `vk_cid` — V1 pools and the
V1 vk are forever coupled and unaffected by any follow-up
ceremony.

## Audit walk

Any third party can verify the ceremony end-to-end from chain +
IPFS alone, with no coordinator trust:

1. **Fetch** the bundle by `CANONICAL_AMM_CEREMONY_CID`. Content
   addressing guarantees byte-identical retrieval across gateways.
2. **For each circuit** (`amm_lp_add`, `amm_lp_remove`,
   `amm_swap_batch`):
   - Walk `attestations.json` from the beacon entry backward
     through `prev_cid` to genesis. Fetch each referenced zkey by
     CID and run
     `snarkjs zkey verify <circuit>.r1cs pot18_final.ptau <zkey>`.
     Every step MUST return `ZKey OK`.
   - Confirm the genesis zkey was correctly initialized from
     `pot18_final.ptau` and the published `<circuit>.r1cs`.
   - Recompute the post-beacon zkey deterministically from the
     pre-beacon zkey + announced beacon block hash + 10 MiMC
     iterations. Recomputed zkey MUST byte-equal the published
     `final.zkey`.
   - Extract `verification_key.json` from `final.zkey` via
     `snarkjs zkey export verificationkey`. Extracted bytes MUST
     byte-equal the published `verification_key.json` in the
     sub-bundle.
3. **Confirm Phase 1.** `sha256(pot18_final.ptau)` MUST equal the
   digest in `bundle_manifest.json.pot18_sha256` and MUST equal
   the Hermez-distributed `pot18` digest hardcoded in
   `dapp/circuits/finalize-amm.sh`.
4. **Confirm drift-guard pins.** SHA-256 hashes of the
   distributed `.r1cs` files MUST equal the
   `PINNED_R1CS_HASHES` table in `drift-guard.test.mjs`. Source
   `.circom` files in the same commit MUST hash to the
   `PINNED_SOURCE_HASHES` table.
5. **Confirm dapp pin.** The CID computed from the canonical
   wrapper JSON listing the three `verification_key.json` CIDs
   MUST equal the `CANONICAL_AMM_VK_CID` constant in
   `dapp/tacit.js`.
6. **Confirm beacon block.** Fetch the block at
   `beacon_block_height` from two independent explorers; both
   hashes MUST equal `beacon_block_hash` in
   `bundle_manifest.json` and the announced block MUST have been
   unmined at the time `/finalize` was first called (verifiable
   from coordinator logs or, conservatively, by checking that
   `beacon_block_height ≥ tip - 12` is consistent with timestamps
   in the contribution attestations).

A passing audit establishes that for each circuit, **at least one
honest contributor** in the chain (or the beacon round) suffices
to make the V1 vk sound under standard Groth16 assumptions.

## Trust model statement

The V1 AMM ceremony is sound under:

- **≥ 1-honest assumption per circuit** across each Phase 2
  contribution chain including the beacon round. The three chains
  are independent: compromise of one circuit's chain compromises
  knowledge-soundness for that one opcode against V1 pools and
  leaves the other two opcodes' soundness unaffected.
- **Phase 1 (Hermez pot18)** soundness inherited from the Polygon
  Hermez ceremony's ≥ 1-honest threshold among its contributors.
  This is the same Phase 1 trust assumption the live mixer's pot14
  already relies on, scaled up to 2^18 constraints — same
  ceremony, more powers consumed.
- **Beacon unpredictability.** The beacon block is announced
  prospectively (≥ 12 confirmations after `/finalize` time means
  the coordinator commits before the block exists). Bitcoin's PoW
  + public-explorer cross-check make the block hash a public
  random oracle independent of any contributor's choice.

The trust posture is **strictly equal to or stronger than the
mixer's**: same Phase 1 lineage, three independent Phase 2 chains
versus one, same beacon construction with the same explorer
cross-check. A reviewer who trusts the mixer ceremony has no
additional assumption to grant for the AMM beyond running the
audit walk three times.

## Recovery: compromised ceremony

If a Phase 2 chain is shown to be compromised post-finalization,
V1 pools using the affected `vk_cid` are stuck on that vk —
`vk_cid` is content-addressed and immutable on chain. The
protocol's response is opcode-additive, never retroactive:

1. Re-run Phase 2 for the affected circuit using the same
   coordinator endpoints. Publish a new
   `CANONICAL_AMM_VK_CID_v2` and `CANONICAL_AMM_CEREMONY_CID_v2`.
   Bump the dapp constants in a single release.
2. Reserve a follow-up opcode `T_LP_MIGRATE_CEREMONY` (slot
   reserved in §"Opcode space reservation") that, in one
   envelope, burns a V1 share UTXO under the affected vk and
   re-mints an equivalent share UTXO under the new vk. The
   migration circuit is part of the new ceremony bundle.
3. **Indexers continue to honor V1 pools** for non-Groth16
   operations. `T_SWAP_VAR` and `T_PROTOCOL_FEE_CLAIM` carry no
   `vk` dependency and remain safe. `T_LP_REMOVE` against the
   affected pool remains safe for LP withdrawal even with a
   compromised vk, because the on-chain Pedersen check still
   binds the burned share to the right amount — the LP can only
   redeem what they actually hold, regardless of the soundness
   break against new mints. Only `T_LP_ADD` against the affected
   pool becomes economically unsafe (a malicious party could
   mint phantom shares against state the compromised vk would
   accept), and the dapp warns and disables it post-disclosure.

Because the AMM is a virtual-pool architecture with no custody
UTXO, even a worst-case soundness compromise cannot let an
attacker steal real funds out of any pool — they can only inflate
LP-share accounting against the affected vk, diluting honest LPs
who add new liquidity after compromise. Honest LPs can withdraw
unaffected via `T_LP_REMOVE` and migrate via the follow-up
`T_LP_MIGRATE_CEREMONY` opcode.

This is a known recovery path, not an emergency override. It would
be invoked only on independent cryptographic evidence of ceremony
compromise. Otherwise, V1 pools run forever on the original vk and
no migration is required.

