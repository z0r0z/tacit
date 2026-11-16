// A read that fails while the validator lays out a note's history is not a verdict on the note.
//
// validateOutpoint reads each transaction of the history once to find what it spends, and walks only what those reads gave it. A read that failed
// there (an explorer that did not answer) left that transaction's parents out of the walk; when the transaction was read again a moment later and
// answered, it was judged without its parents, found them "not valid", and the verdict went up as 'invalid' (not 'fetch-failed'): a provider declined
// a user's 1,000 TAC lock for good with "the opening does not match the note; the output is not a valid note of the asset" (2026-11-15), where the
// same history, asked again, was fine. Now a failed read is asked again, and one that still fails leaves the note a read to try again.
//   node tests/validator-unread-history.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { loadTacit } from '../worker-relay/src/lib/btc-pool-transparent.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeEsploraBtcChain } from '../dapp/fastbridge-btc.js';
import { bpRangeAggProve, pointToBytes, randomScalar } from './bulletproofs.mjs';

// a real range proof: a transfer is checked for one before its history is read, so a made-up one never reaches the parent
const REAL = bpRangeAggProve([5n], [randomScalar()]);

const T = await loadTacit('mainnet', { livePool: true });
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const id = (n) => { const b = new Uint8Array(32); b[0] = 0x5a; new DataView(b.buffer).setUint32(28, n, false); return hex(b); };
const confirmed = { confirmed: true, block_height: 900000, block_time: 1700000000 };

// a transfer envelope of the asset: it decodes (what the walk needs to find its parents); its proofs are never reached, because its parent is judged first
const payload = () => T.encodeCXferPayload({
  assetId: new Uint8Array(32).fill(9), kernelSig: new Uint8Array(64).fill(1),
  outputs: [{ commitment: pointToBytes(REAL.commitments[0]), encryptedAmount: new Uint8Array(8) }], rangeproof: REAL.proof,
});
const transfer = (txid, parent) => ({
  txid, status: confirmed,
  vin: [
    { txid: id(0xc0), vout: 0, witness: [hex(new Uint8Array(64)), hex(T.encodeEnvelopeScript(new Uint8Array(32).fill(4), payload())), hex(new Uint8Array(33))], prevout: { scriptpubkey_type: 'v1_p2tr' } },
    { txid: parent, vout: 0, witness: [hex(new Uint8Array(71)), hex(new Uint8Array(33))], prevout: { scriptpubkey_type: 'v0_p2wpkh' } },
  ],
  vout: [{ scriptpubkey: '0014' + '11'.repeat(20), value: 546 }],
});
// the history: ROOT spends MIDDLE:0, which spends PLAIN:0, a coin that is not a note at all (a plain payment: a genuine "not valid")
const ROOT = id(1), MIDDLE = id(2), PLAIN = id(3);
const plain = { txid: PLAIN, status: confirmed, vin: [{ txid: id(0xc1), vout: 0, witness: [hex(new Uint8Array(71)), hex(new Uint8Array(33))], prevout: { scriptpubkey_type: 'v0_p2wpkh' } }], vout: [{ scriptpubkey: '0014' + '22'.repeat(20), value: 5000 }] };
const TXS = new Map([[ROOT, transfer(ROOT, MIDDLE)], [MIDDLE, transfer(MIDDLE, PLAIN)], [PLAIN, plain]]);

// a reader that fails the way an explorer does: `down(txid, n)` says whether the n-th read of that transaction fails
const reader = (down) => { const n = new Map(); return async (t) => { const k = (n.get(t) || 0) + 1; n.set(t, k); if (down(t, k)) throw new Error('fetch failed'); return TXS.get(t) || null; }; };
const judge = async (fetchTx) => { const c = new Map(), reasons = new Map(); const ok = await T.validateOutpoint(ROOT, 0, c, fetchTx, 0, null, null, null, reasons); return { ok, root: reasons.get(`${ROOT}:0`) }; };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('control: a history with a plain coin in it is a genuine verdict, "invalid", with every read answering', async () => {
  const r = await judge(reader(() => false));
  assert.equal(r.ok, false);
  assert.equal(r.root, 'invalid');
});

test('a read of the middle transaction that fails once while the walk is laid out is asked again, and the verdict is the same as with no failure', async () => {
  const r = await judge(reader((t, k) => t === MIDDLE && k === 1));
  assert.equal(r.ok, false);
  assert.equal(r.root, 'invalid', 'the history was walked after all: the plain coin in it is what makes the note not valid');
});

test('the shape of the 2026-11-15 declines: the middle read fails once, and what is below it cannot be read just now: still a read to try again', async () => {
  // before: the middle was read again, answered, and was judged with its parents never walked: "invalid", and a lock was declined for good
  const r = await judge(reader((t, k) => (t === MIDDLE && k === 1) || t === PLAIN));
  assert.equal(r.ok, false);
  assert.equal(r.root, 'fetch-failed');
});

test('a read that keeps failing leaves the note a read to try again ("fetch-failed"), not "invalid": its history was never walked', async () => {
  // the first three reads fail (the walk's own tries), and the fourth, the later single read, answers: that read used to be judged without the parents
  const r = await judge(reader((t, k) => t === MIDDLE && k <= 3));
  assert.equal(r.ok, false);
  assert.equal(r.root, 'fetch-failed');
});

test('a transaction that never answers is also a read to try again', async () => {
  const r = await judge(reader((t) => t === MIDDLE));
  assert.equal(r.ok, false);
  assert.equal(r.root, 'fetch-failed');
});

test('the provider\'s chain view asks again on such a read (a transient error) and does not say "not a valid note"', async () => {
  const { prims } = makeBtcWallet({ priv: new Uint8Array(32).fill(7), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
  let reads = 0;
  const fetchImpl = async (u) => {
    const t = String(u).split('/tx/')[1];
    if (t === MIDDLE && ++reads <= 3) throw new Error('fetch failed');
    return TXS.has(t) ? new Response(JSON.stringify(TXS.get(t)), { status: 200 }) : new Response('not found', { status: 404 });
  };
  const btc = makeEsploraBtcChain({ bases: ['http://esplora.test'], prims, builder: null, fetchImpl, tacit: T, retryMs: 1 });
  await assert.rejects(btc.resolveNote(ROOT, 0), (e) => e.transient === true, 'a lock whose history could not be read just now is asked again');
});

test('a verdict that a note is not valid is logged with the outpoint the walk rejected first, so the next decline says where the history broke', async () => {
  const { prims } = makeBtcWallet({ priv: new Uint8Array(32).fill(7), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
  const fetchImpl = async (u) => { const t = String(u).split('/tx/')[1]; return TXS.has(t) ? new Response(JSON.stringify(TXS.get(t)), { status: 200 }) : new Response('not found', { status: 404 }); };
  const lines = [];
  const btc = makeEsploraBtcChain({ bases: ['http://esplora.test'], prims, builder: null, fetchImpl, tacit: T, log: (o) => lines.push(o) });
  assert.equal(await btc.resolveNote(ROOT, 0), null, 'a plain coin in the history: not a valid note');
  const said = lines.find((l) => l.msg === 'a note is not valid');
  assert.ok(said, 'the verdict is logged');
  assert.equal(said.note, `${ROOT}:0`);
  assert.equal(said.rejected[0], `${PLAIN}:0`, 'the first outpoint rejected is the deepest one: the plain coin');
});

test('an Ethereum read that fails while the spent notes are checked is a read to try again (transient), not "already consumed on Ethereum"', async () => {
  // the guard is closed when it cannot tell: it said "blocked (evm-unverifiable)", the provider declined the lock for good (and aborted an accepted swap)
  const { secp, keccak_256 } = await import('../dapp/vendor/tacit-deps.min.js');
  const { prims } = makeBtcWallet({ priv: new Uint8Array(32).fill(7), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
  const SPENDER = id(0x70), PARENT = id(0x72);
  const txs = new Map([
    [SPENDER, { txid: SPENDER, status: confirmed, vin: [{ txid: id(0x71), vout: 0 }, { txid: PARENT, vout: 0 }], vout: [{ scriptpubkey: '0014' + '11'.repeat(20), value: 546 }] }],
    [PARENT, { txid: PARENT, status: confirmed, vin: [{ txid: id(0x73), vout: 0 }], vout: [{ scriptpubkey: '0014' + '22'.repeat(20), value: 546 }] }],
  ]);
  const fetchImpl = async (u) => { const t = String(u).split('/tx/')[1]; return txs.has(t) ? new Response(JSON.stringify(txs.get(t)), { status: 200 }) : new Response('not found', { status: 404 }); };
  const G = Uint8Array.of(2, 0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95, 0xce, 0x87, 0x0b, 0x07, 0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59, 0xf2, 0x81, 0x5b, 0x16, 0xf8, 0x17, 0x98);
  const fake = {
    validateOutpoint: async (a, b, c) => { c.set(`${a}:${b}`, true); return true; },
    txOutputEnvelope: () => ({ opcode: 0x22 }),
    getParentEnvelopeData: async () => ({ assetIdHex: '09'.repeat(32), commitment: G }),
  };
  const pool = { btcNoteLeaf: () => '0x' + '22'.repeat(32), nullifier: () => '0x' + '11'.repeat(32) };
  let eth = () => { throw new Error('Ethereum\'s public nodes did not answer (fetch failed)'); };
  const btc = makeEsploraBtcChain({ bases: ['http://esplora.test'], prims, builder: null, fetchImpl, tacit: fake, pool, ethGetStorageAt: async () => eth(), poolAddress: '0x' + 'ab'.repeat(20), keccak256: keccak_256, secp });
  const spender = await btc.fetchTx(SPENDER);
  await assert.rejects(btc.crossLaneBlocked(spender), (e) => e.transient === true, 'the pool could not be read: ask again');
  eth = () => '0x' + '00'.repeat(32);
  assert.equal(await btc.crossLaneBlocked(spender), null, 'read and unspent: nothing blocks');
  eth = () => '0x' + '00'.repeat(31) + '01';
  assert.match(await btc.crossLaneBlocked(spender), /evm-spent/, 'read and spent: a note already consumed is still refused');
});

test('the provider daemon gives its log to the chain view', async () => {
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../fastbridge-lp/server.mjs', import.meta.url), 'utf8'), /makeNodeBtcChain\(\{[^}]*secp, log,\s*\}\)/s);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} unread-history checks passed`);
process.exit(process.exitCode || 0);
