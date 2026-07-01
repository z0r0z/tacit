# PLAN — cBTC + cUSD, made easy (lock → mint → borrow, one guided flow)

Status: design. No code yet. Gated on the ConfidentialPool + CollateralEngine deploy (today
`pool:null` / `collateralEngine:null` — `confidentialPoolReady()` / `_crosslaneConfigured`
keep the surfaces inert). This plan turns the flagship pair into two guided flows that compose
into one story: **lock Bitcoin → mint cBTC → borrow cUSD** = "dollars against your bitcoin,"
no custodian.

## Why this is mostly wiring, not new crypto

Every primitive exists; the UI only exposes the LAST step of each flow. The work is a guided
pipeline + one genuinely new driver (the cBTC lock-tx builder).

cBTC building blocks (all present):
- `buildCbtcLockEnvelope` — the T_CBTC_LOCK (0x66) Taproot frame (cbtc-envelope.js:23).
- Taproot commit/reveal broadcast — the same infra burn-deposit / crossout-broadcast use.
- `cbtc-note-recovery.js` — key-derived blinding so the bearer note never strands.
- `mintCbtc` — the OP_CBTC_MINT action (confidential-defi-actions.js:88).
- `scanCbtc` — recovery after a localStorage wipe.
- `cbtc-redemption.js` — trustless cBTC→BTC via the cross-chain orderbook (adaptor/PTLC).
- `_bridgePipeline` (tacit.js) — an existing staged-pipeline pattern (badge + persistence) to mirror.

cUSD building blocks (all present):
- `makeConfidentialCdp` / `makeConfidentialDefiActions.openCdp/closeCdp/topupCdp` — mint/close/topup.
- Collateral scan via `ux.balance` (the note picker today).

The one missing piece: **build + broadcast the self-custody cBTC lock tx** (the surrounding
Bitcoin tx around `buildCbtcLockEnvelope`), plus the pipeline state machine that auto-advances
lock → track → mint. Both mirror existing patterns.

---

## Part A — cBTC: "Get cBTC" as one guided flow

### Today's friction
The mint form asks for a 32-byte **lock outpoint** + **locked sats**. That outpoint only
exists after the user has hand-built a lock tx and waited for `fold_cbtc_lock` to record it —
neither is in the UI. So the flagship product currently requires constructing a Bitcoin tx by
hand. Pure IA/wiring gap.

### Target UX — one amount, three automatic stages
```
Get cBTC      Lock [ 0.05 ] BTC → you receive 0.05 cBTC (1:1, redeemable, no custodian)
  ① Lock    construct + broadcast the self-custody lock (your BTC, your key; blinding key-derived)
  ② Track   poll reflection until the lock is recorded past finality      ▓▓▓░░ 3/6 confs
  ③ Mint    auto-fill the outpoint from ①; prove OP_CBTC_MINT → cBTC note lands in the wallet
```

Rules:
1. **One field (amount).** Outpoint, blinding, commitment all derived — the user never sees or
   pastes an outpoint.
2. **Auto-advance** with a persistent status badge; mirror `_bridgePipeline` (stages:
   `lock` → `tracking` → `minting` → `done` / `error`), surviving modal close.
3. **Never strands.** Wire the `cbtc-note-recovery` key-derived blinding pairing at lock time
   (already what `mintCbtc` expects via `seedDerived`), so key + chain reconstruct the note.
4. **Peg stated plainly** at the input: "Lock X BTC → get X cBTC, 1:1."
5. **Round-trip in one place.** Add "Redeem cBTC → BTC" beside mint, driving `cbtc-redemption`
   (pairs with an exiting locker on the cross-chain orderbook — already built).

### Work items
1. **`buildAndBroadcastCbtcLock({ amountSats })`** — the one new driver. Compose the lock output
   + `buildCbtcLockEnvelope` (blinding from `cbtc-note-recovery.deriveCbtcNoteBlinding`), fund via
   the existing sats-funding path, sign, broadcast via the Taproot commit/reveal infra, post the
   `/hint` (0x66) so the reflection prover folds it fast. Return `{ lockTxid, lockVout, vBtc, blinding }`.
   **Signet-test first — it moves real BTC.**
2. **cBTC pipeline** — a `_cbtcPipeline` state machine mirroring `_bridgePipeline`: after ①, poll
   the reflection/`cbtcLocks` set until the lock is recorded past finality, then call the existing
   `mintCbtc({ outpoint, vBtc, blinding })` with the values from ① (no user paste).
3. **UI** — replace the outpoint/sats form with the single amount field + staged progress; add the
   redeem action.

---

## Part B — cUSD: "Borrow dollars" (inverse framing)

### Today's friction
The Borrow form makes the user hand-pick collateral notes (checkboxes) and type a debt amount,
then reason about collateralization themselves — backwards from intent.

### Target UX — enter the loan, not the collateral
```
Borrow cUSD   I want [ 100 ] cUSD           Collateral: auto-selected
  Health ▓▓▓▓▓▓░░  safe            Liquidates if collateral falls to $X
  [ Borrow ]
```

Rules:
1. **Enter cUSD wanted**; the UI auto-selects sufficient collateral notes (reuse the coin-select
   already in the send/otc tabs) and shows the resulting **health + liquidation price**.
2. **Safety slider** — pick a target health (conservative ↔ aggressive); it sets how much
   collateral to lock for the requested debt. One click to `openCdp`.
3. **Plain-language risk** — "you keep your collateral unless its value falls to $X, where the
   position can be liquidated." No raw ratios in the default view.
4. Close/topup stay as they are, surfaced on the position card.

---

## Part C — the composition: "dollars against your bitcoin"

The two flows chain into the flagship pitch. Once Part A makes cBTC a one-amount flow and cBTC
is accepted collateral, offer a single path:

```
Borrow dollars against Bitcoin
  Lock [ 0.05 ] BTC → cBTC → borrow up to [ ~$X ] cUSD     (safety: conservative)
  ① lock  ② track  ③ mint cBTC  ④ openCdp(cBTC → cUSD)     → cUSD note in wallet
```
Same pipeline as Part A with a fourth stage that opens the CDP against the freshly-minted cBTC.
Presented as ONE action ("borrow dollars against your bitcoin"); internally it's the two guided
flows composed. Advanced users can still do lock-only (hold cBTC) or borrow-against-existing-notes.

---

## Guardrails / gating
- No new crypto. Every step calls an existing builder; the lock-tx driver is an adapter around
  `buildCbtcLockEnvelope` + existing sats-funding/broadcast.
- **Driver-first, signet-gated:** `buildAndBroadcastCbtcLock` moves real BTC — build + prove it on
  signet (lock recorded by reflection, mint opens to exactly the lock sats, recovery re-derives the
  blinding) BEFORE wiring it into a one-click flow.
- Ships behind `confidentialPoolReady()` / the deploy gate; nothing surfaces until pool +
  CollateralEngine are set. Same config-only flip as the cross-lane checklist
  (dapp/confidential-deployments.js).

## Appendix — reference wiring for `broadcastCbtcLockTx` (the injected tx seam)

`dapp/cbtc-lock.js` composes the lock but injects `broadcastCbtcLockTx` — the commit→reveal that
creates the self-custody lock output carrying the 0x66 envelope. It is the **bridge-deposit template**
(tacit.js:11006–11058) with three precise differences. Adapt in tacit.js (where the tx infra lives):

```
// Inputs: { fundingPrevout, vBtc, lockVout=0, lockSpk, envelopeHex } → { lockTxid, lockVout }
const feeRate   = await getFeeRate('priority');
const payload   = hexToBytes(envelopeHex);                    // the 197-byte 0x66 frame from buildCbtcLockEnvelope
const envScript = encodeEnvelopeScript(wallet.xonly(), payload);
const leaf      = tapLeafHash(envScript);
const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, leaf);
const p2trSpk   = p2trScript(Q_xonly);
const cb        = controlBlock(TAP_NUMS, parity);

const revealVb  = Math.ceil((envScript.length + 200) / 4) + 31 + 11;
const revealFee = feeFor(revealVb, feeRate);
// DIFF 1: the commit P2TR must fund the LOCK VALUE (vBtc) + the reveal fee, not just DUST.
const commitP2trValue = Number(vBtc) + revealFee;

// DIFF 2: vin[0] MUST be `fundingPrevout` — it is the blinding anchor (deriveCbtcNoteBlinding used it).
//   Coin-select so picked[0] === fundingPrevout; add more inputs only to cover commitP2trValue + commitFee.
const picked = selectCommitInputsAnchoredAt(fundingPrevout, commitP2trValue /* + fees */);
const wpkhSpk = p2wpkhScript(wallet.pub);
const change  = sum(picked) - commitP2trValue - commitFee(picked, feeRate);
const commitTx = { version:2, locktime:0,
  inputs: picked.map(u => ({ txid:u.txid, vout:u.vout, sequence:0xfffffffd, witness:[] })),
  outputs: change >= DUST ? [{ value:commitP2trValue, script:p2trSpk }, { value:change, script:wpkhSpk }]
                          : [{ value:commitP2trValue, script:p2trSpk }] };
signCommitInputs(commitTx, picked, wpkhSpk);
await broadcast(bytesToHex(serializeTx(commitTx)));
const commitTxid_ = txid(commitTx);

// DIFF 3: the reveal output at lockVout is the SELF-CUSTODY LOCK (vBtc sats to lockSpk), not a dust marker.
const revealTx = { version:2, locktime:0,
  inputs:  [{ txid:commitTxid_, vout:0, sequence:0xfffffffd, witness:[] }],
  outputs: [{ value: Number(vBtc), script: lockSpk }] };            // lockVout = 0
const prevouts = [{ value: commitP2trValue, script: p2trSpk }];
revealTx.inputs[0].witness = signTaprootScriptPathInput(revealTx, prevouts, envScript, cb);
await broadcastWithRetry(bytesToHex(serializeTx(revealTx)));
return { lockTxid: txid(revealTx), lockVout };
```

- `lockSpk` = the user's OWN address (`p2wpkhScript(wallet.pub)` or a P2TR) — self-custody; the BTC never
  leaves the user's key. The peg is enforced by the reflection rug-scan (retire the lock's backing if the
  locker later spends it), NOT by a third-party escrow. This is why it's oracle-free 1:1.
- The anchor invariant (DIFF 2) is the whole ballgame for recovery: `scanCbtc` tries the user's spent
  prevouts as candidate anchors, so as long as `fundingPrevout` is a real spent prevout of the commit, the
  note recovers — but the lock COMMITS to the blinding derived from exactly that prevout, so vin[0] must be it.
- Fee headroom: size the commit to also cover the reveal fee (`commitP2trValue` already includes it) plus the
  commit's own fee; reject if funding can't cover `vBtc + both fees + DUST`.

## Sequence
1. `buildAndBroadcastCbtcLock` adapter + signet tests (lock → reflection-recorded → mint → recover).
2. cBTC guided pipeline (`_cbtcPipeline`) + single-amount UI; add redeem.
3. cUSD "borrow dollars" inverse UI (auto-collateral + health/liquidation + safety slider).
4. Compose Part C (lock → cBTC → cUSD as one action).
5. Signet dry-run of the full chain; then it's deploy-gated only.
</content>
