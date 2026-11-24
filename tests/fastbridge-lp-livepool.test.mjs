// The provider daemon reads a user's notes against the pool service itself. loadTacit (worker-relay) answers the pool's exit consult from a
// replay's own exit set unless it is told `livePool`, and that set is empty outside a replay: every note that came out of the Bitcoin shielded
// pool, which the fast bridge exists to move, then reads as not valid, and the provider declines the lock with "the opening does not match the
// note; the output is not a valid note of the asset". The house provider did exactly that to a user's 1,000 TAC bridge (2026-11-12).
//   node tests/fastbridge-lp-livepool.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTacit } from '../worker-relay/src/lib/btc-pool-transparent.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeEsploraBtcChain } from '../dapp/fastbridge-btc.js';
import { bpRangeAggProve, pointToBytes, randomScalar } from './bulletproofs.mjs';

const here = (p) => new URL(p, import.meta.url);
const TXID = 'fbcd761a8b3e8e38af9a682179fee6df2f9a0a0f04cdbaf988359cbb9d51db66';
const TX = JSON.parse(JSON.parse(readFileSync(here('./fixtures/pool-exit-tx-2026-11-07.json'), 'utf8'))[TXID].json);
const REC = JSON.parse(readFileSync(here('./fixtures/pool-exit-record-2026-11-07.json'), 'utf8'));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const LIVE = 'https://tacit-btc-pool-mainnet.onrender.com', REPLAY = 'http://btc-pool.replay';
const T = await loadTacit('mainnet', { livePool: true });
const asked = [];
globalThis.fetch = async (input) => {
  const u = String(input?.url ?? input);
  asked.push(u);
  if (u === `${LIVE}/btc-pool/exit/${TXID}/0`) return json(REC);
  if (u === `http://esplora.test/tx/${TXID}`) return json(TX);
  throw new Error('offline test: ' + u);
};
const { prims } = makeBtcWallet({ priv: new Uint8Array(32).fill(7), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
const btc = makeEsploraBtcChain({ bases: ['http://esplora.test'], prims, builder: null, fetchImpl: (...a) => globalThis.fetch(...a), tacit: T });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('with the live pool, a note that came out of the pool is read against the pool service itself, and is a TAC note', async () => {
  T.clearBtcPoolExitCache && T.clearBtcPoolExitCache();
  const note = await btc.resolveNote(TXID, 0);
  assert.ok(note, 'the exit note resolves');
  assert.ok(asked.includes(`${LIVE}/btc-pool/exit/${TXID}/0`), 'the exit was asked of the pool service');
  assert.ok(!asked.some((u) => u.startsWith(REPLAY)), 'and not of a replay\'s exit set');
});

test('the provider daemon loads the note validator with the live pool: the line that made every pool-exit note read as invalid stays fixed', () => {
  const server = readFileSync(here('../fastbridge-lp/server.mjs'), 'utf8');
  assert.match(server, /loadTacit\(network, \{ livePool: true \}\)/, 'fastbridge-lp/server.mjs must not load the validator with the replay\'s exit set');
});

test('a note the pool service says is not an exit is invalid (a verdict), and one it cannot be asked about is a read to try again (not a verdict)', async () => {
  const pool = { says: () => json({ exists: false, height: 975075 }) };
  const prev = globalThis.fetch;
  globalThis.fetch = async (input, ...r) => (String(input?.url ?? input) === `${LIVE}/btc-pool/exit/${TXID}/0` ? pool.says() : prev(input, ...r));
  T.clearBtcPoolExitCache && T.clearBtcPoolExitCache();
  assert.equal(await btc.resolveNote(TXID, 0), null, 'the pool says no: the note is not valid');
  pool.says = () => json({ error: 'down' }, 503);
  T.clearBtcPoolExitCache && T.clearBtcPoolExitCache();
  await assert.rejects(btc.resolveNote(TXID, 0), (e) => e.transient === true, 'the pool service is down: ask again');
  pool.says = () => json({ exists: false, height: 1 });
  T.clearBtcPoolExitCache && T.clearBtcPoolExitCache();
  await assert.rejects(btc.resolveNote(TXID, 0), (e) => e.transient === true, 'a pool service that has not indexed up to the transaction cannot say no yet: ask again');
  globalThis.fetch = prev;
});

test('a long note history gives the event loop a real turn between its reads, and what was proved valid is not walked again', async () => {
  // Render's health check asks every few seconds and restarts a process that does not answer: a history walked in one go held the house provider
  // for minutes (170 s on a real lock). Awaits on reads already in hand give microtasks a turn, not the I/O the health check waits on.
  let turns = 0, going = true;
  const tick = () => { if (!going) return; turns++; setImmediate(tick); };
  tick();
  const marker = { stop: () => { going = false; } };
  const seen = [];
  const fake = {
    validateOutpoint: async (txid, vout, set, fetchTx) => {
      seen.push([...set.keys()]);
      const before = turns;
      for (let i = 0; i < 12; i++) await fetchTx(`${i.toString(16).repeat(64).slice(0, 64)}`);
      // the walk reads the transactions it proves (only what a walk read is kept as proved)
      await fetchTx('ee'.repeat(32)); await fetchTx(txid);
      seen.at(-1).turns = turns - before;
      set.set('ee'.repeat(32) + ':0', true); set.set(`${txid}:${vout}`, true);
      return true;
    },
    txOutputEnvelope: () => ({ opcode: 0x22 }),
    getParentEnvelopeData: async () => ({ assetIdHex: 'ab'.repeat(32), commitment: new Uint8Array(33) }),
  };
  const prev = globalThis.fetch;
  globalThis.fetch = async (u) => { const id = String(u).match(/\/tx\/([0-9a-f]{64})/); return json(id ? { ...TX, txid: id[1] } : TX); };
  const chain = makeEsploraBtcChain({ bases: ['http://esplora.test'], prims, builder: null, fetchImpl: (...a) => globalThis.fetch(...a), tacit: fake });
  try {
    assert.ok(await chain.resolveNote('11'.repeat(32), 0));
    assert.ok(seen[0].turns >= 10, `the loop had a turn between reads (${seen[0].turns} turns in 12 reads)`);
    assert.equal(seen[0].length, 0, 'the first walk starts from nothing');
    assert.ok(await chain.resolveNote('22'.repeat(32), 1));
    assert.ok(seen[1].includes('ee'.repeat(32) + ':0') && seen[1].includes('11'.repeat(32) + ':0'), 'what the first walk proved valid is there at the start of the next');
  } finally { marker.stop(); globalThis.fetch = prev; }
});

test('a note that spends a pool-exit note: the pool service that cannot be asked is a read to try again, and only its "not an exit" is a verdict', async () => {
  // the exit note is already proved (an earlier lock's walk), so only the child's own read of the exit touches the pool service: a 503 there used to leave
  // the child "not valid", and the provider declined the lock for good
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const CHILD = 'c1'.repeat(32);
  const REAL = bpRangeAggProve([5n], [randomScalar()]);   // a real range proof: a transfer is checked for one before its history is read
  const payload = T.encodeCXferPayload({ assetId: new Uint8Array(32).fill(9), kernelSig: new Uint8Array(64).fill(1), outputs: [{ commitment: pointToBytes(REAL.commitments[0]), encryptedAmount: new Uint8Array(8) }], rangeproof: REAL.proof });
  const child = {
    txid: CHILD, status: { confirmed: true, block_height: 976000, block_time: 1700000000 },
    vin: [
      { txid: 'c2'.repeat(32), vout: 0, witness: [hex(new Uint8Array(64)), hex(T.encodeEnvelopeScript(new Uint8Array(32).fill(4), payload)), hex(new Uint8Array(33))], prevout: { scriptpubkey_type: 'v1_p2tr' } },
      { txid: TXID, vout: 0, witness: [hex(new Uint8Array(71)), hex(new Uint8Array(33))], prevout: { scriptpubkey_type: 'v0_p2wpkh' } },
    ],
    vout: [{ scriptpubkey: '0014' + '11'.repeat(20), value: 546 }],
  };
  const pool = { says: () => json(REC) };
  const prev = globalThis.fetch;
  globalThis.fetch = async (input, ...r) => {
    const u = String(input?.url ?? input);
    if (u === `http://esplora.test/tx/${CHILD}`) return json(child);
    if (u === `${LIVE}/btc-pool/exit/${TXID}/0`) return pool.says();
    return prev(input, ...r);
  };
  try {
    T.clearBtcPoolExitCache && T.clearBtcPoolExitCache();
    assert.ok(await btc.resolveNote(TXID, 0), 'the exit note itself is valid, and kept as proved');
    pool.says = () => json({ error: 'down' }, 503);
    T.clearBtcPoolExitCache && T.clearBtcPoolExitCache();
    await assert.rejects(btc.resolveNote(CHILD, 0), (e) => e.transient === true, 'the pool service is down: ask again, the child is not "not valid"');
    pool.says = () => json({ exists: false, height: 975075 });
    T.clearBtcPoolExitCache && T.clearBtcPoolExitCache();
    assert.equal(await btc.resolveNote(CHILD, 0), null, 'the pool says it is not an exit: a verdict');
  } finally { globalThis.fetch = prev; }
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} live-pool checks passed`);
process.exit(process.exitCode || 0);
