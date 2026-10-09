// combinePlan, the count of joins of the two largest notes a payment needs before two notes cover it, and combineNotes,
// which makes one: the two largest live notes paid to the wallet's own pool address as one note, less the relay's fee when
// the relay posts it, shown as settling until the pool counts it. The pool client, the prover and the carrier are stubbed.
//   node tests/secret-combine-notes.test.mjs

import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const secret = await import('../dapp/sats/secret.js');
const { pool, combinePlan } = secret;
const client = secret.poolClientFor('mainnet');
const ASSET = secret.TAC_ASSET_MAINNET;
const pw = secret.poolWalletFor(new Uint8Array(32).fill(7), 'mainnet');
const T = 10n ** 8n;

// ── combinePlan ──
assert.equal(combinePlan([5n * T, 4n * T], 9n * T, 0n), 0, 'two notes that cover it need no join');
assert.equal(combinePlan([9n * T], 9n * T, 0n), 0, 'one note that covers it needs no join');
assert.equal(combinePlan([5n * T, 4n * T, 3n * T], 10n * T, 0n), 1, 'one join, posted from the Bitcoin address');
assert.equal(combinePlan([5n * T, 4n * T, 3n * T], 12n * T, 0n), 1, 'all three, joined once, cover their total');
assert.equal(combinePlan([5n * T, 4n * T, 3n * T], 12n * T, 1n), null, 'with a fee, all three no longer cover their total');
assert.equal(combinePlan([5n * T, 4n * T, 3n * T, 2n * T, 1n * T], 12n * T, T / 10n), 2, 'two joins, each paying the fee');
assert.equal(combinePlan(['300', '200', '100', '0', '0'], '550', '10'), 1, 'strings, and zero-value padding notes, are read');
assert.equal(combinePlan([T, T, T, T, T, T, T, T], 8n * T - 6n * (T / 100n), T / 100n), 6, 'all of eight notes, less six fees, take six joins: the payment spends the last two');
assert.equal(combinePlan([T], 2n * T, 0n), null, 'more than all of them');
assert.equal(combinePlan([T, T], 3n * T, 0n), null);
assert.equal(combinePlan([10n, 10n, 10n], 25n, 20n), null, 'a fee that eats both notes ends the plan');
assert.equal(combinePlan([], 1n, 0n), null);

// ── combineNotes ──
const notes = [
  { asset: '0x' + ASSET, value: String(3n * T), nf: '0x01', txid: 'a1'.repeat(32), leafIndex: 0 },
  { asset: '0x' + ASSET, value: String(5n * T), nf: '0x02', txid: 'a2'.repeat(32), leafIndex: 1 },
  { asset: '0x' + ASSET, value: '0', nf: '0x03', txid: 'a2'.repeat(32), leafIndex: 2 },
  { asset: '0x' + ASSET, value: String(4n * T), nf: '0x04', txid: 'a3'.repeat(32), leafIndex: 3 },
];
let log;
function stub({ fee = 1000n, carrier = 'cc'.repeat(32) } = {}) {
  mem.clear();
  log = { built: [], posts: 0 };
  client.relayInfo = async () => (fee == null ? null : { fees: { ['0x' + ASSET]: fee.toString() } });
  client.quote = async () => ({ fee: fee.toString(), address: secret.poolWalletFor(new Uint8Array(32).fill(9), 'mainnet').addressString, bind: { txid: 'bb'.repeat(32), vout: 0 }, quoteId: 'q1' });
  client.submit = async () => ({ id: 's1' });
  client.relayStatus = async () => ({ carrier });
  client.walletNotes = async () => notes;
  client.anchorAndPaths = async (inputs) => ({ hAnchor: 900000, root: '0x00', notes: inputs, tip: 900010 });
  secret.poolClient.artifactBytes = async () => 0;
  secret.poolClient.system = async () => ({});
  pool.buildSpendBody = (o) => { log.built.push(o); return {}; };
  pool.prove = async () => ({ payload: new Uint8Array(4), payloadHex: '00000000' });
}
const tacit = { DUST: 546, p2wpkhScript: () => new Uint8Array(22), wallet: { pub: new Uint8Array(33), xonly() { log.posts++; throw new Error('SELF_POST'); } } };
const combine = (o = {}) => secret.combineNotes(tacit, { poolWallet: pw, asset: ASSET, ...o });

// Relayed: the two largest notes, paid to the wallet's own pool address as one note, less the relay's fee.
stub();
const r = await combine({ maxFee: 1000n });
assert.equal(r.relayed, true); assert.equal(r.revealTxid, 'cc'.repeat(32)); assert.equal(r.value, 9n * T - 1000n);
const b = log.built[0];
assert.deepEqual(b.inputs.map((n) => n.leafIndex), [1, 3], 'the two largest notes, the 5 and the 4');
assert.equal(b.outputs.length, 2, 'one output to itself and the relay’s fee');
assert.equal(b.outputs[0].address, pw.addressString); assert.equal(b.outputs[0].value, 9n * T - 1000n);
assert.equal(b.outputs[1].value, 1000n);
let v = secret.pendingView(notes, ASSET, pw);
assert.deepEqual(v.live.map((n) => n.leafIndex), [0, 2], 'the joined notes are held as spent');
assert.equal(v.settling, 9n * T - 1000n, 'the new note shows as settling');
assert.equal(secret.pendingView([...notes, { ...notes[0], txid: 'cc'.repeat(32), leafIndex: 9 }], ASSET, pw).settling, 0n, 'until the pool counts it');

// A relayed join needs its fee ceiling; a relay that quotes more than it is refused before anything is proved.
stub();
await assert.rejects(combine({}), /needs maxFee/);
stub({ fee: 2000n });
await assert.rejects(combine({ maxFee: 1000n }), (e) => e.feeMoved === 2000n);
assert.equal(log.built.length, 0);

// From the Bitcoin address: the whole of both notes, no fee output.
stub({ fee: null });
await assert.rejects(combine({ noRelay: true }), /SELF_POST/);
assert.equal(log.built[0].outputs.length, 1); assert.equal(log.built[0].outputs[0].value, 9n * T);

// One note, or two holding less than the fee: nothing to do, said plainly.
stub();
client.walletNotes = async () => [notes[1], notes[2]];
await assert.rejects(combine({ maxFee: 1000n }), (e) => e.said && /one note/.test(e.message));
client.walletNotes = async () => [{ ...notes[0], value: '600' }, { ...notes[1], value: '400' }];
await assert.rejects(combine({ maxFee: 1000n }), (e) => e.said && /less than the relay’s fee/.test(e.message));

console.log('secret-combine-notes: all checks passed');
