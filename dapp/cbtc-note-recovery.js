// Recoverable blinding for a Model-B cBTC.zk note. The cBTC note is owner-free (bearer), so it has NO memo
// channel — it must be re-derivable from the key + chain alone, exactly like a mixer slot (tacit.js
// `_deriveSlotSecret`). The Model-B lock-tx commits `commitXY(v_btc, blinding)` under this derivation, and a
// `scanCbtc` re-derives the SAME blinding from the user's outgoing spends (each spent prevout is a candidate
// `fundingAnchor`) to recover the note after a localStorage wipe. WITHOUT this pairing the note strands (lost
// funds) — which is why the action layer's `mintCbtc` tags the cBTC note `seedDerived`.
//
// Deps: { hmac, sha256, curveOrder } — @noble hmac/sha256 + the secp order N (so the result is a valid scalar).

export function makeCbtcNoteRecovery({ hmac, sha256, curveOrder }) {
  const N = BigInt(curveOrder);
  const DOMAIN = new TextEncoder().encode('tacit-cbtc-note-blinding-v1');
  const cat = (...a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const toBig = (b) => { let x = 0n; for (const y of b) x = (x << 8n) | BigInt(y); return x; };

  // The 36-byte funding anchor = txid_LE(32) ‖ vout_LE(4) (the chain's natural byte order — mirror
  // tacit.js `_slotOutpointBytes`: reverse the displayed txid hex to LE before concat).
  function anchorBytes(txidHexDisplay, vout) {
    const s = String(txidHexDisplay).replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/i.test(s)) throw new Error('txid must be 64 hex chars');
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new Error('vout must be u32');
    const le = new Uint8Array(36);
    for (let i = 0; i < 32; i++) le[i] = parseInt(s.slice((31 - i) * 2, (31 - i) * 2 + 2), 16); // display BE → LE
    le[32] = vout & 0xff; le[33] = (vout >> 8) & 0xff; le[34] = (vout >> 16) & 0xff; le[35] = (vout >>> 24) & 0xff;
    return le;
  }

  // The recoverable Pedersen blinding (a scalar in (0, N)) for the cBTC note created against `fundingAnchor`.
  // Same shape as `_deriveSlotSecret`: hmac(priv, DOMAIN ‖ anchor(36) ‖ outputIndex(1)), reduced mod N.
  function deriveCbtcNoteBlinding({ privkey, anchorOutpoint, outputIndex = 0 }) {
    if (!(privkey instanceof Uint8Array) || privkey.length !== 32) throw new Error('privkey must be 32 bytes');
    if (!(anchorOutpoint instanceof Uint8Array) || anchorOutpoint.length !== 36) throw new Error('anchorOutpoint must be 36 bytes (txid_LE 32 + vout_LE 4)');
    if (!Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex > 0xff) throw new Error('outputIndex must be u8');
    const raw = hmac(sha256, privkey, cat(DOMAIN, anchorOutpoint, Uint8Array.of(outputIndex & 0xff)));
    const b = toBig(raw) % N;
    return b === 0n ? 1n : b;
  }

  // Recover the user's Model-B cBTC notes from the key + chain alone — the inverse of the lock-tx. The lock is a
  // commit→reveal (the 0x66 envelope rides the reveal's WITNESS), so the funding anchor is the COMMIT tx's
  // vin[0] — NOT the reveal's vin[0]. So, slot-style (mirror `scanSlotsFromPrivkey`): try every spent prevout
  // in the user's history as a candidate anchor, re-derive the blinding, and match `commitXY(v_btc, blinding)`
  // against each lock's committed (Cx,Cy). A match ⇒ the user created that lock with their key ⇒ recover the
  // bearer note. `locks` = [{ vBtc, cx, cy }] from `classifyConfidentialTx` on the user's cBTC lock txs;
  // `candidateAnchors` = [{ txid, vout }] the user's spent prevouts; `commitXY` = pool.commitXY.
  function scanCbtc({ privkey, candidateAnchors, locks, commitXY }) {
    const eq = (a, b) => String(a).replace(/^0x/, '').toLowerCase() === String(b).replace(/^0x/, '').toLowerCase();
    const found = [];
    for (const lock of locks) {
      for (const a of candidateAnchors) {
        const blinding = deriveCbtcNoteBlinding({ privkey, anchorOutpoint: anchorBytes(a.txid, a.vout), outputIndex: 0 });
        const { cx, cy } = commitXY(lock.vBtc, blinding);
        if (eq(cx, lock.cx) && eq(cy, lock.cy)) { found.push({ vBtc: String(lock.vBtc), blinding, cx, cy, anchor: a }); break; }
      }
    }
    return found;
  }

  return { anchorBytes, deriveCbtcNoteBlinding, scanCbtc };
}
