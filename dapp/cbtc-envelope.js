// Builders for the cBTC Bitcoin-side Tacit envelopes — the inverse of burn-deposit-bitcoin.js
// parseCbtcLockEnvelope / parseCbtcRedeemEnvelope. These produce ONLY the Tacit frame that rides the lock /
// redeem tx (the Taproot witness); the surrounding Bitcoin tx (inputs, the self-custody lock output, signing,
// broadcast) reuses the existing tx infra. The reflection guest folds these (fold_cbtc_lock / fold_cbtc_redeem)
// and OP_CBTC_MINT later proves the note opens to exactly the lock output's sats.

const _hb = (h, n) => {
  const s = String(h).replace(/^0x/, '').padStart(n * 2, '0');
  if (s.length !== n * 2) throw new Error(`expected a ${n}-byte value, got ${s.length / 2}`);
  const o = new Uint8Array(n);
  for (let i = 0; i < n; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return o;
};
const _le4 = (v) => { const x = Number(v) >>> 0; return Uint8Array.of(x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >> 24) & 0xff); };
const _le8 = (v) => { let x = BigInt(v); const o = new Uint8Array(8); for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const _cat = (...a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const _hx = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const ZERO32 = new Uint8Array(32);

// T_CBTC_LOCK (0x66), 197 bytes: 0x66 ‖ asset(32) ‖ lockVout(4 LE) ‖ Cx(32) ‖ Cy(32) ‖ sigRx(32) ‖ sigRy(32) ‖
// sigZ(32). `v_btc` is NOT in the envelope — the guest stamps it from the lock output's sats and OP_CBTC_MINT
// proves the note opens to exactly that. The sigma-shaped tail is legacy (reflection ignores it) ⇒ zero-default.
export function buildCbtcLockEnvelope({ asset, lockVout, cx, cy, sigRx, sigRy, sigZ }) {
  const env = _cat(
    Uint8Array.of(0x66), _hb(asset, 32), _le4(lockVout), _hb(cx, 32), _hb(cy, 32),
    sigRx ? _hb(sigRx, 32) : ZERO32, sigRy ? _hb(sigRy, 32) : ZERO32, sigZ ? _hb(sigZ, 32) : ZERO32,
  );
  if (env.length !== 197) throw new Error(`cBTC lock envelope must be 197 bytes, got ${env.length}`);
  return _hx(env);
}

// T_CBTC_REDEEM (0x67), 109 bytes: 0x67 ‖ lockTxid(32) ‖ lockVout(4 LE) ‖ v_btc(8 LE) ‖ kernelSig(64). The
// single-tx Bitcoin-native redemption: the same tx UNLOCKS the named lock AND burns exactly v_btc of cBTC
// (Σ C_in = v_btc·H, the audited CXFER burn); reflection retires the whole lock before the rug scan.
export function buildCbtcRedeemEnvelope({ lockTxid, lockVout, vBtc, kernelSig }) {
  const env = _cat(Uint8Array.of(0x67), _hb(lockTxid, 32), _le4(lockVout), _le8(vBtc), _hb(kernelSig, 64));
  if (env.length !== 109) throw new Error(`cBTC redeem envelope must be 109 bytes, got ${env.length}`);
  return _hx(env);
}
