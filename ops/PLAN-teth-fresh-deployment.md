# tETH — fresh deployment plan

Design and sequencing for a clean redeploy of the tETH bridge (contracts +
proving system), bundling the improvements accumulated since the current live
deployment. The live instance holds a small pilot balance, so a fresh
deployment is cheaper than carrying the changes piecemeal.

Architecture chosen: **Option A — per-generation immutable mixers** (no owner,
no upgrade pointer, nothing to govern). The "one canonical tETH, never migrate
escrow" goal that would otherwise argue for a rotatable verifier is instead met
at the **accounting layer** (§2): the dapp and worker recognize every immutable
generation — prior, this one, and future — as a single tETH and route each
escrow-touching operation to the generation that backs it.

## Current live deployment (generation 0)

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
per-pool verifier mapping are set at construction (`poolVerifiers[pid]` is
written only in the constructor). A new proving program means a new vkey, which
the immutable verifier cannot accept — so each generation is a fresh mixer +
verifier + relay. Generation 0 stays deployed and fully redeemable forever.

---

## 1. Architecture decision (settled: Option A)

Per-generation immutable mixers. Each future proving-program change is a new
generation (new mixer + verifier + relay), never an in-place upgrade. This keeps
the strongest property of the current design: no admin, no pause, no rotation —
nothing any party can use to move funds. The cost (no in-place upgrades, asset
identity could fragment per generation) is absorbed by the accounting layer in
§2, so generations stay invisible to the user.

Generation 0 keeps backing exactly the units it minted, payable only through its
own `withdrawFromBurn`, indefinitely.

---

## 2. Multi-generation accounting — one tETH across immutable generations

The core idea. tETH stays a single asset (`3cba71e1…`) across every generation.
Each generation is an independent, self-solvent mixer: its escrow equals the
tETH it minted, enforced by its own guest. A note or UTXO is redeemable only
against the generation whose guest state contains it — so **state membership is
both the routing key and the solvency guarantee**. The dapp and worker present
one unified tETH and route each escrow-touching op to its home generation.

### Why it's safe by construction (no shared escrow, no trust)
- A redeem/burn carries a merkle membership proof against a *specific*
  generation's pool tree; the burn binds that mixer's address, and the
  generation's guest validates membership in *its* tree. A unit minted by
  generation *k* produces a valid burn only against generation *k*.
- A wallet tETH UTXO can be imported only into the generation whose `utxo_set`
  contains it — i.e. the generation that exported it. Another generation's guest
  does not have it and declines the import (the pre-import gate already routes
  here).
- Therefore each generation pays out only the units it minted → self-solvent →
  globally solvent (Σ tETH supply = Σ per-generation escrow, automatically).
- Mis-routing by the client cannot lose funds: the wrong generation's guest
  simply produces no valid proof, and the pre-burn / pre-import gates catch it
  before broadcast. Routing is a UX convenience that fails safe.

### Generation registry
`TETH_DEPLOYMENTS[network]` becomes an ordered list of generations
`{ mixer, verifier, relay, genesisBlock, deployBlock, open }`, all sharing
`assetId = 3cba71e1…`. The last `open: true` entry is the current deposit
target; older entries are redeem-only.

### Routing rules (the only escrow-touching ops)
| Operation | Routes to |
|---|---|
| Deposit (mint) | the latest `open` generation |
| Redeem / burn a pool note | the generation whose pool tree holds the note's leaf |
| Import a wallet tETH UTXO | the generation whose `utxo_set` holds it (= the generation that exported it) |

Pool notes are already partitioned by mixer in client storage
(`_BRIDGE_TETH_NOTES_KEY` keys on `network:mixerAddress`), so a note's home
generation is known. For a wallet UTXO, the import's source export binds the
mixer address — the pre-import gate decodes that export already; extend it to
read the bound mixer and route the import to that generation.

### Unified everywhere else
Balance display sums pool notes + wallet tETH across all generations into one
number. Transfers / CXFER / AMM / orderbook operate on the single `asset_id`;
they move the Bitcoin asset and never touch escrow, so tETH is fully fungible
for trading — no liquidity fragmentation. Escrow only matters at deposit,
import, and burn, where the routing table applies. Supply attestation for
`3cba71e1…` sums per-generation minted = sum of per-generation escrow.

### Lifecycle
Opening a new generation = append to the registry, set the prior generation to
redeem-only (`open: false`), point deposits at the new one. No escrow move, no
asset change, no migration. Old generations remain redeemable forever; their
prover is run on demand and is permissionless, so redemption never depends on us
keeping a box up.

### Generation legitimacy (the security boundary)
Because every generation mints the *same* asset, the unified supply is only as
sound as the weakest generation the client honours: a generation running a
malicious guest could mint unbacked tETH and circulate it as the real asset. So
the set of recognized generations is the security boundary — it cannot be a
curated address list, it must be verifiable from chain. A generation is
legitimate only when all of these hold:

1. `ASSET_ID == 3cba71e1…` — the tETH etch, whose `mint_authority` is all-zero
   (verified on chain: etch `8c31974d…`), so a canonical bridge pool is the only
   path that can create tETH at all.
2. The verifier is **immutable and ownerless** — no admin, pause, or pointer
   that could swap the guest after deployment.
3. The verifier's `PROGRAM_VKEY` is in the **blessed ELF-vkey set** — the
   canonical, ceremony-committed ELFs, one entry per generation, published and
   pinned the same way the single ELF is pinned today (`elf-vkey-pin.json`).
4. The verifier's `BURN_VERIFIER` is the canonical Groth16 ceremony key.
5. The verifier is bound to a real proof-of-work Bitcoin relay.

This extends the existing canonical-pool gate up to the SP1 layer. Today
`isPoolCanonical` already refuses any pool whose Groth16 `vk_cid` /
`ceremony_cid` isn't the canonical trusted setup (a fake setup could otherwise
forge withdrawals and inflate the asset); the client validator credits a
generation's tETH only when its verifier additionally passes the five checks
above, and ignores it otherwise — exactly as it ignores non-canonical pools
today. The only thing the maintainer publishes is the blessed-vkey set;
everything else is read from chain, so a generation outside the set is not
honoured no matter who deployed it. Keeping the set as a pinned client constant
(like the current `CANONICAL_VK_CID`) preserves Option A's no-governance
property — there is no on-chain owner or registry to capture.

---

## 3. Worker changes (generation dimension)

The worker currently keys pool / leaf / nullifier records by
`(network, asset_id, denom)`. With one `asset_id` across generations, two
generations' pools for the same denom would collide (first-confirmed-wins).

- Key pool records by `(network, verifier_or_mixer, asset_id, denom)`. `POOL_INIT`
  carries the generation's verifier/mixer; the worker derives the key from it.
- `/pools` returns the generation per pool; the client iterates all generations
  in `scanPools` and merges.
- Supply / attestation endpoints sum across generations for the asset.

This is the one structural worker change; everything else is registry plumbing.

---

## 4. Guest (ELF) changes

All in `contracts/sp1/program/src/`. Each is a vkey-changing edit, so they ship
together in the generation-1 ELF.

### 4.1 Per-pool root window across cycles (LOCK-4)
The guest seeds `known_pool_roots[i]` each non-genesis cycle with only the
resumed root (`main.rs` non-genesis branch, ~115–120). A redeem binds the pool
root the client observed; if a deposit to the same pool is proven in an earlier
cycle, the bound root is no longer seeded that cycle.
- Persist a K-deep per-pool root window in committed `ProverState` and seed
  `known_pool_roots[i]` from it (K ≈ 32, mirroring the in-cycle ring).
- The client's pre-burn check can then relax to window membership, so redeems of
  already-proven notes no longer wait on unrelated pending deposits.
- `ProverState` gains `pool_recent_roots`; the verifier's committed state head
  carries the window hash.

### 4.2 Backlog-aware deposit gate (LOCK-2)
Make the deposit-capacity gate aware of in-flight mint backlog rather than
instantaneous occupancy, so the existing `POOL_TREE_RESERVE` headroom (already
enforced for mint/rotate/import, `main.rs:374`) accounts for queued deposits
before any higher-volume pool is un-gated.

### 4.3 Denomination-bound nullifier (LOCK-3)
Bind `denom` into the pool `nullifierHash` derivation so a preimage can't be
reused across denominations. The shipped client already derives per-denom; this
closes it for any third-party client.

### 4.4 Inclusion-proof guards (QUAL-1)
Add the 64-byte BIP141 reject and an explicit merkle-depth bound to the on-chain
tx-inclusion path (parity hardening; the SP1-accepted-burn registry remains the
authorization root).

### 4.5 Asset-global spent-nullifier set (TRUST-1, optional)
Optionally move cross-denom nullifier uniqueness to an on-chain asset-global set,
reducing committed guest state. Evaluate cost vs. benefit; not required for
correctness.

*(Out of scope: the import prevTxid byte-order issue was a client bug, already
fixed — the guest is correct. F-2 mint-only reserve already ships in the
generation-0 ELF. No reconcile op: under Option A, generation 0 is immutable and
does not inherit state, so its one stranded pilot unit is an accepted write-off.)*

---

## 5. Contract changes

- **`SP1PoolRootVerifier.sol`** — unchanged logic; new constructor args
  (fresh genesis anchor, the generation-1 vkey, the root-window state head).
- **`TacitBridgeMixer.sol`** — unchanged; fresh deploy bound to the new verifier.
- **`BitcoinLightRelay.sol`** — fresh genesis anchor at a retarget-safe block;
  unchanged logic.

No vault, no pointer, no timelock — that was Option B.

---

## 6. Asset identity & solvency invariant

- **Same `asset_id`** (`3cba71e1…`) for generation 1 and all later generations.
  Each generation's `ASSET_ID` immutable equals it; minting is per-generation and
  backed by that generation's escrow.
- **Per-generation invariant (on-chain):** `totalBalance ≥ Σ unspent pool
  denominations`; the no-inflation rule (#spent ≤ #leaves) holds per generation.
- **Global:** Σ supply = Σ per-generation escrow, by construction, since each
  generation mints 1:1 and pays only its own notes.

---

## 7. Migration

Minimal under Option A + §2 accounting:
1. Deploy generation 1 (contracts + ELF); verify on chain + Etherscan.
2. Append generation 1 to the registry as `open: true`; set generation 0 to
   redeem-only.
3. The client now recognizes both: new deposits → gen 1, redeems → home gen.
4. Generation 0's recoverable pilot units redeem normally against it; its one
   stranded unit is a write-off (no state inheritance to reconcile it).

No escrow move, no rollover, no asset re-etch.

---

## 8. Verification (gate before mainnet)

- Full signet round-trip on generation 1: deposit → mint → export → import →
  redeem, exercising the §4.1 window behaviour.
- Cross-generation signet test: a deposit on gen 1 and a redeem on gen 0 in the
  same client, confirming the routing table and merged balance.
- Re-run the real-proof suites + ceremony vkey pin + ELF pin
  (`.github/workflows/bridge-guards.yml`); confirm the committed ELF sha256
  matches `elf-vkey-pin.json` and the prover box runs the committed canonical ELF.

---

## 9. Sequencing

1. Worker: add the generation dimension (§3) behind the existing single-gen
   behaviour; deploy; verify gen-0 still indexes unchanged.
2. Client: generation registry + routing table + merged balance (§2); gen-0-only
   while gen 1 doesn't exist yet, so a no-op until step 4.
3. Author §4 guest + §5 contract changes on a branch; unit + real-proof tests
   green; signet deploy + §8 round-trip.
4. Mainnet deploy generation 1; append to the registry; flip deposits over.

## Open decisions

- Confirmed: same `asset_id` reuse across generations is sound — tETH's etch
  `mint_authority` is all-zero, so the bridge is the only supply path and there
  is no rogue-mint route. (The family-aggregation variant of §2 is the fallback
  only if a future generation ever needs a different etch.)
- Where the blessed ELF-vkey set lives: pinned client constant (recommended —
  no governance, mirrors `CANONICAL_VK_CID`) vs. an on-chain registry (adds a
  curation surface that Option A is specifically avoiding).
- Whether to include §4.5 (TRUST-1) now or defer.
- Generation key in the worker: mixer address vs. verifier address (verifier is
  the proving-program identity; mixer is the escrow identity — likely verifier).
