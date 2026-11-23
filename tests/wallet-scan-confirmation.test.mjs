// The wallet module's holdings scan reuses its whole last result while the key's outputs are the same. Their confirmation is part of "the same": a note read while its
// transaction was unconfirmed kept that state in the result, so a long-running reader (the fast bridge provider's reverse side, which sells only confirmed notes) saw its change
// note as unconfirmed for as long as it ran and advertised no stock, until it was restarted. The transaction here is a real TAC etch, the scan the real one, the explorer a stub
// that flips the output from unconfirmed to confirmed; time is moved on past the short read caches rather than waited for.
//   node tests/wallet-scan-confirmation.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { tacit, P, scalar, etchNote } from './lib/btc-sim.mjs';
import { bigintToBytes32 } from '../dapp/bulletproofs.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

tacit.wallet.priv = bigintToBytes32(scalar('wallet')); tacit.wallet.pub = P.wallet.pub;
const addr = tacit.wallet.address();
const op = etchNote({ value: 5000n, r: scalar('r1'), script: P.p2wpkhScript(P.wallet.pub) });
let confirmed = false;
const statusNow = () => ({ confirmed, ...(confirmed ? { block_height: 330000, block_time: 1700000000 } : {}) });
const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input) => {
  const url = String(input?.url ?? input);
  const p = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/chain/, '');
  if (p.endsWith(`/address/${addr}/utxo`)) return json([{ txid: op.txid, vout: 0, value: 546, status: statusNow() }]);
  if (p.endsWith(`/tx/${op.txid}`)) return json({ ...op.esplora, status: statusNow() });
  throw new Error('offline test: ' + url);
};
// the module's short read caches (15 s for the output list) lapse as the clock moves, without a wait
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
const later = (secs) => { skew += secs * 1000; };
const note = (h) => { for (const e of h.values()) for (const x of [...(e.utxos || []), ...(e.ghosts || [])]) if (x.utxo.txid === op.txid) return x; return null; };

test('a note read unconfirmed is read again once it has confirmed (the same output, a new state)', async () => {
  const h1 = await tacit.scanHoldings(true);
  assert.equal(note(h1).utxo.status.confirmed, false, 'first read: not confirmed');
  confirmed = true; later(60);
  const h2 = await tacit.scanHoldings(true);
  assert.equal(note(h2).utxo.status.confirmed, true, 'after it confirmed, the scan says so');
  assert.notEqual(h2, h1, 'a new scan, not the memo of the old one');
});

test('with nothing changed the memo is still used (the fix does not turn every scan into a full one)', async () => {
  later(60);
  const h2 = await tacit.scanHoldings(true), h3 = await tacit.scanHoldings(true);
  assert.equal(h3, h2, 'the same outputs in the same state give the same result');
});

let passed = 0;
for (const [name, fn] of tests) { try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} wallet scan confirmation checks passed`);
process.exit(process.exitCode || 0);
