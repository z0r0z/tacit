# Stealth-address dapp integration plan (Task 19)

> Concrete blueprint for landing the class-2 stealth-address scheme
> into `dapp/tacit.js` once the user's parallel style/batch work
> merges. Pre-staged during the signet test wait so execution is
> mechanical when we get the green light.
>
> Reference primitive: `SPEC-BLINDED-PUBKEY-AMENDMENT.md` (round-2
> + audit closures landed).
> Reference impl: `tests/stealth-primitives.mjs` (40/40 unit tests
> + signet round-trip verified).
> Compat audit: `spec/design/BLINDED-PUBKEY-COMPAT-AUDIT.md`.

---

## §1. Scope of this integration

In scope (this plan):

- Lift the cryptographic primitives from `tests/stealth-primitives.mjs`
  into `dapp/tacit.js` as a stable production export surface.
- Add a stealth-scan pass to `scanHoldings` for class-2 detection.
- Extend `buildAndBroadcastCXferMulti` to accept stealth-format
  recipient addresses and emit P2WPKH(hash160(commit)) dust markers.
- Wire the spend-path to use `tweaked_sk` when a wallet UTXO carries
  stealth-credit metadata.
- Add the §F.7 multi-sender refusal check before stealth emission.
- Add a "Beta: shielded address" toggle in the receive/send UI.

Out of scope (separate amendments / follow-up sessions):

- T_AXFER, T_AXFER_VAR, T_AXINTENT, T_SWAP_VAR stealth-recipient
  paths — same shape, each lands in its own focused session.
- T_WITHDRAW / T_SLOT_BURN `recovery_commit` field (class-1; per-
  opcode amendment required).
- Worker-side changes — none needed for class-2 per the compat audit.
- Light-client scan-pubkey delegation (§D.3 optional mode).

---

## §2. Files touched

| File | Type of change | Estimated LOC delta |
|---|---|---|
| `dapp/tacit.js` | Lift primitives + scanner + send-path + spend-path | +200 to +250 |
| `dapp/index.html` | Receive screen toggle + address-format display | +30 |
| `tests/cxfer-stealth.test.mjs` (new) | Wire-format + scanner unit tests | +200 |
| `tests/stealth-cxfer-signet.mjs` (new) | Signet e2e with tacit asset | +250 |

Worker (`worker/src/index.js`): **NOT TOUCHED** — class-2 is
transparent to the validator per the compat audit §4.

---

## §3. Lift the primitives into `dapp/tacit.js`

### §3.1 Where to place them

In `dapp/tacit.js`, the existing blinded-pubkey helpers live near
the cBTC.tac block (line ~7845, `deriveCbtcTacRecoveryCommit`).
The class-2 stealth helpers slot in next to that, sharing the same
BIP-340 / secp256k1 infrastructure.

Insertion point: between `deriveCbtcTacRecoveryTweakedSk` (line
~7855) and the next non-stealth function. Or as a sibling block
clearly labeled `STEALTH ADDRESS PRIMITIVES (class-2, ECDH-derived)`.

### §3.2 Functions to inline (verbatim from `tests/stealth-primitives.mjs`)

```js
// Constants
const STEALTH_HRP = { mainnet: 'tcs', signet: 'tcsts', regtest: 'tcsrt' };
const STEALTH_BECH32M_CONST = 0x2bc830a3;
const DOMAIN_CXFER_STEALTH = new TextEncoder().encode('tacit-cxfer-stealth-v1');
const MIXER_EMITTING_OPCODES = new Set([0x2A, 0x44]); // T_WITHDRAW, T_SLOT_BURN

// Address codec
function encodeStealthAddress({ network, recipientPub, scanPub, spendPub })
function decodeStealthAddress(addr)

// Blinding derivation
function deriveStealthEcdhBlinding({ ourPriv, theirPub, networkTag, domain, txAnchor })
function computeStealthCommit({ underlyingPub, blinding })
function computeStealthTweakedSk({ underlyingPriv, blinding })

// Output script matching
function matchesStealthCommit({ outputScript, commit33 })

// §A.2.5 input aggregation
function aggregateStealthEligibleInputPubkeys(inputs)
function isStealthEligibleKind(kind)
function isMixerDerivedInput({ prevoutTx, prevoutVout })

// §F.7 refusal check (audit 2.1)
function checkStealthEmissionSafety({ inputs, eachInputIsOurs })

// High-level helpers
function senderComputeStealthCommit({ ... })
function recipientScanTxForStealth({ ... })
```

These are byte-identical to the test reference impl — that impl
has been signet-verified, audit-closed, and unit-tested with 40
green tests including locked-vector + adversarial paths. Lifting
them is mechanical; no logic changes.

**Naming convention.** Prefix tacit-stealth helpers with `Stealth`
to distinguish from cBTC.tac variant-1 helpers
(`deriveCbtcTacRecoveryCommit` etc.) which use self-derived
blinding. The audit was clear that domain tags must stay distinct.

---

## §4. Scanner integration in `scanHoldings`

### §4.1 Insertion point

`dapp/tacit.js:13970` defines `scanHoldings(force)`. Its inner
`_scanHoldingsImpl()` walks the wallet's address UTXOs + ancestry.
For each `txid:vout` in the wallet's perspective, the implementation
parses the envelope at the tx's OP_RETURN and credits the asset
UTXO if the wallet owns its recipient_commit.

The stealth pass slots in **alongside** the classical pass — same
chain walk, additional candidate-match step per output.

### §4.2 Algorithm (added inside `_scanHoldingsImpl`)

```js
// For each tx examined by the wallet's scan:
//   1. (existing) classical recipient_commit match — unchanged.
//   2. (new) stealth recipient match per §D.2:

// Identify the envelope opcode at vout[0].
const envOp = parseEnvelopeOpcode(tx);
if (!envOp) return; // pure Bitcoin tx; nothing to do for the wallet

// Look up the domain tag for this opcode in the §C registry.
const domain = STEALTH_DOMAIN_BY_OPCODE.get(envOp);
if (!domain) return; // opcode not in stealth registry

// Aggregate eligible input pubkeys per §A.2.5.
const inputDescriptors = await classifyInputs(tx); // walks witnesses
const { aggregatePub } = aggregateStealthEligibleInputPubkeys(inputDescriptors);
if (!aggregatePub) return; // no eligible inputs — skip per §F.7 dual

// ECDH against the wallet's recipient priv (one ECDH per tx, cached
// across outputs).
const sharedPt = secp.ProjectivePoint
  .fromHex(bytesToHex(aggregatePub))
  .multiply(BigInt('0x' + bytesToHex(wallet.priv)));
const sharedXonly = sharedPt.toRawBytes(true).slice(1);
const shared = sha256(sharedXonly);

// Anchor head: vin[0].outpoint in LE wire order (audit 3.6).
const anchorHead = concatBytes(
  txidLEBytes(tx.vin[0].txid), u32le(tx.vin[0].vout)
);

// Iterate outputs; derive candidate commit per vout_index.
for (const [voutIndex, output] of tx.vout.entries()) {
  const b = bytesToBigint(hmac(sha256, shared, concatBytes(
    domain, networkTagByte, anchorHead, u32le(voutIndex),
  ))) % SECP_N;
  const commit = computeStealthCommit({
    underlyingPub: wallet.pub, blinding: b,
  });
  const matched = matchesStealthCommit({
    outputScript: hexToBytes(output.scriptpubkey),
    commit33: commit,
  });
  if (matched.match) {
    // Credit this UTXO with stealth metadata for spend-path use.
    creditStealthUtxo({
      txid: tx.txid, vout: voutIndex,
      asset_id: parsedFromEnvelope.asset_id,
      amount_recovered_via_existing_ECDH_keystream_path,
      stealth_metadata: {
        sender_aggregate_pub: bytesToHex(aggregatePub),
        domain_tag: bytesToHex(domain),
        vout_index: voutIndex,
        commit_hex: bytesToHex(commit),
        script_kind: matched.scriptKind,
      },
    });
  }
}
```

### §4.3 ECDH-secret-reuse with existing amount keystream (§G.2)

Per the amendment §G.2, the same ECDH shared secret derives the
amount keystream (existing `deriveAmountKeystreamECDH`) AND the
pubkey-blinding scalar (new). Both use the same `sha256(x_only(
sharedPt))` per audit 1.2's normative pin. Implementation:

```js
// Compute ECDH once:
const sharedXonly = ecdh_point.toRawBytes(true).slice(1);
const sharedHash = sha256(sharedXonly);

// Derive both keystreams in parallel:
const amountKeystream = hmac(sha256, sharedHash, AMOUNT_DOMAIN || …);
const stealthBlinding = bytesToBigint(hmac(sha256, sharedHash, STEALTH_DOMAIN || network || anchor || vout)) % SECP_N;
```

Zero extra ECDH cost. The scanner pays one ECDH per tx and reuses
the result for amount recovery + stealth detection.

### §4.4 Persisted stealth-credit metadata

Each stealth-credited UTXO carries enough information to derive
`tweaked_sk` on demand at spend time:

```js
{
  txid: 'abc...',
  vout: 0,
  asset_id: 'def...',           // standard asset UTXO field
  amount: 1000n,                // recovered via existing ECDH path
  blinding: '0xa1b2...',        // recovered via existing ECDH path
  stealth: {                    // NEW — present iff this is a stealth credit
    sender_aggregate_pub: '02...',
    domain_tag: 'tacit-cxfer-stealth-v1' (bytes),
    vout_index: 0,
    commit_hex: '02...',        // for re-verification
    script_kind: 'p2wpkh',      // or 'p2tr'
  }
}
```

Recovery from seed: scanner walks chain → re-derives ECDH + commit
per output → matches → persists. Stateless w.r.t. wallet local
storage; works on a wallet restored from seed.

---

## §5. Send-path integration

### §5.1 `buildAndBroadcastCXferMulti` extension

`dapp/tacit.js:23664` accepts `recipients` as `[{pubHex, amount}, ...]`.
Extend to accept a stealth-format recipient via a new optional
`stealthAddr` field:

```js
recipients = [
  { pubHex: '02...', amount: 1000n },                  // classical
  { stealthAddr: 'tcsts1qqqq...', amount: 500n },      // NEW: stealth
]
```

For stealth recipients:

```js
for (const r of parsed) {
  if (r.stealthAddr) {
    const decoded = decodeStealthAddress(r.stealthAddr);
    r.pub = decoded.recipientPub;           // underlying pubkey for ECDH
    r.useStealth = true;                    // flag for output-script logic below
  } else {
    r.pub = hexToBytes(r.pubHex);
    r.useStealth = false;
  }
  // (existing amount-validation continues unchanged)
}
```

### §5.2 §F.7 refusal check before signing

Before constructing the reveal tx with any stealth recipients,
verify that EVERY eligible input is wallet-owned per audit 2.1:

```js
if (parsed.some(r => r.useStealth)) {
  const inputDescriptors = await classifyInputsForTx({
    pickedAssetUtxos, satFundingInputs,
  });
  const safety = checkStealthEmissionSafety({
    inputs: inputDescriptors,
    eachInputIsOurs: (inp) => isOurOwnedInput(inp),
  });
  if (!safety.safe) {
    throw new Error(`stealth emission refused: ${safety.reason}`);
  }
}
```

The wallet's `isOurOwnedInput(inp)` checks whether the input's
pubkey corresponds to a key the wallet can sign for — either
`wallet.pub` (classical input) or a known stealth credit's
`commit` (downstream stealth input per Phase D pattern).

### §5.3 Per-recipient dust output script

Where the existing builder emits `P2WPKH(hash160(r.pub))` for
recipients, branch on `r.useStealth`:

```js
let dustScript;
if (r.useStealth) {
  // Compute per-vout commit using §A.2.5 sender aggregate.
  const { commit } = senderComputeStealthCommit({
    senderEligibleInputPrivs: ownedEligiblePrivs,
    recipientPub: r.pub,
    networkTag: networkTagFor(NET.name),
    domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead: tx_anchor_head(pickedAssetUtxos[0]),
    voutIndex: recipientVoutIndex,
  });
  dustScript = p2wpkhScript(commit);  // class-2 default per §D.2
  // Persist nothing — recipient re-derives from chain.
} else {
  dustScript = p2wpkhScript(r.pub);  // existing classical path
}
```

### §5.4 ECDH-secret-reuse on emission

Sender computes one ECDH per recipient (existing amount path
already does this). Reuse the shared secret for stealth blinding
with the additional `STEALTH` domain tag — no extra ECDH cost.

---

## §6. Spend-path integration

### §6.1 Detect stealth UTXOs at input selection

When CXFER (or any consumer) picks input UTXOs, check each for
stealth metadata:

```js
for (const utxo of pickedInputs) {
  if (utxo.stealth) {
    // Re-derive tweaked_sk on demand.
    const ecdhBlinding = deriveStealthEcdhBlinding({
      ourPriv: wallet.priv,
      theirPub: hexToBytes(utxo.stealth.sender_aggregate_pub),
      networkTag: networkTagFor(NET.name),
      domain: utxo.stealth.domain_tag,
      txAnchor: stealthAnchor(utxo.stealth),
    });
    utxo.spendPriv = computeStealthTweakedSk({
      underlyingPriv: wallet.priv, blinding: ecdhBlinding,
    });
    utxo.spendPub  = hexToBytes(utxo.stealth.commit_hex);
  } else {
    utxo.spendPriv = wallet.priv;
    utxo.spendPub  = wallet.pub;
  }
}
```

### §6.2 Input signing under tweaked_sk

The existing P2WPKH signing path takes `(priv, pub)` arguments.
Just pass the per-utxo `spendPriv` / `spendPub` per §6.1 instead
of the wallet defaults. No new signing primitive — same ECDSA
+ SIGHASH_ALL machinery.

For P2TR stealth (script_kind === 'p2tr'), call the BIP-340
key-path signer with `spendPriv` and BIP-340 even-Y handling
(handled internally by `signSchnorr`).

---

## §7. UI integration

### §7.1 Receive screen

`dapp/index.html` exposes the wallet's classical address. Add a
toggle: "Show shielded address." When enabled, render alongside
the classical address:

```
Receive at:
  Classical:  tb1q5d7ln4k5kkwhl6rzn0d5cshleznnm8t0azs9ae
  Shielded:   tcsts1qqqq9lnz3fmn63p4uvraveegs94…   [QR]
            └─ Per-tx unique address on chain; same balance.
```

Default: shielded ON for new wallets, classical-only as opt-out.
Per-wallet setting in localStorage.

### §7.2 Send screen

When the user pastes a `tcs* / tcsts* / tcsrt*` HRP address, the
send screen recognizes it as stealth-capable and routes the
build call accordingly (per §5.1). No new UI required for sender
side — same field accepts both classical and stealth address
formats; the address-format parsing determines the path.

If the user pastes a classical address and the receiver had
shared a stealth one elsewhere, the dapp should hint: "this
address is the classical version of a shielded address you may
have intended to use." Out of scope for v1; later UX polish.

### §7.3 Activity feed

No change to the receipt-display: balances and tx history aggregate
across classical and stealth receipts. Per §H.3 of the amendment,
the keyring of stealth-derived addresses MUST NOT surface in the
default UI. A power-user audit view ("Show on-chain footprint")
can list derived addresses for transparency; defer to follow-up.

---

## §8. Test surface

### §8.1 Unit tests (offline)

`tests/cxfer-stealth.test.mjs` (new):

- Roundtrip: stealth-address parse → sender compute commit →
  recipient scanner finds → tweaked_sk · G == commit.
- Refusal-path: mixed-ownership inputs cause emission to throw.
- Refusal-path: ineligible-only inputs cause emission to throw.
- Multi-recipient mixed (classical + stealth) in one CXFER —
  classical recipients unaffected.
- Self-pay via stealth address — wallet's scanner finds receipt.
- Recovery from seed: scanner walks fixture txs and recovers all
  stealth credits with no prior state.

### §8.2 Existing CXFER regression

Existing `tests/cxfer-*.test.mjs` MUST continue to pass without
modification — class-2 is pure-additive. Any test failure is a
regression bug.

### §8.3 Signet e2e (new)

`tests/stealth-cxfer-signet.mjs`:

- Mints a test tacit asset on signet (CETCH).
- Sender wallet emits CXFER with one stealth recipient.
- Recipient wallet's scanner finds the receipt (amount Pedersen-
  hidden AND recipient address stealth-hidden on chain).
- Recipient spends the tacit asset onward via another CXFER —
  validates downstream transferability at the asset layer.

This is the "tacit coins doubly private" demonstration. Same
shape as the existing extended sats harness, but with a tacit
asset envelope wrapped around it.

---

## §9. Rollout sequence (post user-batch-merge)

1. Lift primitives (§3) — purely additive, 2-3 hour task. Run
   existing test suite to confirm no regressions.
2. Scanner integration (§4) — wire stealth pass alongside
   classical. Verify with offline fixtures + a unit test.
3. Send-path (§5) + refusal-check (§5.2) — extends
   `buildAndBroadcastCXferMulti`. Adversarial unit tests for §F.7.
4. Spend-path (§6) — wires `tweaked_sk` derivation at input
   signing time. Unit test covers stealth UTXO spend.
5. UI toggle (§7) — receive screen + send screen address parsing.
   Behind a feature flag for safe rollout.
6. Signet e2e (§8.3) — full tacit-asset round trip with stealth
   recipient. The production-readiness gate.

Estimated total: 2-3 days focused work. Each step lands as its
own commit so the integration history is reviewable in pieces.

---

## §10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Scanner cost regression on large wallets | §H.5 benchmarks. Cache ECDH per tx. Skip txs whose envelope opcode isn't in the stealth registry. |
| ECDH-serialization drift between scanner and emitter | Locked-vector test (already in `stealth-math.test.mjs`). Pinned in §A.2 NORMATIVELY. |
| §F.7 refusal-check forgotten in a builder | Centralize the check in `checkStealthEmissionSafety`. Reference impl test asserts every code path that emits stealth calls it. |
| User confusion over classical vs stealth address | UI: receive screen surfaces both; default favors stealth; "show on-chain footprint" power-user view for auditing. |
| Recipient hasn't upgraded; sender emits stealth | Address-format parser rejects unrecognized HRP at recipient side (§D.1 rule 6). Sender's wallet refuses to emit if recipient's published address is classical-only. |
| Downstream txid byte-order drift | §C anchor registry NORMATIVE: txid is LE wire bytes in tx_anchor. Sender + recipient compute identically. |

---

## §11. Cross-references

- `SPEC-BLINDED-PUBKEY-AMENDMENT.md` §A.2 (construction), §A.2.5
  (eligibility), §C (anchor registry), §D.1 (address format),
  §D.2 (scanner), §F.6 (scan-flooding), §F.7 (refusal), §G.2
  (ECDH reuse), §G.5 (BIP-352 lineage), §H.5 (perf).
- `tests/stealth-primitives.mjs` — reference impl, all helpers
  verbatim-portable to dapp.
- `tests/stealth-math.test.mjs` — 40+ unit tests covering every
  code path the dapp integration relies on.
- `tests/stealth-signet-e2e.mjs` — bare-sats signet round-trip,
  already passing.
- `tests/stealth-signet-extended.mjs` — multi-output, P2TR,
  multi-input, chained-stealth (in flight at time of writing).
- `spec/design/BLINDED-PUBKEY-COMPAT-AUDIT.md` — verified
  unchanged surfaces.
- `spec/design/BLINDED-PUBKEY-ROADMAP.md` — class-1 follow-up
  ordering.
