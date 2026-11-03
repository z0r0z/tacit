// The page's wiring for TAC made ready for Ethereum (dapp/fast/wire.js openBound) on the real tacit.js and the real bind builder: a
// bind of part of a note (the rest bound beside it), the bound notes found again at the key's Taproot address and opened from the key,
// each waiting until the relay's witness and the pool's roots agree, then a move handed to the pool module with the fast lane's
// inputs and a relay fee, and a moved note seen as moved. The explorers, the relay and the pool are stood in for by one fetch.
//   node tests/fastbridge-bound-wire.test.mjs        (Node 22)

import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tacit as T, etchNote, scalar } from './lib/btc-sim.mjs';
import { secp, bytesToHex, hexToBytes, keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { p2trAddress } from '../dapp/crossout-notes.js';
import { openBoundNote } from '../dapp/btc-bind.js';

const { openBound, TAC_ASSET } = await import('../dapp/fast/wire.js');

const TAC = 10n ** 8n;
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const BINDING = '0x' + bytesToHex(keccak_256(hexToBytes('1'.padStart(64, '0') + POOL.slice(2).toLowerCase())));
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The key: its wallet open in tacit.js, the same key the page builds its Bitcoin side from.
const priv = new Uint8Array(32).fill(7);
T.wallet.priv = priv; T.wallet.pub = secp.getPublicKey(priv, true);
const { prims } = makeBtcWallet({ priv, hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => {}, fetchFeeRate: async () => 1 });
const own = prims.p2wpkhScript(prims.wallet.pub);
const taproot = p2trAddress(prims.wallet.xonly(), 'tb');

// 100 TAC at the trading address, in the asset id of TAC (an etch stands in for its history: only the bind's own outputs are checked here).
const r0 = scalar('wire-note');
const etch = etchNote({ ticker: 'TAC', value: 100n * TAC, r: r0, script: own });
T._testSetScanHoldingsOverride(() => new Map([[TAC_ASSET, { utxos: [{ utxo: { txid: etch.txid, vout: 0, value: 546, status: { confirmed: true } }, amount: 100n * TAC, blinding: r0 }] }]]));

// The world: explorer reads, broadcasts, the relay's witness answer and the pool's storage.
const W = { posted: [], txs: new Map(), taprootUtxos: [], tip: 900_010, reflected: new Set(), live: new Set(), storage: new Map(), witnessCalls: 0 };
// the reflection's live-set key of a note: keccak(txid in internal order ‖ vout LE)
const liveKey = (txid, vout) => { const b = new Uint8Array(36); b.set(hexToBytes(txid).reverse(), 0); new DataView(b.buffer).setUint32(32, vout, true); return '0x' + bytesToHex(keccak_256(b)); };
const fetchImpl = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith('/fee-estimates')) return json({ 3: 2, 6: 2 });
  if (u.endsWith('/blocks/tip/height')) return new Response(String(W.tip));
  if (u.includes(`/address/${taproot}/utxo`)) return json(W.taprootUtxos);
  if (/\/address\/[^/]+\/utxo$/.test(u)) return json([{ txid: 'f'.repeat(64), vout: 1, value: 50_000, status: { confirmed: true } }]);
  const tm = u.match(/\/tx\/([0-9a-f]{64})$/);
  if (tm && !init.method) return W.txs.has(tm[1]) ? json(W.txs.get(tm[1])) : new Response('not found', { status: 404 });
  if (u.endsWith('/tx') && init.method === 'POST') { W.posted.push(init.body); return new Response('ok'); }
  if (u.includes('/reflection/live')) return json({ height: W.tip - 30, liveTriples: [...W.live].map((k) => [k, '0x', '0x', '0x', 0]) });
  if (u.includes('/reflection/note-witness')) {
    W.witnessCalls++;
    const { leaves, nullifiers } = JSON.parse(init.body);
    const tree = new pool.Tree(); const at = new Map();
    for (let i = 0; i < 3; i++) tree.insert(word(1000 + i));
    for (const l of W.reflected) at.set(l, tree.insert(l));
    const acc = pool.makeImtAccumulator(); acc.insert(word(5));
    const witnesses = {}, unspent = {};
    for (const l of leaves) witnesses[l] = at.has(l) ? { leafIndex: at.get(l), path: tree.rootAndPath(at.get(l)).path } : null;
    for (const nu of nullifiers) { const w = acc.nonMembershipWitness(nu); unspent[nu] = { value: w.lowValue, next: w.lowNext, index: w.lowIndex, path: w.path }; }
    W.root = tree.root(); W.spentRoot = acc.root();
    return json({ root: W.root, spentRoot: W.spentRoot, height: W.tip - 30, witnesses, unspent });
  }
  throw new Error('unexpected fetch ' + u);
};
const exits = [];
const ux = {
  pool, cfg: { pool: POOL }, chainBindingHex: () => BINDING,
  rpc: async (method, [to, slot]) => { assert.equal(method, 'eth_getStorageAt'); assert.equal(to, POOL); return W.storage.get(String(slot).toLowerCase()) ?? word(0); },
  quoteTransferFee: async (amount, ticker) => { assert.equal(ticker, 'cTAC'); return 1n * TAC; },
  fastlaneExit: async (args) => { exits.push(args); return { ok: true }; },
};
const slot = (key, n) => '0x' + bytesToHex(keccak_256(hexToBytes(String(key).replace(/^0x/, '').padStart(64, '0') + n.toString(16).padStart(64, '0'))));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const b = await openBound({ T, withKey: async (fn) => fn(T), ux, priv, pubHex: bytesToHex(T.wallet.pub), fetchImpl, bases: ['https://explorer.test/api'], witnessBase: 'https://relay.test', hrp: 'tb' });
let bindTxid = null, reveal = null;

test('a bind of 30 TAC spends the 100 TAC note into bound notes of 30 and 70 at the Taproot address, commit then reveal', async () => {
  assert.equal(b.taproot, taproot);
  await assert.rejects(b.bind({ amount: 5n * TAC }), /between 10 and 1000/);
  await assert.rejects(b.bind({ amount: 2000n * TAC }), /between 10 and 1000/);
  // a note the reflection does not track is never bound: its bound note would never become ready
  await assert.rejects(b.bind({ amount: 30n * TAC }), /only 0 TAC of yours can be made ready now/);
  assert.equal(W.posted.length, 0, 'nothing sent');
  W.live.add(liveKey(etch.txid, 0));
  const r = await b.bind({ amount: 30n * TAC });
  assert.equal(W.posted.length, 2, 'commit and reveal');
  bindTxid = r.txid;
  reveal = { txid: r.txid, hex: W.posted[1] };
  assert.ok(/^[0-9a-f]{64}$/.test(bindTxid));
});

test('the bound notes are found at the Taproot address, opened from the key, and wait until the reflection has them', async () => {
  // the explorer's view of the reveal: the payload and outputs as posted
  const { parseTx } = await import('../worker-relay/src/lib/btc-pool-chain.js');
  const p = parseTx(hexToBytes(reveal.hex)).tx;
  const esplora = {
    txid: bindTxid, status: { confirmed: true, block_height: W.tip - 5 },
    vin: p.vin.map((i) => ({ txid: i.txid, vout: i.vout, witness: i.witness.map(bytesToHex) })),
    vout: p.vout.map((o) => ({ scriptpubkey: bytesToHex(o.scriptPubKey), value: Number(o.value) })),
  };
  W.txs.set(bindTxid, esplora);
  W.taprootUtxos = [0, 1].map((vout) => ({ txid: bindTxid, vout, value: 546, status: { confirmed: true, block_height: W.tip - 5 } }));
  const opened = [0, 1].map((vout) => openBoundNote({ tacit: T, priv, pub: T.wallet.pub, tx: esplora, vout }));
  assert.deepEqual(opened.map((o) => o.amount), [30n * TAC, 70n * TAC]);
  const list = await b.bound();
  assert.deepEqual(list.map((n) => [n.amount, n.state]), [[70n * TAC, 'waiting'], [30n * TAC, 'waiting']]);
  assert.equal(list[0].etaMins, (24 - 5) * 10 + 40, 'the blocks still to bury it, then the proof');
  // reflected: the leaves are in the root the relay answers with, and the pool holds that root and the spent root
  for (const o of opened) W.reflected.add(pool.btcNoteLeafBound('0x' + TAC_ASSET, ...Object.values(pool.commitXY(o.amount, word(o.blinding))), '0x' + bytesToHex(prims.wallet.xonly()), BINDING));
  await b.bound();
  W.storage.set(slot(W.root, 78), word(1));
  W.storage.set(word(79), W.spentRoot);
  const ready = await b.bound();
  assert.deepEqual(ready.map((n) => n.state), ['ready', 'ready']);
});

test('a move hands the pool module the fast lane\'s input, the wallet key as the note\'s authority, a relay fee, and relay settling', async () => {
  const [n] = await b.bound();
  await b.move(n);
  assert.equal(exits.length, 1);
  const a = exits[0];
  assert.equal(a.selfRelay, false, 'the relay settles: no ETH needed');
  assert.equal(a.fee, 1n * TAC);
  assert.equal(a.authPriv, '0x' + bytesToHex(priv));
  assert.equal(a.spendRoot, W.root);
  assert.equal(a.bitcoinSpentRoot, W.spentRoot);
  assert.equal(a.notes.length, 1);
  assert.equal(a.notes[0].value, String(70n * TAC));
  assert.ok(a.notes[0].low && a.notes[0].path.length === 32);
  // once the pool has spent it, it is moved
  W.storage.set(slot(n.lane.nullifier, 70), word(1));
  const after = await b.bound();
  assert.equal(after.find((x) => x.vout === n.vout).state, 'moved');
  // a note not ready is refused before anything is asked of the relay
  W.storage.set(word(79), word(3));
  await assert.rejects(b.move(after.find((x) => x.vout !== n.vout)), /differ for now/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ok ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n    ${e.stack?.split('\n').slice(0, 4).join('\n    ')}`); }
}
console.log(`${tests.length - failed}/${tests.length} ready-for-Ethereum wiring checks passed`);
process.exit(failed ? 1 : 0);
