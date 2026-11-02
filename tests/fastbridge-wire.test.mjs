// The page's wiring (dapp/fast/wire.js) on the real tacit.js: the Bitcoin address it checks, the key's TAC notes it lists, and the client it
// builds over a provider. The modules import by site path ("/x.js?cb=..."), which a loader hook maps to dapp/.
//   node tests/fastbridge-wire.test.mjs        (Node 22)

import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

import assert from 'node:assert/strict';
import { realFetch } from './lib/real-fetch.mjs';
import { tacit as T, fetched } from './lib/btc-sim.mjs';
import { secp, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';

const { openFast, notesOf, TAC_ASSET, EXPLORERS } = await import('../dapp/fast/wire.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const key = (n) => new Uint8Array(32).fill(n);
const openWallet = (priv) => { T.wallet.priv = priv; T.wallet.pub = secp.getPublicKey(priv, true); };
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const utxo = (n, confirmed = true, value = 546) => ({ txid: String(n).repeat(64), vout: 0, value, status: { confirmed } });
const holdings = (entries) => new Map(entries);

test('the key\'s TAC notes: confirmed ones, as the lock takes them, and none for an asset the wallet does not hold', async () => {
  T._testSetScanHoldingsOverride(() => holdings([[TAC_ASSET, { utxos: [
    { utxo: utxo(1), amount: 5000n, blinding: 7n, commitment: 'x' }, { utxo: utxo(2, false), amount: 900n, blinding: 8n }, { utxo: utxo(3), amount: 250n, blinding: '0x09' },
  ] }], ['ab'.repeat(32), { utxos: [{ utxo: utxo(4), amount: 1n, blinding: 1n }] }]]));
  const notes = await notesOf(T);
  assert.deepEqual(notes.map((n) => [n.txid[0], n.vout, n.value, n.amount, n.blinding]), [['1', 0, 546, 5000n, 7n], ['3', 0, 546, 250n, 9n]]);
  T._testSetScanHoldingsOverride(() => holdings([]));
  assert.deepEqual(await notesOf(T), []);
  T._testSetScanHoldingsOverride(() => null);
  assert.deepEqual(await notesOf(T), []);
  T._testSetScanHoldingsOverride(null);
});

test('openFast: the address, the notes, the balance and a client over the provider, with its key pinned', async () => {
  const priv = key(5), pubHex = bytesToHex(secp.getPublicKey(priv, true));
  openWallet(priv);
  T._testSetScanHoldingsOverride(() => holdings([[TAC_ASSET, { utxos: [{ utxo: utxo(1), amount: 5000n, blinding: 7n }, { utxo: utxo(2), amount: 700n, blinding: 8n }] }]]));
  const claimPub = '02' + 'ab'.repeat(32);
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://lp.example/info');
    return new Response(JSON.stringify({ claimPub, btcAsset: TAC_ASSET, evmAsset: TAC_ASSET, minAmount: '10', maxAmount: '100000', feeBps: 30, flatFee: '5', csvBlocks: 144, evmWindowSecs: 14400 }), { status: 200 });
  };
  const s = await openFast({ T, withKey: (fn) => fn(T), ux: { cfg: { pool: POOL } }, priv, pubHex, lp: { base: 'https://lp.example', claimPub }, fetchImpl, hrp: 'tb' });
  assert.equal(s.address, T.wallet.address());
  assert.equal(await s.balance(), 5700n);
  assert.deepEqual((await s.notes()).map((n) => n.amount), [5000n, 700n]);
  assert.equal(s.fb.pickNotes(await s.notes(), 600n).notes[0].amount, 700n, 'the smallest note that covers it');
  const t = await s.fb.terms();
  assert.deepEqual([t.claimPub, t.feeBps, t.flatFee, t.minAmount], [claimPub, 30, 5n, 10n]);
  assert.deepEqual(await s.fb.records(), [], 'nothing under way for this key');
  // a provider whose key is not the pinned one is refused
  const other = await openFast({ T, withKey: (fn) => fn(T), ux: { cfg: { pool: POOL } }, priv, pubHex, lp: { base: 'https://lp.example', claimPub: '02' + 'cd'.repeat(32) }, fetchImpl, hrp: 'tb' });
  await assert.rejects(() => other.fb.terms(), /key is not the one this page expects/);
  // with no key pinned the provider\'s own stands
  const loose = await openFast({ T, withKey: (fn) => fn(T), ux: { cfg: { pool: POOL } }, priv, pubHex, lp: { base: 'https://lp.example' }, fetchImpl, hrp: 'tb' });
  assert.equal((await loose.fb.terms()).claimPub, claimPub);
  T._testSetScanHoldingsOverride(null);
});

test('a key whose Bitcoin address is not the wallet\'s is refused before anything is built', async () => {
  const priv = key(5);
  openWallet(key(6));
  await assert.rejects(() => openFast({ T, withKey: (fn) => fn(T), ux: { cfg: { pool: POOL } }, priv, pubHex: 'x', lp: { base: 'https://lp.example' }, hrp: 'tb' }), /not the one the wallet reads/);
  openWallet(priv);
});

test('the explorers the page reads are the two it lists for the bridge page', () => {
  assert.deepEqual(EXPLORERS, ['https://mempool.space/api', 'https://blockstream.info/api']);
  assert.equal(TAC_ASSET, 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b');
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
void realFetch;
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${ran} fast wiring checks passed`);
process.exit(process.exitCode || 0);
