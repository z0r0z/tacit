// Round-trips the cBTC envelope BUILDERS (dapp/cbtc-envelope.js) against the canonical PARSERS
// (dapp/burn-deposit-bitcoin.js) — so a built lock/redeem frame is byte-exact what the reflection guest folds.
// Run: node tests/cbtc-envelope.mjs
import { buildCbtcLockEnvelope, buildCbtcRedeemEnvelope } from '../dapp/cbtc-envelope.js';
import { parseCbtcLockEnvelope, parseCbtcRedeemEnvelope, txOutputValue } from '../dapp/burn-deposit-bitcoin.js';
import assert from 'node:assert';
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// ── T_CBTC_LOCK (0x66): build → parse → fields match (sigma tail zero-defaults) ──
{
  const asset = '0x' + '62'.repeat(32), cx = '0x' + '10'.repeat(32), cy = '0x' + '11'.repeat(32);
  const env = buildCbtcLockEnvelope({ asset, lockVout: 1, cx, cy });
  assert.equal(env.replace(/^0x/, '').length / 2, 197, 'lock envelope is 197 bytes');
  const p = parseCbtcLockEnvelope(env);
  assert.ok(p, 'parser accepts the built lock envelope');
  assert.equal(p.asset, asset, 'asset round-trips');
  assert.equal(p.lockVout, 1, 'lockVout round-trips (LE)');
  assert.equal(p.cx, cx, 'Cx round-trips');
  assert.equal(p.cy, cy, 'Cy round-trips');
  assert.equal(p.sigRx, '0x' + '00'.repeat(32), 'legacy sigma tail defaults to zero');
  ok('buildCbtcLockEnvelope round-trips through parseCbtcLockEnvelope');
}

// a non-zero vout encodes little-endian correctly
{
  const p = parseCbtcLockEnvelope(buildCbtcLockEnvelope({ asset: '0x' + '62'.repeat(32), lockVout: 258, cx: '0x' + '10'.repeat(32), cy: '0x' + '11'.repeat(32) }));
  assert.equal(p.lockVout, 258, 'lockVout 258 (0x0102) LE round-trips');
  ok('lock envelope lockVout little-endian is correct');
}

// ── T_CBTC_REDEEM (0x67): build → parse → fields match ──
{
  const lockTxid = '0x' + 'ab'.repeat(32), kernelSig = '0x' + 'cd'.repeat(64);
  const env = buildCbtcRedeemEnvelope({ lockTxid, lockVout: 0, vBtc: 100000n, kernelSig });
  assert.equal(env.replace(/^0x/, '').length / 2, 109, 'redeem envelope is 109 bytes');
  const p = parseCbtcRedeemEnvelope(env);
  assert.ok(p, 'parser accepts the built redeem envelope');
  assert.equal(p.lockTxid, lockTxid, 'lockTxid round-trips');
  assert.equal(p.lockVout, 0, 'lockVout round-trips');
  assert.equal(p.vBtc, '100000', 'v_btc round-trips (8 LE)');
  assert.equal(p.kernelSig, kernelSig, 'kernelSig round-trips');
  ok('buildCbtcRedeemEnvelope round-trips through parseCbtcRedeemEnvelope');
}

// ── read-side: the envelope's lockVout points at the lock output whose sats the reflection stamps as v_btc ──
{
  const vBtc = 100000n;
  const env = buildCbtcLockEnvelope({ asset: '0x' + '62'.repeat(32), lockVout: 1, cx: '0x' + '10'.repeat(32), cy: '0x' + '11'.repeat(32) });
  const lockVout = parseCbtcLockEnvelope(env).lockVout; // 1
  const vLE = (v) => { let x = BigInt(v); let s = ''; for (let i = 0; i < 8; i++) { s += (Number(x & 0xffn)).toString(16).padStart(2, '0'); x >>= 8n; } return s; };
  // minimal non-segwit raw tx: 1 input, vout0 = OP_RETURN(hash), vout1 = lock output (= v_btc sats)
  const rawTx = '02000000' + '01'
    + '00'.repeat(32) + '00000000' + '00' + 'fdffffff'
    + '02'
    + '0000000000000000' + '22' + '6a20' + 'ab'.repeat(32)   // vout0 OP_RETURN
    + vLE(vBtc) + '16' + '0014' + 'cd'.repeat(20)              // vout1 lock = v_btc
    + '00000000';
  assert.equal(txOutputValue(rawTx, lockVout), vBtc.toString(), 'reflection reads v_btc from the lock output at the envelope lockVout');
  assert.notEqual(txOutputValue(rawTx, 0), vBtc.toString(), 'vout0 (OP_RETURN, 0 sats) is not the lock');
  ok('cBTC lock read-side: envelope lockVout → lock output value (v_btc) align');
}

console.log(`cbtc-envelope: all ${n} checks passed`);
