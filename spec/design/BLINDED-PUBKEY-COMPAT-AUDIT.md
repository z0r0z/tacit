# Blinded-Pubkey Amendment — Backwards-Compatibility Audit

> Verification that adopting `SPEC-BLINDED-PUBKEY-AMENDMENT.md`
> does not break any existing tacit state, opcode, asset UTXO,
> wallet, or worker behavior. Treats the amendment as
> additive-only and walks through every potentially affected
> surface explicitly.
>
> Audit date: 2026-05-19. Pre-rollout review.

---

## Audit principle

The amendment is verified backwards-compatible iff:

1. Every shipped envelope wire format remains byte-identical and
   continues to parse / validate.
2. Every existing asset UTXO remains identifiable and spendable
   by its current holder using their current wallet software,
   without upgrade.
3. Existing addresses (classical bech32 / bech32m) keep
   receiving classical-shaped outputs.
4. Worker validators, indexers, and chain-scan loops continue to
   produce identical state for any block sequence that doesn't
   contain new-scheme operations.
5. No consensus rule change. No `SPEC.md` §5.5 unknown-opcode
   trigger affecting old wallets seeing chain state.
6. Mainnet TAC asset (`f0bbe868…d1aa7194efe3e9a1ef1bde43f94762b`,
   1500+ wallets) and signet test assets remain fully functional.

If any check fails, the amendment must be revised before
implementation begins.

---

## §1. Shipped envelope wire formats — unchanged

Per `SPEC-BLINDED-PUBKEY-AMENDMENT.md §E.4`, class-2 transfer
recipients (the largest surface) require **zero envelope-level
changes**. The recipient marker change lives entirely at the
Bitcoin output script layer, which the validator does not inspect
as part of envelope validation.

### Verified unchanged (no wire-format byte change):

| Opcode | Status | Verification |
|---|---|---|
| `T_CXFER` (`0x23`) | ✅ unchanged | Envelope decoder + validator dispatch byte-identical. Dust output script is not parsed by the worker as part of envelope validation. |
| `T_CXFER_BPP` (`0x22`) | ✅ unchanged | Same |
| `T_AXFER` (`0x26`) | ✅ unchanged | Same |
| `T_AXFER_BPP` (`0x3C`) | ✅ unchanged | Same |
| `T_AXFER_VAR` (`0x37`) | ✅ unchanged | Same |
| `T_AXFER_VAR_BPP` (`0x3D`) | ✅ unchanged | Same |
| `T_DEPOSIT` (`0x29`) | ✅ unchanged | Out of scope for the amendment |
| `T_WITHDRAW` (`0x2A`) | ✅ unchanged (in v1) | Class-1 opt-in field is proposed for future amendment; v1 envelope unchanged |
| `T_SLOT_MINT` (`0x43`) | ✅ unchanged | Out of scope |
| `T_SLOT_BURN` (`0x44`) | ✅ unchanged (in v1) | Class-1 opt-in field proposed for future amendment |
| `T_SLOT_ROTATE` (`0x45`) | ✅ unchanged | Out of scope |
| `T_SLOT_SPLIT` (`0x46`) | ✅ unchanged | Out of scope |
| `T_SLOT_MERGE` (`0x47`) | ✅ unchanged | Out of scope |
| `T_LP_ADD` (`0x2D`) | ✅ unchanged | Class-2 (dust output only) |
| `T_LP_REMOVE` (`0x2E`) | ✅ unchanged | Class-2 (dust output only) |
| `T_SWAP_VAR` (`0x32`) | ✅ unchanged (in v1) | trader_commit migration proposed; v1 unchanged |
| `T_SWAP_BATCH` (`0x2F`) | ✅ unchanged | Ceremony-gated; pre-launch |
| `T_SWAP_ROUTE` (`0x33`) | ✅ unchanged | Out of scope for v1 |
| `T_INTENT_ATTEST` (`0x30`) | ✅ unchanged | Out of scope (attester reputation is a feature) |
| `T_PROTOCOL_FEE_CLAIM` (`0x31`) | ✅ unchanged | Optional case |
| `T_FARM_INIT` (`0x34`) | ⚠ already shipped with launcher_commit | Shipped form is already the blinded-pubkey shape; no further change |
| `T_LP_BOND` (`0x35`) | ⚠ already shipped with bonder_commit | Same |
| `T_LP_UNBOND` (`0x36`) | ⚠ already shipped with unbonder_commit | Same |
| `T_LP_HARVEST` (`0x3B`) | ⚠ already shipped with harvester_commit | Same |
| `T_FARM_REFUND` (`0x3E`) | ⚠ already shipped with launcher_commit | Same |
| `T_CBTC_TAC_DEPOSIT` (`0x49`) | ⚠ already shipped with depositor_recovery_commit | Pre-activation; cBTC.tac wasn't on mainnet at the field change |
| `T_CBTC_TAC_DEPOSIT_ATOMIC` (`0x57`) | ⚠ already shipped with depositor_recovery_commit | Same |
| `T_CTAC_LIEN_SPLIT` (`0x4F`) | ⚠ uses position.depositor_recovery_commit | Same |
| `T_CBTC_TAC_TOP_UP` (`0x59`) | ⚠ same | Same |
| `T_CBTC_TAC_BOND_RELEASE` (`0x5A`) | ⚠ same | Same |

"⚠ already shipped" rows: the construction is already deployed
under cBTC.tac and farms via their respective amendments. Those
amendments landed pre-activation (cBTC.tac) / pre-mainnet (farms)
so there is no live state to migrate. The blinded-pubkey amendment
formalizes the construction those amendments already use; it
doesn't change them.

---

## §2. Asset UTXOs — all remain identifiable and spendable

### Existing classical asset UTXOs

Every asset UTXO created before the amendment is a `(txid, vout)`
indexed by the worker with a Pedersen amount commit and an
asset_id. The dust output script for such UTXOs is whatever the
sender's dapp chose at creation time — historically
`P2WPKH(hash160(recipient_pub))`.

**Spendability check:** the holder of `recipient_priv` continues to
spend any such UTXO using standard ECDSA against
`hash160(recipient_pub)`. The amendment does not change any
classical-output-script-spending behavior.

**Identifiability check:** the holder's wallet scans for outputs at
`hash160(wallet.pub)` per the standard CXFER scan loop. Continues
to find every classical receipt. The new dual-scan path
(§D.2) is purely additive — it adds an ECDH-derived candidate
commit check; it doesn't remove or alter the classical check.

### Mainnet TAC and signet test assets

The mainnet TAC asset (`f0bbe868…d1aa7194efe3e9a1ef1bde43f94762b`,
1500+ live wallets) operates entirely under the classical scheme.
No TAC UTXO is affected by the amendment. No TAC holder needs to
update their wallet.

Signet test assets (cBTC.zk pool test deposits, AMM signet pools,
cBTC.tac signet rehearsal) likewise unchanged.

### cBTC.zk slot UTXOs

Slot UTXOs at `K_btc` are out of scope for the amendment per
`SPEC-BLINDED-PUBKEY-AMENDMENT.md §4` of the roadmap — `K_btc =
r_leaf · G` is already a per-slot single-generator construction;
the amendment can't improve on it and doesn't touch it.

Slot recovery (e.g., `T_SLOT_BURN` payout to a recipient address)
is proposed as a class-1 follow-up but not included in v1. v1
slot operations unchanged.

---

## §3. Existing classical addresses — keep receiving

Bech32 / bech32m addresses at any existing HRP (`bc`, `tb`, `bcrt`,
plus any tacit-specific HRPs already in use) keep receiving
classical-shaped outputs. The amendment reserves NEW HRPs
(`tcs` / `tcsts` / `tcsrt` per §D.1) that don't collide with any
existing HRP — bech32m HRP parsing distinguishes them cleanly.

A sender's wallet observing a recipient's classical address emits
classical-shaped outputs (per the amendment's §D.1 — old wallets
don't recognize the new HRP, so a classical address is the only
parseable form, hence the only form they emit to).

A sender's wallet observing a recipient's stealth-capable address
emits stealth-shaped outputs. Old wallets fail to parse the
stealth address (correctly, per §D.1 rule 6 — no silent fallback)
and surface a clear error to the user ("this wallet does not
support tacit stealth addresses; please update"). No funds are
emitted to the wrong address; no funds are lost.

---

## §4. Worker validators / indexers / chain scan — unchanged

### Worker validator dispatch

Per `SPEC.md §5.5`, workers dispatch on opcode byte. New opcodes
(if any class-1 follow-up amendments reserve them) trigger the
unknown-opcode skip rule on workers that haven't upgraded — they
ignore the envelope and continue scanning. For workers that have
upgraded, new opcodes route to the new validator branch.

**For v1, the blinded-pubkey amendment reserves zero new opcodes**
(per §E.4 of the amendment). Worker validator dispatch is
byte-identical pre- and post-amendment.

### Indexer state

Asset UTXOs continue to be indexed by `(txid, vout, asset_id,
amount_commit)`. The Bitcoin output script doesn't enter the
indexer's state representation; class-2 stealth outputs are
indexed identically to classical outputs. The recipient identity
isn't part of indexer state at all — that's wallet-side.

### Chain scan loops

Cron-driven chain scans on the worker walk new blocks, parse
envelopes, update validator state, persist to KV. None of these
steps involve the recipient pubkey at the dust output level.
Worker behavior is unchanged.

---

## §5. SPEC.md §5.5 unknown-opcode rule

§5.5 of the main SPEC specifies that any tacit envelope with an
opcode byte the indexer doesn't recognize is silently ignored.
This load-bearing rule allows soft-fork-additive opcode reservation.

The blinded-pubkey amendment relies on §5.5 only for any **future**
class-1 amendments that introduce new opcodes (e.g., a future
mixer-withdraw amendment with an optional `recovery_commit` field
might be packaged as a new opcode variant rather than an extension
to `T_WITHDRAW`). For v1, no new opcode is added; §5.5 is not
triggered by the amendment itself.

---

## §6. Recipient wallet behavior — fully additive

A wallet upgraded to support stealth scanning:

1. Continues to scan for classical receipts at
   `P2WPKH(hash160(wallet.pub))`. **Unchanged behavior.**
2. Adds ECDH-derived candidate-commit scanning per §D.2. **New
   behavior on additional candidate addresses.**

If the scanner's stealth code path fails (bug, unsupported tx
type, etc.), the classical scan still finds classical receipts.
The wallet degrades gracefully — worst case, the user sees only
classical receipts and stealth ones go undetected until the bug
is fixed.

A wallet NOT upgraded:

1. Continues to scan for classical receipts. **Unchanged behavior.**
2. Doesn't add the ECDH path. **Misses stealth receipts**, but no
   sender ever emits stealth-shaped outputs to this wallet
   (because the wallet doesn't advertise a stealth-capable
   address per §D.1).

Either way: classical receipts always work.

---

## §7. Sender wallet behavior — fully additive

A wallet upgraded to support stealth emission:

1. Continues to emit classical outputs to classical addresses.
   **Unchanged behavior.**
2. Adds stealth emission for stealth-capable addresses. **New
   behavior triggered only by parsing a stealth-HRP recipient
   address.**

A wallet NOT upgraded:

1. Continues to emit classical outputs. **Unchanged.**
2. Fails to parse stealth addresses (per §D.1 rule 6). **Refuses
   to send**, with a clear error to the user. **No misrouted
   funds.**

---

## §8. cBTC.zk mixer pool & ceremony

The mixer (`SPEC.md §5.10–§5.11`) operates on its own envelope
opcodes (`T_DEPOSIT`, `T_WITHDRAW`) and its own Groth16 ceremony.
The amendment does NOT touch the mixer's wire format, validator,
or ceremony. A class-1 follow-up adding `recovery_commit` to
`T_WITHDRAW` would be packaged as a separate amendment.

**Verified:** mixer ceremony pool state, leaf commitments, nullifier
set, Groth16 verifier, and chain-scan logic all unchanged.

---

## §9. AMM ceremony

The AMM Phase-2 trusted setup ceremony (`SPEC-AMM-FARM-AMENDMENT.md`
references) operates on the `T_SWAP_BATCH` circuit and its
verifying-key materials. The amendment does NOT touch:

- The AMM circuit or its verifying key
- `T_SWAP_BATCH` wire format
- `T_SWAP_VAR` wire format
- Pool state, reserve accounting, LP-share derivation

A future class-1 amendment that adds `trader_commit` to
`T_SWAP_BATCH` would require coordinating with the ceremony
schedule (since changing the public-input shape of the circuit
requires a new ceremony or a circuit update). The blinded-pubkey
amendment v1 explicitly defers this — the AMM trader surface
listed in `SPEC-BLINDED-PUBKEY-AMENDMENT.md §C` is **proposed,
not normative**, and won't ship without a separate amendment that
also addresses the ceremony question.

**Verified:** AMM ceremony unchanged; no coordination required for
v1 blinded-pubkey rollout.

---

## §10. dapp/tacit.js shipped code paths

Code paths verified unchanged for v1 blinded-pubkey rollout:

- `encodeTCxferPayload` / `decodeTCxferPayload` — byte-identical.
- `encodeTAxferPayload` / `decodeTAxferPayload` — byte-identical.
- `scanHoldings` classical receipt detection — unchanged. Class-2
  scan path is additive.
- Pedersen amount-recovery via existing CXFER ECDH amount keystream
  — unchanged. Class-2 stealth keystream reuses the same ECDH but
  derives via a different domain tag; coexists without interaction.
- Asset UTXO ancestry walks — unchanged.
- Bulletproof / BP+ range proof verification — unchanged.

---

## §11. Worker shipped code paths

- `worker/src/index.js` envelope decoders for all opcodes —
  byte-identical.
- Worker KV state for AMM pools, mixer leaves, asset UTXOs,
  positions, intents — all unchanged.
- Cron scan loops — unchanged.
- HTTP endpoints (`/farm/...`, `/pool/...`, `/slot-...`, etc.) —
  unchanged.

---

## §12. Audit conclusion

The blinded-pubkey amendment v1 is **fully backwards-compatible**
with all existing tacit state, wire formats, and code paths.
Adoption is opt-in at the recipient-address-format layer; no
existing wallet, UTXO, or coin requires migration or upgrade.

**Risk classes**:

| Risk | Class | Mitigation |
|---|---|---|
| Existing UTXOs become unspendable | ✗ none | Amendment doesn't touch UTXO format |
| Existing addresses lose receipt ability | ✗ none | Classical addresses keep emitting + receiving classical outputs |
| Worker validator state diverges | ✗ none | Validator dispatch + state unchanged |
| Mainnet TAC asset affected | ✗ none | Out of scope for v1 |
| AMM ceremony coordination required | ✗ none | Class-1 AMM trader surface deferred to separate amendment |
| Mixer ceremony coordination required | ✗ none | Mixer wire format unchanged |
| Old wallets miss receipts | ✓ structurally prevented | Stealth addresses don't parse on old wallets → senders can't emit stealth to them |
| New scanner bug causes silent receipt loss | ✓ low | Classical scan still works; degrades gracefully |
| Forward-compat lock-in | ✓ low | Version + mode bytes in address format leave room for revisions |

**No protocol changes, no breaking changes, no migration risk.**

---

## §13. Pre-test checklist

Before any signet test of class-2 stealth functionality:

- [ ] This audit reviewed by a second party
- [ ] Reference implementation passes unit tests for bech32m
  encoding/decoding (parser rejects malformed, version mismatches,
  cross-network HRPs)
- [ ] Reference implementation passes unit tests for
  `deriveBlindedRecipientCommit` (sender side) and
  `derivBlindedRecipientCommitForScan` (recipient side) producing
  matching outputs given matching inputs
- [ ] Reference implementation passes unit tests for the
  per-vout_index anchor disambiguation (multi-output txs)
- [ ] Reference implementation passes unit tests for the
  even-Y handling at P2TR spend time (vs P2WPKH spend, which has
  no Y constraint)
- [ ] Backwards-compat regression: existing classical CXFER /
  AXFER tests on signet pass without modification
- [ ] Address-format integration: dapp UI parses both classical
  and stealth addresses correctly, refuses to silently fall back
- [ ] Signet round-trip: two wallets, sender emits stealth dust
  marker, recipient scanner detects + spends

If any item fails, address before proceeding.
