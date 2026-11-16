// A 404 for a transaction from one explorer is not an answer while the others have not been asked.
//
// The wallet's explorer reader (dapp/tacit.js) rotates its reads over the explorers and rests the ones that fail, but a 404 from whichever answered first
// ended the read at once: a mirror that lags the chain, or has not indexed a transaction yet, says 404 for what another has, and the page took the
// transaction for one that is not there (and kept that for an hour). Now up to three explorers are asked before a 404 stands.
// Mocked explorers; no network.
//
// Run (Node 22): node --no-experimental-global-navigator tests/explorer-404-rotation.test.mjs
import assert from 'node:assert/strict';
import { JSDOM } from './_jsdom.mjs';

const dom = new JSDOM('', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, location: dom.window.location, __TACIT_NO_INIT__: true });
if (!globalThis.navigator) globalThis.navigator = dom.window.navigator;
localStorage.setItem('tacit-network-v1', 'mainnet');

const hex = (n) => n.toString(16).padStart(64, '0');
const asked = [];
const mode = { lagging: 'mempool.space', missing: false };
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input), u = new URL(url);
  if ((init?.method || 'GET').toUpperCase() === 'POST') throw new Error('offline: ' + url);
  const m = /\/tx\/([0-9a-f]{64})$/.exec(u.pathname);
  if (!m) throw new Error('offline: ' + url);
  asked.push(u.host);
  if (mode.missing || u.host === mode.lagging) return new Response('Transaction not found', { status: 404 });
  return new Response(JSON.stringify({ txid: m[1], status: { confirmed: true, block_height: 900000, block_time: 1700000000 }, vin: [], vout: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const T = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; } };

{
  // eight transactions that a lagging mirror does not have and another explorer does: the reads are taken in turn over the explorers, so the lagging one
  // comes first for some of them; none is taken for missing
  const got = [];
  for (let n = 1; n <= 8; n++) got.push(await T.getTx(hex(0x100 + n)));
  ok('a transaction the first explorer lacks is read from another', got.every((t) => t && t.txid), JSON.stringify(got.map((t) => !!t)));
  ok('and the lagging explorer was among those asked', asked.includes('mempool.space'));
}
{
  // a transaction nobody has: the 404 stands, after at most three explorers were asked
  mode.missing = true; asked.length = 0;
  const t = await T.getTx(hex(0x900));
  ok('a transaction no explorer has is not found', t === null);
  ok('after at most three explorers were asked', asked.length >= 1 && asked.length <= 3, String(asked.length));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
