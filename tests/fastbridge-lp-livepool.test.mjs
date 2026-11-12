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

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} live-pool checks passed`);
process.exit(process.exitCode || 0);
