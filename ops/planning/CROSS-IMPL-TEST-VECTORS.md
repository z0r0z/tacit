# Cross-Impl Test Vectors — Schema + Canonical Cases

> Status: 🛠️ Test fixture template for cross-implementation parity
> testing.
>
> Scope: defines the structure, canonical inputs, and expected
> behaviors for parity test vectors across the dapp and worker
> implementations. Derived values (hashes, sigs, Groth16 proofs)
> are TODO placeholders — engineers fill these in once the first
> reference implementation runs.
>
> Goal: eliminate parity-debugging cycles by enshrining canonical
> inputs + expected behaviors before either implementation
> starts. The "is your version compatible with mine?" question
> becomes "does my impl produce the values pinned in this doc?"
>
> Audience: implementing engineers writing the first dapp and
> worker code paths; subsequent third-party indexer implementers.

---

## Repository layout

```
tests/
├── vectors/
│   ├── intent-attest/
│   │   ├── 01_empty_pool.json
│   │   ├── 02_single_intent.json
│   │   ├── 03_full_pool.json
│   │   ├── 04_equivocation_pair.json
│   │   └── 05_stale_attestation.json
│   ├── swap-var/
│   │   ├── 01_self_broadcast_basic.json
│   │   ├── 02_relayed_with_tip.json
│   │   ├── 03_tick_fan_k4.json
│   │   ├── 04_whole_input_consumed.json
│   │   ├── 05_inflation_attempt_rejection.json
│   │   └── 06_stale_reserves_rejection.json
│   ├── swap-batch/
│   │   ├── 01_n2_exact_cancel.json
│   │   ├── 02_n4_A_dominant.json
│   │   ├── 03_n8_mixed_directions.json
│   │   ├── 04_min_out_violation_rejection.json
│   │   └── 05_arbiter_qualifying_set.json
│   ├── lp-ops/
│   │   ├── 01_pool_init.json
│   │   ├── 02_lp_add_post_init.json
│   │   └── 03_lp_remove_proportional.json
│   ├── protocol-fee/
│   │   ├── 01_fee_accrual.json
│   │   └── 02_claim_post_accrual.json
│   └── trade-batch/
│       ├── 01_amm_only_pass_through.json
│       ├── 02_orderbook_only_pass_through.json
│       ├── 03_mixed_cross_surface.json
│       └── 04_combined_aggregate_violation_rejection.json
├── parity-runner.mjs               # Loads each vector, runs against impl
└── CROSS-IMPL-TEST-VECTORS.md      # This file (or symlink to root)
```

Each vector is a JSON file with the schema below; the runner
loads all vectors per opcode and asserts both dapp and worker
produce identical outputs for inputs, and identical accept/reject
decisions for envelopes.

---

## Runner skeleton

```js
// tests/parity-runner.mjs
import { readFile } from 'fs/promises';
import { glob } from 'glob';
import { buildEnvelope, decodeEnvelope } from '../dapp/tacit.js';
import { workerValidate } from '../worker/src/index.js';

async function runVectorSet(opcodeDir) {
    const files = await glob(`tests/vectors/${opcodeDir}/*.json`);
    let pass = 0, fail = 0;
    for (const file of files) {
        const vector = JSON.parse(await readFile(file, 'utf8'));
        const result = runOneVector(vector);
        if (result.pass) { pass++; }
        else { fail++; console.error(`FAIL ${file}: ${result.reason}`); }
    }
    console.log(`${opcodeDir}: ${pass}/${pass+fail}`);
}

function runOneVector(vector) {
    const { inputs, expected_envelope_bytes, expected_decision, expected_state_delta } = vector;

    // Build the envelope from inputs (both impls)
    const dappBuilt = buildEnvelope(inputs);
    const workerBuilt = workerBuildEnvelope(inputs);  // same logic, different impl

    // Parity check 1: byte-identical envelope construction
    if (dappBuilt.toString('hex') !== workerBuilt.toString('hex')) {
        return { pass: false, reason: 'envelope byte mismatch dapp vs worker' };
    }
    if (expected_envelope_bytes && dappBuilt.toString('hex') !== expected_envelope_bytes) {
        return { pass: false, reason: 'envelope mismatch vs pinned vector' };
    }

    // Parity check 2: validator decision
    const dappDecision = dappValidate(dappBuilt, vector.chain_state);
    const workerDecision = workerValidate(workerBuilt, vector.chain_state);
    if (dappDecision.decision !== workerDecision.decision) {
        return { pass: false, reason: `accept/reject disagreement: dapp=${dappDecision.decision}, worker=${workerDecision.decision}` };
    }
    if (dappDecision.decision !== expected_decision) {
        return { pass: false, reason: `decision mismatch vs expected: got ${dappDecision.decision}, expected ${expected_decision}` };
    }

    // Parity check 3: state delta (for accept cases)
    if (expected_decision === 'accept') {
        if (JSON.stringify(dappDecision.state_delta) !== JSON.stringify(expected_state_delta)) {
            return { pass: false, reason: 'state delta mismatch' };
        }
    }

    return { pass: true };
}

for (const opcode of ['intent-attest', 'swap-var', 'swap-batch', 'lp-ops', 'protocol-fee', 'trade-batch']) {
    await runVectorSet(opcode);
}
```

---

## Shared canonical inputs (pinned across all vectors)

These are fixed values referenced by intent-attest, swap-var,
swap-batch, etc. They're pinned here so vectors don't proliferate
inconsistent test-input strings.

```json
{
    "canonical_inputs": {
        "asset_id_TAC":      "0xaa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11",
        "asset_id_cBTC":     "0xbb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22",
        "asset_id_cUSD":     "0xcc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33",
        "trader_privkey_A":  "0x1111111111111111111111111111111111111111111111111111111111111111",
        "trader_privkey_B":  "0x2222222222222222222222222222222222222222222222222222222222222222",
        "trader_privkey_C":  "0x3333333333333333333333333333333333333333333333333333333333333333",
        "worker_privkey_W1": "0xaabb00112233445566778899aabbccddeeff00112233445566778899aabbccdd",
        "worker_privkey_W2": "0xccdd00112233445566778899aabbccddeeff00112233445566778899aabbccdd",

        "TODO_NOTE_PUBKEYS": "Derive pubkeys from above privkeys via secp256k1 generator. Fill in after first impl runs."
    },
    "canonical_outpoints": {
        "trader_A_tac_utxo": {
            "txid_BE": "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
            "vout":    0
        },
        "trader_B_cbtc_utxo": {
            "txid_BE": "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
            "vout":    1
        }
    },
    "canonical_amounts": {
        "small":  1000,
        "medium": 1000000,
        "large":  10000000000
    },
    "canonical_pool_state": {
        "TAC_cBTC_pool_init": {
            "R_A": 50000000,
            "R_B": 525000,
            "S":   5126953,
            "fee_bps": 30,
            "protocol_fee_bps": 100,
            "protocol_fee_accrued": 0
        }
    }
}
```

The TODO_NOTE_PUBKEYS line marks where derived secp256k1 pubkeys
go. Once the first impl runs, replace with the actual 33-byte
compressed-secp256k1 encoding (deterministic from privkey, so
both impls must produce the same pubkey).

---

## T_INTENT_ATTEST (`0x30`) vectors

**Spec authority:** SPEC.md §5.17.

### Schema

```json
{
    "name": "string",
    "description": "string",
    "inputs": {
        "scope_id": "32-byte hex",
        "open_intent_ids": ["32-byte hex", ...],  // can be empty
        "observed_height": 850123,
        "timestamp": 1700000000,
        "snapshot_uri": "https://...",
        "worker_pubkey": "33-byte hex",
        "worker_privkey": "32-byte hex (signing input, NOT in envelope)"
    },
    "expected": {
        "sorted_intent_ids": ["32-byte hex", ...],     // canonical-sorted
        "intent_pool_hash": "32-byte hex (TODO: compute SHA256 of concat sorted_intent_ids)",
        "envelope_payload_bytes": "hex string (TODO: pin after first impl run)",
        "envelope_hash": "32-byte hex (TODO: SHA256 of payload bytes)",
        "worker_sig": "64-byte hex (TODO: BIP-340 over SHA256('tacit-intent-attest-v1' || preceding_fields))",
        "decision": "accept",
        "state_delta": {
            "attestation_chain_update": {
                "key": "(scope_id, worker_pubkey, observed_height)",
                "value": "{intent_pool_hash, timestamp, snapshot_uri}"
            }
        }
    }
}
```

### Coverage matrix

| # | Case | Expected decision |
|---|---|---|
| 01 | Empty pool (intent_count = 0) | accept; intent_pool_hash = SHA256("") |
| 02 | Single intent in pool | accept; hash = SHA256(intent_id) |
| 03 | Full pool (500+ intents) | accept; verify sort order discipline |
| 04 | Equivocation pair (same scope/worker/height, different hashes) | first: accept; second: reject + flag worker |
| 05 | Stale attestation (timestamp > 5min old at indexer time) | accept at chain layer; dapp surfaces "stale" |

### Computable now

- **Empty intent pool hash**:
  `SHA256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
  This is well-known and can be pinned in vector 01.

### Vector 01 (template — fill TODOs):

```json
{
    "name": "intent_attest_01_empty_pool",
    "description": "Worker attests to an empty intent pool (liveness signal, no intents in scope).",
    "inputs": {
        "scope_id": "0x4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d",
        "open_intent_ids": [],
        "observed_height": 850123,
        "timestamp": 1700000000,
        "snapshot_uri": "https://w1.tacit.dev/v1/snapshot/4d4d...",
        "worker_pubkey": "TODO_DERIVE_FROM_W1_PRIVKEY",
        "worker_privkey": "0xaabb00112233445566778899aabbccddeeff00112233445566778899aabbccdd"
    },
    "expected": {
        "sorted_intent_ids": [],
        "intent_pool_hash": "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "envelope_payload_bytes": "TODO_AFTER_FIRST_IMPL",
        "envelope_hash":          "TODO_SHA256_OF_PAYLOAD",
        "worker_sig":             "TODO_BIP340_OVER_CANONICAL_HASH",
        "decision":               "accept",
        "state_delta": {
            "attestation_chain_update": {
                "key":   "(0x4d4d...4d4d, TODO_W1_PUBKEY, 850123)",
                "value": {
                    "intent_pool_hash": "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                    "timestamp":        1700000000,
                    "snapshot_uri":     "https://w1.tacit.dev/v1/snapshot/4d4d..."
                }
            }
        }
    }
}
```

The first impl run produces the TODO values. Pin them. Both impls
must produce identical outputs going forward.

### Vector 04 (equivocation pair) — critical adversarial case

```json
{
    "name": "intent_attest_04_equivocation_pair",
    "description": "Worker signs two attestations at same (scope, height) with different intent_pool_hashes. First accepted; second flags worker.",
    "subvectors": [
        {
            "subname": "first",
            "inputs": {
                "scope_id": "0x...",
                "open_intent_ids": ["0xabc...", "0xdef..."],
                "observed_height": 850123,
                "worker_pubkey": "0xworker_W1_pub",
                ...
            },
            "expected": {
                "decision": "accept",
                "state_delta": { "attestation_chain": "first hash recorded" }
            }
        },
        {
            "subname": "second_inconsistent",
            "inputs": {
                "scope_id": "0x... (same)",
                "open_intent_ids": ["0xghi...", "0xjkl..."],
                "observed_height": 850123,
                "worker_pubkey": "0xworker_W1_pub (same)",
                ...
            },
            "expected": {
                "decision": "reject",
                "rejection_reason": "EQUIVOCATION_DETECTED",
                "state_delta": {
                    "equivocation_flags": { "added": "0xworker_W1_pub" }
                }
            }
        }
    ]
}
```

---

## T_SWAP_VAR (`0x32`) vectors

**Spec authority:** SPEC-SWAP-VAR-AMENDMENT.md.

### Schema

```json
{
    "name": "string",
    "inputs": {
        "pool_id":            "32-byte hex",
        "direction":          0,
        "R_A_pre":            50000000,
        "R_B_pre":            525000,
        "fee_bps":            30,
        "delta_in":           10000,
        "delta_in_min":       9000,
        "delta_in_max":       11000,
        "min_out":            104,
        "tip_amount":         32,
        "tip_asset":          0,
        "expiry_height":      850150,
        "trader_pubkey":      "33-byte hex (TODO_DERIVE)",
        "trader_privkey":     "32-byte hex (signing input)",
        "asset_input_outpoint": "{txid_BE, vout}",
        "amount_in":          12000,
        "r_in":               "32-byte hex (trader's existing input UTXO blinding)",
        "tip_r":              "32-byte hex (settler tip blinding)"
    },
    "expected": {
        "delta_out_computed": "TODO_FROM_CURVE_FORMULA",
        "r_change":           "TODO_FROM_HMAC(trader_privkey, 'tacit-amm-swap-var-change-v1' || pool_id || outpoint)",
        "r_receipt":          "TODO_FROM_HMAC(trader_privkey, 'tacit-amm-swap-var-receipt-v1' || pool_id || outpoint)",
        "C_change_secp":      "TODO: (amount_in - delta_in - tip_amount) · H + r_change · G",
        "C_receipt_secp":     "TODO: delta_out · H + r_receipt · G",
        "kernel_sig":         "TODO_BIP340_UNDER_(C_change - C_in + delta_in_total · H).x_only",
        "intent_sig":         "TODO_BIP340_OVER_INTENT_MSG",
        "envelope_payload_bytes": "TODO",
        "envelope_hash":          "TODO",
        "decision":               "accept",
        "state_delta": {
            "pool_reserves": {
                "R_A_post": "TODO: R_A_pre + delta_in",
                "R_B_post": "TODO: R_B_pre - delta_out_computed"
            },
            "consumed_outpoint": "asset_input_outpoint",
            "emitted_receipt":   "C_receipt_secp at vout[1]",
            "emitted_change":    "C_change_secp at vout[2]",
            "emitted_tip":       "tip_amount · H + tip_r · G at vout[3]"
        }
    }
}
```

### Coverage matrix

| # | Case | Expected decision |
|---|---|---|
| 01 | Self-broadcast, simple A→B swap, partial fill leaving change | accept |
| 02 | Relayed swap with settler tip | accept |
| 03 | Tick-fan K=4 (trader pre-signs 4 candidates) | accept; settler picks one tick |
| 04 | Whole-input consumed (no-change sentinel) | accept; vout[2] absent; C_change is 33×0x00 |
| 05 | Inflation attempt — trader sets C_receipt to delta_out + 1000000 instead of delta_out | reject; INFLATION_DETECTED via r_receipt opening mismatch |
| 06 | Stale reserves — R_A_pre / R_B_pre don't match running pool state | reject; STALE_RESERVES |
| 07 | min_out violation — curve gives delta_out < min_out | reject; SLIPPAGE_VIOLATION |
| 08 | Range bounds — delta_in > delta_in_max | reject; RANGE_VIOLATION |

### Computation rules for derived fields

**`delta_out_computed`**:
```
γ_num = 10000 - fee_bps  (u16, e.g. 9970 for fee_bps=30)
γ_den = 10000
num   = R_B_pre · γ_num · delta_in    // u256 arithmetic
den   = R_A_pre · γ_den + γ_num · delta_in
delta_out_computed = floor(num / den)
```

For vector 01 with R_A=50M, R_B=525k, fee_bps=30, delta_in=10000:
```
γ_num = 9970, γ_den = 10000
num   = 525000 · 9970 · 10000 = 52,342,500,000,000
den   = 50000000 · 10000 + 9970 · 10000 = 500,000,000,000 + 99,700,000 = 500,099,700,000
delta_out_computed = floor(52342500000000 / 500099700000) = floor(104.6638...) = 104
```

That's a computable derived value the engineer can pin in vector
01's `delta_out_computed` field.

**`r_change` and `r_receipt`** are HMAC-SHA256 outputs:
```
r_receipt = HMAC-SHA256(
    key   = trader_privkey,
    data  = "tacit-amm-swap-var-receipt-v1" || pool_id || txid_BE || vout_LE
) reduced mod n_secp
```
TODO: compute in first impl, pin here.

**`C_receipt_secp`** is a Pedersen commit on secp256k1:
```
C_receipt_secp = delta_out · H_secp + r_receipt · G_secp
```
Where `H_secp` is the NUMS-derived generator per SPEC.md §3.1
(`tacit-generator-H-v1` domain tag). Both impls compute the same
point; first run pins it.

**`kernel_sig`** is BIP-340 Schnorr over the kernel-msg hash:
```
kernel_msg = SHA256(
    "tacit-kernel-v1" ||
    asset_id_in(32) ||
    asset_input_count_LE(1) = 0x01 ||
    asset_input_outpoint(36) ||
    C_change_or_sentinel(33) ||
    delta_in_total_LE(8)  // = delta_in + tip_amount
)
kernel_sig = BIP340_sign(excess_scalar, kernel_msg)
```
where `excess_scalar = (r_change - r_in) mod n_secp` (or
`-r_in mod n_secp` in the whole-input sentinel case).

**`intent_sig`** is BIP-340 Schnorr over the intent-msg hash:
```
intent_msg = SHA256(
    "tacit-amm-swap-var-v1" ||
    pool_id || direction || delta_in || delta_in_min || delta_in_max ||
    delta_out || min_out || tip_amount || tip_asset || expiry_height ||
    trader_pubkey || asset_input_outpoint || receipt_scriptPubKey ||
    C_receipt_secp || C_change_or_sentinel
)
intent_sig = BIP340_sign(trader_privkey, intent_msg)
```

### Vector 05 (inflation attempt) — critical adversarial case

```json
{
    "name": "swap_var_05_inflation_attempt_rejection",
    "description": "Trader maliciously sets C_receipt to delta_out + 1M instead of delta_out, attempting to spend forged asset-B amount later. Indexer must reject via r_receipt opening check.",
    "inputs": {
        ...standard inputs...,
        "MALICIOUS_C_receipt_secp": "TODO: (delta_out + 1000000) · H + r_receipt · G",
        "note": "The trader signs intent_msg over this malicious C_receipt; indexer must catch the mismatch when verifying C_receipt = delta_out · H + r_receipt · G"
    },
    "expected": {
        "decision": "reject",
        "rejection_reason": "RECEIPT_BINDING_VIOLATION",
        "state_delta": null
    }
}
```

This vector is THE critical defense against the
session-discovered inflation attack. Both impls must reject.

---

## T_SWAP_BATCH (`0x2F`) vectors

**Spec authority:** AMM.md + SPEC.md §5.14-§5.16.

### Schema

```json
{
    "name": "string",
    "inputs": {
        "pool_id":  "32-byte hex",
        "n_intents": 2,
        "intents": [
            {
                "trader_pubkey": "33-byte hex",
                "trader_privkey": "32-byte hex (signing)",
                "direction": 0,
                "amount_in_swap": 1000,
                "min_out":         9,
                "tip_amount":      32,
                "tip_asset":       0,
                "expiry_height":   850150,
                "asset_input_outpoint": "{txid_BE, vout}",
                "r_in_secp":       "32-byte hex",
                "r_in_BJJ":        "32-byte hex (BabyJubJub scalar)"
            },
            ...
        ],
        "pool_state": {
            "R_A_pre": 50000000,
            "R_B_pre": 525000,
            "fee_bps": 30,
            "vk_cid":  "ipfs://bafy..."
        },
        "arbiter": null
    },
    "expected": {
        "clearing_solve": {
            "delta_A_net":  "TODO",
            "delta_B_net":  "TODO",
            "P_clear_num":  "TODO",
            "P_clear_den":  "TODO"
        },
        "per_intent_amount_out": [
            {"trader_pubkey": "...", "amount_out": "TODO_FROM_CURVE"},
            ...
        ],
        "groth16_proof":          "TODO_FROM_PROVER",
        "sigma_proofs_per_intent": ["TODO", ...],
        "sigma_proofs_per_receipt":["TODO", ...],
        "R_net_A":                 "TODO_AGGREGATE_BLINDINGS",
        "R_net_B":                 "TODO_AGGREGATE_BLINDINGS",
        "envelope_payload_bytes":  "TODO",
        "envelope_hash":           "TODO",
        "per_trader_sigs":         ["TODO_SIGHASH_ALL_OVER_ENVELOPE_HASH", ...],
        "decision":                "accept",
        "state_delta": {
            "pool_reserves": {
                "R_A_post": "TODO",
                "R_B_post": "TODO"
            },
            "consumed_outpoints": "[trader_intent_outpoints...]",
            "emitted_receipts":   "[per-trader receipt commits at vout[1..N]]",
            "emitted_tips":       "[asset-A tip aggregate, asset-B tip aggregate]"
        }
    }
}
```

### Coverage matrix

| # | Case | Expected decision |
|---|---|---|
| 01 | N=2 exact-cancel (A→B + B→A) | accept; Δ_net = 0 / 0; spot clearing |
| 02 | N=4 A-dominant batch (3 A→B, 1 B→A) | accept; non-trivial clearing-solve |
| 03 | N=8 mixed directions, multi-asset tips | accept; both tip aggregates non-zero |
| 04 | min_out violation — one trader's amount_out < min_out | reject; that trader excluded; settler must re-iterate |
| 05 | Arbiter qualifying set — pool with inclusion arbiter, qualifying mandatory intents | accept; verify arbiter_sig binding |

### Computation rules

**Clearing-solve** (per AMM.md §"4. Deterministic clearing-solve algorithm"):

```
SOLVE_CLEARING(X, Y, R_A, R_B, fee_bps):
    if X · R_B > Y · R_A: SOLVE_A_TO_B_DOMINANT(...)
    if X · R_B < Y · R_A: SOLVE_B_TO_A_DOMINANT(...)
    if X · R_B == Y · R_A: SPOT_CLEARING (Δ_net = 0)

SOLVE_A_TO_B_DOMINANT uses binary search to find Δa_net such that
Δa_net_implied(Δa_net) = Δa_net (fixed point); see AMM.md for
the full algorithm including the convergence + tie-break rules.
```

For vector 01 (exact-cancel N=2):
- X (sum of A→B amount_in) = 1000
- Y (sum of B→A amount_in) = 10 · 100 = 1000 (assuming price≈100)
- If X · R_B == Y · R_A precisely, spot clearing fires
- `P_clear_num = R_A_pre = 50000000`
- `P_clear_den = R_B_pre = 525000`
- `Δ_A_net = 0, Δ_B_net = 0`

**Groth16 proof generation** requires the per-trader openings,
public deltas, and pool reserves. TODO after impl. Engineer pins
the proof bytes in the vector after first generation.

**R_net_A and R_net_B** are aggregate trader blindings revealed
by the settler:
```
R_net_A = (Σᵢ r_in_secp,A,i − Σⱼ r_out_secp,A,j) mod n_secp
R_net_B = (Σᵢ r_in_secp,B,i − Σⱼ r_out_secp,B,j) mod n_secp
```
TODO from settler decryption of trader openings.

### Vector 01 (N=2 exact-cancel) detailed structure

```json
{
    "name": "swap_batch_01_n2_exact_cancel",
    "description": "Two traders match exactly at spot price; pool reserves unchanged.",
    "inputs": {
        "pool_id":  "TODO_DERIVE_SHA256(tacit-amm-pool-v1 || TAC || cBTC || fee_bps_LE(30) || capability_flags(0))",
        "n_intents": 2,
        "intents": [
            {
                "name":            "trader_A_buys_cBTC",
                "trader_privkey":  "0x1111...1111",
                "direction":       0,
                "amount_in_swap":  1000,
                "min_out":         9,
                ...
            },
            {
                "name":            "trader_B_sells_cBTC",
                "trader_privkey":  "0x2222...2222",
                "direction":       1,
                "amount_in_swap":  10,
                "min_out":         950,
                ...
            }
        ]
    },
    "expected": {
        "clearing_solve": {
            "delta_A_net":  0,
            "delta_B_net":  0,
            "P_clear_num":  50000000,
            "P_clear_den":  525000
        },
        "per_intent_amount_out": [
            {"trader_pubkey": "TODO_W1", "amount_out": "TODO_floor(1000 · 525000 / 50000000) = 10"},
            {"trader_pubkey": "TODO_W2", "amount_out": "TODO_floor(10 · 50000000 / 525000) = 952"}
        ],
        ...all other TODO fields...,
        "decision":     "accept",
        "state_delta": {
            "pool_reserves": {
                "R_A_post": 50000000,
                "R_B_post": 525000
            }
        }
    }
}
```

---

## LP-ops vectors (T_LP_ADD `0x2D`, T_LP_REMOVE `0x2E`)

**Spec authority:** AMM.md §"The six opcodes" + SPEC.md §5.14-§5.15.

### Coverage matrix

| # | Case | Expected decision |
|---|---|---|
| 01 | POOL_INIT with MINIMUM_LIQUIDITY lock | accept; pool registered; min_liq UTXO at vout[k_min_liq] |
| 02 | LP_ADD post-init, proportional shares mint | accept; S grows; reserves grow |
| 03 | LP_REMOVE proportional withdrawal | accept; S shrinks; reserves shrink |

### Schema (LP_ADD)

```json
{
    "name": "lp_add_02_post_init",
    "inputs": {
        "variant": 0,
        "pool_id":         "TODO_DERIVE",
        "lp_privkey":      "0x4444...",
        "delta_A":         1000000,
        "delta_B":         10500,
        "share_amount":    "TODO_floor(min(delta_A · S / R_A, delta_B · S / R_B))",
        "r_share":         "32-byte hex",
        "pool_state_pre": {
            "R_A": 50000000,
            "R_B": 525000,
            "S":   5126953
        }
    },
    "expected": {
        "share_amount_computed": "TODO: floor(min(1000000 · 5126953 / 50000000, 10500 · 5126953 / 525000)) = floor(min(102539, 102539)) = 102539",
        "kernel_sig_asset_A":    "TODO_BIP340_OVER_KERNEL_MSG_A",
        "kernel_sig_asset_B":    "TODO_BIP340_OVER_KERNEL_MSG_B",
        "groth16_proof":         "TODO",
        "decision":              "accept",
        "state_delta": {
            "pool_reserves": {
                "R_A_post": 51000000,
                "R_B_post": 535500,
                "S_post":   5229492
            },
            "emitted_lp_share_utxo": "share_amount=102539 at lp_privkey-derived address"
        }
    }
}
```

---

## T_PROTOCOL_FEE_CLAIM (`0x31`) vectors

**Spec authority:** AMM.md §"Protocol fee mechanism" + SPEC.md §5.18.

### Coverage matrix

| # | Case | Expected decision |
|---|---|---|
| 01 | Fee accrual after multiple swaps (no claim yet) | state-only check; no on-chain op |
| 02 | T_PROTOCOL_FEE_CLAIM with correctly-derived claim_amount | accept; lp_asset_id UTXO emitted at recipient |

### Schema (claim envelope)

```json
{
    "name": "protocol_fee_02_claim_post_accrual",
    "inputs": {
        "pool_id":           "TODO",
        "claimer_pubkey":    "TODO_FROM_POOL_PROTOCOL_FEE_ADDRESS",
        "claim_amount":      "TODO_COMPUTED_FROM_LAZY_MINTFEE",
        "claim_blinding":    "32-byte hex",
        "claim_sig":         "TODO_BIP340_OVER_CLAIM_MSG",
        "pool_state_pre": {
            "R_A": 60000000,
            "R_B": 700000,
            "S": 5300000,
            "k_last": "...",
            "protocol_fee_bps": 100,
            "protocol_fee_accrued": "TODO_LAZY_COMPUTE"
        }
    },
    "expected": {
        "lazy_mintFee_computation": "TODO_PER_AMM.MD_FORMULA",
        "decision": "accept",
        "state_delta": {
            "pool.protocol_fee_accrued": 0,
            "pool.k_last":              "set to current k",
            "pool.S":                   "incremented by new_shares (lazy mint)",
            "emitted_utxo":             "lp_asset_id share of claim_amount to claimer"
        }
    }
}
```

---

## T_TRADE_BATCH (`0x39`) vectors — for the deferred impl

**Spec authority:** SPEC-TRADE-BATCH-AMENDMENT.md.

These vectors exist as test infrastructure even though the impl
is deferred. When the impl lands later, vectors are ready.

### Coverage matrix

| # | Case | Expected decision |
|---|---|---|
| 01 | n_amm=2, n_ob=0 (AMM-only pass-through; should match standalone T_SWAP_BATCH) | accept; identical state delta to T_SWAP_BATCH |
| 02 | n_amm=0, n_ob=3 (orderbook-only pass-through; should match 3 independent T_AXFER_VAR) | accept; equivalent to 3 sequential T_AXFER_VAR |
| 03 | n_amm=2, n_ob=2 (mixed cross-surface) | accept; both surfaces settle atomically |
| 04 | Combined chain-aggregate violation — AMM sub-batch + orderbook sub-batch each locally valid but combined sum mismatched by 1 base unit | reject; CHAIN_AGGREGATE_VIOLATION |

Vector 04 is the critical defense for cross-surface conservation.

---

## Filling-in workflow (for engineers)

When the first reference impl produces real outputs:

1. Run the impl against each canonical input vector
2. Capture the derived values (hashes, sigs, proofs, byte strings)
3. Replace TODOs in the corresponding vector JSON file
4. Commit the pinned vectors
5. Subsequent runs of dapp + worker + indexer must produce these exact values
6. Add adversarial-case vectors (e.g., MALICIOUS_C_receipt_secp) by hand; verify both impls reject

**Once pinned**: the test vectors become the parity contract.
Any divergence between dapp + worker means somebody's code drifted
from the spec.

---

## Maintenance

- **Spec changes** → regenerate affected vectors. Document the
  reason in the vector file's `notes` field.
- **New opcode** → add a new directory under `tests/vectors/`,
  follow the same schema.
- **Adversarial case discovered post-launch** → add a new
  numbered vector demonstrating the attack + the indexer's
  rejection.

---

End of test vector schema. Engineers: pick an opcode, write the
builder, compare outputs to other impl, pin the derived values.
Adversarial vectors are non-negotiable (especially `swap_var_05`
inflation defense and `trade_batch_04` cross-aggregate defense).
