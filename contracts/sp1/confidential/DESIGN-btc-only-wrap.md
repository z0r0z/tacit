# Bitcoin-only private transfer: same-tx wrap/unwrap

Status: DESIGN (not implemented). Proposes two new Bitcoin opcodes for trustless, no-escrow entry and exit
of a Bitcoin-only wrapped-BTC asset. Reuses the Bitcoin-homed note scheme and the CXFER kernel unmodified;
claims free opcode space (`0x6A`–`0xFF`, SPEC §3.9).

Scope note: `T_CXFER` transfers of the wrapped note hide amount, not source — its kernel signature hashes
the literal spent `txid:vout` into its signed message (SPEC §2.4), so a chain observer can trace which
prior output funded any given transfer. That's fine for cheap, amount-hidden movement of the wrapped
asset. Payments that also need to hide source and sender are a separate note model — see
[`DESIGN-btc-shielded-pool.md`](./DESIGN-btc-shielded-pool.md), which this design's atomic lock/redeem
pattern feeds directly.

## Why this differs from cBTC

cBTC exists to make a *third party's* locked BTC fungible and spendable by *others* on Ethereum, so it
needs economic security (wstETH escrow, slashing) to stop the locker from rugging the people holding
cBTC against their lock. That problem doesn't exist here: the person locking sats **is** the person
minting the note, for themselves. There is no counterparty to trust and nothing to slash — the wrap is
worth exactly what the lock output is worth because the same transaction proves both facts at once.

## Why this differs from "Shielded Bitcoin" (allocinit)

Their transfer layer is cryptographically sound with no economic assumption — so is `T_CXFER`, already
live. Where they lose parity is the boundary: peg-in/peg-out is explicitly deferred to an unpublished
follow-up paper, and their own text says entry/exit isn't claimed to be trustless. This proposal is a
worked, KISS boundary construction that needs no economic assumption either, because issuance and
redemption are each bound atomically, in one transaction, to a real Bitcoin output's public value.

## T_BTC_WRAP (0x6A) — lock and issue in one transaction

```
0x6A ‖ lock_vout(4 LE) ‖ C(33) ‖ auth_key(32) ‖ opening_proof(64)
```

- `lock_vout`: index of this same transaction's self-custody lock output (P2TR, key-path spendable only
  by the locker — same construction already used for `T_CBTC_LOCK`'s dest output).
- The locked value `v_sat` is **not** a separate field. It is read directly from the amount of
  `outputs[lock_vout]` in this transaction — already public Bitcoin data, so there is nothing to open or
  reflect later.
- `C`: the new note's Pedersen commitment, `C = v_sat·H + r·G` for a blinding factor `r` the locker
  chooses.
- `auth_key`: x-only key for the note's future spend authorization — the existing Bitcoin-homed leaf and
  BIP-340 spend rule apply unmodified (SPEC §4.1): `leaf = keccak(asset ‖ Cx ‖ Cy ‖ auth_key ‖
  "tacit-btc-note-v1")`, spend requires a signature under `auth_key` in domain `tacit-btc-note-spend-v1`.
- `opening_proof`: a Schnorr NIZK proving `C` opens to `v_sat` under a blinding factor known to the
  signer, checked directly against the public `v_sat` — the one piece of new cryptography this adds, and
  it's a standard sigma protocol over the same secp256k1 group already in use, no new proof system.

An indexer accepts `T_BTC_WRAP` iff `outputs[lock_vout]` is a recognized self-custody lock script,
`opening_proof` verifies `C` against that output's value, the asset id is the fixed wrapped-BTC asset, and
the `(txid, lock_vout)` pair hasn't already been wrapped. On acceptance it appends the leaf and the wrapped
note is live — spendable that block, transferable with ordinary `T_CXFER`, no reflection, no mint step, no
waiting.

## T_BTC_UNWRAP (0x6B) — burn and unlock in one transaction

```
0x6B ‖ lock_txid(32) ‖ lock_vout(4 LE) ‖ v_sat(8 LE) ‖ kernel_sig(64)
```

Same shape as `T_CBTC_REDEEM` (109 bytes), minus any reflection reporting. The transaction spends the
`(lock_txid, lock_vout)` output back to the locker's key **and** burns exactly `v_sat` of the wrapped note
in the same transaction, proven by the CXFER kernel (`Σ C_in = v_sat·H`, SPEC §2.4) against the resolved
input commitments — the existing conservation check, unmodified. Supply and backing move together because
one transaction enforces both; there is no window where they can diverge.

## What's reused unmodified

- `T_CXFER` for every transfer once wrapped — Pedersen amounts, Bulletproofs+ range proofs, kernel-signed
  conservation, already live (SPEC §3.4).
- The Bitcoin-homed note leaf and nullifier scheme, and its BIP-340 spend rule (SPEC §4.1).
- The CXFER kernel verification formula (SPEC §2.4).
- `T_CBTC_REDEEM`'s pattern of spending the lock and burning the note in one transaction — copied for
  `T_BTC_UNWRAP`, without the reflection/collateral-layer reporting cBTC needs.
- Opcode space: `0x6A`/`0x6B` come from the free `0x6A`–`0xFF` Bitcoin range (SPEC §3.9, §10).

## Limitations (self-inflicted, not fund-at-risk)

Consistent with the V1 security philosophy already applied elsewhere in this codebase: the lock output has
no covenant, so nothing on Bitcoin stops the locker from spending it some other way instead of through
`T_BTC_UNWRAP`. Doing so doesn't let anyone take anyone else's funds — there's no counterparty — it just
strands that holder's own note (the on-chain backing is gone, the note can never unwrap correctly again).
That's a footgun for the note's owner alone, not a protocol-level fund-safety risk, and it goes away
outright once a covenant primitive (CTV/`OP_CAT`/`OP_CSFS`/`OP_VAULT`) is live and the lock output can be
script-constrained to only ever spend through `T_BTC_UNWRAP`.

## Open questions

- Ticker/asset id for the canonical wrapped asset — deployment choice, not fixed here.
- Whether `T_BTC_WRAP` should allow minting directly to someone else's `auth_key` (pay-in-one-step), or
  whether KISS favors always wrapping to yourself first and sending via `T_CXFER` — leaning toward the
  latter: one less thing the wrap opcode needs to get right, and `T_CXFER` already does this well.
- Worker/indexer and dapp wiring (`worker/src/index.js`, `dapp/tacit.js`, `dapp/cbtc-envelope.js` as the
  closest existing template) — not started.
