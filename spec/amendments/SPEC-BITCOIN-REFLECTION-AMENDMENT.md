# SPEC Amendment — Bitcoin Confidential-Pool Reflection (the cross-lane relay prover)

> **STATUS: DRAFT** (2026-06-08). Defines the **reflection prover**: an SP1 guest
> that proves the Bitcoin confidential pool's state — its note set and its spent
> set — onto Ethereum as `ConfidentialPool.BitcoinRelayPublicValues`
> `(bitcoinPoolRoot, bitcoinSpentRoot, bitcoinHeight)`, the sole authority behind
> the improved-platinum cross-lane gate (`attestBitcoinStateProven`,
> `BITCOIN_RELAY_VKEY`). No trusted oracle: the proof is the authority.
>
> Companion to:
> - `SPEC-CXFER-BPP-AMENDMENT.md` (§5.47, `T_CXFER_BPP` `0x22`) — the confidential-
>   transfer envelope this reflects.
> - `SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT.md` — the EVM pool whose cross-lane gate
>   consumes the reflected roots.
> - `ops/PLAN-confidential-cross-chain.md` §9 — improved (asymmetric) platinum: the
>   reflection prover is a trustless **data** relay, not a capital relayer.
> - `cxfer-core` — the verification toolkit this guest composes (built + tested):
>   `verify_tx_in_block`, `verify_header_chain`, `ReflectionState`
>   (`KeccakTreeAccumulator` + `ImtAccumulator`), `verify_range`, `verify_kernel`,
>   `extract_taproot_envelope`.

## 1. What the reflection prover proves

For a confirmed Bitcoin height `H`, the guest commits exactly:

```
BitcoinRelayPublicValues {
    bytes32 bitcoinPoolRoot;   // root of the reflected note-commitment tree at H
    bytes32 bitcoinSpentRoot;  // root of the reflected spent-nullifier IMT at H (NEVER 0)
    uint64  bitcoinHeight;     // the confirmed height proven up to
}
```

`attestBitcoinStateProven` verifies it against `BITCOIN_RELAY_VKEY`, marks
`bitcoinPoolRoot` canonical (a `bridge_mint` may prove membership against it), and
advances `knownBitcoinSpentRoot`. The cross-lane gate then forces every Bitcoin-homed
Ethereum spend to prove non-membership against this exact spent root. `bitcoinSpentRoot`
is **never zero** — an empty spent set is the non-zero empty-IMT sentinel
(`imt_empty_root`), so the gate is never vacuous.

## 2. The model impedance (the load-bearing design point)

The two surfaces represent a confidential note differently:

| | Bitcoin (`T_CXFER_BPP`) | Ethereum (`ConfidentialPool`) |
|---|---|---|
| note identity | a pool **UTXO** referenced by `(txid, vout)`; its commitment `C = v·H + γ·G` is the output's 33-byte point | a **leaf** `keccak(asset ‖ Cx ‖ Cy ‖ owner)` in the commitment tree |
| spend | consume the input UTXO (it disappears from the UTXO set) | reveal the nullifier `keccak(Cx ‖ Cy ‖ "spent")`, marked in the nullifier set |
| conservation | kernel: `(Σ out) − (Σ in) = excess·G`, `kernel_sig` | in-guest `verify_kernel` + `verify_range` |

So a cross-chain-fluid note must have one identity both surfaces agree is spent. The
**chain-independent nullifier** `ν = keccak(Cx ‖ Cy ‖ "spent")` is that identity (spec
B3): it is a pure function of the commitment, identical on both chains. The reflection
prover's job is to translate **Bitcoin UTXO consumption** into the **same ν** the EVM
gate checks.

## 3. The reflection mapping

Scanning the Bitcoin chain from the previously-proven state, for each accepted
`T_CXFER_BPP` (`0x22`) / `T_CXFER` (`0x23`) / `OP_ENV_CONF_BURN` (`0x2B`) envelope:

- **Outputs → reflected note leaves.** Each output commitment `C_out = (Cx, Cy)` becomes
  a note; append `leaf = keccak(asset ‖ Cx ‖ Cy ‖ owner)` to the note tree
  (`KeccakTreeAccumulator`). *(Open: the Bitcoin output carries `commitment(33) ‖
  amount_ct(8)` but no explicit `owner` word; §7.1 reconciles the leaf derivation so the
  Bitcoin leaf and the EVM leaf of the same note are byte-identical.)*
- **Inputs → cross-lane nullifiers.** Each consumed input `(input_txid, input_vout)`
  resolves (via the reflected UTXO set, §4) to its output commitment `C_in = (Cx, Cy)`;
  insert `ν = keccak(Cx ‖ Cy ‖ "spent")` into the spent IMT (`ImtAccumulator`). This is
  the same ν the EVM `settle` reveals when that note is spent on Ethereum, so the gate
  serializes the note across both lanes.
- **`OP_ENV_CONF_BURN` (cross-out).** A Bitcoin note burned *for Ethereum* (the
  `bridge_mint` source) is an input consumption like any other — its ν enters the spent
  set; the Ethereum mint is gated separately by `claimId`-once.

The committed roots are `ReflectionState::commit()` after folding every envelope up to
`H` in canonical (block height, tx index) order.

## 4. The guest algorithm

```
state = ReflectionState (resumed from the previously-proven anchor, or genesis)
for each block in (anchor_height, H]:           # contiguous, no gaps
    verify_header_chain links it to the relay-anchored tip, PoW each      # §cxfer-core
    for each tx in the block (ALL of them, via the header's merkle root): # completeness
        if extract_taproot_envelope(tx) is a pool envelope:
            verify_range(outputs) && verify_kernel(in, out, …)            # validity
            resolve each input (txid:vout) → C_in against the UTXO set
            state.apply_block(out_leaves, in_nullifiers, height)
commit BitcoinRelayPublicValues = state.commit()
```

- **Confirmation depth.** `H` is buried ≥ `K` confirmations: the header chain proven by
  `verify_header_chain` extends `K` blocks past `H` (or the anchor tip is itself
  relay-attested past `K`).
- **Resumption.** The guest seeds `ReflectionState` from the prior proof's roots +
  the UTXO set digest, processes only `(anchor_height, H]`, and re-commits — `height`
  strictly increases (`attestBitcoinStateProven`'s monotonic guard).

## 5. Completeness + soundness

Two invariants make the reflected roots safe to mint against on Ethereum:

- **No spend omitted.** The guest verifies each block's **full** txid set against the
  header's merkle root (`verify_tx_in_block` / `compute_merkle_root`), then inspects
  **every** tx — it cannot silently drop a pool spend. Omitting a spend would let a
  Bitcoin-spent note pass the Ethereum non-membership gate; processing the complete
  block prevents it.
- **No unbacked value reflected.** The guest re-runs `verify_kernel` + `verify_range`
  on each transfer, so a non-conserving Bitcoin op can never enter the reflected note
  tree. (A `bridge_mint` proves membership + conservation against `bitcoinPoolRoot`; if
  the reflected tree could contain value created from nothing, the mint would be
  unbacked. The in-reflection kernel/range check closes that.)

The spent root only ever **advances** (inserts, never removes), matching the monotonic
height guard.

## 6. Envelopes

The reflection prover **binds to existing envelopes**; it adds no new spend opcode:

- `T_CXFER_BPP` (`0x22`) / `T_CXFER` (`0x23`) — the confidential transfer (§5.47 / §5.2).
  Inputs `(txid, vout)`, outputs `commitment(33) ‖ amount_ct(8)`, `kernel_sig`, BP+/BP
  rangeproof. Reflected per §3.
- `OP_ENV_CONF_BURN` (`0x2B`) — the cross-chain burn (`asset ‖ bitcoin_pool_root ‖
  nullifier ‖ dest_commitment`), already verified by the `bridge_mint` guest; its ν
  enters the spent set.
- **Deposits** (new notes with public backing) enter via the existing Bitcoin wrap /
  etch path; their output commitments are reflected as note leaves like any output.

## 7. Open decisions

1. **Leaf derivation reconciliation.** The EVM leaf is `keccak(asset ‖ Cx ‖ Cy ‖ owner)`;
   the Bitcoin output is `commitment(33) ‖ amount_ct(8)` with the recipient identified by
   the blinded-pubkey dust marker, not an envelope `owner` word. Either (a) derive the
   reflected leaf's `owner` from the dust-marker commitment (so a note's Bitcoin leaf ==
   its EVM leaf), or (b) define a reflection-specific leaf that the `bridge_mint`/EVM
   membership uses for Bitcoin-homed notes. (a) is required for true same-note-both-
   surfaces; (b) is a simpler interim.
2. **UTXO-set witness + its completeness.** Resolving an input `(txid, vout) → C_in`
   needs the reflected UTXO set. Carry it as part of the resumed state (a committed
   accumulator over unspent output commitments), updated each block (add outputs, remove
   consumed inputs) — and prove that update complete, or the input→ν mapping can be
   gamed. This is the heaviest remaining sub-design.
3. **Confirmation depth `K`** per the finality gate, and the deep-reorg posture
   (accept-and-document, as tETH/AMM, vs an explicit unwind).
4. **Deposit backing.** A Bitcoin deposit's value backing (BTC lock / etch) is enforced
   by the Bitcoin validators; whether the reflection prover must re-verify it in-guest
   (vs. trusting the validators for the deposit leg, as the EVM pool trusts on-chain
   escrow) is the cross-chain analogue of the EVM escrow check.

## 8. Built vs. remaining

**Built + tested** (`cxfer-core`, 21 native tests): the full in-zkVM verification
toolkit — `ReflectionState` (note-tree + spent-set accumulators) committing
`BitcoinRelayPublicValues`, per-event `verify_tx_in_block`, header-chain linkage
`verify_header_chain`, plus the reused `verify_range` / `verify_kernel` /
`extract_taproot_envelope`. The contract gate, the relay submission toolkit
(`attestBitcoinStateProven`), and the non-zero spent-root invariant are live.

**Remaining:** the §7.1 leaf reconciliation + §7.2 UTXO-set witness (the keystone
sub-design), the guest binary wiring §4 over the built toolkit, full-block-scan envelope
recognition, and the box `cargo prove` → `BITCOIN_RELAY_VKEY`. Cross-lane stays gated
(`BITCOIN_RELAY_VKEY = 0`) until those close and the spent set is reflected from genesis.
