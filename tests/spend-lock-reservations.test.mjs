// Coin selection waits for the cBTC lock reservations in dapp/tacit.js.
//
// Early cBTC locks paid their BTC to the wallet's own address, and the list of reserved lock outpoints is rebuilt
// from chain before the first pick. A spend (getUtxos with { forSpend: true }, pickSafeCommitSats, the sats send)
// stops with nothing sent when that rebuild fails; a balance read still goes ahead. pickSafeCommitSats drops a
// reserved outpoint even from a list a balance read fetched.
//
// Run: `node tests/spend-lock-reservations.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;
globalThis.__TACIT_NO_INIT__ = true;
localStorage.setItem('tacit-network-v1', 'mainnet');

let historyUp = false;
const posts = [];
let utxos = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, opts = {}) => {
  const u = String(input?.url ?? input);
  if ((opts.method || 'GET').toUpperCase() === 'POST') { posts.push(u); return new Response('0'.repeat(64), { status: 200 }); }
  if (u.includes('/scripthash/')) {
    if (!historyUp) throw new Error('offline: history');
    return json([]);
  }
  if (/\/address\/[a-z0-9]+\/utxo$/.test(u)) return json(utxos);
  if (u.endsWith('/v1/fees/recommended')) return json({ fastestFee: 2, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 });
  if (/\/tx\/[0-9a-f]{64}\/outspend\/\d+$/.test(u)) return json({ spent: false });
  if (/\/tx\/[0-9a-f]{64}$/.test(u)) return json({ txid: u.slice(-64), vin: [{ witness: [] }], vout: [{ value: 50000 }], status: { confirmed: true } });
  throw new Error('offline: ' + u);
};

const { secp } = await import('../dapp/vendor/tacit-deps.min.js');
const { protectOutpoint, unprotectOutpoint } = await import('../dapp/confidential-deployments.js');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
};
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };
// A fresh copy of tacit.js per scenario: the reservations are rebuilt once a session, and a failed history read is
// retried after a minute.
let loads = 0;
async function load() {
  const T = await import(`../dapp/tacit.js?load=${++loads}`);
  const priv = new Uint8Array(32); priv[31] = 9;
  T.wallet.priv = priv; T.wallet.pub = secp.getPublicKey(priv, true);
  return T;
}
const A = { txid: 'a1'.repeat(32), vout: 0, value: 50000, status: { confirmed: true } };
const LOCK = { txid: 'b2'.repeat(32), vout: 1, value: 30000, status: { confirmed: true } };
utxos = [A, LOCK];
const UNREAD = /Could not read your locked coins just now, so nothing was sent/;

console.log('The lock reservations cannot be read');
historyUp = false;
{
  const T = await load();
  const addr = T.wallet.address();
  const shown = await T.getUtxos(addr);
  ok('a balance read still lists the coins', shown.length === 2);
  const e = await err(T.getUtxos(addr, null, { forSpend: true }));
  ok('coin selection stops and says nothing was sent', UNREAD.test(e?.message || ''));
  const e2 = await err(T.pickSafeCommitSats(shown));
  ok('commit funding stops too, even from a balance read\'s list', UNREAD.test(e2?.message || ''));
  const e3 = await err(T.buildAndBroadcastSatsSend({ recipientAddr: addr, amountSats: 10000 }));
  ok('a sats send stops', UNREAD.test(e3?.message || ''));
  ok('nothing was broadcast', posts.length === 0);
}

console.log('\nThe reservations read (one lock reserved)');
historyUp = true;
protectOutpoint(LOCK.txid, LOCK.vout, 30000n);
{
  const T = await load();
  const picked = await T.getUtxos(T.wallet.address(), null, { forSpend: true });
  ok('coin selection goes ahead without the lock outpoint', picked.length === 1 && picked[0].txid === A.txid);
  const safe = await T.pickSafeCommitSats([A, LOCK]);
  ok('commit funding drops the lock outpoint from a list passed in', safe.length === 1 && safe[0].txid === A.txid);
}
unprotectOutpoint(LOCK.txid, LOCK.vout);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
