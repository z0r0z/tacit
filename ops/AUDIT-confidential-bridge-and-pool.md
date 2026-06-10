# Review scope — Tacit confidential bridge + Ethereum shielded pool

> **For the reviewing agent — context + task.** Tacit is an open-source, publicly deployed
> confidential-transaction protocol. It gives on-chain assets the standard *confidentiality* and
> *unlinkability* properties formalized in the zero-knowledge literature and shipped by widely used
> systems — Zcash (shielded pools), Aztec, Monero (Bulletproofs), and the confidential-transactions
> line of work. Owners always retain sole control of their own funds; "privacy" here means amounts
> and the sender↔note association are hidden from third-party observers via Pedersen commitments +
> zero-knowledge membership proofs, exactly the primitives in those peer-reviewed systems.
>
> **Your task is a code-correctness / soundness review of this developer's own open-source code.**
> The properties to verify are *safety* properties — no token inflation, no double-spend, value
> conservation, proof↔verifying-key coherence, escrow solvency. This is defensive security
> engineering: surfacing and fixing soundness bugs so the protocol cannot mint value from nothing
> or lose user funds. It is ordinary cryptographic-protocol review, the same work done on any
> open-source L1/L2, and the right thing to do thoroughly. Nothing here asks you to attack a live
> third-party system or evade anyone's controls; it asks you to verify a public protocol is sound.

Orientation for a reviewer getting up to speed on the confidential cross-chain system: the
Ethereum shielded pool (`ConfidentialPool`), the Bitcoin↔Ethereum bridge, and the proving
topology that ties them together. Read top-to-bottom once, then use the file map as an index.

## The concept in one screen

Tacit is a confidential UTXO protocol spanning **Bitcoin** and **Ethereum**. The same note object
— a secp256k1 Pedersen commitment `C = v·H + r·G` with a note-bound nullifier
`keccak(Cx|Cy|'spent')` — is the unit of value on both chains. What differs per chain is *how a
spend is proven valid*, because the chains have different verification models:

- **Bitcoin** has no on-chain SNARK verifier → validity is **client-side validated**, and proofs
  are **browser-provable**: a fixed-denomination shielded pool (the "mixer" — a Zcash-style
  Poseidon-Merkle anonymity set, Groth16), the AMM (Groth16 + BabyJubJub, arbitrary amounts), and
  **CXFER** (Bulletproofs+ over secp, arbitrary amounts, no ceremony). CXFER is the Bitcoin
  confidential-transfer pool.
- **Ethereum** has an on-chain Groth16 verifier → validity is **proven on-chain** by an **SP1
  zkVM guest** (secp Pedersen notes in a keccak Merkle tree, arbitrary amounts, no per-circuit
  ceremony). This is `ConfidentialPool` — the Ethereum peer of CXFER plus swap/LP and the bridge.
- **The seam** is the **reflection prover**: an SP1 program that proves confirmed Bitcoin
  confidential-pool state (pool root / spent-set / burn-set) and attests it on Ethereum, so the
  Ethereum guest can gate cross-chain spends with no trusted oracle.

SP1 proving is heavy (a GPU box, not a browser), so it lives where on-chain verification is
required (Ethereum) or where Bitcoin state must reach Ethereum (reflection) — not as a Bitcoin
replacement. The Bitcoin circuits stay because they are client-provable.

Asset lifecycle the system supports: deposit ETH/ERC20 → shielded note → transfer / swap / LP;
a Tacit asset has a deterministic public ERC20 face (canonical factory) that wraps back into the
pool; and each shielded asset can bridge to a Bitcoin Tacit tokenization (`tETH` first).

## Deployment state (public, on-chain)

| | Address / value |
|---|---|
| **Ethereum shielded pool (Sepolia)** `ConfidentialPool` | `0x445031c4ee0CdcBDb8c92a6CBBB4639D20cC75A9` |
| SP1 Groth16 verifier (own immutable leaf) | `0x6F9a1D26e398295129bd523748b7fC7e3d801d68` (`VERIFIER_HASH` selector `0x4388a21c`) |
| settle `PROGRAM_VKEY` (pin of record) | `0x00d0fb85d51de5b0743bce2161dcfca3d36f5ce67eb00b8dda0fe7a999939eeb` — opening-sigma swap/LP guest. Live Sepolia pool above still runs the pre-opening-sigma `0x00cc4e72…`; redeploy at the pin is pending (a deploy op) |
| settle ELF sha256 / bytes | `4a64dd59…d3f265c3` / 502512 |
| reflection `BITCOIN_RELAY_VKEY` (pin of record) | `0x0050d656e9d421d5c75724e17dff0ba83e44813691101b75a96ff42d4aa41d49` — relay-anchor model (F1/F2/F3 closed + proven; F4 full-scan built in source/JS/fixture, GPU re-prove pending → will replace this vkey). 0 on the live deploy = Ethereum-only |
| reflection ELF sha256 / bytes | `eca4fe9c…596c32065` / 339632 |
| first asset `cETH` (native ETH, `address(0)`) | assetId `0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2` |
| **tETH bridge (mainnet, live)** mixer | `0x6929acf0…` · verifier `0x19CC65a1` (pinned to immutable Groth16 leaf `0xb69f2584`) · relay `0x45AA7939` · burn-vfy `0x031b22ba` · vkey `0x003e5d74` · asset `0x3cba71e1` |

The vkey/ELF pin of record is `contracts/sp1/confidential/elf-vkey-pin.json`. The deployed vkey
must equal the committed ELF's vkey; the `*ProofReal` tests verify a real Groth16 of that ELF.

## File map

### Ethereum contracts — `contracts/src/`
| File | Role |
|---|---|
| `ConfidentialPool.sol` | The shielded pool: escrow, note tree + nullifiers + inlined note primitives, `settle` (consumes a proof + applies leaves/nullifiers/withdrawals/swaps/liquidity), wrap/unwrap (incl. native ETH `address(0)`), `bridge_mint`/`bridge_burn`, `initPool` + swap/LP reserve state, `attestBitcoinStateProven` (reflection). **Start here.** |
| `CanonicalAssetFactory.sol` | Deterministic public ERC20 from `assetId` (CREATE2 + fixed initcode). |
| `CanonicalBridgedERC20.sol` | The canonical ERC20 the pool mints/burns. |
| `TacitBridgeMixer.sol` | The tETH bridge mixer (Ethereum side of ETH↔Bitcoin). |
| `script/DeployConfidentialPool.s.sol` | Deploy (vkey + verifier + factory wiring). |

### SP1 guest — `contracts/sp1/confidential/`
| File | Role |
|---|---|
| `src/main.rs` | The settle guest: `OP_WRAP/TRANSFER/UNWRAP/BRIDGE_BURN/BRIDGE_MINT/ATTEST_META/SWAP/LP_ADD/LP_REMOVE`. The load-bearing in-guest validity checks live here. **Start here for proving logic.** |
| `src/reflect.rs` | The reflection prover (Bitcoin header PoW + tx inclusion + envelope binding → `BitcoinReflectionPublicValues`). |
| `cxfer-core/src/lib.rs` | Shared crypto: `verify_pedersen_opening`, nullifier, keccak Merkle, IMT non-membership, `pool_id`/`lp_share_id`. |
| `cxfer-core/src/{bitcoin,bjj,sigma}.rs` | Bitcoin header/tx verify; BabyJubJub; secp↔BJJ sigma binding. |
| `elf-vkey-pin.json` | Binds both committed ELFs ↔ their vkeys + sha256s. |
| `elf/{cxfer-guest,reflection-prover}` | Committed canonical ELFs (the bytes the box must run). |
| `exec-{swap,lp,prove,crosslane,reflect-prove,bridgemint}.rs` | Box harnesses: feed a fixture witness → execute (cycles) or Groth16-prove. |
| `verify-vkey-pin.sh`, `readiness-gate.sh` | Pin + readiness guards. |

### Dapp (client assemblers + crypto) — `dapp/`
| File | Role |
|---|---|
| `confidential-pool.js` | Note/leaf/nullifier/Merkle-tree/`commitXY` primitives (the JS mirror of the guest). |
| `confidential-transfer.js` / `confidential-swap.js` / `confidential-lp.js` | Op assemblers — build the witness + a verify function mirroring every guest assert. |
| `confidential-relay.js` | Settle-relay client (`submitOp` / `waitForSettle`). |
| `confidential-indexer.js`, `confidential-reflection-scan-indexer.js` | Seed-only recovery from on-chain events; the scan indexer assembles the full-scan reflection batch (`confidential-reflection-indexer.js` is the superseded witnessed-model oracle). |
| `bulletproofs-plus.js` | CXFER range proofs (the Bitcoin confidential pool). |
| `circuits/withdraw.circom` | The Bitcoin mixer circuit (Groth16/Poseidon, fixed-denomination). |

### Worker (relay backends) — `worker/src/`
| File | Role |
|---|---|
| `confidential-settle.js` | Settle job queue (submit/claim/ack/status; FIFO claim + dedup). |
| `reflection-attest.js` | Reflection relay (assemble Bitcoin-state batch / ack cursor). |
| `index.js` | Routes: `/confidential/{submit,job,ack,status}`, `/reflection/{job,ack}`. |

### Box loops — `ops/scripts/`
`confidential-settle-loop.sh` (claim → Groth16 → `settle` → ack) · `reflection-relay-loop.sh`
(prove Bitcoin state → `attestBitcoinStateProven` → ack). Both poll the worker (outbound-only).

### Tests (the verification surface)
- **Forge** `contracts/test/`: `ConfidentialPool.t.sol` + `…Invariant`/`…Fuzz`/`…KAT`/`…Swap`
  (state machine), `Confidential{Proof,SwapProof,LpProof,CrossLaneProof,ReflectionProof}Real.t.sol`
  (real Groth16 verified on-chain through the genuine SP1 verifier), `ConfidentialTacWalkthrough`,
  `BridgeWithdrawRealProof` + `TacitBridgeMixer` (tETH).
- **Node** `tests/`: `confidential-{transfer-roundtrip,swap-op,lp-op,settle,relay,…}.mjs` (op
  round-trips that mirror the guest), `bulletproofs-plus-*.test.mjs` (CXFER ranges).

### Specs + runbooks
`spec/SPEC-CONFIDENTIAL-POOL.md` (the pool spec; §7.1 = normative in-guest validity bindings
B1–B6) · amendments `SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT.md`, `SPEC-CXFER-BPP-AMENDMENT.md`,
`SPEC-BITCOIN-REFLECTION-AMENDMENT.md`, `SPEC-TETH-BRIDGE-AMENDMENT.md` (the live tETH bridge is a
**hybrid**: Groth16 deposit/burn proofs over a Poseidon tree *plus* an SP1 pool-root state proof
+ accepted-burn registry — the spec's "Live implementation" section reconciles both) ·
`ops/RUNBOOK-confidential-pool-deploy.md` (deploy + relay activation), `…-readiness.md`,
`ops/STATUS-confidential-system.md` · `ops/reviews/AUDIT-teth-bridge-mainnet-2026-06-03.md`.

## What to verify — soundness checklist

A sound audit must hit every item below. They are ordered by blast radius. **Key framing:** the
contract sees only hashes (commitments, nullifiers, roots), so it can enforce escrow,
nullifier-uniqueness, and reserve pre-gates — but the value/amount/membership logic that prevents
inflation lives in the **SP1 guest** (`src/main.rs`) and the **vkey/ELF pin**. So the guest +
pin carry the load; treat any property the contract "can't see" as guest-critical. For each item,
confirm the property actually holds at the cited spot — don't assume from the comment.

### A. Value conservation / no token inflation — [fund-critical]
- **Opening soundness, every op.** Each cleartext amount is bound to its note commitment by
  `verify_pedersen_opening` (`cxfer-core/src/lib.rs`); the typed-`u64` amount + the opening together
  are the range check. Confirm the `u128` products in each op (`main.rs`) cannot overflow the
  equality asserts, and that an unopened/forged amount is rejected.
- **`OP_WRAP` / `OP_UNWRAP`** — `value·unitScale == amount`; `unitScale` is bound via `deposit_id`
  on wrap and re-checked by the contract on unwrap (SPEC §7.1 B1/B2).
- **`OP_TRANSFER`** — Mimblewimble kernel: Σ inputs = Σ outputs via the BIP-340 kernel signature.
- **`OP_SWAP`** — constant-product non-decrease (`k_post ≥ k_pre`), the net reserve delta equals
  the net of the openings, and `min_out` holds.
- **`OP_LP_ADD` / `OP_LP_REMOVE`** — in-ratio add (`dA·R_B == dB·R_A`), proportional
  shares/withdrawal floored *toward the pool*, openings bind `dA`/`dB`/`dShares`.
- **`OP_BRIDGE_MINT`** — minted value is bound to a proven Bitcoin burn and cannot exceed it.
- **No-inflation invariant + escrow solvency** — `#spent ≤ #leaves` (the reserve floor), and
  `escrow[asset]` ≥ all outstanding redeemable value across notes + pool reserves. Trace
  wrap/unwrap/withdraw/`initPool`/`settle` to confirm escrow only moves with conserved value.

### B. Double-spend / nullifier integrity — [fund-critical]
- Note-bound nullifier `keccak(Cx|Cy|'spent')` is the **same derivation** in guest, dapp, and
  worker (SPEC §7.1 B3) — a mismatch silently breaks the cross-lane gate.
- Contract consumes each ν once; `settle` rejects a repeated ν.
- **Cross-lane non-membership is mandatory and fail-closed** (SPEC §7.1 B4): any spend against a
  Bitcoin root proves ν ∉ the reflected Bitcoin spent-set; the empty/zero spent-root path must
  **not** bypass the check (confirm the non-zero IMT sentinel → fail-closed).
- `bridge_mint` dedups against a **dedicated** `bitcoinBurnRoot` (not the general spent set); a
  burned ν is pushed into the nullifier set so a fastlane→burn→mint sequence can't double-spend.

### C. Proof ↔ verifying-key ↔ ELF coherence — [fund-critical]
- Deployed `PROGRAM_VKEY` equals the committed `elf/cxfer-guest` vkey; `BITCOIN_RELAY_VKEY` equals
  the committed `elf/reflection-prover` vkey (`elf-vkey-pin.json`; check with `verify-vkey-pin.sh`).
- The `*ProofReal.t.sol` tests verify a **real** Groth16 of those exact ELFs on-chain at those
  vkeys — confirm they aren't mocked and the fixture vkey matches the pin.
- ELF-drift: the prover box must run the committed bytes (host `include_bytes!`), never a rebuild.
- `chainBinding == keccak(chainid ‖ pool)` + the PV version gate prevent cross-chain /
  cross-contract / version replay.

### D. Membership & Merkle integrity
- `keccak_merkle_verify` against a valid root; `spend_root != 0` required; tree-depth bound; leaf
  insertion monotonic (`firstLeafIndex`). Confirm a spend can't prove against an attacker-chosen
  or stale root (check the accepted-root window).
- IMT non-membership soundness (low-key ordering + sentinel) for the Bitcoin spent/burn sets.

### E. Cross-chain reflection soundness — `src/reflect.rs`
- Header chain: PoW + retarget + genesis anchor, **every** block (no omission).
- Tx inclusion (`verify_tx_in_block`) + envelope parse (`extract_taproot_envelope` strips the TACIT
  frame — a historical silent-drop bug) + commitment binding.
- Digest chain: `priorDigest == knownReflectionDigest`, `newDigest` strictly advances, height
  monotonic guard; and the consumer reads the **right** reflected root (pool vs spent vs burn).

### F. Bridge custody — `TacitBridgeMixer.sol` + `contracts/sp1/{program,tree}`
- SP1 pool-root state proof proves the pool root from **complete** Bitcoin blocks
  (Groth16-of-every-envelope → no leaf omission/forgery).
- Accepted-burn registry: withdraw only against an SP1-proven burn; claim-ID binding
  `ν‖denom‖poolRoot‖recipient‖bindHash`; burns survive later state advancement.
- Mint-only capacity reserve bounds deposits not yet proven (pool-tree exhaustion); withdrawals
  ≤ total deposits (no drain); decimal/wei scaling correct.

### G. Contract state machine & escrow — `ConfidentialPool.sol`
- `settle`: pre-gates (swap/LP reserve pre == live; ν-unspent; root valid) then applies the post
  state atomically.
- Native ETH: `address(0)` sentinel; payable `wrap` escrows exactly `msg.value`;
  `forceSafeTransferETH` payout; `receive()` rejects stray ETH; `initPool` ETH legs;
  `nonReentrant` + effects-before-external-send ordering.
- Registration: cross-chain links established **only** via guest-proven `attest_meta`
  (`_autoRegisterFromMeta`); `registerWrapped`/`registerMinted` are local-only; `unitScale`
  derivation; pool-minted assets require `decimals == ETH_DECIMALS`.

### H. Client ↔ guest parity
- Each JS assembler's `verify*` mirrors **every** guest assert (the `tests/confidential-*-op.mjs`
  round-trips). A gap means the client and guest disagree on what's valid — diff the field order +
  every assertion across contract ↔ `main.rs` ↔ `confidential-*.js`.

### I. Relay trust surface
- The worker never proves and never holds funds — it queues + relays a proof the contract
  independently verifies; submit is permissionless (a bad witness simply fails to prove).
- Idempotency on lost ack: a re-served job's re-submit reverts (ν spent) and is acked failed — no
  double-apply. Box-only routes are Bearer-gated (liveness, not fund-soundness).

## How to audit (method + output)
1. **Per op, trace value in vs value out** in `main.rs`; list what the contract cannot see (only
   hashes) and confirm the guest enforces each such property.
2. **Cross-read the three faces** of every op — contract (`ConfidentialPool.sol`) ↔ guest
   (`main.rs`) ↔ client (`confidential-*.js`); they must agree on field order and every assertion.
3. **Run the suites, then hunt coverage gaps** — an op or a reject-branch with no negative test is
   a finding in itself.
4. **Output:** findings with severity (**fund-critical / soundness / liveness**), each citing
   `file:line`, the property that breaks, and a minimal reproducing test (forge or node) where
   feasible — a failing regression test is the deliverable, not prose.

```
cd contracts && forge test --match-path "test/Confidential*.t.sol"    # state + real-proof suite
forge test --match-path "test/{TacitBridgeMixer,BridgeWithdrawRealProof,BridgeIntegration}.t.sol"
node tests/confidential-swap-op.mjs && node tests/confidential-lp-op.mjs \
  && node tests/confidential-transfer-roundtrip.mjs && node tests/confidential-settle.mjs
node tests/confidential-bridge-mint.mjs && node tests/confidential-bridge-burn.mjs \
  && node tests/confidential-reflection-state.mjs
bash contracts/sp1/confidential/verify-vkey-pin.sh                    # committed ELF ↔ pin
bash contracts/sp1/confidential/readiness-gate.sh                     # tiered go/no-go
```

## Status / follow-ups (neutral)
- Ethereum-native pool (send/swap/LP, public-ERC20 ↔ shield, native ETH) is deployed on Sepolia
  and proven on-chain. Cross-chain (bridge/export, reflection-gated) is built and proven but the
  **reflection + settle relays are not yet running** — cross-chain is interim-trusted until they are.
- Not yet built: dapp UI for the pool; POOL_INIT for Bitcoin-origin pools; cross-chain unified LP
  UX; settle idempotency pre-check (nullifier-spent → re-ack vs lost ack); shared cross-chain
  anonymity set (OR-membership against the reflected Bitcoin root) — a deliberate follow-up.
