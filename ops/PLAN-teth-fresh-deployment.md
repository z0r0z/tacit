# tETH — fresh deployment plan

Design and sequencing for a clean redeploy of the tETH bridge (contracts +
proving system), bundling the improvements accumulated since the current live
deployment. The live instance holds a small pilot balance, so a fresh
deployment is cheaper than carrying the changes piecemeal.

## Current live deployment (generation to supersede)

| Component | Address / value |
|---|---|
| Mixer | `0x6929acf0a8dDe761Bf16A54B61473e89124FECbf` |
| Verifier (`SP1PoolRootVerifier`) | `0x19CC65a1B4e3C9516Cc648182bdeb1116A7cA701` |
| Relay (`BitcoinLightRelay`) | `0x45AA793952A710E61D456deAcA13E29d8E5c0951` |
| Burn Groth16 verifier | `0x031b22ba…` |
| Program vkey | `0x003e5d74…` |
| Genesis BTC anchor | block 952127 |
| tETH `asset_id` | `3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34` |

The mixer is immutable and ownerless: `BURN_VERIFIER`, `ASSET_ID`, and the
per-pool verifier mapping are all set at construction (`TacitBridgeMixer.sol`
constructor; `poolVerifiers[pid]` is written only there). A new proving program
means a new vkey, which the immutable verifier cannot accept, so a new verifier
and a new mixer are required — there is no in-place upgrade. This plan decides
whether that stays true for every future change or only once more.

---

## 1. Architecture decision (settle first)

Two shapes for the new deployment. Everything else is the same regardless; this
is the fork that determines whether future proving-program changes need another
full migration.

### Option A — keep the per-generation immutable model
Each future ELF change = new verifier + new mixer + migration, as today.
- **Pro:** zero added trust surface; custody and proving are both immutable.
- **Con:** every guest change repeats the migration, and the tETH `asset_id`
  fragments per generation unless explicitly rolled over.

### Option B — vault + rotatable verifier (recommended)
Separate custody from verification:
- **`TacitBridgeVault`** (immutable, ownerless) holds the ETH and exposes
  `withdrawFromBurn`, exactly as the mixer does today.
- The vault references a **`verifier` pointer** that can be rotated, but only
  through a **timelock** and only to a verifier whose `PROGRAM_VKEY` matches a
  **ceremony-committed vkey**. Custody itself stays immutable; a rotation can
  stall service but cannot move funds, and the timelock gives holders an exit
  window before any rotation takes effect.

```solidity
// sketch
address public verifier;                 // current proving program
bytes32 public immutable VKEY_REGISTRY;  // ceremony-committed next-vkey root
uint256 public immutable ROTATE_DELAY;   // timelock
// queueVerifier(addr) checks IVerifier(addr).PROGRAM_VKEY ∈ VKEY_REGISTRY,
// records eta = now + ROTATE_DELAY; activate() flips `verifier` after eta.
// No path mutates balances or recipients.
```

With Option B, future items in §2 become **hot verifier swaps** — same vault,
same escrow, same canonical `asset_id`, no migration. Paired with
state-inheriting genesis (§4), existing notes carry forward on each swap.

**Trade-off to weigh:** Option B introduces a bounded governance surface (a
timelocked, vkey-pinned verifier pointer) that Option A does not have. Given a
guest change otherwise forces a full migration each time, Option B trades a
narrow, exit-able pointer for never migrating escrow again.

---

## 2. Guest (ELF) changes

All in `contracts/sp1/program/src/`. Each is a vkey-changing edit, so they ship
together in the new ELF (Option A) or as the first rotation (Option B).

### 2.1 Per-pool root window across cycles (LOCK-4)
Today the guest seeds `known_pool_roots[i]` each non-genesis cycle with only the
resumed root (`main.rs` non-genesis branch, ~line 115–120), growing it with
in-cycle appends. A burn/redeem binds the pool root the client observed; if a
deposit to the same pool is proven in an earlier cycle, the bound root is no
longer seeded and the redeem is not recognized in that cycle.

- **Change:** persist a K-deep per-pool root window in committed `ProverState`
  and seed `known_pool_roots[i]` from it at cycle start (mirror the existing
  recent-roots ring already used within a cycle; K ≈ 32).
- **Knock-on:** the client's pre-burn equality check can relax to
  *prefix/window membership*, so redeems of already-proven notes no longer wait
  on unrelated pending deposits.
- **State/verifier:** `ProverState` gains `pool_recent_roots: Vec<Vec<[u8;32]>>`;
  the verifier's committed state head carries the window hash.

### 2.2 Backlog-aware deposit gate (LOCK-2)
Before any higher-volume pool is un-gated, make the deposit-capacity gate aware
of the in-flight mint backlog rather than instantaneous tree occupancy, so the
`POOL_TREE_RESERVE` headroom (already enforced for mint/rotate/import,
`main.rs:374` etc.) accounts for queued deposits.

### 2.3 Denomination-bound nullifier (LOCK-3)
Bind `denom` into the pool `nullifierHash` derivation so the same preimage can
never be reused across denominations. The shipped client already derives keys
per-denom; this closes it at the protocol level for any third-party client.

### 2.4 Inclusion-proof guards (QUAL-1)
Add the 64-byte BIP141 reject and an explicit merkle-depth bound to the
on-chain tx-inclusion path (parity hardening; the SP1-accepted-burn registry,
not the inclusion proof, remains the authorization root).

### 2.5 Asset-global spent-nullifier set (TRUST-1, optional)
Optionally move cross-denom nullifier uniqueness from the guest's in-state set
to an on-chain asset-global set, reducing what the guest must carry in committed
state. Evaluate cost vs. benefit; not required for correctness.

### 2.6 Reconcile operation (recovery)
Add a guest op that re-credits a provably-stranded unit — a note whose source
UTXO and nullifier history are on chain but which no current object represents.
Used once during migration to recover orphaned pilot units; gated so it can only
re-credit against verifiable on-chain history, not mint freely.

*(Not in scope: the import prevTxid byte-order issue was a client bug, already
fixed; the guest is correct there. F-2 mint-only reserve is already in the live
ELF.)*

---

## 3. Contract changes

- **`SP1PoolRootVerifier.sol`** — unchanged validation logic. If Option B, the
  constructor takes the committed vkey registry root; if state-inheriting
  genesis (§4), the constructor accepts a non-empty `genesisPoolsHash` /
  `ProvenState` instead of the all-zero `currentState.poolsHash`
  (`SP1PoolRootVerifier.sol:123`).
- **Vault (Option B)** — new `TacitBridgeVault` with the timelocked, vkey-pinned
  verifier pointer (§1). Reuses the existing `withdrawFromBurn` flow verbatim.
- **`BitcoinLightRelay.sol`** — redeployed with a fresh genesis anchor at the
  retarget-safe block (see relay retarget cadence notes); unchanged logic.

---

## 4. State continuity & asset identity

- **State-inheriting genesis:** initialize the new verifier's `currentState` to
  the prior verifier's final `ProvenState` (poolsHash, nullifierSetHash, height,
  anchor) and have the new ELF resume from the prior frontiers (the non-genesis
  branch already reconstructs trees from frontiers). Existing pool notes remain
  valid leaves — no re-import.
- **`asset_id`:** with the vault + state inheritance, keep the **same canonical
  `asset_id`** (`3cba71e1…`) across the generation. Without them (Option A),
  the established pattern is a fresh supply-0 asset and an explicit rollover.

---

## 5. Migration & recovery

The current mixer is immutable; ETH leaves only via its own `withdrawFromBurn`.
So escrow moves to the new custody only through real redeems:

1. Stop new deposits on the current deployment (client `live:false`).
2. Stand up the new custody + verifier + relay; open deposits there.
3. Keep the current prover available until the current pool drains; the client
   routes redeems of current-generation notes to the current mixer.
4. Roll the small pilot balance over (designated-recipient redeem into the new
   custody), and run the §2.6 reconcile op once to recover the orphaned unit.

With Option B this is the **last** escrow move; subsequent proving changes are
verifier rotations with no migration.

---

## 6. Verification (gate before mainnet)

- Full signet round-trip on the new ELF + contracts: deposit → mint → export →
  import → redeem, including the §2.1 window behaviour and the §2.6 reconcile op.
- Re-run the real-proof suites + ceremony vkey pin + ELF pin
  (`.github/workflows/bridge-guards.yml`).
- Confirm the committed ELF sha256 matches `elf-vkey-pin.json` and the prover
  box runs the committed canonical ELF (host `include_bytes!`), never a native
  rebuild.

---

## 7. Sequencing

1. **Decide §1** (Option A vs B). Everything downstream depends on it.
2. Author the §2 guest changes + §3 contract changes on a branch; unit + real-
   proof tests green.
3. Signet deploy + §6 round-trip, including reconcile.
4. Mainnet deploy (fresh genesis anchor), verify on chain + Etherscan.
5. Execute §5 migration; recover the orphaned unit; flip the client over.

## Open decisions

- Option A vs Option B (and if B, the `ROTATE_DELAY` length and who holds the
  rotation key / how the vkey registry is committed).
- Same `asset_id` vs fresh supply-0 asset.
- Whether to include §2.5 (TRUST-1) now or defer.
