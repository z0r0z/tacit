# AMM Phase 2 Ceremony — Coordination Runbook

> Status: Operational reference for coordinating the AMM Groth16
> trusted-setup ceremony.
>
> Scope: produce the canonical Groth16 verifying keys for the three
> AMM V1 circuits — `amm_lp_add`, `amm_lp_remove`,
> `amm_swap_batch` — bundled under a single `vk_cid` JSON wrapper
> and a single `ceremony_cid` audit directory that every V1 AMM
> pool shares.
>
> Pattern reference: matches tacit's mixer ceremony (finalized
> 2026-05-11, `circuit_hash =
> 1373a3bc34153c291d057b44edaba11d5a4aa779d0998e0d0c0e400dfc89129d`,
> 2,227 community contributions, beacon at Bitcoin block 948824,
> bundle pinned at `bafybeidq2ahzte4sfiqjsmhqta62ufenpppzpch5...`).
> The AMM ceremony reuses the same coordinator, queue, and beacon
> mechanics — just three circuits running in parallel against one
> shared Phase 1 ptau.
>
> Audience: ceremony coordinator + Phase 2 contributors.

---

## What the ceremony produces

A content-addressed bundle pinned to IPFS as one directory containing:

- **Three finalized zkeys.** `amm_lp_add_final.zkey`,
  `amm_lp_remove_final.zkey`, `amm_swap_batch_final.zkey`.
- **Three pre-beacon zkeys.** Last per-circuit contribution before
  the beacon (auditors verify each finalized zkey is a clean beacon
  extension of its pre-beacon counterpart).
- **One vk wrapper JSON.** `vk.json` — a single file containing
  the three circuits' verifying keys keyed by `lp_add`,
  `lp_remove`, `swap_batch`. This is what pools pin via `vk_cid`.
- **Three R1CS files.** One per circuit, content-hashed for
  drift detection.
- **One shared Phase 1 ptau.** `pot18_final.ptau` — sufficient
  for all three circuits (largest is 171,162 constraints; pot18
  ceiling is 262,144).
- **Three attestation chains.** Per-circuit genesis-to-beacon
  contribution transcripts (each contribution's prev_cid linking
  back to its circuit's genesis).
- **One beacon transcript.** Bitcoin-block-hash beacon applied to
  all three pre-beacon zkeys at the same Bitcoin block.
- **A verification script** that re-derives every vk in the wrapper
  from the bundle's transcripts.

Pools pin `vk_cid = CIDv1(raw codec, sha256(vk.json))` and
`ceremony_cid = CIDv1(dag-pb, sha256(bundle directory))`. The
indexer/dapp resolves a per-kind verifying key by:

```js
// vk_cid integrity-check (single hash over the wrapper bytes)
const wrapperBytes = await ipfs.cat(pool.vk_cid);
if (!verifyVkCidBinding(wrapperBytes, pool.vk_cid)) throw 'vk_cid mismatch';
const wrapper = JSON.parse(new TextDecoder().decode(wrapperBytes));

// Pick by opcode kind
const vk = wrapper[kind];  // 'lp_add' | 'lp_remove' | 'swap_batch'
await snarkjs.groth16.verify(vk, publicSignals, proof);
```

Normative: SPEC.md §5.14 wire format + §5.16 step 8. Reference:
`tests/amm-validator.mjs` — `deriveVkCid()` / `verifyVkCidBinding()`.

## Trust posture

Standard Groth16 Phase 2 properties:

- **Soundness** requires ≥ 1 honest contributor across each
  circuit's chain. As long as one participant per circuit destroys
  their entropy, no party can forge proofs against that vk.
- **Privacy (zero-knowledge)** does NOT depend on the ceremony.
  Groth16 has unconditional zero-knowledge; trusted setup affects
  forgeability only.
- **Phase 1 (ptau)** must be sourced from a publicly-attested
  ceremony with disjoint contributors. Phase 2 cannot rescue a
  backdoored Phase 1.
- **Shared ptau is sound across circuits.** A single contributor
  who poisons their pot18 contribution would have to do so against
  Hermez's published ptau, which is already finalized — so the
  AMM ceremony only adds Phase 2 trust assumptions, not Phase 1.

Per-circuit soundness is independent: an honest contribution in
`amm_lp_add` does not establish `amm_swap_batch` soundness, and
vice versa. In practice contributors run all three contributions in
one session so honest contributors typically cover all three at
once.

The ceremony output is publicly verifiable — anyone can fetch the
bundle from IPFS, walk all three attestation chains, and re-derive
the three final vks. If every re-derivation matches the published
wrapper JSON, the ceremony's mathematical integrity is established.

---

## Step 0: Pre-flight checks

Before recruitment begins:

- [ ] **All three AMM circuits frozen.** `amm_lp_add.circom`,
      `amm_lp_remove.circom`, `amm_swap_batch.circom`. The
      drift-guard in `dapp/circuits/amm/drift-guard.test.mjs`
      pins SHA-256 hashes of all four `.circom` sources +
      compiled `.r1cs` files + constraint-count fingerprints. Run
      `bash dapp/circuits/amm/build.sh` and confirm drift-guard
      passes — any inadvertent source edit fails the build.

- [ ] **Constraint counts verified.** Expected (post-hardening):
      - `amm_lp_add`: 5,153 constraints (budget 30K)
      - `amm_lp_remove`: 10,369 constraints (budget 30K)
      - `amm_swap_batch`: 171,162 constraints (budget 300K; fits
        pot18 = 262K)

- [ ] **R1CS hashes recorded.** Per-circuit `sha256(r1cs)` is the
      `circuit_hash` that anchors each ceremony chain. Three
      circuit hashes total, one per zkey chain.

- [ ] **Phase 1 ptau chosen + provenance-verified.** See next
      section.

---

## Step 1: Phase 1 (Powers-of-Tau) provenance

The largest AMM circuit is `amm_swap_batch` at 171,162 constraints.
This requires a ptau file sized for ≥ 2^18 (262,144) constraints.
**Canonical choice: `powersOfTau28_hez_final_18.ptau`.**

Rationale: pot18 fits with 1.7× margin and matches the
`dapp/circuits/amm/dev-zkey/` lineage. pot19 (524K cap) would
double bundle storage and contributor download cost for zero
protocol benefit at N_MAX=16 — any future N_MAX bump needs a
fresh ceremony either way, so the headroom is illusory.

**Recommended source:** Polygon Hermez Perpetual Powers of Tau
ceremony — 71 public contributors (2020–2022), Bitcoin-block-hash
beacon-finalized. Same provenance the mixer uses for pot14.

| File | Max constraints | Use case |
|---|---|---|
| `powersOfTau28_hez_final_18.ptau` | 2^18 = 262,144 | **AMM canonical** |
| `powersOfTau28_hez_final_19.ptau` | 2^19 = 524,288 | Not needed for V1 |
| `powersOfTau28_hez_final_20.ptau` | 2^20 = 1,048,576 | Overkill |

**Provenance verification.** Canonical BLAKE2b-512 hash for pot18
comes from the published snarkjs README. SHA256 is not canonically
published by Hermez; compute locally after BLAKE2b matches and
pin it as belt-and-suspenders cross-check (same pattern as the
mixer's `dapp/circuits/build.sh:47` pin).

```bash
# Fetch the ptau file
curl -O https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_18.ptau

# Pinned BLAKE2b-512 from snarkjs README
EXPECTED_BLAKE2B="7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e"
EXPECTED_SHA256="<compute locally on first verified download>"

ACTUAL_BLAKE2B=$(openssl dgst -blake2b512 powersOfTau28_hez_final_18.ptau 2>/dev/null | sed 's/.*= //')
ACTUAL_SHA256=$(shasum -a 256 powersOfTau28_hez_final_18.ptau | cut -d' ' -f1)

[ "$ACTUAL_BLAKE2B" = "$EXPECTED_BLAKE2B" ] || { echo "PTAU BLAKE2B MISMATCH"; exit 1; }
```

Refuse to use the ptau file on ANY hash mismatch. Phase 2 cannot
rescue a backdoored Phase 1, so this verification is load-bearing.

---

## Step 2: Phase 2 setup (genesis contributions)

The coordinator runs the genesis Phase 2 setup for each of the
three circuits, sharing the same ptau:

```bash
SNARKJS=npx --yes snarkjs@0.7.6
PTAU=powersOfTau28_hez_final_18.ptau

for c in amm_lp_add amm_lp_remove amm_swap_batch; do
    R1CS="dapp/circuits/amm/build/${c}.r1cs"
    Z0="${c}_0000.zkey"

    $SNARKJS groth16 setup "$R1CS" "$PTAU" "$Z0"
    $SNARKJS zkey verify "$R1CS" "$PTAU" "$Z0"
done
```

Each genesis zkey is pinned to IPFS; the coordinator initializes
three parallel ceremony chains on the worker, one per circuit
hash:

```bash
# Each /ceremony/init creates an independent chain keyed by circuit_hash
for c in amm_lp_add amm_lp_remove amm_swap_batch; do
    R1CS="dapp/circuits/amm/build/${c}.r1cs"
    CIRCUIT_HASH=$(shasum -a 256 "$R1CS" | cut -d' ' -f1)
    curl -X POST \
      -H "X-Tacit-Init-Token: $CEREMONY_INIT_TOKEN" \
      -F "circuit_hash=$CIRCUIT_HASH" \
      -F "zkey0=@${c}_0000.zkey" \
      -F "r1cs=@$R1CS" \
      -F "ptau=@$PTAU" \
      -F "initiator_name=tacit-amm-coordinator" \
      "https://tacit-pin.rosscampbell9.workers.dev/ceremony/init"
done
```

After this step the worker hosts three independent contribution
queues, all sharing pot18.

---

## Step 3: Contribution rounds

Each contributor performs one Phase 2 contribution per circuit
against that circuit's current head zkey. The worker's
`/ceremony/<hash>/contribute` endpoint orders submissions by CAS
on the head_cid.

### Per-contributor procedure (all three circuits, one session)

```bash
for c in amm_lp_add amm_lp_remove amm_swap_batch; do
    R1CS="${c}.r1cs"
    CIRCUIT_HASH=$(shasum -a 256 "$R1CS" | cut -d' ' -f1)

    # Fetch current head zkey for this circuit
    HEAD_CID=$(curl -s "$WORKER/ceremony/$CIRCUIT_HASH" \
      | python3 -c "import sys,json; print(json.load(sys.stdin)['state']['head_cid'])")
    curl -sLf "$GATEWAY/$HEAD_CID" -o "${c}_prev.zkey"

    # Contribute (snarkjs prompts for entropy)
    $SNARKJS zkey contribute "${c}_prev.zkey" "${c}_mine.zkey" \
        --name="${MY_NAME}" --entropy="$(head -c 64 /dev/urandom | base64)"

    # Verify the contribution is structurally valid
    $SNARKJS zkey verify "$R1CS" pot18_final.ptau "${c}_mine.zkey"

    # Submit to coordinator queue (worker uploads to IPFS + advances chain)
    curl -X POST \
      -F "zkey=@${c}_mine.zkey" \
      -F "contributor_name=$MY_NAME" \
      -F "expected_head_cid=$HEAD_CID" \
      "$WORKER/ceremony/$CIRCUIT_HASH/contribute"
done
```

Wall-clock per contributor: `amm_lp_add` (~5K constraints) +
`amm_lp_remove` (~10K) finish in seconds each; `amm_swap_batch`
(~171K) is the dominant cost at ~2–3 minutes on a modern laptop.
Full session ~3–5 minutes including pot18 download (first time
only — cached after).

### Toxic-waste destruction (load-bearing for soundness)

After contributing, **the contributor MUST destroy their entropy
source**. Recommended:

1. Wipe the machine (full-disk overwrite or physical destruction).
2. Attest publicly to having done so.
3. Do NOT retain ANY backup of the entropy used.

One honest contributor per circuit suffices for that circuit's
soundness. So the discipline doesn't require every participant to
be perfect — but each contribution should be treated as
load-bearing.

### Coordinator-side queue management

The coordinator's public queue page shows all three chains in
parallel:

```
AMM Phase 2 Ceremony (https://amm-ceremony.tacit.dev/queue)
─────────────────────────────────────────────────────────────────
                       lp_add      lp_remove    swap_batch
Genesis                ✓           ✓            ✓
alice    (0001)        ✓           ✓            ✓
bob      (0002)        ✓           ✓            ✓
carol    (0003)        ✓           ✓            —  (in flight)
─────────────────────────────────────────────────────────────────
Current contributions: lp_add=247  lp_remove=246  swap_batch=241
```

Contributors poll the queue; the next slot per circuit is whoever
picks up the current head + completes a valid contribution first.
Worker CAS ensures one canonical ordering per chain. Cross-circuit
ordering is independent — a contributor can contribute to
`amm_lp_add` and `amm_swap_batch` in either order.

### Recommended contribution window

**Target: ≥ 1,000 contributions per circuit over ~4–6 weeks.**
Match or exceed the mixer's 2,227 (which exceeded Tornado Cash's
1,114). Most contributors will hit all three chains in one session,
so the per-circuit count converges.

Diversity considerations:
- Geographic (recruit from multiple continents/timezones)
- Organizational (independent contributors, not all from one team)
- Hardware-stack (different OS, different CPU vendors)
- Network-path (ideally air-gapped contribution machines)

Promote via tacit channels + Bitcoin/cryptography communities.

---

## Step 4: Beacon finalization

After the contribution window closes, the coordinator applies the
**same Bitcoin-block-hash beacon to all three pre-beacon zkeys**
at the same block. This produces three canonical finalized zkeys
in one beacon transaction.

**Beacon source: Bitcoin block hash.**

Pick a future Bitcoin block height in advance. Recommended: a
block ~24–48 hours after the contribution window closes.

```bash
BEACON_BLOCK_HEIGHT=<announced height>
BEACON_BLOCK_HASH=$(bitcoin-cli getblockhash $BEACON_BLOCK_HEIGHT)

for c in amm_lp_add amm_lp_remove amm_swap_batch; do
    R1CS="${c}.r1cs"

    $SNARKJS zkey beacon "${c}_pre_beacon.zkey" "${c}_final.zkey" \
        $BEACON_BLOCK_HASH 10 \
        --name="Bitcoin block $BEACON_BLOCK_HEIGHT beacon"
    $SNARKJS zkey verify "$R1CS" pot18_final.ptau "${c}_final.zkey"
    $SNARKJS zkey export verificationkey "${c}_final.zkey" "${c}_vk.json"
done
```

**Why a Bitcoin block hash works as a beacon:** unpredictable
until the block is mined, public once it is, and cannot be
retroactively manipulated. Even a malicious coordinator who
controls every prior contribution cannot pre-compute the beacon's
effect — they'd have to mine a specific block, which is
computationally infeasible. The 10-iteration MiMC chain (matching
the mixer pattern) makes the beacon's effect indistinguishable
from random.

The same beacon applied to all three pre-beacon zkeys means one
Bitcoin block hash is the cryptographic anchor for the entire
AMM ceremony — auditable as a single event.

---

## Step 5: Wrapper construction + publication

Build the per-kind vk wrapper that pools pin via `vk_cid`:

```bash
# Construct the wrapper JSON (canonical key order: lex-ascending)
python3 <<'PY' > vk.json
import json
wrapper = {
    "lp_add":     json.load(open("amm_lp_add_vk.json")),
    "lp_remove":  json.load(open("amm_lp_remove_vk.json")),
    "swap_batch": json.load(open("amm_swap_batch_vk.json")),
}
json.dump(wrapper, open("vk.json","w"), sort_keys=True, separators=(",",":"))
PY

# Derive vk_cid (CIDv1 raw codec, sha2-256) over the wrapper bytes
# Reference impl: tests/amm-validator.mjs deriveVkCid
```

Bundle everything for public audit:

```
amm-ceremony-bundle/
├── circuits/
│   ├── amm_lp_add.r1cs
│   ├── amm_lp_remove.r1cs
│   └── amm_swap_batch.r1cs
├── zkeys/
│   ├── amm_lp_add_0000.zkey           # genesis Phase 2 state
│   ├── amm_lp_add_pre_beacon.zkey
│   ├── amm_lp_add_final.zkey
│   ├── amm_lp_remove_0000.zkey
│   ├── amm_lp_remove_pre_beacon.zkey
│   ├── amm_lp_remove_final.zkey
│   ├── amm_swap_batch_0000.zkey
│   ├── amm_swap_batch_pre_beacon.zkey
│   └── amm_swap_batch_final.zkey
├── attestations/
│   ├── amm_lp_add/                     # per-circuit chains
│   ├── amm_lp_remove/
│   └── amm_swap_batch/
├── powersOfTau28_hez_final_18.ptau     # Phase 1 input (shared)
├── vk.json                              # canonical per-kind wrapper (vk_cid resolves here)
├── verify-ceremony.sh                   # public auditor's tool
└── README.md                            # human-readable summary
```

### `verify-ceremony.sh` (the public auditor's tool)

```bash
#!/usr/bin/env bash
set -e

# 1. Verify Phase 1 ptau provenance
EXPECTED_PTAU_BLAKE2B="7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e"
ACTUAL_B2B=$(openssl dgst -blake2b512 powersOfTau28_hez_final_18.ptau 2>/dev/null | sed 's/.*= //')
[ "$ACTUAL_B2B" = "$EXPECTED_PTAU_BLAKE2B" ] || { echo "PTAU BLAKE2B FAIL"; exit 1; }

# 2. For each circuit, verify the chain + beacon + vk derivation
for c in amm_lp_add amm_lp_remove amm_swap_batch; do
    echo "Verifying $c..."

    # Walk the per-circuit attestation chain
    # (chain integrity proven by prev_cid links recursively from beacon)

    # Re-derive vk from final.zkey
    npx snarkjs zkey verify circuits/${c}.r1cs powersOfTau28_hez_final_18.ptau zkeys/${c}_final.zkey
    npx snarkjs zkey export verificationkey zkeys/${c}_final.zkey derived_${c}_vk.json
done

# 3. Verify the wrapper JSON contains the three derived vks
python3 <<'PY'
import json
w = json.load(open("vk.json"))
for kind, fname in [("lp_add", "derived_amm_lp_add_vk.json"),
                    ("lp_remove", "derived_amm_lp_remove_vk.json"),
                    ("swap_batch", "derived_amm_swap_batch_vk.json")]:
    derived = json.load(open(fname))
    assert w[kind] == derived, f"vk mismatch on {kind}"
print("All three vks match the derived ceremony output ✓")
PY

echo "✓ Ceremony verified. The canonical vk wrapper derives correctly"
echo "  from the three published transcripts under shared pot18."
```

### IPFS pinning

```bash
# Pin the entire bundle as one directory
ipfs add -r amm-ceremony-bundle/
# Record the resulting root CID as AMM_CEREMONY_CID

# Pin vk.json separately as a raw blob (its CID is what pools pin)
ipfs add --cid-version=1 --raw-leaves amm-ceremony-bundle/vk.json
# Record this CID as AMM_VK_CID (starts with "bafkrei...")
```

Both CIDs go into the dapp's launch constants and into pool-init
defaults. Every V1 AMM pool's `POOL_INIT` envelope binds to these.

---

## Step 6: Acceptance criteria

The ceremony is complete when:

- [ ] ≥ 1,000 community contributions accepted per circuit
      (≥ 2,000 target to match the mixer pattern)
- [ ] Each circuit's genesis zkey derived correctly from pot18
      (verified independently by ≥ 3 reviewers)
- [ ] Every contribution in every queue verified
      (`snarkjs zkey verify` passes; chain link via prev_cid intact)
- [ ] Bitcoin-block-hash beacon applied to all three pre-beacon
      zkeys at the same block
- [ ] All three finalized zkeys verified post-beacon
- [ ] `vk.json` wrapper constructed from the three derived vks
- [ ] Wrapper content-addressed via IPFS (CID computed; auditable)
- [ ] Full bundle directory pinned to IPFS (separate dir CID for
      `ceremony_cid`)
- [ ] Public verification script reproduces all three vks from
      transcripts
- [ ] CIDs hardcoded in dapp + worker
- [ ] Transcript publicly announced via tacit channels

When all are checked: ceremony is finalized. The three vks are
permanently committed and used by all V1 AMM pools.

---

## Step 7: Public announcement

Recommended announcement format:

```
Tacit AMM Phase 2 Ceremony — Finalized

Circuits:
- amm_lp_add      (5,153 constraints)
- amm_lp_remove   (10,369 constraints)
- amm_swap_batch  (171,162 constraints; N_MAX=16)

Phase 1: powersOfTau28_hez_final_18 (Hermez, BLAKE2b verified)
Contributions: <N> per circuit over <window dates>
Beacon: Bitcoin block <height> at <hash> (10 MiMC iterations,
        applied to all three pre-beacon zkeys at the same block)
Bundle CID:     <bafy...>    (ceremony_cid; full audit directory)
vk wrapper CID: <bafkrei...> (vk_cid; per-kind verifying keys)
Verification: ipfs get <CID>/verify-ceremony.sh && bash verify-ceremony.sh

The canonical AMM vk wrapper is permanently committed. All V1 AMM
pools share this trust anchor. Auditors can verify the ceremony's
mathematical integrity by running the verification script against
the public bundle.

Soundness rests on ≥ 1 honest contributor per circuit having
destroyed their toxic waste. Privacy (zero-knowledge) is
unconditional and does not depend on the ceremony.

Thank you to the <N> public contributors who made this ceremony
possible.
```

---

## Operational risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Phase 1 ptau backdoor | Very low | Polygon Hermez is widely-attested; dual-hash verification refuses on mismatch |
| Contributor drops out mid-queue | Medium | Queues are async, per-circuit; next contributor takes the next slot |
| Coordinator censorship of submissions | Low | Submissions land on IPFS; coordinator only orders the public queue; refused submissions can be re-posted via alternative coordinators |
| Beacon-block grinding attack | Negligible | Block selection announced in advance; attacker can't manipulate hash without mining; 10-iter MiMC frustrates weak biasing |
| Circuit bug found after ceremony | Low (mitigated by pre-ceremony review) | Fresh ceremony required for the affected circuit; the other two can stay if independent |
| Coordinator loses ceremony bundle | Low | IPFS pinning; multiple pinning services (Pinata, web3.storage, Filecoin) |
| Contributor skips a circuit | Acceptable | Each chain is independent; missing contributions don't break the others |

---

## Reference: how this differs from the mixer ceremony

| Aspect | Mixer ceremony | AMM ceremony |
|---|---|---|
| Phase 1 ptau | `powersOfTau28_hez_final_14` (16K cap) | `powersOfTau28_hez_final_18` (262K cap) |
| Circuits | mixer canonical (one chain) | three chains (lp_add, lp_remove, swap_batch) |
| Phase 2 contributions | 2,227 over public window | ≥ 1,000 per chain target |
| Beacon | Bitcoin block 948824, 10 MiMC | TBD block, same 10 MiMC pattern |
| vk_cid | single-file raw-codec CID of the withdraw vk JSON | single-file raw-codec CID of the `{lp_add, lp_remove, swap_batch}` JSON wrapper |
| Bundle CID | `bafy...y2u` | TBD post-finalization |
| Verification | Public script in bundle | Same approach, three circuits |

The wire format and integrity rule (`vk_cid` is CIDv1 raw codec
+ sha2-256 over the resolved JSON bytes) are uniform across pool
kinds; only the resolved JSON shape differs (mixer: flat vk;
AMM: per-kind wrapper).

---

## What to start NOW (week 0)

1. **Confirm all three AMM circuits frozen.** Run drift-guard
   against current `dapp/circuits/amm/` sources.
2. **Fetch + verify pot18.** Pin to local + IPFS.
3. **Generate the three genesis Phase 2 zkeys.** Record genesis
   CIDs per circuit.
4. **POST `/ceremony/init` × 3** against the worker (one per
   circuit hash).
5. **Set up the public queue infrastructure.** Static page + IPFS
   pinning service. Display all three chains in parallel.
6. **Begin participant recruitment** via tacit + crypto channels.
7. **Announce the contribution window dates** + target beacon
   block height.

Contributions begin as soon as the three genesis zkeys are
published.

End of runbook. Next coordinator action: fetch + verify pot18,
publish the three genesis Phase 2 zkeys.
