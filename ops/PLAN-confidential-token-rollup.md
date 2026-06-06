# PLAN — Confidential Token (Tacit on Ethereum)

Arbitrary-amount confidential balances on secp256k1 Bitcoin-native notes. It
**ships as a shielded pool** (Phase 1, per-op validity proofs — Railgun/Tornado-
Nova shape), **scales into a batched rollup** (Phase 2, many ops per proof →
sub-cent), and **unifies cross-chain** (Phase 3, one balance fluid across Bitcoin
and Ethereum). Every Phase-1/2 choice here is made to **tee up Phase 3** at
near-zero added cost (§11).

This is the parity-true amount model (same notes and same Bulletproofs+ as
Bitcoin Tacit CXFER); it supersedes the Tier-A denominated transfer for the
arbitrary-amount path. Cross-chain layer: [`PLAN-confidential-cross-chain.md`].
Note format and primitives:
[`SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT.md`](../spec/amendments/SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT.md),
`SPEC-RANGE-PROOF-PRIMITIVE.md`, `SPEC-BLINDED-PUBKEY-AMENDMENT.md`.

---

## 1. Thesis

Every confidential ERC-20 in production is built on BN254/Grumpkin — curves
Bitcoin cannot speak. Tacit's notes are **secp256k1**, so a confidential balance
is the *same cryptographic object* on Bitcoin and Ethereum: one seed, one note,
one range proof, both chains. Arbitrary EVM amounts make that literally true, and
Bitcoin Tacit is already live (1500+ wallets), so this is the Ethereum surface of
an existing network, not a standalone me-too pool.

What the user sees stays simple: *send any amount, privately, on Ethereum, with
the wallet they already use on Bitcoin.*

## 2. Why off-chain validation (the constraint that shapes everything)

Arbitrary amounts remove the cheap on-chain path. With fixed denominations `v·H`
was a precomputed constant; for arbitrary `v`, even "this note commits to `v`"
needs `v·H`, and secp256k1 scalar multiplication on the EVM is ~750k gas (no
precompile); a Bulletproofs+ verify is far worse. So all secp validation moves
into the **SP1 guest** (secp is a cheap precompile there — the bridge already
uses it), and the chain holds value, verifies one proof, tracks roots.

**No new trusted setup.** SP1's on-chain verifier is universal — it verifies any
program against its `vkey` (a public input), pinned to the immutable Groth16 leaf
(not the upgradeable gateway), exactly as the tETH bridge does. A new guest needs
no ceremony.

## 3. Note model (shared with the Bitcoin layer)

- `C = v·H + r·G` on secp256k1, `v ∈ [0, 2^64)`, `H` the NUMS generator
  `"tacit-generator-H-v1"` (identical to Bitcoin).
- `leaf = keccak(asset_id, Cx, Cy, owner)` — the leaf hashing matches the
  Bitcoin-side note commitment scheme so a unified tree is natural later (§11).
- `nullifier = keccak(note_secret)` — **chain-independent by construction** (no
  chainid/contract in the nullifier). One note → one nullifier on every chain, so
  a single global set catches cross-chain double-spend (§11). Replay is prevented
  in the *spend proof*, which binds chainid + contract, not in the nullifier.
- `owner` = an Ethereum address or a stealth pubkey commit (`P + b·G`), `b` from
  the HMAC derivation that scans both chains.
- Notes are deterministically derived (`(secret_i, r_i) = HMAC(seed, …)`), so a
  wallet recovers its balance from the seed alone plus a chain scan.

## 4. State model

- **Commitment tree** — incremental Merkle tree of note leaves, **Keccak**,
  depth 32 (~4.3B notes), permanent root history.
- **Nullifier set** — spent markers.

Phase 1 keeps both **on-chain** (Keccak makes the incremental Merkle cheap, and a
plain `mapping` for nullifiers): the guest *validates* notes and emits leaves +
nullifiers; the contract *maintains* the tree and the nullifier map. This keeps
the Phase-1 guest small. Phase 2 moves both **in-guest** — the tree and an
**indexed-Merkle** nullifier accumulator, only roots on-chain — to amortize under
batching. That Phase-2 nullifier accumulator is, by design, the structure that
becomes the **global** (Bitcoin + Ethereum) set in Phase 3 (§11).

## 5. Operations (guest validates; contract maintains tree + escrow)

- **`wrap` (deposit).** On-chain: escrow `v` of the ERC-20, record a pending
  deposit `(asset_id, v, C)`. Guest: verify `C` opens to public `v`, emit the
  leaf; contract inserts it. Amount public only at the boundary.
- **`transfer` (confidential core).** `n`-in / `m`-out, hidden amounts. Guest
  verifies input membership against a known root, the conservation kernel per
  `asset_id`, an aggregated Bulletproofs+ range proof on every output, freshness,
  and emits revealed nullifiers + output leaves + the public `fee`. Contract
  marks nullifiers, inserts leaves, pays the fee.
- **`unwrap` (withdraw).** Guest verifies a note opens to public `v`, emits its
  nullifier + `(recipient, asset_id, v)`; contract pays from escrow. Recipient
  and amount are proof-bound.
- **`mint` / `burn` (etched supply).** Public-amount supply ops with a PoK
  binding the commitment; supply public and exact, allocation hidden; fair-launch
  (`petch`) gating lives here.

Conservation is **per `asset_id`** in-guest, so one contract holds many assets
under a single anonymity set — and the same per-asset conservation later admits
confidential cross-asset swaps.

## 6. On-chain surface

A single contract per generation, immutable and ownerless:

- Per-asset escrow + an asset registry (`asset_id → {kind, underlying,
  UNIT_SCALE, name, symbol, decimals, cross_chain_link}`; §11).
- The Keccak commitment tree (root + history) and nullifier map (Phase 1).
- A pending-deposit accumulator for wraps.
- `settle(proof, publicValues)`: verify against the pinned immutable SP1 Groth16
  leaf with the committed `vkey`; check the referenced root ∈ history; reject
  already-spent nullifiers and mark the new ones; insert emitted leaves; pull
  deposits / pay withdrawals + fees from escrow.

**Permissionless settlement.** A validity proof is trustless regardless of who
produced it, so anyone may submit a (batch of) op(s) for a fee; no privileged
sequencer; a user can always self-prove a batch of one.

Structural invariants: per asset `escrow ≥ Σ unspent note value` (wrap is the
only mint path, every transition conserves, withdrawals are proof-bound); no
double-spend (nullifier check); no inflation (conservation + range in-guest).

## 7. Proving — shielded pool → rollup

The guest is one program (its own `vkey`, no ceremony) validating one or more ops
against a referenced root. **Batch size is the only dial.** Size 1 is Phase 1
(per-op proofs, simplest, ~300–470k/op on-chain). Larger batches amortize the
single proof verification toward sub-cent/tx (Phase 2). Range proofs are
aggregated (`bpRangeAggProve`/`Verify`, reused unchanged). The guest shares
crates with the tETH bridge guest (secp, accumulators, Bitcoin-state verification
— §11), and one prover deployment serves both.

## 8. Data availability and recovery

- Phase 1: note memos + nullifiers in **calldata** — permanent and recoverable
  from any archive, simplest for an MVP.
- Phase 2: **EIP-4844 blobs** for cost, paired with the existing IPFS-pin /
  indexer infra (`mirror-pins.sh`) as the durable archive so cheap DA does not
  cost recoverability.
- Wallets reconstruct from seed-derived notes plus a scan, verified against the
  on-chain root; the indexer is a convenience, direct reconstruction the fallback.

## 9. Finality — instant for the parties, settled on the proof

A note is a bearer secret, so the **recipient verifies the sender's Bulletproofs+
proof client-side the moment they receive it off-chain** — cryptographic
certainty of payment before any batch settles. On-chain settlement (advancing the
root) is what enables onward-spend to third parties and unwrap, and follows on
the next proof cycle. Batching latency therefore applies to onward-spend/exit,
not to "did I get paid."

## 10. Trust and liveness

Immutable SP1 Groth16 leaf (no owner-upgradeable path); permissionless proving +
self-prove fallback; blob DA on L1; deposits honored only past sufficient
confirmations (the bridge's reorg discipline); roots advance monotonically.

## 11. Phase-3 forward-compatibility (the tee-ups)

Phase 3 (cross-chain shared set, [`PLAN-confidential-cross-chain.md`]) needs a
global nullifier set, cross-chain-recognizable notes/assets, and a guest that can
consume Bitcoin state. We make Phase 1/2 tee these up at near-zero cost:

1. **Chain-independent nullifier** (`keccak(note_secret)`, §3) — the same note
   yields the same nullifier on both chains, so the global set is a union, no
   remapping. Replay protection lives in the chain-bound spend proof.
2. **Bitcoin-compatible leaf hashing** (§3) — eases the unified deposit tree (the
   "indistinguishable origin" platinum form).
3. **Phase-2 nullifier accumulator = indexed-Merkle, designed as the global
   set.** In Phase 3 it is fed by both chains, with **Ethereum L1 as the ordering
   anchor** and Bitcoin deferring (Bitcoin Tacit is off-chain-validated).
4. **Guest shares crates with the tETH bridge guest** (secp, accumulators,
   Bitcoin-state verification) — Phase 3's "consume the Bitcoin spend
   accumulator" is then a small delta, not a new guest.
5. **Versioned, extensible public-values layout** — Phase 3 appends cross-chain
   accumulator roots + exposed mint-nullifiers in the tail without breaking the
   layout.
6. **Asset registry carries a cross-chain link** (`cross_chain_link`) — a
   confidential asset (e.g. tETH) is recognized as the same asset on both chains;
   the tETH bridge already binds the two ids.
7. **Deploy under the multi-generation framework** (as tETH gen-1) — Phase 3 is
   simply generation-N, not a disruptive redeploy; nothing else needs pre-wiring.

None of these complicate Phase 1; they are format and structural choices made
once, now.

## 12. Relationship to existing work

- **Reused:** the SP1 verifier deployment + canonical-ELF discipline + secp
  precompiles + deposit-accumulator + reorg gating (bridge); aggregated secp
  Bulletproofs+ (`dapp/bulletproofs-plus.js`, unchanged); the stealth
  construction; deterministic note derivation; the factory / on-chain
  `name`·`symbol`·`decimals` / `asset_id` work from the Tier-A contracts.
- **Replaced for arbitrary amounts:** the Tier-A denominated note, the OR-proof,
  the on-chain `transfer`, the denomination ladder. Tier-A may remain as an
  optional instant/prover-free/quantized mode, but the arbitrary-amount product
  is this.

## 13. User experience

One seed scans and spends on both chains; send any amount privately with instant
recipient assurance; balance recovers from the seed; fees are a fraction of a
cent at batch scale and the user never sees a "batch"; wrap any ERC-20 in, unwrap
to any address.

## 14. Phasing

1. **Phase 1 — shielded pool.** Per-op proofs, arbitrary hidden amounts, on-chain
   Keccak tree + nullifier map, guest reusing the bridge stack, immutable Groth16
   root, self-prove + worker relayer. The headline ships here.
2. **Phase 2 — batched rollup.** In-guest tree + indexed-Merkle nullifier
   accumulator, many ops per proof, permissionless proving, blob DA → sub-cent.
3. **Phase 3 — cross-chain shared set.** Global nullifier set via the tETH rail;
   confidential tETH as flagship; then the indistinguishable-origin reach.

Same architecture throughout; batch size and the cross-chain accumulator are the
only things that change.

## 15. Settled decisions

- **Tree / nullifiers:** Phase 1 on-chain Keccak incremental Merkle (depth 32) +
  on-chain nullifier mapping (guest validates, contract maintains); Phase 2 moves
  both in-guest, nullifiers as an indexed-Merkle accumulator (also the future
  global set, §11).
- **Hash:** Keccak everywhere (SP1 precompile in-guest, native on-chain compare +
  JS, no secp field-alignment friction; Poseidon's circuit edge is moot in a
  zkVM).
- **Assets:** single multi-asset contract from the start (`asset_id` in notes,
  per-asset escrow + conservation); a small launch allowlist is the dial.
- **DA:** calldata Phase 1 → blobs + IPFS mirror Phase 2.
- **Fees:** public `fee` term in the kernel, paid **in-asset** to the settler
  (paying gas in ETH from one's own address would deanonymize the transfer —
  the relayer lesson); wrap/unwrap are public boundary ops, user self-pays ETH
  gas. Phase 1 worker relayer + self-prove; Phase 2 permissionless settler market.
- **BP+:** reuse the canonical secp verifier (`secp.rs`) compiled into the guest
  with SP1's k256 precompiles — not a fresh crate — so the guest accepts
  byte-identical proofs to Bitcoin.
- **Nullifier derivation:** chain-independent (§11.1); chain/contract binding in
  the proof.

## 16. Phase-1 build scope

**Contract** (`ConfidentialPool`, single multi-asset):
- Storage: `assetRegistry[asset_id]`, per-asset `escrow`, `commitmentRoot` +
  `knownRoot[]`, `nullifierSpent[]`, `pendingDeposits`.
- `registerWrapped(underlying, unitScale, name, symbol, decimals) → asset_id`;
  etched assets register via the existing factory path.
- `wrap(asset_id, amount, C)` — pull ERC-20, append pending deposit.
- `settle(proof, pv)` — the one verification entrypoint; `pv` carries
  `{version, spendRoot, opType, nullifiers[], newLeaves[], withdrawals[],
  depositsConsumed, perAssetFee[]}`. Verify proof vs pinned SP1 leaf + committed
  `vkey`; `spendRoot ∈ knownRoot`; nullifiers unseen → mark; insert `newLeaves`
  (Keccak incremental Merkle) → new `commitmentRoot` → `knownRoot`; pay
  withdrawals + fees; consume deposits.
- Events carry leaves + encrypted memos + nullifiers (calldata DA).

**Guest** (SP1, shares crates with the bridge guest):
- Inputs: op witness (notes, blindings, membership paths, BP+ proof, kernel).
- Verifies: input membership (Keccak path → `spendRoot`), per-asset conservation
  kernel, aggregated BP+ ranges on outputs, `wrap` open-to-`v`, output freshness.
- Commits the `pv` struct above (versioned tail for Phase-3 fields, §11.5).

**Prover module** (`dapp/`): build wrap/transfer/unwrap/mint/burn witnesses +
aggregated BP+ from the seed-derived notes; reuse `bulletproofs-plus.js`.

**Test plan:** real-proof Forge suite (KAT note/leaf/nullifier vectors generated
by the prover, asserted against in-contract Keccak tree insertion); end-to-end
deposit→transfer→withdraw with a real SP1 proof on a local node; rejection tests
(bad range, broken conservation, reused nullifier, unknown root, tampered
recipient/fee); a multi-asset transfer; gas measurement per op.

**Build status (2026-06-06):** `contracts/src/ConfidentialPool.sol` landed +
`test/ConfidentialPool.t.sol` (15 tests, mock SP1 verifier) green — the on-chain
state machine (escrow, Keccak depth-32 incremental Merkle, nullifier set, pending
deposits, withdrawals + in-asset settler fees, version/chain-binding gating) is
verified independent of the proof system. Guest scaffold at
`contracts/sp1/confidential/` (`main.rs` validation flow + ABI `PublicValues`
matching the contract; `secp.rs` interface). Remaining for a real proof: factor
the bridge `secp.rs` into a shared crate, port the aggregated secp Bulletproofs+
verifier + the conservation kernel, the dapp prover-witness builder, and the
real-proof gate — all needing the SP1 toolchain.

## 17. Open decisions (Phase-1 fine-tuning, not blocking)

- Membership-path width vs tree depth perf in-guest (Keccak cycles).
- `pendingDeposits` as a list vs a running accumulator hash.
- Whether `mint`/`burn` ride `settle` or keep thin dedicated entrypoints.
- Worker relayer fee-quoting + self-prove UX in the dapp.
