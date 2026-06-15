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

**Build status (2026-06-14) — realness VERIFICATION complete, recording + dispatch remaining.** Implemented +
adversarially tested + committed (additive, no vkey change yet):
- `bitcoin::verify_etch_anchor` — the etch supply anchor (73f269e)
- `bitcoin::verify_merkle_path` — per-tx PoW inclusion, scan-free (500b42d)
- `burn_deposit::verify_provenance_dag` + 9 KATs — the pure DAG-linkage check, the inflation surface:
  value-swap seam, dangling non-`C_0` leaf, in-DAG double-spend, unproduced/consumed burned note, wrong-`C_0`
  (c2dc6c7)
- `burn_deposit::{ProvenanceWitness, verify_provenance}` — the FULL realness composition: per-CXFER inclusion
  + conservation (value & asset, bound to the one asset) → linkage. Success path unit-tested with REAL
  conserving crypto (the `conserving_m1` fixture as a depth-1 distribution from `C_0`); failures cover
  unconfirmed inclusion, non-conserving kernel, fabricated `C_0` (afa9582). 87/87 cxfer-core green.
- `dapp/burn-deposit-provenance.js` — the JS liveness mirror (`verifyMerklePath`/`verifyProvenanceDag`/
  `verifyProvenance`); 11 tests mirror the Rust verdicts one-for-one (0dddc6a)

So the security-critical realness — Rust authority + JS liveness — is DONE and isolated. REMAINING (integration — coordinate with the
reflect.rs owner, then re-prove): (a) the RECORDING — record ν via `fold_spent`/`fold_burn` + the `S`-cap
field on `ScanReflection` (needs the IMT witnesses the scan loop builds); (b) the on-chain burn-deposit op
handling (likely reuse the 0x2B burn envelope — a 0x2B spend of a note NOT in the live set dispatches to
`verify_provenance` instead of the reflected-note path); (c) the reflect.rs scan dispatch + binding
`confirmed_block_root` to the reflection's header sync; (d) the worker WIRING (call the JS mirror in the
reflection assembler/indexer); (e) re-prove → new `BITCOIN_RELAY_VKEY` (into #11).

## Phase 3 dispatch SPEC — the reflect.rs integration (a re-prove item, box-validated not unit-tested)
The reflection guest is validated by box fixtures + on-chain `*ProofReal`, NOT `cargo test`; this dispatch is
implemented and validated IN the mainnet re-prove (extend the reflection round-trip fixture with a
burn-deposit case first). It rides the same `BITCOIN_RELAY_VKEY` rotation as the mainnet re-anchor (#11).

**Trigger.** A tx carries a bridge-burn envelope (0x2B) AND `scan_tx_spends` found NO live-set spend
(`spends.is_empty()`) — a pre-existing, never-reflected note (the near-tip reflection's live set is empty at
launch, so ALL existing TAC bridges hit this path). The reflected-note bridge-out (`spends.len()==1 &&
spends[0].nu==env_nu`) stays the existing path.

**Witness-sync discipline (footgun #1).** Read ALL burn-deposit witnesses UNCONDITIONALLY in this branch (so
the io stream stays in sync with the assembler), then `fold_spent`/`fold_burn` ONLY if every check passes —
skip-not-panic, exactly like the cxfer/crossout/cbtc folds. A griefed/invalid burn-deposit folds nothing.

**Witness (fixed read order):** `etch_tx` (CETCH) + (etch merkle path, index); `prov_headers` (the pre-anchor
header chain from the etch block to THIS batch's anchor); `num_cxfers` × `ProvenanceWitness` fields
(outpoints, compressed in/out commitments, vouts, range proof, kernel sig, merkle path/index,
`confirmed_block_root`); `burned_commitment` (compressed); the spent-set + burn-set IMT insert witnesses.

**Checks (all required; skip on any miss):**
1. **Canonical pre-anchor chain (footgun #2):** `verify_header_chain(prov_headers)` succeeds AND its tip ==
   `prev_hash` (this batch's relay-pinned anchor). Binds the witnessed history to canonical Bitcoin — a
   fabricated chain can't reach the relay anchor. (Cost: ~one header per block since the etch, holder-borne;
   a committed canonical-hash accumulator to amortize it is a follow-up.)
2. **Etch + criterion:** `verify_etch_anchor(etch_tx, asset)` → `(C_0, mint_authority, _)`;
   `is_fixed_supply(mint_authority)`; the etch's merkle path resolves to a `prov_headers` block root.
   `c0_outpoint = outpoint_key(etch_txid, 0)`, `c0_ch = commitment_hash_compressed(C_0)`.
3. **Cxfer blocks canonical:** every `ProvenanceWitness.confirmed_block_root` ∈ `{extract_merkle_root(h)}`
   over `prov_headers`.
4. **Burned-note ↔ ν binding (footgun #3):** `burned_outpoint` = the burn tx's spent input (`extract_inputs`);
   `burned_ch = commitment_hash_compressed(burned_commitment)`; `env_nu == nullifier(decompress(burned_commitment))`
   (the envelope ν is the note's REAL ν → no second bridge under a different ν).
5. `burn_deposit::verify_provenance(asset, c0_outpoint, c0_ch, burned_outpoint, burned_ch, &prov)` == Ok.

**Record (only if all pass):** `fold_spent(env_nu, …)` (nullify in the shared set → no double-use) +
`fold_burn(env_nu → env_dest, …)` (authorize the EVM `bridge_mint` to exactly `env_dest`). The JS assembler
mirror (`dapp/burn-deposit-provenance.js`) gates on the SAME predicate so the witness stream stays in sync.

**Imports to add to reflect.rs:** `burn_deposit`, `commitment_hash_compressed`, `decompress`, `nullifier`,
`outpoint_key`, and `bitcoin::{verify_etch_anchor, verify_merkle_path, is_fixed_supply, extract_inputs}`.

**S-cap (deferred, defence-in-depth):** a per-asset cumulative-bridged accumulator on `ScanReflection`
(digest-bound) capping total ≤ `S`; needs the burned value via an opening sigma. Realness + shared-ν are the
primary guards; the cap is a backstop — follow-up.

## Fixture generator — the remaining build before the GPU re-prove
The dispatch is integrated + compile-verified; both reflect harnesses serialize the burn-deposit witness
(16f0e53). What's left is a generator producing a `reflection_input.json` with a burn-deposit tx, then a
native execute (`exec-reflect-fixture.rs`, CPU — no GPU) to validate the dispatch folds it. Reuses
`gen-reflection-input.mjs` (headers/IMT) + the dapp confidential crypto (conserving cxfers + `C_0`).

1. **Synthetic PoW (one continuous chain).** Low-difficulty (regtest `bits` 0x207fffff) 80-byte headers,
   each linking (prev == predecessor's double-SHA) with the correct merkle root, nonce mined so
   `double_sha256(header) <= target`. The PROV portion (etch block .. block H-1) is `provHeaders`; the SCAN
   portion (block H .. tip) is the batch `headers`. `prov_tip == scan headers[0].prev == prev_hash` (the
   dispatch's canonical-chain check) — they're contiguous.
2. **TAC etch (CETCH) in the first prov block.** A 0x21 tx committing `C_0` at the canonical layout; the
   supply note = vout 0. `asset_id = sha256(etch_txid ‖ vout0)`. Witness `etchSiblings`/`etchIndex` to its
   block's merkle root.
3. **Conserving cxfer DAG (in prov blocks).** `C_0 → … → burned note`, each a real conserving cxfer
   (BIP-340 kernel + BP+ range, like the `conserving_m1` fixture) via the dapp prover; per-cxfer merkle path
   + `confirmedBlockRoot` (its prov block's root).
4. **Burn tx (0x2B) in a SCAN block.** Spends the burned note's outpoint; envelope declares
   `env_nu == nullifier(burned coords)` + `env_dest`. (Inclusion is the scan's full-scan, not a path.)
5. **Witnesses.** `burnedCx`/`burnedCy`; the spent insert (ν into the spent IMT) + burn insert (ν → dest)
   via the dapp IMT machinery.
6. **Prior = empty live set** (near-tip anchor) → the burn's note is not in live → the burn-deposit branch.

Validate: native execute → the PV's `bitcoinBurnRoot` reflects the folded burn. Negative variants
(fabricated cxfer / wrong `C_0` / unconfirmed block) → folds NOTHING (skip-not-panic). Then the GPU re-prove
(`exec-reflect-prove.rs`) + on-chain `*ProofReal`, folded into the #11 mainnet re-prove.

## Mintable assets — cmint-deposit (§6.1), so the bridge covers ALL Tacit-native assets
Fixed-supply assets bridge via the burn-deposit (provenance to `C_0`). **Mintable** assets (etch
`mint_authority != 0`) bridge via **cmint-deposit**: their supply is `C_0` PLUS the issuer-authorized mints,
so a real note descends from `C_0` **or** an authorized cmint. The criterion (the etch's `mint_authority`)
routes between them; both are trustless (no list).

**Realness leaf set.** `verify_provenance_leaves` admits `valid_leaves = {C_0} ∪ {authorized cmint outputs}`
— `C_0` via `verify_etch_anchor`, each cmint via `verify_cmint_authorized`. (Foundation DONE, b409f27.)

**`verify_cmint_authorized` (the crux — the mintable inflation surface).** A `T_MINT` (0x24) is a valid supply
leaf iff: (1) CONFIRMED (header+merkle, like a provenance cxfer); (2) asset-bound — `parse_cmint` → its
`assetId == the bridged asset`, and `verify_etch_anchor(etch)` shows `mint_authority` (x-only) `!= 0`
(mintable); (3) issuer-signed — BIP-340 `verify(mint_authority, mint_msg, issuer_sig)`; (4) range — BP+ over
the minted commitment ∈ [0, 2⁶⁴); (5) **anti-re-wrap (ESSENTIAL)** — `mint_msg` binds the COMMIT ANCHOR (the
commit-tx's first input outpoint), read from the witnessed commit tx (`reveal.vin[0] == commit_txid`,
`commit.vin[0] == commit_anchor`). The minted note (cmint output, vout 0) is then the leaf.

**Why anti-re-wrap is required (soundness):** without binding the commit anchor, an observer re-broadcasts the
issuer's mint envelope in a fresh commit/reveal → a new confirmed tx → a new minted-note outpoint → admitted
AGAIN → the issuer's single authorization inflates supply N times. The commit-anchor ties the signature to
exactly one tx. (This is the one place mintable is genuinely harder than fixed-supply.)

**Dispatch (reflect.rs).** For a 0x2B burn of a non-live note: build `valid_leaves` = `C_0`
(`verify_etch_anchor`) + `[verify_cmint_authorized(cmint) for each cmint in the witness]` — fixed-supply
yields `[C_0]` (no cmints), mintable yields `C_0 ∪ cmints` — then `verify_provenance_leaves`. So the current
`is_fixed_supply` gate becomes a branch: both kinds bridge, with the right leaf set.

**Assembler/tracer.** The tracer's backward walk stops at `C_0` OR an authorized cmint (a leaf); the assembler
includes the cmints (the `T_MINT` tx + the commit tx + inclusion) in the witness. The dapp also needs a
`T_MINT` signer so a mintable asset can actually mint (then bridge).

**Canonical mint message = the live dapp's `computeMintMsg` (coherence, not a new message).** The dapp
already has a complete, security-reviewed Bitcoin-side confidential mint — `buildAndBroadcastCMint` (the
signer, UI-wired) + the mint validator (re-derives the issuer message + verifies it against the etch's
`mintAuthority`). Its canonical signed message is
`sha256("tacit-mint-v1" ‖ asset ‖ anchor_txid(internal) ‖ anchor_vout_LE ‖ commitment ‖ amount_ct)`
(`anchor = commit_tx.vin[0]`). `verify_cmint_authorized` binds the SAME message byte-for-byte, so a mint the
live dapp accepts as supply is exactly the one the bridge admits as a supply leaf — no second signer, existing
mints become bridgeable. (`anchor_txid` from the guest's `extract_inputs` is the serialized prevout = internal
order = the dapp's `reverseBytes(display_txid)`.)

**Build status (2026-06-15) — cmint-deposit + value binding + worker wiring DONE through native-exec; remaining = re-prove.**
- `parse_cmint` + `verify_cmint_authorized` (BIP-340 issuer sig + BP+ range + commit-anchor anti-re-wrap),
  message aligned to the dapp `computeMintMsg` (binds `amount_ct`); KATs — 90/90 cxfer-core green (7fb1f07 +
  this alignment).
- reflect.rs dispatch building `valid_leaves = C_0 ∪ authorized cmints` via `verify_cmint_authorized`, each
  cmint reveal confirmed in the canonical pre-anchor chain (4227a5d). The `is_fixed_supply` gate is gone — the
  criterion self-enforces (a fixed-supply asset has `mint_authority == 0` → every cmint rejected → leaves =
  `[C_0]`).
- **Native-exec validated in-zkVM** (a locally-built reflection ELF over the burn-deposit fixture): a
  real cmint-rooted note **BURN FOLDED** (the burned note descends from the issuer-authorized cmint leaf), the
  fixed-supply baseline still folds (`n_cmints = 0`), and a tampered issuer sig **folds nothing**
  (skip-not-panic). Generator: `MINTABLE=1` / `CMINT_TAMPER=1` modes of `gen-reflection-burn-deposit.mjs`.
- JS mirror `verifyProvenanceLeaves` + `verifyCmintAuthorized` (`dapp/burn-deposit-provenance.js`) + KATs
  (incl. the commit-anchor binding); tracer multi-leaf path (`burn-deposit-tracer.js` stops at `C_0 ∪ cmint`
  outpoints) + KATs; the assembler already carries the `cmints` witness (4227a5d).
- The dapp `T_MINT` signer already exists (`buildAndBroadcastCMint`) and is now coherent with the bridge.
- **Value binding (the inflation crux, 04151a4):** `fold_note_append` onboards the proven-real burned note
  into the pool tree (append-only, never live) after `verify_provenance_leaves` + `fold_spent` succeed, so the
  Ethereum `OP_BRIDGE_MINT` binds `v_mint == v_burn` by membership + kernel — a burn-deposit mint becomes
  identical to a reflected bridge-out. Without this the recording was `ν → env_dest` with `env_dest`'s value
  unconstrained (a real v=1 burn could authorize a v=10⁹ mint); the existing mint also could not consume a
  burn-deposit note (no pool membership). `fold_spent` is now skip-not-panic (a re-presented ν folds nothing
  instead of wedging the prover). Applies identically to fixed-supply and mintable (one shared dispatch).
- **Worker wiring:** the canonical scan (`confidential-pool.js::foldBurnDepositTx`) folds a 0x2B burn of a
  pre-existing note iff the JS mirror admits it (`fold_spent → fold_note_append → fold_burn`), else emits a
  zero witness so the prover stream stays in sync; the scan indexer (`makeScanReflectionIndexer`, a
  `burnDepositKit` + `assembleBlocks({ burnDeposits })`) builds `valid_leaves = C_0 ∪ authorized cmints`,
  runs the mirror, and assembles the static witness via `buildBurnDepositStatic`. Tested:
  `tests/confidential-burn-deposit-wiring.mjs` (valid folds / invalid skips / cmint leaf admitted / snapshot
  round-trip). The worker injects the kit (its Bitcoin parsers + `parseEtchAnchor`); the live Bitcoin
  provenance tracing remains the worker's data-plane job.

REMAINING: the re-prove (rotates `BITCOIN_RELAY_VKEY`, folds into #11) + the worker's live data-plane
(fetching the etch/cmint/headers + the cxfer-by-output graph the tracer walks).

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
