// The recoverable cBTC-note blinding (dapp/cbtc-note-recovery.js) — deterministic from priv + funding anchor,
// binds every field, a valid secp scalar, and the anchor is txid_LE ‖ vout_LE (matches _deriveSlotSecret's
// shape). This is the match-point the Model-B lock-tx + a future scanCbtc must share. Run: node tests/cbtc-note-recovery.mjs
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeCbtcNoteRecovery } from '../dapp/cbtc-note-recovery.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import assert from 'node:assert';
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const N = BigInt(secp.CURVE.n);
const rec = makeCbtcNoteRecovery({ hmac, sha256, curveOrder: N });
const pool = makeConfidentialPool({ secp, keccak256: (b) => keccak_256(b), sha256: (b) => sha256(b) });
const priv = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

// anchor byte-order: display BE txid → LE; vout little-endian
{
  const a = rec.anchorBytes('00'.repeat(31) + 'ff', 1);
  assert.equal(a.length, 36, '36-byte anchor');
  assert.equal(a[0], 0xff, 'txid display BE → LE (last display byte first)');
  assert.equal(a[31], 0x00, 'txid LE tail');
  assert.deepEqual([...a.slice(32)], [1, 0, 0, 0], 'vout little-endian');
  ok('anchorBytes: txid_LE ‖ vout_LE (mirrors _slotOutpointBytes)');
}

// deterministic + valid scalar + binds priv / anchor / outputIndex
{
  const anchor = rec.anchorBytes('ab'.repeat(32), 0);
  const b0 = rec.deriveCbtcNoteBlinding({ privkey: priv, anchorOutpoint: anchor, outputIndex: 0 });
  assert.equal(rec.deriveCbtcNoteBlinding({ privkey: priv, anchorOutpoint: anchor, outputIndex: 0 }), b0, 'deterministic');
  assert.ok(b0 > 0n && b0 < N, 'valid scalar in (0, N)');
  assert.notEqual(rec.deriveCbtcNoteBlinding({ privkey: priv, anchorOutpoint: anchor, outputIndex: 1 }), b0, 'binds outputIndex');
  assert.notEqual(rec.deriveCbtcNoteBlinding({ privkey: priv, anchorOutpoint: rec.anchorBytes('cd'.repeat(32), 0), outputIndex: 0 }), b0, 'binds funding anchor');
  const priv2 = Uint8Array.from({ length: 32 }, (_, i) => i + 2);
  assert.notEqual(rec.deriveCbtcNoteBlinding({ privkey: priv2, anchorOutpoint: anchor, outputIndex: 0 }), b0, 'binds priv');
  ok('deriveCbtcNoteBlinding: deterministic, scalar in (0,N), binds priv/anchor/index');
}

// scanCbtc round-trip: derive a note from the commit anchor, hide it among candidate spends, recover it
{
  const anchorTxid = 'ab'.repeat(32), anchorVout = 0, vBtc = 100000n;
  const blinding = rec.deriveCbtcNoteBlinding({ privkey: priv, anchorOutpoint: rec.anchorBytes(anchorTxid, anchorVout), outputIndex: 0 });
  const { cx, cy } = pool.commitXY(vBtc, blinding);
  const candidateAnchors = [
    { txid: '11'.repeat(32), vout: 3 },
    { txid: anchorTxid, vout: anchorVout },   // ← the lock's commit-tx funding anchor (among decoys)
    { txid: '22'.repeat(32), vout: 1 },
  ];
  const locks = [{ vBtc: vBtc.toString(), cx, cy }];
  const recovered = rec.scanCbtc({ privkey: priv, candidateAnchors, locks, commitXY: pool.commitXY });
  assert.equal(recovered.length, 1, 'the user recovers their own cBTC lock by trying candidate anchors');
  assert.equal(recovered[0].cx, cx); assert.equal(recovered[0].blinding, blinding); assert.equal(recovered[0].anchor.txid, anchorTxid);
  const priv2 = Uint8Array.from({ length: 32 }, (_, i) => i + 9);
  assert.equal(rec.scanCbtc({ privkey: priv2, candidateAnchors, locks, commitXY: pool.commitXY }).length, 0, 'a stranger cannot recover the note');
  ok('scanCbtc: finds the funding anchor among candidate spends, recovers the note; a stranger recovers nothing');
}

console.log(`cbtc-note-recovery: all ${n} checks passed`);
