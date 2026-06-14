# DESIGN — cBTC.zk sats-lock reflection value-entry (guest hand-off)

> **STATUS: DECIDED — rides the in-flight reflection re-prove.** The trustless real-BTC value-entry
> (lock sats → mint a backed cBTC note) is folded into the reflection guest now, so the deployed
> `BITCOIN_RELAY_VKEY` supports it (see [`CHECKLIST-cbtc-readiness.md`](./CHECKLIST-cbtc-readiness.md)).
> This is the guest design hand-off — companion to the cmint-deposit value-entry
> (`SPEC-BITCOIN-REFLECTION-AMENDMENT §6.1`), which it mirrors in shape, and to
> [`DESIGN-mode-b-recursion.md`](./DESIGN-mode-b-recursion.md) (same hand-off style). The guest is the
> parallel session's; this specifies the construction it implements.
>
> **Two separable pieces, only the first is deploy-gated:**
> 1. **The value-entry fold (this doc, §1–§3)** — proves a real sats-lock EXISTS and backs exactly the
>    minted cBTC value. Guest-level → `BITCOIN_RELAY_VKEY` → must be in the re-prove.
> 2. **The vault-custody construction (§4, the open crux)** — enforces the lock is *released only on
>    redemption*. Bitcoin-side validator + script design; determines the *trust level*, not the deploy.
>
> **IMPLEMENTATION STATUS (2026-06-13):** the **value-entry core is built + tested natively**
> (cxfer-core, 66 tests green): `bitcoin::parse_cbtc_lock_envelope` (0x66) + `bitcoin::parse_tx_output`
> (reads the locked output's value + scriptPubKey) + `ScanReflection::fold_cbtc_lock` (asset binding +
> vault-SPK match + opening-sigma value-binding `note == v_btc` + owner-free fold; skip-not-panic) +
> the `CBTC_ZK_ASSET_ID` / `CBTC_VAULT_SPK` / `CBTC_LOCK_DOMAIN` consts + the adversarial KAT
> (`fold_cbtc_lock_admits_backed_mint_rejects_tampering`: backed mint folds; wrong-asset / over-mint /
> non-vault each fold nothing). The guest **dispatch is added** to `reflect.rs` (the 0x66 branch,
> mirrors 0x65 — untested locally, needs the box). **Remaining (guest owner):** (a) the witness-stream
> assembler must emit the per-0x66 witnesses (`note_path` + opening sigma) — the box harnesses
> (`exec-reflect-*`) + the JS scan-indexer, coherent with the reflect.rs read; (b) **finalize the two
> placeholders** — `CBTC_VAULT_SPK` (the vault lock FORM, §4) and `CBTC_ZK_ASSET_ID` — both baked into
> `BITCOIN_RELAY_VKEY`, so they must be final before the re-prove; (c) box `cargo prove` → the new
> vkey + on-chain fixture.

## The model

```
lock sats on Bitcoin  ──(reflection verifies the lock)──▶  cBTC note enters the confidential pool root
   (T_CBTC_LOCK tx)                                          (backed 1:1, conservation-closed)
                                                                     │
                                                          bridge_mint (unchanged, any asset)
                                                                     ▼
                                                          cBTC ERC20 / confidential note on Ethereum
redeem: burn cBTC (ν spent) + spend the vault output (release sats), gated by the vault validator (§4)
```

cBTC is then **just another Bitcoin-pool asset** — the bridge, the canonical ERC20, the confidential
pool carry it with zero contract change. The only new guest surface is the value-entry below.

## 1. The `T_CBTC_LOCK` value-entry (mirrors the cmint fold, §6.1)

New opcode `T_CBTC_LOCK` (e.g. `0x66`). Wire (analogous to `T_MINT`, but backed by a *lock* not an
issuer signature):
```
opcode(1) ‖ asset_id(32) ‖ lock_vout(4) ‖ commitment(33) ‖ amount_ct(8) ‖ rp_len(2) ‖ rangeproof(VAR)
```
The lock tx carries, at output `lock_vout`, the **locked sats** (value `v_btc_sats`, the canonical
cBTC vault scriptPubKey) and, in the Taproot envelope, the **minted cBTC note** `(commitment, amount_ct)`.

`ScanReflection::fold_cbtc_lock` — all checks in-guest; **any failure → skip (fold nothing)**, exactly
like the cmint / cxfer skip-not-panic. An attacker who fabricates any piece folds nothing:

1. **Confirmed lock output.** The tx is confirmed (`verify_tx_in_block` + `verify_header_chain` — the
   full-scan already does this per block). Read output `lock_vout`: assert
   `scriptPubKey == CBTC_VAULT_SPK` (the canonical vault output, §4) **and** read its value
   `v_btc_sats`. A non-vault or absent output → skip.
2. **Conservation `v_cbtc == v_btc`.** The cBTC note commits to `v_cbtc` (range-proven `[0, 2⁶⁴)` via
   the BP+ `rangeproof`, single output `m=1`). Assert `v_cbtc · CBTC_SCALE == v_btc_sats` (1:1;
   `CBTC_SCALE = 1` if cBTC is sat-denominated). This binds the minted value to the locked sats — **no
   over-mint** is representable.
3. **Asset binding.** `asset_id == CBTC_ZK_ASSET_ID` (the pinned canonical cBTC.zk id — domain-separated;
   not an attacker-chosen id). So only the real cBTC asset mints.
4. **Lock single-use.** The lock outpoint `key = outpoint_key(lock_txid, lock_vout)` is inserted into
   the live UTXO set **under `asset_id` with value = the cBTC note's commitment hash** — so the vault
   output backs **exactly one** cBTC note. A second `T_CBTC_LOCK` citing the same outpoint hits the
   duplicate-insert guard (`LiveUtxoSet::insert` panics on a duplicate key → in `fold_cbtc_lock` guard
   with `live.get(key).is_none()` and skip if present). No double-mint against one lock.
5. **Fold.** On success: append `reflected_note_leaf(asset_id, commitment)` (owner-free, §7.1) to the
   note tree + insert the cBTC note's own outpoint into the live set under `asset_id`. The **vault
   outpoint** is tracked as the backing (so redemption can remove it, §3).

## 2. The conservation invariant (what makes cBTC provably 1:1 backed)

**Reflected cBTC pool value ≤ locked sats backing it**, by construction:
- every cBTC note enters only via `fold_cbtc_lock`, which requires a confirmed vault output of **equal**
  value (check 2) that is **single-use** (check 4);
- redemption (§3) removes the cBTC note (ν → spent set) and the vault outpoint **together**;
- the full-scan is conservation-closed (it can only *move* notes otherwise), so no cBTC value exists
  without a live, equal-value vault output behind it.

This is the property the reflection proves onto Ethereum: cBTC on either chain is backed by real,
confirmed, unspent sats — verifiable by anyone, no oracle.

## 3. Redemption

Burn the cBTC note (a normal confidential pool spend → `ν` into the spent set) **and** spend the vault
output (release sats), atomically bound by the vault validator (§4). The reflection reflects:
- the cBTC burn (`ν` in the spent set — cross-lane correct, like any spend);
- the vault-output spend → its outpoint leaves the backing/live set.
So the backing set shrinks exactly as cBTC is redeemed; the §2 invariant holds across redemption.

## 4. The open crux — vault custody (NOT deploy-gated; determines the trust level)

§1 proves the lock **exists and backs the value**. It does **not** by itself enforce that the vault
output is **released only on redemption** — that is the classic BTC-custody problem, and it is the part
that decides how trustless cBTC.zk actually is. Options, in increasing trustlessness:
- **Protocol-key vault + indexer-enforced redemption** — the vault is a known key; the validator
  recognizes a vault-spend as valid **only** when a matching cBTC burn accompanies it. Soundness rests
  on the key not unilaterally moving sats (a custody assumption; can be threshold/MPC + slashing).
- **Covenant vault** (e.g. `OP_CTV`/`OP_VAULT` if/when available) — the script *enforces* "spendable
  only into the redemption template," removing the custody key. The trust-minimal target.
- **Pre-signed-redemption / DLC-style** — a fixed redemption transaction the locker can always broadcast.

Tacit's structural edge: the lock + the redemption are **native and reflection-provable** (no external
SPV/federation a wBTC/tBTC needs), so the vault is the *only* residual trust surface, and it can be
hardened independently of the value-entry. **This needs its own design pass + review**; it can land
*after* the deploy (the value-entry is forward-compatible with any of the above). Choose + document the
launch vault posture (likely protocol-key + redemption-enforcement, accept-and-document, with covenant
as the upgrade) — the same accept-and-document discipline as the reorg posture.

## Coordination + why it shares the re-prove

- **Guest (parallel session, rides this re-prove → `BITCOIN_RELAY_VKEY`):** `bitcoin::parse_cbtc_lock_envelope`
  (opcode `0x66`) + `ScanReflection::fold_cbtc_lock` + the `CBTC_VAULT_SPK` / `CBTC_ZK_ASSET_ID` /
  `CBTC_SCALE` constants. It is the **same fold shape** as cmint-deposit (verify-backing → fold-note →
  skip-not-panic), so it's an additive opcode in the value-entry dispatch, **not** a re-architecture —
  which is exactly why folding it into the in-flight re-prove is cheap.
- **Bitcoin validator (worker/indexer, additive, post-deploy):** the vault script recognition + the
  redemption-gating (§4) + the cBTC mint/redeem flows.
- **Ethereum contract:** **no change** — cBTC is an asset; the backing is verified in the guest and
  trusted via the reflection proof. The deploy locks only the vkey.
- **App (mine, after the legs):** cBTC mint/redeem UX, the canonical-ERC20 surfacing, the unified-holdings
  recognition (the resolver already handles any asset id).

## KATs to land with the guest change
A fabricated lock output, a wrong-value lock (over-mint), a wrong `asset_id`, a double-mint of one
outpoint, and an unconfirmed lock must **each fold nothing** — the same adversarial-PoC battery the
cmint / REFLECT-1 / asset-preservation paths got.
