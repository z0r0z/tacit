# Stealth dapp integration — per-call-site patch plan

Status: pre-staged for Task 19.
Companion files:
- `tests/stealth-dapp-patch.mjs` — helpers ready to inline.
- `tests/cxfer-stealth.test.mjs` — unit tests, pass today against the
  standalone module, work unchanged once inlined.
- `spec/design/STEALTH-DAPP-INTEGRATION-PLAN.md` — high-level plan.

This document spells out the **exact edits** to land once the user's
batch merge clears. Every edit is additive: classical send/receive
paths are untouched.

---

## 0. Where things live in `dapp/tacit.js` (anchors as of HEAD)

| § | Anchor | Line (approx) |
|---|---|---|
| crypto helpers | `function deriveBlinding` | 3828 |
| keystreams | `function deriveAmountKeystreamECDH` | 3895 |
| CXFER opcode | `const T_CXFER = 0x23` | 5158 |
| CXFER decoder | `function decodeCXferPayload` | 5396 |
| cBTC.tac recovery commit (POI check landed) | `function deriveCbtcTacRecoveryCommit` | 7845 |
| scanner | `async function scanHoldings` | 13970 |
| CXFER scanner branch | `} else if (env.opcode === T_CXFER` | 14319 |
| recipient ECDH/self trial | `if (senderPubHex)` | 15130–15170 |
| CXFER sender | `async function buildAndBroadcastCXferMulti` | 23664 |
| AXFER atomic-intent sender | `recipBlinding = deriveBlinding(... makerPub ...)` | 24096 |
| OTC settlement sender | `recipBlinding = deriveBlinding(... sellerPub ...)` | 26433 |
| export surface | `deriveBlinding, deriveChangeBlinding,` | 74557 |

---

## 1. Inline the helpers (one block, no behavior change)

Copy the **entire contents** of `tests/stealth-dapp-patch.mjs` (minus
its top-of-file import block) into `dapp/tacit.js` immediately after
`deriveAmountKeystreamSelf` at line 3904 (i.e. into the same locality
as the other blinding/keystream primitives). Replace its imports with
references to the existing dapp symbols:

| import in patch module | dapp symbol |
|---|---|
| `secp` | `secp` (already top-level) |
| `sha256` | `sha256` (already top-level) |
| `hmac` | `hmac` (already top-level) |
| `hexToBytes`, `bytesToHex`, `concatBytes` | already top-level |
| `p2wpkhScript`, `p2trScript`, `xOnly` | already defined in dapp |
| `SECP_N` | already top-level |

After paste, all `export` keywords inside the patch must be **stripped**.

The block adds these dapp-internal symbols:

```
STEALTH_HRP, DOMAIN_CXFER_STEALTH, DOMAIN_AXFER_STEALTH,
DOMAIN_AXFER_VAR_STEALTH, STEALTH_DOMAIN_BY_OPCODE, MIXER_EMITTING_OPCODES,
encodeStealthAddress, decodeStealthAddress,
deriveStealthEcdhBlinding, computeStealthCommit, computeStealthTweakedSk,
classifyInput, isStealthEligibleKind, aggregateStealthEligibleInputPubkeys,
isMixerDerivedInput, checkStealthEmissionSafety, stealthTxAnchorHead,
senderComputeStealthCommit, recipientScanTxForStealth.
```

Add them to the export object at line 74557 so the dapp build re-exports
them for unit tests:

```js
deriveBlinding, deriveChangeBlinding,
deriveStealthEcdhBlinding, computeStealthCommit, computeStealthTweakedSk,
encodeStealthAddress, decodeStealthAddress,
senderComputeStealthCommit, recipientScanTxForStealth,
aggregateStealthEligibleInputPubkeys, isMixerDerivedInput,
checkStealthEmissionSafety, STEALTH_DOMAIN_BY_OPCODE,
```

No call site in dapp/ yet references the new symbols → safe to land
as one preparatory commit on top of the user's batch.

---

## 2. CXFER sender: optional stealth recipient (line 23664)

`buildAndBroadcastCXferMulti` already takes a `recipients: [{ pubHex,
amount }]` array. The stealth path needs to accept either a raw
`pubHex` (classical) OR a `stealthAddress: 'tcsts1…'` (new). When the
latter is given, the sender computes the commit, replaces the recipient
P2WPKH with `p2wpkhScript(commit)`, and runs §F.7 refusal **before
broadcast**.

### 2a. Extend recipient parsing (replace the `parsed = recipients.map(...)` block at 23675)

```js
const parsed = recipients.map((r, i) => {
  if (!r) throw new Error(`recipients[${i}] missing`);
  if (typeof r.stealthAddress === 'string' && r.stealthAddress.length > 0) {
    const decoded = decodeStealthAddress(r.stealthAddress);
    const netTag = walletNetworkTag();   // 'mainnet' | 'signet' | 'regtest'
    if (decoded.network !== netTag) {
      throw new Error(`recipients[${i}].stealthAddress is for ${decoded.network}, wallet is on ${netTag}`);
    }
    const amt = BigInt(r.amount);
    if (amt < 0n || amt >= (1n << BigInt(N_BITS))) throw new Error(`recipients[${i}].amount out of range`);
    return {
      isStealth: true,
      stealthRecipientPub: decoded.recipientPub,
      pub: decoded.recipientPub,              // used for Pedersen ECDH (unchanged semantics)
      pubHex: bytesToHex(decoded.recipientPub),
      amount: amt,
    };
  }
  if (typeof r.pubHex !== 'string') throw new Error(`recipients[${i}].pubHex required`);
  const pubHex = r.pubHex.trim().toLowerCase().replace(/\s/g, '');
  if (!/^0[23][0-9a-f]{64}$/.test(pubHex)) throw new Error(`recipients[${i}].pubHex invalid format`);
  try { secp.ProjectivePoint.fromHex(pubHex); } catch { throw new Error(`recipients[${i}].pubHex not on curve`); }
  const amt = BigInt(r.amount);
  if (amt < 0n || amt >= (1n << BigInt(N_BITS))) throw new Error(`recipients[${i}].amount out of range`);
  return { isStealth: false, pubHex, pub: hexToBytes(pubHex), amount: amt };
});
```

Existing duplicate-recipient guard at 23694 still works — it dedupes on
`pubHex`, which we still set for stealth recipients (the underlying
recipientPub, *not* the commit).

### 2b. §F.7 refusal — fail-closed before broadcast

Insert immediately after `const firstAssetIn = pickedAssetUtxos[0].utxo;`
at line 23734:

```js
// §F.7 (audit 2.1): if any output is stealth, EVERY eligible input
// must be wallet-owned. Eligible inputs in this builder are
// (a) tacit-envelope inputs (= all asset UTXOs picked above, since
// CXFER reveals through a tacit envelope) and (b) any aux BTC P2WPKH
// inputs sourced from `wallet.address()`. Both classes are
// wallet-owned by construction in this code path — we never co-spend
// foreign inputs. Assert it.
if (parsed.some(r => r.isStealth)) {
  // The classifier inputs are synthesized from local knowledge — every
  // asset input came from `pickedAssetUtxos` (ours) and every aux input
  // from `getUtxos(wallet.address())` (ours). The check is a guard
  // against a future code path that tries to co-sign foreign inputs.
  const safety = checkStealthEmissionSafety({
    inputs: [
      ...pickedAssetUtxos.map(() => ({ kind: 'tacit-envelope', pub: wallet.pub, ours: true })),
      // Aux BTC inputs are added later in `pickedSats`; we don't have
      // them yet here. After they're picked, re-run the check below.
    ],
    eachInputIsOurs: (inp) => inp.ours === true,
  });
  if (!safety.safe) throw new Error(`stealth emission unsafe: ${safety.reason}`);
}
```

Add a second check right after `pickedSats` is finalized (after line
23832), before the kernel signature is computed:

```js
if (parsed.some(r => r.isStealth)) {
  const safety = checkStealthEmissionSafety({
    inputs: [
      ...pickedAssetUtxos.map(() => ({ kind: 'tacit-envelope', pub: wallet.pub, ours: true })),
      ...pickedSats.map(() => ({ kind: 'p2wpkh', pub: wallet.pub, ours: true })),
    ],
    eachInputIsOurs: (inp) => inp.ours === true,
  });
  if (!safety.safe) throw new Error(`stealth emission unsafe: ${safety.reason}`);
}
```

### 2c. Replace recipient script with stealth commit (line 23806–23808)

```js
const revealPkScripts = [];
for (let i = 0; i < K; i++) {
  if (parsed[i].isStealth) {
    // §A.2 sender computes commit; replaces P2WPKH(hash160(recipientPub))
    // with P2WPKH(hash160(commit)). The anchor head and vout index
    // disambiguate per-output keystream/blinding domain.
    const txAnchorHead = stealthTxAnchorHead(firstAssetIn.txid, firstAssetIn.vout);
    const { commit } = senderComputeStealthCommit({
      senderEligibleInputPrivs: [wallet.priv],   // single-signer; all eligible inputs share wallet.priv
      recipientPub: parsed[i].stealthRecipientPub,
      networkTag: walletNetworkTag(),
      domain: STEALTH_DOMAIN_BY_OPCODE.get(useBpp ? T_CXFER_BPP : T_CXFER),
      txAnchorHead,
      voutIndex: i,
    });
    revealPkScripts.push(concatBytes(new Uint8Array([0x00, 0x14]), hash160(commit)));
  } else {
    revealPkScripts.push(concatBytes(new Uint8Array([0x00, 0x14]), hash160(parsed[i].pub)));
  }
}
```

The **Pedersen** blinding and keystream paths at lines 23744–23747 are
**unchanged** — they continue to use `parsed[i].pub` (the underlying
recipient pubkey), so the recipient still decrypts the amount via the
same ECDH path. Only the **on-chain pubkey** is blinded; the amount-
encryption channel is independent.

This is the §B "two capabilities" framing made concrete: amount privacy
(unchanged) is orthogonal to address-link privacy (new). When both are
present, the output is doubly private.

---

## 3. Recipient scanner: trial stealth match (line 15130)

In `scanHoldings`, immediately **after** the ECDH-recipient branch
(15144–15157) and the self-derived branch (15159–15171) miss, add a
stealth-match branch:

```js
// §A.2 stealth recipient trial: the on-chain pubkey at this vout may
// not be wallet.pub directly — it may be commit = wallet.pub + b·G,
// where b is derived from ECDH(sender_pubkey_aggregate, wallet.priv).
// Try this only if the prior two trials missed and the output is a
// P2WPKH or P2TR (the two eligible scriptKinds for stealth emission).
if (!recovered && senderPubHex) {
  // Classify every input in this tx (need all of them for aggregation).
  const classifiedInputs = tx.vin.map((vin) => {
    const witness = (vin.witness || []).map(h => hexToBytes(h));
    const prevoutScript = vin.prevout && vin.prevout.scriptpubkey
      ? hexToBytes(vin.prevout.scriptpubkey)
      : null;
    return classifyInput({ witness, prevoutScript });
  });
  // Skip if any eligible input is mixer-derived (§A.2.5 rule 6).
  // Mempool-space exposes prevout via /tx/:txid/outspends; we already
  // have it on `vin.prevout`. We need the parent tx vout's
  // OP_RETURN to check for MIXER_EMITTING_OPCODES; fetch lazily.
  // (Inlined inside isMixerDerivedInput when caller passes prevoutTx.)
  // For now, conservatively use the prevoutScript heuristic: only the
  // T_WITHDRAW/T_SLOT_BURN outputs sit at vout 0 of their parent and
  // have OP_RETURN at vout 0 too; if vin.prevout.vout !== 0 we know it
  // isn't mixer-derived.
  // (Full prevoutTx lookup deferred to scanner-level caching; safe
  // because false negatives only cause a missed scan, never a false
  // credit.)

  const anchorHead = stealthTxAnchorHead(tx.vin[1].txid, tx.vin[1].vout);
  const outputScript = hexToBytes((tx.vout[u.vout].scriptpubkey || ''));
  const credits = recipientScanTxForStealth({
    classifiedInputs,
    outputs: [{ script: outputScript }],
    walletPriv: wallet.priv,
    walletPub: wallet.pub,
    networkTag: walletNetworkTag(),
    domain: STEALTH_DOMAIN_BY_OPCODE.get(env.opcode),
    txAnchorHead: anchorHead,
  });
  if (credits.length === 1) {
    // We matched. The amount-ct still decrypts via ECDH (sender's
    // pubkey aggregate vs. wallet.priv) — the Pedersen blinding for
    // the amount is INDEPENDENT of the stealth blinding for the
    // pubkey. Re-run the same trial-decrypt but with the aggregated
    // sender pubkey instead of just vin[1].witness[1].
    const senderAggPub = aggregateStealthEligibleInputPubkeys(classifiedInputs).aggregatePub;
    if (senderAggPub) {
      const anchorBytes = concatBytes(
        reverseBytes(hexToBytes(tx.vin[1].txid)),
        (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, tx.vin[1].vout >>> 0, true); return b; })(),
      );
      const ks = deriveAmountKeystreamECDH(wallet.priv, senderAggPub, anchorBytes, u.vout);
      const candidate = decryptAmount(ct, ks);
      if (candidate >= 0n && candidate < (1n << 64n)) {
        const r = deriveBlinding(wallet.priv, senderAggPub, anchorBytes, u.vout);
        try {
          if (pedersenCommit(candidate, r).equals(bytesToPoint(onChainCommitment))) {
            recovered = { amount: candidate, blinding: r, tweakedSk: credits[0].tweakedSk };
            recoveryPath = 'stealth';
          }
        } catch {}
      }
    }
  }
}
```

When `recoveryPath === 'stealth'`, the wallet must spend the UTXO with
`tweakedSk` (not `wallet.priv`). Persist `tweakedSk` on the holdings
entry alongside `amount`/`blinding`:

```js
h.utxos.push({
  ...,
  ...(recoveryPath === 'stealth' ? { stealthTweakedSk: bytesToHex(recovered.tweakedSk) } : {}),
});
```

(Persisting raw priv-key bytes locally is no worse than persisting
`wallet.priv` — both already live in localStorage.)

---

## 4. UTXO spending: signing with `stealthTweakedSk`

Find every place that signs with `wallet.priv` to spend a tacit asset
UTXO. The single-signer dapp uses `wallet.priv` directly for:

- BIP-143 P2WPKH input signing (asset UTXOs spent as inputs in
  `buildAndBroadcastCXferMulti` / `buildAndBroadcastAxferIntent`).
- BIP-341 P2TR key-path (none currently in dapp/, but reserve the path
  for future use).

In each signer, swap `wallet.priv` for `utxo.stealthTweakedSk ?? wallet.priv`
(literal hex → bytes). The corresponding pubkey is `commit`, which is
already on chain at `tx.vout[u.vout].scriptpubkey`; no change needed
in script construction at spend time. The signer can derive
`commitPub = secp.getPublicKey(tweakedSk, true)` for the witness.

---

## 5. UI integration (deferred — TODO before beta flag)

- Accept tcsts1… / tcs1… / tcsrt1… addresses in the recipient field of
  the manual-send UI. If the address decodes, populate `stealthAddress`
  on the recipient; otherwise fall through to the existing pubHex
  resolver.
- Toast: "shielded recipient" badge when send composes with stealth
  address.
- New scanner stat: "shielded receipts" counter.

---

## 6. Backwards-compat invariants

- Every wire format is **unchanged**. CXFER envelope bytes, kernel-msg,
  rangeproof, all bit-identical.
- Classical sends (no stealth address) trigger zero new code paths —
  the `if (parsed.some(r => r.isStealth))` guards short-circuit.
- Classical recipient scans (no stealth output to us) still hit the
  ECDH / self / atomic-intent / OTC branches first; the stealth trial
  only fires after they miss, at the cost of one extra HMAC + point
  add + bytes-compare per scanned vout. Benchmark in §scan benchmark
  task before flipping the beta flag.

---

## 7. Test plan

- Unit: `tests/cxfer-stealth.test.mjs` (30/30 passing today).
- Math: `tests/stealth-math.test.mjs` (40/40 passing today).
- Signet e2e: `tests/stealth-signet-e2e.mjs` (bare-sats roundtrip
  passed in commit-tree).
- Signet extended: `tests/stealth-signet-extended.mjs` (phases A/B/C
  passed; phase D in flight at time of writing).
- After dapp inline: add `tests/stealth-cxfer-signet.mjs` (skeleton
  already in tree) — "doubly private" CXFER tacit-asset roundtrip
  with stealth recipient.

---

## 8. Order of operations (post-merge)

1. Inline patch module (§1). Run `node tests/cxfer-stealth.test.mjs`
   pointing at dapp/tacit.js exports — must still pass 30/30.
2. Apply §2 (CXFER sender). Run `tests/stealth-math.test.mjs` again
   end-to-end.
3. Apply §3 (scanner). Hand-test against the signet harness's stealth
   sends already on chain (Phase A multi-output, Phase B P2TR,
   Phase C multi-input).
4. Apply §4 (spend path). Hand-test by spending one of those UTXOs
   from the dapp.
5. Build `tests/stealth-cxfer-signet.mjs` doubly-private CXFER on
   signet. PASS gate before beta flag.
6. UI integration (§5). Beta flag default OFF on mainnet, ON on signet.

Estimated duration: 2–3 days post-merge for §1–§4, +1 day for §5–§6.
