# DESIGN — Trustless onboarding of existing confidential assets (TAC both-ways)

Bridge existing confidential **fixed-supply** Tacit assets (TAC) Bitcoin→ETH and back, **trustlessly** —
no operator-seeded genesis. ETH-origin value (cETH/tETH) and the reverse already work; this fills the
Bitcoin-native onboarding gap that blocks "TAC both ways."

## Core invariant
For a `bridge_mint` to be backed (not inflation), the reflection must verify the bridged Bitcoin note is a
**real, unspent note of that asset's actual supply** — not a commitment an attacker fabricated to any value.
Opening proves `C → v`; it does **not** prove `C` is real. So the reflection must **track the asset's supply**.

## Bridgeability is a CRITERION, not an allowlist  (← resolves the allowlist)
**cBTC.zk and TAC are DISTINCT concepts — keep them separate.** cBTC.zk's `cbtc_lock` is the real-BTC
self-custody peg (rug-tolerant, buffer-backed, oracle-free); its hardcoded asset pin is **correct for that
one peg, not a hack — leave it untouched.** TAC onboarding is a **separate new fold** whose admission is a
**criterion, not a list**: any asset whose own etch declares **fixed-supply** (`mint_authority == NONE`) and
whose burn proves realness is bridgeable — derived per-asset from its etch, trustless, no list / admin /
per-deploy. (Mintable assets, `mint_authority != NONE`, use `cmint`-deposit, §6.1 — also separate.)
So "allowlist" was an artifact of trying to *generalize* `cbtc_lock`; once the concepts are separate,
cBTC.zk keeps its correct pin and TAC's fold is criterion-based. Bridging a new fixed-supply asset = its
etch + burn verify, never a config change.

## Supply tracking: etch-anchored (the supply is FIXED at the etch — no full-history scan)
**Key efficiency (fixed-supply only):** the entire supply is minted ONCE at the **etch** — a single block.
So the reflection does NOT full-scan the ~5,397 blocks since; it **anchors the supply at the etch block**
(read the initial mint commitment `C_0` + total `S`, confirmed via the relay/header-merkle), optionally
cross-checked against the etch's **cid-committed IPFS metadata** (content-addressed → trustless: the guest
verifies the *witnessed* JSON's hash == the on-chain `cid`). This collapses the bootstrap from ~days of
full-scan to **one block**.

Per-bridge **realness** (that a SPECIFIC burned note descends from `C_0`, not a commitment fabricated to any
value) is then proven **per-bridge, holder-borne** — bounded by the note, not the whole chain history:
- **Unmixed note:** a provenance proof — the cxfer DAG from the note back to `C_0` (each cxfer conserving +
  linked). Bounded by the note's own trading depth.
- **Mixed note** (through the Bitcoin mixer, which deliberately severs provenance): the mixer's existing
  **deposit-backed withdrawal proof** *is* the realness (a withdrawal is backed by a real deposit), with the
  reflection capping total bridged ≤ `S` (the etch cap). This is the mixer-reuse path — and it grows the
  anon set.

Net: **no ~days full-scan** — a one-block supply anchor + bounded per-bridge realness. Only if a fully
general (non-fixed-supply, untraceable) case ever needs it does the recursive-chunked full-scan return.

## Onboarding: burn-and-mint (rug-proof, arbitrary amounts)
- **Forward:** burn `v` TAC on Bitcoin (consume a supply-member note) → `bridge_mint` the confidential note
  on ETH. The burn proves: membership in the reflected supply (real) + opening (value `v`) + BP+ range.
  **Rug-proof** (consumed, nothing retained to spend); **arbitrary `v`** (opening sigma, not a denomination).
- **Reverse:** burn the ETH note → `crossout_mint` re-mints `v` TAC on Bitcoin (bridge-authorized, no TAC
  mint_authority needed; preserves the fixed global supply).
- **Privacy:** the burn `v` is public (required for backed-not-phantom — the REFLECT-1 line); owner hidden
  (owner-free leaf + memo); downstream privacy via in-pool `cxfer` or mixer routing (which also grows the
  anon set).

## Soundness
- **No inflation:** burned note ∈ reflected supply (real) + opening (value) + range; the supply itself is
  trustlessly bootstrapped (no seed to trust).
- **Rug-proof:** burn, not a retained lock (so no buffer / no rug-detection / no lock lifecycle).
- **Conservation:** burn on Bitcoin (−v) = mint on ETH (+v); reverse symmetric. Global supply constant.

## Phase 3 detail — per-bridge realness (the inflation surface, sound WITHOUT a full scan)
The fold (`fold_asset_burn_deposit`, a NEW sibling of `fold_cbtc_lock`/`fold_crossout` — touches neither)
admits a burned TAC note → a `bridge_mint` authorization ONLY under ALL of:

1. **Realness — confirmed provenance to `C_0`.** Witness = the note's provenance DAG: the conserving CXFERs
   from the burned commitment back to etch-initial notes (members of the etch `C_0` output set). For EACH
   CXFER the fold checks: (a) it is a CONFIRMED Bitcoin tx (header+merkle to the relay anchor — the scan's
   inclusion path); (b) it conserves per-asset, asset preserved (`verify_cxfer_conservation` + the asset
   gate — the REFLECT-1 / asset-preservation lines); (c) it is linked (each non-leaf input = an output of
   another DAG CXFER; each leaf input ∈ `C_0` via `verify_etch_anchor`); (d) the burned commitment is an
   output of the sink CXFER. Any failure folds NOTHING (skip-not-panic).
2. **No double-bridge / no double-use — shared nullifier set.** The burned note's ν goes into the
   reflection's nullifier set (the SAME set as in-pool spends → cross-lane consistency). A ν already present
   (re-bridge, or an in-pool spend of the same note) folds nothing.
3. **Bound by `S`** (defence-in-depth): a cumulative-bridged accumulator caps total bridged ≤ the etch
   supply `S` from `verify_etch_anchor`; over-cap folds nothing. Even a provenance bug can't exceed real supply.

Plus the per-note **opening + BP+ range** (the `bridge_mint` value = the opened `v`), exactly as the existing folds.

**Why no full history scan is needed (your efficiency insight, completed):** the fold only checks that each
provided CXFER is *confirmed on-chain* — it does NOT need to have scanned all of the asset's history.
**Bitcoin's own consensus already prevents a leaf note from being spent twice**, so two conflicting DAGs
(e.g. `A→B+C` vs `A→D`) cannot both be confirmed; only the real one passes (a)+(c). Legitimate sibling
bridges (B and C from the same real `A→B+C`) are each fine (distinct ν, conservation holds). Double-bridging
the same descendant is caught by (2). So per-bridge confirmed-provenance + shared-ν + conservation is sound
with the supply read ONCE from the etch — no etch-to-tip scan, no operator seed.

**Mixed notes** (mixer deliberately severs provenance): realness = the mixer's existing deposit-backed
withdrawal proof, under the same (2)+(3) guards (and it grows the anon set).

**Witness** (`dapp/`/`worker`, holder-built): `{ burned {C,v,r}, provenance:[{cxfer_tx, inclusion, input_links[],
out_index}], leaves:[etch_anchor_witness], }` — or `{ mixer_withdrawal_proof }` for the mixed path.

**Adversarial KATs (each MUST fold nothing):** fabricated commitment (no DAG); non-descendant leaf (∉ `C_0`);
non-conserving CXFER mid-DAG (REFLECT-1); asset-relabel in the DAG; double-bridge (ν reused); burn-then-pool-
spend (shared-ν); over-`S`; out-of-range `v`; unconfirmed/forged-inclusion CXFER.

**Integration + re-prove (coordination, NOT a blind edit):** the fold fn lands additively in cxfer-core; the
scan DISPATCH is in `reflect.rs` (parallel Mode B session's active file → coordinate / let its owner wire it);
the JS mirror lands in `dapp/`/`worker` (re-check mtime). Reflection-guest change → new `BITCOIN_RELAY_VKEY`
→ fold into the #11 mainnet re-anchor re-prove (one coordinated re-prove; settle vkey unchanged).

**Build status (2026-06-14) — realness CORE done, integration remaining.** Implemented + adversarially
tested + committed (additive, no vkey change yet): the etch anchor `bitcoin::verify_etch_anchor` (73f269e),
the per-tx inclusion primitive `bitcoin::verify_merkle_path` (500b42d), and the pure DAG-linkage verifier
`burn_deposit::verify_provenance_dag` + 9 KATs (c2dc6c7) — the inflation surface (value-swap seam, dangling
non-`C_0` leaf, in-DAG double-spend, unproduced/consumed burned note, wrong-`C_0`) is covered. REMAINING
(integration — coordinate with the reflect.rs owner, then re-prove): (a) `fold_asset_burn_deposit` composing
those over `verify_cxfer_conservation` + recording ν via `fold_spent`/`fold_burn`, plus the `S`-cap field on
`ScanReflection`; (b) the burn-deposit envelope + provenance witness types (parse each CXFER tx → the
`VerifiedCxfer` shape); (c) the reflect.rs scan dispatch + the confirmed-block-root binding to the reflection's
header sync; (d) the JS worker mirror; (e) re-prove → new `BITCOIN_RELAY_VKEY` (into #11).

## Findings / preconditions (impl phase 1)
- **CETCH layout discrepancy (resolve first):** cxfer-core `parse_etch_meta` reads `cid(32)` right after
  `decimals`, but the live worker `decodeCEtchPayload` reads `commitment(33) ‖ amount_ct(8) ‖ rp_len ‖
  rangeproof ‖ mint_authority(32) ‖ img_len ‖ image_uri` there (no cid). The **worker is the live truth**;
  `parse_cetch` follows it. Flag whether `parse_etch_meta` is T_PETCH(0x27)-only or has a latent CETCH(0x21)
  gap (it would misread the supply commitment as a cid).
- **Trustless supply source = on-chain `C_0`** (the CETCH `commitment(33)`), confirmed via header+merkle —
  NOT an IPFS JSON (CETCH carries `image_uri`, a URI, not a content-addressed cid). Better: fully on-chain.

## Phases (implementation)
1. **`parse_cetch` + criterion** — extract `C_0` + `mint_authority` + decimals per the canonical (worker)
   CETCH layout; the fixed-supply criterion is `mint_authority == NONE`. **`cbtc_lock` untouched.** Resolves the allowlist via the criterion.
2. **Etch supply anchor** — anchor the supply at the etch block via the on-chain `C_0`, confirmed by header
   + merkle to the relay anchor. One block. (Replaces the ~days full-scan bootstrap.)
3. **burn-deposit fold** — cxfer-core + reflect.rs: burn + per-bridge realness (provenance-to-`C_0` for unmixed / mixer-deposit-backed for mixed) + opening + range + nullifier; JS worker mirror; adversarial KATs (fabricated commitment, non-descendant note, wrong value, replay, out-of-range, double-burn, over-cap → each folds nothing).
4. **Witness assembly** — holder/worker builds the note's provenance DAG to `C_0` (or the mixer proof) + the etch-anchor witness.
5. **Re-prove → new `BITCOIN_RELAY_VKEY`** (fold into the mainnet re-anchor, task #11) + redeploy.
6. **Live e2e** — TAC Bitcoin→ETH→back round-trip; verify supply conservation + asset-id preservation.

## Timeline
~1 week engineering (the etch-anchor read + the burn-deposit/provenance fold + the mirror/KATs) + the
mechanical re-prove. **No multi-day bootstrap** — the etch-anchor is one block, and per-bridge realness is a
runtime, holder-borne proof bounded by the note (not the asset's whole history). The fold reuses existing
blocks (opening sigma, BP+ range, leaf, header/merkle, the Mode B recursion).
