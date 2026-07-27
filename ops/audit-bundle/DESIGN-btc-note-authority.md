# Design — Bitcoin note authority model

How a Bitcoin-homed confidential note carries spend authority, why a malformed (zero-auth) note is unspendable,
and how output destinations are bound. Accurate to `cxfer-core/src/bitcoin.rs`, `cxfer-core/src/lib.rs`, and the
reflection folds (`reflect.rs`); verify against the code.

## The Bitcoin-homed leaf and its auth key

A Bitcoin-homed note's membership leaf is

```
btc_note_leaf(asset, Cx, Cy, auth_key) = keccak(asset ‖ Cx ‖ Cy ‖ auth_key ‖ "tacit-btc-note-v1")
```

where `auth_key` is the **x-only Taproot key** of the note's Bitcoin UTXO. The reflection derives `auth_key`
from the confirmed output's scriptPubKey (`bitcoin::output_p2tr_xonly`) — it is read **verbatim from the
confirmed tx**, never reconstructed to an assumed shape. Spend authority is the pairing of two facts: knowledge
of the note's blinding `r` (the bearer/kernel proof, shared with the native model) AND a **BIP-340 signature
under `auth_key`** for any Ethereum-lane spend of the note (`btc_note_spend_msg`). So a delegated prover or an
observer who learns the public blinding still cannot move the note or re-point its outputs without the Taproot
key.

## Zero-auth notes are unspendable — and folds fail closed on them

A note whose `auth_key` is all-zero has no valid spender: `x = 0` is not a valid secp256k1 x-coordinate, so no
BIP-340 key exists over it. A non-P2TR receipt/change output yields exactly this zero `auth_key`. The AMM /
transfer folds therefore treat a zero auth key as **fail-closed**: they bind the receipt/change scriptPubKey
verbatim from the confirmed tx and reject a zero auth key rather than onboard a permanently unspendable note
(`fold_swap_var` gate 0 rejects a non-P2TR receipt and a non-P2TR change; the KATs
`zero receipt auth (non-P2TR) rejected` / `zero change auth (non-P2TR)` pin this). "Fail" here means **skip**,
not abort: the input was already nullified in the general scan, so a malformed swap self-strands its own
initiator while reflection advances (skip-not-abort). This is the correct posture precisely because an
unspendable note would otherwise silently burn the holder's value.

## Destination binding via SIGHASH_ALL (H-01)

For the pool-note inputs a reflection fold consumes (pure CXFER/AXFER and LP add/remove), the output
destinations are read from the confirmed tx. To ensure a coordinator cannot have signed a partial commitment
that lets the destinations be swapped, the fold requires the spender's Bitcoin signature to commit to **all**
of the tx's outputs. `sig_binds_all_outputs` (`bitcoin.rs`) enforces this per input:

- a 64-byte Schnorr item is SIGHASH_DEFAULT (implicit ALL) → binds;
- a 65-byte Taproot item or an ECDSA `DER‖flag` binds only if the explicit flag byte is `0x01` (SIGHASH_ALL);
- SIGHASH_SINGLE / NONE (`0x02` / `0x03`) and every ANYONECANPAY variant (`0x8x`) do **not** bind all outputs
  and are **rejected**.

So under the emitters' live SIGHASH_ALL policy the destinations are Bitcoin-consensus-bound on the confirmed
tx. The in-guest sighash inspection (`note_spends_sighash_binding`) is the defense-in-depth that enforces this
in the fold itself rather than relying only on the emitter's policy.

## The adaptor exception (0x83)

There is one legitimate use of an ANYONECANPAY sighash: the atomic-settlement **adaptor** swap
(`OP_ADAPTOR_*`) spends the maker's asset with **SIGHASH_SINGLE|ANYONECANPAY (0x83)** by design — the maker
signs binding only its own output (its leg of the atomic swap), so a counterparty can attach its own funding
input without invalidating the maker's signature. That is why `0x83` is explicitly enumerated as a NON-binding
flag in `sig_binds_all_outputs` and is **not** admitted to the SIGHASH_ALL destination-binding path: the adaptor
lock-set carries its own authorization (`claim_sig`, deadline-exclusive lock/claim/refund), so it does not — and
must not — go through the pure-note SIGHASH_ALL gate. **Confirm the adaptor path's own authorization fully
substitutes for the destination binding it is exempt from, and that no non-adaptor note-spend can reach the tx
under a `0x8x` flag.**
