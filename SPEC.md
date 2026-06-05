# tacit protocol specification

> **Status:** v1. Wire format is envelope version `0x01`. Canonical opcode table at §1.1 enumerates every assigned, drafted, reserved, and free opcode byte across SPEC.md + all amendments in `spec/amendments/` — that table is the single source of truth before drafting a new opcode. Runs on signet + mainnet — the dApp's in-page privkey (auto-generated, imported, or locally bound to an external wallet's address) is what signs every protocol op (see §2). This spec is the authoritative reference for indexer implementations and audit review.

## 1. Overview

tacit is an **indexer-validated meta-protocol on Bitcoin** that
extends the Runes/Ordinals pattern past plain tokens. It rides on
Bitcoin's existing consensus by encoding asset-protocol envelopes
inside Taproot script-path witness data. Validity is enforced by
**indexers** that any party can run and reach the same verdict
from chain data alone — no consensus change, no federation, no
off-chain proof exchange.

Tacit applies that pattern across a wider surface than earlier
Bitcoin meta-protocols:

- **Confidential value** — every on-chain amount is a Pedersen
  commitment with an aggregated bulletproof rangeproof and a
  Mimblewimble-style kernel signature; supply conservation holds
  without revealing amounts.
- **Anonymous spend** — a Tornado-style shielded pool (Poseidon-
  Merkle tree + Groth16 + nullifier) decouples deposit from
  withdrawal; the same circuit is reused for the cBTC.zk slot
  semantics that lock real BTC at a Taproot key derived from a
  mixer note's secret.
- **Native AMM** — uniform-clearing-price block-batched market
  with confidential per-trader amounts and mixer-composable LP
  shares; pool reserves are public numbers the indexer tracks, no
  UTXO holds any pool's funds.
- **Trustless wrapped BTC** — `cBTC.zk` slots use the mixer's
  cryptographic primitives to lock and redeem BTC with no
  federation and no co-signer.
- **Fungible wrapped BTC** — `cBTC.tac` composes a cBTC.zk anchor
  with an LP-share lien on the canonical (TAC, tETH) AMM pool,
  with over-collateralization providing the bond. The
  collateral substrate is itself indexer-validated value (the same
  market-validated value any Rune carries), structurally aligned
  into the wrapping mechanism.

See [`spec/CIRCUITS.md`](./spec/CIRCUITS.md) for how the two
Groth16 circuit families (mixer's anonymous-spend +
AMM's amount-confidentiality) compose across these surfaces.

Compared to other Bitcoin token meta-protocols:
- **Runes / BRC-20** — public amounts, tokens only. tacit hides
  amounts and goes further into AMM, wrapped BTC, anonymous spend.
- **RGB / Taproot Assets** — privacy via off-chain proof
  distribution; recipient must receive validity proofs from the
  sender out-of-band. tacit keeps everything on chain at the cost
  of larger witnesses, with the benefit of trustless privkey-only
  recovery.
- **Liquid Confidential Transactions** — same CT primitives,
  federated sidechain. tacit lives on Bitcoin proper.
- **Bitcoin rollups / sidechain AMMs (Citrea, Botanix, Liquid
  SideSwap)** — provide AMM and wrapped BTC under rollup operator
  or federation trust. tacit's AMM and cBTC.zk wrapping live on
  L1 indexer-validated state with no operator set.

### 1.1 Canonical opcode table

This table is the **single source of truth** for opcode-byte assignments
across SPEC.md and every amendment in `spec/amendments/`. Before drafting
an amendment that introduces a new opcode, scan this table for collisions
and pick from the explicitly-listed free slots. The legend:

- ✅ **shipped**: in production worker + dapp, on signet, validators enforce wire format.
- 📝 **drafted**: spec amendment exists, may have reference impl in `tests/`; not yet enforced in production.
- 🔒 **reserved**: opcode byte claimed by an amendment for future activation; nobody else may use it.
- ⬜ **free**: unassigned, may be claimed by a new amendment.

| Opcode | Op | Status | Source | Description |
|---|---|---|---|---|
| `0x21` | `T_CETCH` | ✅ shipped | SPEC §5.1 | Issue a new asset with a hidden initial supply. Optionally mintable. |
| `0x22` | `T_CXFER_BPP` | ✅ shipped (signet bake) | SPEC §5.21 | Confidential transfer with Bulletproofs+ aggregated rangeproof. Byte-identical to `T_CXFER` (`0x23`) except for the rangeproof bytes; ~14% smaller witness. Mainnet activation pending signet bake completion (`bppEnabled()` defaults ON for signet, OFF for mainnet via `tacit-bpp-enable-mainnet-v1` localStorage flag). |
| `0x23` | `T_CXFER` | ✅ shipped | SPEC §5.2 | Transfer (split) confidential value between parties. Optional opt-in shielded recipient (§5.2.1) emits per-tx unique recipient marker — see SPEC-BLINDED-PUBKEY amendment. |
| `0x24` | `T_MINT` | ✅ shipped | SPEC §5.3 | Issuer issues additional supply on a mintable asset. |
| `0x25` | `T_BURN` | ✅ shipped | SPEC §5.4 | Any holder destroys part or all of their balance. Burn amount is public. |
| `0x26` | `T_AXFER` | ✅ shipped | SPEC §5.7 | CXFER variant that allows non-tacit auxiliary inputs (e.g., a buyer's BTC payment) in the same Bitcoin tx, enabling atomic single-tx OTC settlement. |
| `0x27` | `T_PETCH` | ✅ shipped | SPEC §5.8 | Permissionless-mint deployment record. Declares ticker, decimals, lifetime cap, fixed per-mint amount, and a height window. Creates **no** supply UTXO; deployer receives zero tokens. |
| `0x28` | `T_PMINT` | ✅ shipped | SPEC §5.9 | Permissionless mint event against a `T_PETCH` ancestor. Anyone may broadcast. Mints exactly `mint_limit` tokens; reveals `(amount, blinding)` so any chain reader can audit cumulative supply against the cap. |
| `0x29` | `T_DEPOSIT` | ✅ shipped | SPEC §5.10 | Lock a fixed-denomination UTXO into a shielded pool — appends a Poseidon leaf commitment `Poseidon(secret, ν, denomination)` to the pool's Merkle tree. Same opcode with `denomination = 0` is `POOL_INIT` (creates a new pool). |
| `0x2A` | `T_WITHDRAW` | ✅ shipped | SPEC §5.11 | Anonymous mint from a shielded pool. Produces a fresh tacit UTXO of the pool's denomination at vout[0], gated on a Groth16 proof of unspent leaf membership. Withdraw recipient is unlinkable to any specific deposit. |
| `0x2B` | `T_DROP` | ✅ shipped | SPEC §5.12 | Lock existing supply of an asset into a public-claim pool. Spends one or more tacit UTXOs of `asset_id` summing to `cap_amount`; declares `(per_claim, cap_amount, merkle_root)` in the envelope. Supply-preserving. |
| `0x2C` | `T_DCLAIM` | ✅ shipped | SPEC §5.13 | Permissionless claim event against a `T_DROP` ancestor. Anyone may broadcast (subject to the parent drop's optional Merkle-eligibility gate). Mints exactly `per_claim` tokens from the drop pool. |
| `0x2D` | `T_LP_ADD` | 📝 drafted | `AMM.md` §5.14 | Add liquidity to a confidential constant-product AMM pool. The `variant=1` sentinel doubles as `POOL_INIT`. |
| `0x2E` | `T_LP_REMOVE` | 📝 drafted | `AMM.md` §5.15 | Burn confidential LP-share UTXOs for proportional withdrawal of pool reserves. |
| `0x2F` | `T_SWAP_BATCH` | 📝 drafted | `AMM.md` §5.16 | Settle N confidential swap intents against a pool at one uniform clearing price per direction. Single Groth16 proof. |
| `0x30` | `T_INTENT_ATTEST` | 📝 drafted | `AMM.md` §5.17 | Scope-generic preconfirmation channel attestation. Used by batched-AMM coordinators and other scoped settlement surfaces. No Groth16 / no ceremony. |
| `0x31` | `T_PROTOCOL_FEE_CLAIM` | 📝 drafted | `AMM.md` §5.18 | Mint accrued protocol fee shares from a pool's `protocol_fee_reserve` to the configured fee recipient. |
| `0x32` | `T_SWAP_VAR` | 📝 drafted | `SPEC-SWAP-VAR-AMENDMENT.md` §5.20 | Per-trade variable-amount AMM swap. No batching, no clearing price, no Groth16 — sigma cross-curve proof binds trader's `delta_in_commitment` to the pool's reserve delta. |
| `0x33` | `T_SWAP_ROUTE` | 📝 drafted | `SPEC-SWAP-ROUTE-AMENDMENT.md` §5.22 | Atomic multi-hop AMM routing (2..N_HOPS_MAX=4 hops in one Bitcoin tx). Reuses `T_SWAP_VAR` kernel-sig + bulletproof stack; no Groth16, no ceremony. (Reassigned from `T_LP_ADD_RANGE` reservation — range-LP amendment never drafted; range-LP allocation moved to `0x3F`–`0x42`.) |
| `0x34` | `T_FARM_INIT` | 📝 drafted | `SPEC-AMM-FARM-AMENDMENT.md` §5.40 | Launcher-funded LP-staking reward farm creation. Virtual treasury (no on-chain UTXO); kernel-sig closure on launcher's reward-asset input. (Reassigned from `T_LP_REMOVE_RANGE` reservation.) |
| `0x35` | `T_LP_BOND` | 📝 drafted | `SPEC-AMM-FARM-AMENDMENT.md` §5.41 | Bond `lp_asset_id` shares against a farm. Per-bond worker-indexed record keyed by `vout[1].outpoint`; Q.96 `entry_acc_per_share` snapshot for lazy accrual. (Reassigned from `T_LP_REPOSITION` reservation.) |
| `0x36` | `T_LP_UNBOND` | 📝 drafted | `SPEC-AMM-FARM-AMENDMENT.md` §5.42 | Settle bond: validator mints fresh `lp_asset_id` + reward UTXOs by decree, deletes bond record. BIP-340 sig by `bonder_pubkey`. (Reassigned from `T_LP_MIGRATE_V` reservation.) |
| `0x37` | `T_AXFER_VAR` | ✅ shipped | SPEC §5.7.6.1, §5.7.9 | Variable-amount atomic settlement: T_AXFER with a bulletproofs range proof on the buyer's auxiliary BTC leg. |
| `0x38` | `T_WRAPPER_ATTEST` | ✅ shipped | SPEC §5.19 | Optional on-chain wrapper-issuer attestation pinning an external-wallet → tacit-key binding so wallet-portable identity becomes auditable by third parties. |
| `0x39` | `T_TRADE_BATCH` | 📝 drafted | `SPEC-TRADE-BATCH-AMENDMENT.md` §5.20 | Atomic cross-surface settlement: settles N AMM intents + K orderbook bilateral pairs in one Bitcoin tx. (Reassigned from 0x43 to fix collision with `T_SLOT_MINT`.) |
| `0x3A` | `T_RANGE_ATTEST` | 📝 drafted | `SPEC-RANGE-ATTEST-AMENDMENT.md` §5.21 | Persistent on-chain range-attestation envelope binding a holder pubkey to a `commitment ≥ K` claim. Power-user feature (KYC tier proofs, reputation, governance weight). (Reassigned from 0x44 to fix collision with `T_SLOT_BURN`.) |
| `0x3B` | `T_LP_HARVEST` | 📝 drafted | `SPEC-AMM-FARM-AMENDMENT.md` §5.43 | Claim accrued farm reward without unbonding the underlying LP shares (MasterChef `harvest()` equivalent). Updates `bond.entry_acc_per_share` to canonical exit; does NOT touch `farm.total_bonded`. |
| `0x3C` | `T_AXFER_BPP` | 📝 drafted | `SPEC-AXFER-BPP-AMENDMENT.md` | BP+ variant of `T_AXFER` (`0x26`). Byte-identical wire shape modulo opcode + rangeproof bytes; ~14% smaller witness on every atomic OTC settlement. |
| `0x3D` | `T_AXFER_VAR_BPP` | 📝 drafted | `SPEC-AXFER-BPP-AMENDMENT.md` | BP+ variant of `T_AXFER_VAR` (`0x37`). Byte-identical wire shape (N=2 + asset_input_count=1 tightenings + interleaved vout layout + mandatory OP_RETURN(80) preserved) modulo opcode + rangeproof bytes. |
| `0x3E` | `T_FARM_REFUND` | 📝 drafted | `SPEC-AMM-FARM-AMENDMENT.md` §5.44 | Launcher reclaims unspent `treasury_remaining` strictly after `end_height + AMM_FARM_REFUND_GRACE_BLOCKS` (~7 days). Single-shot, full-amount. Preserves "no privileged operator mid-stream" property. |
| `0x3F` – `0x42` | `T_LP_ADD_RANGE` / `T_LP_REMOVE_RANGE` / `T_LP_REPOSITION` / `T_LP_MIGRATE_V` | 🔒 reserved | `SPEC-AMM-RANGE-LP-AMENDMENT.md` (TBD) | Concentrated-liquidity / range-LP follow-up amendment. Reassigned from the original `0x33`–`0x36` block when those slots were taken over by `T_SWAP_ROUTE` and the farm opcodes. |
| `0x43` | `T_SLOT_MINT` | ✅ shipped | `SPEC-CBTC-ZK-AMENDMENT.md` §5.21 | Self-custody-slot wrapper atomic mint. Locks BTC at `K_btc = r_leaf · G_secp256k1`. |
| `0x44` | `T_SLOT_BURN` | ✅ shipped | `SPEC-CBTC-ZK-AMENDMENT.md` §5.22 | Self-custody-slot wrapper atomic redeem. |
| `0x45` | `T_SLOT_ROTATE` | ✅ shipped | `SPEC-CBTC-ZK-AMENDMENT.md` §5.23 | Self-custody-slot wrapper atomic transfer (key rotation). |
| `0x46` | `T_SLOT_SPLIT` | ✅ shipped | `SPEC-CBTC-ZK-FUNGIBILITY-AMENDMENT.md` §5.24 | Atomic 1→N slot split, ΣD_new = D_old. |
| `0x47` | `T_SLOT_MERGE` | ✅ shipped | `SPEC-CBTC-ZK-FUNGIBILITY-AMENDMENT.md` §5.25 | Atomic N→1 slot merge, ΣD_old ≥ D_new. |
| `0x48` | `T_SLOT_NOTE` | 🔒 reserved | `SPEC-CBTC-ZK-FUNGIBILITY-AMENDMENT.md` §5.26 | Encrypted slot note attachment. |
| `0x49` | `T_CBTC_TAC_DEPOSIT` | ✅ shipped (v1 lien model) | `SPEC-CBTC-TAC-AMENDMENT.md` §5.47 | LP-share lien mint: cBTC.zk slot (backing) + LP-share lien on canonical (TAC, tETH) pool → cBTC.tac. |
| `0x4A` | `T_CBTC_TAC_WITHDRAW` | ✅ shipped (v1 lien model) | `SPEC-CBTC-TAC-AMENDMENT.md` §5.47 | Cooperative unwind: burn cBTC.tac → release LP-share lien + spend slot K_btc. |
| `0x4B` | `T_CBTC_TAC_FORCE_CLOSE` | ✅ shipped (v1 lien model) | `SPEC-CBTC-TAC-AMENDMENT.md` §5.47 | Permissionless lien transfer to claim pool when LP-share BTC value < 1.2× slot. |
| `0x4C` | `T_CTAC_LIEN_CLAIM` | ✅ shipped (v1 lien model) | `SPEC-CBTC-TAC-AMENDMENT.md` §5.47 | Burn cBTC.tac → mint pro-rata LP-share from claim pool. (Wire format preserved as `T_SHARE_SLASH_CLAIM`.) |
| `0x4D` | `T_SLOT_FRACTIONALIZE` | 🔒 reserved | `SPEC-CBTC-ZK-AMOUNT-AMENDMENT.md` §5.25 | Slot → standard tacit shares. Reserved for future activation. |
| `0x4E` | `T_SLOT_RECONSOLIDATE` | 🔒 reserved | `SPEC-CBTC-ZK-AMOUNT-AMENDMENT.md` §5.26 | Standard tacit shares → slot. Reserved for future activation. |
| `0x4F` | `T_CTAC_LIEN_SPLIT` | ✅ shipped (v1 lien model) | `SPEC-CBTC-TAC-AMENDMENT.md` §5.47 | Split a liened LP-share UTXO into multiple outputs; lien inherits onto one chosen output (must still meet 2× collateral). |
| `0x50` | `T_GOV_PROPOSAL` | 📝 drafted | `SPEC-GOVERNANCE-AMENDMENT.md` | TAC DAO proposal. |
| `0x51` | `T_GOV_VOTE` | 📝 drafted | `SPEC-GOVERNANCE-AMENDMENT.md` | TAC DAO vote. |
| `0x52` | `T_GOV_VETO` | 📝 drafted | `SPEC-GOVERNANCE-AMENDMENT.md` | TAC DAO veto. |
| `0x53` | `T_GOV_EXECUTE` | 📝 drafted | `SPEC-GOVERNANCE-AMENDMENT.md` | TAC DAO execute. |
| `0x54` | `T_CUSD_TAC_DEPOSIT` | 📝 drafted | `SPEC-CUSD-TAC-AMENDMENT.md` §6.3 | Open cUSD.tac position. |
| `0x55` | `T_CUSD_TAC_WITHDRAW` | 📝 drafted | `SPEC-CUSD-TAC-AMENDMENT.md` §6.4 | Close cUSD.tac position. |
| `0x56` | `T_CUSD_TAC_FORCE_CLOSE` | 📝 drafted | `SPEC-CUSD-TAC-AMENDMENT.md` §6.5 | Permissionless cUSD.tac liquidation. |
| `0x57` | `T_CBTC_TAC_DEPOSIT_ATOMIC` | ✅ shipped | `SPEC-CBTC-TAC-AMENDMENT.md` §5.48 | Atomic LP_ADD + cBTC.tac DEPOSIT — single envelope; depositor provides the cBTC.zk backing slot + raw TAC + tETH bond-pool inputs, worker LPs the latter and attaches lien on the new LP-share UTXO and mints cBTC.tac. |
| `0x58` | `T_CBTC_TAC_WITHDRAW_ATOMIC` | ✅ shipped | `SPEC-CBTC-TAC-AMENDMENT.md` §5.49 | Atomic cBTC.tac WITHDRAW + LP_REMOVE — single envelope; burns cBTC.tac, spends slot K_btc, removes the freed LP shares, pays out BTC + TAC + tETH. |
| `0x59` | `T_CBTC_TAC_TOP_UP` | ✅ shipped | `SPEC-CBTC-TAC-AMENDMENT.md` §5.50 | Strengthen bond on an open cBTC.tac position (add LP-share collateral without touching the slot or the minted cBTC.tac). Lien-replacement under `commitmentForUtxo` enforcement. |
| `0x5A` | `T_CBTC_TAC_BOND_RELEASE` | ✅ shipped | `SPEC-CBTC-TAC-AMENDMENT.md` §5.51 | Partial bond release on an open cBTC.tac position (release LP-share collateral while ratio stays above the maintenance floor). Symmetric inverse of §5.50. |
| `0x5B` | `T_PREAUTH_BID` | ✅ shipped | `SPEC-PREAUTH-BID-AMENDMENT.md` §5.7.11 | Buyer-offline preauth bid. Symmetric counterpart to §5.7.8 preauth-sale: buyer pre-signs sats input + canonical bid-context OP_RETURN under `SIGHASH_SINGLE_ACP` (`0x83`), any seller appends asset UTXO + payout output and broadcasts. Reuses `T_AXFER` kernel-sig + Pedersen + bulletproof stack; only new validator rule is the OP_RETURN binding tying buyer's pre-sig to `(asset_id, recipient, amount, blinding, price_sats)`. Closes the "sells just work" UX gap where every existing bid path requires the buyer to be online. Family head for the **preauth/offline-trading block** (`0x5B`–`0x5E`). (Reassigned from initial `0x59` draft when the canonical opcode table was reconciled against shipped cBTC.tac extended ops.) |
| `0x5C` | `T_PREAUTH_BID_VAR` | ✅ shipped | `SPEC-PREAUTH-BID-VAR-AMENDMENT.md` §5.7.12 | Variable-amount preauth-bid (partial-fill). Buyer publishes `(min_fill, max_fill, price_per_unit, fill_increment)` and K = (max-min)/inc + 1 `SIGHASH_SINGLE_ACP` pre-signatures (one per allowed fill ratio). Seller picks a ratio, attaches the matching pre-sig, settlement includes an indexer-enforced refund vout for the unfilled portion. Extends §5.7.11 with per-ratio inline section + K-sig bid record + refund-vout validator rule. The "holy grail" set-and-forget partial-fill bid UX; mirrors §5.7.6.1 / `T_AXFER_VAR` on the buyer-offline side. Signet-validated end-to-end (`tests/preauth-bid-var-onchain-e2e-signet.mjs`). |
| `0x5D` – `0x5E` | `T_PREAUTH_BID_BATCH` / `T_PREAUTH_MATCH` | 🔒 reserved | `SPEC-PREAUTH-BID-AMENDMENT.md` "Follow-up primitives" | Preauth/offline-trading family follow-ups: batched-fill preauth-bid-var (one seller fills N preauth-bids in one settlement tx, ~70% fee reduction symmetric to §5.7.8.1) and both-sides preauth (third-party fulfiller cross-matches a preauth-sale and a preauth-bid into one settlement, both parties fully offline). Reserved adjacent to the preauth/offline-trading family head at `0x5B` so the family stays contiguous as the variants draft. |
| `0x5F` – `0xFF` | — | ⬜ free | — | Available. Note: `SPEC-WORKER-BOND-AMENDMENT.md` tentatively names `0x5F`/`0x60`/`0x61` for `T_WORKER_BOND_OPEN` / `T_WORKER_BOND_CLOSE` / `T_WORKER_SLASH` (shifted from its prior tentative `0x5B`–`0x5D` claim once the preauth/offline-trading family block at `0x5B`–`0x5E` was reserved); final assignments lock at merge time. |

**Process for claiming a new opcode**:
1. Scan the table above for free slots (⬜ rows).
2. Prefer placement adjacent to related opcodes (e.g., a new AMM op near `0x2D`-`0x32`, a new slot op near `0x43`-`0x47`).
3. Update this table in the same commit that introduces the amendment.
4. Update `worker/src/index.js`, `dapp/tacit.js`, and any reference impl in `tests/` to match.
5. Cross-implementation parity is enforced by `tests/cross-impl-vectors-gen.mjs` + `tests/amm-spec-conformance.test.mjs` — opcode bytes appearing in pre-sig digests must agree with this table.

### 1.2 Legacy descriptive paragraph

(Retained for historical context; superseded by §1.1 above.)

Operations summary: tacit envelope opcodes span `0x21, 0x23–0x32, 0x37, 0x38` for SPEC.md-merged behavior; `0x39, 0x3A` for drafted V1.x amendments (TRADE_BATCH, RANGE_ATTEST); `0x43–0x4C` for the shipped slot + cBTC.tac families; `0x50–0x56` for drafted governance + cUSD.tac; `0x57–0x5A` for the shipped cBTC.tac extended block (deposit/withdraw atomics + top-up + bond-release); and `0x5B–0x5E` for the drafted preauth/offline-trading family (`T_PREAUTH_BID` plus three reserved follow-ups). Runs on signet + mainnet — the dApp's in-page privkey (auto-generated, imported, or locally bound to an external wallet's address) is what signs every protocol op (see §2).

## 2. Trust model

| Trusted for | Mitigation if compromised |
|---|---|
| **Bitcoin (host chain)** — tx ordering, witness integrity, no double-spends | None: this is the substrate |
| **Indexer code** (the dApp HTML or a re-implementation) — correct enforcement of the rules in this spec | Re-host, audit, pin by content hash. Two browsers running the same code reach the same verdict |
| **`@noble/secp256k1` and `@noble/hashes`** — crypto primitives | Vendored under `dapp/vendor/tacit-deps.min.js` and pinned by IPFS CID alongside `dapp/index.html` + `dapp/tacit.js`. Build pipeline at `build/`; runtime KAT in `runStartupKAT()` is independent defense |
| **In-page tacit privkey** (localStorage) — signs every tacit op (P2WPKH spend, taproot script-path, kernel sig, mint authority) and is the HMAC key for blinding/keystream derivations | This is the wallet for tacit assets. It can be (a) auto-generated on first load, (b) imported from a privkey hex the user holds, or (c) **locally bound** to an external wallet's address when the user connects Xverse/UniSat/Leather. All three paths store the privkey under a `localStorage` key namespaced by **network** (`tacit-wallet-v1:signet` vs `tacit-wallet-v1:mainnet`) and, in case (c), additionally by the external wallet's address (`tacit-wallet-v1:<network>:by:<extAddr>`); reconnecting the same external wallet on the same network *in the same browser profile* re-binds to the same tacit identity. **Note:** the locally-bound case is local binding, not cryptographic derivation from the external wallet's seed — clearing localStorage or switching browsers/devices will yield a different tacit identity even if the external wallet is the same. In all three cases this in-page key is what controls asset UTXOs and must be exported and backed up. Mainnet UX gates every value-creating op behind an export-and-acknowledge step. Hardware-wallet signing for the protocol's signing paths (kernel sig, taproot script-path, HMAC-blinding) is a future enhancement — current external-wallet support does not expose those primitives. |
| **The asset's etcher (issuer)** — *the announced initial supply is what they say it is* | Out of scope cryptographically at the protocol layer (Pedersen hides the supply, so no third party can verify the announcement without the issuer's opening). Resolved at the client layer by publishing the `(supply, blinding)` opening — §7.3 spells out the IPFS-primary, worker-cached attestation flow that the reference dApp ships on by default. The protocol guarantees no inflation *downstream of etch* either way. |
| **The asset's mint authority** (mintable assets only) — *minting decisions* | Holder of the `mint_authority` private key from the CETCH envelope |

What is **not** trusted:
- Any external server (worker, IPFS gateway, mempool API) for protocol-level validity. Workers in this repo are pure caches/conveniences; setting `WORKER_BASE = ''` disables them and the protocol still works.
- Off-chain proof distribution (RGB-style). Wallets recover full balance from privkey + chain alone.
- Watchtowers, federation members, or any third party.

## 3. Cryptographic primitives

> The primitives below are the building blocks. For how they
> compose into the protocol's two circuit families and where each
> family is reused across surfaces (mixer, cBTC.zk slots, AMM,
> cBTC.tac), see [`spec/CIRCUITS.md`](./spec/CIRCUITS.md). For
> term definitions that overlap across surfaces (shielded amount
> vs shielded address; leaf vs slot; lien vs bond), see
> [`spec/GLOSSARY.md`](./spec/GLOSSARY.md).

### 3.1 Curve and generators

- Curve: **secp256k1** (BIP-340 conventions for Schnorr).
- `G`: standard secp256k1 base point. Used as the **blinding generator**.
- `H`: NUMS (nothing-up-my-sleeve) generator, derived as:
  ```
  seed   = SHA256("tacit-generator-H-v1")
  for counter in 0..256:
      x = SHA256(seed || [counter])
      candidate = 0x02 || x   # try compressed, even Y
      if (point parses && nonzero):
          H = candidate
          break
  ```
  Used as the **value generator** in Pedersen commitments.

- Bulletproof vector generators `G_vec[i]`, `H_vec[i]` (`i ∈ [0, 64·8)`): same try-and-increment pattern with domain `"tacit-bp-G-v1"` and `"tacit-bp-H-v1"` plus 4-byte LE index.
- Bulletproof aux generator `Q`: derived with domain `"tacit-bp-Q-v1"`.

All of these have **no known discrete log** with respect to each other, justified by NUMS construction.

**Reference test vectors** (compressed-point hex, for cross-implementation parity):

```
H        = 02bd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56
Q        = 0279b66e857697b21949facaa998d6c31e4636f81f442c63f84bea33e83baafda4
G_vec[0] = 025cfa02a4913b0b122c4f275ae566e6ba52627d80036e25a43a3fd5d2062f28d4
G_vec[1] = 027608f5161dd88146ab22635ad357622a7e3fd9a293efd6fc21d18b50efab7c4e
G_vec[2] = 022f8c08dda9ade0264065a6770b219a5ee82c872f627d4503c4c3292472f1fb23
G_vec[3] = 02add28339b32e0e27075cb6cdee409acf07860ba5bf7cdca07cabf50947ed5a55
H_vec[0] = 02b78ed462f5c137b05d1e99daeb2619eb890ec4781acf098018628ca0ec0d20e2
H_vec[1] = 02ac4ee8f1ded833bf18be0815b9602b4fe0d586ade57923b35ef22e3e7c1e6ce2
H_vec[2] = 02795d359afdced0c4c7735bf61f24cdab214d43301f5210eefd46b96657a708a8
H_vec[3] = 02b65a170dfd727dd403cda635ddd2419882da910f6f79e10b24c4e5f3d171c76c
```

A re-implementation that types one of the domain strings wrong silently produces different generators and rejects every proof from the canonical implementation. These vectors are the cross-check.

### 3.2 Pedersen commitment

`C = a · H + r · G` where `a` is the amount (BigInt), `r` is the blinding scalar.

Properties:
- **Hiding** (perfect / information-theoretic): for uniformly random `r`, `C` is uniformly distributed in the group regardless of `a`, so `C` alone reveals nothing about `a` even to an unbounded adversary.
- **Binding** (computational, under the unknown-discrete-log assumption for `H` w.r.t. `G`): finding a different opening `(a', r') ≠ (a, r)` with the same `C` is equivalent to computing `log_G(H)`. The NUMS construction in §3.1 is what justifies this assumption.
- **Additively homomorphic**: `C₁ + C₂ = (a₁+a₂)·H + (r₁+r₂)·G`.

### 3.3 Bulletproofs aggregated rangeproof

Bünz et al. 2017 §3 (IPA) + §4.3 (aggregated range proof) at **n = 64 bits**. m ∈ {1, 2, 4, 8} aggregation.

Public inputs: `m` Pedersen commitments `V_j = v_j · H + γ_j · G`. Proof: `v_j ∈ [0, 2⁶⁴)` for all j.

Verifier optimizations in this implementation:
- **IPA verifier collapse**: reduce log(nm) recursive G/H vector updates to a single multi-scalar multiplication.
- **Pippenger MSM**: signed-digit windowed buckets (`c=4` for 33–128 points, `c=5` for >128). Cuts naïve O(N · 256) point-ops to O(N + 2 · 2^c) per window.
- **Batch verification**: combine N range proofs into one multi-exp using random linear combination with per-proof α (t̂ check) and β (IPA check). Soundness: failure probability ≤ 2/order ≈ 2⁻²⁵⁵.

### 3.4 BIP-340 Schnorr

Standard. Used for:
- Tap-script-path signatures on commit-reveal flows.
- **Kernel signatures** for CXFER / BURN (under the message hash defined in §5.2).
- **Mint authorization signatures** for T_MINT (under the message hash defined in §5.5).

### 3.5 Domain-separated HMAC-SHA256 derivations

All deterministic blindings + amount-encryption keystreams are HMAC-SHA256 keyed by either:
- `wallet_priv` (self-derivations), or
- `SHA256(ECDH(my_priv, their_pub).x)` (peer-derivations).

Tagged by a v1 domain string + per-output `(anchor || vout_LE)`. Domain tags **for on-chain blinding/keystream derivations** (the set this section governs):

| Tag | Purpose | Where used |
|---|---|---|
| `tacit-blind-v1` | ECDH-derived recipient blinding scalar | CXFER recipient output |
| `tacit-change-v1` | Self-derived change blinding scalar | CXFER + BURN change outputs |
| `tacit-etch-v1` | Etcher's supply blinding scalar | CETCH supply commitment |
| `tacit-mint-blind-v1` | Issuer's mint blinding scalar | T_MINT new-supply commitment |
| `tacit-amount-v1` | ECDH-derived recipient amount keystream (8B) | CXFER recipient `amount_ct` |
| `tacit-amount-self-v1` | Self-derived amount keystream (8B) | CXFER + BURN change `amount_ct` |
| `tacit-etch-amount-v1` | Etcher's supply keystream (8B) | CETCH `amount_ct` |
| `tacit-mint-amount-v1` | Issuer's mint keystream (8B) | T_MINT `amount_ct` |

Other domain-separated v1 tags appear where they're used and are not part of this table:

- **BIP-340 Schnorr signature-message tags:** `tacit-kernel-v1` (§5.2, §5.4, §5.7, §5.20), `tacit-mint-v1` (§5.3), `tacit-disclosure-v1` (§5.6), `tacit-axintent-{v1,claim-v2,fulfilment-v1,cancel-v1}` (§5.7.6), `tacit-axintent-{publish-v1,claim-v3,fulfilment-v2}` (§5.7.6.1 variable-amount intents), `tacit-bid-{intent-v1,claim-v1,cancel-v1}` (§5.7.7), `tacit-preauth-sale-{v1,cancel-v1}` (§5.7.8), `tacit-pool-init-v1` (§5.10.1), `tacit-deposit-v1` (§5.10), `tacit-drop-v1` (§5.12), `tacit-drop-reclaim-v1` (§5.12.1), `tacit-amm-{lp-add-v1,lp-remove-v1,intent-v1,launcher-gate-v1,protocol-fee-claim-v1}` (§5.14–§5.16, §5.18; AMM.md is the architectural reference), `tacit-amm-swap-var-v1` (§5.20 `intent_msg` domain), `tacit-intent-attest-v1` (§5.17; scope-generic preconfirmation channel attestation — used by both AMM and orderbook surfaces, see `spec/amendments/SPEC-ORDERBOOK-CHANNEL-AMENDMENT.md` for orderbook scope schemas), `tacit-wrapper-attest-v1` (§4.2.4, §5.19).
- **SHA256 domains (not Schnorr messages):** `tacit-withdraw-bind-v1` is the SHA256 domain for the `T_WITHDRAW` `bind_hash` (§5.11); `tacit-axintent-id-v1` is the SHA256 domain for the content-addressed `intent_id` derivation for variable-amount intents (§5.7.6.1 *Intent record*).
- **HMAC keystream domains:** `tacit-axintent-blinding-v1` for the per-intent `r` encryption ciphertext stored in the worker fulfilment record (§5.7.6); `tacit-axintent-onchain-amount-v1` and `tacit-axintent-onchain-blinding-v1` for the on-chain encrypted `(amount, r)` carried in the optional `OP_RETURN(40)` at the reveal tx (§5.7.6 *Recovery model*); `tacit-axintent-change-v1` for the maker's self-change blinding scalar at variable-amount fulfilment (§5.7.6.1); `tacit-axintent-onchain-maker-amount-v1` and `tacit-axintent-onchain-maker-blinding-v1` for the maker's half of the mandatory `OP_RETURN(80)` recovery payload (§5.7.6.1 *On-chain recovery*). For T_SWAP_VAR (§5.20): `tacit-amm-swap-var-receipt-v1` (HMAC of `r_receipt` from trader privkey + pool + anchor), `tacit-amm-swap-var-recv-v1` (HMAC of receipt P2WPKH recipient address), `tacit-amm-swap-var-change-v1` (HMAC of `r_change` for the change UTXO), `tacit-amm-swap-var-tip-v1` (HMAC of `r_tip` for the settler-tip output).
- **Generator derivations:** `tacit-generator-H-v1` and `tacit-bp-{G,H,Q}-v1` (§3.1).
- **Bulletproof Fiat-Shamir transcript:** `tacit-bp-v1` (§3.3).
- **Off-chain coordination tags** (defined by their worker endpoints in §8): `tacit-opening-v1`, `tacit-listing-{v1,cancel-v1,claim-v1}`, `tacit-listing-range-{v1,cancel-v1,claim-v1}`, `tacit-airdrop-{leaf-v1,node-v1,claim-v1,claim-delete-v1}` — the airdrop leaf/node/claim-v1 formats are reused by §5.13's on-chain canonical claim msg; the other off-chain tags live entirely outside the on-chain protocol.

**Endianness convention.** Throughout this spec, `txid_BE` denotes the txid in the byte order that `SHA256(serialized_tx)` natively produces — the same bytes a Bitcoin transaction puts on the wire when it references a previous output. This is the **reverse** of the displayed/RPC hex form (e.g. `getrawtransaction` output, block-explorer URLs). In wider Bitcoin documentation this on-wire order is often called "internal" or "LE"; tacit's `_BE` label is not standard but is fixed by the test vectors in §3.1 (and `tests/vectors.test.mjs`). Implementers should treat any `_BE` field as `reverseBytes(hexToBytes(displayed_txid))`. `_LE` on integer fields (e.g. `vout_LE`, `amount_LE`) means standard little-endian integer encoding.

Anchor construction:
- **CXFER / T_AXFER / BURN**: `anchor = first_asset_input_txid_BE || first_asset_input_vout_LE`. The first asset input is `tx.vin[1]` in all three opcodes (asset inputs come immediately after the envelope-bearing `vin[0]`; T_AXFER's aux BTC inputs are appended at the tail). Per-tx entropy prevents cross-tx correlation (`(C₁ − C₂) = (a₁ − a₂) · H` leak).
- **CETCH / T_MINT**: `anchor = first_commit_input_txid_BE || first_commit_input_vout_LE`. Anchor predates the envelope (a pre-existing UTXO), breaking the envelope/commitment cycle. Scanners read it via `reveal_tx.vin[0]` → fetch commit tx → `commit_tx.vin[0]`.

**Uniqueness invariant.** Bitcoin consensus prevents any outpoint from being spent twice, so each anchor is unique across all valid txs that reference it as a first input. Combined with the per-output `vout_LE` suffix in every keystream/blinding domain, no two outputs across all valid envelopes can ever reuse the same `(domain, anchor, vout)` triple under a given keystream. This is what makes the deterministic recovery of openings from chain + privkey alone safe.

### 3.6 Poseidon hash + per-pool Merkle tree

Mixer-pool envelopes (§5.10, §5.11) require a SNARK-friendly hash and a tree-membership proof. The reference choice is **Poseidon** over BN254 with rate=2, capacity=1, and the parameters of Grassi et al. 2020 (8 full + 57 partial rounds, MDS matrix as published, S-box `x⁵`).

For each `(asset_id, denomination)` pool that has been initialized (§5.10.1), indexers maintain a deterministic **append-only Merkle tree** of fixed depth `L = 20` (≈ 1.05M leaves). Empty leaves are the constant `EMPTY_LEAF = poseidon(0)` — single-input Poseidon over the field-element zero. Deposit leaves are appended in canonical chain order: by confirmed block height, then by `(tx_index, vin[1].outpoint)` within a block. Indexers MUST cache the last 32 historical roots per pool; withdrawals (§5.11) may reference any one of them, providing a liveness window for in-flight proofs against recently-grown trees.

Two indexers running over the same chain history reach byte-identical merkle roots and nullifier sets — pool state is a deterministic function of confirmed envelopes.

### 3.7 Groth16 zk-SNARK (one circuit, all pools)

The withdrawal envelope (§5.11) carries a Groth16 proof over **BN254 (alt_bn128)** under the canonical `withdraw.circom` verifying key (`vk`). One circuit, one ceremony, all pools: every legitimate mixer pool (and every cBTC.zk slot operation, which reuses `withdraw.circom` unmodified) pins the same `(vk_cid, ceremony_cid)` pair at `POOL_INIT`. The `vk` is content-addressed on IPFS; the `POOL_INIT` envelope's per-pool `vk_cid` / `ceremony_cid` fields are wire-format hooks reserved for a future circuit revision shipped as a separate pool surface (see §5.11.3).

Trusted setup: Powers-of-Tau (Phase 1) followed by a coordinator-chained Groth16 ceremony (Phase 2). Phase 1 is `pot14_final.ptau` from the Polygon Hermez Powers-of-Tau ceremony; Phase 2 was a public ceremony finalized at 2,227 community contributions plus a Bitcoin-block beacon (2,229 canonical attestations total). Soundness assumes ≥ 1 honest contributor across that ceremony's participants. Privacy (the witness hides) does *not* depend on the ceremony — Groth16 has perfect zero-knowledge unconditionally. See [`MIXER.md`](./MIXER.md) §"Trusted setup" for bundle layout, audit transcript, and canonical CIDs; §5.11.3 covers indexer enforcement.

### 3.8 Withdrawal circuit (canonical reference)

Public inputs (in BN254 scalar field `Fr`):
- `merkle_root`
- `nullifier_hash`
- `denomination`
- `r_leaf` — the on-chain Pedersen blinding scalar, derived deterministically from the witness (constraint 4)
- `bind_hash`

Private inputs (witness):
- `secret`, `nullifier_preimage` ∈ `Fr`
- `path_elements[L]`, `path_indices[L]`

Constraints:

1. `leaf = poseidon(secret, nullifier_preimage, denomination)`.
2. Walking `path_elements`/`path_indices` from `leaf` reproduces `merkle_root`.
3. `nullifier_hash == poseidon(nullifier_preimage)`.
4. `r_leaf == poseidon(secret, nullifier_preimage)`. The on-chain Pedersen blinding is *forced* to a deterministic function of the depositor's secret pair, so the validator's external Pedersen check (§5.11) — `pedersenCommit(denomination, r_leaf) == recipient_commitment` — fully closes the soundness gap against an inflation attack. The malicious-withdrawer attack against an in-circuit-skipped Pedersen check fails here because they cannot pick `r_leaf` freely; the circuit constrains it. **Equivalent to an in-circuit secp256k1 multi-scalar Pedersen at ~100× lower constraint cost.**
5. `bind_squared == bind_hash * bind_hash`. No-op arithmetic constraint that binds `bind_hash` into the proof's polynomial system. Without it, a relayer or mempool observer could replay a copied proof against a substituted public input. `bind_hash` covers `(asset_id, denomination, nullifier_hash, recipient_commitment, r_leaf)` — see §5.11 for the canonical computation.

Total constraint count is dominated by the merkle path (20 levels × 1 Poseidon-2) plus 3 standalone Poseidons (leaf, nullifier, r_leaf) ≈ **5–7k constraints**. Prove time on a 2024 laptop is sub-second; verify is microseconds. The footprint fits comfortably in pot17 (130k constraints) so smaller ceremonies are practical.

### 3.9 BabyJubJub (embedded curve, AMM only)

The AMM (§§5.14–5.16) introduces a second elliptic curve: **BabyJubJub**, the twisted Edwards curve `a·u² + v² = 1 + d·u²·v²` over the BN254 scalar field. Mixer envelopes (§§5.10–5.11) do not touch BabyJubJub.

| Parameter | Value |
|---|---|
| Field prime `p_Fr` | `21888242871839275222246405745257275088548364400416034343698204186575808495617` |
| `a` | `168700` |
| `d` | `168696` |
| Full group order | `21888242871839275222246405745257275088614511777268538073601725287587578984328` |
| Prime subgroup order `n_BJJ` | full / 8 = `2736030358979909402780800718157159386076813972158567259200215660948447373041` |
| Cofactor | `8` |

Parameters match circomlib's BabyJubJub byte-for-byte. Points are encoded as **compressed Edwards**: 32-byte little-endian v-coordinate with the sign of u in the high bit of byte 31. This matches circomlib's `packPoint`.

**NUMS generators.** AMM-side Pedersen commitments use two NUMS generators `H_BJJ` and `G_BJJ` derived by try-and-increment under domain tags `"tacit-amm-bjj-H-v1"` and `"tacit-amm-bjj-G-v1"`. Algorithm (matches AMM.md §"BabyJubJub NUMS try-and-increment"):

```
counter = 0
loop:
    digest = SHA256(seed_utf8 || counter_LE_u32(4))
    u      = bigint_be(digest) mod p_Fr
    lhs    = a·u² mod p_Fr
    num    = (1 - lhs) mod p_Fr
    den    = (1 - d·u²) mod p_Fr
    if den == 0: counter++; continue
    v²     = num · den⁻¹ mod p_Fr
    if v² is not a quadratic residue mod p_Fr: counter++; continue
    v      = sqrt(v²); pick the root with EVEN least-significant bit
    P      = (u, v)
    Q      = 8 · P
    if Q == identity: counter++; continue
    if n_BJJ · Q ≠ identity: counter++; continue
    return Q
```

The canonical generator coordinates (normative; any deviation indicates a domain-tag typo, wrong endianness, or wrong sqrt sign rule):

```
H_BJJ counter = 2
  u = 0x13969c921b0a36e78280a9ff5415b7756761b630fd5fa30d7537e3640cbf6da5
  v = 0x1553d34ea48b8d61df6de5ca9ae5d95183746714ba21af253a46c18a6c2279e4

G_BJJ counter = 2
  u = 0x16b271021d857578ee55d438a32eed9081bfe28579f6e671c87c58a035b49b7b
  v = 0x2447904d61713ffa77c624c908255001a5f369e2548764cb4adbc6e454ae9884
```

Reference implementation: `tests/amm-bjj.mjs`. Parity suite: `tests/amm-bjj.test.mjs` (36 tests).

### 3.10 Sigma cross-curve binding (Camenisch-Stadler)

AMM intent/receipt Pedersen commitments live on both **secp256k1** (for on-chain Bitcoin compatibility) and **BabyJubJub** (for in-circuit Groth16 arithmetic). A **169-byte sigma proof** binds the two commitments to the same hidden u64 amount `a`, without doing non-native secp256k1 EC arithmetic inside a BN254 circuit (which would cost ~600K–1M constraints per opening). The sigma is SNARK-free, no trusted setup, microseconds to prove/verify.

**Statement:** prover knows `(a, r_secp, r_BJJ)` with `a < 2^64` such that
```
C_in_secp = a·H_secp + r_secp·G_secp    (on secp256k1)
C_in_BJJ  = a·H_BJJ  + r_BJJ ·G_BJJ     (on BabyJubJub)
```

**Protocol.** Prover:
```
α       sampled uniformly in [0, 2^320 − 2^192)  via 40-byte rejection sample
β_secp  sampled uniformly in [0, n_secp)
β_BJJ   sampled uniformly in [0, n_BJJ)

A_secp  = α·H_secp + β_secp·G_secp      (on secp256k1)
A_BJJ   = α·H_BJJ  + β_BJJ ·G_BJJ       (on BabyJubJub)

e       = bigint_be(SHA256("tacit-amm-xcurve-v1"
                            || C_secp_compressed(33)
                            || C_BJJ_packed(32)
                            || A_secp_compressed(33)
                            || A_BJJ_packed(32))[16:32])
        (i.e., the low 128 bits of the digest read big-endian; `e < 2^128`)

z_a      = α + e·a                       (over the integers; bounded < 2^320)
z_r_secp = β_secp + e·r_secp mod n_secp
z_r_BJJ  = β_BJJ  + e·r_BJJ  mod n_BJJ
```

**Proof bytes (169 total, exactly):**
```
A_secp(33) || A_BJJ(32) || z_a(40, BE) || z_r_secp(32, BE) || z_r_BJJ(32, BE)
```

**Verifier:**
1. Parse proof and decode points (reject on malformation).
2. Range-check: `z_a < 2^320` (40-byte BE encoding bound), `z_r_secp < n_secp`, `z_r_BJJ < n_BJJ`.
3. Recompute `e` from the public transcript.
4. Check `z_a · H_secp + z_r_secp · G_secp == A_secp + e · C_in_secp` on secp256k1, reducing `z_a` mod `n_secp` for the secp scalar multiplication.
5. Check `z_a · H_BJJ + z_r_BJJ · G_BJJ == A_BJJ + e · C_in_BJJ` on BabyJubJub, reducing `z_a` mod `n_BJJ` for the BJJ scalar multiplication.

**The same integer `z_a` is sent on the wire and used in both equations** — the binding comes from the shared integer response, not from `z_a` fitting unreduced in either group's scalar field (`z_a < 2^320` may exceed both `n_secp ≈ 2^256` and `n_BJJ ≈ 2^251`). A cheater wanting to bind one commitment to `a_s` and the other to `a_b ≠ a_s` would need to find a single integer `z_a` whose modular reductions satisfy two different congruences post-hoc — a CRT problem at `> 2^128` work given `e < 2^128`.

**Soundness:** 128-bit Fiat-Shamir (challenge space `e < 2^128`, ≈ 2^128 SHA-256 evals to forge a transcript). **Statistical ZK:** ≥ 128-bit margin on `a` — the rejection-sampled `α` mask of `2^320 − 2^192 ≈ 2^320` over the maximum `e·a < 2^192` leaves `(α + e·a) / α` ratio ≈ `1 + 2^{-128}`. **Parameter rationale:** given `a < 2^64` (enforced by the Groth16 batch circuit's `Num2Bits(64)`) and `e < 2^128`, the product `e·a < 2^192`; the prover samples `α` uniformly in `[0, 2^320 − 2^192)` to guarantee `z_a < 2^320` deterministically (40 bytes BE). The 40-byte `z_a` slot is the wire-size cost of carrying the 128-bit-soundness response.

Reference implementation: `tests/amm-sigma-xcurve.mjs` (also exposes `proveXCurveDeterministic` — the audit-recommended production-prover path, using HMAC-SHA256 nonces derived from a long-term seed key + statement). Parity suite: `tests/amm-sigma-xcurve.test.mjs`.

## 4. Asset identity

`asset_id = SHA256(reveal_txid_BE || reveal_vout_LE)` where `reveal_vout = 0` for CETCH and T_PETCH (the etch envelope is always at the start of the reveal tx and asset_id keys off the canonical first-output position regardless of whether that vout actually carries a tacit UTXO).

This deterministically derives a 32-byte asset_id from the etch reveal transaction. T_MINT and T_PMINT envelopes reference the same `asset_id` and include `etch_txid` so the validator can resolve the originating etch envelope (CETCH for T_MINT, T_PETCH for T_PMINT — the validator rejects any cross-mode reference).

The `ticker` field is **not** unique. Multiple etches with `ticker = "USDC"` are valid; they will have distinct `asset_id` values. Wallets must display `asset_id` alongside ticker for disambiguation (same as ERC-20 contract addresses). Ticker collisions span CETCH and T_PETCH alike — the etch mode is part of an asset's identity but not part of its display name, so a CETCH `"USDC"` and a T_PETCH `"USDC"` collide on display the same way two CETCH `"USDC"` etches would.

### 4.1 LP-share asset_id (AMM origin, third asset-id origin path)

The AMM (§§5.14–5.16) introduces a third canonical asset-id origin: LP shares issued at pool initialization. The deterministic derivation is:

```
pool_id      = SHA256(
                 "tacit-amm-pool-v1"
              || asset_A          (32 B, lex-smaller)
              || asset_B          (32 B, lex-larger)
              || fee_bps_LE       (2 B,  u16, 0..1000)
              || capability_flags (1 B,  u8 bitmap)
               )
lp_asset_id  = SHA256("tacit-amm-lp-v1" || pool_id)
```

where `asset_A` is the lexicographically smaller of the two pool assets under unsigned big-endian byte compare (`asset_A < asset_B`). Including `fee_bps` and `capability_flags` in the preimage gives Uniswap V3/V4-style multi-tier parity: a single asset pair can host multiple canonical pools at distinct fee/capability tiers; each yields a distinct `pool_id` and therefore a distinct `lp_asset_id`. See AMM.md §"Pool state" for the full discriminator semantics.

**Three-origin resolution.** When an indexer or validator encounters an `asset_id` it does not yet recognize, it resolves the origin by checking — in order — whether:

1. A confirmed `CETCH` (§5.1) exists whose reveal-tx satisfies `asset_id == SHA256(reveal_txid_BE || 0_LE)`.
2. A confirmed `T_PETCH` (§5.8) exists whose reveal-tx satisfies the same equation. (CETCH and T_PETCH are mutually exclusive — a given `asset_id` matches at most one.)
3. A confirmed canonical `POOL_INIT` (§5.14 variant=1) exists whose `pool_id` satisfies `asset_id == SHA256("tacit-amm-lp-v1" || pool_id)`.

Domain separation between paths is structural: path (1)/(2) SHA256 preimages are 36 bytes (`txid_BE(32) || vout_LE(4)`); path (3) LP-asset preimages are 47 bytes (`"tacit-amm-lp-v1"(15) || pool_id(32)`); pool_id itself has an 84-byte preimage for no-skim pools (domain(17) || A(32) || B(32) || fee_bps_LE(2) || flags(1)) or a 119-byte preimage for fee-enabled pools (the above plus protocol_fee_address(33) || protocol_fee_bps_LE(2), appended iff the pool has a non-zero protocol fee per AMM.md §"Pool state"). All sizes are disjoint, so cross-origin collisions reduce to SHA256 preimage-finding under distinct domain separations and are cryptographically negligible.

Indexers maintain a reverse map keyed by `asset_id` so the lookup is constant time. The §5.5 validator algorithm extends with one additional branch: when walking an ancestry that lands on a `T_LP_ADD` or `T_LP_REMOVE` (§§5.14–5.15) producing an `lp_asset_id` UTXO, resolution path (3) is what authorises that UTXO as a real tacit asset.

Reference implementation: `tests/amm-asset.mjs`. Parity suite: `tests/amm-asset.test.mjs` (23 tests).

### 4.2 Wrapper convention (CETCH metadata extension)

#### 4.2.1 Wrapper metadata field

CETCH asset metadata (§5.1 — IPFS-pinned JCS-canonical JSON blob content-addressed by the CETCH's `image_uri`) MAY include a top-level `tacit_wrapper` field. Presence of this field declares the asset to be a **wrapper** — a tacit-native token backed by an underlying Bitcoin-layer asset (native sats, runes, ordinals, etc.) custodied by an issuer with publicly auditable reserves. Absence of the field declares the asset a plain (non-wrapper) tacit asset.

The wrapper convention is **convention-only**: no new opcode (except the optional §5.19 T_WRAPPER_ATTEST), no protocol-level change, no indexer trust requirement on any issuer. Permissionless — anyone can CETCH a wrapper-tagged asset.

The example below is annotated with `//` comments for clarity; the actual on-chain bytes are JCS-canonical JSON (RFC 8785) and do NOT contain comments. JCS canonicalisation sorts object keys alphabetically and normalises numeric encoding — encoders and decoders must round-trip through canonical form for the `image_uri` CID to match.

```jsonc
{
  // existing CETCH metadata fields: ticker, decimals, image_uri, etc.
  // ...

  "tacit_wrapper": {
    "version": 1,                        // convention version
    "underlying": {                      // what the asset wraps
      "chain": "bitcoin",                // chain identifier
      "asset": "native",                 // "native" | "rune:<rune_id>" | "ordinal:<inscription_id>"
      "unit": "satoshi"                  // base unit of the underlying
    },
    "peg": {
      "numerator": 1,                    // u64; 1 base unit of tacit asset
      "denominator": 1,                  // u64; underlying units backing per tacit base unit = denominator/numerator
      "kind": "fixed"                    // "fixed" | "oracle_priced"
    },
    "custody": {
      "kind": "multisig",                // "multisig" | "user_dlc" | "burn" | "user_custody"
      "reserve_address": "bc1p...",      // bech32; required iff kind="multisig" or "burn".
                                         // OMITTED for "user_dlc" and "user_custody" — backing
                                         // is per-holder (not a single address); see §4.2.2.
                                         // When present, MUST be used solely for wrapper
                                         // reserves (§4.2.3).
      "threshold_k": 3,                  // optional; signing threshold for multisig
      "threshold_n": 5,                  // optional; total signer count
      "escape": {                        // optional; reserve-loss mitigation
        "kind": "csv_timeout",
        "blocks": 26280                  // ~6 months; after timeout, holders can coordinate spend
      }
      // kind-specific fields ("user_dlc": oracle_aggregate_pubkey, epoch_blocks,
      // csv_escape_blocks; defined by the custody-kind amendment, see §4.2.2)
      // MAY appear alongside the above.
    },
    "redemption": {
      "fee_bps": 10,                     // maximum basis points charged on burn.
                                         // Actual fee MAY be lower (advertised
                                         // via the issuer's auto-taker intent)
                                         // but MUST NOT exceed this ceiling.
      "min_request_units": 1000,         // optional; minimum tacit-base-unit amount accepted
                                         // in EITHER direction (mint or burn).
      "endpoint": "https://..."          // optional; off-band coordination URL
    },
    "attestation": {
      "issuer_pubkey": "02ab...",        // 33-byte compressed; signs attestations
      "schedule_blocks": 144             // expected gap between attestations, in Bitcoin blocks.
                                         // Conventional values: 6 (hourly), 144 (daily),
                                         // 1008 (weekly). 0 = "on_demand" (no schedule).
      // Note: the signing-message domain is implied by `version` (= 1 ⇒
      // "tacit-wrapper-attest-v1"). No explicit domain field — version
      // pinning prevents drift.
    }
  }
}
```

All fields under `tacit_wrapper` MUST be present unless explicitly marked optional or unless the field's documentation in §4.2.2 conditions its presence on `custody.kind` (e.g., `reserve_address` is required for `multisig`/`burn` and omitted for `user_dlc`/`user_custody`). Implementations encountering an unknown `version` value MUST treat the asset as a plain (non-wrapper) asset (forward compat). Implementations encountering an unknown `custody.kind` MUST likewise treat the asset as a plain asset — kind-specific field requirements aren't decodable without the kind's amendment.

#### 4.2.2 Field semantics

**`underlying.chain`** identifies the source-layer chain. v1 supports `"bitcoin"`; future versions MAY add other chains.

**`underlying.asset`** identifies the specific asset on that chain:
- `"native"` — native chain currency (sats for Bitcoin)
- `"rune:<rune_id>"` — a specific rune (rune_id format per Runes spec)
- `"ordinal:<inscription_id>"` — a specific inscription
- Other values MAY be defined by future convention extensions.

**`underlying.unit`** names the indivisible base unit of the underlying. For Bitcoin native: `"satoshi"`. For runes: per-rune.

**`peg.numerator` / `peg.denominator`** define the exchange ratio:

```
base_units_of_tacit_asset = (underlying_units × numerator) / denominator
```

Equivalently, the underlying backing required per tacit base unit is `denominator / numerator`. Examples:

- **cBTC at 1:1 with sats**: `numerator = 1, denominator = 1`. One sat backs one cBTC base unit.
- **"100-sat cBTC unit" wrapper** (each cBTC base unit represents 100 sats of backing): `numerator = 1, denominator = 100`. Backing per cBTC base unit = 100 sats.
- **"Fractional cBTC unit" wrapper** (each cBTC base unit represents one one-hundredth of a sat — degenerate but illustrative): `numerator = 100, denominator = 1`. Backing per cBTC base unit = 1/100 sat (impossible without fractional sats; included only to show formula direction).

Implementations MUST use the *backing-per-tacit-unit* form (`denominator / numerator`) in the coverage check of §4.2.3, not the inverse.

**`peg.kind`**:
- `"fixed"` — peg is constant. Reserves backing is checked as `reserves ≥ supply × denominator / numerator`.
- `"oracle_priced"` — peg varies (e.g., USD-pegged stablecoin collateralized in sats). Coverage check requires an oracle price feed; the canonical oracle is specified by the cUSD TAC amendment (out of scope here). v1 wrappers SHOULD use `"fixed"` unless they target the canonical oracle.

**`custody.kind`** determines both the backing model and which custody fields are required:

- `"multisig"` — issuer custodies reserves in an N-of-M Taproot multisig at `reserve_address` (required). `threshold_k` and `threshold_n` describe the signing threshold. Coverage = chain-summed UTXOs at `reserve_address` ÷ expected_reserves (§4.2.3).
- `"user_dlc"` — reserves are individually held in per-user 2-of-2 DLCs (MakerDAO-style). `reserve_address` is OMITTED; backing is tracked per CDP in indexer state rather than at a single address. Coverage is derived from indexer state (Σ open-CDP collateral ÷ Σ open-CDP mints) and is 1.0 by construction except during liquidation events. Concrete realisation specified by the cUSD TAC amendment.
- `"burn"` — reserves are provably destroyed (one-way wrapping; no redemption path). `reserve_address` is the burn address (required) — typically an OP_RETURN-locked or NUMS-locked output the indexer can verify is unspendable.
- `"user_custody"` — each holder custodies their own backing (e.g., HTLC-locked sats per cBTC unit). `reserve_address` is OMITTED; backing is per-holder and fungibility constraints make this research-grade only — placeholder, no current realisation.

**`custody.reserve_address`** is the bech32 chain address where reserves are observable. Indexers compute `reserves_balance` by summing the UTXOs at this address.

**`custody.escape`** describes the holder-side mitigation if the issuer goes offline:
- `"csv_timeout"` — after `blocks` confirmations of no issuer activity, holders coordinate to spend the multisig via the CSV-locked escape path. Specifics depend on the multisig script.

**`attestation.issuer_pubkey`** signs periodic reserve-coverage attestations and the issuer's commitment to honour redemptions. Compromise of this key compromises the *issuer-attestation trustworthiness*; it does NOT compromise the reserves themselves (those are held in `reserve_address` under multisig keys).

**`attestation.schedule_blocks`** is the expected interval, in Bitcoin blocks, between successive issuer attestations. Conventional values:

- `6` blocks (~hourly): high-volume issuers wanting tight liveness
- `144` blocks (~daily): typical issuer cadence
- `1008` blocks (~weekly): low-touch issuers
- `0`: `"on_demand"` — no fixed schedule; freshness defined per indexer policy

Indexers compute `attestation_freshness_factor` as a function of the gap between `current_height` and the most recent attestation's `as_of_height`. Reference formula:

```
gap = max(0, current_height − latest_attestation.as_of_height)
freshness =
  1.0                              if schedule_blocks == 0 (on-demand)
  1.0                              if gap ≤ schedule_blocks
  max(0.0, 1.0 − (gap − schedule_blocks) / (2 × schedule_blocks))
                                    otherwise (linear decay to 0 over 2× schedule)
```

A daily-schedule issuer (144 blocks) is fully fresh up to 144 blocks late, then linearly decays to 0 over the next 288 blocks (3× total schedule duration). Tunable per dapp policy.

**`redemption.fee_bps`** is the **maximum** fee the issuer charges on burn (in basis points). Issuers MAY charge less by advertising a lower fee in their auto-taker intent, but MUST NOT charge more. Indexer scoring uses this max as the worst-case cost.

**`redemption.min_request_units`** is the minimum tacit-base-unit amount accepted in either direction (mint or burn). Setting it to 1000 means an issuer's auto-lister won't honor mint requests for fewer than 1000 base units, and the auto-taker won't accept burn requests for fewer either. Symmetry simplifies the issuer's inventory logic.

#### 4.2.3 Cryptographic reserve coverage check

Coverage is computed differently per `custody.kind`. All paths yield the same semantic — `coverage(asset) = backing / (supply × peg.denominator / peg.numerator)` — but the source of `backing` differs.

**Path A — chain-summed (`custody.kind = "multisig"` or `"burn"`).** Indexers SHOULD compute:

```
expected_reserves = supply(asset) × peg.denominator / peg.numerator
coverage(asset)   = reserves_balance(asset.custody.reserve_address) / expected_reserves
```

Where:

- `reserves_balance(addr)` is the sum of `underlying.asset` balances at `addr` (for bitcoin native: sum of UTXO values in satoshis; for runes: per-rune balance per the rune protocol; for ordinals: count of inscriptions held). For `kind = "burn"`, `reserves_balance` is monotonically non-decreasing and `supply` is monotonically non-increasing, so coverage trends upward over time (or stays flat once issuance halts).
- `supply(asset)` is the cumulative issued supply minus burned supply, derived from tacit indexer state: `Σ T_MINT amounts − Σ T_BURN amounts` for the asset_id.

**Path B — indexer-derived (`custody.kind = "user_dlc"` or `"user_custody"`).** No single `reserve_address` exists. Indexers compute `backing` as `Σ collateral across all open per-holder lockups` tracked in indexer state, and `supply` as `Σ mints against those lockups`. By construction the two move together at every open/close event, so coverage ≡ 1.0 outside in-flight liquidation windows. The specific bookkeeping is defined by the custody-kind amendment (e.g., the cUSD TAC amendment for `user_dlc`).

**Indexer support scope (Path A).** Path A is `SHOULD` (not `MUST`) because indexers cannot compute coverage for underlyings they don't speak. A tacit indexer that only knows the Bitcoin chain layer can compute coverage for `underlying.chain="bitcoin", underlying.asset="native"` trivially (UTXO sum), but for `"rune:..."` or `"ordinal:..."` it must either embed rune/ordinal protocol parsing or mark coverage as **unknown** in registry queries.

Indexers that DO support a given `(chain, asset)` pair MUST surface under-collateralised state (`coverage < 1.0`) in every query that returns the wrapper. The dapp SHOULD score under-collateralised variants proportionally lower in routing.

**Reserve isolation (MUST — Path A only).** When `custody.reserve_address` is present, it MUST be used **exclusively** for wrapper reserves. Issuers MUST NOT commingle protocol fees, treasury holdings, payment receipts, or any other non-reserve funds at this address. Commingling inflates the computed `coverage` ratio (non-reserve UTXOs are indistinguishable from reserve UTXOs at the chain layer) and is a protocol violation. v1 enforcement is reputational — indexers MAY perform heuristic detection of commingling but rigorous cryptographic enforcement requires covenants (not available on Bitcoin L1 today) and is left to a future amendment.

**No trust transferral.** The coverage check is a pure function of public on-chain data (Path A) or public indexer state derived from chain data (Path B). Anyone running an indexer can compute it. Disagreements between indexers indicate data-fetch bugs, not adversarial issuers.

**No protocol-level rejection (convention default).** Per this convention, an indexer does NOT reject transactions involving under-collateralised wrapper assets; the asset's UTXOs remain valid and spendable. The convention is advisory: it lets the ecosystem *see* under-collateralisation, not *prevent* it. Issuer competition + market pricing handle the rest. **Exception:** specific custody-kind amendments MAY impose additional protocol-level rules on transactions involving their assets (e.g., the cUSD TAC amendment constrains AMM-pool init for canonical assets). Such rules are amendment-scoped and do not override this convention's "no rejection" default for other variants.

#### 4.2.4 Issuer attestation

Issuers SHOULD periodically publish a signed attestation:

```
attestation_msg = SHA256(
    "tacit-wrapper-attest-v1"
    || network_tag(1)                 // 0x00=mainnet, 0x01=signet, 0x02=regtest
    || asset_id(32)
    || issuer_pubkey(33)
    || reserves_LE(8)                 // u64 claimed reserves at as_of_height
    || supply_LE(8)                   // claimed supply at as_of_height
    || as_of_height_LE(4)             // bitcoin block height of attestation
    || timestamp_LE(8)                // unix seconds
)

attestation_sig = BIP-340 over attestation_msg under issuer_pubkey
```

The `network_tag` byte prevents cross-network replay even if asset_ids collide across networks.

The attestation MAY be published off-chain (issuer's website, IPFS, or the tacit worker) or, optionally, on chain via §5.19 T_WRAPPER_ATTEST (`0x38`). Both carry the same `attestation_msg` content and BIP-340 signature; the on-chain path adds a non-spoofable Bitcoin-anchored timestamp at the cost of ~2 Bitcoin txs per attestation.

Attestations serve three purposes:

1. **Liveness signal.** A recent attestation proves the issuer is online. Indexers SHOULD downgrade routing weight for variants whose most-recent attestation is older than 3× the declared `schedule_blocks` interval.
2. **Commitment to honour redemption.** The attestation message binds the issuer's public commitment to the (reserves, supply) pair as of a specific height. A misbehaving issuer who subsequently rugpulls leaves a publicly-signed claim on record.
3. **Independent verification.** Any third party can fetch the attestation, verify the signature, fetch the named reserve and supply values from chain, and confirm the issuer's claim matches reality. Discrepancies are publishable.

Attestations are NOT consensus-relevant. Indexers MUST NOT use attestations to reject transactions. The attestation is a *reputation primitive*, not a *protocol primitive*.

#### 4.2.5 Indexer discovery + routing

Indexers MAINTAIN a wrapper registry derived from CETCH metadata:

```
wrapper_registry: Map<(underlying.chain, underlying.asset), Set<asset_id>>
```

Populated by:

1. **CETCH scan (primary).** Every confirmed CETCH whose metadata blob carries a `tacit_wrapper` field with a known `version` is added to the registry under its `(underlying.chain, underlying.asset)` key.
2. **Protocol-derived assets (amendment-defined).** Future amendments MAY define wrapper-tagged assets whose asset_ids are computed from spec constants rather than CETCH transactions. Such assets have no on-chain CETCH; their `tacit_wrapper` metadata is **synthesized** by the indexer per the amendment's spec text (the amendment provides the exact JCS template). Indexers post-amendment MUST include synthesized assets in the registry alongside CETCH-scanned ones. The cUSD TAC amendment defines the first such assets (canonical cBTC, canonical cUSD); see that amendment's §6.4.3.

Indexers MUST treat CETCH-scanned and synthesized variants identically for routing, coverage queries, and registry membership — the discovery path is metadata-source-specific; downstream consumers see one uniform registry.

Indexers expose two query endpoints:

```
GET /wrappers/{chain}/{asset}
  → list of variants with: asset_id, ticker, issuer_pubkey,
    coverage_ratio, latest_attestation_timestamp,
    custody.kind, custody.reserve_address, redemption.fee_bps,
    routing_score

GET /wrappers/{asset_id}
  → full tacit_wrapper metadata + computed coverage + latest
    attestation (if any) + AMM-pool depth across pairs
```

Dapps consume these endpoints to:

- Surface "send/receive BTC" UI that resolves to wrapper variants
- Route trades against best-scoring variants
- Surface coverage warnings when a variant is under-collateralised
- Show issuer attestation freshness as a trust signal

#### 4.2.6 Routing score (informative)

Reference scoring function used by the canonical dapp:

```
routing_score(variant) =
    w_coverage    × min(1.0, coverage_ratio)           // capped at 1.0
  − w_deviation   × abs(amm_price_vs_peg − 1.0)        // peg deviation
  + w_liveness    × attestation_freshness_factor       // 0.0..1.0
  − w_fee         × (redemption.fee_bps / 10000.0)     // higher fee = lower score
  + w_depth       × log10(1 + amm_total_tvl_sats)      // deeper liquidity preferred
```

Where:

- `amm_price_vs_peg` is the spot price reported by the deepest AMM pool containing this variant against the underlying-equivalent reference (e.g., for a `cBTC.*` variant, the deepest pool pairing it with any `cBTC.*` variant whose `coverage_ratio ≥ 0.98`, falling back to TAC-pair price × external BTC-quote if no same-underlying counterpart exists). Pegged at 1.0 in absence of any pool.
- `amm_total_tvl_sats` is the sat-denominated TVL across **all AMM pools containing this variant on either side**, summed: `Σ (pool.reserve_in_sats_equivalent × 2)` over those pools. Pools whose other side has no defensible sat-equivalent are skipped. Same-variant double-counting across pools is allowed (a pool's full TVL contributes to the score of both legs).
- `attestation_freshness_factor` follows the per-§4.2.4 reference formula based on the variant's declared `schedule_blocks` and observed attestation gap. Synthesized canonical variants (§4.2.5) inherit freshness from the protocol-state component they're synthesized against (e.g., for `user_dlc` canonical assets, the oracle threshold's latest T_PRICE_ATTEST height per the cUSD TAC amendment).

Reference weights (dapp-tunable, subject to change as the ecosystem matures): `w_coverage = 1.0, w_deviation = 0.5, w_liveness = 0.3, w_fee = 0.2, w_depth = 0.4`. Variants with `coverage < 0.98` are flagged for user attention. Variants with `attestation_freshness_factor < 0.3` are demoted in routing.

The scoring function is **dapp policy**, not protocol. Competing dapps MAY score differently. Issuers compete on the underlying trust signals, not on dapp ranking.

#### 4.2.7 Ticker prefix convention (informative)

The `c` prefix in tickers like `cBTC`, `cUSD`, `cRUNE.*` denotes a **confidential wrap** — a tacit-native token backed 1:1 (or oracle-priced) by an asset external to tacit. All tacit assets are amount-confidential by construction; the prefix exists to signal "this token represents external collateral inside tacit's confidentiality envelope." It does not appear on tacit-native tokens (e.g., TAC), where the property would be redundant.

This is a **naming convention**, not a protocol rule. Issuers MAY pick other tickers; indexers do not key on the prefix. The convention exists so users + dapp UI can recognize wrapped assets at a glance and so the ecosystem coordinates on a shared vocabulary for the same underlying (all `cBTC.*` variants wrap the same underlying sats).

## 5. Envelope wire format

All envelopes ride in `tx.vin[0].witness[1]` (the script-path leaf data) of a Taproot script-path spend. The witness layout is:

```
witness[0] = schnorr_sig(64 B)
witness[1] = envelope_script
witness[2] = control_block
```

`envelope_script` structure:

```
<32-byte signing pubkey> OP_CHECKSIG
OP_FALSE OP_IF
  PUSH "TACIT" (5 bytes)
  PUSH 0x01    (envelope version)
  PUSH <payload>  (split across PUSHDATA chunks ≤ 520 B each)
OP_ENDIF
```

The internal pubkey of the Taproot output is **BIP-341 NUMS** (`50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0`), so script-path is the only spend path. `OP_FALSE OP_IF … OP_ENDIF` makes the entire envelope unexecuted (similar to ordinals inscriptions).

`payload[0]` is the opcode byte. Subsections below specify each opcode's payload.

### 5.1 CETCH (`0x21`) — initial issuance

```
T_CETCH(1)
|| ticker_len(1)         u8, 1..16
|| ticker(ticker_len)    UTF-8
|| decimals(1)           u8, 0..8
|| commitment(33)        Pedersen C = supply·H + r·G (compressed)
|| amount_ct(8)          u64 LE supply XOR HMAC-keystream
|| rp_len(2)             u16 LE rangeproof length
|| rangeproof(rp_len)    aggregated bulletproof, m=1, n=64
|| mint_authority(32)    x-only Schnorr pubkey, OR all-zero (=non-mintable)
|| img_len(2)            u16 LE, 0..256
|| image_uri(img_len)    UTF-8 (typically "ipfs://bafk…")
```

Constraints:
- `decimals ≤ 8` matches Bitcoin's native unit. With 64-bit range, max display supply per asset_id at d decimals is `(2⁶⁴ − 1) / 10ᵈ`.
- `mint_authority` is permanent. A fixed-supply etch sets it to `0x00…00`; a mintable etch sets it to the issuer's wallet x-only pubkey. There is no protocol-level mechanism to rotate or transfer mint authority short of a hard fork.
- Etcher recovers `(supply, blinding)` from chain via `tacit-etch-v1` / `tacit-etch-amount-v1` derivations + commit-input anchor.

### 5.2 CXFER (`0x23`) — confidential transfer

```
T_CXFER(1)
|| asset_id(32)
|| kernel_sig(64)            Schnorr sig over kernel_msg, see below
|| N(1)                      number of outputs, ∈ {1,2,4,8}
|| (commitment(33) || amount_ct(8))  ×N
|| rp_len(2)
|| rangeproof(rp_len)        aggregated bulletproof, m=N, n=64
```

Kernel message (`in_count` and `out_count` are 1-byte unsigned; encoder and validator both reject `in_count > 255` and `out_count > 255` rather than truncating silently):
```
kernel_msg = SHA256(
    "tacit-kernel-v1"
    || asset_id(32)
    || in_count(1) || (input_txid_BE(32) || input_vout_LE(4))*in_count
    || out_count(1) || output_commitment(33)*out_count
    || burned_amount_LE(8)    # 0 for CXFER, >0 for BURN
)
```

The kernel sig verifies under `E'.x_only()` where:
```
E' = (Σ output_commitments) − (Σ input_commitments)
```
Sign with `excess = (Σ output_blindings) − (Σ input_blindings)`. If amounts balance, `E' = excess · G` (no H component) and the signature verifies. If amounts don't balance, `E'` has a non-zero H component (`δ · H + excess · G`) and producing a valid sig requires breaking DLP for H w.r.t. G — which is hard since H is NUMS.

#### 5.2.1 Shielded recipient (opt-in extension)

CXFER recipients can additionally opt into address-graph privacy via the **shielded address** primitive defined in [`spec/amendments/SPEC-BLINDED-PUBKEY-AMENDMENT.md`](./spec/amendments/SPEC-BLINDED-PUBKEY-AMENDMENT.md) (class-2). On-the-wire bytes are unchanged — the envelope, kernel sig, range proof, and Pedersen commitment are all identical. The difference is at the recipient output's `scriptPubKey`:

```
classical recipient: vout[i].script = P2WPKH(hash160(recipient_pubkey))
shielded recipient:  vout[i].script = P2WPKH(hash160(commit))
  where commit = recipient_pubkey + b·G
        b      = HMAC(sha256(ECDH(sender_eligible_input_priv_sum, recipient_pubkey).x),
                      DOMAIN_CXFER_STEALTH || network_tag || tx_anchor_head || vout_index_LE(4))
```

Recipients publish a bech32m-encoded handle (`tcs1…` mainnet, `tcsts1…` signet, `tcsrt1…` regtest) that opaquely carries their pubkey; senders decode it and emit `P2WPKH(commit)` per recipient vout. The recipient's wallet trial-derives `b` against `wallet.priv` per eligible output, matches the on-chain script, and persists `tweaked_sk = wallet.priv + b mod n` for later spend. Amount-channel ECDH (Pedersen blinding + amount keystream) continues to use the underlying `recipient_pubkey`, so the two channels remain orthogonal. Validator and indexer behavior is unchanged — class-2 stealth is fully transparent to the trust-bearing protocol per the compatibility audit in `spec/design/BLINDED-PUBKEY-COMPAT-AUDIT.md`.

### 5.3 T_MINT (`0x24`) — issue more supply on a mintable asset

```
T_MINT(1)
|| asset_id(32)              must equal SHA256(etch_txid_BE || 0_LE) for canonical bind
|| etch_txid(32)             reference to the original CETCH reveal tx
|| commitment(33)             Pedersen C = mint_amount·H + r_m·G
|| amount_ct(8)              u64 LE mint_amount XOR HMAC-keystream (issuer-only)
|| rp_len(2)
|| rangeproof(rp_len)        aggregated bulletproof, m=1, n=64
|| issuer_sig(64)            Schnorr sig under mint_authority pubkey
```

Mint authorization message:
```
mint_msg = SHA256(
    "tacit-mint-v1"
    || asset_id(32)
    || commit_anchor(36)         # commit_tx.vin[0].txid_BE || commit_tx.vin[0].vout_LE
    || commitment(33)
    || amount_ct(8)
)
```

The anchor binds the issuer's signature to a specific commit/reveal pair. Without it, the mint envelope payload (asset_id, commitment, amount_ct, rangeproof, issuer_sig) is fully observable on chain and an attacker could rewrap the same payload into their own commit/reveal pair to plant a validator-accepted supply UTXO at their own address. With the attestation pattern from §8 leaking the (amount, blinding) opening, that planted UTXO becomes spendable, doubling the auditable supply. The anchor is the same value the issuer already derives for the mint blinding (§3.5), so verifiers can re-derive it from `reveal_tx.vin[0].txid` → fetch commit tx → `commit_tx.vin[0]`.

Validator checks:
1. `asset_id == SHA256(etch_txid_BE || 0_LE)`.
2. Fetch the CETCH ancestor at `etch_txid`. Confirm `mint_authority ≠ 0x00…00` (asset is mintable) and `verifySchnorr(issuer_sig, mint_msg, mint_authority) == true`.
3. Range proof verifies for `commitment`.
4. `vout = 0` of the reveal tx holds the new supply UTXO. Its on-chain output script (typically a P2WPKH controlled by the issuer) is **not** validator-enforced — `mint_authority` is x-only and so does not by itself determine a unique compressed-pubkey output script. Spendability of the new supply is whatever Bitcoin rules say about that output's script, exactly as for any other tacit UTXO.

The new supply UTXO can subsequently be CXFER'd or BURN'd like any other holding.

### 5.4 T_BURN (`0x25`) — destroy supply

```
T_BURN(1)
|| asset_id(32)
|| burned_amount(8)          u64 LE — public
|| kernel_sig(64)            Schnorr sig under E' = burn·H + Σ_out − Σ_in
|| N(1)                      ∈ {0,1,2,4,8}; N=0 ⇒ burn-everything
|| (commitment(33) || amount_ct(8))  ×N
|| rp_len(2)                 omitted if N=0
|| rangeproof(rp_len)        omitted if N=0
```

Kernel message: same form as §5.2, with non-zero `burned_amount` field.

Validator equation (commitment space):
```
Σ input_commitments == burned_amount · H + Σ output_commitments
```

Equivalently, `E' = (Σ outputs) + (burned · H) − (Σ inputs)` and the kernel sig must verify under `E'.x_only()`. Soundness rests on the same DLP argument as CXFER's kernel sig.

Burns are permissionless: any holder of asset UTXOs can burn part or all of their balance. The burned amount is public so observers can audit supply reduction.

### 5.5 Validator algorithm

The validator inspects bytes at `tx.vin[0].witness[1]` and tries to decode them as a tacit envelope. It does **not** assert that the input is actually a Taproot script-path spend with the BIP-341 NUMS internal key — "envelope-bearing input" is a byte-pattern test, not a script-semantics test. Soundness for each opcode is supplied by a different mechanism, all chain-verifiable without re-checking Taproot semantics:

- **CXFER, T_AXFER, T_BURN.** A malformed or non-script-path input cannot satisfy the kernel sig + aggregated range proof: the kernel binds asset_id, every asset input outpoint, every output commitment, and the public burned amount, and the range proof bounds outputs. Tampering with any of that breaks one or both checks. `T_AXFER` (§5.7) additionally allows non-tacit aux inputs at `vin[1+asset_input_count..]`; those don't enter the kernel msg, so they can't affect the asset-side balance equation.
- **T_MINT.** The issuer's BIP-340 sig under `mint_authority` (resolved from the parent CETCH) is bound to the `commit_anchor` (commit_tx.vin[0].outpoint), so an attacker rewrapping the on-chain mint payload into their own commit/reveal pair would need a fresh issuer sig over the new anchor.
- **CETCH.** No kernel sig and no anchor sig — anyone can broadcast a CETCH-shaped envelope. This is intentional: there is no "the asset" to forge, because `asset_id = SHA256(reveal_txid_BE || 0_LE)` makes every well-formed CETCH a *new* asset whose identity is bound to the tx that carried it. Soundness for CETCH is just that its supply commitment carries a valid range proof; a forger has nothing to gain by re-using bytes from another etch since they would only be re-etching it under a fresh `asset_id`.
- **T_PETCH.** Same posture as CETCH — no sig, no anchor. Forging gives a fresh `asset_id` under the forger's reveal-tx, not control of an existing one. Soundness here additionally requires `cap_amount % mint_limit == 0` and the height-window invariants (§5.8) so the mint state machine is well-defined.
- **T_PMINT.** No signature. Soundness rests on three indexer-enforced invariants, all derivable from confirmed chain state: (1) `amount == petch.mint_limit`, (2) the T_PMINT's confirmed block height lies within the height window declared by the parent T_PETCH, and (3) the cumulative count of canonically-earlier valid T_PMINTs against the same `asset_id`, multiplied by `mint_limit`, is strictly less than `cap_amount`. Replay of a published T_PMINT envelope into a fresh commit/reveal pair is allowed but cost-symmetric with honest minting (§5.9 *Replay analysis*) — it consumes a cap slot at full Bitcoin-fee cost and produces a UTXO at the rewrapper's output script with the same opening; it does not steal the original miner's UTXO.
- **T_DROP.** Kernel sig on the asset-side balance equation `Σ C_in − cap_amount · H == excess · G`, exactly as in T_DEPOSIT (§5.10). The Mimblewimble argument is identical: the depositor cannot produce a valid x-only signature unless the consumed inputs' committed amounts sum to `cap_amount`. Per-drop `(per_claim, cap_amount, merkle_root, expiry_height)` are envelope plaintext; the indexer fixes them at drop-creation time and they cannot subsequently mutate.
- **T_DCLAIM.** No signature on the claim itself — the *eligibility witness* (eth_sig + merkle proof) IS the authentication when the parent drop sets a non-zero `merkle_root`. Soundness rests on four indexer-enforced invariants, all derivable from confirmed chain state: (1) `amount == drop.per_claim`, (2) `confirmed_height ≤ drop.expiry_height` (or no expiry if zero), (3) cumulative `(prior valid T_DCLAIMs against drop_id) × per_claim + amount ≤ cap_amount`, and (4) if `drop.merkle_root ≠ 0`, then the witness's merkle proof verifies against `(eth_address, per_claim, leaf_index)`, the eth_sig recovers `eth_address` from the EIP-191 hash of the canonical claim msg over `vout[0]`'s recipient pubkey, and `(drop_id, leaf_index)` is not already in the claimed-leaf set. Replay of a published T_DCLAIM envelope into a fresh commit/reveal pair is allowed but cost-symmetric with honest claiming (§5.13 *Replay analysis*).

The Taproot script-path framing in §5 (`OP_FALSE OP_IF` envelope, NUMS internal key) describes the canonical encoding — what writers SHOULD produce — and is what makes the witness slot cheap and inert under Bitcoin consensus. Validators do not enforce it. A future revision that requires Taproot validation would not change protocol soundness; it would only narrow what a writer is allowed to produce.

For each wallet UTXO, walk back through ancestry:

```
validateOutpoint(txid, vout):
    if cached:                                return cached
    fetch parent tx; decode envelope at vin[0].witness[1]
    if envelope.opcode == T_CETCH:
        verify range proof on its commitment
        vout must == 0
        record metadata (ticker, decimals, mint_authority, image_uri)
        return true
    if envelope.opcode == T_MINT:
        verify asset_id == SHA256(etch_txid_BE || 0_LE)
        fetch CETCH ancestor; recursively validateOutpoint(etch_txid, 0)
        confirm mintable and issuer_sig under mint_authority (with commit_anchor binding)
        verify range proof on mint commitment
        vout must == 0
        return true
    if envelope.opcode in {T_CXFER, T_BURN}:
        recursively validateOutpoint each input outpoint (tx.vin[1..])
        verify aggregated range proof for outputs (skip if BURN with N=0)
        verify asset_id consistency: every input's parent envelope must declare the same asset_id
        compute E' (with burned·H term if BURN) and verify kernel_sig under E'.x_only()
        return true
    if envelope.opcode == T_CXFER_BPP:
        # See §5.21. Byte-identical to CXFER except the rangeproof is a
        # Bulletproofs+ aggregated proof (~14% smaller witness). All other
        # fields (kernel_sig, commitments, amount_ct, kernel_msg construction,
        # ECDH-derived blinding + amount-recovery) are unchanged from CXFER.
        recursively validateOutpoint each input outpoint (tx.vin[1..])
        verify aggregated Bulletproofs+ range proof for outputs
        verify asset_id consistency: every input's parent envelope must declare the same asset_id
        compute E' (no burn term — T_CXFER_BPP is not a burn variant) and verify kernel_sig under E'.x_only()
        return true
    if envelope.opcode == T_AXFER:
        # See §5.7. Identical to CXFER except aux BTC inputs at
        # vin[1+asset_input_count..] are not validated as tacit ancestors.
        decode asset_input_count from payload
        require 1 <= asset_input_count <= len(tx.vin) - 1
        recursively validateOutpoint each in tx.vin[1 .. 1+asset_input_count]
        verify aggregated range proof for outputs[0..N]
        verify asset_id consistency across asset_inputs only
        compute E' from asset_inputs + outputs (no burn term) and verify kernel_sig under E'.x_only()
        return true
    if envelope.opcode == T_PETCH:
        # See §5.8. Deployment record only — no UTXO produced at any vout.
        # T_PETCH is reached during ancestry walks only when a wallet
        # accidentally treats the reveal tx's vout 0 as a tacit UTXO; the
        # correct answer is "not a tacit UTXO". Indexer cron records T_PETCH
        # metadata via a separate non-recursive scan path.
        return false
    if envelope.opcode == T_PMINT:
        verify asset_id == SHA256(etch_txid_BE || 0_LE)
        # Parent lookup is a metadata read, not an ancestry recursion: T_PETCH
        # has no spendable parent UTXO to validate. The validator looks up
        # T_PETCH metadata by etch_txid (cached during cron scan, or fetched
        # ad-hoc by decoding the reveal tx at etch_txid).
        petch = lookupPetchMetadata(etch_txid)
        require petch != null and petch.opcode == T_PETCH
        verify amount == petch.mint_limit
        let effective_start = petch.mint_start_height ≠ 0 ? petch.mint_start_height : (petch.etch_height + 1)
        let effective_end   = petch.mint_end_height   ≠ 0 ? petch.mint_end_height   : ∞
        verify confirmed_height ∈ [effective_start, effective_end]
        verify (count of canonically-earlier confirmed T_PMINTs against this
                asset_id at depth ≥ 3) * mint_limit + amount <= cap_amount
        verify 0 < blinding < curve_order
        verify pedersenCommit(amount, blinding) == commitment
        vout must == 0
        return true
    if envelope.opcode == T_DEPOSIT:
        # See §5.10. Consumes the asset input and appends a leaf to the per-
        # pool merkle tree; produces no tacit UTXO. POOL_INIT (denomination
        # sentinel = 0) is a metadata event handled by the same scan path.
        return false
    if envelope.opcode == T_WITHDRAW:
        # See §5.11. Produces a fresh tacit UTXO at vout[0] gated on a Groth16
        # proof of unspent leaf membership in the pool. Recursive validation
        # of any UTXO produced by T_WITHDRAW does NOT recurse through pool
        # ancestry — the proof + nullifier check is the protocol-level
        # validity. Pool-level state (tree, nullifiers, registered vk) is
        # maintained by the cron-mode scan path described in §3.6 and §5.10.
        require pool registered for (asset_id, denomination)
        require merkle_root in last 32 canonical roots of this pool
        require nullifier_hash NOT in this pool's spent-nullifier set
        verify Groth16 proof under pool.vk over public inputs
            [merkle_root, nullifier_hash, denomination, r_leaf, bind_hash]
        # External secp256k1 Pedersen check — closes inflation attack (§3.8 c4)
        require recipient_commitment == denomination · H + r_leaf · G
        record nullifier_hash as spent
        vout must == 0
        return true
    if envelope.opcode == T_DROP:
        # See §5.12. Consumes asset inputs whose committed amounts sum to
        # cap_amount; declares the drop pool's parameters; produces no tacit
        # UTXO of the asset. The pool's accounting (cap_amount, per_claim,
        # merkle_root, cumulative_claimed, claimed_leaf_set) is maintained
        # by the cron-mode scan path; the recursive validator merely returns
        # false so ancestors don't treat the reveal tx's vout 0 as a tacit
        # asset UTXO.
        return false
    if envelope.opcode == T_DCLAIM:
        # Parent lookup is a metadata read, not an ancestry recursion: T_DROP
        # consumes the supply and produces no asset UTXO. The validator
        # fetches the parent tx by drop_reveal_txid (carried in the T_DCLAIM
        # payload) and decodes its envelope; drop_id = SHA256(drop_reveal_txid_BE
        # || 0_LE) is the indexer's KV key, derived locally.
        drop_id = SHA256(drop_reveal_txid_BE || 0_LE)
        parent_tx = fetch(drop_reveal_txid)
        parent_env = decode(parent_tx.vin[0].witness[1])
        require parent_env != null and parent_env.opcode == T_DROP
        drop = decodeDropPayload(parent_env.payload)
        require drop != null and drop.per_claim > 0    # reject reclaim variant as a claim parent
        verify asset_id == drop.asset_id
        verify amount == drop.per_claim
        let effective_end = drop.expiry_height ≠ 0 ? drop.expiry_height : ∞
        verify confirmed_height ≤ effective_end
        verify (count of canonically-earlier confirmed T_DCLAIMs against this
                drop_id at depth ≥ 3) * per_claim + amount <= cap_amount
        if drop.merkle_root != 0:
            # Eligibility-gated drop. Witness MUST carry (recipient_pub,
            # leaf_index, eth_address, eth_sig, merkle_proof). recipient_pub
            # is the 33-byte compressed pubkey controlling vout[0]; the
            # eth_sig binds them by signing the canonical claim msg over
            # their tacit pubkey.
            verify hash160(witness.recipient_pub) == vout[0].scriptpubkey[2:22]
            verify merkle_proof(drop.merkle_root, witness.leaf_index,
                                leaf(witness.eth_address, per_claim, witness.leaf_index))
            verify eth_sig recovers witness.eth_address from EIP-191 hash of
                canonical_claim_msg(drop.merkle_root, drop.network, asset_id,
                                    witness.eth_address, witness.leaf_index, per_claim,
                                    drop.ticker, drop.decimals, witness.recipient_pub)
            verify (drop_id, witness.leaf_index) NOT in claimed_leaf_set
            record (drop_id, witness.leaf_index) as claimed
        verify 0 < blinding < curve_order
        verify pedersenCommit(amount, blinding) == commitment
        vout must == 0
        return true
    return false
```

Recursion is memoized via a `(txid, vout) → bool` map. In production-mode optimization, all rangeproofs are deferred into a batched bulletproof verify (one multi-exp); falls back to per-proof verify if batch fails.

**Unknown-opcode forward-compatibility rule (soft-fork semantics).** New envelope opcodes can be added to the protocol via future ceremonies and SPEC revisions (e.g., follow-up AMM concentrated-liquidity opcodes proposed at `0x33+`; see AMM.md §"Forward compatibility"). To preserve clean upgrade mechanics, **an indexer that encounters an envelope opcode it does not recognize MUST treat the envelope as a no-op at the asset and pool-state level**:

- The envelope does NOT create any tacit asset UTXO.
- The envelope does NOT credit or debit any pool reserve, mixer-pool leaf, LP-share supply, or other indexer-tracked state.
- The Bitcoin transaction carrying the envelope remains structurally valid (Bitcoin consensus does not care about envelope content); only the protocol-layer effect is skipped.
- The indexer SHOULD log the unknown opcode for monitoring, but MUST NOT halt indexing or revert state.
- Wallets querying the indexer see no balance/state change from the unknown envelope.

This is the **soft-fork semantic** that lets future opcodes ship without breaking deployed indexers. A V1-aware indexer continues to operate correctly when follow-up opcodes appear on chain — it ignores them. A follow-up-aware indexer additionally interprets the new opcodes and tracks the additional state. Both converge on the same V1 state for V1 envelopes.

**Constraint:** opcodes already defined in this spec MUST NOT be redefined or reused with different semantics. Future ceremonies add new opcodes at new code points; they do not overload existing ones.

**AMM opcode branches** (added by §§5.14–5.18). The §5.5 dispatch grows five branches, each described in full above:

```
if envelope.opcode == T_LP_ADD (0x2D):
    # See §5.14. Public (delta_A, delta_B, share_amount); per-asset Mimblewimble-
    # style kernel sigs; Groth16 proof asserts at-the-ratio + share formula. For
    # variant=1 (POOL_INIT), register pool metadata + verify launcher gate +
    # pin protocol_fee_address/protocol_fee_bps; otherwise crystallize protocol
    # fee (Uniswap-V2-lazy mintFee) then mint LP-share UTXO at the declared share vout
    # under lp_asset_id.

if envelope.opcode == T_LP_REMOVE (0x2E):
    # See §5.15. Public share_amount; kernel sig on consumed LP-share UTXO
    # under (Σ C_in_LP − share_amount·H).x_only(); Groth16 asserts proportional
    # withdrawal. Crystallize protocol fee before applying. Mints two receipt
    # UTXOs (one of asset A, one of asset B).

if envelope.opcode == T_SWAP_BATCH (0x2F):
    # See §5.16. Confidential per-trader amounts; settler-bundled. Sigma
    # cross-curve proofs verified out-of-circuit (per-intent AND per-receipt).
    # Groth16 batch proof verifies in-circuit BabyJubJub openings + clearing
    # arithmetic. Chain-side aggregate Pedersen check on secp256k1.
    require vout[0] == OP_RETURN(sha256(payload))
    decode payload
    for each per-intent and per-receipt sigma proof: verify against (C_secp, C_BJJ)
    verify Groth16 batch proof under pool.vk
    verify chain-side aggregate Pedersen check per asset
    verify direction consistency + constant-product invariant on declared deltas
    advance pool reserves; credit each receipt UTXO at vout[1+i]
    # NOTE: protocol fee is NOT crystallized here (Uniswap-V2-lazy: only at LP events + claim)

if envelope.opcode == T_INTENT_ATTEST (0x30):
    # See §5.17. Scope-generic preconfirmation channel attestation.
    # No Pedersen / no Groth16. Verify worker_sig; per-(scope_id,
    # worker_pubkey, observed_height) equivocation check.
    # No state mutation: pool reserves and orderbook records are unchanged.

if envelope.opcode == T_PROTOCOL_FEE_CLAIM (0x31):
    # See §5.18. Authenticated mint of accrued protocol fee. No Groth16.
    # Verify claimer_pubkey matches pool.protocol_fee_address; crystallize protocol
    # fee; verify claim_amount == pool.protocol_fee_accrued; verify claim_sig
    # (BIP-340) and public commitment opening; emit lp_asset_id UTXO at vout[0];
    # reset pool.protocol_fee_accrued = 0.

if envelope.opcode == T_SWAP_VAR (0x32):
    # See §5.20. Per-trade variable-amount AMM swap; reuses CXFER N=2 cryptography
    # (Pedersen + aggregated bulletproof + kernel sig). No Groth16; no ceremony
    # coupling — ships alongside V1 without depending on the T_SWAP_BATCH Phase 2
    # setup. Single-trader settlement against the spot curve at fee_bps.
    # Outcome taxonomy (§5.20): INVALID / EXECUTE / PASS-THROUGH.
    # Stage A — authentication; any failure ⇒ INVALID (no credits):
    require vout[0] == OP_RETURN(sha256(payload))
    decode payload; verify r_receipt < n_secp
    verify C_in_secp byte-equals vin[1]'s parent commitment (input binding)
    verify intent_sig (BIP-340 over intent_msg under trader_pubkey)
    verify kernel_sig (BIP-340 under (C_change − C_in + delta_in_total·H).x_only();
                       NO_CHANGE_SENTINEL substitutes ZERO when input fully consumed)
    verify aggregated bulletproof over (C_change_or_sentinel, C_receipt_secp)
    # Stage B — executability; any failure ⇒ PASS-THROUGH (refund):
    executable := pool registered+verified AND direction ∈ {0, 1}
                  AND vin[1] asset == direction's input asset == tip_asset
                  AND delta_in ∈ [delta_in_min, delta_in_max], delta_in > 0
                  AND confirm_height < expiry_height
                  AND delta_out_actual = curve(pool.reserve_A, pool.reserve_B,
                                               delta_in, fee_bps)   # ACTUAL running
                      with post-reserves u64-representable and > 0  # reserves
                  AND delta_out_actual >= max(1, min_out)           # binding floor
    # EXECUTE: advance pool reserves; credit receipt at vout[1] (output asset,
    #   delta_out_actual, derived commitment delta_out_actual·H + r_receipt·G);
    #   credit change at vout[2] if non-sentinel; credit tip at vout[3] iff its
    #   commitment opens under r_tip (unopenable tip ⇒ settler forfeits, fill stands).
    # PASS-THROUGH: pool unchanged; credit receipt at vout[1] (input asset refund,
    #   delta_in + tip_amount, derived commitment); credit change if non-sentinel.
    # Both: vin[1] consumed. Below SWAP_VAR_OUTCOME_ACTIVATION[network], the
    # superseded strict-equality algorithm applies.

if envelope.opcode == T_AXFER_VAR (0x37):
    # See §5.7.9. Variable-amount atomic settlement; reuses CXFER N=2 cryptography.
    # Require N == 2 (recipient + maker_change); require asset_input_count == 1.
    # Require vout[3] is the mandatory OP_RETURN(80) dual-recovery payload
    # (or split form: OP_RETURN(40) at vout[3] + OP_RETURN(40) at vout[4]).
    # Verify aggregated bulletproof over m=2 commitments; verify kernel_sig
    # (BIP-340) under (C_recip + C_change − C_listed).x_only() over the
    # kernel_msg shape from §5.4 (same domain "tacit-kernel-v1" as CXFER/T_AXFER;
    # the kernel msg includes asset_input_count=1 and N=2, distinguishing it
    # from T_AXFER kernel sigs even though the bytes overlap).
    # Tacit outputs live at {0, 2}; vout[1] is BTC payment (non-tacit);
    # vout[3..] are recovery OP_RETURNs (non-tacit). aux inputs at vin[2..]
    # do not enter the kernel msg.

if envelope.opcode == T_WRAPPER_ATTEST (0x38):
    # See §5.19. Optional on-chain wrapper attestation. No Pedersen / no Groth16.
    # Verify network_tag matches; verify as_of_height ≤ tip (mempool) or
    # ≤ confirmation_height (post-confirmation); recompute attestation_msg per
    # §4.2.4 and verify attestation_sig (BIP-340) under issuer_pubkey;
    # apply three-case dedup against (network, asset_id, issuer_pubkey, as_of_height)
    # log entry (first-confirmed | idempotent duplicate | equivocation-flag).
    # Emits no tacit UTXO; modifies no asset state; only updates wrapper-attestation log.
```

The existing CETCH / CXFER / T_MINT / T_BURN / T_AXFER / T_PETCH / T_PMINT / T_DEPOSIT / T_WITHDRAW / T_DROP / T_DCLAIM logic is unchanged. AMM envelopes (opcodes `0x2D`–`0x31`) do not recurse through the ancestry walk for asset-id resolution beyond the §4.1 three-origin rule; LP-share UTXO produced by `T_LP_ADD` and `T_PROTOCOL_FEE_CLAIM`, plus the locked MINIMUM_LIQUIDITY output, are authorized by the canonical POOL_INIT existence (path 3 of §4.1), not by recursive parent walking. `T_AXFER_VAR` (`0x37`) extends the §5.5 ancestry walk identically to `T_AXFER` — the produced tacit UTXOs at `vout[0]` and `vout[2]` are validateOutpoint() ⇒ true for the asset_id named in the envelope. T_WRAPPER_ATTEST (`0x38`) is non-recursive — it produces no UTXO and only appends to the indexer's wrapper-attestation log.

### 5.6 Range disclosure (`balance ≥ K`)

A holder may publish a zero-knowledge proof that the sum of their balances across a chosen set of UTXOs of a given asset is at least `K`, without revealing the actual balance. This is an **off-chain** primitive: nothing about it touches Bitcoin's witness data. The proof is published to the worker's `/assets/:asset_id/disclosures` endpoint and any third party can verify it from chain data + the proof bytes alone.

Soundness sketch. Let `C_i = a_i · H + r_i · G` be the holder's UTXO commitments for the asset. Define `C_sum = Σ C_i = a_sum · H + r_sum · G` (additively homomorphic, §3.2). The prover computes `v = a_sum − K` and produces a 64-bit aggregated bulletproof on the commitment `C' = v · H + r_sum · G`. Equivalently, `C' = C_sum − K · H` — the verifier reconstructs `C'` from the on-chain commitments without ever learning `a_sum` or `r_sum`. A valid range proof on `C'` bounds `v ∈ [0, 2⁶⁴)`, which is `a_sum ≥ K` (modulo the `a_sum < 2⁶⁴ + K` precondition required by the proof system).

Disclosure message:
```
disclosure_msg = SHA256(
    "tacit-disclosure-v1"
    || asset_id(32)
    || N_LE(2)                    # u16 LE, count of utxos
    || (txid_BE(32) || vout_LE(4)) × N
    || threshold_LE(8)            # u64 LE
    || rangeproof_bytes
    || owner_pubkey(33)           # compressed
)
```

Disclosure record (stored shape; `asset_id` is taken from the URL path on POST and echoed in `GET` responses, the other fields are the POST body):
```
{
  asset_id:     hex(32),          # from URL path /assets/:asset_id/disclosures
  utxos:        [{txid, vout}, …],
  threshold:    decimal string, 0 < K < 2⁶⁴,
  rangeproof:   hex,
  owner_pubkey: hex(33),
  sig:          hex(64)           # BIP-340 Schnorr over disclosure_msg, x-only key from owner_pubkey
}
```

The reference worker enforces `1 ≤ utxos.length ≤ 64` on POST. The wire format above (the canonical reference for interop) only requires `0 < N_LE < 2¹⁶`; deployments may pick a different cap.

Verifier requirements:
1. `0 < K < 2⁶⁴`.
2. For every listed UTXO: parent tx exists; vout's `scriptpubkey` is P2WPKH whose 20-byte hash equals `HASH160(owner_pubkey)`; parent's `vin[0].witness[1]` decodes as a tacit envelope; `getParentEnvelopeData(env, vout)` returns a commitment with the declared `asset_id`.
3. BIP-340 Schnorr verify of `sig` over `disclosure_msg` under `owner_pubkey` (x-only).
4. Bulletproof verifies on `C' = (Σ on-chain C_i) − K · H`.

Privacy caveats.
- `utxos[]` is public — the verifier learns *which* UTXOs back the disclosure (graph privacy is not a goal of v1, §9).
- `owner_pubkey` is published in cleartext, equal to the spending key of every listed UTXO.
- `K` itself is public.
- The disclosure does not prevent double-counting: the same UTXO may be referenced by two disclosures from the same owner. Consumers requiring exclusivity must pin disclosures to a UTXO set they consider canonical at observation time.

Replay rules.
- Disclosures are not bound to a timestamp or block height. A disclosure remains "true" only as long as every listed UTXO is still owned by `owner_pubkey` and unspent. Any verifier that needs current truth MUST re-check UTXO ownership and unspent-ness against the chain at query time. The worker may garbage-collect disclosures that reference spent UTXOs.
- The worker dedupes by `(asset_id, owner_pubkey, K)`: re-publishing for the same triple overwrites the earlier UTXO set, proof, and timestamp. Different `K` values from the same owner coexist as separate disclosures.

This primitive is implementation-defined in v1: the wire format above is the canonical reference for any implementation that wants to interoperate. Indexer-level validity is unaffected — disclosures live entirely outside the on-chain protocol.

### 5.7 T_AXFER (`0x26`) — atomic OTC settlement

CXFER is structurally complete for confidential transfers but presupposes that *every* `vin` after the envelope-bearing `vin[0]` is a tacit asset input. That precludes mixing a tacit transfer with a non-tacit Bitcoin payment in the same Bitcoin tx — the use case for atomic OTC settlement, where a maker's CXFER reveal and a taker's BTC payment must close together so neither party can grief.

`T_AXFER` is a CXFER variant that explicitly declares how many of `tx.vin[1..]` are tacit asset inputs. Subsequent inputs are auxiliary — Bitcoin-only, ungoverned by tacit semantics. Old wallets/indexers running v1.0 of this spec see opcode `0x26`, fail to decode, and reject the UTXO; once they upgrade, every UTXO they previously rejected validates the same way they validate CXFER today, with no chain rewrite.

```
T_AXFER(1)
|| asset_id(32)
|| asset_input_count(1)        u8, 1..255 — vin[1..1+asset_input_count] are tacit asset inputs
|| kernel_sig(64)              Schnorr sig over kernel_msg, see below
|| N(1)                        number of tacit outputs, ∈ {1,2,4,8}
|| (commitment(33) || amount_ct(8))  ×N
|| rp_len(2)
|| rangeproof(rp_len)          aggregated bulletproof, m=N, n=64
```

Constraints enforced at decode:
- `asset_input_count ≥ 1` (a `T_AXFER` with no asset inputs is rejected — it's a degenerate "create-from-nothing" attempt the kernel sig already prevents, but rejecting up-front is cheaper than letting the kernel sig do the work).
- `asset_input_count + 1 ≤ tx.vin.length` (the declared asset inputs must actually exist in the tx).
- `N ∈ {1,2,4,8}` (same aggregation constraint as CXFER).

Kernel message — **identical to CXFER's kernel msg in §5.2**, with `in_count := asset_input_count`:
```
kernel_msg = SHA256(
    "tacit-kernel-v1"
    || asset_id(32)
    || asset_input_count(1) || (input_txid_BE(32) || input_vout_LE(4))*asset_input_count
    || N(1) || output_commitment(33)*N
    || burned_amount_LE(8)    # always 0 for T_AXFER; T_BURN's analog is out of scope here
)
```

The same domain tag (`"tacit-kernel-v1"`) is reused deliberately. The kernel msg semantics are identical between `CXFER (0x23)` and `T_AXFER (0x26)` — both bind exactly the asset side of the transfer (asset_id, asset input outpoints, output commitments, burned=0). A signature for one verifies the same balance equation under the other; this is harmless because the asset inputs and output commitments are themselves part of the msg, and the prover cannot synthesize a valid sig over a different tx's asset side. The opcode byte is a presentation choice — what `vin[1+asset_input_count..]` are allowed to be — not a cryptographic invariant.

The kernel sig verifies under `E'.x_only()` exactly as in §5.2, computed only over the declared asset inputs and the declared tacit outputs:
```
E' = (Σ output_commitments[0..N]) − (Σ asset_input_commitments)
```
Auxiliary `vin[1+asset_input_count..]` and `vout[N..]` do not enter `E'`. Their security is whatever Bitcoin's own consensus rules give them: each aux input must be signed by its owner per standard Bitcoin script semantics; each aux output is just satoshis going somewhere. None of that touches tacit asset value.

#### 5.7.1 Validator algorithm extension

Insert between the CETCH/MINT and the existing CXFER/BURN branches:

```
if envelope.opcode == T_AXFER:
    decode asset_input_count, kernel_sig, outputs[0..N], rangeproof from payload
    require asset_input_count >= 1 and asset_input_count + 1 <= len(tx.vin)
    require N in {1,2,4,8}
    asset_inputs = tx.vin[1 .. 1+asset_input_count]
    # tx.vin[1+asset_input_count..] are auxiliary BTC inputs — NOT validated here
    recursively validateOutpoint each input outpoint in asset_inputs
    verify aggregated range proof for outputs (m=N)
    verify asset_id consistency: every parent envelope of asset_inputs declares the same asset_id
    compute E' from asset_inputs + outputs and verify kernel_sig under E'.x_only()
    return true
```

Vouts beyond `N-1` are not tacit UTXOs. A wallet querying `validateOutpoint(reveal_txid, vout >= N)` against a `T_AXFER` envelope returns `false` — the indexer correctly identifies that vout as outside the tacit footprint of the tx. The user's wallet treats it as a regular Bitcoin UTXO. This matches CXFER's behavior on out-of-range vouts.

#### 5.7.2 Soundness

Same argument as §5.2, restricted to the asset side of the tx:

- **No inflation downstream.** `E' = Σ_out_tacit C − Σ_asset_in C`. A balanced tx has `δ = Σa_out − Σa_in = 0` and `E' = excess·G` (no H component); kernel sig verifies under `excess`. An unbalanced tx has `δ ≠ 0`, `E' = δ·H + excess·G`, and producing a sig under `E'.x_only()` requires breaking DLP for H w.r.t. G. Aux BTC inputs/outputs never enter this equation, so they cannot inflate or deflate the tacit side.
- **No negative-amount smuggling.** Aggregated bulletproof on `outputs[0..N]` bounds each amount to `[0, 2⁶⁴)` — same as CXFER.
- **Replay protection.** Kernel msg binds `(asset_id, asset_input_outpoints, output_commitments, burned=0)`. A `T_AXFER` payload reused in a different tx must reuse those exact asset inputs; Bitcoin consensus prevents any outpoint from being spent twice, so cross-tx replay of the kernel sig is impossible.
- **Aux BTC tampering.** A taker reorders or replaces aux BTC inputs/outputs *after* the maker signed the reveal — see §5.7.3 for the SIGHASH discipline that makes this safe (or unsafe) on a per-implementation basis. The kernel sig itself is unaffected because the kernel msg doesn't bind aux inputs/outputs.

#### 5.7.3 Off-chain coordination (PSBT-style flow)

`T_AXFER` is the on-chain shape. The atomic-settlement choreography is implementation-defined and lives off-chain; this section describes the canonical pattern the reference dApp follows so other implementations can interop.

**Maker (seller) prepares a partially-signed reveal tx:**
1. Picks the asset UTXOs being sold; computes the CXFER reveal kernel sig + bulletproof + envelope script as in §5.2.
2. Builds the reveal tx with:
   - `vin[0]` = the commit-tx P2TR (envelope-bearing), signed via taproot script-path with `SIGHASH_SINGLE | ANYONECANPAY` (= `0x83`)
   - `vin[1..1+asset_input_count]` = the maker's tacit asset UTXOs, each signed via P2WPKH with `SIGHASH_SINGLE | ANYONECANPAY`
   - `vout[0..N-1]` = the tacit output commitments (recipient + change)
   - The tx is "open-ended": the taker can append `vin[1+asset_input_count..]` and `vout[N..]` without invalidating the maker's sigs (SIGHASH_SINGLE binds vin[i] to vout[i] only; ANYONECANPAY drops binding to other inputs).
3. Encodes the partial reveal as a tacit-PSBT (PSBT with the proprietary keys defined in §5.7.4) and shares with the taker.

**Taker (buyer) finalizes:**
1. Parses the tacit-PSBT; runs §5.7's validator algorithm against the in-flight reveal to confirm the kernel sig + bulletproof + envelope are well-formed and that the output to the taker decrypts to the agreed amount.
2. Appends:
   - `vin[1+asset_input_count..]` = the taker's BTC funding input(s), signed `SIGHASH_ALL` (taker pins the whole tx now that no further changes are allowed).
   - `vout[N..]` with the BTC payment to the maker's address (`price_sats` to maker; optional change back to taker; optional fee delta).
3. The maker's vin[0] sig signs over `(vin[0], vout[0])` only — vout[0] is the recipient tacit commitment, fixed at maker-sign time. The taker cannot modify vout[0] without invalidating that sig.
4. The maker's `vin[1..1+asset_input_count]` sigs each sign over `(vin[i], vout[i])` only. Vouts at index `i` for `1 ≤ i < N` are tacit change/recipient commitments; `vout[N..]` are aux BTC and are NOT bound by any maker sig (SIGHASH_SINGLE on vin[k] for k ≥ N has no corresponding vout — implementations MUST sign with SIGHASH_NONE | ANYONECANPAY for such inputs, or arrange for at least one tacit vout per maker asset input). The reference dApp constrains tx layout so each maker input has a tacit-vout counterpart, sidestepping this.
5. Broadcasts.

**What's protected vs. what isn't:**
- Maker cannot rug-pull post-broadcast: the kernel sig + tacit-input sigs are committed to the recipient's tacit commitment. The taker sees this on-chain alongside their own BTC payment.
- Taker cannot get tokens without paying: a reveal tx with `vout[N..]` BTC stripped/redirected would invalidate the taker's own SIGHASH_ALL sig, so the tx wouldn't broadcast.
- Maker double-spend race: between PSBT delivery and broadcast, the maker can spend their asset UTXOs in another tx. Mitigation is operational (taker broadcasts promptly, CPFP if needed) — this matches Magic Eden's ordinals listings.

#### 5.7.4 Tacit-PSBT proprietary keys

PSBT (BIP-174) supports proprietary key types under the `0xfc` keytype prefix with a per-application identifier. For tacit-PSBT, identifier = ASCII `"TACIT"` (5 bytes). Within the `TACIT` namespace:

| Subtype | Key-data | Value | Where |
|---|---|---|---|
| `0x00` | (empty) | envelope script bytes (the leaf script of `vin[0]`) | input map at `vin[0]` |
| `0x01` | (empty) | control block bytes (the script-path control block of `vin[0]`) | input map at `vin[0]` |
| `0x02` | (empty) | u8: `asset_input_count` (matches the on-chain field width in §5.7) | global map |
| `0x03` | u8: input index (0..N-1) | `(commitment(33) || amount_ct(8) || blinding_hint(33))` for the recipient — the blinding hint is the sender's compressed pubkey, which the recipient combines with their own privkey via ECDH per §3.5 to recover the blinding | global map |

The `blinding_hint` lets the taker pre-verify their tacit-output commitment without a separate share-link. Other tacit outputs (change to maker, recipient outputs to other parties) are not annotated; the taker has no need to open them and the maker recovers their own change via §6.

Implementations that don't ship a PSBT extension can fall back to a JSON envelope of the same shape; the proprietary-key form is provided so a future Sparrow/Specter/etc. plugin can do the listing-take flow with their existing tooling.

#### 5.7.5 Comparison with CXFER

| | `CXFER` (0x23) | `T_AXFER` (0x26) |
|---|---|---|
| All `vin[1..]` must be tacit asset inputs | yes | no — only `vin[1..1+asset_input_count]` are |
| Allows BTC payments in the same Bitcoin tx | no | yes (at `vin[1+asset_input_count..]` and `vout[N..]`) |
| Kernel msg | binds all of `vin[1..]` | binds only the declared asset inputs |
| Aggregated bulletproof | over `outputs[0..N]` | over `outputs[0..N]` (unchanged) |
| Recovery (§6) | unchanged | unchanged — recipient/change derivations key off the asset side, ignoring aux inputs |
| Use cases | private transfers, etcher's own change, simple sends | OTC marketplace settlement, atomic asset-for-BTC swaps |

Both opcodes are first-class. A confidential send between two known parties has no reason to use `T_AXFER`; the witness is a few bytes smaller as `CXFER`. Marketplace settlement (where a taker funds the same Bitcoin tx) uses `T_AXFER`. The validator handles both interchangeably as ancestors of any future descendant CXFER/BURN.

#### 5.7.6 Atomic intents (browse-and-take)

§5.7.3 covers the targeted-recipient flow: the maker knows the taker's pubkey at intent-build time and signs a partial reveal that's complete except for the taker's BTC-side inputs. That works for one-shot bilateral OTC but rules out a public marketplace, because a CXFER recipient blinding is `HMAC(ECDH(maker_priv, taker_pub), …)` (§3.5) — without the taker's pubkey, the maker can't compute the recipient commitment, so they can't sign the kernel.

**Atomic intents** lift that restriction with one wire-format-irrelevant trick: the maker generates a fresh per-intent recipient blinding as a uniform-random scalar and uses it to fix the recipient commitment at intent-publish time, independent of any taker pubkey. The Bitcoin output script (`P2WPKH(taker_pub)`) still binds the recipient identity — that's set at fulfilment time, after a specific taker has claimed the intent. Atomicity is preserved end-to-end.

The blinding scalar `r` is **never published cleartext**. Doing so would let any observer recover the listed amount via baby-step-giant-step over `a·H = C - r·G` (≈seconds for 64-bit amounts; milliseconds for low-decimal assets). Instead, the maker holds `r` privately on their device and, at fulfilment time, encrypts it to the claimant's pubkey via an ECDH-derived 32-byte keystream:

```
ks = HMAC-SHA256(SHA256(ECDH(maker_priv, taker_pub)),
                 "tacit-axintent-blinding-v1" || intent_id || asset_id)
enc_recipient_blinding = r XOR ks            // 32 bytes
```

The keystream is bound to `(intent_id, asset_id)` so a ciphertext from one intent cannot be replayed against another. Symmetric ECDH means the claimant decrypts with `(taker_priv, maker_pub)` to recover the same `ks` and hence `r`. The worker stores the ciphertext opaquely and forwards it on the fulfilment GET; only the named claimant can decrypt.

This is purely a coordination layer on top of `T_AXFER` — no new opcode, no new wire format, no consensus implication. The reference dApp ships it; an alternative implementation can ignore it and still validate intent-mediated settlements correctly because the on-chain bytes are indistinguishable from a §5.7.3-style targeted offer.

##### Records

The off-chain marketplace stores three records per intent:

```
intent {
  intent_id            16 bytes / 32 hex chars (sha256(commit_txid_BE || maker_pubkey)[:16])
  asset_id, maker_pubkey (33B compressed), maker_address (bech32),
  amount               u64 base units (cleartext — the listed amount)
  price_sats           u64
  expiry               unix-seconds (≤ 365 days from publish)
  commit_txid          the maker's already-broadcast commit tx
  commit_value         u64 sats locked in the commit P2TR
  p2tr_spk_hex         34-byte segwit script (00 20 || tweaked-key)
  asset_utxo           { txid, vout, value }
  envelope_script_hex  the leaf script committed in the commit P2TR
                       (carries the on-chain recipient commitment in its T_AXFER payload)
  control_block_hex    the 33-byte tapscript control block
  intent_sig           BIP-340 over intent_msg, under maker_pubkey
}

  // The recipient_blinding scalar `r` is NOT in this record (deliberately —
  // see the privacy paragraph above). The maker holds it locally; the
  // taker receives it encrypted at fulfilment time.

claim {
  intent_id, taker_pubkey (33B),
  taker_utxo { txid, vout, value }   // P2WPKH-controlled by taker_pubkey,
                                     // value ≥ intent.price_sats. Worker
                                     // verifies on-chain at claim time as a
                                     // proof-of-funds gate; not locked, just
                                     // attested.
  sig, claimed_at, expires_at        // 5-min TTL
}

fulfilment {
  intent_id, taker_pubkey,
  partial_reveal           JSON-encoded partial Bitcoin tx with maker
                           SIGHASH_SINGLE_ACP sigs targeted at the claimant's pubkey
  enc_recipient_blinding   32-byte hex — `r XOR HMAC-SHA256(SHA256(ECDH(maker_priv,
                           taker_pub)), "tacit-axintent-blinding-v1" || intent_id || asset_id)`
  fulfilment_sig           BIP-340 over fulfilment_msg, under maker_pubkey
  fulfilled_at             unix-seconds — fulfilments older than 24h are GC'd
                           on read so the maker can re-fulfil for a new claimant
}
```

##### Canonical messages

```
intent_msg = SHA256(
    "tacit-axintent-v1"
    || asset_id(32) || intent_id(16) || maker_pubkey(33)
    || amount_LE(8) || price_LE(8) || expiry_LE(8)
    || commit_txid_BE(32) || asset_utxo_txid_BE(32) || asset_utxo_vout_LE(4)
)

claim_msg     = SHA256("tacit-axintent-claim-v2"     || asset_id || intent_id || taker_pubkey
                       || taker_utxo_txid_BE(32) || taker_utxo_vout_LE(4))
// The bound funding UTXO outpoint pins the claim to a specific source of
// sats — a captured sig cannot be re-aimed at a different outpoint. The
// worker re-checks that the bound UTXO is P2WPKH-controlled by
// taker_pubkey and value ≥ intent.price_sats before accepting the claim
// (proof-of-funds gate; not locked).
fulfilment_msg = SHA256("tacit-axintent-fulfilment-v1" || asset_id || intent_id || taker_pubkey
                       || SHA256(partial_reveal_json))
cancel_msg    = SHA256("tacit-axintent-cancel-v1"    || asset_id || intent_id)
```

`intent_id` is `SHA256(commit_txid_BE || maker_pubkey)[:16]` — stable per intent, derivable by anyone given the commit txid and maker pubkey, and unique because commit_txid is unique in Bitcoin.

##### Lifecycle (state machine)

```
[publish]   maker:   build & broadcast commit tx + post intent → intent stored
[browse]    anyone:  GET /atomic-intents → discover open intents
[claim]     taker:   POST /:intent_id/claim with taker_pubkey + a committed
                     funding UTXO (P2WPKH, value ≥ price_sats) → 5-min lock
[fulfil]    maker:   POST /:intent_id/fulfilment with partial reveal targeted at claimant
[take]      taker:   GET fulfilment, append BTC funding signed SIGHASH_ALL, broadcast
[settled]   anyone:  the on-chain T_AXFER is indistinguishable from a §5.7.3 settlement
```

If the taker doesn't broadcast within the claim window, the lock expires and the intent goes back to "browse" state. The maker's commit tx is unaffected and a new claim can come in. If the maker doesn't fulfil within the claim window, the same applies.

##### Trust analysis

The atomic intent flow inherits §5.7.2 soundness from `T_AXFER` itself, plus three coordination-layer guarantees:

- **Maker can't redirect the taker's payment.** The maker's `vin[1]` (asset input) is signed `SIGHASH_SINGLE_ACP`, binding `vout[1]` = BTC payment to maker. If the taker rewrote `vout[1]` (e.g., to redirect payment), maker's sig becomes invalid → Bitcoin consensus rejects.
- **Taker can't get tokens without paying.** The taker's `SIGHASH_ALL` sig on their funding input commits to the entire tx including the maker's payment output. Removing `vout[1]` invalidates the taker's sig. The taker can't sign a fresh sig that excludes payment because that would make `vin[1]`'s sig (maker's, unchanged) bound to a nonexistent vout.
- **Maker can't fulfil for a different taker than the one who claimed.** `fulfilment_msg` binds `taker_pubkey` and the partial reveal's hash. The worker rejects mismatches; clients cross-check the partial reveal's `vout[0].scriptpubkey` is `P2WPKH(hash160(claim.taker_pubkey))`.

What atomic intents *don't* protect against:

- **Maker double-spend race.** Between fulfilment-posting and taker-broadcast, the maker could in principle race-spend the asset UTXO in another tx. Same race as ordinals atomic listings. Mitigation is operational: the taker broadcasts immediately on receiving fulfilment (the dApp's "Take" button does this).
- **Maker liveness.** Fulfilment requires the maker to be online during the 5-min claim window. If they're offline, the claim expires and a fresh claim from anyone can replace it.
- **Abandoned commits.** If no one claims the intent before its expiry, the commit P2TR sits unspent on chain. The maker can reclaim by spending it via the script-path with the envelope as the leaf — the reclaim is exactly a take-by-self with the maker as both maker and taker.

##### Privacy of the listed amount

Atomic intents publish the listed UTXO's amount in cleartext — the taker needs to know what they're buying. The recipient blinding `r` is **not** published; it's encrypted to the claimant at fulfilment time (see above). The maker's *other* UTXOs of the same asset are unaffected — observers learn the amount of the listed UTXO from the cleartext `amount` field, but not its `r`, so the on-chain commitment remains computationally unrecoverable to anyone except the named claimant. Range-disclosed listings (§5.6 + listings layer) cover the symmetric case (no atomicity, but no listed amount either); the two primitives coexist for different use cases.

##### Recovery model (on-chain OP_RETURN, seed-only recoverable)

The maker's fulfilment-time partial reveal **MAY include a 0-sat `OP_RETURN(40)`** at a vout position past the maker-bound vouts (e.g., `vout[N+number_of_maker_BTC_outputs]`; the reference dApp uses `vout[2]` for the N=1 atomic-intent layout). The 40-byte payload carries `(amount, r)` encrypted to the taker via the same symmetric ECDH path used for the worker fulfilment ciphertext, with separate domain tags so one ciphertext can't decrypt another or replay against a different output index:

```
ks_amount   = HMAC-SHA256(SHA256(ECDH(maker_priv, taker_pub)),
                          "tacit-axintent-onchain-amount-v1"
                          || intent_id(16) || asset_id(32) || vout_idx_LE(4)).first8
ks_blinding = HMAC-SHA256(SHA256(ECDH(maker_priv, taker_pub)),
                          "tacit-axintent-onchain-blinding-v1"
                          || intent_id(16) || asset_id(32) || vout_idx_LE(4))

payload_40   = (amount_LE(8) XOR ks_amount) || (r_bytes(32) XOR ks_blinding)
script_42    = OP_RETURN(0x6a) || OP_PUSHBYTES_40(0x28) || payload_40
```

The maker's `SIGHASH_SINGLE|ANYONECANPAY` sigs bind only vin[i] ↔ vout[i], so the OP_RETURN at any vout past the maker's signed range is outside their sig binding; the taker's `SIGHASH_ALL` sig at broadcast commits to it. A taker who mutates the OP_RETURN destroys their own recovery (they can't decrypt a ciphertext they themselves chose), so the only rational behavior is to broadcast the maker-provided bytes verbatim.

**With OP_RETURN present:** the recipient UTXO is **recoverable from chain + privkey alone** — same property as §6 paths 2–5. A wallet restoring from seed years later scans the chain, finds the reveal tx involving its address, extracts `maker_pubkey` from `vin[1].witness[1]` and `commit_txid` from `vin[0].prevout`, re-derives `intent_id = SHA256(commit_txid_BE || maker_pubkey)[:16]`, computes the ECDH-derived keystreams, decrypts the OP_RETURN, and verifies the on-chain Pedersen commitment opens to `(amount, r)`. No worker, no local cache, no off-band involvement.

**Without OP_RETURN (legacy fulfilment):** the recipient UTXO remains in the original recovery model — local opening cache (path 1) or worker re-fetch within the 24-hour fulfilment TTL. Beyond the TTL, the UTXO is a "ghost" entry: BTC sats spendable by privkey, asset amount unrecoverable without maker re-providing the encrypted blinding off-band.

**Wire format is unchanged.** The OP_RETURN is purely additive at the Bitcoin tx layer; the T_AXFER envelope at `vin[0].witness[1]` is identical to a §5.7.3 targeted settlement. Existing intents on chain (no OP_RETURN) keep working via the legacy fallbacks; new intents using OP_RETURN gain seed-only recovery. Indexer behavior is unchanged — the T_AXFER decoder only reads the envelope and ignores extra vouts.

**Chain-pattern indistinguishability trade-off.** An atomic-intent reveal that includes the OP_RETURN is observably different from a §5.7.3 targeted reveal that doesn't. The reference dApp accepts this small marginal distinguishability (atomic intents are already distinguishable via `amount_ct = zeros` in the envelope; the OP_RETURN adds one more signal). A future hardening could add a matching OP_RETURN to targeted reveals (with the same shape, different keystream tag) to restore full uniformity.

Reference impl: `dapp/tacit.js` (`deriveAxintentOnchainKeystreams`, `encodeAxintentOnchainPayload`, `decodeAxintentOnchainPayload`, `encodeAxintentOnchainOpReturn`, `tryExtractAxintentOnchainOpReturn`); mirror in `tests/composition.mjs`. Parity + adversarial coverage: `tests/dapp-parity.test.mjs` §5d (12 tests), `tests/axintent-onchain-recovery.test.mjs` (16 e2e tests).

Targeted §5.7.3 settlements remain unchanged — they use ECDH-derived blindings and recover normally via §6 path 2 without needing the OP_RETURN.

**Maker-side recovery.** A maker who reimports their privkey on a fresh device after losing local state recovers the listed asset UTXO via §6 paths normally — its `r` was set at the asset's originating CXFER / CETCH / T_AXFER, not at intent-publish time, so it is unaffected by the loss of the per-intent random `r`. The unspent commit P2TR's BTC sats are reclaimable via script-path spend using the privkey plus the leaf-script and control-block bytes the worker holds in the intent record (or any cached copy of the intent payload). What is irretrievably lost is the per-intent random `r` itself: any in-flight claim becomes un-fulfillable, the claim lock expires, and the maker must publish a fresh intent with a new `r` to relist. No asset value is destroyed — only the listing.

##### Worker endpoints (reference)

```
POST   /assets/:asset_id/atomic-intents
GET    /assets/:asset_id/atomic-intents
DELETE /assets/:asset_id/atomic-intents/:intent_id          (signed cancel)
POST   /assets/:asset_id/atomic-intents/:intent_id/claim    (signed by taker)
POST   /assets/:asset_id/atomic-intents/:intent_id/fulfilment (signed by maker)
GET    /assets/:asset_id/atomic-intents/:intent_id/fulfilment
```

The worker validates ownership at every step (P2WPKH hash160 match for the asset UTXO, BIP-340 sig verification under the appropriate pubkey for each canonical msg) but does not verify the bulletproof inside the partial reveal — clients re-verify at take time, same policy as the standalone disclosure endpoint (§5.6).

This primitive is implementation-defined in v1: the wire format above is the canonical reference for any implementation that wants to interoperate with the reference dApp's marketplace. Indexer-level validity is unaffected — atomic intents live entirely outside the on-chain protocol.

#### 5.7.6.1 Variable-amount atomic intents (coordination layer)

Extends §5.7.6 with **maker-online continuous partial fills**. A maker posts one intent advertising "up to `amount` tacit at total price `price_sats`, with minimum take `min_take_amount`"; a taker claims with `requested_amount ∈ [min_take_amount, amount]`; settlement is a single Bitcoin tx that delivers exactly `requested_amount` to the taker and returns `(amount − requested_amount)` to the maker as change.

The on-chain envelope is `T_AXFER_VAR` (§5.7.9). The off-chain coordination layer differs from §5.7.6 in three load-bearing ways:

1. **Commit phase deferred to fulfilment** — a variable-amount intent's commit tx is constructed and broadcast at fulfilment, not at publish, because `C_recip` and `C_change` depend on the taker's chosen `requested_amount`.
2. **Claim carries `requested_amount`** — taker fixes the fill amount when claiming, not just the intent_id.
3. **Fulfilment exchanges an unbroadcast commit + a partial reveal**; the worker performs sequential broadcast.

##### Intent record

```
intent {
  intent_id          16 bytes = SHA256("tacit-axintent-id-v1"
                                       || maker_pubkey(33)
                                       || asset_utxo_txid_BE(32)
                                       || asset_utxo_vout_LE(4))[0..16]
                              — deterministic from intent terms; derivable both
                              at publish (worker handle) and from chain data at
                              recovery (vin[1] reveals the asset_utxo outpoint).
  network            "mainnet" | "signet" | "regtest"
  opcode             0x37  (declares T_AXFER_VAR settlement; legacy whole-UTXO
                            intents use 0x26 per §5.7.6 and that record shape.)
  asset_id           32 bytes
  asset_utxo         { txid, vout, value }  — maker's listed tacit UTXO
  amount             u64 — listed UTXO's amount in base units (cleartext).
                          Serves as the IMPLICIT max_take_amount — a taker
                          can request any amount up to but not exceeding `amount`.
  min_take_amount    u64 — OPTIONAL.
                          Absence  ⇒ whole-UTXO fill (legacy §5.7.6 semantics);
                                     intent uses opcode 0x26 and §5.7.6's record shape.
                          Presence ⇒ variable fill; opcode 0x37; commit deferred.
  price_sats         u64 — total price for the full listed `amount`. Per-base-
                          unit pricing scales linearly (see *Bounded recipient
                          amount* below).
  expiry             u64 — unix-seconds. Worker drops claims after this.
  maker_pubkey       33 bytes (compressed)
  maker_address      string — bech32 BTC payment address for vout[1]
  intent_sig         64 bytes — BIP-340 over intent_msg (below)
}
```

`intent_msg` binds every field a taker quotes against:

```
intent_msg = SHA256("tacit-axintent-publish-v1"
                   || asset_id || intent_id
                   || asset_utxo_txid_BE(32) || asset_utxo_vout_LE(4)
                                              || asset_utxo_value_LE(8)
                   || amount_LE(8) || price_sats_LE(8)
                   || min_take_amount_LE(8)  // 0x00…00 if absent
                   || expiry_LE(8)
                   || maker_pubkey(33) || H(maker_address)(32)
                   || network_tag(1))
```

Workers MUST verify `intent_sig` under `maker_pubkey` before accepting the publish. Without an on-chain commit tx as an anchoring artefact, `intent_sig` is the only binding the worker holds; a taker downloading the intent record validates the signature client-side before quoting against it.

The maximum take is **always** the listed UTXO's amount; there is no separate `max_take_amount` field. A maker who wants to expose only part of a UTXO MUST pre-split via a self-CXFER first, then publish the intent against the smaller UTXO.

Publish-time rules:

1. If `min_take_amount` absent ⇒ legacy whole-UTXO (§5.7.6, opcode `0x26`, `claim_msg_v2`, commit broadcast at publish).
2. If `min_take_amount` present:
   - `1 ≤ min_take_amount ≤ amount`.
   - On-chain settlement uses `T_AXFER_VAR` (`0x37`); claim format is `claim_msg_v3`.
   - **No commit tx is broadcast at publish.**

An intent record with `min_take_amount == amount` is semantically equivalent to a whole-UTXO intent and SHOULD use `T_AXFER` (`0x26`); implementations MAY refuse to publish degenerate variable-amount intents.

##### Commit-phase timing

`T_AXFER` commits the envelope script bytes via a P2TR script-tree **at intent publish time** because the recipient commitment, ciphertext, kernel sig, and rangeproof are fully determined by the listed `amount` and recipient pubkey — both known at publish.

`T_AXFER_VAR` payloads commit to `C_recip` and `C_change`, which depend on `requested_amount`. The aggregated bulletproof and kernel sig (signing under `(r_recip + r_change − r_listed) · G`'s x-only form) likewise depend on the take split. None of these are knowable at intent publish — `requested_amount` is taker-chosen.

Therefore: **a variable-amount intent's commit tx is constructed and broadcast at fulfilment, not at publish.** The publish record is an authenticated off-chain offer; the on-chain commit is created only after a taker's claim fixes `requested_amount`.

Invariants preserved across the timing shift:

1. The taproot-committed envelope bytes remain the canonical settlement object. Validators read one self-contained envelope from the script-path reveal — no cross-output reconstruction.
2. The P2TR commit still commits to the exact settlement bytes; it just does so after those bytes become well-defined.
3. The maker's BTC-payment binding via `vin[1]` SIGHASH_SINGLE_ACP on `vout[1]` is unchanged.

The maker holds the unbroadcast commit tx until the taker signs the completed reveal; an abandoned claim costs the maker zero on-chain fee.

| Property                              | Whole-UTXO path (§5.7.6, `0x26`) | Variable-amount path (§5.7.6.1, `0x37`) |
|---------------------------------------|----------------------------------|------------------------------------------|
| On-chain advertising of the intent    | Yes (commit_tx visible)          | No (worker record only)                  |
| Maker sunk cost at publish            | ~1700 sats                       | Zero                                     |
| Maker can back out before take        | Only via reclaim-leaf            | Trivially (just don't fulfil)            |
| Settlement tx ancestry                | Reveal references confirmed commit | Reveal references mempool commit       |
| Atomicity                             | Preserved                        | Preserved                                |
| Continuous partial fills              | No (whole-UTXO only)             | Yes (any `requested ∈ [min, amount]`)    |

##### Claim message bump

```
// LEGACY whole-UTXO claim (unchanged):
claim_msg_v2 = SHA256("tacit-axintent-claim-v2"
                     || asset_id || intent_id || taker_pubkey
                     || taker_utxo_txid_BE(32) || taker_utxo_vout_LE(4))

// NEW variable-amount claim:
claim_msg_v3 = SHA256("tacit-axintent-claim-v3"
                     || asset_id || intent_id || taker_pubkey
                     || taker_utxo_txid_BE(32) || taker_utxo_vout_LE(4)
                     || requested_amount_LE(8))
```

`requested_amount` MUST satisfy `min_take ≤ requested ≤ amount`; the worker rejects out-of-range claims. The `v3` domain prevents `v2` sigs from being misused as `v3` (and vice versa). Legacy intents accept only `claim_msg_v2`; variable-amount intents accept only `claim_msg_v3`.

##### Fulfilment message and partial reveal

```
fulfilment_msg_v2 = SHA256("tacit-axintent-fulfilment-v2"
                          || asset_id || intent_id || taker_pubkey
                          || requested_amount_LE(8)
                          || SHA256(partial_reveal_json))
```

The `v2` domain bumps from §5.7.6's `v1` because: (a) the partial_reveal carries an N=2 `T_AXFER_VAR` envelope (not §5.7.6's N=1 `T_AXFER`), and (b) `requested_amount` is explicitly bound in the signature domain — defense-in-depth against `partial_reveal_json` parsing divergence between implementations.

Fulfilment is a four-leg exchange (maker → worker → taker → worker) followed by sequential broadcast:

**1. Maker prepares (after reading the claim's `requested_amount`).**

The maker derives blindings, builds the envelope, and constructs both the commit tx (unbroadcast) and the partial reveal tx (maker-signed but missing taker funding):

- **Blindings.**
  - Recipient: `r_recip := r XOR HMAC-SHA256(SHA256(ECDH(maker_priv, taker_pub)), "tacit-axintent-blinding-v1" || intent_id || asset_id)` (per-intent secret `r` held privately since publish — unchanged from §5.7.6).
  - Maker change: `r_change := HMAC-SHA256(maker_priv, "tacit-axintent-change-v1" || intent_id || asset_id)`. Self-derivable from seed + intent_id (load-bearing for on-chain recovery below).
- **Output commitments.**
  - `C_recip  = requested_amount · H + r_recip · G`
  - `C_change = (amount − requested_amount) · H + r_change · G`
- **Aggregated bulletproof** over `{C_recip, C_change}` per §5.7.9.
- **Kernel.** `excess = r_recip + r_change − r_listed (mod n)`; `kernel_msg = computeKernelMsg(asset_id, [asset_utxo], [C_recip, C_change], burned=0)` per §5.4.3; `kernel_sig = SignSchnorr(kernel_msg, excess)` under `(excess · G).x_only()`.
- **Envelope.** Encode the `T_AXFER_VAR` payload per §5.7.9. Wrap in the standard envelope script under maker's x-only internal key.
- **Commit tx (unbroadcast).** Single-output tx paying `DUST + estimated_reveal_fee` to the P2TR address derived from the envelope script's leaf hash.
- **Vout layout.** Must match §5.7.9 wire format:
  - `vout[0]`: DUST P2WPKH(taker_pub) — recipient tacit UTXO.
  - `vout[1]`: `floor(requested_amount × price_sats / amount)` sats to `maker_address` — BTC payment, scaling linearly with the take fraction.
  - `vout[2]`: DUST P2WPKH(maker_pub) — maker's change tacit UTXO.
  - `vout[3]`: `OP_RETURN(0x6a) || OP_PUSHDATA1(0x4c) || 0x50 || payload_80` — MANDATORY 83-byte scriptPubKey carrying the dual-recovery payload (see *On-chain recovery* below).
  - `vout[4+]`: taker BTC change (added by taker at completion).
- **Maker signs the partial reveal.** `vin[0]` (commit P2TR script-path) signed SIGHASH_SINGLE_ACP bind­ing `vout[0]`; `vin[1]` (asset UTXO P2WPKH) signed SIGHASH_SINGLE_ACP binding `vout[1]` (BTC payment). A taker cannot redirect or inflate the BTC payment without invalidating this signature.

**2. Maker POSTs the fulfilment to the worker.**

```
POST /atomic-intents/{asset_id}/{intent_id}/fulfilment
{
  taker_pubkey, requested_amount,
  commit_tx_hex,              // unbroadcast
  envelope_script_hex, control_block_hex, p2tr_spk_hex,
  partial_reveal,             // JSON: inputs[0..1], outputs[0..3], witnesses
  enc_recipient_blinding,     // for legacy takers without OP_RETURN path
  fulfilment_sig              // BIP-340 over fulfilment_msg_v2
}
```

The worker validates and transitions the claim to `COMMIT_READY`. **No on-chain activity has occurred yet.**

**3. Taker downloads, verifies, completes the reveal.** Taker checks: `commit_tx_hex` derives to the claimed P2TR address; partial reveal's `vin[0]` references `commit_tx_hex:0`; both SIGHASH_SINGLE_ACP signatures verify; bulletproof + kernel sig verify; `requested_amount` matches the claim; `vout[1]` value equals `floor(requested_amount × price_sats / amount)`; `vout[3]` is the mandatory `OP_RETURN(80)` recovery payload; `fulfilment_sig` verifies under `maker_pubkey`. On pass, taker appends BTC funding inputs and change vout, signs SIGHASH_ALL, returns to worker.

**4. Worker performs sequential broadcast.** Worker broadcasts `commit_tx`, polls for mempool visibility, then broadcasts the completed reveal (CPFP-package by ancestor feerate). BIP-431 package relay (TRUC v3) MAY be used where supported.

##### Worker state machine

```
OPEN
  ↓ taker claim, requested_amount ∈ [min_take, amount]
CLAIMED(taker, requested_amount, ttl)
  ↓ maker POSTs fulfilment; worker validates
COMMIT_READY
  ↓ taker completes the reveal, submits to worker
REVEAL_READY
  ↓ worker broadcasts commit_tx
COMMIT_BROADCAST
  ↓ commit_tx visible in mempool
REVEAL_BROADCAST
  ↓ reveal confirmed
SETTLED
```

While `CLAIMED` or later, the worker MUST NOT offer the same `intent_id` to another taker.

| Transition                            | TTL     | On expiry                                  |
|--------------------------------------|---------|---------------------------------------------|
| CLAIMED → COMMIT_READY               | ~5 min  | Revert to OPEN. No on-chain activity yet.   |
| COMMIT_READY → REVEAL_READY          | ~5 min  | Revert to OPEN. No on-chain activity yet.   |
| REVEAL_READY → COMMIT_BROADCAST      | seconds | Worker-internal.                            |
| COMMIT_BROADCAST → REVEAL_BROADCAST  | ~30s    | Worker logs; commit becomes maker-only UTXO; maker reclaims via leaf-path. |

##### Bounded recipient amount

`requested_amount ∈ [min_take_amount, amount]`. BTC payment scales linearly:

```
payment_sats = floor(requested_amount × price_sats / amount)
```

Rounding is floor (taker pays at most one sat less than proportional; the maker accepts this rounding loss). The reference dApp warns when `floor(price_sats × min_take_amount / amount) < DUST` — sub-dust payments are unspendable.

##### On-chain recovery (dual-party, seed-only)

§5.7.6 settled recipient-side recovery via a 40-byte `OP_RETURN` carrying the encrypted `(amount, r)` opening so the taker can re-derive their opening from `(taker_priv, chain)` alone. `T_AXFER_VAR` introduces a maker-side recovery problem: `requested_amount` is taker-chosen and lives only in the taker-encrypted OP_RETURN, the worker's claim record (24-hour TTL), and the maker's local cache. If the maker loses local state and the worker has GC'd the claim, the maker cannot reconstruct the change amount without brute-forcing the commitment — intractable for u64.

**Resolution: `T_AXFER_VAR` settlements MUST carry an 80-byte recovery payload split into two 40-byte halves — one ECDH-encrypted to the taker, one keystream-encrypted to the maker under their own privkey.**

```
script_83 = OP_RETURN(0x6a) || OP_PUSHDATA1(0x4c) || 0x50 || payload_80
payload_80 layout:
  bytes[ 0..40]   taker_payload  (recipient recovery — same encoding as §5.7.6)
  bytes[40..80]   maker_payload  (maker change recovery)
```

The OP_RETURN output is **mandatory** for every `T_AXFER_VAR` settlement. A reveal without an 80-byte recovery output at `vout[3]` is invalid; validators MUST reject. An equivalent split into two separate `OP_RETURN(0x6a) || OP_PUSHBYTES_40(0x28) || payload_40` outputs at `vout[3]` and `vout[4]` is also valid; the canonical form is the single `OP_RETURN(80)`. Indexers MUST accept both; payload ordering (taker first, maker second) is fixed in both.

**Taker payload** (unchanged from §5.7.6):

```
ks_taker_amt   = HMAC-SHA256(SHA256(ECDH(maker_priv, taker_pub)),
                            "tacit-axintent-onchain-amount-v1" || intent_id || asset_id)
ks_taker_blnd  = HMAC-SHA256(SHA256(ECDH(maker_priv, taker_pub)),
                            "tacit-axintent-onchain-blinding-v1" || intent_id || asset_id)
taker_payload  = (requested_amount_LE  XOR ks_taker_amt[0..8])    (8 bytes)
              || (r_recipient_LE32     XOR ks_taker_blnd[0..32])  (32 bytes)
```

**Maker payload** (new):

```
ks_maker_amt   = HMAC-SHA256(maker_priv,
                            "tacit-axintent-onchain-maker-amount-v1" || intent_id || asset_id)
ks_maker_blnd  = HMAC-SHA256(maker_priv,
                            "tacit-axintent-onchain-maker-blinding-v1" || intent_id || asset_id)
maker_payload  = ((amount − requested_amount)_LE  XOR ks_maker_amt[0..8])   (8 bytes)
              || (r_change_LE32                   XOR ks_maker_blnd[0..32]) (32 bytes)
```

The maker's keystream is derived from `maker_priv` alone — no ECDH needed since the maker is decrypting their own data. The keystream binds `intent_id` and `asset_id` so payloads cannot be replayed across settlements.

**External-observer privacy:** both payloads are keystream-encrypted, so a passive chain observer learns neither `requested_amount` nor the change amount from the OP_RETURN alone.

**Maker recovery flow** (from seed alone, no local state):

1. Reimport `maker_priv`.
2. Scan chain for txs where `vin[1].witness[1] == maker_pub` AND `vin[0].witness[1]` decodes as a `T_AXFER_VAR` envelope (opcode `0x37`) under the commit P2TR script-path leaf.
3. Re-derive `intent_id` from `vin[1]`'s outpoint via `SHA256("tacit-axintent-id-v1" || maker_pubkey || asset_utxo_txid_BE || asset_utxo_vout_LE)[:16]`.
4. Re-derive `ks_maker_amt`, `ks_maker_blnd`.
5. Extract `OP_RETURN(80)`; decrypt the second 40 bytes.
6. Verify `pedersen_commit(change_amount, r_change) == C_change` against `vout[2]`'s tacit commitment.
7. If verified, record the change UTXO as spendable.

**On-chain cost.** The 80-byte recovery output is 91 vbytes (8 B value + 1 B scriptPubKey-length prefix + 82 B scriptPubKey). OP_RETURN is non-witness data — no SegWit discount. §5.7.6's single-party 40-byte recovery output is 51 vbytes; delta is ~40 vbytes (~400 sats at 10 sat/vB). The maker bears this cost as part of the settlement tx fee.

#### 5.7.7 Bid intents (off-chain buyer-side coordination)

§5.7.6 covers the seller-initiated flow: a holder publishes an intent to sell N units at price P, any taker claims. §5.7.7 mirrors that for the **buyer-initiated** direction: a would-be holder publishes an intent to BUY N units at price P, any seller claims by spinning up a §5.7.6 (or §5.7.6.1 variable-fill) atomic intent **specifically targeted at the bidder's pubkey**, which the bidder then takes through the existing §5.7.3 flow. **Settlement uses the corresponding settlement opcode** — `T_AXFER` (`0x26`) for whole-only bids, `T_AXFER_VAR` (`0x37`, §5.7.9) for variable-fill bids. The §5.7.7 bid layer itself adds no new wire format and no new validator rule; it's a pure off-chain coordination shape over the existing on-chain settlement opcodes.

**Why bid intents are off-chain in v1.** A naïve "buyer commits sats with a script-path P2TR" design doesn't work in current Bitcoin script: the T_AXFER envelope's kernel signature binds the seller's asset input outpoints, but those outpoints are unknown at bid-publish time, so the buyer can't precompute the envelope and can't commit it into their P2TR's tap-tree. Bitcoin script lacks the introspection covenants (no `OP_CHECKVOUTPUTSPK`, no `OP_CTV`) that would let the buyer's lock be conditionally unlocked by a tx-structure check. v1 bids therefore live entirely in the worker layer, with the trust model of any off-chain order book: the bidder is trusted to follow through on their take. Anti-spam mitigations (sig-required POSTs, per-IP rate limits, bid-expiry caps) sit in the worker.

A future protocol revision with on-chain escrow (true buyer-funded atomic settlement) is feasible via either (a) BIP-119 OP_CTV / BIP-345 OP_VAULT once one ships at consensus, or (b) a two-commit architecture where buyer and seller each pre-broadcast a commit and the reveal spends both — operationally heavier (3 txs per settlement vs §5.7.6's 2) but viable today. V1 keeps the simpler off-chain pattern; a follow-up amendment can add escrow as a separate primitive.

##### Records

The off-chain bid book stores three records per bid, all worker-managed:

```
bid_intent {
  bid_id            16 bytes / 32 hex chars  (sha256(asset_id || buyer_pubkey || nonce)[:16])
  asset_id          32 bytes
  buyer_pubkey      33 bytes (compressed) — where the bid-converted axintent
                    will deliver. The bidder's tacit recipient pubkey.
  buyer_address     bech32, derived as P2WPKH(buyer_pubkey). Sellers compare
                    hash160 against the eventual claim's vout[0] script.
  amount            u64 base units (cleartext — what the bidder wants to receive)
  price_sats        u64 (cleartext — total sats the bidder agrees to pay)
  expiry            unix-seconds (≤ 30 days from publish — shorter than ask
                    intents because no on-chain lock exists)
  nonce             32 bytes (random, included so a bidder can post multiple
                    independent bids on the same asset)
  intent_sig        BIP-340 over bid_intent_msg, under buyer_pubkey
  created_at        unix-seconds (worker-stamped)
}

bid_claim {
  bid_id, seller_pubkey (33B compressed), seller_utxo_txid, seller_utxo_vout,
  axintent_id       16B — the atomic intent the seller has published in
                    response, targeted at this bid's buyer_pubkey
  sig               BIP-340 over bid_claim_msg under seller_pubkey
  claimed_at        unix-seconds, expires_at = claimed_at + 30 minutes
}
```

There is **no separate `bid_fulfilment` record** — fulfilment is just the bidder taking the axintent the seller published, which uses §5.7.6's existing `axintent_fulfilment` flow.

##### Canonical messages

```
bid_intent_msg = SHA256(
    "tacit-bid-intent-v1"
    || asset_id(32) || bid_id(16) || buyer_pubkey(33)
    || amount_LE(8) || price_LE(8) || expiry_LE(8)
    || nonce(32)
)

bid_claim_msg = SHA256(
    "tacit-bid-claim-v1"
    || asset_id || bid_id || seller_pubkey
    || axintent_id(16)
)

bid_cancel_msg = SHA256("tacit-bid-cancel-v1" || asset_id || bid_id)
```

`bid_id` derives from `(asset_id, buyer_pubkey, nonce)` — same bidder can post multiple independent bids on the same asset, distinguishable by nonce.

##### Lifecycle

```
[publish]   buyer:   sign bid_intent_msg → POST /bid-intents → stored
[browse]    anyone:  GET /assets/:aid/bid-intents → discover open bids
[accept]    seller:  decide to fulfil a bid; build an atomic intent
                     (§5.7.6) targeted at bid.buyer_pubkey from one of their
                     asset UTXOs; broadcast the axintent's commit tx;
                     POST /bid-intents/:bid_id/claim with axintent_id →
                     30-min lock on the bid record
[take]      buyer:   GET the claim; reads the linked axintent_id; treats it
                     as a regular §5.7.6 axintent and goes through the take
                     flow (POST claim, GET fulfilment, append BTC funding
                     SIGHASH_ALL, broadcast)
[settled]   anyone:  on-chain T_AXFER is indistinguishable from a §5.7.3
                     settlement (or §5.7.6) — bid intents converge to the
                     same wire format
```

If the seller doesn't claim within `bid.expiry`, the bid simply expires (no on-chain reclaim needed — there was nothing locked on-chain). The buyer can re-publish at any time.

##### Trust analysis

Bid intents are **off-chain coordination only**. Concrete properties:

- **Buyer doesn't risk sats at bid time.** Nothing is locked. They sign a directive saying "I'd pay this." If they ghost at take time, they lose nothing (and so does anyone else, since the seller hasn't broadcast the axintent yet — only the commit-tx is on chain, and the seller can self-cancel via §5.7.6's reclaim path).
- **Seller risks one commit-tx fee** when they choose to claim a bid. If the bidder ghosts after the seller has published the axintent, the seller can reclaim their asset by self-cancelling the axintent (the existing flow). They lose only the commit-tx cost (~$1–3 mainnet).
- **No buyer→seller trust required for delivery.** The §5.7.6 flow is fully atomic: when the bidder takes the axintent, settlement is guaranteed in one tx.
- **Spam vector.** Bidders can post bid intents with no follow-through cost. Mitigations: (a) BIP-340 sig required on POST, so spammers must control the bidder pubkey they're impersonating; (b) per-IP rate limit on `/bid-intents` POSTs (mirrors the airdrop-claim rate-limit pattern); (c) `expiry ≤ 30 days` cap, so stale bids GC.
- **Liveness.** Both sides must be online during the take window. Same as §5.7.6.

##### Worker endpoints (reference)

```
POST   /assets/:asset_id/bid-intents
GET    /assets/:asset_id/bid-intents
DELETE /assets/:asset_id/bid-intents/:bid_id              (signed cancel)
POST   /assets/:asset_id/bid-intents/:bid_id/claim        (signed by seller, links axintent_id)
GET    /assets/:asset_id/bid-intents/:bid_id              (returns intent + claim if any)
```

The worker validates: BIP-340 sig per canonical msg; bid_id derivation from (asset_id, buyer_pubkey, nonce); reasonable amount/price/expiry bounds.

##### Comparison with §5.7.6

|  | §5.7.6 (ask) | §5.7.7 (bid) |
|---|---|---|
| Initiator | seller | buyer |
| On-chain commit at intent | yes (seller's commit P2TR with envelope) | no — bid is purely off-chain |
| Sats locked at intent | n/a (sats not yet involved) | no |
| Cost to publish | ~1 commit tx fee (~$1-3 mainnet) | zero |
| Cost to ghost | maker forfeits commit tx fee | bidder forfeits nothing (reputation risk) |
| Settlement wire format | T_AXFER opcode 0x26 | T_AXFER opcode 0x26 (via auto-converted axintent) |
| Settlement tx count | 2 (commit + reveal) | 3 (no buyer commit, but seller still posts an axintent commit + reveal — the bid intent itself is off-chain) |
| Recovery semantics | §5.7.6 exception (random `r`) | inherited (the converted axintent uses §5.7.6 recovery) |

Both flows can coexist on the same asset: a buyer can post a bid at the same time another holder posts an ask. Whichever gets matched first settles; the other expires.

This primitive is implementation-defined in v1: the wire format above is the canonical reference for any implementation that wants to interoperate with the reference dApp's marketplace. Indexer-level validity is unaffected — bid intents live entirely outside the on-chain protocol; all settlement is normal `T_AXFER` via §5.7.6.

#### 5.7.8 Preauth sales (buyer-completable T_AXFER)

§5.7.6 atomic intents require the maker to come back online during the 5-min claim window: the recipient blinding `r` is a uniform-random scalar fixed at intent-publish time and has to be encrypted to a specific taker at fulfilment. That round-trip is fine for trader-to-trader OTC but rules out the UniSat-style flow most marketplace users expect ("seller lists once, walks away; buyer clicks Buy"). Preauth sales remove the maker-online requirement by making one specific exchange: the maker publishes the listed UTXO's `(amount, blinding)` opening at listing time, and the buyer derives an ECDH-recoverable `r_out` against the maker's pubkey per §5.7.3 — same recovery path as targeted offers. The crypto delta is exactly one bit: random per-intent `r` (§5.7.6, encrypted at fulfilment) → ECDH-derived `r_out` (§5.7.3 / §3.5, recoverable from chain + privkey). No new opcode, no validator change, no consensus implication: on-chain bytes are indistinguishable from a §5.7.3 targeted settlement.

The maker still has to authorize the sale before going offline. That authorization has two parts:

1. **A signed sale message** (`tacit-preauth-sale-v1` below) that binds asset_id, exact asset outpoint, opening, min price, payout script, expiry, and a per-listing nonce — all under the maker's BIP-340 key.
2. **A pre-signed P2WPKH spend signature for `vin[1]`** with `SIGHASH_SINGLE | ANYONECANPAY` (= `0x83`), binding the asset input to `vout[1] = seller_payout_script` paying `min_price_sats`. This is the Bitcoin-consensus authorization that lets the buyer's later settlement tx actually spend the listed UTXO without the maker present.

The seller-spend signature is the load-bearing piece. Without it, the buyer can construct a valid tacit kernel + envelope (the opening is public), but Bitcoin consensus rejects the tx because `vin[1]`'s witness is missing. With it, the buyer composes the rest of the tx around the maker's signed input/output pair and Bitcoin consensus enforces the maker's payout terms.

##### The seller_asset_spend signature

The maker signs a deterministic skeleton tx with `SIGHASH_SINGLE | ANYONECANPAY` over the asset input. Per BIP-143:

```
hashPrevouts  = 0x00..00   (ANYONECANPAY set → other inputs' outpoints don't sign)
hashSequence  = 0x00..00   (ANYONECANPAY set → other inputs' sequences don't sign)
hashOutputs   = dSHA256(out_value_LE(8) || out_scriptpubkey_varslice)
                where out_value = min_price_sats, out_scriptpubkey = seller_payout_script
                (SIGHASH_SINGLE on input_index=1 signs only vout[1])

preimage =
    nVersion_LE(4)                     // integer 2
 || hashPrevouts(32)                   // 32 zero bytes
 || hashSequence(32)                   // 32 zero bytes
 || outpoint_BE(32) || vout_LE(4)      // asset_outpoint
 || scriptCode_varslice                // P2WPKH scriptCode: 19 || 76 a9 14 || hash160(seller_pubkey) || 88 ac
 || value_LE(8)                        // asset_outpoint.value (sats)
 || nSequence_LE(4)                    // integer 0xfffffffd (BIP-125 RBF-opt-in, matches reference dApp)
 || hashOutputs(32)                    // dSHA256(min_price_sats_LE(8) || varslice(seller_payout_script))
 || nLocktime_LE(4)                    // integer 0
 || nHashType_LE(4)                    // integer 0x83 (SIGHASH_SINGLE | SIGHASH_ANYONECANPAY)

sighash = dSHA256(preimage)
signature_bytes = DER(sign_ecdsa_lowS(sighash, seller_priv)) || byte 0x83
```

Every field above is derivable from the sale-auth message, so the worker (and any verifier) reconstructs the preimage byte-for-byte and rejects the listing if `ecdsa_verify(sighash, signature_bytes[:-1], seller_pubkey)` fails or if the trailing byte is not `0x83`. The buyer's settlement tx must place this signature in `vin[1].witness = [signature_bytes, seller_pubkey]`; Bitcoin consensus rejects any settlement that modifies the asset outpoint, the payout value, or the payout script — the maker's signature would simply not verify.

The buyer is free to add `vin[0]` (commit/envelope), `vin[2..]` (BTC funding, signed `SIGHASH_ALL`), and `vout[0]` (buyer's tacit output), `vout[2..]` (change, fees). None of those touch the maker's sighash preimage.

##### Records

The off-chain marketplace stores one record per active sale plus an event log:

```
sale {
  sale_id              16 bytes / 32 hex chars (sha256("tacit-preauth-sale-id-v1" || asset_outpoint_txid_BE
                       || asset_outpoint_vout_LE || seller_pubkey || nonce)[:16])
  asset_id, seller_pubkey (33B compressed),
  asset_outpoint       { txid, vout, value }
  asset_opening        { amount: u64_str, blinding: 32B hex }   // cleartext disclosure of the listed UTXO
  min_price_sats       u64
  seller_payout_script raw script bytes (typically P2WPKH(seller_pubkey), but ANY locking script is fine
                       as long as the wallet/relay accepts it as a P2WPKH-style output)
  expiry               unix-seconds (≤ 365 days from publish, matching §5.7.6)
  seller_asset_spend   { signature_hex: DER+0x83, derivable from the fields above per the preimage recipe }
  auth_sig             BIP-340 over sale_auth_msg, under seller_pubkey
  nonce                16 random bytes (lets the seller cancel + re-list the same outpoint with a fresh sale_id)
  status               'live' | 'taken' | 'cancelled' | 'expired' | 'stale_spent'
}

cancel { sale_id, asset_id, seller_pubkey, sig }    // explicit signed teardown
```

The recipient blinding `r_out` is **not** stored on the worker. The buyer derives it locally at take time via `deriveBlinding(buyer_priv, seller_pubkey, asset_outpoint_anchor, 0)` (§3.5 / §5.7.6 ECDH symmetry) — same primitive the official wallet's recovery loop uses, so the buyer's new UTXO is recoverable from chain + privkey alone with no local-cache dependency.

##### Canonical messages

```
sale_auth_msg = SHA256(
    "tacit-preauth-sale-v1"
    || asset_id(32) || sale_id(16) || seller_pubkey(33)
    || asset_outpoint_txid_BE(32) || asset_outpoint_vout_LE(4) || asset_utxo_value_LE(8)
    || amount_LE(8) || blinding(32)
    || min_price_sats_LE(8)
    || varslice(seller_payout_script)
    || expiry_LE(8)
    || varslice(seller_asset_spend_signature)        // DER || 0x83
    || nonce(16)
)

sale_cancel_msg = SHA256("tacit-preauth-sale-cancel-v1" || asset_id || sale_id)
```

`varslice(x)` is `varint(len(x)) || x` matching Bitcoin's wire format. Network is implicit through `asset_id` uniqueness (asset_ids derive from per-network etch txids, so cross-network replay is excluded by 1/2^256 chain divergence — same convention as §5.7.6).

##### Lifecycle (state machine)

```
[publish]   seller:  build sale-auth body + seller_asset_spend → POST /preauth-sales
                     (no on-chain footprint at this stage — pure off-chain listing)
[browse]    anyone:  GET /preauth-sales → discover open listings
[take]      buyer:   GET /preauth-sales/:sale_id → reconstruct skeleton, build commit P2TR,
                     compute r_out via ECDH, build T_AXFER envelope + kernel sig + bulletproof,
                     append BTC funding signed SIGHASH_ALL, broadcast reveal
[settled]   anyone:  on-chain T_AXFER is indistinguishable from §5.7.3 settlement
[cancel]    seller:  POST /preauth-sales/:sale_id/cancel (signed) → status = 'cancelled'
            anyone:  asset outpoint spent in any tx → worker marks 'stale_spent' on next scan
                     expiry passes → worker marks 'expired' on read
```

There is no claim/lock step. The settlement tx itself is the lock: Bitcoin consensus settles exactly one spend of the asset UTXO. Two buyers racing the same listing both build valid settlement txs locally; the one that confirms wins, the other is rejected by node mempool policy (double-spend) or by reorg-rescan. A worker-side per-sale lock during take is still recommended as a UX courtesy (returns 409 to losing buyers immediately instead of waiting for mempool rejection), but it's not load-bearing for correctness.

##### Trust analysis

Inherits §5.7.2 soundness from `T_AXFER` plus two coordination-layer guarantees:

- **Seller can't lose the asset without receiving the signed payout.** `seller_asset_spend` is `SIGHASH_SINGLE | ANYONECANPAY` over `(vin[1], vout[1])` only. Any settlement tx that omits `vout[1]`, redirects it, lowers its value, or replaces the script invalidates the seller's signature → Bitcoin consensus rejects.
- **Buyer can't get the asset without paying.** Buyer's BTC funding inputs sign `SIGHASH_ALL`. Removing the seller payout output from the broadcast tx changes the buyer's sighash → buyer's own signature becomes invalid. Buyer can't produce a fresh sig that excludes the payout because the seller's `vin[1]` sig (unchanged) would then bind a nonexistent output.

What preauth sales *don't* protect against:

- **Seller double-spend race.** Between publish and settlement broadcast, the seller can spend the asset UTXO in a different tx (e.g., a private transfer to themselves). Same race as §5.7.6 atomic intents and as every off-chain Bitcoin marketplace; mitigation is worker-side outspend monitoring + read-time stale filtering + buyer rebroadcast with CPFP if their settlement loses the race.
- **Buyer payment-UTXO double-spend.** A buyer could broadcast their settlement and then RBF a different tx spending the same BTC funding inputs to themselves before the settlement confirms. This is a CPFP/RBF arms race indistinguishable from any other Bitcoin take. Mitigation: worker pre-checks buyer payment outpoints are unspent at take time; UI shows confirmation depth before treating the sale as final.
- **Vout[2..] outputs.** The seller's `SIGHASH_SINGLE | ANYONECANPAY` signature binds vout[1] only. Marketplace fees, creator royalties, or any other auxiliary outputs are **not** bound by the seller's signature and can be added/omitted/redirected by a custom buyer client without invalidating the seller's spend. Any fee enforcement above the protocol must live in worker validation and the official dApp's tx construction; alternative clients may bypass.

##### Recovery semantics

Unlike §5.7.6 atomic-intent recipients (random `r`, recovery via local cache or 24h-TTL re-fetch), preauth-sale recipients use ECDH-derived `r_out`. The buyer's recipient UTXO recovers via §6 path 2 from chain + privkey alone — `vin[1].witness[1]` exposes the seller pubkey, the buyer's wallet redoes the ECDH against its own privkey, recomputes the same `r_out`, decrypts `amount_ct`, and verifies `pedersenCommit(amount, r_out) == output_commitment`. No worker dependency post-confirmation.

The seller's own change UTXOs (if any — preauth sales typically sell whole UTXOs, but a buyer-completable variant that splits and returns change to the seller is possible by adding another tacit vout) recover via §6 path 4 (self-derived blinding), same as any CXFER change. The seller's recovery is unaffected by preauth sales: their listed UTXO's `(amount, blinding)` were already known to them, and the new state after settlement is just "that UTXO is now spent."

##### Confidentiality footprint

Publishing the listed UTXO's `(amount, blinding)` reveals exactly one historical UTXO. The disclosure is permanent for that UTXO (anyone can recompute `pedersenCommit(amount, blinding) == on_chain_C` forever) but is bounded:

- The seller's **other** asset UTXOs of the same asset stay confidential — their commitments are unrelated points and revealing one opening tells an observer nothing about another.
- The seller's **balance** in any other asset is unaffected.
- After settlement, the **new owner**'s recipient UTXO uses a fresh ECDH-derived `r_out` and is confidential again. The historical listed UTXO remains in the chain's spent set with its opening permanently known, but the new owner's holding is private.
- A holder who values lot-level privacy more than UX can route through §5.7.6 atomic intents instead (the listed amount is still public, but `r` stays private to the seller).

This is a deliberate tradeoff: §5.7.6 = no lot-level opening, requires seller online; §5.7.8 = public lot-level opening, seller can go offline. The reference dApp ships both and lets the seller choose per listing.

##### Worker endpoints

```
POST   /assets/:asset_id/preauth-sales
GET    /assets/:asset_id/preauth-sales
GET    /assets/:asset_id/preauth-sales/:sale_id
DELETE /assets/:asset_id/preauth-sales/:sale_id          (signed cancel)
```

Worker validation on POST must:

```
verify auth_sig under seller_pubkey over sale_auth_msg
verify asset_outpoint exists, is unspent, and is owned by seller_pubkey (P2WPKH hash160 match)
verify asset_opening commits to the on-chain commitment for that outpoint
reconstruct the seller_asset_spend sighash preimage from the sale-auth fields and verify
  ecdsa(sighash, signature[:-1], seller_pubkey) succeeds and signature[-1] == 0x83
reject if a live preauth-sale already exists for the same asset_outpoint
enforce expiry ≤ 365 days from now
```

On read, the worker filters out sales whose asset_outpoint has been spent (outspend check, same SWR/cache pattern as §5.6 listings) and surfaces a `stale_spent` flag rather than silently hiding them so the seller sees what happened.

Worker validation on take is not strictly required (Bitcoin consensus enforces the seller's terms regardless), but the reference dApp's official take path SHOULD re-verify (a) asset_outpoint still unspent, (b) buyer payment outpoints unspent, (c) the settlement tx the dApp built includes the exact vout[1] the seller signed — this catches buyer-side bugs before broadcast and gives the buyer a chance to fix them locally instead of paying a relay fee for a tx the network will reject.

This primitive is implementation-defined in v1: the wire format above is the canonical reference for any implementation that wants to interoperate with the reference dApp's marketplace. Indexer-level validity is unaffected — preauth sales live entirely outside the on-chain protocol; all settlement is normal `T_AXFER` and validates identically to a §5.7.3 targeted offer.

##### 5.7.8.1 Batched take (position-independent `SIGHASH_SINGLE_ACP`)

A single buyer who routes across `N ≥ 2` preauth sales (each from a distinct seller) MAY settle all `N` fills in one `T_AXFER` reveal tx instead of `N` independent settlements. This is a **flow-level optimization with no protocol change** — no new opcode, no new envelope variant, no listing-schema migration, no worker validation change. Listings published before this subsection was added remain batchable as-is because the seller's `seller_asset_spend` signature has a position-independence property that's load-bearing for batching.

**The load-bearing invariant.** The maker signs with `SIGHASH_SINGLE | SIGHASH_ANYONECANPAY` (`0x83`). The BIP-143 preimage for this flag set is:

```
nVersion          (4)
hashPrevouts      = 0x00..00      ← ANYONECANPAY zeros this
hashSequence      = 0x00..00      ← ANYONECANPAY (and SIGHASH_SINGLE) zero this
this.outpoint     (36)            ← the signing input's asset outpoint
this.scriptCode   (varslice)      ← P2WPKH(seller_pubkey)
this.value        (8)             ← the signing input's UTXO value
this.nSequence    (4)             ← 0xfffffffd by SPEC convention
hashOutputs       = dSHA256(serialize(outputs[input_index]))
                                  ← SIGHASH_SINGLE hashes ONLY the same-index output
nLocktime         (4)             ← 0
nHashType         (4)             ← 0x83
```

The only `input_index`-dependent term is `hashOutputs`, which evaluates to `dSHA256(serialize(outputs[input_index]))`. Every other field is a constant of the signing seller's UTXO + listed terms. If the buyer places the seller's payout output (`value = min_price_sats`, `script = seller_payout_script`) at `vout[k]`, then `hashOutputs` evaluates to the identical 32 bytes regardless of `k`. **The preimage is bit-identical across positions; the signature validates at any vin index.**

A seller's single-slot pre-signature (signed assuming the maker's input lands at `vin[1]` and the payout at `vout[1]`) therefore validates as `vin[k].witness` for any `k ∈ [1, 255]` provided:

1. `tx.inputs[k].outpoint` equals the seller's `asset_outpoint`,
2. `tx.inputs[k].sequence == 0xfffffffd`, and
3. `tx.outputs[k]` equals `{ value: min_price_sats, script: seller_payout_script }`.

**Batched reveal layout (`N` sellers in one settlement tx):**

```
vin[0]        buyer's commit P2TR      — script-path-spends the envelope
vin[1..N]     seller_i's asset UTXOs   — each carries its existing pre-signed
                                          SIGHASH_SINGLE_ACP witness at THIS
                                          position; vout[1+i] MUST be seller_i's
                                          payout
vin[N+1..]    buyer's P2WPKH funding   — SIGHASH_ALL on the whole tx

vout[0]       buyer's combined recipient (DUST P2WPKH); Pedersen commitment in
              the envelope payload is pedersen(Σ amount_i, r_out)
vout[1..N]    seller_i's payouts       — bound by SIGHASH_SINGLE_ACP on vin[1+i]
vout[N+1]     buyer change             — OPTIONAL, present iff ≥ DUST
```

**AXFER payload field constraints:**

- `asset_input_count = N` (consumes the `1..255` range the wire format already permits in §5.7's T_AXFER decoder).
- `N_outputs = 1` (a single combined recipient; per §5.4 the outputs count must be in `{1, 2, 4, 8}`).
- `output[0].commitment = pedersen(Σ_i amount_i, r_out)` where `r_out` is derived via `deriveBlinding(buyer.priv, seller_0.pub, seller_0.outpoint, 0)` (the first seller's ECDH anchor — matches the wallet-recovery scanner's `firstIn = tx.vin[1]` convention so recovery works unchanged).
- `output[0].encrypted_amount` encrypts `Σ_i amount_i` under the same first-seller ECDH keystream.
- `kernel_sig` signs the standard kernel message over `(asset_id, [N input outpoints], [output[0].commitment])` with `excess = (r_out − Σ_i blinding_i) mod n`.
- `rangeproof` is a single-output bulletproof for `Σ_i amount_i`; size matches a 1-output proof (~688 bytes for `m=1`), not N×.

**Worker trade-record accounting.** The worker dedupes hints by `(asset_id, reveal_txid)` via `bumpTransferCount`. A batched reveal is ONE `txid` and therefore ONE trade event; emitting `N` per-fill hints with individual `price_sats` would record only the first fill's price and undercount 24h volume by `~(N-1)/N`. Implementations MUST emit **exactly one** hint per batched reveal with:

- `price_sats = Σ_i min_price_sats_i`
- `amount = String(Σ_i amount_i)`
- `listing_kind = "instant-batch"` (distinguishable from single-take's `"instant"`)
- `fill_count = N` (integer ∈ `[1, 255]`; older worker builds tolerate the field by silently coercing to 1, newer builds store it on the `last_trade` + recent-trades ring for chart/tape multi-fill annotation)

**Failure semantics.** Pre-flight (parallel `getOutspend` on every seller's asset UTXO) runs BEFORE the buyer's commit broadcasts. If any seller's UTXO is already spent, the buyer aborts the batch and pays zero on-chain fees. Post-commit failures (reveal fails relay, indexer issue) are recoverable via script-path-spend of the commit P2TR using the saved envelope script + control block — same recovery primitive as single-take §5.7.8, just with a `batch[]` array in the recovery record carrying per-sale openings.

**Backwards compatibility.** Single-take §5.7.8 settlements remain valid and unchanged. A batched reveal is wire-indistinguishable from a multi-input CXFER except for the `T_AXFER` opcode byte. Indexers that already handle `asset_input_count ≥ 1` (any compliant §5.7 implementation) ingest batched reveals correctly. The `fill_count` hint field is the only schema addition; missing values silently default to 1.

#### 5.7.9 T_AXFER_VAR (`0x37`) — variable-amount atomic settlement

On-chain settlement opcode for §5.7.6.1 variable-amount atomic intents. Reuses CXFER N=2 cryptography (Pedersen + aggregated bulletproof + kernel sig) with the asset-input count tightened to exactly 1 and the vout layout interleaved so the maker's `vin[1]` SIGHASH_SINGLE_ACP signature binds the BTC payment at `vout[1]`.

**Wire format:**

```
opcode(1)              = 0x37
asset_id(32)
asset_input_count(1)   = 0x01 EXACTLY (tightened from T_AXFER's 1..255; see *Why exactly one asset input*)
N(1)                   = 0x02 (recipient_commit, maker_change_commit)
  for i in 0..N-1:
    commitment(33)     # compressed Pedersen point (NOT BIP-340 x-only)
    amount_ct(8)       # u64 HMAC keystream-encrypted ciphertext
rp_len(2 LE)
rangeproof(rp_len)     # aggregated bulletproof over m=2 commitments (CXFER §3.3.4 with m=2)
kernel_sig(64)         # BIP-340 over kernel_msg, signing key = (excess · G).x_only()
```

**Bitcoin transaction layout (normative — indexers reject deviations):**

```
vin[0]              = commit P2TR (envelope-bearing taproot script-path spend)
vin[1]              = maker's single tacit asset input (signed SIGHASH_SINGLE_ACP)
vin[2..]            = taker's BTC funding inputs (signed SIGHASH_ALL by taker at completion)

vout[0]             = recipient tacit       (DUST P2WPKH(taker_pubkey))
vout[1]             = maker BTC payment     (sats to maker_address;
                                             bound by vin[1] SIGHASH_SINGLE_ACP same-index rule;
                                             value = floor(requested_amount × price_sats / amount))
vout[2]             = maker change tacit    (DUST P2WPKH(maker_pubkey))
vout[3]             = OP_RETURN(80) dual-recovery payload (MANDATORY per §5.7.6.1 *On-chain recovery*;
                                             two-output split with OP_RETURN(40)+OP_RETURN(40)
                                             at vout[3] and vout[4] is also accepted)
vout[3+N_OP..]      = taker BTC change (added by taker at completion; unbound by maker's sig)
```

Validators MUST locate tacit outputs at indices `{0, 2}`. Any output at index `1` is the BTC payment and is NOT a tacit UTXO. This interleaved layout is the load-bearing difference vs `T_AXFER`, where tacit outputs are contiguous from `vout[0]`. A `T_AXFER_VAR` envelope under opcode `0x37` declares this layout unambiguously.

**Validator algorithm:**

```
if envelope.opcode == T_AXFER_VAR:
    require envelope.asset_id is well-formed (32 bytes)
    require N == 2                                   // recipient + maker_change
    require asset_input_count == 1                   // exact; see *Why exactly one asset input*
    require tx.vin.length >= 2                       // commit input + asset input minimum
    let asset_input = tx.vin[1]
    let aux_inputs  = tx.vin[2..]                    // taker's BTC funding; ungoverned

    require asset_input is a validateOutpoint() ⇒ true asset UTXO of envelope.asset_id

    // Recovery output is MANDATORY (§5.7.6.1 *On-chain recovery*):
    require vout[3] is either:
       (a) an OP_RETURN(0x6a) || OP_PUSHDATA1(0x4c) || 0x50 || 80-byte payload, OR
       (b) the first half of a split form: OP_RETURN(0x6a) || OP_PUSHBYTES_40(0x28) || 40-byte taker payload,
           with vout[4] carrying the matching 40-byte maker payload in the same form.
    // Failure here invalidates the settlement — both parties' seed-only recovery depends on this output.

    require aggregated bulletproof verifies over the N=2 output commitments
    require kernel_msg = SHA256(
        "tacit-kernel-v1"
        || asset_id(32)
        || asset_input_count_LE(1)                   // = 0x01
        || asset_input_outpoint (txid_BE(32) || vout_LE(4))
        || output_commitments_concat(2 × 33B)        // C_recip || C_change
        || burned_amount_LE(8) = 0
    )
    require kernel_sig verifies under (C_recip + C_change − C_listed).x_only()

    // Same domain tag ("tacit-kernel-v1") and same kernel-msg shape as CXFER §5.4 and T_AXFER §5.7.1.
    // The opcode byte is a presentation choice (what aux inputs are allowed; what vout layout
    // applies; whether the recovery OP_RETURN is mandatory) — not a cryptographic invariant.
    // A signature for one opcode does NOT verify under another because asset_input_count and
    // output count differ in the kernel msg.

    // Vouts beyond N-1 (i.e., index ≥ 2) are not tacit UTXOs except for vout[2]'s maker change.
    // The BTC payment at vout[1] and recovery OP_RETURNs at vout[3..] are non-tacit.
```

**Why exactly one asset input.** `T_AXFER_VAR` tightens `asset_input_count = 1` because:

1. **Variable-amount fills are inherently single-UTXO operations.** The maker is partially filling one listed UTXO; consuming multiple UTXOs in one settlement doesn't fit the intent shape (the intent record pins one `asset_outpoint`).
2. **SIGHASH_SINGLE binding only makes sense at one index.** The maker's BTC-payment binding works because `vin[1] ↔ vout[1]` under SIGHASH_SINGLE's same-index rule. With multiple asset inputs, `vin[2]`'s SIGHASH_SINGLE would bind `vout[2]` — the maker's tacit change output — adding spec surface area for no behavioral gain.
3. **Multi-input fulfilment is achievable via pre-consolidation.** A maker holding multiple small UTXOs that they want to use for a single variable-amount listing can self-CXFER them into one UTXO first, then publish the intent against the consolidated UTXO.

**Soundness.** The N=2 partial reveal inherits CXFER's soundness invariants verbatim (§5.4.4): the kernel signature binds `(asset_id, asset_inputs, output_commitments, burned=0)`; the aggregated bulletproof bounds each output to `[0, 2⁶⁴)`; balance equation `C_recip + C_change − Σ C_in = excess · G` is the same closure CXFER uses. Tampering with any output commitment breaks the kernel sig; tampering with any rangeproof element breaks bulletproof verification. Aux inputs at `vin[2..]` are Bitcoin-only and do not enter the kernel msg — they cannot affect the asset-side balance equation.

**Comparison with existing opcodes:**

|                              | CXFER (`0x23`)            | T_AXFER (`0x26`)                                     | T_AXFER_VAR (`0x37`)  |
|------------------------------|---------------------------|------------------------------------------------------|-----------------------|
| Outputs per envelope         | N ∈ {1, 2, 4, 8}          | N ∈ {1, 2, 4, 8}; N=1 in §5.7.6 intents             | N = 2 (fixed)         |
| asset_input_count            | 1..255                    | 1..255                                               | = 1 exactly (tightened) |
| Aux non-tacit inputs         | no                        | yes                                                  | yes                   |
| Tacit-output vout indices    | [0..N-1] contiguous       | [0..N-1] contiguous                                  | {0, 2} (BTC at vout[1]) |
| Recovery OP_RETURN           | not used                  | OPTIONAL 40-byte (§5.7.6 *Recovery*)                 | MANDATORY 80-byte     |
| Maker pre-signs?             | n/a                       | yes (whole-UTXO at intent-publish)                   | no — signs at fulfil  |
| Change output                | yes (self)                | no                                                   | yes (maker)           |
| Fill semantics               | bilateral                 | whole-UTXO                                           | continuous partial    |

The `T_AXFER_VAR` opcode is not strictly needed for cryptographic reasons — `T_AXFER`'s wire format already permits `N ∈ {1, 2, 4, 8}`, so an N=2 envelope under opcode `0x26` would parse. The new opcode is justified by **layout semantics**: it places the BTC payment at `vout[1]` (between the recipient tacit at `vout[0]` and the maker change at `vout[2]`) so that the maker's `SIGHASH_SINGLE_ACP` on `vin[1]` binds the BTC payment under SIGHASH_SINGLE's same-index rule. With contiguous tacit outputs the BTC payment couldn't be bound by the maker's asset-side signature, and a malicious taker could redirect the payment. The opcode also makes the 80-byte recovery OP_RETURN mandatory (vs optional 40-byte under `T_AXFER`), closing the seed-only-recovery exception for both parties.

`T_AXFER_VAR` reuses every cryptographic primitive already shipped for CXFER and T_AXFER: no new bulletproof variant, no new kernel-sig construction, no new domain tag for the kernel sig itself.

### 5.8 T_PETCH (`0x27`) — permissionless-mint deployment record

`T_PETCH` declares an asset whose supply is issued by **anyone**, in fixed tranches of `mint_limit`, until a lifetime cap is reached. The deploying tx receives **zero tokens**: a `T_PETCH` envelope creates no tacit UTXO. To hold tokens, the deployer (or anyone else) must broadcast `T_PMINT` like any other participant.

This is a complement to CETCH's mint-authority model, not a replacement. CETCH+T_MINT covers issuer-controlled distribution with hidden supply changes; drops/claims (§8 marketplace layer) cover snapshot-based whitelist distribution; `T_PETCH`+`T_PMINT` covers open-participation fair-launch issuance with publicly auditable supply.

```
T_PETCH(1)
|| ticker_len(1)         u8, 1..16
|| ticker(ticker_len)    UTF-8
|| decimals(1)           u8, 0..8
|| cap_amount(8)         u64 LE base units, > 0 — lifetime mint cap
|| mint_limit(8)         u64 LE base units, > 0 — exact per-T_PMINT amount
|| mint_start_height(4)  u32 LE — 0 ⇒ "etch_height + 1" (next confirmed block)
|| mint_end_height(4)    u32 LE — 0 ⇒ no end height (open until cap)
|| img_len(2)            u16 LE, 0..256
|| image_uri(img_len)    UTF-8 (typically "ipfs://bafk…")
```

Constraints (envelope-level; rejected as malformed if violated):
- `ticker_len ∈ [1, 16]`, `decimals ∈ [0, 8]` — same as CETCH.
- `cap_amount > 0`, `mint_limit > 0`.
- `cap_amount % mint_limit == 0`. The cap MUST be reachable — a non-divisible cap leaves a residual that can never be minted, which produces user confusion and gameable end-of-mint races. Validators reject any T_PETCH with a non-zero remainder.
- If `mint_start_height ≠ 0`, then `mint_start_height ≥ etch_height + 1`. A `T_PETCH` cannot open minting in its own block — this is the structural defense of the "zero deployer allocation" property. `mint_start_height = 0` is the canonical "next block after etch confirms" sentinel, not "active immediately".
- If `mint_end_height ≠ 0`, then `mint_end_height > mint_start_height_effective` where `mint_start_height_effective = mint_start_height ≠ 0 ? mint_start_height : etch_height + 1`.

Properties:
- **No supply UTXO is created.** Vout 0 of the `T_PETCH` reveal tx is treated as regular Bitcoin output by tacit; it carries no asset balance. `validateOutpoint(T_PETCH_reveal_txid, 0)` returns `false`. The deployer typically uses vout 0 for change.
- **No commitment, no rangeproof.** There is no hidden supply at deploy time, so neither primitive is needed.
- **Anyone may broadcast a T_PETCH** for any ticker — same posture as CETCH (§5.5). Ticker collisions across CETCH and T_PETCH are resolved at the wallet/UI layer (display) not the protocol layer (asset_id is canonical).
- `asset_id = SHA256(reveal_txid_BE || 0_LE)` — the same derivation as CETCH (§4), so all downstream tooling resolves T_PETCH-rooted assets identically.

Soundness for T_PETCH. Like CETCH, T_PETCH has no kernel sig and no anchor sig — anyone can broadcast a T_PETCH-shaped envelope. There is no "the asset" to forge because every well-formed T_PETCH defines a *new* `asset_id`. A forger has nothing to gain by re-using bytes since they would only be re-deploying under a fresh identity.

### 5.9 T_PMINT (`0x28`) — permissionless mint event

```
T_PMINT(1)
|| asset_id(32)              must equal SHA256(etch_txid_BE || 0_LE)
|| etch_txid(32)             reference to the originating T_PETCH reveal tx
|| commitment(33)            Pedersen C = amount·H + blinding·G (compressed)
|| amount(8)                 u64 LE — public; MUST equal petch.mint_limit
|| blinding(32)              public scalar — 0 < blinding < curve_order
```

Validator checks:
1. `asset_id == SHA256(etch_txid_BE || 0_LE)`.
2. Fetch the etch ancestor at `etch_txid`. The parent envelope MUST be `T_PETCH` (opcode `0x27`). A T_PMINT that names a `CETCH` (opcode `0x21`) parent — or any other opcode — is rejected. T_MINT and T_PMINT are intentionally non-substitutable: the issuance trust models differ, and the asset's mode is part of its on-chain identity even though both etch opcodes derive `asset_id` the same way.
3. `amount == petch.mint_limit`.
4. Compute `effective_start = petch.mint_start_height ≠ 0 ? petch.mint_start_height : (petch.etch_height + 1)`. Compute `effective_end = petch.mint_end_height ≠ 0 ? petch.mint_end_height : ∞`. Reject if the T_PMINT's confirmed block height is `< effective_start` or `> effective_end`.
5. Let `prior_count` be the count of T_PMINTs against this `asset_id` confirmed at canonically-earlier `(height, tx_index)` positions. Reject if `(prior_count + 1) × petch.mint_limit > petch.cap_amount`.
6. Verify `blinding ∈ (0, curve_order)` and `pedersenCommit(amount, blinding) == commitment`. The commitment field is what subsequent CXFER / BURN walks consume as an input commitment for kernel-sig verification (§5.2 / §5.4).
7. `vout = 0` of the reveal tx holds the new supply UTXO. Spendability of the on-chain output script follows Bitcoin rules, exactly as in T_MINT (§5.3 step 4).

The new supply UTXO can subsequently be CXFER'd, T_AXFER'd, or BURN'd like any other holding.

**Cap-overflow ordering.** When two T_PMINTs are mined in the same block and the cap can fit one but not both, canonical ordering is by `tx_index` within the block: lower `tx_index` wins. The losing T_PMINT is decoded but rejected at step 5. Its commit/reveal pair stays on chain; it produces no spendable tacit UTXO, and the rejected miner forfeits their Bitcoin tx fees. This is the same outcome as any other invalid envelope.

**Why no signature.** T_PMINT carries no Schnorr signature. Anyone may produce the bytes; the blinding is public; the recipient is implicit (whoever controls the reveal tx's `vout[0]` output script). This is intentional — there is no "the minter" to authenticate. The validity gate is the cap counter plus the height window, both enforced from indexer state, not from cryptographic authentication.

Replay analysis. An attacker who copies a published T_PMINT envelope and rewraps its bytes into their own commit/reveal pair must pay full Bitcoin tx fees. Their reveal-tx `vout[0]` commits to the *same* `(amount, blinding)` opening, so the resulting UTXO sits at *their* output script with the *same* opening as the original. This is not a theft of the original miner's UTXO (which lives at the original reveal tx's `vout[0]` permanently), but it does consume one cap slot. Since reproducing a T_PMINT costs the same as honest minting, there is no asymmetric grief vector — the rewrap path *is* the honest path under a different label. The cap eventually fills; that is the design.

Cross-network replay is prevented by Bitcoin's network-level tx isolation: signet and mainnet asset_ids derive from different reveal txids, so byte-identical envelope bytes broadcast on both networks produce different `asset_id`s and never collide.

**Privacy disclosure.** Because every T_PMINT publishes `(amount, blinding)` in cleartext and `amount == mint_limit` is public, **cumulative supply is fully observable** for `T_PETCH`-rooted assets (`cumulative_minted = (count of valid T_PMINTs) × mint_limit`). This is a deliberate departure from CETCH's hidden-supply property — the asset class trades supply-side confidentiality for permissionless issuance and on-chain auditable cap enforcement. Per-holder balances remain confidential after the first CXFER (§3.5 re-blinds outputs). Wallets SHOULD surface this distinction at etch time so deployers and minters understand the trade-off.

**Confirmation depth for cap correctness.** Step 5's `prior_count` is order-sensitive on canonical chain history. Two T_PMINTs that each look valid against the chain near tip may collectively violate the cap when canonically ordered. Indexers MUST therefore compute `prior_count` only over T_PMINTs at confirmation depth ≥ 3 (the standard Bitcoin 3-confirmation rule, where a tx in block N has 1 confirmation when tip == N — the same depth Bitcoin reorg risk crosses below ~1% under reasonable hashrate assumptions). Tip-state T_PMINTs surface as "pending" to UI layers; they are not credited to wallets nor counted toward the cap until the depth threshold is crossed. On a reorg, indexers MUST re-run step 5 over the new canonical chain — a previously-credited T_PMINT may become invalid (cap-overflow under new ordering) and its UTXO MUST be revoked from holdings. This is a stronger reorg sensitivity than CETCH+T_MINT, where credit depends only on the issuer's signature, not on aggregate chain state.

Recovery semantics. T_PMINT-produced UTXOs are publicly opened — `(amount, blinding)` are in chain data — so any wallet with the privkey for the `vout[0]` output script can recover the UTXO from chain alone, with no derivation required. The first CXFER from such a UTXO produces fresh blindings (§3.5) and restores forward confidentiality for that holder. Wallets MAY surface a one-time hint encouraging a self-CXFER after mint, but the protocol does not require it and the UTXO is fully spendable in its open state.


### 5.10 T_DEPOSIT (`0x29`) — anonymize a UTXO into a pool

Spends one tacit UTXO of `asset_id` whose committed amount equals `denomination`. The input commitment is consumed (no tacit-side output produced); a leaf is appended to the pool's Merkle tree (§3.6) for `(asset_id, denomination)`.

```
T_DEPOSIT(1)
|| asset_id(32)
|| denomination(8)              u64 LE — public, the pool's fixed amount
|| leaf_commitment(32)          poseidon(secret, nullifier_preimage, denomination)
|| kernel_sig(64)               Schnorr sig over kernel_msg (below)
```

Constraints enforced at decode:
- `denomination > 0` (the `denomination = 0` payload shape is the `POOL_INIT` variant; see §5.10.1).
- A canonical pool for `(asset_id, denomination)` must already be initialized. Deposits to uninitialized pools are silently ignored by the indexer (return `false`).
- `vin.length ≥ 2`; `vin[1]` is the asset input being deposited.

Kernel message:
```
kernel_msg = SHA256(
    "tacit-deposit-v1"
    || asset_id(32)
    || denomination_LE(8)
    || input_txid_BE(32) || input_vout_LE(4)
    || leaf_commitment(32)
)
```

The kernel sig verifies under `(C_in − denomination · H).x_only()` where `C_in` is the input commitment fetched from `vin[1]`'s parent envelope. Sign with `excess = r_in` (the input's blinding). If the input's committed amount equals `denomination`, the H component vanishes and `(C_in − denomination·H) = r_in·G`; if it doesn't, the residual H component makes producing a valid x-only signature equivalent to breaking DLP for `H` w.r.t. `G` — same Mimblewimble argument as §5.2.

This kernel proves *exactly `denomination` of `asset_id` was consumed into the pool*, without revealing the input's blinding. The leaf is Poseidon-bound to a `(secret, nullifier_preimage)` pair only the depositor knows.

Validator algorithm extension:
```
if envelope.opcode == T_DEPOSIT:
    if denomination == 0:
        # POOL_INIT path — see §5.10.1
        decode pool_denom, vk_cid, ceremony_cid, init_sig
        if no canonical pool exists for (asset_id, pool_denom) at this height:
            register {vk_cid, ceremony_cid, init_height: this_block} as canonical
        return false
    require pool registered for (asset_id, denomination)
    require vin.length >= 2 and vin[1] is a tacit UTXO of asset_id
    recursively validateOutpoint(vin[1])
    let C_in = parent envelope commitment for vin[1]
    let E' = C_in - denomination·H
    verify kernel_sig under E'.x_only() over kernel_msg
    append leaf_commitment to pool's merkle tree at canonical position
    return false   # T_DEPOSIT produces no tacit UTXO
```

**Implementation note.** Indexers MAY split this validator step between (a) a forward-state crawl that performs the kernel re-verify + canonical-position tree append, and (b) a recursive ancestry-walk discriminator that returns `false` to stop ancestors from treating a T_DEPOSIT-bearing reveal-tx output as a tacit UTXO. The reference worker handles the forward-state crawl in its scheduled scan and exposes pool state via `/pools`; the dapp mirrors the worker's pool snapshot in `scanPools` (with kernel + canonical-order re-checks per the three-verifier model) and the dapp's recursive validator merely returns `false` for any T_DEPOSIT it encounters during ancestry walks. Either layout satisfies the algorithm above.

`vout[0]` of the reveal tx is BTC change, not a tacit UTXO. Recovery walks (§6) do not recurse through T_DEPOSIT envelopes.

#### 5.10.1 POOL_INIT (variant of T_DEPOSIT, `denomination = 0` sentinel)

Pool creation reuses opcode `0x29` with a `denomination = 0` sentinel. The remainder of the payload differs:

```
T_DEPOSIT (POOL_INIT shape)
|| asset_id(32)
|| denomination(8) = 0
|| pool_denom(8)              u64 LE — the actual pool denomination, > 0
|| vk_cid_len(1)              u8, 1..64
|| vk_cid(vk_cid_len)         IPFS CID of the Groth16 verifying key (UTF-8)
|| ceremony_cid_len(1)        u8, 1..64
|| ceremony_cid(...)          IPFS CID of MPC ceremony transcripts (UTF-8)
|| init_sig(64)               BIP-340 sig over init_msg by initializer pubkey at vin[1].witness[1]
```

Init message:
```
init_msg = SHA256(
    "tacit-pool-init-v1"
    || asset_id(32)
    || pool_denom_LE(8)
    || vk_cid(vk_cid_len)
    || ceremony_cid(ceremony_cid_len)
)
```

Once a pool is initialized, its `vk_cid` is fixed forever — content-addressed, no rotation, no soft-fork mechanism to migrate. Multiple `POOL_INIT` envelopes for the same `(asset_id, pool_denom)` are tolerated; the indexer treats only the *first canonically-ordered confirmed* one as canonical and ignores the rest. **Canonical order is `(confirmation_height ASC, tx_index ASC, reveal_txid ASC)`** — same canonical key family used throughout §11. Within a block the lowest `tx_index` wins; the `reveal_txid` byte-lex tiebreaker is a determinism guard for the (Bitcoin-impossible) `tx_index` collision case and ensures every conforming indexer arrives at the same canonical pool regardless of network-order receipt. Both confirmation_height and the included transaction's depth MUST satisfy depth ≥ `MIXER_DEPOSIT_CONFIRMATION_DEPTH = 3` before canonicalization is final. **No special privilege governs pool initialization** — the same first-mover dynamic as ticker disambiguation in CETCH (§4) applies.

**`init_sig` is attestation-of-authorship, not soundness-enforcing.** Because pool init is permissionless and first-canonically-confirmed-wins, an unsigned (or arbitrarily-signed) POOL_INIT can claim the canonical slot exactly as well as a "properly" signed one. Indexers MAY surface the initializer pubkey for off-chain reputation / UI purposes, but MUST NOT make canonicalization or any soundness check contingent on `init_sig` validity. The field is preserved in the wire format to expose initializer identity to off-chain attestation systems and to allow a future soft-rule that gates canonicalization on signature validity should one ever be needed; v1 indexers do not verify it.

Pool initialization is a metadata event only — no tacit UTXO is produced and the validator returns `false` for any vout against a POOL_INIT envelope.

### 5.11 T_WITHDRAW (`0x2A`) — anonymous mint from a pool

Produces one fresh tacit UTXO of `asset_id` at `vout[0]`, contingent on a Groth16 proof of unspent leaf membership in the pool tree. Consumes no tacit input — the asset value comes from the pool's accumulated deposits.

```
T_WITHDRAW(1)
|| asset_id(32)
|| denomination(8)              u64 LE — the pool
|| merkle_root(32)              claimed pool root (must match a recent canonical root)
|| nullifier_hash(32)           public; must be unique within the pool
|| recipient_commitment(33)     compressed Pedersen point: denomination·H + r_leaf·G
|| r_leaf(32)                   public Pedersen blinding scalar (BN254 Fr / secp256k1 scalar)
|| bind_hash(32)                see below
|| proof_len(2)                 u16 LE
|| proof(proof_len)             Groth16 proof bytes
```

`r_leaf` is published in cleartext on chain — identical privacy posture to T_PMINT's `(amount, blinding)` pair (§5.9). Because `denomination` is also public (the pool's fixed amount), publishing `r_leaf` does not leak any additional information about the depositor: the leaf at deposit was `poseidon(secret, ν, denomination)` and `r_leaf = poseidon(secret, ν)` is a one-way function of the same secret pair; an observer cannot invert either to identify which deposit corresponds to a given withdraw.

`bind_hash` is computed as:
```
bind_hash = SHA256(
    "tacit-withdraw-bind-v1"
    || asset_id(32)
    || denomination_LE(8)
    || nullifier_hash(32)
    || recipient_commitment(33)
    || r_leaf(32)
)
```

Public inputs to the Groth16 verifier (in BN254 scalar field, see §3.8):
`[merkle_root, nullifier_hash, denomination, r_leaf, bind_hash]`.

Validator algorithm extension:
```
if envelope.opcode == T_WITHDRAW:
    require pool registered for (asset_id, denomination)
    require merkle_root in last 32 canonical roots of this pool
    require nullifier_hash NOT in this pool's spent-nullifier set
    verify bind_hash matches recompute over (asset_id, denomination,
        nullifier_hash, recipient_commitment, r_leaf)
    verify Groth16 proof under pool.vk over [merkle_root, nullifier_hash,
        denomination, r_leaf, bind_hash]
    # External secp256k1 Pedersen check — closes the inflation-attack vector.
    # The circuit constrains r_leaf to be poseidon(secret, ν), so a malicious
    # withdrawer cannot fabricate a recipient_commitment with a freely-chosen
    # blinding for an inflated amount. SPEC §3.8 constraint 4.
    require recipient_commitment == denomination · H + r_leaf · G
    record nullifier_hash as spent
    require validated vout index == 0   # T_WITHDRAW produces its tacit UTXO at vout[0]; any other vout index is rejected
    return true
```

Recipient blinding & amount recovery: trivial. Both `denomination` (public) and `r_leaf` (public, in envelope) are read directly from chain; the recipient — whose pubkey controls `vout[0]`'s P2WPKH — uses them as the input opening for any future CXFER. **No share-link needed for tornado-flow-to-other**: the recipient simply sees a UTXO paying their address, reads the envelope, and has everything required to spend. Recovery is identical for self-withdraw and for-other; the wallet does not need to track which case applies.

#### 5.11.1 Soundness

- **No pool inflation.** Each T_DEPOSIT consumes exactly `denomination` of asset value (kernel sig under `C_in − denom·H`); each T_WITHDRAW produces exactly `denomination` of asset value and consumes one previously-unseen nullifier. The indexer's nullifier set + leaf count maintain the invariant `(# leaves − # nullifiers) ≥ 0` as a per-pool reserve obligation.
- **No double-withdraw.** Nullifiers are committed in plaintext as a public input to the proof. The indexer maintains a `(asset_id, denomination) → set<nullifier_hash>` and rejects any T_WITHDRAW whose nullifier is already present.
- **No proof replay across recipients.** `bind_hash` is squared inside the circuit, binding the proof's polynomial system to the specific `(asset_id, denomination, nullifier_hash, recipient_commitment, r_leaf)` tuple. A relayer or mempool observer cannot reuse a proof with a substituted recipient; the verifier rejects.
- **No inflation via fabricated recipient_commitment.** The circuit forces `r_leaf == poseidon(secret, nullifier_preimage)` (constraint 4), and the validator forces `recipient_commitment == denomination · H + r_leaf · G` externally. A malicious withdrawer cannot construct a recipient_commitment opening to an amount larger than the pool's denomination — Pedersen binding is computationally infeasible to forge for a fixed `r_leaf` and `denomination`.
- **No proof replay across pools.** `asset_id` and `denomination` are committed in `bind_hash`; cross-pool replay fails the `bind_hash` check.
- **No proof replay across roots.** `merkle_root` is a public input to the Groth16 statement; replaying a proof against a different root would require the prover to have generated a leaf-membership proof against that other root, which is not the case for a copied proof.

#### 5.11.2 Anonymity set

The withdrawer's anonymity set within a pool is **all leaves with currently-unspent nullifiers at the moment the proof is broadcast**, restricted to leaves whose owners have not otherwise leaked their `(secret, nullifier_preimage)` tuple to outside parties. With Groth16 zero-knowledge and Poseidon collision-resistance, a chain analyst observing the on-chain T_WITHDRAW envelope learns no information about which leaf was spent beyond the count of currently-unspent leaves.

Practical anonymity scales with **pool depth** (number of unspent leaves) and **temporal mixing** (time elapsed between deposit and withdraw, during which other deposits and withdraws have occurred). A withdrawer who deposits and then immediately withdraws when their leaf is the only unspent one in the pool gets ≤ 1 anonymity. The dApp surfaces an "anonymity set size" reading on the withdraw screen so users can wait for adequate set size before withdrawing.

#### 5.11.3 Trusted setup

Soundness rests on the Groth16 ceremony for `withdraw.circom` having ≥ 1 honest contributor. Privacy does *not* — Groth16 has perfect zero-knowledge unconditionally. **One circuit, one ceremony, all pools.** `withdraw.circom` is the single circuit for every mixer pool (and for cBTC.zk slot operations, which reuse it unmodified — see `SPEC-CBTC-ZK-AMENDMENT.md`); its verifying key and ceremony transcript are the canonical trust anchor for the entire mixer surface. Phase 1 uses `pot14_final.ptau` from the Polygon Hermez Powers-of-Tau ceremony; Phase 2 was a public coordinator-chained ceremony that finalized at 2,227 community contributions followed by a Bitcoin-block beacon (2,229 canonical attestation records: genesis + 2,227 contribs + beacon). The finalized bundle is content-addressed on IPFS — see [`MIXER.md`](./MIXER.md) §"Trusted setup" for the bundle layout, audit transcript, and bundle/vk CIDs.

The `POOL_INIT` envelope's `vk_cid` / `ceremony_cid` fields exist so any future circuit revision can be initialized as a separate `(asset_id, pool_denom)` surface without a wire-format change; today every legitimate pool pins the canonical pair. The reference dapp hardcodes `(CANONICAL_VK_CID, CANONICAL_CEREMONY_CID)`, treats any pool that declares a different pair as out-of-protocol, hides it from deposit/withdraw selectors, and refuses to construct envelopes against it (a non-canonical pool may have a retained MPC trapdoor). Indexers MAY mirror that posture; the protocol-level invariants in §5.11.2 hold regardless, since a non-canonical pool's withdrawals verify only against its own non-canonical vk and cannot consume canonical-pool leaves.

**Phase 1 provenance is a soundness prerequisite.** Phase 2 contributions cannot rescue a backdoored Phase 1; if `ptau` was generated by a single party who retained the toxic waste, every withdraw proof is forgeable by that party regardless of Phase 2 contributor count. The canonical ceremony's Phase 1 is `pot14_final.ptau` from the Polygon Hermez ceremony (publicly-attested, disjoint contributors); its SHA256 is recorded in the bundle's README and verifiable from the bundle CID. Indexers MAY refuse to recognize pools whose `ceremony_cid` is not on a known-good list.

#### 5.11.4 Privacy threat model + operational hygiene

The cryptographic unlinkability of T_WITHDRAW follows from **Groth16's zero-knowledge property + the hiding/binding assumptions of the commitment + hash construction** (§3.6–§3.8); trusted setup affects soundness, not privacy. An observer reading the on-chain `T_WITHDRAW` envelope learns no information about which leaf the withdraw is unspending, beyond the count of currently-unspent leaves in the pool. Operational privacy (the practical "is the withdrawer linkable to the depositor on the Bitcoin chain graph?" question) depends on three things outside the protocol's control:

1. **Anonymity-set size.** Cryptographic unlinkability hides one withdraw within the set of currently-unspent leaves. A pool with 1 unspent leaf provides ≤ 1 anonymity. The dApp surfaces the live anonymity-set count on the withdraw screen and SHOULD warn when it falls below a configurable threshold (default 5 = strong warning, default 50 = caution). Pool operators SHOULD be honest in user-facing copy: the mixer's privacy strength scales with that pool's per-denomination volume; a tacit asset whose mixer sees 40 deposits a year provides nominal privacy, not real privacy.

2. **Bitcoin-level fee linkage.** The `T_WITHDRAW` reveal tx must pay BTC miner fees from a sat UTXO. If the withdrawer broadcasts from a wallet whose fee-source UTXOs trace to the depositor's wallet via chain-graph clustering, the SNARK privacy is operationally wasted. **For pay-to-someone-else withdraws (Alice deposits, Bob withdraws to Bob's wallet), no chain-graph link exists between Alice and Bob.** For self-mix (Alice deposits, Alice withdraws to a fresh receive address), the fee-source link must be broken via either (a) a fresh BTC wallet funded from an unlinked source (CoinJoin output, Lightning channel close, fresh exchange withdrawal), or (b) a relayer marketplace where a third party pays the fee in exchange for compensation taken from the recipient_commitment. The protocol does not require relayers — they are a UX convenience for the self-mix case.

3. **Network and timing correlation.** Broadcasting `T_WITHDRAW` from the same node IP / mempool propagation pattern as the corresponding `T_DEPOSIT` is trivially linkable by mempool monitors and broadcast-time analysis. Privacy-conscious users SHOULD route broadcasts through Tor or equivalent and SHOULD wait long enough between deposit and withdraw that timing-correlation is noisy (recommended minimum: hours, ideally days, for self-mix).

**Soundness invariants (indexer-enforced).** Every conforming indexer MUST enforce all five before crediting a `T_WITHDRAW` output as a spendable UTXO:

| # | Invariant | Enforcement |
|---|---|---|
| 1 | **Conservation** | Each `T_DEPOSIT` consumes exactly one tacit UTXO of `(asset_id, denomination)` (kernel sig over `C_in − denomination·H`). Pool reserve = `(# included leaves − # spent nullifiers) × denomination`, where "included" means a leaf whose depositing tx has reached confirmation depth ≥ `MIXER_DEPOSIT_CONFIRMATION_DEPTH = 3` (§5.10 reorg-safety gate). The reserve is a hard floor: an indexer MUST reject a `T_WITHDRAW` whose acceptance would make `# spent nullifiers > # included leaves` for the pool — i.e. drive the reserve negative — even when invariants 2–4 pass. One deposit appends one leaf and one withdraw burns one note, so this can only ever happen via a forged proof (e.g. a retained ceremony trapdoor on a non-canonical pool); the floor bounds any such forgery to the pool's real deposits rather than letting it mint unbounded supply. The leaf bound MUST never under-count the included set (use the authoritative included-leaf count, not a partially-applied local tree), so the floor only rejects a provably-over-drained withdraw and never a live one. The same depth-≥3 gate applies to POOL_INIT canonicalization and to T_WITHDRAW nullifier-set insertion: every mixer state change is reverted-or-kept atomically with the 3-confirmation reorg window. Indexers that index optimistically (write to KV before depth ≥ 3) MUST implement a rollback path that drops leaves, pool-init records, and nullifier-set entries whose tx is reorged out before reaching depth ≥ 3. |
| 2 | **Membership** | The proven leaf must lie in a recently-canonical merkle root (last `POOL_RECENT_ROOTS_WINDOW = 32` roots per §3.6). |
| 3 | **Non-double-spend** | The published `nullifier_hash` MUST NOT appear in the pool's spent-set. Indexers atomically check + insert. |
| 4 | **Output validity** | Recipient commitment is bound by `pedersenCommit(denomination, r_leaf) == recipient_commitment` (validator) AND by `bind_hash` squared into the proof (circuit constraint 5). Together these close the inflation-attack vector and the relayer-replay vector. |
| 5 | **Fee unlinkability (operational, NOT protocol-enforced)** | Pay-to-someone-else: structurally satisfied. Self-mix: requires user discipline (fresh wallet, Tor, timing) OR a relayer. The protocol provides no protocol-level mechanism; the dApp's withdraw confirm dialog surfaces the threat model. |

**Recipient-substitution attack and its closure.** A mempool observer who sees an in-flight `T_WITHDRAW` reveal tx could attempt to lift the proof + public inputs and rebroadcast with a different `recipient_commitment` to steal the withdrawal. The defense is the `bind_hash` covering `recipient_commitment` (along with the other fields), squared into the proof's polynomial system per §3.8 constraint 5. An attacker who substitutes `recipient_commitment`:

- Reusing the original `bind_hash` → the dapp's decoder rejects on `bind_hash` recompute mismatch (§5.11 validator step + indexer-determinism §11).
- Computing a fresh `bind_hash` for the substituted recipient → the SNARK rejects because `bind_hash` is a circuit-public input bound to the proof's polynomial system; the attacker would need to re-prove with their own witness, which they don't have.

The two checks (validator-side `bind_hash` recompute + circuit-side `bind_hash²` constraint) together close the substitution attack.

**Three-verifier model.** The `T_WITHDRAW` proof is verified at three trust boundaries:

| Verifier | Role | Authority |
|---|---|---|
| **Dapp browser (snarkjs)** | Verifies the proof before the user's wallet credits the new UTXO as spendable | **Authoritative for that user's wallet credit.** A failed verify here means the user does not see the UTXO as theirs, regardless of indexer state. |
| **Indexer cron (worker)** | Indexers MAY additionally run snarkjs offline to flag invalid proofs in returned `/pools/:aid/:denom` responses; this Groth16 layer is the optional one. | **Convenience caching.** The reference worker performs structural decode + kernel-sig re-verify (Conservation) + `bind_hash` recompute, but NOT Groth16 proof verification (no snarkjs in the worker runtime). Indexer correctness is bounded by the dapp's authoritative re-verify. |
| **Light clients / third-party indexers** | Anyone running the spec MAY verify proofs locally to maintain trustlessness without trusting our worker | **Required for trustless wallet operation.** Clients that delegate proof-validity to a remote indexer accept that indexer's honesty assumption. |

#### 5.11.5 Withdraw output and post-withdraw privacy

The `T_WITHDRAW` reveal tx produces one tacit UTXO at `vout[0]` with the `recipient_commitment` opening to `(denomination, r_leaf)`. The recipient address (the BTC P2WPKH at `vout[0]`'s scriptpubkey) controls spending the dust output. Because both `denomination` and `r_leaf` are public on chain, **the recipient — or anyone observing the chain — can construct a CXFER consuming this UTXO without any share-link**. This makes the mixer's withdraw output a first-class participant in the standard confidential-transfer protocol.

**Privacy does not end at the withdraw.** Once the recipient consumes the UTXO via CXFER, the resulting outputs are full Pedersen-committed amounts under `tacit-blind-v1` ECDH derivation — amounts are hidden from chain observers as in any other CXFER. The mixer breaks the deposit ↔ withdraw chain-graph edge; CXFER continues to hide amounts on every subsequent transfer. A user who withdraws and then immediately CXFERs to spread the amount across multiple destinations gets cumulative privacy: the mixer hides the source, CXFER hides the amounts.

**Caveat: post-withdraw identity if recipient wallet is publicly linked.** If the withdraw recipient's pubkey is publicly associated with a real-world identity (e.g., reused across known-person addresses), the chain-graph privacy of the *withdraw* is preserved but the *recipient* is identified as "received funds from this pool's mixer." For full anonymity, the recipient pubkey should be a fresh wallet whose history begins with the withdraw.

### 5.12 T_DROP (`0x2B`) — public-claim pool over existing supply

`T_DROP` consumes one or more existing tacit UTXOs of `asset_id` and locks the total committed amount into a **public-claim pool**. Anyone (subject to an optional Merkle-eligibility gate) may subsequently claim `per_claim` tokens from the pool via `T_DCLAIM` (§5.13) until the cumulative claimed amount reaches `cap_amount`, at which point the pool is drained.

This is the existing-supply analog of `T_PETCH` (§5.8). `T_PETCH` creates *new* supply permissionlessly out of nothing under a declared cap; `T_DROP` *redistributes* already-issued supply under the same FCFS-with-cap model. The two complement each other: a CETCH-rooted asset can be airdropped via `T_DROP` without ever migrating to `T_PETCH` semantics, and a `T_PETCH`-rooted asset's mint output can be re-routed through `T_DROP` for downstream redistribution. Asset identity (`asset_id`) is invariant across both.

`T_DROP` is **supply-preserving**, like `T_DEPOSIT` (§5.10): the deposited tokens are not destroyed and re-minted but rather shifted from the depositor's wallet into the pool's accounting, and reconstituted at each claimant's wallet by `T_DCLAIM`. Total `asset_id` supply is invariant across the full lifecycle.

```
T_DROP(1)
|| asset_id(32)              the existing token's asset_id (CETCH, T_PETCH, T_MINT, or T_PMINT root)
|| cap_amount(8)             u64 LE base units, > 0 — total pool supply, MUST equal Σ consumed input amounts
|| per_claim(8)              u64 LE base units, > 0 — exact per-T_DCLAIM amount
|| merkle_root(32)           eligibility gate; all-zeros = open FCFS, otherwise the root of an off-chain
                             (eth_address, per_claim, leaf_index) merkle tree per the §8 airdrop helpers
|| expiry_height(4)          u32 LE — 0 ⇒ no expiry; otherwise highest height at which T_DCLAIM is accepted
|| ticker_len(1)             u8, 0..16 — convenience copy for claim-msg construction; MAY be 0 (deferred to drop's CETCH/T_PETCH ancestor)
|| ticker(ticker_len)        UTF-8 (typically copied from the asset's parent etch envelope)
|| decimals(1)               u8, 0..8 — convenience copy; same role as ticker
|| asset_input_count(1)      u8, 1..16 — number of asset inputs being consumed
|| kernel_sig(64)            Schnorr sig over kernel_msg (below)
```

`drop_id` is derived from the reveal tx the same way `asset_id` derives from CETCH (§4):
```
drop_id = SHA256(reveal_txid_BE || 0_LE)
```

Tx structure:
```
vin[0]     = commit P2TR     ← taproot script-path spend; envelope in witness[1]
vin[1..N]  = asset UTXOs of asset_id summing to cap_amount   ← signed P2WPKH SIGHASH_ALL
            (N = asset_input_count)
vin[N+1..] = (optional) sats funding inputs                  ← signed P2WPKH SIGHASH_ALL
vout[0]    = (no tacit UTXO of asset_id is created — pool marker; safe to spend as a regular Bitcoin output)
vout[1..]  = sats change to depositor (regular P2WPKH)
```

Kernel message:
```
kernel_msg = SHA256(
    "tacit-drop-v1"
    || asset_id(32)
    || cap_amount_LE(8)
    || per_claim_LE(8)
    || merkle_root(32)
    || expiry_height_LE(4)
    || asset_input_count(1)
    || for each asset input i in [1..N]:
         input_txid_BE(32) || input_vout_LE(4)
)
```

The kernel sig verifies under `(Σ C_in − cap_amount · H).x_only()` where `C_in` is each asset input's parent-envelope commitment. Sign with `excess = Σ r_in` (the sum of input blindings — the depositor knows these because they're spending their own UTXOs). If the consumed inputs' committed amounts sum to exactly `cap_amount`, the H component vanishes and the residual `(Σ r_in) · G` is a valid x-only signing key; if they don't, the residual H component makes producing a valid x-only signature equivalent to breaking DLP for `H` w.r.t. `G` — the same Mimblewimble argument as §5.2 and §5.10. No additional blinding field appears in the envelope — `T_DROP` is supply-locking, not supply-creating, so unlike `T_PMINT` it has no output commitment whose opening would need to be published.

Constraints (envelope-level; rejected as malformed if violated):
- `cap_amount > 0`, `per_claim > 0`.
- `cap_amount % per_claim == 0`. The cap MUST be reachable — a non-divisible cap leaves a residual that can never be claimed (same reasoning as `T_PETCH`'s `cap_amount % mint_limit` constraint, §5.8).
- `asset_input_count ∈ [1, 16]`. The cap on the number of inputs bounds tx size and kernel-msg length; a depositor with more than 16 small UTXOs MUST first consolidate via CXFER.
- `merkle_root` is 32 bytes; an all-zero value is the canonical "open FCFS, no eligibility gate" sentinel.
- `expiry_height = 0` means no expiry. Non-zero values MUST satisfy `expiry_height > drop_reveal_height` (a drop cannot expire in its own block — symmetric with §5.8's deferred-start constraint).
- If `ticker_len ≠ 0`, then `ticker_len ∈ [1, 16]` and `decimals ∈ [0, 8]`. If `ticker_len = 0`, the `decimals` byte is still present (set to 0) and the indexer / dapp resolves both fields from the asset's parent etch envelope at claim-msg construction time.

Properties:
- **No tacit UTXO is created.** Vout 0 of the `T_DROP` reveal tx is treated as a regular Bitcoin output by tacit; it carries no asset balance. `validateOutpoint(T_DROP_reveal_txid, 0)` returns `false`. The depositor typically uses vout 0 as the pool-marker dust slot and `vout[1+]` for sats change.
- **No range proof.** `cap_amount` is plaintext, so range-proof bounding is unnecessary; the soundness invariant is `Σ C_in − cap_amount · H == excess · G`, which the kernel sig already enforces.
- **Anyone may broadcast a `T_DROP` against any `asset_id`.** Posting a drop is permissionless at the protocol layer; the soundness gate is "the depositor controlled UTXOs summing to `cap_amount`." A depositor cannot publish a drop they cannot fund.
- **Pool accounting is indexer-state.** Like `T_PETCH`, `T_DROP` is reached during ancestry walks only when a wallet accidentally treats the reveal tx's `vout[0]` as a tacit UTXO; the correct answer there is "not a tacit UTXO." Indexer cron records `T_DROP` metadata via a separate non-recursive scan path (parallel to T_PETCH's metadata path in §5.8).
- **First-canonically-confirmed-wins per `drop_id`.** Two `T_DROP` envelopes computing the same `drop_id` are impossible by construction (`drop_id` derives from the reveal tx). Distinct `drop_id`s for the same `asset_id` coexist freely; a token can be airdropped across multiple concurrent campaigns.

Soundness for T_DROP. Like CETCH and T_PETCH, T_DROP has no anchor sig — the kernel sig binds the asset inputs but not the commit_anchor, so rewrapping the same envelope bytes into a fresh commit/reveal pair is allowed in principle. However, the rewrapped tx would need to spend the same set of asset inputs (the kernel msg commits to each `(input_txid, input_vout)`); since those inputs are spent by the original `T_DROP`, the rewrap cannot confirm. Replay across asset_ids is prevented because `asset_id` is in the kernel msg. Replay against a different cap/per_claim/merkle_root is prevented because each of those fields is in the kernel msg.

**Reorg sensitivity.** If a confirmed `T_DROP` is reorged out, all `T_DCLAIM`s referencing its `drop_id` become invalid — they reference a non-existent parent. The standard Bitcoin 3-confirmation rule (§5.9 *Confirmation depth*) applies symmetrically: indexers SHOULD NOT credit `T_DCLAIM` outputs whose parent `T_DROP` is at depth < 3. Drops in tip-state are surfaced as "pending" to UI layers; claims against them are likewise pending until depth crosses the threshold.

#### 5.12.1 Reclaim path

If `expiry_height ≠ 0` and the current chain height exceeds it, the depositor may reclaim any unclaimed remainder of the pool by broadcasting a follow-up `T_DROP_RECLAIM` envelope.

Reclaim is not a separate opcode — it reuses `T_DROP` (`0x2B`) with `per_claim = 0` as the "reclaim variant" sentinel. The payload diverges:

```
T_DROP (RECLAIM shape, per_claim = 0)
|| asset_id(32)
|| cap_amount(8)             u64 LE — MUST equal the unclaimed remainder
                                       = original_cap - (count_of_valid_T_DCLAIMs * original_per_claim)
|| per_claim(8) = 0          sentinel — discriminates reclaim from standard shape
                             (same byte offset as standard T_DROP's per_claim field, so
                             decoders can read it before branching on shape)
|| reclaim_drop_id(32)       reference to the original T_DROP being reclaimed
|| reclaim_sig(64)           BIP-340 sig under depositor pubkey over reclaim_msg (below)
|| cap_blinding(32)          opening for the synthetic output commitment at vout[0]
```

```
reclaim_msg = SHA256(
    "tacit-drop-reclaim-v1"
    || reclaim_drop_id(32)
    || asset_id(32)
    || cap_amount_LE(8)
)
```

The depositor pubkey is the x-only pubkey at the original `T_DROP`'s `vin[1].witness[1]` (the first asset input's P2WPKH controller). Reclaim produces one fresh tacit UTXO of `asset_id` at `vout[0]` with `pedersenCommit(cap_amount, cap_blinding)` opening to the unclaimed remainder. The pool is closed; subsequent `T_DCLAIM` envelopes against the original `drop_id` are rejected.

Validator algorithm for the reclaim shape:
```
require reclaim_drop_id resolves to a confirmed T_DROP at depth ≥ 3
require current_height > original_drop.expiry_height
require cap_amount == (original_drop.cap_amount
                      - count_of_valid_T_DCLAIMs(reclaim_drop_id) * original_drop.per_claim)
require reclaim_sig verifies under (depositor_pubkey).x_only() over reclaim_msg
verify pedersenCommit(cap_amount, cap_blinding) == output_commitment at vout[0]
mark drop_id as closed
return true   # produces a tacit UTXO at vout[0]
```

The reclaim-variant `T_DROP` is the **only** opcode the protocol allows to mint a fresh asset UTXO without a kernel sig over input commitments — and only because the pool's accumulated reserve is a function of indexer state (the original drop's commit minus the cumulative claims), not of a freshly-consumed input. Soundness here is symmetric with `T_WITHDRAW` (§5.11) where the asset value also comes from accumulated indexer state rather than a directly-consumed input.

**Reclaim broadcast timing (UX gate, not consensus rule).** The depositor MUST wait for the chain to settle past `expiry_height` before broadcasting a reclaim. Specifically: the canonical T_DCLAIM count used in the equality check `cap_amount == original_cap - count_of_valid_T_DCLAIMs × per_claim` is recomputed at **reclaim's depth-3 acceptance**, not at broadcast time. A T_DCLAIM mined at `height = expiry_height` reaches depth 3 at `expiry_height + 2`; if Bob broadcasts a reclaim at `expiry_height + 1` declaring a count that excludes that pending T_DCLAIM, the reclaim is REJECTED when the canonical count overshoots Bob's declaration (no inflation: reject prevents overshoot). Bob can re-broadcast with the corrected count, but he has burned the failed-reclaim's fees. Recommended discipline: wait `current_height ≥ expiry_height + 2 * confirmation_depth = expiry_height + 6` before constructing the reclaim, so the canonical T_DCLAIM count is stable. The protocol enforces no minimum-wait; the rejection-on-mismatch is the safety mechanism, and the UX gate is purely fee-saving.

### 5.13 T_DCLAIM (`0x2C`) — permissionless claim event

```
T_DCLAIM(1)
|| asset_id(32)              must equal drop.asset_id
|| drop_reveal_txid(32)      the on-chain txid of the originating T_DROP reveal tx;
                             validator fetches parent envelope from this txid
                             (same pattern as T_PMINT's `etch_txid`, §5.9)
|| commitment(33)            Pedersen C = amount · H + blinding · G (compressed)
|| amount(8)                 u64 LE — public; MUST equal drop.per_claim
|| blinding(32)              public scalar — 0 < blinding < curve_order
|| witness_len(2)            u16 LE — 0 for open drops, > 0 if drop.merkle_root ≠ 0
|| witness(witness_len)      eligibility witness; see structure below
```

`drop_id` (the indexer's KV key, used for cap accounting and the claimed-leaf nullifier set) is derived as `SHA256(drop_reveal_txid_BE || 0_LE)` — the same construction as `asset_id` from a CETCH `etch_txid` (§4). The wire payload carries `drop_reveal_txid` (not `drop_id`) so the validator can fetch the parent T_DROP tx directly; `drop_id` is a per-indexer derivation.

For Merkle-gated drops (`drop.merkle_root ≠ 0`), the witness is:
```
witness:
|| recipient_pub(33)         compressed pubkey controlling vout[0]; MUST satisfy hash160(recipient_pub) == vout[0].scriptpubkey[2:22]
|| leaf_index(4)             u32 LE — position of the claimant's leaf in the snapshot merkle tree
|| eth_address(20)           the claimant's Ethereum address bound in the snapshot leaf
|| eth_sig(65)               r(32) || s(32) || v(1), EIP-191 signature over canonical_claim_msg
|| proof_len(1)              u8, 0..32 — number of 32-byte sibling hashes
|| proof_path(proof_len * 32) sibling hashes, ordered leaf-up
```

`recipient_pub` is published in the witness rather than recovered from the reveal tx because Bitcoin P2WPKH outputs commit only to `HASH160(pubkey)`, not the pubkey itself — the validator needs the full pubkey to reconstruct the canonical claim msg and verify the eth_sig recovery. The `hash160(recipient_pub) == vout[0].scriptpubkey[2:22]` check binds the witness-supplied pubkey to the actual output script.

For open drops (`drop.merkle_root == 0`), `witness_len` MUST be `0` and any non-zero witness payload is rejected as malformed.

The canonical claim msg the eth_sig MUST sign is **byte-for-byte identical** to the §8 worker-mediated airdrop msg — including the `Drop: merkle_root_hex` line. The on-chain and off-chain flows share the same wire format so a recipient's eth_sig is interchangeable between them; an issuer who has accumulated signed tuples for the worker flow can reuse them directly in T_DCLAIM witnesses.

```
canonical_claim_msg = utf8(
    "tacit airdrop claim v1\n"
  + "\n"
  + "Drop:    " + merkle_root_hex + "\n"
  + "Network: " + ("mainnet" | "signet") + "\n"
  + "Asset:   " + asset_id_hex + "\n"
  + "Address: 0x" + eth_address_hex + "\n"
  + "Leaf:    " + decimal(leaf_index) + "\n"
  + "Amount:  " + display(per_claim, decimals) + " " + ticker
                  + " (" + decimal(per_claim) + ")\n"
  + "Tacit:   " + recipient_pub_compressed_hex + "\n"
  + "\n"
  + "By signing, you authorize the airdrop issuer to send the above amount of "
  + ticker + " to the tacit pubkey listed."
)
```

**Cross-pool sig replay note.** Because `merkle_root` (not `drop_id`) keys the canonical msg, a recipient's eth_sig is valid for *any* `T_DROP` using the same snapshot. This is intentional: if a depositor publishes two `T_DROP`s against the same snapshot (e.g., to top up an exhausted pool), the recipient is entitled to claim from both with one signing operation. Each `T_DROP` has its own `(drop_id, leaf_index)` nullifier set, so the leaf is independently single-use per drop — no double-claim within a single drop, but two drops against the same snapshot is by-design two distinct campaigns.

The merkle leaf is computed exactly as in §8:
```
leaf = SHA256(
    "tacit-airdrop-leaf-v1"
    || eth_address(20)
    || per_claim_LE(8)
    || leaf_index_LE(4)
)
```

Sort-pair sibling hashes (`SHA256("tacit-airdrop-node-v1" || min(L,R) || max(L,R))`) are also identical, so a snapshot built by the existing dapp airdrop tooling is directly usable as a `T_DROP` snapshot with no re-hashing.

Validator checks:
1. `asset_id == drop.asset_id`. Mismatch is rejected.
2. Compute `drop_id = SHA256(drop_reveal_txid_BE || 0_LE)`. Fetch the parent tx at `drop_reveal_txid`; decode its `vin[0].witness[1]` envelope. The envelope MUST be `T_DROP` (opcode `0x2B`) with `per_claim ≠ 0` (the reclaim variant is not a valid `T_DCLAIM` parent). The drop must be at confirmation depth ≥ 3 (§5.12 reorg sensitivity).
3. `amount == drop.per_claim`.
4. If `drop.expiry_height ≠ 0`, the T_DCLAIM's confirmed block height MUST satisfy `confirmed_height ≤ drop.expiry_height`. Claims past expiry are rejected even if cap remains.
5. Let `prior_count` be the count of valid T_DCLAIMs against this `drop_id` confirmed at canonically-earlier `(height, tx_index)` positions and at depth ≥ 3. Reject if `(prior_count + 1) × drop.per_claim > drop.cap_amount`.
6. If `drop.merkle_root ≠ 0` (Merkle-gated):
   - Read `recipient_pub` from the witness. Verify `hash160(recipient_pub) == vout[0].scriptpubkey[2:22]` (i.e., vout[0] is a P2WPKH paying the supplied pubkey). Reject on mismatch.
   - Recompute `canonical_claim_msg` using `drop.merkle_root`, `drop.network`, `asset_id`, witness `eth_address`, witness `leaf_index`, `drop.per_claim`, `drop.ticker`, `drop.decimals`, and `witness.recipient_pub`. If `drop.ticker_len == 0`, resolve `ticker`/`decimals` from the asset's parent etch envelope.
   - Recover `eth_addr_recovered` from `keccak256(EIP-191(canonical_claim_msg))` and witness `eth_sig`. Reject if `eth_addr_recovered ≠ witness.eth_address`.
   - Recompute `leaf` from `(witness.eth_address, drop.per_claim, witness.leaf_index)`. Verify the merkle proof against `drop.merkle_root` using sort-pair sibling hashes.
   - Reject if `(drop_id, witness.leaf_index)` is already in the claimed-leaf set.
   - Record `(drop_id, witness.leaf_index)` as claimed.
7. If `drop.merkle_root == 0` (open FCFS): no witness checks beyond `witness_len == 0`. Anti-sybil is by Bitcoin tx fees — each claim costs the claimant a real fee.
8. Verify `0 < blinding < curve_order` and `pedersenCommit(amount, blinding) == commitment`.
9. `vout = 0` of the reveal tx holds the new supply UTXO at `P2WPKH(hash160(recipient_pub))`.

The new supply UTXO can subsequently be CXFER'd, T_AXFER'd, BURN'd, or DEPOSIT'd like any other holding.

**Cap-overflow ordering.** Two T_DCLAIMs mined in the same block whose claims would collectively exceed the cap are ordered by `tx_index`: lower wins (identical to §5.9 *Cap-overflow ordering*). The losing claim's commit/reveal pair stays on chain and produces no spendable tacit UTXO. The claimant forfeits their Bitcoin tx fees and (if Merkle-gated) the `(drop_id, leaf_index)` is NOT recorded as claimed — they may re-attempt in a later block.

**Why no Schnorr sig on the envelope itself.** `T_DCLAIM` carries no protocol-layer Schnorr signature, mirroring `T_PMINT` (§5.9). The validity gate is (a) for Merkle-gated drops, the eth_sig recovering the snapshot's eth_address from the canonical claim msg, and (b) for open drops, simply the cap counter. The recipient is implicit (whoever controls `vout[0]`'s output script) — claimants signal their tacit identity by funding the reveal tx from a wallet they control.

Replay analysis. An attacker who copies a published `T_DCLAIM` envelope and rewraps its bytes into their own commit/reveal pair:

- **Open drop case.** The rewrapped tx produces a fresh `vout[0]` UTXO at *their* output script with the same `(amount, blinding)` opening. This is not theft (the original claimant's UTXO at the original reveal tx's `vout[0]` is permanent), but it does consume one cap slot. Since reproducing a `T_DCLAIM` costs the same as honest claiming, there is no asymmetric grief vector — the rewrap path *is* the honest path under a different label. Identical posture to `T_PMINT` (§5.9).
- **Merkle-gated drop case.** The witness's `canonical_claim_msg` binds `recipient_pubkey_compressed_hex`. An attacker who rewraps a published `T_DCLAIM` MUST also substitute the recipient pubkey at `vout[0]` (otherwise they're just paying fees to deposit dust to the original claimant). But substituting the recipient changes the canonical msg, which changes the EIP-191 hash, which changes what `eth_sig` recovers to. The rewrap fails step 6 (eth_addr_recovered ≠ witness.eth_address). The merkle gate is therefore robust to envelope-byte replay — a recipient's signed claim is bound to their tacit pubkey by the same mechanism that closes the relayer-substitution attack in `T_WITHDRAW` (§5.11.4).

Cross-network replay is prevented by Bitcoin's network-level tx isolation (signet and mainnet `drop_id`s derive from different reveal txids) and additionally by the `Network:` field in the canonical claim msg.

**Privacy disclosure.** Like `T_PMINT`, `T_DCLAIM` publishes `(amount, blinding)` in cleartext and `amount == drop.per_claim` is public. Cumulative claims are fully observable on chain (`cumulative_claimed = (count of valid T_DCLAIMs against drop_id) × per_claim`). For Merkle-gated drops, the witness additionally publishes `(eth_address, leaf_index)` per claim — the snapshot's eligibility list is already public information (anchored in the IPFS-pinned snapshot blob), so this leaks no new identity but does timestamp which leaves have been claimed when. Per-holder balances regain confidentiality on the first CXFER (§3.5 re-blinds outputs).

Wallets SHOULD surface this distinction at drop-creation time so depositors understand the trade-off vs. the §8 worker-mediated airdrop (which preserves per-claim privacy until fulfilment broadcast, modulo the IPFS-pinned snapshot which is identical in both flows).

**Smart-contract wallet limitation.** On-chain `T_DCLAIM` only supports recipients whose snapshot `eth_address` is controlled by an ECDSA private key (EOA wallets — MetaMask, Rainbow, Rabby, Coinbase Wallet, Trust, Frame). Smart-contract wallets (Safe, Argent, Ambire) that authenticate via ERC-1271's `isValidSignature(bytes32, bytes)` cannot have their sigs verified by a Bitcoin-context validator — ERC-1271 verification requires an `eth_call` to the contract, which is not available in the validator's execution environment. Smart-wallet recipients MUST use the §8 worker-mediated airdrop flow (which retains the ERC-1271 fallback path) for any drop whose snapshot includes their address. Issuers SHOULD either filter smart-contract wallets out of merkle-gated `T_DROP` snapshots, or publish dual coverage (a `T_DROP` for EOA recipients + a worker-mediated airdrop offering the same merkle root for smart-wallet recipients).

#### 5.13.1 Soundness

| # | Invariant | Enforcement |
|---|---|---|
| 1 | **Conservation** | The drop pool's reserve = `cap_amount - cumulative_claimed`. `T_DROP` kernel sig binds inputs summing to `cap_amount`. Each `T_DCLAIM` decrements the reserve by exactly `per_claim`. `T_DROP_RECLAIM` (5.12.1) consumes the remainder. The cumulative invariant `(claims × per_claim) + (reclaim_amount) ≤ cap_amount` holds across the pool's lifecycle. |
| 2 | **Cap enforcement** | Step 5 of the T_DCLAIM validator: `(prior_count + 1) × per_claim ≤ cap_amount`. Indexers compute `prior_count` only over T_DCLAIMs at depth ≥ 3. |
| 3 | **No double-claim (Merkle-gated)** | The `(drop_id, leaf_index)` tuple acts as the nullifier — analogous to `nullifier_hash` in `T_WITHDRAW`. The indexer maintains a per-`drop_id` claimed-leaf set; step 6 rejects reuse. |
| 4 | **No relayer substitution (Merkle-gated)** | `recipient_pub` is bound into the canonical claim msg; substituting recipient invalidates the eth_sig recovery (replay analysis above). |
| 5 | **Output validity** | Pedersen binding: `pedersenCommit(amount, blinding) == commitment`. `amount` and `blinding` are both public; the commitment field is what subsequent CXFER / BURN walks consume as an input commitment for kernel-sig verification (§5.2 / §5.4). |
| 6 | **Reorg safety** | All cap-counter / claimed-leaf-set updates run at depth ≥ 3. On a reorg, indexers MUST re-run steps 2 and 5 over the new canonical chain. A previously-credited `T_DCLAIM` may become invalid under new ordering and its UTXO MUST be revoked from holdings. Stronger reorg sensitivity than CETCH+T_MINT, matching `T_PMINT`'s posture. |

#### 5.13.2 Comparison: T_DCLAIM vs. §8 worker-mediated airdrop

Both flows use the same merkle-leaf schema (`tacit-airdrop-leaf-v1`), the same node-hash schema (`tacit-airdrop-node-v1`), and the same canonical claim msg (modulo `drop_id` vs. `merkle_root` in the `Drop:` line). A snapshot built by the existing dapp Drops-tab tooling is directly usable in either flow.

|  | §8 worker-mediated airdrop | §5.12/§5.13 T_DROP/T_DCLAIM |
|---|---|---|
| **Issuer cost (N=1000 mainnet)** | ~$1–1.4K (143 batched CXFERs × 7 recipients each) | ~$10 (one T_DROP tx) |
| **Recipient cost** | $0 (issuer pays) | ~$5–10/claim (claimant pays own reveal) |
| **Self-service** | No — recipients submit claims to the worker queue and wait for the issuer to fulfil | Yes — claimants self-broadcast `T_DCLAIM` without issuer involvement |
| **Eligibility gate** | Off-chain (issuer verifies merkle + eth_sig before broadcasting CXFER) | On-chain (indexer verifies merkle + eth_sig as part of `T_DCLAIM` validation) |
| **Privacy of claim list** | Tuples sit in worker queue until fulfilled; chain only reveals the final batched CXFER amounts under Pedersen | Each `T_DCLAIM` publishes `(eth_address, leaf_index)` and `(per_claim, blinding)` in plaintext, identical to T_PMINT's posture |
| **Trust model** | Worker is dumb-storage; canonical truth is the issuer's batched CXFERs | Pure protocol; no worker trust needed for claim validity |
| **When to choose** | Small-to-medium drops where issuer wants to control timing, keep per-claim amounts private until fulfilment, or batch into fewer txs | Large public drops, fair-launch-style distributions of existing supply, or any scenario where issuer being online for N fulfilments is impractical |

The two flows coexist: an issuer may publish both an §8 announcement and a `T_DROP` against the same snapshot, letting recipients pick which path they prefer. The snapshot, merkle root, and eth_sig wire formats are identical across both, so there is no per-flow re-tooling.

### 5.14 T_LP_ADD (`0x2D`) — add liquidity / POOL_INIT

**Architectural summary in `AMM.md` §"Core opcodes" + [`spec/amm/wire-formats.md`](./spec/amm/wire-formats.md) §"Envelope byte layouts".** This subsection pins the byte-level wire format and validator algorithm.

Two variants:
- `variant = 0` — add liquidity to an existing pool at the current ratio.
- `variant = 1` — POOL_INIT: create a pool with initial reserves.

**Wire format (variant 0, standard add):**

```
opcode(1)                  = 0x2D
variant(1)                 = 0x00
asset_A(32)                # lex-smaller of the two pool asset_ids
asset_B(32)                # lex-larger
delta_A_LE(8)              # u64, > 0 — public asset_A added
delta_B_LE(8)              # u64, > 0 — public asset_B added
share_amount_LE(8)         # u64, > 0 — public LP shares minted
share_C_secp(33)           # compressed Pedersen-secp commitment of share_amount
share_C_BJJ(32)            # packed BabyJubJub Pedersen commitment (§3.9 encoding)
share_xcurve_sigma(169)    # sigma cross-curve binding (§3.10) for the share output
kernel_sig_A(64)           # BIP-340 over kernel_msg_A (below) under (Σ C_in_A − Δa·H).x_only()
kernel_sig_B(64)           # BIP-340 over kernel_msg_B
proof_len_LE(2)
proof(proof_len)           # Groth16 batch proof under pool.vk
```

Fixed-prefix bytes: `454 + proof_len` (one 169-byte sigma; spec-conformance pin: `LP_ADD_FIXED_PREFIX = 454`).

**Wire format (variant 1, POOL_INIT)** is the standard layout above with this block appended **before** the proof:

```
fee_bps_LE(2)                       # u16, 0..1000 (capped at 10%)
vk_cid_len(1)                       # u8, 1..64
vk_cid(vk_cid_len)                  # IPFS CID, UTF-8 (CIDv1 raw codec, sha2-256;
                                    #   "bafkrei..." form per §5.16 step 8).
                                    #   Resolves to a JSON file with three keys
                                    #   bundling the three AMM circuit vks:
                                    #     {
                                    #       "lp_add":     <snarkjs vk for amm_lp_add>,
                                    #       "lp_remove":  <snarkjs vk for amm_lp_remove>,
                                    #       "swap_batch": <snarkjs vk for amm_swap_batch>
                                    #     }
                                    #   Indexers pick the entry matching the opcode:
                                    #     T_LP_ADD       -> "lp_add"
                                    #     T_LP_REMOVE    -> "lp_remove"
                                    #     T_SWAP_BATCH   -> "swap_batch"
                                    #   The integrity rule (§5.16 step 8) hashes the
                                    #   raw bundle bytes, not per-entry — one CID
                                    #   pins the full triple.
ceremony_cid_len(1)                 # u8, 1..64
ceremony_cid(ceremony_cid_len)      # IPFS CID, UTF-8 — directory CID for the public
                                    #   audit bundle (attestation chains, pre/post-
                                    #   beacon zkeys, ptau, beacon transcript) under
                                    #   one IPFS dir; indexers/auditors fetch via
                                    #   <ceremony_cid>/<file>.
arbiter_count(1)                    # u8; V1: MUST be 0. Reserved for a follow-up
                                    #   amendment to repurpose (e.g., T_EXCLUSION_CLAIM
                                    #   slashing-target metadata, time-lock-encryption
                                    #   public-key references). See AMM.md
                                    #   §"Curation-MEV mitigation".
arbiter_threshold_m(1)              # u8; V1: MUST be 0. Reserved.
arbiter_pubkeys(33 * arbiter_count) # V1: empty (arbiter_count == 0). Reserved.
launcher_sig_count(1)               # u8, 0..2
launcher_sigs(64 * launcher_sig_count)  # BIP-340 each
protocol_fee_address(33)            # compressed secp256k1; all-zeros = disabled
protocol_fee_bps_LE(2)              # u16, 0..1000 (= 0..10% of LP-fee growth)
pool_meta_uri_len(1)                # u8, 0..255
pool_meta_uri(pool_meta_uri_len)    # informational dapp metadata pointer (IPFS CID,
                                    #   description, logo, website). Never consensus-bound;
                                    #   indexer does not dereference. Length 0 is permitted.
pool_capability_flags(1)            # u8 bitfield; founder-set, immutable.
                                    #   bit 0 (0x01): reserved for future opt-in (e.g.,
                                    #                 LP_ADD requires T_RANGE_ATTEST)
                                    #   bit 1 (0x02): POOL_CAP_SOLO_INTENT_ALLOWED — if set,
                                    #                 T_SWAP_BATCH envelopes with n_intents == 1
                                    #                 are accepted (default V1 pools reject
                                    #                 n_intents < AMM_MIN_BATCH_SIZE = 2 for
                                    #                 amount confidentiality; see AMM.md
                                    #                 §"Minimum batch size")
                                    #   bits 2..7: reserved, MUST be 0 at POOL_INIT
```

`protocol_fee_address` and `protocol_fee_bps` are **founder-set and immutable** for the pool's lifetime (founder picks at POOL_INIT). Pools created with `protocol_fee_address = 33 × 0x00` have no protocol fee ever, and `protocol_fee_bps` must equal 0; the decoder rejects mismatched (non-zero address with zero bps, or zero address with non-zero bps). When enabled, the indexer accrues protocol fee per `AMM.md` §"Protocol fee mechanism" using a Uniswap-V2-lazy `mintFee` model crystallized at every LP event and at `T_PROTOCOL_FEE_CLAIM`.

POOL_INIT additionally requires the reveal tx to include the locked MINIMUM_LIQUIDITY output at `vout[1]` per AMM.md §"MINIMUM_LIQUIDITY burn-output construction".

**kernel_msg_X** (X ∈ {A, B}):
```
kernel_msg_X = SHA256(
    "tacit-amm-lp-add-v1"
    || variant(1) || pool_id(32) || asset_X(32)
    || delta_X_LE(8) || share_amount_LE(8) || share_C_secp(33)
    || in_count_X(1) || (in_txid_BE(32) || in_vout_LE(4)) * in_count_X
)
```
Sign with `excess_X = Σᵢ r_in_secp,X,i`. The `variant` byte distinguishes regular `LP_ADD` from `POOL_INIT` so the same bytes cannot be replayed across modes.

**Validator algorithm** (extends §5.5):
1. Decode payload. Reject on any structural error or trailing bytes.
2. Reject if `asset_A ≥ asset_B` (lex order).
3. Recompute `pool_id = SHA256("tacit-amm-pool-v1" || asset_A || asset_B || fee_bps_LE || capability_flags [ || protocol_fee_address || protocol_fee_bps_LE ])`. The trailing `protocol_fee_address || protocol_fee_bps_LE` pair is appended iff `protocol_fee_bps != 0` (joint-non-zero with `protocol_fee_address`, per the decoder rule). For `variant == 1` (POOL_INIT) the discriminators come from the envelope; for `variant == 0` they come from the existing pool record indexed by `pool_id`. (V3/V4 fee-tier parity: distinct `(fee_bps, capability_flags, protocol_fee_config)` tuples are distinct canonical pools — see SPEC §4.1 / AMM.md §"Pool state". The size-discriminated protocol-fee fields make the no-skim canonical pool un-squattable: a frontrunner pinning a fee recipient hashes to a different `pool_id` than the canonical no-skim variant.)
4. **If `variant == 1`:**
   a. Reject if a pool already exists for this `pool_id`.
   a.1. Reject if `fee_bps > 1000` (= 10% protocol cap; also wire-format-rejected since `fee_bps_LE` is u16 0..1000, echoed here as an explicit validator step so non-reference implementations cannot accidentally fork by accepting higher fees). Reject if `protocol_fee_bps > 1000`.
   a.2. **V1 reserved-bytes check.** Reject if `arbiter_count != 0` or `arbiter_threshold_m != 0` or `arbiter_pubkeys.length != 0`. V1 has no on-chain arbiter mode; these bytes exist as reserved wire slots for a follow-up amendment to repurpose (AMM.md §"Curation-MEV mitigation").
   b. Fetch each asset's metadata blob by its envelope-committed CID; if `tacit_amm_launcher` is set per the JCS rules of §3.9 / §4.1, verify the corresponding BIP-340 sig in `launcher_sigs` over `SHA256("tacit-amm-launcher-gate-v1" || pool_id || vk_cid_bytes || fee_bps_LE)`. Reject on missing or invalid sig.
   c. Verify `share_amount == isqrt(delta_A · delta_B) − MINIMUM_LIQUIDITY` (founder portion; v1 fixes `MINIMUM_LIQUIDITY = 1000`).
   d. Verify the MINIMUM_LIQUIDITY locked output at `vout[1]` matches the deterministic NUMS construction (AMM.md §"MINIMUM_LIQUIDITY burn-output construction").
5. **If `variant == 0`:** require an existing pool with `pool.pool_id == pool_id`. Verify `share_amount == floor(min(delta_A·S/R_A, delta_B·S/R_B))`.
6. Verify `kernel_sig_A` and `kernel_sig_B` under the respective `(Σ C_in_X − delta_X·H_secp).x_only()` keys.
7. Verify `share_xcurve_sigma` binds `share_C_secp` and `share_C_BJJ` to a shared u64 amount (§3.10).
8. Verify Groth16 `proof` under the `"lp_add"` entry of the JSON resolved at `pool.vk_cid` (see §5.14 wire format note on the per-kind vk wrapper) over the canonical public-input vector ([`spec/amm/wire-formats.md`](./spec/amm/wire-formats.md) §"Groth16 public-input vector"). Integrity-check the wrapper bytes against `pool.vk_cid` per §5.16 step 8.
9. If all checks pass: register pool (POOL_INIT) or apply `R_A += delta_A, R_B += delta_B, S += share_amount`; credit the LP-share UTXO at the declared `vout`.

Reference impl: `tests/amm-validator.mjs` (`validateLpAdd`).

### 5.15 T_LP_REMOVE (`0x2E`) — burn LP shares for proportional withdrawal

```
opcode(1)                  = 0x2E
asset_A(32)
asset_B(32)
share_amount_LE(8)         # u64, > 0 — public LP shares burned
delta_A_LE(8)              # u64, public — receipt of asset A
delta_B_LE(8)              # u64, public — receipt of asset B
recv_A_C_secp(33)          # asset-A receipt Pedersen-secp commitment
recv_A_C_BJJ(32)           # packed BabyJubJub commitment
recv_A_xcurve_sigma(169)   # sigma cross-curve binding for the asset-A receipt
recv_B_C_secp(33)
recv_B_C_BJJ(32)
recv_B_xcurve_sigma(169)
kernel_sig_LP(64)          # BIP-340 over kernel_msg_LP under (Σ C_in_LP − share_amount·H).x_only()
proof_len_LE(2)
proof(proof_len)
```

Fixed prefix: `623 + proof_len` (two 169-byte sigmas, one per leg; spec-conformance pin: `LP_REMOVE_FIXED_PREFIX = 623`).

**kernel_msg_LP:**
```
kernel_msg_LP = SHA256(
    "tacit-amm-lp-remove-v1"
    || pool_id(32) || share_amount_LE(8)
    || delta_A_LE(8) || delta_B_LE(8)
    || recv_A_C_secp(33) || recv_B_C_secp(33)
    || lp_in_count(1) || (lp_in_txid_BE(32) || lp_in_vout_LE(4)) * lp_in_count
)
```

**Validator algorithm:**
1. Decode payload. Reject on structural error.
2. Require existing pool. Recompute `pool_id` and verify it matches.
3. Verify proportional withdrawal: `delta_A == floor(R_A · share_amount / S)`, `delta_B == floor(R_B · share_amount / S)`.
4. Verify `kernel_sig_LP` under `(Σ C_in_LP − share_amount·H_secp).x_only()`.
5. Verify both receipts' sigma cross-curve bindings (§3.10).
6. Verify Groth16 `proof` under the `"lp_remove"` entry of the JSON resolved at `pool.vk_cid` (per-kind vk wrapper; see §5.14 wire format and §5.16 step 8 for the integrity rule).
7. On success: apply `R_A -= delta_A, R_B -= delta_B, S -= share_amount`; credit the two receipt UTXOs at `vout[0]` (asset A) and `vout[1]` (asset B).

Reference impl: `tests/amm-validator.mjs` (`validateLpRemove`).

### 5.16 T_SWAP_BATCH (`0x2F`) — uniform-price block-batch settlement

**Architectural summary in AMM.md §"Uniform clearing".** Per-trader amounts are confidential via Pedersen; the envelope publishes only the aggregate batch deltas `(Δa_net, Δb_net)` and per-asset aggregate blinding residues `R_net_X`.

**Wire format:**
```
opcode(1)                  = 0x2F
asset_A(32)
asset_B(32)
n_intents(1)               # u8, 1..16
delta_A_net_signed(9)      # 1-byte sign (0=positive A-in, 1=negative) || 8-byte u64 LE magnitude
delta_B_net_signed(9)      # same encoding
R_net_A(32)                # secp256k1 scalar (BE) — aggregate blinding residue for asset A
R_net_B(32)
fee_bps_at_settle_LE(2)    # u16 — captured pool.fee_bps at settlement height
tip_A_amount_LE(8)         # u64 — aggregate asset-A tip
tip_B_amount_LE(8)         # u64 — aggregate asset-B tip
tip_A_C_secp(33)           # aggregate asset-A tip commitment
tip_B_C_secp(33)
r_tip_A_LE(32)             # secp256k1 scalar — opening for tip_A_C_secp (published for indexer verification)
r_tip_B_LE(32)

# (V1: no arbiter block. POOL_INIT requires arbiter_count == 0
#  per §5.14 step 4.a.2, so the conditional that would have
#  produced an arbiter block here is structurally unreachable in
#  V1. The wire slot is reserved for a follow-up amendment to
#  repurpose; see AMM.md §"Curation-MEV mitigation".)

# Per-intent block, repeated n_intents times in intent_id ascending order:
direction(1)               # 0 = A→B, 1 = B→A
trader_pubkey(33)
C_in_secp(33)
C_in_BJJ(32)
in_xcurve_sigma(169)
min_out_LE(8)
tip_amount_LE(8)
expiry_height_LE(4)
intent_sig(64)             # BIP-340 over SHA256(intent_msg) under trader_pubkey

# Per-receipt block, repeated n_intents times in same intent_id order:
C_out_secp(33)
C_out_BJJ(32)
out_xcurve_sigma(169)

# Tail:
proof_len_LE(2)
proof(proof_len)
settler_meta_uri_len(1)                     # u8, 0..255 (0 = no URI)
settler_meta_uri(settler_meta_uri_len)      # UTF-8 — informational settler metadata
                                             # pointer (version, identity, analytics URL).
                                             # NEVER consensus-bound; indexer does not
                                             # dereference. Length byte is REQUIRED
                                             # (always present, may be zero).
```

Per-intent block: **352 B** (= 340 + 12 from the 157→169-byte sigma upgrade). Per-receipt block: **234 B** (= 222 + 12). For N=16, envelope ≈ 9.5 KB (see AMM.md §"Fee-market sensitivity" for the full size table). Spec-conformance pins: `PER_INTENT_BYTES = 352`, `PER_RECEIPT_BYTES = 234`.

**intent_msg** is constructed per AMM.md §"Cross-asset authorization for swaps".

**Bitcoin transaction layout (normative — indexers reject deviations):**

| Index | Role |
|---|---|
| `vin[0]` | Settler's envelope-bearing input (Taproot script-path); witness carries the T_SWAP_BATCH payload |
| `vin[1+i]` | Trader inputs in `intent_id` ascending byte-order, `i ∈ [0, n_intents)` |
| `vin[N+1..]` | Optional settler BTC funding inputs |
| `vout[0]` | `OP_RETURN(envelope_hash)` — 0 sat, 32-byte data; `envelope_hash = SHA256(payload)` over the entire T_SWAP_BATCH payload |
| `vout[1+i]` | Trader receipt: dust P2WPKH paying the trader's pre-declared `receive_scriptPubKey` |
| `vout[N+1]` | Aggregate asset-A tip output (dust P2WPKH paying settler) — present iff `tip_A_amount > 0` |
| `vout[N+2]` | Aggregate asset-B tip output — present iff `tip_B_amount > 0` |
| `vout[N+3..]` | Optional settler BTC change |

The `vout[0]` OP_RETURN binding rule is what makes trader `SIGHASH_ALL` signatures bind to the envelope content (otherwise a malicious settler could re-wrap the trader's input into a different envelope and burn the trader's value). See AMM.md §"Per-vin Bitcoin-layer signature" for the threat model.

**Validator algorithm:**
1. Verify `vout[0]` is a 0-sat `OP_RETURN` whose 32-byte data equals `SHA256(payload)`.
2. Decode payload. Reject if `n_intents == 0` (empty batches are forbidden — see "Degenerate-empty batch" in AMM.md §"Uniform clearing"; also wire-format-rejected since `n_intents` is u8 1..16) or `n_intents > N_MAX` (= 16). Reject if `n_intents < AMM_MIN_BATCH_SIZE` (= 2) **unless** `pool.capability_flags & POOL_CAP_SOLO_INTENT_ALLOWED` (= `0x02`); this is the solo-intent privacy-collapse defense. Default V1 pools reject solo batches; pools that opt in at POOL_INIT trade amount confidentiality for liveness in low-volume regimes. Decode the trailing `settler_meta_uri_len` (REQUIRED, u8, may be 0) and `settler_meta_uri` (UTF-8, 0..255 bytes); reject any trailing bytes after the URI. The URI is informational and indexer-opaque, but the length byte is consensus-bound (envelope hash covers it).
3. Require existing pool. Recompute `pool_id` and verify match. Verify `fee_bps_at_settle == pool.fee_bps`. Reject if `fee_bps_at_settle > 1000` (= 10% protocol cap; also wire-format-rejected since `fee_bps_LE` is u16 0..1000, but echoed here as an explicit validator step so non-reference implementations cannot accidentally fork by accepting higher fees).
4. **No V1 arbiter block.** V1 pools have `arbiter_count == 0` (enforced at POOL_INIT per §5.14 step 4.a.2), so no arbiter block can appear in a T_SWAP_BATCH envelope against a V1 pool. The wire slot is reserved for a follow-up amendment (AMM.md §"Curation-MEV mitigation").
5. Verify per-intent ordering: `intent_id` values are strictly ascending byte-order.
6. For each intent: verify `intent_sig` (BIP-340 over `SHA256(intent_msg)` under `trader_pubkey`); verify `in_xcurve_sigma` binds `C_in_secp` and `C_in_BJJ` (§3.10); reject if `expiry_height < current_height`.
7. For each receipt: verify `out_xcurve_sigma` binds `C_out_secp` and `C_out_BJJ`.
8. **vk_cid integrity self-check** (normative). Before passing vk bytes to the Groth16 verifier, recompute the canonical V1 CID from the resolved bytes and verify it matches `pool.vk_cid` byte-for-byte. Canonical V1 format: CIDv1 with raw codec (0x55) + sha2-256 multihash (0x12 0x20), multibase-base32 lowercase no-padding (starts with `"bafkrei..."`). The CID hashes the **entire** JSON wrapper resolved at `vk_cid` (the `{lp_add, lp_remove, swap_batch}` object — see §5.14 wire format note), not the per-kind entry inside it: one CID pins the full triple. The indexer parses the JSON after integrity-checking and selects the `"swap_batch"` entry for `T_SWAP_BATCH` verification. Reference impl: `tests/amm-validator.mjs` `deriveVkCid()` / `verifyVkCidBinding()`. **Production indexers MUST run this check; failure rejects the envelope before any snarkjs call.** Closes the "misconfigured IPFS gateway returns malicious vk bytes" hazard.
9. Verify Groth16 batch `proof` under the `"swap_batch"` entry of the integrity-checked vk wrapper over the canonical public-input vector ([`spec/amm/wire-formats.md`](./spec/amm/wire-formats.md) §"Groth16 public-input vector").
10. **Chain-side aggregate Pedersen check** (per asset `X ∈ {A, B}`):
    ```
    Σ_{X→Y traders} C_in_secp,i  −  Σ_{Y→X traders} C_out_secp,i
      −  tip_X_C_secp  −  delta_X_net_signed · H_secp  ==  R_net_X · G_secp
    ```
11. Verify direction consistency: `(delta_A_net, delta_B_net)` signs are `(+, -)` for A→B-dom, `(-, +)` for B→A-dom, or `(0, 0)` for spot.
12. Verify post-batch reserves are positive and the constant-product invariant holds: `(R_A + Δa_net)·(R_B + Δb_net) ≥ R_A·R_B` (with sign-aware Δ).
13. **Verify the with-fee CFMM curve floor identity** (pins settler pricing to the deterministic solve up to per-trader floor dust; closes the settler-trader-collusion fee-redirection vector that the constant-product check alone admits). For non-spot batches, with `γ_num = 10000 − fee_bps` and `γ_den = 10000`:
    - A-dom (`Δa_net > 0`, `Δb_net < 0`): `|Δb_net| · (R_A · γ_den + γ_num · |Δa_net|) ≤ R_B · γ_num · |Δa_net|`.
    - B-dom (`Δa_net < 0`, `Δb_net > 0`): `|Δa_net| · (R_B · γ_den + γ_num · |Δb_net|) ≤ R_A · γ_num · |Δb_net|`.

    All inputs are public quantities (pool reserves, declared deltas, fee_bps). No private witness needed. See AMM.md §"Uniform clearing" constraint (4) for the rationale.
14. On success: apply reserves; credit each receipt UTXO at `vout[1+i]`.

The deterministic clearing-solve algorithm (AMM.md §"Deterministic clearing solve") is verified implicitly: the Groth16 proof binds per-trader amounts to per-trader Pedersen commitments and to `P_clear = X/(Y+Δb_net)` (or its B-dom equivalent), and the aggregate Pedersen check binds the batch totals to the declared deltas.

Reference impl: `tests/amm-validator.mjs` (`validateSwapBatch`).

### 5.17 T_INTENT_ATTEST (`0x30`) — preconfirmation channel attestation (scope-generic)

A **scope-generic** lightweight envelope that anchors a worker's open-intent set to Bitcoin at the worker's chosen cadence. Serves both AMM intents (T_SWAP_BATCH / T_SWAP_VAR, see AMM.md §"Preconfirmation layer") and orderbook intents (T_AXFER_VAR + variable-fill bids, see `spec/amendments/SPEC-ORDERBOOK-CHANNEL-AMENDMENT.md`). Enables soft-confirm UX (~30 s) for traders across surfaces without changing settlement guarantees — settlement still happens at the block clock via the surface-specific settlement opcode (T_SWAP_BATCH / T_SWAP_VAR / T_AXFER_VAR).

**Wire format:**

```
opcode(1)             = 0x30
scope_id(32)          # 32-byte canonical identifier of the attested intent set.
                       # Recommended schemas (informative, indexer-opaque):
                       #   - AMM pool:        scope_id = pool_id (per AMM.md §"Pool state")
                       #   - Orderbook pair:  SHA256("tacit-orderbook-pair-v1"
                       #                              || asset_id_min || asset_id_max)
                       #   - Orderbook global: SHA256("tacit-orderbook-global-v1" || worker_pubkey)
                       # The indexer treats scope_id as opaque (only used as the
                       # equivocation-detection key).
intent_pool_hash(32)  # SHA256(canonical-sorted intent_ids in this scope at observed_height)
observed_height_LE(4) # u32, Bitcoin block height the snapshot is "as of"
timestamp_LE(8)       # u64, worker's wall-clock unix seconds at sign
intent_count_LE(2)    # u16, number of intents committed in this snapshot
snapshot_uri_len(1)   # u8, 0..255 (0 = no URI; worker reachable only via direct P2P)
snapshot_uri(snapshot_uri_len) # UTF-8 — HTTP(S) endpoint or IPFS CID prefix where
                       # the full sorted_intent_ids[] can be fetched. Informational
                       # only; the indexer never fetches it (not consensus-bound).
worker_pubkey(33)     # compressed secp256k1
worker_sig(64)        # BIP-340 over SHA256("tacit-intent-attest-v1" || preceding_fields)
```

Wire size: 1 + 32 + 32 + 4 + 8 + 2 + 1 + uri_len + 33 + 64 = 177 + uri_len bytes (typical ~210 B with HTTP URL). No Groth16, no Pedersen, no sigma — the lightest opcode in the protocol.

**Intent-pool hash construction (normative):**

```
sorted_intent_ids = sort_lex_ascending([intent_id for each open intent in scope])
intent_pool_hash  = SHA256(intent_id_0 || intent_id_1 || ... || intent_id_{N-1})
```

Each `intent_id` is 32 bytes (canonical SHA-256 of its intent_msg per the surface-specific intent shape — §5.16 for AMM intents, §5.7.6.1 / §5.7.7 for orderbook intents). The sort is byte-lexicographic ascending; two workers committing to identical pools produce identical hashes.

`intent_count` MUST equal `N`. Empty pool: `intent_count = 0`, `intent_pool_hash = SHA256("")` (the empty-string hash) — a valid no-op proving liveness with no intents in flight.

Membership "proofs" are the worker's published intent list itself (fetched off-chain over `snapshot_uri` or any P2P channel, rehashed locally, compared to the chain commitment); no Merkle paths, no sparse trees. For tacit's expected pool sizes the full-list rehash is one HTTP round trip and one SHA-256 sweep — comparable to a logarithmic Merkle proof in wire size and simpler in every other respect. Future amendments can swap in a vector commitment (KZG/FRI) for large-N regimes without changing the on-chain wire format (`intent_pool_hash` stays 32 bytes regardless of preimage structure).

**Validator algorithm** (extends §5.5):

```
if envelope.opcode == T_INTENT_ATTEST (0x30):
    decode payload; reject on structural error
    verify worker_sig under worker_pubkey over SHA256("tacit-intent-attest-v1" || preceding_fields)
    reject if observed_height > envelope_height (no future-state claims)
    let key = (scope_id, worker_pubkey, observed_height)
    let existing = indexer.attestationChain.get(key)
    if existing && existing.intent_pool_hash != decoded.intent_pool_hash:
        EQUIVOCATION DETECTED
        indexer.equivocationFlags.add(worker_pubkey)
        reject envelope
    if existing && existing.intent_pool_hash == decoded.intent_pool_hash:
        idempotent duplicate — accept silently
    else:
        indexer.attestationChain.set(key, decoded)
        accept
    return true
```

The indexer does NOT fetch `snapshot_uri`. The URI is informational metadata for off-chain trader verification; not consensus-bound, not validated.

Multi-worker support is structural: different `worker_pubkey` values at the same `(scope_id, observed_height)` with different hashes are NOT equivocation — they're independent workers' views. Equivocation is per-worker.

Different-scope attestations from the same worker at the same height are independent — no equivocation check across scopes (a worker covering multiple AMM pools and multiple orderbook scopes attests to each independently).

**§11.2 ordering rule:** Within a block, T_INTENT_ATTEST envelopes apply in `(tx_index, vin[0] outpoint)` order. Equivocation check is order-sensitive: the first canonically-ordered attestation per `(scope_id, worker_pubkey, observed_height)` is canonical; any subsequent with a different hash flags the worker.

**Trader-side soft-confirm verification:** given a worker-supplied bundle `{my_intent_id, sorted_intent_ids[], scope_id, observed_height, timestamp, worker_pubkey, worker_sig}` and the corresponding on-chain T_INTENT_ATTEST envelope, the trader (1) checks the worker is trusted + not flagged for equivocation, (2) checks `timestamp` freshness (default TTL 30 s — reflects the soft-confirm UX cadence; dapps may raise it to absorb worker clock skew but anything above ~120 s is operationally suspect), (3) verifies `worker_sig` as BIP-340 over the canonical pre-image, (4) recomputes `intent_pool_hash` locally over the published list and compares to the on-chain envelope, (5) binary-searches the sorted list for their `my_intent_id`. All pass ⇒ `soft_confirmed`; any fail ⇒ `stale` / `forged` / `equivocator` / `untrusted_worker` / `intent_missing`.

**Settlement does NOT depend on T_INTENT_ATTEST.** Any surface (AMM pool, orderbook scope) can operate indefinitely without any T_INTENT_ATTEST envelopes ever being broadcast — traders just don't get the soft-confirm UX. The hard-confirm paths (T_SWAP_BATCH §5.16, T_SWAP_VAR §5.20, T_AXFER_VAR §5.7.9) are all independent.

**Channel framing (informative):** the preconf layer is a *tacit channel* — a multi-party off-chain commitment where the worker is the channel operator, the open intent pool is the channel state, and each T_INTENT_ATTEST envelope is a periodic anchor of the state to L1. The worker cannot steal (never holds funds; intents are commitments, not value transfers), cannot censor unilaterally (traders have unconditional unilateral exit via self-broadcast — T_SWAP_VAR self-broadcast for AMM, direct T_AXFER_VAR fulfilment against any maker UTXO for orderbook), and cannot equivocate without leaving on-chain evidence. No funding tx, no commitment-tx exchange, no penalty-tx mechanism, no challenge protocol, no covenants — just a hash commitment and a signature, fitting Bitcoin natively. See AMM.md §"Worker as channel operator" for the analogy table with payment channels.

Reference impl: `tests/amm-attest.mjs` (`OpenIntentSMT`, `validateAmmAttest`, `verifySoftConfirm`). Parity suite: `tests/amm-attest.test.mjs` (32 tests).

### 5.18 T_PROTOCOL_FEE_CLAIM (`0x31`) — mint accrued protocol fee to recipient UTXO

Authenticated mint of the pool's accrued protocol-fee balance as an `lp_asset_id` UTXO to the founder-pinned `protocol_fee_address`. The opcode has no Groth16 proof: the claim amount is public (it equals the pool's `protocol_fee_accrued` counter at decode time) and the LP-share commitment uses a public opening (amount, blinding) since LP shares are fungible and the recipient is already public.

**Wire format (fixed 202 bytes):**

```
opcode(1)                  = 0x31
pool_id(32)                # SHA256("tacit-amm-pool-v1" || asset_A || asset_B || fee_bps_LE || capability_flags) — see SPEC §4.1
claimer_pubkey_x_only(32)  # x-only of pool.protocol_fee_address
claim_amount_LE(8)         # u64, > 0 — must equal pool.protocol_fee_accrued (post-crystallization)
claim_C_secp(33)           # Pedersen commitment of claim_amount with chosen blinding
claim_blinding(32)         # r_secp (revealed; opening is public for fungible LP shares)
claim_sig(64)              # BIP-340 over claim_msg
```

**`claim_msg`:**

```
claim_msg = SHA256(
    "tacit-amm-protocol-fee-claim-v1"
    || pool_id(32)
    || claim_amount_LE(8)
    || claim_C_secp(33)
    || claim_blinding(32)
)
```

**Validator algorithm** (extends §5.5):

1. Decode payload. Reject on structural error or wrong total length (≠ 202).
2. Reject `claim_amount == 0`.
3. Recompute `pool_id` from `(asset_A, asset_B, fee_bps, capability_flags, protocol_fee_address, protocol_fee_bps)` of the pool registered in the indexer (the full discriminator tuple — see SPEC §4.1; trailing protocol-fee fields appended iff the pool has a non-zero protocol fee); reject if the envelope's `pool_id` doesn't match a known pool.
4. Reject if `pool.protocol_fee_address` is all-zeros (no protocol fee configured) or `pool.protocol_fee_bps == 0`.
5. Reject if `claimer_pubkey_x_only` doesn't equal the x-only of `pool.protocol_fee_address`.
6. **Crystallize protocol fee** on pool state: `pool ← crystallizeProtocolFee(pool)`. This applies the Uniswap-V2-lazy `mintFee` formula over `(k_now − k_last)` and updates `pool.protocol_fee_accrued`, `pool.lp_total_shares`, and `pool.k_last`.
7. Reject if `claim_amount != pool.protocol_fee_accrued` (post-crystallization).
8. Verify `claim_sig` is a valid BIP-340 signature under `claimer_pubkey_x_only` over `claim_msg`.
9. Verify `claim_C_secp` opens to `(claim_amount, claim_blinding)` — i.e., `claim_C_secp == claim_amount·H_secp + claim_blinding·G_secp`.
10. Reject if `claim_blinding ≥ secp256k1 group order`.
11. Emit an `lp_asset_id` UTXO at `vout[0]` payable to a P2WPKH/P2TR script under `claimer_pubkey_x_only`, carrying commitment `claim_C_secp` with amount `claim_amount` and blinding `claim_blinding`.
12. Set `pool.protocol_fee_accrued = 0`. `pool.k_last` is already updated by step 6.

**Properties:**
- **No replay:** every successful claim resets `protocol_fee_accrued` to 0; a stale envelope with the same `claim_amount` will be rejected at step 7 (the new `protocol_fee_accrued` is now lower or zero).
- **No Groth16:** the claim is authenticated purely by `claim_sig` + commitment opening. The verifier needs no per-pool circuit artifact.
- **No envelope-resize:** the wire format is fixed-length (202 bytes) — every claim envelope is byte-identical in size, removing any ambiguity in length parsing.
- **Forward-compatible recipient script:** validator implementations MAY accept any standard P2WPKH/P2TR/P2WSH script under `claimer_pubkey_x_only`; for v1, the canonical script is `OP_1 <claimer_pubkey_x_only>` (P2TR key-path).

**Forward compatibility:** the founder picks `protocol_fee_address` at POOL_INIT and it is immutable. Future ceremonies MAY add a governance opcode that mutates pool fee parameters; v1 pools are not eligible for that path and retain their founder-set address.

Reference impl: `tests/amm-validator.mjs` (`validateProtocolFeeClaim`). Parity suite: `tests/amm-protocol-fee.test.mjs` (31 tests).

### 5.19 T_WRAPPER_ATTEST (`0x38`) — optional on-chain wrapper attestation

> **Status:** OPTIONAL. Issuers MAY publish wrapper attestations off-chain (IPFS, website, tacit worker) per §4.2.4 without ever using this opcode. The opcode exists for issuers who want their attestation timestamped onto Bitcoin chain itself, providing a stronger liveness signal at the cost of ~2 Bitcoin txs per attestation (commit + reveal).

**Wire format (envelope payload, fixed 159 bytes):**

```
opcode(1)             = 0x38
network_tag(1)        # 0x00=mainnet, 0x01=signet, 0x02=regtest
asset_id(32)
issuer_pubkey(33)     # compressed secp256k1
reserves_LE(8)        # u64; reserves balance at as_of_height
supply_LE(8)          # u64; circulating supply at as_of_height
as_of_height_LE(4)    # u32; Bitcoin block height
timestamp_LE(8)       # u64; unix seconds
attestation_sig(64)   # BIP-340 over attestation_msg per §4.2.4
```

Total: `1 + 1 + 32 + 33 + 8 + 8 + 4 + 8 + 64 = 159` bytes fixed. No Pedersen commitments, no range proofs, no asset-input chain — purely a signed-data envelope. The wire-carried `network_tag` MUST match the indexer's local network identifier; this is a belt-and-suspenders defense against the theoretical case where asset_ids collide across networks.

**On-chain embedding.** 159 bytes exceeds Bitcoin's standard `OP_RETURN` policy limit (80 bytes). T_WRAPPER_ATTEST therefore uses the **standard tacit commit-reveal pattern** identical to T_AXFER / mixer envelopes:

- **Commit tx**: a Bitcoin transaction with one P2TR output. The P2TR's tap-tree is a single leaf whose script is the envelope-bearing tacit script (`OP_FALSE OP_IF "TACIT" 0x01 <payload> OP_ENDIF`). The internal key is NUMS so only the script-path is spendable.
- **Reveal tx**: a Bitcoin transaction whose `vin[0]` spends the commit's P2TR output via script-path, revealing the envelope as the script-path witness. The reveal tx has no required tacit vouts (the attestation produces no asset UTXO). Optional vouts MAY carry BTC change at the issuer's discretion.

Two Bitcoin transactions per attestation; total ~385 vbytes. At 10 sat/vB: ~3850 sats per attestation. Daily attestation at mainnet fee rates ≈ $1-2/day at current sat prices.

**Validator algorithm** (extends §5.5):

```
if envelope.opcode == T_WRAPPER_ATTEST:
    require envelope.asset_id is well-formed
    require envelope.issuer_pubkey is a valid compressed secp256k1 point
    require envelope.network_tag matches the local network identifier

    // Height bound — applied differently at mempool admission vs post-confirmation:
    if validating at mempool admission:
        require envelope.as_of_height ≤ current_tip_height
    if validating post-confirmation:
        require envelope.as_of_height ≤ this_tx.confirmation_height

    recompute attestation_msg per §4.2.4 (binds the same network_tag)
    require attestation_sig verifies under issuer_pubkey

    if all checks pass:
        // Three-case dedup against the wrapper-attestation log keyed by
        // (network, asset_id, issuer_pubkey, as_of_height):
        let existing = log.get(network, asset_id, issuer_pubkey, as_of_height)
        if existing is None:
            log.put(...)                                       // first-confirmed: record
            accept envelope
        else if existing.{reserves,supply,timestamp} == envelope.{...}:
            accept envelope (idempotent duplicate; no state change)
        else:
            flag issuer_pubkey as EQUIVOCATOR in wrapper registry
            reject envelope (do not overwrite the canonical entry)
```

The reveal tx's vouts MAY carry anything (BTC change, etc.); none of them are tacit UTXOs. The envelope sits in `vin[0].witness[1]` as the script-path leaf script, not in any vout.

**Soundness.** The opcode emits no asset UTXOs and modifies no asset state. Its only effect is appending an entry to the indexer's wrapper-attestation log keyed by `(network, asset_id, issuer_pubkey, as_of_height)`. An adversarial issuer attestation is *publishable* (the sig verifies) but is *easily refuted* by anyone who fetches the named reserve and supply values from chain and observes a mismatch.

**Replay protection — three cases:**

1. **First attestation per (network, asset_id, issuer_pubkey, as_of_height)**: indexer records it; accept.
2. **Duplicate attestation with byte-identical content**: accept silently (idempotent; safe for retry/rebroadcast scenarios).
3. **Equivocation** — same `(network, asset_id, issuer_pubkey, as_of_height)` tuple, but different `(reserves, supply, timestamp)`: flag the issuer in the wrapper registry as an equivocator. Subsequent attestations from this issuer MAY be downweighted or rejected by indexers (per dapp policy). The canonical entry remains the first-confirmed one.

### 5.20 T_SWAP_VAR (`0x32`) — per-trade variable-amount AMM swap

> Section appears after §5.19 to preserve back-reference stability;
> in opcode order this sits between §5.18 (`T_PROTOCOL_FEE_CLAIM`, 0x31)
> and §5.19 (`T_WRAPPER_ATTEST`, 0x38). Full architectural rationale and
> the trader-UX model are in AMM.md §"Two AMM trader paths" + `spec/amendments/SPEC-SWAP-VAR-AMENDMENT.md`.

The second AMM trader path: per-trade-against-curve fills with continuous-amount `[Y, X]` range semantics, settled in a single Bitcoin tx with **no Groth16 proof and no batching**. Lives alongside `T_SWAP_BATCH` (`0x2F`) under the "two AMM trader paths" model. Reuses CXFER N=2 cryptography (Pedersen + aggregated bulletproof + kernel sig) from `T_AXFER_VAR` (`0x37`); ships independently of the AMM Phase 2 trusted setup.

**Settlement semantics are market-order-within-floor + pass-through** (2026-06-05 revision; extended rationale in `spec/amendments/SPEC-SWAP-VAR-AMENDMENT.md` §"Concurrency and the burn race"): the validator evaluates the curve at the pool's **actual running reserves** at the envelope's canonical position, the trader's signed `min_out` is the binding price consent, and an envelope that authenticates but cannot execute **passes the trader's input back through** at the receipt slot instead of consuming it without credit. Concurrent same-pool swaps therefore all settle — each at its canonical-position price, or as a refund — and no interleaving can destroy a trader's input. Activation is height-gated per network (`SWAP_VAR_OUTCOME_ACTIVATION`; networks with no prior `T_SWAP_VAR` history pin 0); envelopes confirmed below the activation height validate under the superseded strict-equality algorithm preserved in the amendment file's git history.

**Trade-offs vs `T_SWAP_BATCH`:**

| Property | `T_SWAP_VAR` (this section) | `T_SWAP_BATCH` (§5.16) |
|---|---|---|
| Trade size | Public (`delta_in` cleartext) | Hidden in Pedersen aggregate |
| Range semantics | Yes — `[delta_in_min, delta_in_max]` | No — fixed `amount_in_swap` |
| Whole-UTXO consumption | No — change UTXO supported | Required (pre-split via CXFER) |
| Settlement | Single tx, per-fill curve | Two-RTT, batched at uniform `P_clear` |
| Crypto | Bulletproof + kernel sig | Groth16 batch + sigma cross-curve |
| Ceremony | None (CXFER reuse) | Phase 2 trusted setup |
| MEV resistance | Bitcoin tx-order MEV applies | Uniform price within batch |

The dapp's swap tile SHOULD default to `T_SWAP_VAR` for typical flow and surface `T_SWAP_BATCH` as the opt-in "private mode" with the trade-off explained (longer settlement, hidden trade size, batched with others).

**Wire format** (full byte layout + field semantics: `spec/amendments/SPEC-SWAP-VAR-AMENDMENT.md` §"Wire format"):

```
opcode(1)                  = 0x32
pool_id(32)
direction(1)               # 0 = A→B, 1 = B→A
R_A_pre(8)                 # u64 LE — trader's reserve view at quote time (advisory)
R_B_pre(8)                 # u64 LE — trader's reserve view at quote time (advisory)
delta_in(8)                # u64 LE — chosen fill amount Δ
delta_in_min(8)            # u64 LE — Y, lower bound of trader's range
delta_in_max(8)            # u64 LE — X, upper bound of trader's range
delta_out(8)               # u64 LE — trader's quoted Δ_out (advisory; the credited
                           #   amount is the validator's curve evaluation at actual reserves)
min_out(8)                 # u64 LE — slippage floor — the trader's binding price consent
tip_amount(8)              # u64 LE — settler tip in tip_asset
tip_asset(1)               # 0 = asset_A, 1 = asset_B (MUST == input asset)
expiry_height(4)           # u32 LE
trader_pubkey(33)          # compressed secp256k1
C_in_secp(33)              # trader's input UTXO commitment
C_change_or_sentinel(33)   # fresh-blinded change commit, or 33×0x00 NO-CHANGE SENTINEL
C_receipt_secp(33)         # QUOTED receipt commitment: delta_out·H + r_receipt·G
                           #   (bulletproof slot-1 subject; advisory at credit time —
                           #   the receipt UTXO's canonical commitment is validator-
                           #   derived from the resolved outcome)
r_receipt(32)              # scalar mod n_secp BE; published so the indexer can DERIVE
                           #   the canonical receipt commitment from the outcome amount
                           #   (load-bearing inflation defense — no trader-declared
                           #   receipt value is trusted; see amendment §"Wire format")
range_proof_len(2)         # u16 LE
range_proof(...)           # aggregated bulletproof m=2 over (C_change_or_sentinel, C_receipt_secp)
kernel_sig(64)             # BIP-340 over kernel_msg
intent_sig(64)             # BIP-340 over intent_msg under trader_pubkey
```

Total payload ≈ 950–1000 bytes.

**Bitcoin tx layout (normative — indexers reject deviations):**

| Index | Role |
|---|---|
| `vin[0]` | Settler's envelope-bearing input (Taproot script-path); witness carries the T_SWAP_VAR payload |
| `vin[1]` | Trader's tacit asset UTXO of (direction == 0 ? asset_A : asset_B); signed SIGHASH_ALL |
| `vin[2..]` | Optional settler BTC funding inputs |
| `vout[0]` | `OP_RETURN(envelope_hash)` — 0 sat, 32-byte data; `envelope_hash = SHA256(payload)` |
| `vout[1]` | Trader receipt UTXO — dust P2WPKH; outcome-dependent: on EXECUTE the **output** asset at `delta_out_actual`, on PASS-THROUGH the **input** asset refunded at `delta_in + tip_amount` (canonical commitment validator-derived in both cases) |
| `vout[2]` | Trader change UTXO — dust P2WPKH; carries `C_change_or_sentinel`. Omitted iff `C_change_or_sentinel == NO_CHANGE_SENTINEL` (whole-input case) |
| `vout[3]` | Optional settler tip UTXO — present iff `tip_amount > 0` |
| `vout[4..]` | Optional settler BTC change |

**Self-broadcast supported.** Unlike `T_SWAP_BATCH`, a trader can self-broadcast a `T_SWAP_VAR` envelope without a settler (the kernel sig closure is single-trader; no second-party signatures required). The trader funds their own BTC fee, sets `tip_amount = 0`, and pays no settler tip. Suitable for power users + privacy-conscious flow that wants to avoid leaking batch composition to a settler operator.

**Validator algorithm (outcome taxonomy).** Every confirmed envelope resolves to exactly one of **INVALID** (authentication failure — no tacit credit anywhere, the input's value chain ends), **EXECUTE** (market-order fill at actual reserves), or **PASS-THROUGH** (refund — pool state unchanged, input credited back at the receipt slot). Authentication gates are all over data the builder controls at sign time, so INVALID is unreachable for a correct builder; every condition dependent on confirmation-time state lives in the executability stage, where failure refunds instead of burning. Envelopes confirmed below `SWAP_VAR_OUTCOME_ACTIVATION[network]` validate under the superseded strict-equality algorithm.

*Stage A — authentication (any failure ⇒ INVALID):*

1. Verify `vout[0]` is a 0-sat `OP_RETURN` whose 32-byte data equals `SHA256(payload)`.
2. Decode payload; verify `opcode == 0x32`; verify `r_receipt < n_secp`.
3. **Input binding:** verify `C_in_secp` byte-equals the commitment carried by `vin[1]`'s parent output (the conservation arithmetic below is only sound against the real input value).
4. **Intent sig:** reconstruct `intent_msg` from envelope fields + `vin[1]` outpoint + `vout[1]` `receive_scriptPubKey`; verify `intent_sig` (BIP-340) under `trader_pubkey` x-only.
5. **Kernel sig:** construct verifier key `P = C_change_or_sentinel − C_in_secp + delta_in_total · H_secp` with `delta_in_total = delta_in + tip_amount` (and `NO_CHANGE_SENTINEL` substituting the additive identity); verify `kernel_sig` under `P.x_only()` over `kernel_msg`. Closes the trader's input-asset side only.
6. **Bulletproof:** verify aggregated m=2 range proof over `(C_change_or_sentinel, C_receipt_secp)`. Slot-0 proves `change_amount ≥ 0` (prevents over-spend; load-bearing); slot-1 ranges the quoted receipt for wire-parity with `T_AXFER_VAR` — the credited receipt's range-safety is established by derivation (step 9).

*Stage B — executability (any failure ⇒ PASS-THROUGH):*

7. With `pool` = the running pool state at this envelope's canonical position `(block, tx_index)` — including earlier-position same-block AMM envelopes per AMM.md §"Indexer determinism rules" — require ALL of:
   - `pool_id` registered with fully-verified validation status; `direction ∈ {0, 1}`; `vin[1]`'s parent asset equals the direction's input asset; `tip_asset` equals the direction's input asset;
   - `delta_in > 0` and `delta_in_min ≤ delta_in ≤ delta_in_max`;
   - `confirm_height < expiry_height`;
   - **curve at actual reserves:** with `γ_num = 10000 − pool.fee_bps`, `γ_den = 10000`:
     - direction 0: `delta_out_actual = ⌊pool.reserve_B · γ_num · delta_in / (pool.reserve_A · γ_den + γ_num · delta_in)⌋`
     - direction 1: `delta_out_actual = ⌊pool.reserve_A · γ_num · delta_in / (pool.reserve_B · γ_den + γ_num · delta_in)⌋`

     with post-reserves representable u64 and `> 0`;
   - **slippage floor:** `delta_out_actual ≥ max(1, min_out)` (a zero-output fill never executes — pass-through is strictly kinder than donating `delta_in` to the pool).

*Outcome application:*

8. **EXECUTE:** apply `(R_A_post, R_B_post)`; credit receipt UTXO at `vout[1]` with the **output** asset, amount `delta_out_actual`, canonical commitment `delta_out_actual · H_secp + r_receipt · G_secp`; credit change UTXO at `vout[2]` if non-sentinel; if `tip_amount > 0` AND `vout[3]`'s commitment opens to `tip_amount` under the settler's derived `r_tip` (domain `"tacit-amm-swap-var-tip-v1"`), credit the tip — an unopenable tip output is simply not credited (settler forfeits the tip; fill and pool unaffected). **Protocol fee is NOT crystallized here** (Uniswap-V2-lazy: only at LP events + `T_PROTOCOL_FEE_CLAIM`).
9. **PASS-THROUGH:** pool state unchanged; credit receipt UTXO at `vout[1]` with the **input** asset, amount `delta_in + tip_amount` (everything the kernel closure proves left the input beyond the committed change — no tip on non-execution), canonical commitment `(delta_in + tip_amount) · H_secp + r_receipt · G_secp`; credit change UTXO at `vout[2]` if non-sentinel; `vout[3]` carries no tacit value.
10. Both outcomes: mark `vin[1].outpoint` consumed. The derivation in steps 8–9 is the inflation defense: the receipt's committed value is computed by the validator from amounts it itself established (curve output, or the kernel-bound refund total); no trader-declared receipt value is trusted. Range-safety needs no new proof — `delta_out_actual < reserve` by curve construction, and `delta_in + tip_amount ≤ amount_in < 2⁶⁴` transitively from the input's own ancestry range proof via the kernel closure. Indexers persist each swap's resolved outcome (or re-derive it by replay) to answer spend-time ancestry validation for receipt UTXOs, since the credited amount is no longer a static envelope field.

**Domain-tag additions (BIP-340 signature / HMAC domains):**

| Tag | Use |
|---|---|
| `tacit-amm-swap-var-v1` | `intent_msg` SHA256 domain |
| `tacit-amm-swap-var-receipt-v1` | HMAC derivation of `r_receipt` from trader privkey |
| `tacit-amm-swap-var-recv-v1` | HMAC derivation of receipt pubkey (P2WPKH recipient address) |
| `tacit-amm-swap-var-change-v1` | HMAC derivation of `r_change` for the change UTXO |
| `tacit-amm-swap-var-tip-v1` | HMAC derivation of `r_tip` for the settler-tip output |

The `kernel_msg` reuses the shared `tacit-kernel-v1` domain from CXFER (§5.4) / `T_AXFER_VAR` (§5.7.9); the asset-side single-sided closure pattern is structurally parallel to `T_AXFER_VAR`'s maker-side closure.

**Settler / dapp behavior** is fully specified in the amendment (`spec/amendments/SPEC-SWAP-VAR-AMENDMENT.md` §"Settlement flow", §"Open questions"); summarized briefly: settler observes pool depth, builds the envelope using trader-supplied range parameters and the trader's pre-signed intent, broadcasts. The trader's dapp validates the assembled envelope before sending the kernel-sig excess scalar (this step replaces `T_SWAP_BATCH`'s two-RTT auto-sign flow).

Reference impl: `tests/swap-var.mjs` (`validateSwapVar`, `encodeSwapVar`, `decodeSwapVar`, `curveDeltaOut`, `buildTickFan`, `buildSwapVarIntentMsg`, `buildSwapVarKernelMsg`); re-exported from `tests/amm-validator.mjs` as the single canonical entry point for the AMM-opcode validator surface. Spec-conformance pins: `tests/amm-spec-conformance.test.mjs`.

### 5.21 T_CXFER_BPP (`0x22`) — confidential transfer with Bulletproofs+ rangeproof

`T_CXFER_BPP` is a byte-for-byte parallel of `T_CXFER` (§5.2) carrying a **Bulletproofs+** (Chung, Han, Lai, Maller, Mohnblatt, Sarkar, Sharma; 2020) aggregated rangeproof in place of the standard Bulletproofs rangeproof. Pedersen commitment, kernel-msg construction, ECDH-derived blinding + amount-recovery, aggregation cap `N ∈ {1,2,4,8}`, and the soft-fork unknown-opcode framing are all preserved verbatim. Witness footprint drops ~14% across `m ∈ {1,2,4,8}` from the BP+ wire savings (3 group elements + 3 scalars in the BP+ baseline vs 4 group elements + 5 scalars in BP).

**Wire format:**

```
T_CXFER_BPP(1)              = 0x22
|| asset_id(32)
|| kernel_sig(64)            Schnorr sig over kernel_msg, see §5.2
|| N(1)                      number of outputs, ∈ {1,2,4,8}
|| (commitment(33) || amount_ct(8))  ×N
|| rp_len(2)
|| rangeproof(rp_len)        aggregated Bulletproofs+, m=N, n=64
```

Every field except the opcode byte and the `rangeproof` bytes is byte-identical to §5.2. The kernel msg, commitment encoding, and amount-encryption keystream are unchanged.

**Kernel message** — identical to §5.2 (CXFER), with `burned_amount = 0`:
```
kernel_msg = SHA256(
    "tacit-kernel-v1"
    || asset_id(32)
    || in_count(1) || (input_txid_BE(32) || input_vout_LE(4))*in_count
    || out_count(1) || output_commitment(33)*out_count
    || burned_amount_LE(8)    # 0 for T_CXFER_BPP
)
```

Domain-tag reuse is intentional: the kernel signature secures the asset-side balance equation `(Σ output_commitments) − (Σ input_commitments) = excess·G`, which is identical between `T_CXFER` and `T_CXFER_BPP`. The same kernel-signing path in `dapp/tacit.js` and the worker indexer applies unchanged; only the rangeproof prover/verifier is swapped.

**Rangeproof specification.** Aggregated Bulletproofs+ per Chung et al. 2020 §3 (Weighted Inner-Product Argument) + §4.4 (Aggregated Range Proof). Public parameters:

| Parameter | Value |
|---|---|
| Curve | secp256k1 (same as T_CXFER) |
| Range `n` | `64` (commitments prove `v ∈ [0, 2⁶⁴)`) |
| Aggregation `m` | `N` (1, 2, 4, or 8 — matches output count) |
| `G` | secp256k1 base point |
| `H` | §3.1 NUMS construction under `tacit-generator-H-v1` |
| `G_vec[0..511]`, `H_vec[0..511]` | §3.1 try-and-increment under `tacit-bp-G-v1` / `tacit-bp-H-v1` |
| `Q` | §3.1 try-and-increment under `tacit-bp-Q-v1` |
| Fiat-Shamir transcript hash | SHA-256, transcript-tagged per the WIPA construction in `dapp/bulletproofs-plus.js` |

Generator vectors are **reused unchanged** from §3.1; no new NUMS-derivation domain tags are introduced. The pinned hex-encoded reference test vectors in §3.1 (`G_vec[0..3]`, `H_vec[0..3]`, `H`, `Q`) remain authoritative cross-implementation parity checks for both `T_CXFER` and `T_CXFER_BPP`.

Proof size at each aggregation level (measured against the reference port in `dapp/bulletproofs-plus.js`):

| `m` | T_CXFER (BP) | T_CXFER_BPP (BP+) | Saving |
|---|---|---|---|
| 1 | ~688 B | **591 B** | -14% |
| 2 | ~754 B | **657 B** | -13% |
| 4 | ~820 B | **723 B** | -12% |
| 8 | ~886 B | **789 B** | -11% |

**Validator algorithm.** The §5.5 dispatch carries a dedicated `T_CXFER_BPP` branch (see §5.5):

```
if envelope.opcode == T_CXFER_BPP:
    recursively validateOutpoint each input outpoint (tx.vin[1..])
    verify aggregated Bulletproofs+ rangeproof for outputs
    verify asset_id consistency: every input's parent envelope declares the same asset_id
    compute E' (no burn term) and verify kernel_sig under E'.x_only()
    return true
```

**Mixed-ancestry rule.** A `T_CXFER_BPP` envelope MAY consume inputs produced by any of `T_CETCH`, `T_MINT`, `T_CXFER`, `T_AXFER`, `T_AXFER_VAR`, `T_PMINT`, `T_WITHDRAW`, `T_DCLAIM`, `T_PROTOCOL_FEE_CLAIM`, or any other producing opcode. The reverse also holds: `T_CXFER`, `T_AXFER`, `T_AXFER_VAR`, and `T_BURN` envelopes MAY consume inputs produced by `T_CXFER_BPP`. The ancestry walk recurses across the producing-opcode's verifier (Bulletproofs for CXFER ancestors, Bulletproofs+ for `T_CXFER_BPP` ancestors); **both verifiers MUST be present in any conforming indexer** for as long as either opcode appears anywhere in chain history.

**Soundness.** Identical reduction shape to §5.2 (Mimblewimble + range-proof argument):

1. **Conservation of value.** `E' = (Σ output_commitments) − (Σ input_commitments)`. If amounts balance, `E' = excess·G` (no `H` component) and the kernel signature verifies. Otherwise `E'` carries a non-zero `H` component and producing a valid signature requires solving the discrete log of `H` w.r.t. `G` — hard since `H` is NUMS (§3.1).
2. **No inflation via negative amounts.** The aggregated Bulletproofs+ rangeproof binds each output's committed value to `[0, 2⁶⁴)`. Soundness reduces to the DLog assumption over secp256k1 (Chung et al. 2020 Theorem 4.4 — identical reduction shape to standard Bulletproofs).
3. **No cross-asset confusion.** `asset_id` is committed in the kernel msg, and the validator asserts asset_id consistency across every recursively-validated input. Identical to §5.2.
4. **No replay across outpoints.** The kernel msg binds every input outpoint (`txid_BE || vout_LE`). Identical to §5.2.

**Recovery.** `amount_ct` is encrypted under an HMAC-keystream derived from the ECDH shared secret between sender and recipient pubkeys — identical to §3.5 and §5.2. **Bulletproofs+ changes only the rangeproof bytes**; the amount-recovery code paths in `dapp/tacit.js` and the worker require zero modification. A wallet recovering on a fresh device walks ancestry across whatever mix of `T_CXFER` and `T_CXFER_BPP` envelopes appears in chain history, dispatching on the opcode byte to the correct rangeproof verifier; the rest of the recovery flow is opcode-agnostic.

**Domain-tag additions:** none. Kernel signatures reuse `tacit-kernel-v1`; rangeproof generator derivations reuse `tacit-generator-H-v1` / `tacit-bp-G-v1` / `tacit-bp-H-v1` / `tacit-bp-Q-v1` from §3.1 verbatim. Cross-impl parity for both proof systems is anchored by the same pinned hex constants.

**Activation gating.** The reference dapp's send-path accepts `useBpp` per-call; `bppEnabled()` defaults ON for signet and OFF for mainnet (mainnet flip via `localStorage['tacit-bpp-enable-mainnet-v1']`). Indexers MUST accept `T_CXFER_BPP` envelopes on both networks unconditionally — the gate is sender-side only.

Reference impl: `dapp/bulletproofs-plus.js` (`bppRangeProve`, `bppRangeVerify`), `dapp/tacit.js` (`encodeCXferBppPayload`, `decodeCXferBppPayload`, `validateOutpoint` dispatch, `bppEnabled`), `worker/src/index.js` (`T_CXFER_BPP` constant + `decodeCXferBppPayload` + ancestry-walk + canonical-order branches). Test suite: `tests/bulletproofs-plus-*.test.mjs` (11 test files covering roundtrip, adversarial, malicious-prover, Monero-scenarios, pinned fixtures, property fuzz, prover smoke, Python parity, symbolic identity, witness extractor, bounded exhaustive), `tests/cxfer-bpp-wire.test.mjs`, `tests/cxfer-bpp-integration.test.mjs`. Signet harness: `tests/cxfer-bpp-onchain-e2e-signet.mjs` (mixed-ancestry CETCH → T_CXFER_BPP → T_CXFER round-trip). Extended-narrative draft preserved at `spec/amendments/SPEC-CXFER-BPP-AMENDMENT.md`.

### 5.22 T_SWAP_ROUTE (`0x33`) — atomic multi-hop AMM swap

> Section appears after §5.21 to preserve back-reference stability;
> in opcode order this sits between §5.20 (`T_SWAP_VAR`, 0x32) and
> §5.19 (`T_WRAPPER_ATTEST`, 0x38). Full architectural rationale,
> threat model, and tip-mechanic follow-up are in
> `spec/amendments/SPEC-SWAP-ROUTE-AMENDMENT.md`.

`T_SWAP_ROUTE` settles a single trader's N-hop swap atomically across up to `N_HOPS_MAX = 4` AMM pools in one Bitcoin tx — Uniswap-V2-router parity for tacit. Hop *k*'s public output delta feeds hop *k+1*'s input; the trader's Pedersen-committed input UTXO and a fresh Pedersen-committed receipt UTXO close under a single kernel sig that binds the entire route. Pre-ceremony viable: reuses the bulletproof rangeproof + kernel-sig stack from `T_SWAP_VAR` (§5.20); introduces no new Groth16 circuit and no new ceremony coupling. Distinct from `T_TRADE_BATCH` (`0x39` — cross-surface AMM↔orderbook; ships independently).

**Inherits §5.20's outcome-taxonomy settlement semantics route-atomically** (same activation constant): the validator re-derives every hop at the actual running reserves from `delta_in_0` forward, the terminal `min_out` is the trader's binding price consent, and a route that authenticates but cannot execute resolves as a single **PASS-THROUGH** — every pool untouched, the trader's input refunded at `vout[1]`. The declared per-hop `(R_A_pre, R_B_pre, delta_a_net_mag, delta_b_net_mag)` blocks demote to advisory quote context. There is no partial-route outcome: EXECUTE applies all hops, PASS-THROUGH applies none.

**Trade-offs vs sequential `T_SWAP_VAR`:**

| Property | `T_SWAP_ROUTE` (this section) | N × `T_SWAP_VAR` (§5.20) |
|---|---|---|
| Bitcoin txs to settle N hops | 1 | N |
| Intermediate-asset price risk | None — atomic | Exposed at each tx boundary |
| Intermediate UTXOs held by trader | None | One per hop |
| Total Bitcoin fee | ~1.3 KB envelope, single tx | ~950 B × N envelopes, N txs |
| Per-hop kernel sigs | 1 global | N |
| Slippage gate | Terminal-only on `delta_out_last` (Uni-V2 router parity) | Per-hop |
| Privacy posture | Per-hop deltas cleartext (identical to N sequential T_SWAP_VAR) | Same |

**Wire format** (full byte layout + field semantics: `spec/amendments/SPEC-SWAP-ROUTE-AMENDMENT.md` §"Wire format"):

```
opcode(1)                  = 0x33
n_hops(1)                  # u8, 2..N_HOPS_MAX (= 4)
trader_input_asset_id(32)
trader_output_asset_id(32)
min_out(8)                 # u64 LE — slippage gate on FINAL hop's
                           #          output (per-hop slippage NOT
                           #          enforced; Uni-V2 router parity)
expiry_height(4)           # u32 LE; 0 = no expiry
trader_pubkey(33)          # compressed secp256k1

# Per-hop block × N (67 bytes each)
[for hop k ∈ {0, …, n_hops−1}]:
    pool_id(32)
    direction(1)               # 0 = asset_A is input side, 1 = asset_B
    fee_bps(2)                 # u16 LE — pool's fee_bps at settle
    R_A_pre(8)                 # u64 LE — quoted pool reserve A pre-hop (advisory;
                               #   hops re-derive at actual reserves)
    R_B_pre(8)                 # u64 LE (advisory)
    delta_a_net_mag(8)         # u64 LE — quoted magnitude of pool's net A change
                               #   (advisory, except hop-0's input-side delta =
                               #   delta_in_0, which seeds the route and is
                               #   kernel-pinned to the input amount)
    delta_b_net_mag(8)         # u64 LE (advisory)

# Trader chain bindings
trader_input_outpoint:
    txid(32 BE) || vout(4 LE)
C_in_secp(33)                  # Pedersen commit at the input outpoint
C_receipt_secp(33)             # QUOTED receipt commit (trader's output; its declared
                               #   opening stays Stage-A-enforced — it pins
                               #   amount_in == delta_in_0 via the kernel closure —
                               #   but the CREDITED commitment is validator-derived
                               #   from the resolved outcome)
r_receipt(32)                  # receipt blinding (revealed; mirrors §5.20)

# Closures
range_proof_len(2)             # u16 LE
range_proof(variable)          # aggregated BP m=2 over (SENTINEL, C_receipt_secp)
kernel_sig(64)                 # BIP-340 over kernel_msg
intent_sig(64)                 # BIP-340 over route_msg under trader_pubkey
```

Total payload ≈ 1.3 KB at N=4. Well under Taproot tap-leaf limits.

**Bitcoin tx layout (normative — indexers reject deviations):**

| Index | Role |
|---|---|
| `vin[0]` | Envelope-bearing input (Taproot script-path); witness carries the T_SWAP_ROUTE payload |
| `vin[1]` | Trader's tacit asset UTXO of `trader_input_asset_id`; signed SIGHASH_ALL |
| `vout[0]` | `OP_RETURN(envelope_hash)` — 0 sat, 32-byte data; `envelope_hash = SHA256(payload)` |
| `vout[1]` | Trader's final receipt UTXO (DUST sats; asset is `trader_output_asset_id`) |
| `vout[2..]` | Optional settler-fee outputs (V1.x follow-up; absent in V1 self-fulfill) and settler change |

**Self-broadcast only in V1.** Settler-driven routing with per-hop tips is a follow-up amendment that allocates a new opcode (`T_SWAP_ROUTE_TIPPED`, e.g. `0x53`); V1 `T_SWAP_ROUTE` envelopes pay no settler tips and the trader funds the Bitcoin tx fee directly.

**Intent + kernel messages:**

```
route_msg = SHA256(
    "tacit-swap-route-v1"
    || trader_pubkey(33)
    || trader_input_asset_id(32) || trader_output_asset_id(32)
    || min_out_LE(8) || expiry_height_LE(4)
    || n_hops_LE(1)
    || hop_block_concat                # all per-hop blocks back-to-back
    || C_in_secp(33) || C_receipt_secp(33)
)

hops_hash = SHA256(hop_block_0 || hop_block_1 || …)

kernel_msg = SHA256(
    "tacit-kernel-v1"                  # reused from CXFER + T_SWAP_VAR
    || trader_input_asset_id(32) || trader_output_asset_id(32)
    || asset_input_count_LE(1) = 0x01
    || trader_input_outpoint           # txid_BE(32) || vout_LE(4)
    || C_receipt_secp(33)
    || delta_in_0_LE(8)                # hop[0]'s input-side delta
    || delta_out_last_LE(8)            # hop[n_hops-1]'s output-side delta
    || hops_hash(32)                   # binds the exact hop sequence
)
```

`hops_hash` in `kernel_msg` closes the "settler swaps the hop sequence under the same kernel sig" attack: any reorder, substitution, or pool-id swap changes `hops_hash` and invalidates the kernel sig.

The kernel-sig verification point is:

```
P = C_receipt_secp − C_in_secp − (delta_out_last − delta_in_0) · H_secp
```

signed by `excess_route = r_receipt − r_in` (modular subtraction in the secp256k1 scalar field). When the route round-trips back to the input asset at exactly break-even (`delta_out_last == delta_in_0`), the `H_secp` term collapses to ZERO and the sig closes a pure `(r_receipt − r_in)·G` balance — the same structural pattern as `T_AXFER_VAR`'s break-even closure.

**Validator algorithm (outcome taxonomy — see §5.20 for the INVALID / EXECUTE / PASS-THROUGH definitions).** Envelopes confirmed below `SWAP_VAR_OUTCOME_ACTIVATION[network]` validate under the superseded strict algorithm.

*Stage A — authentication (any failure ⇒ INVALID):*

1. Verify `vout[0]` is a 0-sat `OP_RETURN` whose 32-byte data equals `SHA256(payload)`.
2. Decode payload; verify `opcode == 0x33` and `2 ≤ n_hops ≤ N_HOPS_MAX (4)`.
3. **Input binding:** verify `C_in_secp` byte-equals the commitment carried by `vin[1]`'s parent output.
4. **Intent sig:** reconstruct `route_msg`; verify `intent_sig` (BIP-340) under `trader_pubkey`.
5. **Quoted-receipt opening:** `r_receipt != 0`, `r_receipt < n_secp`, AND `pedersenCommit(delta_out_last_declared, r_receipt) == C_receipt_secp` where `delta_out_last_declared` is the final hop's declared output delta. This opening stays load-bearing in Stage A even though the credited commitment is derived: the route has no change slot, so it is exactly what makes the kernel closure (step 6) pin `amount_in == delta_in_0` — without it the closure under-determines the input amount and the refund arithmetic is unsound.
6. **Kernel sig:** construct `P = C_receipt_secp − C_in_secp − (delta_out_last_declared − delta_in_0) · H_secp`; reject if `P == ZERO`; verify `kernel_sig` (BIP-340) over `kernel_msg` under `P.x_only`. Together with step 5 this proves `amount_in == delta_in_0` (whole-input-exact).
7. **Bulletproof:** aggregated `m=2` over `(ZERO_SENTINEL, C_receipt_secp)` (slot 0 is the additive identity; slot 1 ranges the quoted receipt). Wire-format parity with `T_AXFER_VAR` / `T_SWAP_VAR` keeps the verifier hot path identical across opcodes.

*Stage B — executability (any failure ⇒ PASS-THROUGH):*

8. Require `trader_input_asset_id != trader_output_asset_id` (degenerate route) and, if `expiry_height != 0`, `confirm_height ≤ expiry_height`.
9. Snapshot each touched pool's running reserves at this envelope's canonical position (so a route that re-visits the same pool advances state correctly hop-by-hop). **Per-hop re-derivation** (`k ∈ {0, …, n_hops−1}`), seeded with `delta_in_actual_0 = delta_in_0`:
   - Require `snap = poolSnapshot[H.pool_id]` exists with fully-verified validation status and `snap.tradable == true`; require `H.fee_bps == snap.fee_bps`; require `H.direction ∈ {0, 1}`.
   - **Asset continuity:** the hop's input asset (from `H.direction` against the pool's pair) equals `hop_input_asset` (initialized to `trader_input_asset_id`, advances each hop).
   - **Curve at actual reserves:** `delta_out_actual_k = ⌊R_out · γ_num · delta_in_actual_k / (R_in · γ_den + γ_num · delta_in_actual_k)⌋` with `γ_num = 10000 − snap.fee_bps`, `γ_den = 10000`; require `delta_in_actual_k > 0`, post-reserves representable u64 and `> 0`.
   - Advance the snapshot; feed `delta_in_actual_{k+1} = delta_out_actual_k`. The declared `(R_A_pre, R_B_pre, delta_a_net_mag, delta_b_net_mag)` blocks are not consulted (advisory).
10. **Final asset closure:** `hop_input_asset == trader_output_asset_id`.
11. **Min-out gate (terminal-only):** `delta_out_actual_last ≥ max(1, min_out)`.

*Outcome application:*

12. **EXECUTE:** apply every pool's snapshot to canonical state; consume `vin[1]`; credit `vout[1]` with `trader_output_asset_id`, amount `delta_out_actual_last`, canonical commitment `delta_out_actual_last · H_secp + r_receipt · G_secp`. **Protocol fees are NOT crystallized here** (Uniswap-V2-lazy, same as §5.20).
13. **PASS-THROUGH:** no pool advances; consume `vin[1]`; credit `vout[1]` with `trader_input_asset_id`, amount `delta_in_0` (= the full input, by the step-5/6 pin), canonical commitment `delta_in_0 · H_secp + r_receipt · G_secp`.

Stage-A failure means the Bitcoin tx still confirms (Bitcoin doesn't care about indexer semantics) but no tacit state changes and no UTXO credits — reachable only by a malformed or forged builder, never by pool movement. Atomic at the indexer-state-transition layer in all outcomes (mirrors `T_SWAP_BATCH` / `T_TRADE_BATCH` posture).

**Within-block ordering:** when multiple `T_SWAP_ROUTE` / `T_SWAP_VAR` / `T_SWAP_BATCH` envelopes touch the same pool in the same block, AMM.md §"Indexer determinism rules" applies: `(tx_index, vin[0] outpoint)` ascending. Earlier-in-block envelopes apply state first; later ones see the updated reserves. A route that re-visits the same pool walks the snapshot hop-by-hop within the same envelope.

**Reorg safety:** identical to §5.20. Pool state advances at depth ≥ 3; intermediate observers MAY display "settling (provisional)" status at depths 1–2.

**Domain-tag additions:**

| Tag | Use |
|---|---|
| `tacit-swap-route-v1` | `route_msg` SHA256 domain (intent sig) |

`kernel_msg` reuses the shared `tacit-kernel-v1` domain from §5.4 / §5.7.9 / §5.20.

**Backwards compatibility.** Purely additive. Pre-amendment indexers see opcode `0x33` as unknown and ignore (per §5.5 unknown-opcode forward-compat rule). `T_SWAP_VAR` and `T_SWAP_BATCH` paths are unchanged.

Reference impl: `tests/swap-route.mjs` (`validateSwapRoute`, `encodeSwapRoute`, `decodeSwapRoute`, `buildSwapRouteIntentMsg`, `buildSwapRouteKernelMsg`, `hashHops`); re-exported from `tests/amm-validator.mjs`. Worker dispatch: `worker/src/index.js` (`T_SWAP_ROUTE = 0x33` + `decodeTSwapRoutePayload` + scan-loop branch). Dapp builder + UI: `dapp/tacit.js` (`buildAndBroadcastSwapRoute`, `previewSwapRoute`, `findSwapRoutePath`). Tests: `tests/swap-route.test.mjs` (24/24 — wire roundtrip, msg builders, honest 2-hop, 13 adversarial cases incl. cross-pool kernel-sig replay, asset chain break, amount chain break, drained pool, fee_bps mismatch, expiry, min_out violation, tampered sigs, receipt-opening forgery), `tests/swap-route-dapp-worker-parity.test.mjs` (13/13 cross-impl byte parity), `tests/amm-router-preview.test.mjs` (13/13 dapp routing topology). Signet harness: `tests/amm-swap-route-onchain-e2e-signet.mjs`. Extended-narrative draft preserved at `spec/amendments/SPEC-SWAP-ROUTE-AMENDMENT.md`.

## 6. Recovery semantics

A wallet with only its **private key** can recover its full balance from chain data alone for every UTXO produced by the **on-chain protocol layer** (CETCH / CXFER / T_MINT / T_BURN / T_PMINT / T_WITHDRAW / T_DCLAIM, including targeted §5.7.3 T_AXFER settlements and reclaim-shape T_DROP outputs). Atomic-intent recipient UTXOs are the one exception — see §5.7.6 "Recovery model exception" — because their recipient blinding is a uniform-random scalar fixed at intent-publish time rather than ECDH-derived; recovery from chain + privkey alone is impossible by design, and recovery falls back to local opening cache or re-fetching the encrypted fulfilment from the worker. T_PMINT, T_WITHDRAW, and T_DCLAIM recovery are the *easiest* of all paths because the opening fields are published in the envelope rather than derived — no HMAC keystream, no ECDH (§5.9 *Recovery semantics*, §5.11 *Recipient blinding & amount recovery*, §5.13 *Privacy disclosure*).

For each UTXO the wallet owns:

1. **Local opening cache** (`localStorage`): `(amount, blinding)` if the wallet has previously seen this UTXO. **Required** for atomic-intent recipient UTXOs (or re-fetching from the worker's encrypted fulfilment record while it's within the 24h TTL).
2. **As recipient (CXFER, targeted T_AXFER §5.7.3)**: ECDH against sender's pubkey at `tx.vin[1].witness[1]`. Try `tacit-blind-v1` blinding + `tacit-amount-v1` keystream. Verify `pedersenCommit(decrypted_amount, blinding) == on_chain_commitment`.
3. **As own change (CXFER / BURN)**: Try `tacit-change-v1` blinding + `tacit-amount-self-v1` keystream against the change vout.
4. **As own etched supply (CETCH)**: Try `tacit-etch-v1` + `tacit-etch-amount-v1` against the etcher's commit-input anchor.
5. **As own minted supply (T_MINT)**: Try `tacit-mint-blind-v1` + `tacit-mint-amount-v1` against the mint commit-input anchor.
6. **As T_PMINT-minted supply (own or other)**: Read `(amount, blinding)` directly from the T_PMINT envelope. No derivation required — both fields are public. The wallet recognizes ownership by matching its pubkey's HASH160 against `vout[0].scriptpubkey`. Confirm `pedersenCommit(amount, blinding) == commitment` to reject tampered envelopes (the same authenticity check as paths 2–5).
7. **As mixer-pool withdrawal (T_WITHDRAW)**: Read `denomination` and `r_leaf` directly from the envelope (both are public — same recovery pattern as T_PMINT). Verify `pedersenCommit(denomination, r_leaf) == on_chain_commitment` to reject tampered envelopes. Recovery works identically whether the withdrawer === recipient or not — the public `r_leaf` makes share-links unnecessary.
8. **As T_DCLAIM-claimed supply**: Read `(amount, blinding)` directly from the envelope (both public — identical recovery pattern to T_PMINT, §5.13). The wallet recognizes ownership by matching its pubkey's HASH160 against `vout[0].scriptpubkey`. Verify `pedersenCommit(amount, blinding) == commitment` to reject tampered envelopes. For Merkle-gated drops the witness's `(eth_address, leaf_index)` is also on chain, but those fields are not required for amount-side recovery — only for re-verifying eligibility post-hoc.
9. **As T_DROP reclaim output**: Read `(cap_amount, cap_blinding)` from the reclaim-shape envelope payload (§5.12.1). Same opening primitive as paths 6–8.
10. **As AMM receipt (T_SWAP_BATCH, T_LP_ADD, T_LP_REMOVE)**: blindings are HMAC-derived from `(recipient_privkey, pool_id, recipient_anchor_outpoint, asset_id)` under the domain tags `tacit-amm-receipt-secp-v1` and `tacit-amm-receipt-bjj-v1`. The anchor is the recipient's **consumed input outpoint** in the parent envelope:
   - Swap receipt (T_SWAP_BATCH): trader's tacit input outpoint at `vin[1+rank]`.
   - LP-share receipt (T_LP_ADD): LP's canonical (first) asset-A input outpoint.
   - LP-withdraw receipts (T_LP_REMOVE): LP's lp_asset_id input outpoint. Two receipts are emitted (one per asset side); they share the anchor but differ by `asset_id` in the HMAC preimage.

   Derivation:
   ```
   anchor_outpoint = txid_BE(32) || vout_LE(4)            # 36 bytes
   seed_secp = HMAC-SHA256(recipient_privkey,
                           "tacit-amm-receipt-secp-v1"
                           || pool_id || anchor_outpoint || asset_id)
   seed_BJJ  = HMAC-SHA256(recipient_privkey,
                           "tacit-amm-receipt-bjj-v1"
                           || pool_id || anchor_outpoint || asset_id)
   r_out_secp = bigint_be(seed_secp) mod n_secp
   r_out_BJJ  = bigint_be(seed_BJJ)  mod n_BJJ
   ```

   The recipient recovers `amount_out` from public envelope data (deltas + clearing-price arithmetic for swaps; declared `delta_A`/`delta_B` for LP ops) and verifies `pedersenCommit(amount_out, r_out_secp) == C_out_secp` from the envelope. Reference impl: `tests/amm-receipt.mjs`.

   Anchoring on the input outpoint (rather than the parent txid) avoids circularity: the envelope contains `C_out_secp` which depends on `r_out_secp`, which would otherwise depend on the txid, which depends on the envelope.

If none of the paths produce a valid `(amount, blinding)` opening, the UTXO is recorded as a **"ghost"** — the wallet sees that it owns the BTC sat output but cannot decrypt the asset amount. This indicates either a legacy/incompatible sender, a misuse, or an atomic-intent recipient whose local cache and remote encrypted fulfilment are both unavailable; it does not represent loss of value (the BTC sats are still spendable by the wallet privkey).

**`amount_ct` is a raw XOR keystream — authenticity is load-bearing on the commitment check.** Decryption produces a candidate amount; the wallet MUST verify `pedersenCommit(candidate, blinding) == on_chain_commitment` before accepting it. The Pedersen binding property is what rejects tampered ciphertexts: if anyone flips a bit in `amount_ct`, the decrypted candidate differs from the originally-committed value and the equality fails. Recovery paths 2–5 above all perform this check; skipping it would let an attacker forge spurious ghost-UTXO openings.

## 7. Security properties

### 7.1 Privacy

- **Amount confidentiality** of every commitment. Perfect Pedersen hiding + bulletproof zero-knowledge. Observers see range bounds and structure but not the value.
- **Pedersen perfect-hiding is the load-bearing privacy primitive; the keystream is a recovery channel, not a privacy mechanism.** The on-chain Pedersen commitment `C = a·H + r·G` reveals nothing about `a` to any observer who lacks `r`, regardless of whether `amount_ct` is also published. Even total exposure of every wallet's keystream-derivation key — or stripping `amount_ct` from the wire entirely — would not break amount confidentiality at the commitment layer; it would only force recipients to learn `a` out-of-band (sender→recipient share-link, etc.) rather than reconstruct it from chain. `amount_ct` exists so the recipient (and only the recipient) can decode `a` from chain alone, fulfilling §6's privkey-only recovery property.
- **Keystream uniqueness across transactions** (NOT forward secrecy): the keystream that XOR-encrypts each `amount_ct` is bound to a per-tx anchor (`vin[0]` outpoint) and per-output `vout` index. The same (sender, recipient, amount) tuple produces a different ciphertext every transaction because the anchor is unique. This prevents the OTP key-reuse attack (where two ciphertexts under the same keystream leak their XOR difference) but does **not** provide forward secrecy in the cryptographic sense — the keystream derives from `HMAC(SHA256(ECDH(maker_priv, taker_pub)), …)` (or `HMAC(wallet_priv, …)` for self-derived amounts), all of which are static long-term keys. **If either party's tacit privkey is compromised, every past `amount_ct` for transactions involving that key becomes decryptable from chain alone.** Real forward secrecy would require ephemeral key exchange per transaction, which the in-page key-custody model (a single static privkey reused for every op) does not support. The fall-back to Pedersen perfect-hiding (above) is what keeps amount confidentiality intact even under that compromise: a privkey leak makes amounts recoverable to the holder of the leaked key, not to anyone else.
- **No off-chain metadata leak on the send path.** A vanilla CXFER (and a targeted §5.7.3 T_AXFER) produces a Bitcoin tx broadcast and nothing else — no worker call, no IPFS pin, no third-party service is contacted as part of the transfer. Setting `WORKER_BASE = ''` in `dapp/tacit.js` disables every off-chain endpoint and the protocol still works for transfers, validation, and recovery (§8). Discovery and marketplace features (etch/mint attestation caches, per-UTXO openings, range disclosures, OTC listings, atomic intents) are explicit user-initiated publishes; an observer of the worker sees nothing about a send unless the user separately opted to publish for that asset.

What is **not** hidden:
- **Address graph.** Bitcoin-level addresses are visible.
- **Asset_id.** Visible in CXFER / T_MINT / T_BURN payloads.
- **Sender pubkey.** P2WPKH input signatures expose sender's pubkey at `vin[1].witness[1]` (recipient needs it for ECDH). Same exposure as any P2WPKH-funded transfer.
- **Public burn amounts.** T_BURN's `burned_amount` is in cleartext.
- **Output-count bucket, not exact recipient count.** §5.2 fixes `N ∈ {1,2,4,8}` at the wire level (and §5.4 additionally permits `N = 0` for burn-everything). A CXFER carrying K recipients + 1 change output picks the smallest bucket fitting K+1 and pads the remainder with zero-amount filler outputs, each using a fresh `tacit-change-v1` blinding + `tacit-amount-self-v1` keystream — same derivation paths as a real change output. Padding commitments are `0·H + r·G = r·G`, computationally indistinguishable from a real change commitment without the wallet privkey; the holder's recovery scan decrypts them to `0` and silently skips. Observers learn "N is in {1,2,4,8}" rather than "K = 3 recipients." K=1 and K∈{3,7} pay no padding cost (they exactly fill a bucket); K∈{2,4,5,6} carry 1–3 decoys. The reference dApp always bucket-pads on every CXFER it emits; a re-implementation is free to do the same or to ship a tight non-padded N at the cost of leaking the exact recipient count.

### 7.2 Soundness

- **No inflation downstream of etch.** Kernel sig + range proof ensure `Σ_out ≤ Σ_in + burnt − burnt = Σ_in` (or `Σ_in − burned` for BURN).
- **No negative-amount smuggling.** Range proof bounds every amount to `[0, 2⁶⁴)`, including change. A "negative" amount would be `N − k` modulo the scalar field; this is *not* in the 64-bit range and the proof rejects.
- **Mint authorization (CETCH+T_MINT).** T_MINT requires Schnorr sig under `mint_authority` from the CETCH ancestor. Non-mintable assets (`mint_authority = 0`) reject all T_MINT envelopes.
- **Permissionless mint cap (T_PETCH+T_PMINT).** T_PMINT carries no signature; the cap is enforced by the indexer summing canonically-ordered T_PMINT events at confirmation depth ≥ 3 (§5.9). Cumulative supply is publicly observable for these assets — the trade is supply-side confidentiality for permissionless issuance with on-chain auditable cap. Reorgs at depth < 3 may revoke a previously-credited T_PMINT under new canonical ordering; indexers MUST re-run the cap check on reorg and surface revocations to wallets. T_PMINT envelope replay is allowed but cost-symmetric with honest minting (the rewrapper pays full Bitcoin fees and consumes one cap slot for an extra UTXO at their own output script — no theft from the original miner).
- **Replay protection.** Kernel msg binds (asset_id, input outpoints, output commitments, burned_amount). Mint msg binds (asset_id, commit_anchor, commitment, amount_ct) — the anchor prevents envelope re-wrap into a different commit/reveal pair (§5.3). T_PMINT has no signature and no anchor: rewrap is allowed, and the cost-symmetric replay analysis above is what makes it harmless. No cross-tx or cross-asset replay across any opcode.
- **Batch range-proof soundness.** The 2⁻²⁵⁵ bound on batch-verify failure assumes the batching scalars α and β are independent uniform samples drawn *after* the prover commits to the proof. Both conditions hold: each call to `randomScalar()` reads `crypto.getRandomValues`, and the draws happen inside the verify loop (post proof-fixing), so a malicious prover cannot have engineered Eq1 = −Eq2 in advance.

#### Implementation hygiene

The bulletproof prover/verifier is hand-rolled in JavaScript (see `dapp/tacit.js` and `tests/bulletproofs.mjs`). Concrete defensive measures in the implementation:

- CSPRNG (`crypto.getRandomValues`) for every scalar sample
- Length-prefixed Fiat-Shamir transcript with explicit nonzero-challenge checks
- NUMS generator vectors with published test vectors enforced at boot (`runStartupKAT`)
- Differential parity tests between dapp / worker / composition mirror covering message-byte equality and ECDH symmetry
- Ancestry-validating indexer with batch-verify that fails closed on any sub-proof rejection

### 7.3 Issuer trust

The protocol does not enforce **honesty about the announced initial supply** at the cryptographic layer. Pedersen hides the supply; without the issuer's `(supply, blinding)` opening, no third party can verify the announcement.

The reference dApp resolves this by **publishing the opening by default**, via two redundant channels:

1. **IPFS metadata (primary, worker-independent).** When attestation is enabled, the dApp pins a metadata JSON containing `tacit_attest = { supply, blinding, commitment }` to IPFS, and uses that blob's CID as the on-chain envelope's `image_uri`. Verifiers fetch the blob via the gateway, decode `tacit_attest`, and check `pedersenCommit(supply, blinding) == on_chain_commitment`. **No worker is involved** in this path — the metadata is content-addressed, anyone can re-pin it, and the binding property of Pedersen makes a forged attestation infeasible (would require finding a different opening of the same commitment).
2. **Worker `/attest` cache (secondary, discovery convenience).** The dApp also POSTs the same opening to the worker's `/assets/:asset_id/attest` endpoint as a discovery-time cache so Discover renders ✓ immediately without an extra IPFS round-trip. The worker can suppress this cache (returning no attestation) but cannot forge one — the verifier re-runs the Pedersen check client-side either way.

T_MINT events use the same model via `/assets/:asset_id/mints/:mint_txid/attest`. The reference dApp auto-attests every mint by default (per-asset opt-out via `localStorage`).

**Defaults:** the etch UI's "Publish supply opening" checkbox is on by default and labeled (recommended). For any asset etched through the dApp without opting out, supply is **provably public from chain + IPFS alone**. Issuers explicitly opt out only when they want the centralized-stablecoin trust model (USDC/USDT-style: "trust me about the supply"), which the dApp surfaces as a deliberate choice.

For non-mintable assets attested at etch, the result is **provably and permanently public supply** — no more issuance can ever occur, and the one attestation is the complete supply forever.

For mintable assets, additional trust is on the mint_authority key not being abused (the holder can mint arbitrary amounts at any time). Auto-attestation of every mint event by default closes the "K mints, N unattested" supply-bound gap; with all mints attested, total supply at any moment = etch + Σ attested mints − Σ on-chain burns.

**Reproduce it yourself.** `scripts/verify-tac-supply.mjs` is a standalone verifier of the above for a non-mintable asset, from chain + IPFS alone (no indexer trusted): it recomputes `asset_id = SHA256(etch_txid_LE ‖ vout_LE)`, reads `mint_authority` + `commitment` from the etch tx's Taproot witness, content-verifies the attestation against its IPFS CID, derives the NUMS generator `H`, and checks `pedersenCommit(supply, blinding) == commitment`. Defaults to the live TAC etch; pass `<asset_id> <etch_txid>` for any other fixed-supply asset. `scripts/verify-tac-supply-standalone.mjs` is a dependency-free build of the same check (runnable via `curl … | node --input-type=module`, no clone), and `dapp/verify.html` is the one-click in-browser version (same checks, runs client-side; served at `/verify`).

### 7.4 Mixer pool (§5.10–5.11)

**Privacy.** The withdrawer's anonymity set within a pool is the count of currently-unspent leaves at the moment the proof is broadcast. Groth16 zero-knowledge ensures a chain analyst learns no information beyond pool size from a withdrawal. **Anonymity does not require trusted setup** — Groth16 zero-knowledge is unconditional. Trusted setup is only load-bearing for *soundness* (no false withdrawals).

**Soundness.** Per §5.11.1: no pool inflation (kernel sig + denomination check on deposits), no double-withdraw (nullifier set), no recipient substitution (`bind_hash` squaring), no cross-pool/cross-root replay (`asset_id` + `denomination` + `merkle_root` committed in proof public inputs).

**Trusted-setup posture.** Each pool runs its own per-circuit Groth16 MPC ceremony at init time. Soundness rests on ≥ 1 honest contributor *for that specific pool*; pools with weaker ceremony don't undermine other pools. Pool initialization is permissionless (§5.10.1) — anyone can run a ceremony and post `POOL_INIT`. Pool consumers should verify ceremony contributor diversity before depositing; the IPFS-pinned ceremony transcripts in the on-chain envelope make this directly auditable.

**What's not hidden.**
- **Pool participation.** T_DEPOSIT and T_WITHDRAW envelopes are public — observers see *that* a particular address deposited or withdrew, just not which deposit corresponds to which withdrawal.
- **Pool size and denomination.** Public on chain; the same fact that grants anonymity sets is visible to observers.
- **Address-graph privacy.** Same as the rest of tacit (§7.1): Bitcoin sender/recipient addresses are visible. Mixer pools break the *amount-to-address-to-amount* link inside a pool but not the input or output address itself.

## 8. Worker (off-chain conveniences)

The worker (`worker/src/index.js`) is **not part of the trust-bearing protocol**. Setting `WORKER_BASE = ''` in `dapp/tacit.js` disables it entirely; the protocol still works for full validation and transfers.

Worker endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /pin` | Image upload to IPFS via Pinata |
| `POST /pin-json` | Metadata-blob pin |
| `POST /drip` | Signet faucet drip |
| `GET /balance` | Faucet wallet balance |
| `GET /assets` | List of indexed asset metadata + scan freshness |
| `GET /assets/:asset_id` | Single asset metadata |
| `POST /assets/:asset_id/attest` | Discovery cache for the etch attestation. Worker re-verifies `C == supply·H + r·G` before storing. The primary attestation channel is the IPFS metadata blob at the envelope's `image_uri` — see §7.3; this endpoint is a cache for fast Discover-first paint. |
| `POST /assets/:asset_id/mints/:mint_txid/attest` | Same shape, for T_MINT events. The reference dApp auto-attests by default (issuer opt-out per asset). |
| `GET /assets/:asset_id` (and list) — `burns[]` field | Public burn history: each entry has cleartext `burned_amount` + tx + height. No attestation needed because burns are public on-chain. |
| `POST /assets/:asset_id/disclosures` | Holder publishes a `balance ≥ K` range disclosure (§5.6); worker verifies the Schnorr sig + on-chain ownership + asset-id consistency before storing. The bulletproof itself is **not** verified by the worker (~600 LOC of verifier code per submission); consumers MUST re-verify it client-side per §5.6, requirement (4). |
| `GET /assets/:asset_id/disclosures` | List published range disclosures for an asset; consumers MUST re-verify (chain ownership and unspent-ness can change after publication). |
| `GET /assets/:asset_id/openings` | List per-UTXO `(amount, blinding)` openings the issuer/holder has voluntarily published for an asset (cache-only, optional). |
| `POST /utxos/:txid/:vout/opening` | Holder publishes a per-UTXO `(amount, blinding)` opening. Worker re-verifies the BIP-340 sig under `owner_pubkey` and `pedersenCommit(amount, blinding) == on_chain_commitment` before storing. |
| `GET /utxos/:txid/:vout/opening` | Single-UTXO opening lookup (cache-only). |
| `GET /assets/:asset_id/listings`, `POST /assets/:asset_id/listings/:txid/:vout/claim`, `DELETE /assets/:asset_id/listings/:txid/:vout` | OTC marketplace endpoints. **Settlement is OTC, not protocol-enforced** — the worker stores listing intent + an opening proof; actual delivery is bilateral. The marketplace surface lives entirely outside the on-chain protocol; an indexer that only cares about token validity can ignore it. |
| `POST /assets/:asset_id/listings-range`, `GET /assets/:asset_id/listings-range`, `POST /assets/:asset_id/listings-range/:owner_pubkey/claim`, `DELETE /assets/:asset_id/listings-range/:owner_pubkey` | Range-disclosure variant of the above (lists backed by a `balance ≥ K` proof rather than a single UTXO opening). `POST /…/claim` is a 5-minute taker reservation, symmetric to the per-UTXO `listings/:txid/:vout/claim` row. Same OTC caveat applies. |
| `POST /airdrops/:root/claims`, `GET /airdrops/:root/claims`, `DELETE /airdrops/:root/claims/:leaf_index` | Airdrop claim dropbox keyed by the issuer's merkle root. Recipients submit `(leaf_index, tacit_pubkey, eth_sig)` tuples; issuers pull batches and re-verify the merkle proof + ETH sig client-side against the off-chain snapshot before broadcasting CXFERs. Worker validates format only — it has no snapshot to check against. Lives entirely outside the on-chain protocol; canonical truth is the resulting CXFER set. |
| `POST /assets/hint` | `{ reveal_txid, reveal_vout? }` — targeted index of a freshly broadcast etch / mint / burn so it appears in `/assets` immediately without waiting for the next 5-min cron tick. Works pre-confirmation. |
| `GET /petch-assets` | Permissionless-mint asset registry (T_PETCH-rooted). Same envelope/payload shape as `/assets` plus per-asset `cap_amount`, `mint_limit`, `mint_start_height`, `mint_end_height`, `cumulative_minted` (depth ≥ 3), and a `mints_remaining` convenience field. T_PETCH-rooted assets are excluded from `/assets` so the two registries can be filtered cleanly in UI; consumers wanting "every asset" union both. |
| `GET /assets/:asset_id/pmints` | Confirmed T_PMINT events for a T_PETCH-rooted asset, in canonical (height, tx_index) order. Each entry: `{ txid, height, tx_index, recipient_script, depth, status: 'credited' \| 'pending' \| 'revoked' }`. Status is recomputed every cron tick against current depth and reorg state. Wallets MUST treat `pending` as non-spendable. |
| `POST /scan` | Manual cron trigger (debug) |
| `POST /rescan?from=<height>` | Rewind `meta:last_scanned` (debug) |

Cron (`*/5 * * * *`) scans recent signet AND mainnet blocks for CETCH, T_MINT, T_BURN, T_PETCH, and T_PMINT envelopes and indexes them. Worker decodes envelopes only structurally — the rangeproof and signature verification stay client-side. The cap counter for T_PETCH-rooted assets is maintained per-asset and re-derived from canonical chain order on every reorg-affected block. The `/assets/hint` endpoint exists so a freshly broadcast envelope appears in the registry without waiting for the next cron tick.

**Protocol validity vs. operational dependency.** "Not part of the trust-bearing protocol" means the worker cannot make an invalid envelope appear valid: every consumer is expected to re-verify rangeproofs, kernel sigs, mint sigs, and Pedersen openings client-side. It does **not** mean a malicious or faulty worker is harmless to user experience: such a worker could omit assets from `/assets`, return stale `last_scanned` heights, withhold or mis-serve `/openings` data needed for cold recovery, fail to index a freshly hinted reveal, lie about burn history, or refuse `/disclosures`. None of that produces unsound balances, but it can degrade discovery, slow recovery, and cause UI to lag chain reality. Any deployment that wants to harden against this should run its own indexer (the cron in `worker/src/index.js` is a few hundred lines and pluggable behind any mempool.space-compatible REST endpoint), or run client-side validation eagerly enough that worker output is treated as a hint rather than as canonical metadata. Likewise, the dApp's reliance on `mempool.space` REST APIs for raw-tx fetching is a UX dependency, not a trust dependency: a Bitcoin Core or Electrum backend would serve identically once the JSON shape is matched.

## 9. Out of scope (v1)

- **Multisig mint authority.** Requires FROST or MuSig2 plumbing on top of single-key Schnorr. The on-chain `mint_authority` field can hold any 32-byte x-only pubkey, so multisig is implementable later without changing the wire format.
- **Asset_id confidentiality.** Liquid CT uses surjection proofs to also hide which asset is moving. Not in tacit v1.
- **BIP-352 silent-payments receive side.** Tacit-native receiver privacy for tacit tokens ships via the shielded address primitive (SPEC-BLINDED-PUBKEY amendment, class-2) — recipients publish a `tcs1…` bech32m handle that produces per-tx-unique on-chain markers on every CXFER receipt. The mixer pool (T_DEPOSIT / T_WITHDRAW, §5.10–§5.11) provides full anonymity-set unlinkability for assets routed through it. For plain BTC sats, the **sender side** of BIP-352 is supported in the dapp's sats-send flow (recipients pasting `sp1…` / `tsp1…` get a fresh per-tx P2TR output derived from the picked input set); the **receive side** is deferred until upstream wallet support converges, since detecting inbound silent payments requires either a worker that pre-filters every taproot output or polling a third-party SP indexer. Tacit users who want receiver privacy for plain sats today route through the mixer pool.
- **Bulletproofs+** (Chung et al. 2020) — ~17% smaller proofs at the cost of additional implementation complexity. Deferred to v1.5.
- **Lightning compatibility.** Tacit transfers are on-chain only; no LN-style payment channels.
- **Multi-asset transfers in one envelope.** Each CXFER carries a single `asset_id`.

## 10. Open issues / known limitations

- **Witness size.** ~10 KB witness per CXFER (m=2) at current bulletproof sizes — about 2,500–3,000 vBytes after the SegWit discount. At 10 sat/vB on mainnet, ~25–30k sats per transfer.
- **First-load scan time.** Cold scanHoldings on a wallet with deep ancestry takes seconds (mitigated by batched verification).
- **Lost mint key = permanent fixed supply.** No recovery mechanism. The dApp gates mintable etches behind an explicit key-export step before broadcast.
- **Lost mixer note = permanent inaccessibility of the deposit.** `T_WITHDRAW` (§5.11) requires the depositor's `(secret, ν)` pair, generated by CSPRNG at deposit time (§5.10) and not derivable from chain alone. A wallet that loses its note storage cannot reconstruct the deposit; the leaf is bound to a witness only that note's holder can produce. The reference dApp gates first deposit behind a note-export step and offers deposit-record export/import. Deterministic `(secret, ν)` derivation from privkey is a future UX improvement (parallel to §6's privkey-only recovery for non-mixer flows); v1 ships with the Tornado / Privacy Pools pattern of out-of-band note backup.
- **Local storage is the wallet.** Whichever path placed a privkey in the page (auto-generated, imported, or locally bound to an external wallet address), `localStorage` is what persists it. Mainnet UX gates every value-creating op behind a "have you exported the key?" acknowledgement (per §2). Hardware-wallet signing for the protocol's signing paths is the proper long-term mitigation but not in v1.
- **Network-scoped wallet keys.** v1 stores signet and mainnet identities under separate `localStorage` keys (`tacit-wallet-v1:signet`, `tacit-wallet-v1:mainnet`, plus `…:by:<extAddr>` variants when locally bound to an external wallet). Compromise of a signet/test key does NOT compromise mainnet — they're independent secrets generated on first use of each network. The trade-off is that switching from signet to mainnet (or vice versa) presents a fresh empty wallet by default; users who want to carry an identity across networks can manually `Import key` on the destination network. Older builds used a single un-namespaced `tacit-wallet-v1`; the dApp does not auto-migrate, so existing data under that key remains accessible only via manual import.
- **T_PMINT reorg sensitivity.** Cap correctness for T_PETCH-rooted assets requires complete, canonically-ordered T_PMINT history. Two T_PMINTs near tip can each look valid in isolation yet collectively violate the cap when canonically ordered. v1 mitigates by requiring confirmation depth ≥ 3 for cap-credit (§5.9 *Confirmation depth*); the deeper the threshold, the smaller the reorg-revocation surface but the slower mint UX. Wallets MUST surface "pending" T_PMINT UTXOs as non-spendable until the depth threshold crosses, and MUST handle revocation events when an indexer reverts a previously-credited T_PMINT under new canonical ordering. CETCH+T_MINT assets are unaffected — credit there depends only on the issuer's signature, not on aggregate chain state.
- **Reference-indexer KV.list cap.** The reference worker uses a single un-paginated `KV.list({ limit: 1000 })` call in three load-bearing places: (a) `loadCanonicalPmints` per asset, (b) the `/pools` aggregate endpoint's per-pool leaf + nullifier counts, and (c) the `/pools/:asset_id/:denom` detail endpoint's leaf list and nullifier list. An asset that accrues more than 1000 confirmed T_PMINTs will under-count `cumulative_minted`; a pool that accrues more than 1000 deposits or 1000 withdrawals will return a truncated state to clients that consume the worker view. v1 ships with this cap; deployments expecting > 1000 mints on a single asset OR planning to operate a pool past 1000 leaves/nullifiers should patch the relevant call sites to follow the `list_complete` cursor before relying on the worker's aggregate view. The cap is operational, not cryptographic — the dapp's local `scanPools` reconstructs from chain regardless, so a worker truncation degrades freshness/UX, not soundness.
- **T_DROP / T_DCLAIM / T_DROP_RECLAIM (§5.12–§5.13) — shipped.** Wire format, validator pseudocode, codec, worker indexer (`drop:<network>:<drop_id>`, `dclaim:<network>:<drop_id>:<height>:<tx_index>:<txid>`, `drop-reclaim:<network>:<drop_id>` KV layout parallel to `petch:` / `pmint:`), broadcast paths for all three opcodes, recursive-validator branches in `dapp/tacit.js`, and dapp UI for create-drop / claim / reclaim are live and tested. One v1 operational note:
  - **Rewrap-credit gate.** A T_DCLAIM envelope can be copied off-chain and re-published under a different reveal txid that still binds to the same `recipient_pub` (the binding check is hash160-only, by design — see §5.13). Independent indexers ALL reject the rewrap deterministically via the `(drop_id, leaf_index)` nullifier rule. The dapp's *local* validator additionally queries the worker's `/drops-onchain/:drop_id/claims?credited=1&include_txids=1` slim view to confirm a candidate T_DCLAIM txid is the canonical winner before crediting the recipient's UTXO graph; without this gate, a recipient running purely from local validation could be tricked into double-counting the rewrap as a second balance entry until the next full rescan. The worker query mirrors `_fetchPmintCredited` used for T_PMINT. When the worker is unreachable, the validator credits optimistically (`workerAvailable: false`) and a subsequent rescan once the worker is back will correct the local view — chain truth (the nullifier rule) is unchanged either way. The same posture applies to T_DROP_RECLAIM: the dapp validator requires worker-confirmed `claim_count` to verify the declared `cap_amount` equals the canonical remainder before crediting the reclaimed UTXO; without the worker, the reclaim shape is rejected (the safety-critical case where an over-declaration would inflate supply).
- **Mixer pool — production, Phase 2 ceremony finalized.** Wire format (§5.10–§5.11), worker indexing (`/pools` + canonical leaf order + nullifier set + reorg-safety depth gate per `MIXER_DEPOSIT_CONFIRMATION_DEPTH`), dApp UI (Mixer tab), Groth16 prove + verify pipeline (snarkjs vendored at `vendor/tacit-mixer.min.js`), `T_DEPOSIT` / `T_WITHDRAW` broadcast flows, and indexer-determinism gates (worker `bind_hash` recompute mirrors dapp's per §11) are all shipped and tested (108 tests across 7 mixer test files; see `tests/mixer*.test.mjs`). Verifier soundness is closed per §3.8 + §5.11.1.

  **Both ceremony prerequisites are resolved:**

  1. ~~**Phase 1 ptau provenance.**~~ Resolved: `dapp/circuits/build.sh` fetches the publicly-attested Polygon Hermez ceremony output (`powersOfTau28_hez_final_14.ptau`, 71 public contributors, 2020–2022, Bitcoin-block-hash beacon-finalized) and dual-checks both SHA256 and BLAKE2b-512 against the canonical hashes published in the snarkjs README before proceeding; refuses to use the file on any mismatch. Phase 2 contributions cannot rescue a backdoored Phase 1, so this verified provenance is load-bearing — but it is shipped.
  2. ~~**Phase 2 per-circuit ceremony.**~~ Resolved 2026-05-11: the coordinator ran the public Phase 2 ceremony for the canonical mixer circuit (`circuit_hash = 1373a3bc34153c291d057b44edaba11d5a4aa779d0998e0d0c0e400dfc89129d`), accepted 2,227 community contributions over the contribution window, and beacon-finalized against Bitcoin block 948824 (10 MiMC iterations). Final contributor count is ~2× Tornado Cash's Phase 2 reference (1,114). The canonical bundle (final zkey, pre-beacon zkey, vk JSON, r1cs, ptau, attestations chain) is pinned to IPFS at `bafybeidq2ahzte4sfiqjsmhqta62ufenpppzpch5ppry55tzxzlvltxy2u` and hardcoded in the dapp as `CANONICAL_CEREMONY_CID`; every pool init binds to the same trust anchor. Auditors can fetch the bundle, walk the attestation chain via `prev_cid` from beacon back to genesis, and verify each link content-addresses the previous zkey. The bundle is content-addressed so any future tamper produces a different CID and fails verification at withdrawal time.

  The protocol still supports the general pattern of one-Phase-2-ceremony-per-circuit (e.g., a future circuit upgrade would require a fresh ceremony); the section above documents how the live circuit's ceremony was run.

## 11. Indexer rejection-path determinism

This section is normative for every conforming indexer (worker, dapp client, third-party).

The protocol's most consensus-sensitive state is the **set of envelopes accepted as valid**. Two indexers seeing the same byte sequence MUST reach the same accept/reject decision, byte-for-byte. Determinism in the *rejection path* is as important as determinism in the *acceptance path*: a malformed envelope that one indexer accepts and another rejects produces a fork in derived state — most catastrophically in the per-pool spent-nullifier set (§5.11), where divergence means one indexer believes a nullifier is spent (and rejects future legitimate withdraws using that ν) while another doesn't.

### 11.1 Required determinism properties

Every envelope decoder, in every implementation, MUST:

1. **Produce identical accept/reject verdicts** for byte-equal inputs. No timing-dependent or stateful rejection paths in the structural decode layer.
2. **Reject on the FIRST failed invariant** in the validator algorithm's documented order (§5.5 / §5.10 / §5.11). Indexers that short-circuit out of order may diverge on envelopes that fail multiple invariants.
3. **Return null (not throw, not partial)** on any malformed input. Throwing surfaces as different failure modes in different runtimes; null is unambiguous.
4. **Validate semantic invariants in the decoder**, not in the consumer. Specifically:
   - `T_WITHDRAW`: `bind_hash` recompute MUST be in `decodeTWithdrawPayload` (not in a separate validator step). Otherwise a worker that uses the structural decoder without the validator step writes nullifiers for envelopes the dapp would reject — see §5.11.4 invariant 5.
   - `T_PETCH`: `cap_amount % mint_limit == 0` and `mint_limit <= cap_amount` MUST be in `decodeCPetchPayload`.
   - `T_PMINT`: `0 < amount < 2^N_BITS` and `blinding != 0` MUST be in `decodeCPmintPayload`.
5. **Use byte-exact field encoding.** Little-endian for u64 / u32 / u16 fields (e.g., `denomination`, `mint_limit`, `proof_len`); big-endian for hash digests treated as field elements (e.g., `bind_hash` SHA256 output is a 32-byte BE field). Mixed encoding silently breaks indexer parity.
6. **Use byte-exact field-element encoding for Groth16 public inputs.** The mixer's `T_WITHDRAW` validator (§5.11) feeds `[merkle_root, nullifier_hash, denomination, r_leaf, bind_hash]` into `snarkjs.groth16.verify`. Every implementation MUST serialize each public input as a **32-byte big-endian** unsigned integer, then reduce modulo the BN254 scalar field order `r = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001` before passing to the verifier. `r_leaf` published on chain is the 32-byte BE Poseidon output and MAY exceed `r` (no in-circuit normalization); the `mod r` reduction at the verifier interface is the canonical normalization point. The validator's separate secp256k1 Pedersen check reduces the same bytes `mod n_secp256k1` independently — these are two distinct reductions over the same byte string, NOT a chained operation.

### 11.2 Cross-implementation enforcement

The dapp ↔ worker decoder agreement is enforced by `tests/mixer-envelope.test.mjs`, `tests/worker-decoder.test.mjs`, and `tests/dapp-parity.test.mjs`. Any new indexer (third-party, light client, alternative implementation) SHOULD run an analog test suite against this spec's decoder shapes before serving users.

Concretely: a third indexer implementation in Rust / Go / Python MUST produce byte-identical KV state given the same Bitcoin chain history. Disagreements are bugs and SHOULD be reported as protocol-level issues.

### 11.3 Audit checklist

For each envelope opcode, indexer implementers MUST verify:

- [ ] Wire-format byte layout exactly matches the §5 spec (no extra padding, no missing fields, byte order documented per field).
- [ ] All structural invariants (lengths, sentinel values, field ranges) are enforced in the decoder, not in callers.
- [ ] Recompute-and-compare invariants (e.g., `T_WITHDRAW.bind_hash`, `T_PMINT` Pedersen consistency at the recovery layer) are documented and tested.
- [ ] Rejection produces `null` (or the language's equivalent), never a throw or a partial parse.
- [ ] No envelope-level state is exposed via decoder return values that differs between accept-and-fail-later vs reject-now paths. The decoder's verdict is final at the structural layer.

### 11.4 AMM determinism rules (T_LP_ADD, T_LP_REMOVE, T_SWAP_BATCH, T_SWAP_VAR)

Indexer implementers MUST follow these byte-for-byte to arrive at the same pool state from the same chain history.

**Rounding.** All AMM arithmetic operates on u64 base units; all divisions floor toward the pool, so rounding errors accrue as fees to existing LPs:

- `T_LP_ADD` (standard): `share_amount = floor(min(delta_A · S / R_A, delta_B · S / R_B))`.
- `T_LP_ADD` (POOL_INIT): `total_shares = isqrt(delta_A · delta_B)` via Newton-method integer square root; founder receives `total_shares − MINIMUM_LIQUIDITY` (with `MINIMUM_LIQUIDITY = 1000` base units locked to the NUMS recipient per AMM.md §"MINIMUM_LIQUIDITY burn-output construction").
- `T_LP_REMOVE`: `delta_A = floor(R_A · share_amount / S)`, `delta_B = floor(R_B · share_amount / S)`.
- `T_SWAP_BATCH` net deltas: per AMM.md §"Deterministic clearing solve" — γ-scaling carried in u128, floor toward zero (favoring the pool). Indexer recomputes byte-identically and rejects any declared `(delta_A_net, delta_B_net)` that disagrees.

**Envelope-hash binding (T_SWAP_BATCH only).** Every T_SWAP_BATCH Bitcoin transaction MUST include `vout[0]` as a 0-sat `OP_RETURN` whose 32-byte data equals `SHA256(payload)`, where `payload` is the full T_SWAP_BATCH envelope payload (opcode byte through final byte of `proof`). Indexers reject any T_SWAP_BATCH whose `vout[0]` data does not match the recomputed hash. `T_LP_ADD` and `T_LP_REMOVE` do NOT require this OP_RETURN — they are single-party ops where the LP signs their own envelope and no third-party substitution is possible.

**T_SWAP_BATCH Bitcoin tx layout.** Indexers reject deviations from the layout specified in §5.16 (`vin[0]` settler envelope, `vin[1+i]` trader inputs in `intent_id` ascending order, `vout[0]` OP_RETURN, `vout[1+i]` trader receipts at matching indices, optional aggregate tip outputs at `vout[N+1..N+2]`, optional settler change after).

**Canonical ordering.** Within a block, AMM envelopes apply in `(tx_index, vin[0] outpoint)` order. Within a T_SWAP_BATCH envelope, per-trader inputs and outputs MUST appear in `intent_id` ascending byte-order; the OP_RETURN at `vout[0]` precedes all receipts.

**Reorg safety.** AMM pool state advances at depth ≥ 3 blocks (`AMM_OP_CONFIRMATION_DEPTH = 3`, mirroring `MIXER_DEPOSIT_CONFIRMATION_DEPTH`). Reorgs deeper than 3 force the indexer to roll back to the last common ancestor and replay forward.

**Metadata blob canonicalization (launcher gate).** When validating a POOL_INIT against assets that pin a launcher pubkey, the indexer fetches each asset's metadata blob by its envelope-committed CID and treats the blob as JCS-canonical per RFC 8785. If the fetched bytes are not byte-identical to their canonical re-serialization, the indexer treats the launcher gate as **absent** (first-mover wins). The `tacit_amm_launcher` field must be a 66-character lowercase hex string with prefix `02` or `03` (33-byte compressed secp256k1 pubkey); malformed values fall back to "no gate." Reference impl: `tests/amm-jcs.mjs`.

**Three-origin asset-id resolution.** When resolving an unrecognized `asset_id`, indexers check CETCH (§5.1) → T_PETCH (§5.8) → POOL_INIT (§5.14 variant=1, via path 3 of §4.1) in order. Constant-time lookup via a reverse map keyed by `asset_id`. Cross-origin collisions are negligible (different SHA256 preimage lengths under distinct domain tags).

**Min-out fixed-point iteration** (settler subset selection, see AMM.md §"Min-out fixed-point iteration"): the settler iterates over candidate intents and the deterministic clearing solve, dropping any intent whose `min_out` is unsatisfiable at the current `P_clear`, until the set stabilises or empties. The loop strictly shrinks the set each iteration; convergence is bounded by `len(candidate_set)`.

**Cross-batch ordering.** Multiple T_SWAP_BATCH envelopes against the same pool in the same block: apply in `(tx_index, vin[0] outpoint)` order; for each subsequent batch, re-run the deterministic clearing solve against the post-earlier reserves and reject any envelope whose declared `(delta_A_net, delta_B_net)` does not match.

## 12. Acknowledgements

- Pedersen commitments, Mimblewimble kernel signatures: Maxwell, Poelstra, Jedusor.
- Bulletproofs aggregated range proof: Bünz, Bootle, Boneh, Poelstra, Wuille, Maxwell (2017).
- BIP-340 Schnorr / BIP-341 Taproot: Wuille, Nick, Towns.
- Indexer-validated meta-protocol pattern: Runes / Ordinals.
- Tornado Cash mixer design (Pedersen commitments + Groth16 + nullifier set + per-pool merkle tree): Pertsev, Storm, Semenov; Tornado.cash team (2019). Tacit's `withdraw.circom` adapts theirs.
- All primitives sourced from [`@noble/secp256k1`](https://github.com/paulmillr/noble-secp256k1) and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes).
