# Bitcoin note authority at the ETH↔BTC seam (F1/F2 fix)

Status: DESIGN (implementation in progress). This closes the two cross-chain criticals from the
GPT-PRO bundle-3 audit (2026-07-24). Both are facets of one root cause: a **Bitcoin-homed note carries no
Bitcoin spend authority in its reflected leaf**, so the ETH lane authenticates on knowledge of the Pedersen
blinding — which several Bitcoin ops publish — and the cross-out lane never binds the destination script.

The fix reuses the primitive already shipped for farm-harvest/unbond/protocol-fee-claim materializations
(`lib.rs` `*_owner_msg` + `dest_spk` binding, verified by `bip340_verify`): **a canonical x-only key is
committed and an operation-bound BIP-340 signature by it is required.** F1 applies it to the general
reflected note when spent on the ETH lane; F2 applies it to the cross-out destination.

---

## F1 — reflected note carries a Bitcoin authority key; ETH-lane spend must sign

### The authority
The 32-byte **x-only Taproot output key** of the Bitcoin UTXO that holds the note. Tacit materializes
confidential notes to P2TR outputs (`OP_1 ‖ <32-byte x-only>`), so this key is exactly "who can spend the
UTXO on Bitcoin." The reflection prover **derives it from the confirmed tx output's scriptPubKey**
(`extract_outputs`, the same source `dest_spk` checks already parse) — never a free witness. A non-P2TR
output cannot home a spendable note (reflection rejects it), consistent with how notes are created today.

### The leaf (distinct domain — the structural key)
```
reflected btcHomed leaf  = keccak(asset ‖ Cx ‖ Cy ‖ auth_key ‖ "tacit-btc-note-v1")
native ETH leaf          = keccak(asset ‖ Cx ‖ Cy ‖ owner)           // unchanged
```
The extra domain tag makes the two leaf shapes disjoint. To spend a btcHomed note the prover must
reconstruct its leaf for the membership check, which **forces** supplying `auth_key` (and the btcHomed spend
path that verifies the signature). A spender cannot pass a btcHomed note through the native path: the
native leaf `keccak(asset‖Cx‖Cy‖owner)` with any chosen `owner` never equals the btcHomed leaf. So the guest
needs no out-of-band "is this a Bitcoin root" flag — the leaf domain routes it. Native ETH notes are
untouched (still bearer; owner label is not authority, as designed).

### The ETH-lane spend (every op that can spend a btcHomed input)
For each btcHomed input the witness carries `auth_key` and a BIP-340 signature; the guest verifies:
```
bip340_verify(sig, btc_note_spend_msg(...), auth_key)
btc_note_spend_msg = keccak("tacit-btc-note-spend-v1" ‖ chainBinding ‖ pool/op-id ‖
                            inLeaf ‖ inNullifier ‖ Σ(all output leaves) ‖ public amounts/effects ‖ fee ‖ deadline)
```
Binding **all outputs + amounts + fee + deadline** stops a mempool/delegated-prover party from re-pointing
the value: any change to the outputs invalidates the signature. `inNullifier = keccak(Cx‖Cy‖"spent")` stays
commitment-only (unchanged) so cross-lane ν-matching (`check_btc_nonmembership`, bridge-mint, Mode-B) still
lines up — the auth key is an **additional** gate, never part of ν.

Ops in scope (inputs can resolve against a `knownBitcoinRoot`): `OP_TRANSFER`, `OP_SWAP`, `OP_LP_ADD`,
`OP_SWAP_ROUTE`, bridge-burn, and any other op whose input membership can be a btcHomed leaf. Native-only
ops (wrap-* from public deposits) are unaffected. Each in-scope op reads `auth_key`+`sig` per input and
verifies before conservation.

### Mode-B
Unchanged mechanically, but now fed a correctly-authorized consume: the contract records
`bitcoinConsumed[ν]` only after the guest verified the auth signature, so reverse reflection retires the
genuine Bitcoin UTXO only when its own key signed the spend.

### Spend authority across all value-spending ops (fast lane fully open)
A Bitcoin-homed note's leaf is domain-tagged, so any op reconstructing a native `leaf(asset,Cx,Cy,owner)`
cannot match it — an op that is not btcHomed-aware **fails closed** on such an input automatically. The
authorized signed path is implemented in **every value-spending op**, so Bitcoin-homed notes are usable
directly (no transfer-first): `OP_TRANSFER`, `OP_SWAP`, `OP_LP_ADD`, `OP_LP_REMOVE`, `OP_SWAP_ROUTE`,
`OP_OTC`, `OP_UNWRAP`, `OP_SEND_AND_UNWRAP`, `OP_BRIDGE_BURN` (inputs), `OP_CDP_MINT`, `OP_FARM_BOND`.

Two shared helpers keep it uniform and lower-divergence:
- `input_leaf_authed(asset,cx,cy,owner,btc_homed,ν,&mut stash)` — builds the input leaf (`btc_note_leaf` when
  `btc_homed`, else native `leaf`) and stashes `(auth_key, leaf, ν)` for the signature check. `owner` doubles
  as the auth key. For ops whose inputs share one position `owner` (CDP, farm-bond) the leg reads its own
  x-only auth key when flagged, so it isn't tied to the position owner.
- `verify_btc_input_auths(stash, chain, op_id, out_leaves, fee, deadline)` — one BIP-340 signature per
  Bitcoin-homed input over `btc_note_spend_msg`, read after the op's outputs are known.

**Binding rule (over-bind for safety):** each op binds `out_leaves = every leaf the op appended`
(`leaves[op_start..]`), so no output the op produces can be re-pointed — this is the core theft protection
and avoids per-op reasoning about *which* leaves to bind. Public-output ops add a synthetic leaf: `OP_UNWRAP`
binds `leaf(asset,recip,value,fee)`; `OP_SEND_AND_UNWRAP` binds its change leaves + `leaf(asset,recip,payout,
fee)`; `OP_BRIDGE_BURN` binds the destination leaves; `OP_CDP_MINT` binds the debt note + position leaf;
`OP_FARM_BOND` binds the receipt leaf. A per-op `OP_ID_*` tag blocks cross-op signature replay. The
contract's btcHomed value-exit (`bitcoinConsumed`) is keyed on `spendRoot ∈ knownBitcoinRoot`, independent of
op, so any of these paths records the consume and Mode-B retires the UTXO.

---

## F2 — cross-out binds the destination Bitcoin authority

### The problem
`bridge_burn` (ETH→BTC, `main.rs`) forces the destination leaf owner to zero and the burn kernel binds no
Bitcoin recipient, so `fold_crossout` folds whichever vout-0 script confirms first for the authorized
`(claimId, destChain, destCommitment, asset)` tuple; the claim-ID replay guard then buries the victim's real
mint.

### The fix (0 pool bytecode)
Repurpose the destination leaf's now-zero owner field as a **committed destination authority** = the x-only
Taproot key the burner intends to receive at:
```
crossout dest leaf = keccak(asset ‖ Cx ‖ Cy ‖ dest_auth_key ‖ "tacit-crossout-dest-v1")
```
- `main.rs` bridge-burn: read `dest_auth_key` (nonzero), build the dest leaf with it, and use the
  **leaf-bound kernel** (`verify_kernel_with_fee_bound` with the dest leaves) so the burner's authorization
  commits to the exact destination — a delegated prover can't swap it.
- `fold_crossout` (`lib.rs`): parse the mint tx's **vout-0 scriptPubKey**, require it to be P2TR and its
  x-only key to equal the `dest_auth_key` in the eth-authorized leaf, before admitting the outpoint. A
  replay with a different/unspendable script no longer matches the authorized leaf → folds nothing, and the
  real mint still lands.
- The contract's `crossOutCommitment`/`claimId` layout is unchanged (the authority rides inside the leaf
  preimage the guest checks), so **0 bytes** of `ConfidentialPool` runtime growth.

---

## Touch-points (implementation checklist)

Guest:
- `cxfer-core/src/lib.rs`: `reflected_note_leaf` → add `auth_key` + domain (new fn or param); new
  `btc_note_spend_msg` + `crossout_dest_leaf` helpers; per-input auth verify in each in-scope op's fold and
  in the settle dispatch; `fold_crossout` dest-script check.
- `cxfer-core/src/bitcoin.rs`: extract the x-only key from a P2TR scriptPubKey (helper); use in reflection
  note-append and cross-out fold.
- `src/main.rs`: per-input `auth_key`+`sig` read/verify for btcHomed inputs; bridge-burn `dest_auth_key`.
- `src/reflect.rs` / `swap_batch.rs`: pass the derived `auth_key` when appending reflected notes.

Dapp (mirror, or membership/leaves diverge and spends fail):
- `dapp/confidential-reflection-indexer.js`, `confidential-reflection-scan-indexer.js`: build the reflected
  leaf with `auth_key` + domain (from the confirmed output's x-only key), not `ZERO_OWNER`.
- `dapp/confidential-pool.js` (`destCommitment`), `dapp/confidential-swapbatch.js`,
  `dapp/burn-deposit-assembler.js`: same leaf shape; emit `auth_key`+`sig` on btcHomed spends; cross-out
  `dest_auth_key`.

Fixtures / harnesses: regenerate every btcHomed-input and cross-out fixture with the new leaf + sig;
rebuild the 3 ELFs, re-pin `elf-vkey-pin.json`, `MODE=execute` parity on changed ops, redeploy with the new
burned vkey. New seam crypto gets its own audit pass before burn-in.

---

## Reprove checklist (guest done; remaining = dapp mirror + build/prove, needs the prover box for parity)

Guest status: **complete and green** — F3/F4/F5, F1 append (all folds + reflect.rs + swap_batch), F1 spend
(EVERY op that can spend a btcHomed input requires the BIP-340 signature — `input_leaf_authed` is the sole
spend-path constructor of `btc_note_leaf` and each call site is paired with `verify_btc_input_auths`: the ops
listed in "Ops in scope" above, i.e. `OP_TRANSFER`, `OP_SWAP`, `OP_LP_ADD`, `OP_LP_REMOVE`, `OP_OTC`,
`OP_SWAP_ROUTE`, `OP_UNWRAP`, `OP_SEND_AND_UNWRAP`, `OP_BRIDGE_BURN`, `OP_CDP_MINT`, `OP_FARM_BOND`), F2
(bridge_burn + fold_crossout). cxfer-core tests pass; the settle guest, reflection guest, and cxfer-core all
compile.

Dapp primitives added to `dapp/confidential-pool.js` and exported: `btcNoteLeaf(asset,cx,cy,authKey)`,
`btcNoteSpendMsg(chainBinding,opId,inLeaf,inNu,outLeaves,fee,deadline)`, `p2trXonly(spk)`.

Remaining, each verified by `MODE=execute` parity on the box (a JS↔guest divergence shows up there):

1. **Reflection mirror leaf shape** — in `confidential-reflection-scan-indexer.js`,
   `confidential-reflection-indexer.js`, `confidential-swapbatch.js`: every reflected note leaf becomes
   `pool.btcNoteLeaf(asset, cx, cy, authKey)` where `authKey = pool.p2trXonly(<output scriptPubKey at that
   note's vout>)` (`?? ZERO32` on non-P2TR). Parse the vout scripts from each tx's `rawHex`. Vout per note
   must match `reflect.rs`: swap_var receipt @1 / change @2, swap_route @1, cxfer `vouts[i]`, lp_share &
   lp_remove @ `canonical_amm_output_vout`, swap_batch receipt i @ i+1, harvest/unbond/fee dest @1,
   crossout @0.
2. **Cross-out destCommitment (F2)** — `pool.js foldCrossout`: take a `destAuthKey` arg and use
   `btcNoteLeaf(asset, cx, cy, destAuthKey)` (was `leaf(...ZERO_OWNER)`); the crossout-indexer caller derives
   it from the mint tx's vout-0 script via `p2trXonly`. The ETH burn-side dapp emitter records the burner's
   chosen recipient x-only key in the dest `owner` field (was forced 0).
3. **Per-op witness layout (all opened ops)** — the proof-gen for each value-spending op writes, per input,
   a `btc_homed` u32 flag (0 for native, right after the input's `owner` field). For a Bitcoin-homed input
   the note's x-only auth key goes in the `owner` slot (transfer/swap/lp/route/otc/unwrap/bridge_burn) — or,
   for CDP-mint / farm-bond legs, a separate x-only key read only when the flag is set. After the op's outputs
   + fee, it writes one 64-byte BIP-340 sig per btcHomed input, in stash order, over
   `btcNoteSpendMsg(chainBinding, OP_ID_<op>, inLeaf, inNu, outLeaves, fee, deadline)`. `outLeaves`,
   `fee`, `deadline`, and the `OP_ID_<op>` tag per op match the guest exactly (see the binding rule above:
   over-bind = every leaf the op appended, plus the synthetic public-output leaf where noted; OTC and
   bridge_burn pass fee 0, CDP/farm-bond pass fee/deadline 0). `OP_ID_<op>` = `"tacit.op.<name>"` padded to
   32 bytes, matching the guest `op_id(...)` consts.
4. **bridge_burn witness** — the burn proof-gen writes `dest_auth_key` (recipient x-only key) in the dest
   `owner` slot for a Bitcoin destination (the guest builds `btc_note_leaf` and binds it via the leaf-bound
   kernel).
5. **Fixtures / harnesses** — regenerate the transfer, bridge_burn, cross-out, and every reflected-output
   fixture with the new leaves/flags/sigs; update the matching `harnesses/exec-*.rs` if their witness read
   order changed.
6. **Build / prove / deploy** — `cargo prove build` the 3 ELFs, `MODE=execute` parity per changed op, re-pin
   `pins/elf-vkey-pin.json`, regenerate Groth16 fixtures, redeploy the pool with the new burned vkey, run the
   seam audit on the new authority crypto before burn-in.

Safety note: even before steps 1–6 land, the deployed-source posture is fail-closed — a Bitcoin-homed note
carries authority in its leaf and cannot be spent on the ETH lane except through a signed BIP-340
authorization on every spending op (see "Ops in scope"), so the F1/F2 exploits are closed; the remaining work
re-enables and mirrors the flows, it does not gate
the security fix.
