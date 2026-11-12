// The fee rate the fast bridge builds a lock at: an explorer that answers an implausible figure is not believed, explorers that disagree wildly
// give the lower, and ordinary estimates are unchanged.
//   node tests/fastbridge-fee-bound.test.mjs
import assert from 'node:assert';
import { makeEsploraBtcChain } from '../dapp/fastbridge-btc.js';
const prims = { wallet: { pub: new Uint8Array(33), priv: new Uint8Array(32), address: () => 'bc1qtest' } };
const rate = async (answers) => {
  const fetchImpl = async (url) => { const b = Object.keys(answers).find((k) => url.startsWith(k)); const v = answers[b]; if (v === 'down') throw new TypeError('fetch failed'); return { ok: true, json: async () => ({ 3: v, 6: v }), text: async () => '' }; };
  const btc = makeEsploraBtcChain({ bases: Object.keys(answers), prims, builder: null, fetchImpl });
  return btc.feeRate().then((v) => v, (e) => e);
};
let n = 0; const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };
ok(await rate({ 'https://a.test/api': 6, 'https://b.test/api': 8 }) === 7, 'two ordinary estimates give their average, as before');
ok(await rate({ 'https://a.test/api': 40, 'https://b.test/api': 90 }) === 65, 'a fee spike on which they differ by two or three times is not touched');
ok(await rate({ 'https://a.test/api': 6, 'https://b.test/api': 2_000_000 }) === 6, 'an explorer that answers two million sat/vB is not believed');
ok(await rate({ 'https://a.test/api': 6, 'https://b.test/api': 4_999 }) === 6, 'one that answers a figure under the ceiling but a thousand times the other gives the lower');
ok(await rate({ 'https://a.test/api': 2_000_000, 'https://b.test/api': 2_000_000 }) instanceof Error, 'if every explorer gives an implausible figure there is no estimate');
ok(await rate({ 'https://a.test/api': 12 }) === 12, 'a single explorer is believed within the ceiling');
ok(await rate({ 'https://a.test/api': 12, 'https://b.test/api': 'down' }) === 12, 'and when the other is down');
console.log(`${n} ok`);
