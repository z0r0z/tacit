# AMM Phase 2 Ceremony — Coordination Runbook

> Status: 🛠️ Operational reference for coordinating the AMM
> Groth16 trusted-setup ceremony.
>
> Scope: produce the canonical `vk` for `amm_swap_batch.circom`
> (`172K` constraints, `N_MAX = 16`) that all V1 AMM pools share.
>
> Pattern reference: matches tacit's existing mixer ceremony
> (finalized 2026-05-11, `circuit_hash =
> 1373a3bc34153c291d057b44edaba11d5a4aa779d0998e0d0c0e400dfc89129d`,
> 2,227 community contributions, beacon at Bitcoin block 948824,
> bundle pinned at `bafybeidq2ahzte4sfiqjsmhqta62ufenpppzpch5...`).
> The AMM ceremony follows the same structure for consistency.
>
> Audience: ceremony coordinator + Phase 2 contributors.

---

## What the ceremony produces

A content-addressed bundle pinned to IPFS containing:
- The final `amm_swap_batch.zkey` (Phase 2 output)
- The pre-beacon `amm_swap_batch.zkey` (last contribution before
  beacon finalization)
- The verification key `amm_swap_batch.vk.json`
- The R1CS file `amm_swap_batch.r1cs`
- The Phase 1 `ptau` file used as input
- The attestations chain (each contribution's transcript + the
  prev_cid linking back to genesis)
- A verification script that re-derives the `vk` from the bundle

The `vk` is what every conforming indexer uses to verify
`T_SWAP_BATCH` Groth16 proofs. Once published, it is immutable;
every V1 AMM pool binds to it.

## What the ceremony's trust posture is

Standard Groth16 Phase 2 properties:

- **Soundness** requires ≥ 1 honest contributor across the
  ceremony. As long as one participant destroys their toxic
  waste (entropy contribution), no party can forge proofs against
  the resulting `vk`.
- **Privacy (zero-knowledge)** does NOT depend on the ceremony.
  Groth16 has unconditional zero-knowledge; trusted setup affects
  forgeability only.
- **Phase 1 (ptau)** must be sourced from a publicly-attested
  ceremony with disjoint contributors. Phase 2 cannot rescue a
  backdoored Phase 1.

The ceremony output is publicly verifiable — anyone can fetch the
bundle from IPFS, walk the attestation chain, and re-derive the
final `vk`. If the re-derivation matches the published `vk`, the
ceremony's mathematical integrity is established. Contributor
trust (did they actually destroy their entropy?) is independent
per contributor; honest behavior of even one participant suffices.

---

## Step 0: Pre-flight checks

Before recruitment begins:

- [ ] **`amm_swap_batch.circom` is frozen.** Any future change to
      the circuit invalidates the ceremony output and requires a
      fresh ceremony. Confirm with the implementation team that
      the circuit is at its final form (no pending P0 changes from
      the spec hardening pass).

- [ ] **Constraint count verified.** Compile the circuit; verify
      `~172K constraints` matches AMM.md's stated budget. If
      constraints diverge significantly, recheck the circuit
      before locking the ptau choice.

- [ ] **R1CS file checksum recorded.** Compute
      `sha256(amm_swap_batch.r1cs)`; this is the `circuit_hash`
      that anchors the ceremony. Every contributor will verify
      they're working against this exact circuit.

- [ ] **Phase 1 ptau file chosen + provenance-verified.** See
      next section.

---

## Step 1: Phase 1 (Powers-of-Tau) provenance

`amm_swap_batch.circom` at 172K constraints requires a ptau file
sized for ≥ 2^18 (262,144) constraints. The mixer used
`powersOfTau28_hez_final_14.ptau` (sized for 2^14); the AMM needs
a larger ptau.

**Recommended source: Polygon Hermez Perpetual Powers of Tau**
ceremony, same provenance the mixer uses (71 public contributors,
2020-2022, Bitcoin-block-hash beacon-finalized). Select the
appropriate size:

| File | Max constraints | Use case |
|---|---|---|
| `powersOfTau28_hez_final_18.ptau` | 2^18 = 262,144 | Sufficient for amm_swap_batch (172K) |
| `powersOfTau28_hez_final_19.ptau` | 2^19 = 524,288 | Headroom for V2 circuit growth |
| `powersOfTau28_hez_final_20.ptau` | 2^20 = 1,048,576 | Generous headroom |

**Recommended: `powersOfTau28_hez_final_19.ptau`** — gives ~3x
headroom over current constraint count, leaving room for circuit
refinements without re-ceremony. Pin this choice in
`dapp/circuits/amm/build.sh` analogous to how the mixer pins its
ptau choice.

**Provenance verification** (mirroring `dapp/circuits/build.sh`):

Canonical BLAKE2b-512 hash for `powersOfTau28_hez_final_19.ptau` comes from
the published snarkjs README table (same source the mixer's `_14` pin came
from — see `dapp/circuits/build.sh:47`, where mixer's pinned BLAKE2b matches
the snarkjs README byte-for-byte). SHA256 is not canonically published by
Hermez; we compute it locally after BLAKE2b matches and pin it as a
belt-and-suspenders cross-check (same pattern as mixer's
`PTAU_EXPECTED_SHA256`).

```bash
# Fetch the ptau file (mirroring mixer's URL choice — snarkjs README lists
# both this CDN mirror and the s3 mirror; both serve identical bytes).
curl -O https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_19.ptau

# Pinned BLAKE2b-512 from snarkjs README (published Hermez canonical hash).
EXPECTED_BLAKE2B="bca9d8b04242f175189872c42ceaa21e2951e0f0f272a0cc54fc37193ff6648600eaf1c555c70cdedfaf9fb74927de7aa1d33dc1e2a7f1a50619484989da0887"
# SHA256 is computed-and-pinned at first verified download. Replace the
# value below after the first verified fetch passes the BLAKE2b check.
EXPECTED_SHA256="<compute locally on first verified download>"

ACTUAL_BLAKE2B=$(openssl dgst -blake2b512 powersOfTau28_hez_final_19.ptau 2>/dev/null | sed 's/.*= //')
ACTUAL_SHA256=$(shasum -a 256 powersOfTau28_hez_final_19.ptau | cut -d' ' -f1)

[ "$ACTUAL_BLAKE2B" = "$EXPECTED_BLAKE2B" ] || { echo "PTAU BLAKE2B MISMATCH"; exit 1; }
# After first verified fetch passes BLAKE2b, set EXPECTED_SHA256 to ACTUAL_SHA256
# and re-run for subsequent fetches.
if [ "$EXPECTED_SHA256" != "<compute locally on first verified download>" ]; then
  [ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || { echo "PTAU SHA256 MISMATCH"; exit 1; }
fi
```

For reference, the canonical published BLAKE2b-512 hashes from snarkjs
README (use whichever size the ceremony commits to):

| File | Max constraints | BLAKE2b-512 (canonical, from snarkjs README) |
|---|---|---|
| `powersOfTau28_hez_final_18.ptau` | 262,144 | `7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e` |
| `powersOfTau28_hez_final_19.ptau` | 524,288 (**recommended for AMM**) | `bca9d8b04242f175189872c42ceaa21e2951e0f0f272a0cc54fc37193ff6648600eaf1c555c70cdedfaf9fb74927de7aa1d33dc1e2a7f1a50619484989da0887` |
| `powersOfTau28_hez_final_20.ptau` | 1,048,576 | `89a66eb5590a1c94e3f1ee0e72acf49b1669e050bb5f93c73b066b564dca4e0c7556a52b323178269d64af325d8fdddb33da3a27c34409b821de82aa2bf1a27b` |

Refuse to use the ptau file on ANY hash mismatch. Phase 2 cannot
rescue a backdoored Phase 1, so this verification is load-bearing.

---

## Step 2: Phase 2 setup (genesis contribution)

Coordinator runs the genesis contribution (or designates a trusted
participant to do so). This is the first Phase 2 zkey produced
from the ptau.

```bash
# Inputs: circuit r1cs + Phase 1 ptau
# Output: amm_swap_batch_0000.zkey (genesis Phase 2 state)

snarkjs groth16 setup amm_swap_batch.r1cs powersOfTau28_hez_final_19.ptau amm_swap_batch_0000.zkey
```

Verify the setup:
```bash
snarkjs zkey verify amm_swap_batch.r1cs powersOfTau28_hez_final_19.ptau amm_swap_batch_0000.zkey
```

**Pin the genesis zkey to IPFS.** Record its CID. This is the
starting point of the attestation chain.

```bash
ipfs add amm_swap_batch_0000.zkey
# Record the resulting CID as GENESIS_CID
```

---

## Step 3: Contribution rounds (the public ceremony window)

Each contributor performs the same protocol against the prior
contributor's zkey. The coordinator runs a public queue + ordering
to prevent collisions.

### Per-contributor procedure

The contributor receives the prior zkey (by IPFS CID from the
coordinator's queue) and performs one Phase 2 contribution:

```bash
# Download the prior contribution
ipfs get $PRIOR_CID -o amm_swap_batch_prev.zkey

# Contribute (snarkjs prompts for entropy: mouse, keyboard, /dev/random)
snarkjs zkey contribute amm_swap_batch_prev.zkey amm_swap_batch_mine.zkey \
    --name="${MY_NAME}" --entropy=<entropy_source>

# Verify the contribution is structurally valid
snarkjs zkey verify amm_swap_batch.r1cs powersOfTau28_hez_final_19.ptau amm_swap_batch_mine.zkey

# Generate the attestation transcript
snarkjs zkey export verificationkey amm_swap_batch_mine.zkey amm_swap_batch_mine.vk.json

# Compute the contribution attestation
cat <<EOF > amm_swap_batch_mine.attestation.json
{
    "contribution_index": <next index>,
    "contributor_name": "${MY_NAME}",
    "contributor_pubkey": "<optional: contributor's identity pubkey>",
    "timestamp": $(date -u +%s),
    "prev_cid": "${PRIOR_CID}",
    "prev_zkey_sha256": "$(sha256sum amm_swap_batch_prev.zkey | cut -d' ' -f1)",
    "this_zkey_sha256": "$(sha256sum amm_swap_batch_mine.zkey | cut -d' ' -f1)",
    "this_vk_sha256": "$(sha256sum amm_swap_batch_mine.vk.json | cut -d' ' -f1)",
    "circuit_hash": "$(sha256sum amm_swap_batch.r1cs | cut -d' ' -f1)",
    "ptau_hash": "$(sha256sum powersOfTau28_hez_final_19.ptau | cut -d' ' -f1)",
    "toxic_waste_destroyed": true,
    "destruction_method": "<entropy source destroyed, machine wiped, etc.>"
}
EOF

# Pin to IPFS — both the zkey and the attestation
ipfs add amm_swap_batch_mine.zkey
ipfs add amm_swap_batch_mine.attestation.json

# Submit the CIDs to the coordinator's queue
# (CID of the zkey becomes the next PRIOR_CID for the next contributor)
```

### Toxic-waste destruction (load-bearing for soundness)

After contributing, **the contributor MUST destroy their entropy
source**. Recommended:

1. Wipe the machine (full-disk overwrite or physical destruction).
2. Attest publicly to having done so (sign the attestation_json
   with your public identity if you have one).
3. Do NOT retain ANY backup of the entropy used.

If even ONE contributor in the entire ceremony genuinely destroys
their entropy, the ceremony is sound. So the discipline doesn't
require every participant to be perfect — but each contributor
should treat their own contribution as load-bearing.

### Coordinator-side queue management

The coordinator maintains a public ordered list:

```
Contribution Queue (https://amm-ceremony.tacit.dev/queue)
─────────────────────────────────────────────────────
0000  GENESIS     CID: bafy...0000  pinned by coordinator
0001  alice       CID: bafy...0001  ✓ verified
0002  bob         CID: bafy...0002  ✓ verified
0003  carol       CID: bafy...0003  ✓ verified
0004  [pending]   ← next contributor takes this slot
```

When a contributor's submission arrives, the coordinator:
1. Verifies the submitted zkey against the prior CID (chain link)
2. Verifies the zkey structurally via `snarkjs zkey verify`
3. Confirms the attestation JSON matches the zkey hashes
4. Adds to the queue with the next index
5. Pins both zkey + attestation to IPFS

Contributors poll the queue; the next slot is whoever picks up the
prior CID + completes a valid contribution first. Public,
permissionless ordering.

### Recommended contribution window

**Target: ≥ 1000 contributions over ~4-6 weeks.** Match or exceed
the mixer ceremony's 2,227 (which exceeded Tornado Cash's 1,114
reference). More contributors = stronger soundness assumption
(any ONE honest contributor suffices).

Diversity considerations:
- Geographic (recruit from multiple continents/timezones)
- Organizational (independent contributors, not all from one team)
- Hardware-stack (different OS, different CPU vendors)
- Network-path (ideally air-gapped contribution machines)

Promote the ceremony via:
- Tacit project channels
- Bitcoin / cryptography communities (Bitcoin Twitter, Reddit, IRC)
- Privacy-focused groups (Mimblewimble, Aztec, etc.)
- Crypto-community ceremonies that have similar trust postures

---

## Step 4: Beacon finalization

After the contribution window closes, the coordinator applies a
**public, unmanipulable randomness beacon** to the final
contributor's zkey. This produces the canonical `vk`.

**Beacon source: Bitcoin block hash.**

Pick a future Bitcoin block height in advance. Recommended: a
block ~24-48 hours after the contribution window closes, so
contributors have time to settle final submissions.

```bash
# Wait for the announced beacon block to confirm
BEACON_BLOCK_HEIGHT=<announced height>
BEACON_BLOCK_HASH=$(bitcoin-cli getblockhash $BEACON_BLOCK_HEIGHT)

# Apply the beacon (10 MiMC iterations, matching mixer ceremony pattern)
snarkjs zkey beacon amm_swap_batch_FINAL_PRE_BEACON.zkey amm_swap_batch_FINAL.zkey \
    $BEACON_BLOCK_HASH 10 --name="Bitcoin block $BEACON_BLOCK_HEIGHT beacon"

# Verify the beacon-finalized zkey
snarkjs zkey verify amm_swap_batch.r1cs powersOfTau28_hez_final_19.ptau amm_swap_batch_FINAL.zkey

# Export the canonical vk
snarkjs zkey export verificationkey amm_swap_batch_FINAL.zkey amm_swap_batch.vk.json
```

The beacon-finalized zkey `amm_swap_batch_FINAL.zkey` is the
canonical output. Its derived `vk` is what every V1 AMM pool
references.

**Why a Bitcoin block hash works as a beacon**: it's
unpredictable until the block is mined, public once it is, and
cannot be retroactively manipulated. Even a malicious coordinator
who controls every prior contribution cannot pre-compute the
beacon's effect on the zkey — they'd have to mine a specific
block, which is computationally infeasible for an arbitrary
target.

The 10-iteration MiMC chain (matching mixer pattern) makes the
beacon's effect indistinguishable from random, even if the
attacker could weakly bias the chosen block.

---

## Step 5: Publication + pinning

Bundle everything for public audit:

```
amm-ceremony-bundle/
├── amm_swap_batch.circom              # canonical circuit
├── amm_swap_batch.r1cs                # compiled constraints
├── amm_swap_batch_0000.zkey           # genesis Phase 2 state
├── amm_swap_batch_FINAL_PRE_BEACON.zkey  # last contribution
├── amm_swap_batch_FINAL.zkey          # canonical (post-beacon)
├── amm_swap_batch.vk.json             # canonical verification key
├── powersOfTau28_hez_final_19.ptau    # Phase 1 input
├── attestations/
│   ├── 0001_alice.json
│   ├── 0002_bob.json
│   ├── ...
│   └── BEACON_FINALIZATION.json       # the beacon-application transcript
├── verify-ceremony.sh                  # public verification script
└── README.md                            # human-readable summary
```

### `verify-ceremony.sh` (the public auditor's tool)

```bash
#!/bin/bash
set -e

echo "Verifying AMM ceremony..."

# 1. Verify Phase 1 ptau provenance (canonical BLAKE2b from snarkjs README;
#    SHA256 pinned locally after first verified fetch — see "Step 1" above).
EXPECTED_PTAU_BLAKE2B="bca9d8b04242f175189872c42ceaa21e2951e0f0f272a0cc54fc37193ff6648600eaf1c555c70cdedfaf9fb74927de7aa1d33dc1e2a7f1a50619484989da0887"
EXPECTED_PTAU_SHA256="<pinned locally after first verified fetch>"
ACTUAL_B2B=$(openssl dgst -blake2b512 powersOfTau28_hez_final_19.ptau 2>/dev/null | sed 's/.*= //')
ACTUAL_SHA=$(shasum -a 256 powersOfTau28_hez_final_19.ptau | cut -d' ' -f1)
[ "$ACTUAL_B2B" = "$EXPECTED_PTAU_BLAKE2B" ] || { echo "PTAU BLAKE2B FAIL"; exit 1; }
[ "$EXPECTED_PTAU_SHA256" = "<pinned locally after first verified fetch>" ] \
  || [ "$ACTUAL_SHA" = "$EXPECTED_PTAU_SHA256" ] \
  || { echo "PTAU SHA256 FAIL"; exit 1; }

# 2. Walk the attestation chain from genesis to beacon
PRIOR_CID=$(jq -r .ipfs_genesis_cid manifest.json)
for attestation in attestations/0001_*.json ... attestations/000N_*.json; do
    PREV=$(jq -r .prev_cid "$attestation")
    [ "$PREV" = "$PRIOR_CID" ] || { echo "CHAIN BREAK at $attestation"; exit 1; }
    PRIOR_CID=$(jq -r .this_zkey_cid "$attestation")
done

# 3. Verify the beacon application
snarkjs zkey verify amm_swap_batch.r1cs powersOfTau28_hez_final_19.ptau amm_swap_batch_FINAL.zkey
BEACON_BLOCK_HASH=$(jq -r .beacon_block_hash attestations/BEACON_FINALIZATION.json)
# Optional: confirm beacon block hash matches Bitcoin chain history

# 4. Derive vk from FINAL.zkey, compare to published vk.json
snarkjs zkey export verificationkey amm_swap_batch_FINAL.zkey derived_vk.json
diff <(jq -S . derived_vk.json) <(jq -S . amm_swap_batch.vk.json) || {
    echo "VK DERIVATION MISMATCH"; exit 1;
}

echo "✓ Ceremony verified. The canonical vk derives correctly from"
echo "  the published transcripts."
```

Anyone running this script with the IPFS bundle proves the
ceremony's mathematical integrity.

### IPFS pinning

```bash
# Pin the entire bundle
ipfs add -r amm-ceremony-bundle/

# Record the resulting root CID
echo "AMM_CEREMONY_CID=<bafy...>" >> dapp/circuits/amm/CEREMONY_CID
```

### Hardcode the CID in the dapp

```js
// dapp/circuits/amm/ceremony.js
export const AMM_CEREMONY_CID = "bafybeiq2ahzte...";  // pinned at ceremony finalization
export const AMM_VK_CID = "bafybeiabc123...";          // CID of vk.json specifically
```

Every V1 AMM pool's `POOL_INIT` envelope binds to this `vk_cid`
+ `ceremony_cid` (via the existing AMM.md mechanism). All pools
share the same trust anchor.

---

## Step 6: Acceptance criteria

The ceremony is complete when:

- [ ] ≥ 1000 community contributions accepted (≥ 1100 strongly
      recommended to match Tornado Cash's reference; aim for
      ≥ 2000 to match or exceed mixer ceremony pattern)
- [ ] Genesis zkey derived correctly from ptau (verified
      independently by ≥ 3 reviewers)
- [ ] Every contribution in the queue verified (snarkjs zkey verify
      passes; chain link via prev_cid intact)
- [ ] Bitcoin-block-hash beacon applied to final pre-beacon zkey
- [ ] Final beacon zkey verified
- [ ] `vk.json` derived from final zkey, content-addressed via IPFS
- [ ] Full bundle pinned to IPFS at canonical CID
- [ ] Public verification script reproduces the vk from transcripts
- [ ] CID hardcoded in dapp + worker
- [ ] Transcript publicly announced via tacit project channels +
      crypto community channels

When all are checked: ceremony is finalized. The `vk` is
permanently committed and used by all V1 AMM pools.

---

## Step 7: Public announcement

Recommended announcement format (modeled on the mixer ceremony
announcement):

```
Tacit AMM Phase 2 Ceremony — Finalized

Circuit: amm_swap_batch.circom (172K constraints, N_MAX=16)
Circuit hash: <sha256 of amm_swap_batch.r1cs>

Contributions: <N> over <window dates>
Beacon: Bitcoin block <height> at <hash> (10 MiMC iterations)
Bundle CID: <bafy...>
Verification: ipfs get <CID>/verify-ceremony.sh && bash verify-ceremony.sh

The canonical AMM vk is permanently committed. All V1 AMM pools
share this trust anchor. Auditors can verify the ceremony's
mathematical integrity by running the verification script
against the public bundle.

Soundness rests on ≥ 1 honest contributor having destroyed their
toxic waste. Privacy (zero-knowledge) is unconditional and does
not depend on the ceremony.

Thank you to the <N> public contributors who made this ceremony
possible.
```

---

## Operational risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Phase 1 ptau backdoor | Very low | Polygon Hermez is widely-attested; dual-hash verification refuses on mismatch |
| Contributor drops out mid-queue | Medium | Queue is async; next contributor just takes the next slot |
| Coordinator censorship of submissions | Low | Submissions go directly to IPFS; coordinator only orders the public queue; refused submissions can be re-posted via alternative coordinators if needed |
| Beacon-block grinding attack | Negligible | Block selection is announced in advance; attacker can't manipulate the block's hash without mining work; 10-iteration MiMC chain further frustrates weak biasing |
| Circuit found to have bug after ceremony | Low (mitigated by pre-ceremony review) | Fresh ceremony required; vk is per-circuit |
| Coordinator loses ceremony bundle | Low | IPFS pinning; multiple pinning services; backup at `Filecoin` or `Pinata` |

---

## Reference: matching the mixer ceremony pattern

The mixer ceremony (finalized 2026-05-11) provides the operational
template. AMM ceremony follows the same structure:

| Aspect | Mixer ceremony | AMM ceremony |
|---|---|---|
| Phase 1 ptau | `powersOfTau28_hez_final_14` (16K) | `powersOfTau28_hez_final_19` (524K) |
| Circuit | mixer canonical | `amm_swap_batch.circom` (172K) |
| Phase 2 contributions | 2,227 over public window | ≥ 1000 target |
| Beacon | Bitcoin block 948824, 10 MiMC | TBD block, 10 MiMC |
| Bundle CID | `bafy...y2u` | TBD post-finalization |
| Verification | Public script in bundle | Same approach |

This consistency means contributors familiar with the mixer
ceremony recognize the pattern; the trust posture is calibrated
against an already-successful tacit ceremony.

---

## What to start NOW (week 0)

The 6-8 week ceremony timeline assumes immediate action on
recruitment. Specifically, this week:

1. **Confirm `amm_swap_batch.circom` is frozen** (no pending P0
   changes from the spec stack)
2. **Choose the Phase 1 ptau size** (recommended `_19`)
3. **Fetch + verify the ptau** against published canonical hashes
4. **Generate the genesis Phase 2 zkey** + record `GENESIS_CID`
5. **Set up the public queue infrastructure** (a static webpage +
   IPFS pinning service)
6. **Begin participant recruitment** via tacit community channels +
   crypto community outreach
7. **Announce the contribution window dates** (e.g., 4-6 weeks
   from today) + the target beacon block height (~1 week after
   window closes)

Contributions begin as soon as the genesis zkey is published.
Recruitment runs in parallel with engineering tracks 1, 2, 4, 6
of the implementation roadmap.

End of runbook. Next coordinator action: pick Phase 1 ptau size +
verify provenance, then publish genesis Phase 2 zkey.
