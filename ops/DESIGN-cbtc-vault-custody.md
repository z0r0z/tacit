# DESIGN — cBTC.zk vault custody: the trustless-Bitcoin OPTION (not the launch path)

> **STATUS: NOT the launch custody — the trustless-Bitcoin OPTION, documented for post-covenant / when its
> novel-crypto risk is warranted.** This construction makes redemption trustless on Bitcoin *today* using
> adaptor signatures (best *story*), but "trustless via sophisticated crypto" carries its **own** risk: an
> adaptor 2-of-2 + a pre-sign ceremony are novel, not-widely-deployed primitives, and a bug loses real BTC.
>
> **LAUNCH custody (decided): a simple protocol-key/MPC P2TR vault + the mature Ethereum contracts**
> (`InsuranceVault`, the DAO, `cbtcBackingSats`) managing the risk — see `DESIGN-cbtc-tac.md`. Rationale:
> leaning on **battle-tested Ethereum-contract trust** substitutes for **novel-Bitcoin-primitive risk**,
> which is the lower-risk trade *for now*. The trust is then a simple, MPC-able, slashable Bitcoin key +
> auditable Ethereum contracts — not the adaptor construction below.
>
> **ENDGAME: a real covenant (CTV/OP_VAULT)** makes the Bitcoin-native trustless version simple *and* safe,
> and the Ethereum scaffolding drops away. The construction below is the bridge to that — kept as the
> trustless-Bitcoin option if it's ever wanted before covenants, with eyes open to its implementation risk.

## 1. The construction — adaptor-locked redemption (PTLC)

The cBTC.zk lock is a **Taproot 2-of-2 (locker `L` + protocol `P`)** output. At lock time, the locker also
commits a redemption secret `t` (the same secret the cBTC.zk note's redemption will reveal):

1. **Lock.** The locker funds the vault output `2of2(L, P)` and folds the cBTC.zk note via the reflection
   (`fold_cbtc_lock`, conservation `v_cbtc == v_btc`). The protocol `P` **pre-signs** an *adaptor* signature
   for the vault-spend, locked to `T = t·G` (a one-time ceremony, like the adaptor-swap lock). After
   pre-signing, **`P` is out of the loop** — its presig only completes with `t`.
2. **Custody invariant.** The vault can be spent only with **both** `L`'s signature **and** `P`'s completed
   signature. `L` can't spend alone (needs `P`'s sig); `P`'s sig completes only with `t`; `P` can't spend
   alone (needs `L`'s sig). So **the sats move iff `t` is known** — and `t` is revealed **only** by redeeming
   (burning) the cBTC.zk note. **No party can move the BTC without a redemption.** Trustless after the
   one-time pre-sign — no live custodial key that can unilaterally move funds.
3. **Redeem.** The holder burns the cBTC.zk note → the guest reveals `t` (exactly the adaptor-claim
   `s`-exposure: `t = σ·(s − s̃)`) → the locker completes `P`'s adaptor presig with `t` + adds `L`'s sig →
   spends the vault to themselves. Burn ↔ unlock are **atomic** by the adaptor binding.
4. **No timeout needed** for a backing lock: it stays locked as long as the cBTC.zk note circulates; the
   holder redeems when they choose. (A locker-only refund path can be added behind a long CLTV if desired,
   but it would re-open a unilateral-spend door — prefer none for a pure backing lock.)

This is the **adaptor-swap pattern pointed inward**: instead of swapping across chains, the "claim" *is* the
redemption, and revealing `t` unlocks the backing. The primitives (`presign`/`complete`/`extract`, the
even-`y` `R+T` parity, the lock-set) are the ones in `dapp/adaptor-signature.js` (BIP-340-faithful, tested).

## 2. What it changes in the reflection (`fold_cbtc_lock`)

`CBTC_VAULT_SPK` stops being a single constant — each lock is a *different* `2of2(L, P)` Taproot. So the
guest check moves from `spk == CBTC_VAULT_SPK` to **`spk` is a well-formed `2of2` whose protocol leg is the
pinned protocol key `P` and whose Taproot commits the adaptor point `T`** (the locker leg + `T` ride the
witness). The **pinned constant becomes the protocol pubkey `CBTC_VAULT_PROTOCOL_X`** (32 bytes, x-only),
not a full scriptPubKey. The conservation + single-use checks are unchanged. (This is a small `fold_cbtc_lock`
edit; it rides the cBTC.zk reflection re-prove that was needed anyway to finalize the constants.)

## 3. The trust ledger, after this
| Concern | Mechanism | Trust |
|---|---|---|
| cBTC.zk = real BTC (peg) | `fold_cbtc_lock` conservation | **none** (proof) |
| Sats move only on redemption | adaptor-locked 2-of-2; `t` revealed only by the burn | **none** after the one-time pre-sign (no live custodial key) |
| cBTC.tac fungible redemption | a mediator matches a fungible burn to a lock | the **only** residual — the fungible convenience layer |
| cBTC.tac fungible-layer hedge | optional `InsuranceVault` (Ethereum) | **soft + optional** (covenant/adaptor shrink it) |

**cBTC.zk is now fully trustless** (peg + custody). The residual trust is *only* the fungible cBTC.tac
redemption mediator — and even that is reducible (per-denomination adaptor locks, or the covenant vault).

## 4. Two products, by design
- **cBTC.zk** — non-fungible, **adaptor-redeemable, trustless** real BTC. For trust-minimizers: lock a whole
  amount, hold a provable claim, redeem trustlessly by revealing `t`. No custodian, no insurance.
- **cBTC.tac** — the **fungible** form (a claim on the cBTC.zk lock pool), with a redemption mediator + the
  optional `InsuranceVault` backstop. For liquidity/DeFi users who accept the thin mediation trust for
  fungibility. The peg is still real-BTC-backed and trustless; only *which* lock a fungible burn unwinds is
  mediated.

This mirrors how Bitcoin already works (hold native BTC trustlessly, or a fungible wrapper with a custodian)
— except here the trustless option is native + reflection-provable, and the wrapper's trust is thin +
covenant-bound to disappear.

## 5. Covenant endgame
A covenant (`CTV`/`OP_VAULT`) replaces the `2of2` + adaptor with a script that *enforces* spend-only-into-
redemption — removing even the one-time pre-sign ceremony and the locker key. The construction above is
forward-compatible: the reflection's form-check just accepts the covenant SPK instead of the `2of2`.

## 6. Build impact (rides the cBTC.zk reflection re-prove — re-prove is fine)
- **Reflection guest:** `fold_cbtc_lock` checks the `2of2`-with-`CBTC_VAULT_PROTOCOL_X` form (+ commits `T`)
  instead of a constant SPK; pin `CBTC_VAULT_PROTOCOL_X` (the protocol x-only pubkey — the one value still
  needed) instead of `CBTC_VAULT_SPK`.
- **Redemption:** the burn op reveals `t` (the adaptor `s`-exposure — same machinery as the cross-chain
  adaptor claim). The Bitcoin-side completion (`L` sig + completed `P` presig) is wallet/validator work,
  reusing `dapp/adaptor-signature.js`.
- **Pre-sign ceremony:** at lock time, `P` produces the adaptor presig for the `2of2` spend locked to `T`.
  A small signing service (the protocol's, one-shot per lock) — but it holds **no ongoing custody** (it
  can't complete its own presig without `t`).
- **Insurance:** the Ethereum `InsuranceVault` + `cbtcBackingSats` become **optional** (the fungible-layer
  hedge), not core — build them only if/when the fungible mediation warrants it.

## 7. Net
The best cBTC is **trustless end-to-end on Bitcoin**: a conservation-proven peg + adaptor-locked redemption
that no custodian can bypass, reusing the adaptor primitive already built. Fungibility (cBTC.tac) is a thin,
optional, covenant-bound layer on top — not the place the trust lives, and not a reason to accrete Ethereum
plumbing. The one value still needed from you is the **protocol pubkey** `CBTC_VAULT_PROTOCOL_X` (replacing
the vault-SPK ask); everything else is construction we can build + a re-prove.
