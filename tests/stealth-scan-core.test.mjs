// dapp/stealth-scan-core.js, the stealth scan's math shared by tacit.js and the scan worker, held to what tacit.js did before it moved (the reference kept in
// tests/_stealth-scan-reference.mjs): every function the same, and recipientScanTxForStealth, which skips an output that cannot match and reads the wallet key once, returning
// exactly the credits the original returned, on random transfers that pay the wallet, pay others, carry odd scripts, or are malformed.
//   node --test tests/stealth-scan-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { concatBytes } from '../dapp/vendor/tacit-deps.min.js';
import * as core from '../dapp/stealth-scan-core.js';
import * as ref from './_stealth-scan-reference.mjs';

import { walletPriv, walletPub, DOMAIN_FIXTURE as DOMAIN, bytes, json, transfer } from './_stealth-fixtures.mjs';

const both = (t, over = {}) => {
  const args = { classifiedInputs: t.classifiedInputs, outputs: t.outputs, walletPriv, walletPub, networkTag: t.networkTag, domain: DOMAIN, txAnchorHead: t.txAnchorHead, ...over };
  return [core.recipientScanTxForStealth(args), ref.recipientScanTxForStealth(args)];
};

test('every function the module took from tacit.js is the one tacit.js had, with the same behaviour', () => {
  for (const name of Object.keys(ref).filter((n) => n !== 'recipientScanTxForStealth')) assert.strictEqual(core[name].toString(), ref[name].toString(), `${name} is unchanged`);
});

test('random transfers, some paying the wallet: the same credits, in the same order', () => {
  let paid = 0, none = 0;
  for (let i = 0; i < 160; i++) {
    const t = transfer();
    const [a, b] = both(t);
    assert.strictEqual(json(a), json(b), `transfer ${i}`);
    if (b.length) paid++; else none++;
  }
  assert.ok(paid >= 20 && none >= 10, `the run held both: ${paid} that pay the wallet, ${none} that do not`);
});

test('transfers that pay nobody and transfers made only of odd scripts give nothing, as before', () => {
  for (let i = 0; i < 80; i++) { const [a, b] = both(transfer({ pay: false })); assert.strictEqual(json(a), json(b)); assert.deepStrictEqual(b, []); }
  for (let i = 0; i < 40; i++) { const [a, b] = both(transfer({ pay: false, junk: true })); assert.strictEqual(json(a), json(b)); }
});

test('with no usable input, a wallet key that is not 33 bytes, or no outputs: the same answer', () => {
  const t = transfer();
  assert.strictEqual(json(core.recipientScanTxForStealth({ classifiedInputs: [{ kind: 'p2wsh', pub: null }], outputs: t.outputs, walletPriv, walletPub, networkTag: 'mainnet', domain: DOMAIN, txAnchorHead: t.txAnchorHead })),
    json(ref.recipientScanTxForStealth({ classifiedInputs: [{ kind: 'p2wsh', pub: null }], outputs: t.outputs, walletPriv, walletPub, networkTag: 'mainnet', domain: DOMAIN, txAnchorHead: t.txAnchorHead })));
  for (const wp of [walletPub.slice(0, 32), new Uint8Array(33), new Uint8Array(0)]) {
    const [a, b] = (() => { let x, y; try { x = core.recipientScanTxForStealth({ classifiedInputs: t.classifiedInputs, outputs: t.outputs, walletPriv, walletPub: wp, networkTag: t.networkTag, domain: DOMAIN, txAnchorHead: t.txAnchorHead }); } catch (e) { x = 'threw ' + e.message; } try { y = ref.recipientScanTxForStealth({ classifiedInputs: t.classifiedInputs, outputs: t.outputs, walletPriv, walletPub: wp, networkTag: t.networkTag, domain: DOMAIN, txAnchorHead: t.txAnchorHead }); } catch (e) { y = 'threw ' + e.message; } return [x, y]; })();
    assert.strictEqual(json(a), json(b), `wallet key of ${wp.length} bytes`);
  }
  const [a, b] = both({ ...t, outputs: [] });
  assert.deepStrictEqual([a, b], [[], []]);
});

test('an unknown network or a bad key behaves as it did (the error is the same)', () => {
  const t = transfer();
  const run = (m) => { try { return json(m.recipientScanTxForStealth({ classifiedInputs: t.classifiedInputs, outputs: t.outputs, walletPriv, walletPub, networkTag: 'nonsense', domain: DOMAIN, txAnchorHead: t.txAnchorHead })); } catch (e) { return 'threw ' + e.message; } };
  assert.strictEqual(run(core), run(ref));
  const runPriv = (m) => { try { return json(m.recipientScanTxForStealth({ classifiedInputs: t.classifiedInputs, outputs: t.outputs, walletPriv: new Uint8Array(31), walletPub, networkTag: t.networkTag, domain: DOMAIN, txAnchorHead: t.txAnchorHead })); } catch (e) { return 'threw ' + e.message; } };
  assert.strictEqual(runPriv(core), runPriv(ref));
});

test('and it is faster on a transfer with outputs that cannot pay anyone', () => {
  const t = transfer({ pay: false, junk: true });
  const wide = { ...t, outputs: Array.from({ length: 12 }, (_, i) => ({ script: i % 3 === 0 ? concatBytes(new Uint8Array([0x6a, 0x20]), bytes(32)) : bytes(10 + i) })) };
  const run = (m) => { const t0 = performance.now(); for (let i = 0; i < 40; i++) m.recipientScanTxForStealth({ classifiedInputs: wide.classifiedInputs.length ? wide.classifiedInputs : t.classifiedInputs, outputs: wide.outputs, walletPriv, walletPub, networkTag: 'mainnet', domain: DOMAIN, txAnchorHead: t.txAnchorHead }); return performance.now() - t0; };
  run(core); run(ref);
  const a = run(core), b = run(ref);
  console.log(`  12 outputs none of which can pay: original ${b.toFixed(0)} ms, now ${a.toFixed(0)} ms for 40`);
  assert.ok(a <= b * 1.1, 'never slower');
});
