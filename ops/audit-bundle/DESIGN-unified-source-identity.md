# Design — unified source identity (burn_id) and cross-asset inflation resistance

This describes how a bridged / cross-lane value's **source identity** is derived and bound so that a burn on one
lane authorizes exactly one mint on the other, and cannot be substituted by a cheaper same-shaped note. It is
accurate to `cxfer-core/src/lib.rs`; verify against the code.

## Why the bare commitment is not enough

A note's Pedersen commitment `C = v·H + r·G` is asset-blind — the asset lives in the leaf, not the point. The
bare-commitment nullifier `ν = keccak(Cx‖Cy)` therefore **collides** across notes that share a commitment but
differ in asset or key. Such a collision is constructible for any note whose opening is public (for example a
`T_SWAP_VAR` receipt, whose value and blinding are revealed by the fold). If a bridge burn were keyed only by
`ν`, a burn of a cheap same-commitment clone could authorize a mint against a dear-asset note — a cross-asset
inflation. This is the class of defect the source-identity model closes (the bundle-7 F1 fix).

## burn_id: the source-specific burn identity

Bridge burns are keyed by a **source-specific `burn_id`**, not by `ν`
(`bridge_burn_id`, domain `"tacit-bridge-burn-source-v1"`):

```
burn_id = keccak( "tacit-bridge-burn-source-v1"
                ‖ source_kind        // 1 byte
                ‖ spent_txid         // 32 bytes  (the exact spent Bitcoin outpoint …)
                ‖ spent_vout         // 4 bytes   (… identifies the real consumed UTXO)
                ‖ src_leaf )         // 32 bytes  (the note's FULL authenticated leaf)
```

`src_leaf` is the note's full domain-separated membership leaf — `btc_note_leaf(asset, Cx, Cy, auth_key)` for a
Bitcoin-homed source — so the identity binds the **exact authenticated source**: the spent outpoint PLUS asset
+ commitment + Taproot key. This is what `OP_BRIDGE_MINT` must reproduce to mint, and it keys both the burn
accumulator (`fold_burn`) and the one-mint gate. Because asset and `auth_key` are inside the identity, a burn of
a same-commitment clone of a different asset or key produces a **different** `burn_id` and cannot authorize the
mint. `ν` is retained only for global cross-lane spentness (a note is spent-once across both chains); value
authorization for a bridge mint keys off `burn_id`.

## Source class separation (reflected vs scan-free deposit)

`source_kind` domain-separates the two ways value enters a burn identity so they can never share a `burn_id`
even if every other field coincided:

- `BURN_SOURCE_REFLECTED = 1` — a live reflected note spent in a confirmed `0x2B` burn tx.
- `BURN_SOURCE_DEPOSIT = 2` — a scan-free burn-deposit (a provenance-authenticated native leaf; see
  `burn_deposit.rs`).

This prevents a reflected-note burn and a scan-free burn-deposit from colliding on identity, which — combined
with the consumed-outpoints IMT (a fast-lane-retired outpoint proven non-member before a burn-deposit onboards)
— closes the cross-lane double-mint surface. See the cross-lane double-mint gate in
`CHANGES-SINCE-LAST-ROUND.md`.

## The one-mint gate

On Ethereum, `OP_BRIDGE_MINT` / `OP_BRIDGE_STEALTH_MINT` prove (a) membership of the burned note's leaf in a
relay-attested Bitcoin pool root and (b) membership of `burn_id → dest_leaf` in the relay-attested burn set,
then mint — value carried verbatim by the conservation kernel, one mint per `burn_id`. The reverse direction
(`OP_BRIDGE_BURN` emitting a crossOut, minted on Bitcoin by the Mode-B `fold_crossout`) uses the same
source-identity discipline: the crossout identity binds the exact spent Ethereum source, so a crossOut cannot be
replayed to mint twice on Bitcoin. **Confirm the guest reproduces the identity from the *real* spent note's
authenticated fields, never from an attacker-declared envelope field.**
