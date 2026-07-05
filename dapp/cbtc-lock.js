// cBTC self-custody lock driver — the one new piece for the "Get cBTC" guided flow (ops/PLAN-cbtc-cusd-easy.md
// Part A, item 1). Builds + broadcasts the Model-B lock tx whose reflection fold (fold_cbtc_lock) records a
// self-custody Bitcoin lock that OP_CBTC_MINT later opens 1:1 into a bearer cBTC.zk note.
//
// SKETCH / DE-RISK SCAFFOLD — dependency-injected like crossout-broadcast.js so it is unit-testable and keeps
// the wallet/tx specifics in tacit.js. NOT yet wired into the UI and NOT broadcasting anything. This MOVES REAL
// BTC once wired, so it is gated on the pool deploy AND must be signet-proven first (checklist at the bottom).
//
// The composition (all real APIs):
//   funding prevout  → chosen FIRST (the blinding is anchored to it — see below)
//   blinding         → deriveCbtcNoteBlinding(priv, anchor(fundingPrevout))   [cbtc-note-recovery.js]
//   (Cx,Cy)          → commitXY(vBtc, blinding)                                [pool.commitXY]
//   envelope (0x66)  → buildCbtcLockEnvelope({asset, lockVout, cx, cy})        [cbtc-envelope.js]
//   lock tx          → commit→reveal; the reveal creates the self-custody lock OUTPUT at lockVout carrying the
//                      envelope in its witness (injected broadcastCbtcLockTx — the existing Taproot infra)
//   /hint (0x66)     → fast-track the reflection fold
//
// CRITICAL ORDERING (why funding is selected before the blinding): the note blinding is
// deriveCbtcNoteBlinding(priv, anchor = the COMMIT tx's vin[0] prevout). The recovery scan (scanCbtc) re-derives
// it from the user's spent prevouts, so the lock MUST commit exactly that derivation. Therefore: pick the funding
// UTXO → derive the blinding from it → build the envelope (Cx,Cy) → only then construct the commit/reveal. Get
// this order wrong and the note is UNRECOVERABLE (stranded BTC).

import { buildCbtcLockEnvelope } from './cbtc-envelope.js';

export function makeCbtcLock(deps) {
  const {
    privkey,                 // Uint8Array(32) — the wallet's Bitcoin spend key (for the recoverable blinding)
    asset,                   // CBTC_ZK_ASSET_ID (0x62a20d98… — the constant localAssetOf key)
    commitXY,                // (vBtc, blinding) → { cx, cy }   [pool.commitXY]
    deriveCbtcNoteBlinding,  // ({ privkey, anchorOutpoint, outputIndex }) → scalar   [cbtc-note-recovery]
    anchorBytes,             // (txidHexDisplay, vout) → Uint8Array(36)                [cbtc-note-recovery]
    selectLockFunding,       // async ({ amountSats }) → { fundingPrevout:{txid,vout}, ... }  (tacit.js coin-select)
    ownLockScriptPubKey,     // () → scriptPubKey for the self-custody lock output (user's own P2TR)
    broadcastCbtcLockTx,     // async ({ fundingPrevout, vBtc, lockVout, lockSpk, envelopeHex, waitOpts })
                             //   → { lockTxid, lockVout }   (commit/reveal-with-lock-output; existing infra)
    postHint,                // async (txid, vout) → any     (worker /hint 0x66 fast-track; optional)
    lockVout = 1,            // which output index of the reveal carries the locked sats (must be != 0; the reflection fold skips a vout-0 lock)
  } = deps;

  if (!(privkey instanceof Uint8Array) || privkey.length !== 32) throw new Error('cbtc-lock: privkey must be 32 bytes');
  if (typeof commitXY !== 'function') throw new Error('cbtc-lock: inject commitXY');
  if (typeof broadcastCbtcLockTx !== 'function') throw new Error('cbtc-lock: inject broadcastCbtcLockTx');

  // Build + broadcast a self-custody cBTC lock of `amountSats`. Returns everything the mint needs:
  //   { lockTxid, lockVout, vBtc, blinding, anchor } — feed lockTxid/lockVout + vBtc + blinding to mintCbtc.
  async function buildAndBroadcastCbtcLock({ amountSats, feePadSats = 0n, waitOpts } = {}) {
    const vBtc = BigInt(amountSats);
    if (vBtc <= 0n) throw new Error('cbtc-lock: amount must be positive');

    // 1. Select funding FIRST — the blinding is anchored to the commit tx's vin[0] prevout.
    const sel = await selectLockFunding({ amountSats: vBtc + BigInt(feePadSats) });
    if (!sel || !sel.fundingPrevout) throw new Error('cbtc-lock: no funding available for the lock');
    const { fundingPrevout } = sel;

    // 2. Recoverable blinding from priv + the funding anchor (the SAME derivation scanCbtc re-runs).
    const anchorOutpoint = anchorBytes(fundingPrevout.txid, fundingPrevout.vout);
    const blinding = deriveCbtcNoteBlinding({ privkey, anchorOutpoint, outputIndex: 0 });

    // 3. Commit to (vBtc, blinding); 4. build the 0x66 envelope (sigma tail defaults to zero).
    const { cx, cy } = commitXY(vBtc, blinding);
    const envelopeHex = buildCbtcLockEnvelope({ asset, lockVout, cx, cy });

    // 5. Construct + broadcast the commit→reveal; the reveal creates the self-custody lock output at lockVout
    //    with vBtc sats and carries the envelope in its witness. Injected — this is the only tx-construction seam.
    const lockSpk = ownLockScriptPubKey();
    const res = await broadcastCbtcLockTx({ fundingPrevout, vBtc, lockVout, lockSpk, envelopeHex, waitOpts });
    if (!res || !res.lockTxid) throw new Error('cbtc-lock: broadcast returned no lock txid');

    // 6. Fast-track the reflection fold so ② (track) resolves quickly.
    if (postHint) { try { await postHint(res.lockTxid, res.lockVout ?? lockVout); } catch { /* fold still happens via cron */ } }

    return {
      lockTxid: res.lockTxid,
      lockVout: res.lockVout ?? lockVout,
      vBtc: String(vBtc),
      blinding,
      anchor: fundingPrevout,
    };
  }

  return { buildAndBroadcastCbtcLock };
}

// ── SIGNET VALIDATION CHECKLIST (do BEFORE wiring into the one-click pipeline) ──────────────────────────────
// This driver moves real BTC and mints a bearer note whose recoverability depends on an exact byte derivation.
// Prove each, on signet, with a throwaway key:
//   1. Lock lands: broadcastCbtcLockTx produces a confirmed reveal with a vBtc-sats lock output at lockVout and
//      the 197-byte 0x66 envelope in the witness (parseCbtcLockEnvelope round-trips Cx/Cy/lockVout).
//   2. Reflection records it: fold_cbtc_lock inserts the lock (outpoint → vBtc, asset) into the cbtcLocks set
//      past finality; the /hint 0x66 fast-tracks it.
//   3. Mint opens 1:1: mintCbtc({ outpoint, vBtc, blinding }) settles and the note commits (Cx,Cy) == commitXY(
//      vBtc, blinding) == the lock's committed point. Over-mint / wrong-sats must fail closed.
//   4. Recovery: wipe localStorage, run scanCbtc over the user's spent prevouts; it MUST re-derive the same
//      blinding from `anchor` (the funding prevout) and match the lock's (Cx,Cy) — i.e. the note is recovered
//      from key + chain alone. This is the anti-strand invariant; if it fails, DO NOT ship.
//   5. Redeem round-trip: cbtc-redemption pairs the holder with an exiting locker and returns real BTC 1:1.
