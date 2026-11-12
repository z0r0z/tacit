// A note made by an exit from the Bitcoin shielded pool (T_BTC_SPEND, opcode 0x6d) is a note the reference provider takes: the Bitcoin
// side it reads a lock's notes with (dapp/fastbridge-btc.js resolveNote, which both the lock's output and each note it spends go through)
// resolves the real exit transaction of 2026-11-07 (fbcd761a…, the note of a lock a screening provider refused) to a TAC note, and does
// not resolve one the pool service does not know. The reference provider advertises `anyTac: true` on the strength of this.
//   node tests/fastbridge-exit-note.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTacit } from '../worker-relay/src/lib/btc-pool-transparent.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeEsploraBtcChain } from '../dapp/fastbridge-btc.js';
import { bytesToHex } from '../dapp/vendor/tacit-deps.min.js';

const here = (p) => new URL(p, import.meta.url);
const TXID = 'fbcd761a8b3e8e38af9a682179fee6df2f9a0a0f04cdbaf988359cbb9d51db66';
const TX = JSON.parse(JSON.parse(readFileSync(here('./fixtures/pool-exit-tx-2026-11-07.json'), 'utf8'))[TXID].json);
const REC = JSON.parse(readFileSync(here('./fixtures/pool-exit-record-2026-11-07.json'), 'utf8'));
const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// the pool service and an explorer, stood in for by one fetch; anything else is a read the test did not expect
// the origin the validator consults for exits once loadTacit has set it up (worker-relay's replay helper answers it from the relay's own
// exit set, which is empty here, so the stub goes in after the load)
const POOL = 'http://btc-pool.replay';
let poolSays = () => json(REC);
const reads = [];
const T = await loadTacit('mainnet');
globalThis.fetch = async (input) => {
  const u = String(input?.url ?? input);
  reads.push(u);
  if (u === `${POOL}/btc-pool/exit/${TXID}/0`) return poolSays();
  if (u === `http://esplora.test/tx/${TXID}`) return json(TX);
  throw new Error('offline test: ' + u);
};
const { prims } = makeBtcWallet({ priv: new Uint8Array(32).fill(7), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
const btc = makeEsploraBtcChain({ bases: ['http://esplora.test'], prims, builder: null, fetchImpl: (...a) => globalThis.fetch(...a), tacit: T });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const fresh = () => { if (typeof T.clearBtcPoolExitCache === 'function') T.clearBtcPoolExitCache(); };

test('an exit note is a TAC note to the reference provider: the commitment and asset are the pool service\'s record of the exit', async () => {
  fresh(); poolSays = () => json(REC);
  const note = await btc.resolveNote(TXID, 0);
  assert.ok(note, 'the exit note resolves');
  assert.equal(note.assetIdHex.replace(/^0x/, ''), TAC);
  const cx = REC.Cx.replace(/^0x/, ''), cy = REC.Cy.replace(/^0x/, '');
  assert.equal(bytesToHex(note.commitment), ((parseInt(cy.slice(-2), 16) & 1) ? '03' : '02') + cx, 'the commitment the exit made');
});

test('an exit the pool service does not know is no note, and neither is one it cannot be asked about', async () => {
  fresh(); poolSays = () => json({ exists: false, height: 975075 });
  assert.equal(await btc.resolveNote(TXID, 0), null, 'a transaction that looks like an exit and is not one');
  // not told is not the same as told no: a pool service that does not answer is a read that failed, said as one to try again, and never a
  // verdict on the user's note (the provider answers an offer it cannot judge with "ask again", and declines only a note it found not valid)
  fresh(); poolSays = () => json({ error: 'down' }, 503);
  await assert.rejects(btc.resolveNote(TXID, 0), (e) => e.transient === true && /could not be read just now/.test(e.message), 'not told: ask again');
  fresh(); poolSays = () => { throw new Error('connect ETIMEDOUT'); };
  await assert.rejects(btc.resolveNote(TXID, 0), (e) => e.transient === true, 'the pool service unreachable: ask again');
  fresh(); poolSays = () => json({ ...REC, asset: '0x' + '11'.repeat(32) });
  const other = await btc.resolveNote(TXID, 0);
  assert.ok(!other || other.assetIdHex.replace(/^0x/, '') !== TAC, 'an exit of another asset is not TAC');
});

test('the reference provider never looks at a note\'s history with the bridge\'s trace, which is what its `anyTac` claim rests on', () => {
  for (const f of ['../dapp/fastbridge-el.js', '../dapp/fastbridge-bl.js', '../dapp/fastbridge-provider.js', '../dapp/fastbridge-btc.js', '../dapp/fastbridge-evm.js']) {
    assert.doesNotMatch(readFileSync(here(f), 'utf8'), /burndep|reflection\/burndep|lineage/i, `${f} screens notes: its ad must not say anyTac`);
  }
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
const stray = reads.filter((u) => !u.startsWith(POOL) && !u.startsWith('http://esplora.test'));
if (stray.length) { console.log('reads the test did not expect:', [...new Set(stray)]); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} exit-note checks passed`);
process.exit(process.exitCode || 0);
