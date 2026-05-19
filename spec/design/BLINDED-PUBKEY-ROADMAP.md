# Blinded-Pubkey Commit — Implementation Roadmap

> Operational tracker for applying `SPEC-BLINDED-PUBKEY-AMENDMENT.md`
> across the tacit protocol surface. Distinct from the amendment
> itself: the amendment is normative spec; this is the working
> checklist of where the construction applies, in what order, with
> what migration risk.
>
> Last reviewed: 2026-05-19.

## Terminology

| Layer | Term | Where used |
|---|---|---|
| **Cryptographic primitive** | "blinded-pubkey commit" | `SPEC-BLINDED-PUBKEY-AMENDMENT.md`, code (`deriveCbtcTacRecoveryCommit`), per-opcode spec references |
| **User-facing capability** | "shielded address" | dapp UI, marketing copy, user-visible toggles. Pairs naturally with "shielded amount" (the existing Pedersen-based capability) |
| **Industry-aligned synonym** | "stealth address" / "BIP-352-style payments" | external comms, cross-protocol references, when invoking BIP-352 lineage helps audience comprehension |

The protocol surfaces two opt-in capabilities side-by-side:

- **shielded amount** (current default) — Pedersen-hidden amount, recipient pubkey visible at the dust marker
- **shielded amount + shielded address** (opt-in) — both hidden; per-tx unique recipient address

Recipients opt into the stronger mode via address format; senders honor the choice.

## Status legend

| Marker | Meaning |
|---|---|
| ✅ shipped | Construction in production code; cited in normative spec |
| 🛠️ in-flight | Spec drafted, code in progress |
| 📝 proposed | Spec slot reserved; no code yet |
| 🚫 don't apply | Analyzed; structural reason the construction can't help |
| ⏸️ deferred | Applies in principle but blocked on coordination (e.g., live orders) |

---

## §1. Spec-normative deployments (some still pending code migration)

### cBTC.tac (`SPEC-CBTC-TAC-AMENDMENT.md`)

| Opcode | Field | Status | Anchor |
|---|---|---|---|
| `T_CBTC_TAC_DEPOSIT` (`0x49`) | `depositor_recovery_commit` | ✅ shipped | `target_leaf_hash` |
| `T_CBTC_TAC_DEPOSIT_ATOMIC` (`0x57`) | `depositor_recovery_commit` | ✅ shipped | `target_leaf_hash` |
| `T_CTAC_LIEN_SPLIT` (`0x4F`) | depositor sig verifies under `x_only(position.depositor_recovery_commit)` | ✅ shipped | (uses position field) |
| `T_CBTC_TAC_TOP_UP` (`0x59`) | same | ✅ shipped | (uses position field) |
| `T_CBTC_TAC_BOND_RELEASE` (`0x5A`) | same | ✅ shipped | (uses position field) |

### AMM farms (`SPEC-AMM-FARM-AMENDMENT.md`)

⚠️ **Status correction (audit 3.1):** the farm amendment specifies
these commit fields normatively, but the dapp and worker
implementations still decode cleartext `*_pubkey` fields. The
spec-side rename is complete; the code-side migration is pending.
Treat the rows below as "🛠️ spec normative; code pending" rather
than "shipped."

| Opcode | Field | Status | Anchor |
|---|---|---|---|
| `T_FARM_INIT` (`0x34`) | `launcher_commit` | 🛠️ spec normative; dapp + worker pending | `pool_id \|\| farm_nonce` |
| `T_FARM_REFUND` (`0x3E`) | `launcher_commit` (matched to farm record); refund payout at `P2TR(x_only(commit))` | 🛠️ spec normative; code pending | (uses farm record field) |
| `T_LP_BOND` (`0x35`) | `bonder_commit`; bond-receipt marker `P2TR(x_only(commit))` at `vout[1]` | 🛠️ spec normative; code pending | `farm_id \|\| bond_nonce` |
| `T_LP_UNBOND` (`0x36`) | `unbonder_commit` (must match `bond.bonder_commit`); payouts at `P2TR(x_only(commit))` | 🛠️ spec normative; code pending | (uses bond record field) |
| `T_LP_HARVEST` (`0x3B`) | `harvester_commit` (must match `bond.bonder_commit`); reward at `P2TR(x_only(commit))` | 🛠️ spec normative; code pending | (uses bond record field) |

---

## §2. Pre-launch / pre-activation — easy adoption, no migration risk

Surfaces with no live mainnet state. Adopt the construction directly when the opcode lands.

### cBTC.tac follow-on opcodes (pre-activation; §5.42 bootstrap not yet met)

| Opcode | Field to add | Anchor | Effort |
|---|---|---|---|
| `T_CBTC_TAC_WITHDRAW` (`0x4A`) | `recovery_commit` for bond return UTXO; pay `vout[1]` to `P2TR(x_only(commit))` | `target_leaf_hash` | spec only (already partly in dapp) |
| `T_CBTC_TAC_FORCE_CLOSE` (`0x4B`) | recovery commit on slash payouts | `target_leaf_hash \|\| slash_height` | spec + dapp |
| `T_SHARE_SLASH_CLAIM` (`0x4C`) | claim recipient commit | `claim_nullifier` | spec + dapp |
| `T_CBTC_TAC_WITHDRAW_ATOMIC` (`0x58`) | recovery commit | `target_leaf_hash` | spec + dapp |

### AMM trader surface (ceremony-gated; pre-launch)

| Opcode | Field to add | Anchor | Effort |
|---|---|---|---|
| `T_SWAP_BATCH` (`0x2F`) | `trader_commit` replaces cleartext `trader_pubkey` | `intent_id` | spec change; trader-side dapp; worker; tests. Ships with the AMM ceremony anyway, so no extra coordination cost |
| `T_SWAP_VAR` (`0x32`) | `trader_commit` (optional; trader can use classical for variable-amount flows where dapp prefers fresh subkey UX) | `intent_id` | spec + dapp; can land before ceremony |
| `T_SWAP_ROUTE` (`0x33`) | `trader_commit` per hop | `intent_id` | spec + dapp |
| `T_INTENT_ATTEST` (`0x30`) | attester pubkey — see §5 below; probably not applicable | n/a | n/a |

### LP-share recipient (when AMM trader surface lands)

| Opcode | Field to add | Anchor | Effort |
|---|---|---|---|
| `T_LP_ADD` (`0x2D`) | LP-share output recipient commit | `pool_id \|\| add_nonce` | spec + dapp |
| `T_LP_REMOVE` (`0x2E`) | asset payouts to recipient commit | `pool_id \|\| remove_nonce` | spec + dapp |

---

## §3. Phased rollout — shipped surfaces, careful migration

The amendment splits stealth use into two classes (see SPEC-BLINDED-PUBKEY-AMENDMENT.md §C):

- **Class 1 — validator-coordinated commits.** Envelope carries a commit field the validator dispatches on. Per-opcode wire-format change required.
- **Class 2 — pure-dapp transfer recipients.** The recipient marker is a Bitcoin output script chosen by the sender's dapp; the protocol layer doesn't see it. **No opcode reservation, no wire-format change.**

### Class 2 — CXFER / AXFER transfer recipients (biggest user-flow upgrade)

**Critical design insight:** no new opcodes needed. The protocol-layer envelope (`T_CXFER`, `T_AXFER`, `T_AXFER_VAR`, BP+ twins) carries `recipient_commit` as a Pedersen amount commitment at the protocol layer. The validator identifies the recipient by the Pedersen commit, not by the Bitcoin script of the dust marker. The worker indexes by `(txid, vout)` plus envelope commits — the Bitcoin output script is irrelevant to protocol-level state. **Only the recipient's wallet cares**, and the recipient finds receipts via the scanner rule in SPEC-BLINDED-PUBKEY-AMENDMENT.md §D.2.

| Opcode | Status | Migration approach |
|---|---|---|
| `T_CXFER` (`0x23`) | 📝 proposed (dapp + scanner only; no opcode reservation) | Sender's dapp emits dust marker at `P2WPKH(hash160(commit_compressed))` instead of `P2WPKH(hash160(P_recipient))` when paying a stealth-capable address. Recipient's scanner dual-scans per §D.2. **Zero envelope-level changes, zero worker changes.** |
| `T_CXFER_BPP` (`0x22`) | 📝 proposed (dapp + scanner only) | Same |
| `T_AXFER` (`0x26`) | 📝 proposed (dapp + scanner only) | Same |
| `T_AXFER_BPP` (`0x3C`) | 📝 proposed (dapp + scanner only) | Same |
| `T_AXFER_VAR` (`0x37`) | 📝 proposed (dapp + scanner only) | Same |
| `T_AXFER_VAR_BPP` (`0x3D`) | 📝 proposed (dapp + scanner only) | Same |
| `T_LP_ADD` (`0x2D`) LP-share recipient marker | 📝 proposed (dapp + scanner only) | Same |
| `T_LP_REMOVE` (`0x2E`) payout markers | 📝 proposed (dapp + scanner only) | Same |

**Effort:** focused dapp+scanner work per surface — no spec amendment per opcode required (one global address-format amendment + scanner spec covers all of them simultaneously). Per-opcode is maybe 1–2 days of dapp scanner integration work. The aggregate work is in one amendment + one dapp scanner refactor, not per-opcode amendments.

### Class 1 — Mixer / slot payouts (wire-format change required)

| Opcode | Status | Migration approach |
|---|---|---|
| `T_WITHDRAW` (`0x2A`) | 📝 proposed: add optional `recovery_commit` field to envelope; payout at `P2TR(x_only(commit))` | Optional field; old envelopes (no field) keep working. New envelopes opt into stealth recipient. Wire-format change because the validator needs to construct the payout script from the envelope. |
| `T_SLOT_BURN` (`0x44`) | 📝 proposed: same shape | Same |
| `T_SLOT_SPLIT` (`0x46`) | 📝 proposed: per-output recipient commit | Same; validator routes per-output payouts |
| `T_SLOT_MERGE` (`0x47`) | 📝 proposed: recipient commit on the produced slot | Same |

**Effort:** lighter than originally scoped — the wire-format extension is small (one optional 33-byte field per envelope), and the dapp scanner already handles slot/withdraw recipient detection.

### Orderbook intent records (off-chain coordination)

| Surface | Status | Migration approach |
|---|---|---|
| Atomic intent `maker_pubkey` (`SPEC.md §5.7.6`) | ⏸️ deferred | Schema-versioned record: v1 carries cleartext, v2 carries `maker_commit`. Workers validate both during a transition window. Active intents naturally expire (≤365 days per `§5.7.6`). No consensus break. |
| Variable-fill bid `bidder_pubkey` (`SPEC.md §5.7.7`) | ⏸️ deferred | Same shape |
| Claim `taker_pubkey` (`SPEC.md §5.7.6`) | ⏸️ deferred | Same shape — taker_commit derived per-claim |

**Effort:** off-chain only — no opcode/envelope changes; just worker schema bump + dapp builder/parser. ~3–5 days.

---

## §4. Don't apply — analyzed, structural reasons

| Surface | Why skip |
|---|---|
| `T_SLOT_MINT` (`0x43`) | `K_btc = r_leaf · G` is already a per-slot single-generator construction; `r_leaf` is independent of `wallet.priv`. Slots don't cluster to the wallet pubkey at the protocol layer. Trick can't improve on what's already there. |
| `T_SLOT_ROTATE` (`0x45`) old owner field | Old owner pubkey equals K_btc, already public from the slot's mint. |
| `T_DEPOSIT` (`0x29`) | Input UTXO's prevout is on chain regardless of envelope construction. Bitcoin chain-graph layer; protocol commits don't reach this. |
| Bond TAC source addresses (e.g., `bond_source_outpoint`) | Real Bitcoin spend keys, not protocol identity. Chain-graph privacy requires a fresh Bitcoin wallet (staking subkey infrastructure handles this); blinded-pubkey commit doesn't help. |
| Protocol-fee sentinel pubkeys (`AMM.md §3792 AMM_PROTOCOL_FEE_SENTINEL_INSURANCE`) | Designed as a public, structural-not-a-pubkey constant (leading 0x01 byte). Privacy is anti-goal here — sentinel must be globally verifiable as not-a-key. |

---

## §5. Optional / case-by-case (skip by default)

Surfaces where the construction technically applies but the privacy benefit is unwanted or marginal.

| Surface | Default | Notes |
|---|---|---|
| `T_INTENT_ATTEST` (`0x30`) attester pubkey | 🚫 skip | Settlers/attesters often want stable identity for reputation. Privacy would interfere with the social trust layer. |
| `T_PROTOCOL_FEE_CLAIM` (`0x31`) claimer pubkey | 📝 optional | Pool launcher's choice — if claimer wants to be identifiable for accounting, classical; if anonymizing fees, use commit. |
| `T_RANGE_ATTEST` (`0x3A`) holder pubkey | 🚫 skip | Persistent attestation identity is the point. Privacy would defeat the use case (reputation, KYC tier proofs, governance weight). |
| `T_WRAPPER_ATTEST` (`0x38`) issuer signing | 🚫 skip | Issuer reputation is load-bearing for the wrapper convention. |
| `T_DROP` (`0x12`) claim recipients | 📝 optional | Drop creator picks: identifiable drops (attribution) vs anonymous drops (private airdrops). |
| `T_FARM_INIT` (`0x34`) `protocol_fee_address` (if not sentinel) | 📝 optional | Already supports the privkey-less sentinel for insurance routing. Privkey-bearing recipients can opt in. |

---

## §6. Naming + UX recommendation

**In the dapp UI:** use "shielded address" for the user-facing capability name. Pairs naturally with "shielded amount." Avoid "stealth" in default UI copy — it has a slightly conspiratorial connotation that the spec's careful framing doesn't deserve.

**In external comms / docs:** use "BIP-352-style shielded addresses" or "BIP-352-like payments" when audience comprehension benefits from invoking the lineage. Both honest, both accurate.

**In code:** use `blindedPubkeyCommit` / `recovery_commit` / `_commit` suffix throughout. Avoid `stealth_*` naming except where it specifically refers to the new opcode variants (`T_CXFER_STEALTH`, etc.) reserved by the rollout amendments.

**Default mode for new users:** shielded address ON for personal wallets (cBTC.tac, AMM trader, peer payments). OFF for explicitly-identified surfaces (merchant onboarding, treasury setup, public donation addresses).

**Per-receipt override:** the receive screen exposes both classical and shielded address formats. User picks per context (an invoice URL for a merchant might publish the classical address; a Twitter bio might publish the shielded one).

---

## §7. Migration tracking — milestones per opcode

For each phased-rollout surface, track:

1. **Spec** — wire format reserved, anchor registered in `SPEC-BLINDED-PUBKEY-AMENDMENT.md §C`
2. **Dapp builder** — encoder + scanner + spend-path tweaked_sk derivation
3. **Worker validator** — decoder + chain-scan dispatch + state-machine updates
4. **Tests** — wire roundtrip + adversarial + scanner + recovery-from-seed
5. **Signet** — e2e harness against live signet pool
6. **Mainnet** — activation gated by dapp/worker capability detection

Per-opcode rows can carry a `[✓ spec | ✓ dapp | _ worker | _ tests | _ signet | _ mainnet]` strip when work starts.

Already done (for reference):

```
cBTC.tac depositor_recovery_commit:  [✓ spec | ✓ dapp | ✓ worker | _ tests | _ signet | n/a]
Farm launcher_commit:                [✓ spec | _ dapp | _ worker | _ tests | _ signet | n/a]
Farm bonder/unbonder/harvester:      [✓ spec | _ dapp | _ worker | _ tests | _ signet | n/a]
```

---

## §8. Cross-references

- `SPEC-BLINDED-PUBKEY-AMENDMENT.md` — normative primitive (construction, derivation variants, anchor registry, soundness)
- `SPEC-CBTC-TAC-AMENDMENT.md §5.36.7` — first deployment + worked example
- `SPEC-AMM-FARM-AMENDMENT.md` — launcher/bonder/unbonder/harvester deployments
- `AMM.md` "LP privacy via blinded-pubkey commits" — narrative for the AMM-side audience
- `BIP-340` / `BIP-341` / `BIP-352` — upstream Bitcoin BIPs for the cryptographic and silent-payment lineage
- `AMENDMENTS.md` — global amendment status index
