// Send bookkeeping in dapp/tacit.js's sats send (buildAndBroadcastSatsSend).
//
// A silent-payment credit spent by a send is marked with the spending txid at broadcast, not deleted: it is out of
// selection and the balance while the spend is unconfirmed or not yet indexed, pruned once a spend of it confirms,
// and spendable again if the spend is gone. The send's inputs are marked spent and the UTXO cache dropped, so the
// next pick never reuses them while the index lags.
//
// Run: `node tests/sp-credit-spend-mark.test.mjs`

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

const { secp, bytesToHex } = await import('../dapp/vendor/tacit-deps.min.js');
const T = await import('../dapp/tacit.js');

const priv = new Uint8Array(32); priv[31] = 11;
T.wallet.priv = priv; T.wallet.pub = secp.getPublicKey(priv, true);
const addr = T.wallet.address();
const ownScript = bytesToHex(T.p2wpkhScript(T.wallet.pub));
const P = { txid: 'a1'.repeat(32), vout: 0, value: 60000, status: { confirmed: true, block_height: 100 } };
const C = { txid: 'c3'.repeat(32), vout: 1, sats: 40000 };

let utxoReads = 0;
const outspend = new Map();        // "txid:vout" -> { spent, status }
const goneTx = new Set();          // spending txids no node knows
const broadcasts = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, opts = {}) => {
  const u = String(input?.url ?? input);
  if ((opts.method || 'GET').toUpperCase() === 'POST' && u.endsWith('/tx')) {
    if (!broadcasts.includes(opts.body)) broadcasts.push(opts.body);
    return new Response('0'.repeat(64), { status: 200 });
  }
  if (u.includes('/scripthash/')) return json([]);
  if (u.endsWith(`/address/${addr}/utxo`)) { utxoReads++; return json([P]); }
  if (u.endsWith('/v1/fees/recommended')) return json({ fastestFee: 2, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 });
  let m = /\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/.exec(u);
  if (m) return json(outspend.get(`${m[1]}:${m[2]}`) || { spent: false });
  m = /\/tx\/([0-9a-f]{64})\/status$/.exec(u);
  if (m) return goneTx.has(m[1]) ? new Response('Transaction not found', { status: 404 }) : json({ confirmed: false });
  m = /\/tx\/([0-9a-f]{64})$/.exec(u);
  if (m && m[1] === P.txid) return json({ txid: P.txid, version: 2, locktime: 0, vin: [{ txid: 'ee'.repeat(32), vout: 0, witness: ['00'.repeat(71), '02' + '11'.repeat(32)], prevout: { scriptpubkey_type: 'v0_p2wpkh', value: 70000 } }], vout: [{ scriptpubkey: ownScript, scriptpubkey_type: 'v0_p2wpkh', scriptpubkey_address: addr, value: P.value }], status: P.status });
  if (m) return new Response('Transaction not found', { status: 404 });
  throw new Error('offline: ' + u);
};

// Chain reads are cached for some seconds (15s for an outspend): the clock moves on between chain states.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const later = () => { skew += 20_000; };

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
};
const key = `${C.txid}:${C.vout}`;
const credit = () => T.loadSpCredits()[key];
const unspentKeys = async () => (await T.loadUnspentSpCredits()).map((u) => `${u.txid}:${u.vout}`);

T.recordSpCredit({ txidHex: C.txid, vout: C.vout, sats: C.sats, tweakHex: '07'.repeat(32), blockTime: 1, keyVersion: 0 });
ok('the credit starts spendable', (await unspentKeys()).includes(key));

console.log('A send that spends the credit and the plain coin');
const r = await T.buildAndBroadcastSatsSend({ recipientAddr: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amountSats: 90000 });
ok('sent, spending both', broadcasts.length === 1 && r.inputsSpent.length === 2);
ok('the credit is kept, marked with the spending txid', credit()?.spendingTxid === r.txid);
ok('it leaves selection while the spend is not indexed', !(await unspentKeys()).includes(key));
const before = utxoReads;
const after = await T.getUtxos(addr);
ok('the UTXO cache was dropped (a fresh read)', utxoReads === before + 1);
ok('the plain coin the send spent is not offered again while the index still lists it', !after.some((u) => u.txid === P.txid));

console.log('\nThe spend is seen, then confirms');
outspend.set(key, { spent: true, txid: r.txid, status: { confirmed: false } });
later();
ok('unconfirmed spend: out of selection, record kept', !(await unspentKeys()).includes(key) && !!credit());
T.recordSpCredit({ txidHex: C.txid, vout: C.vout, sats: C.sats, tweakHex: '07'.repeat(32), blockTime: 1, keyVersion: 0 });
ok('a rescan of the receiving tx keeps the spend mark', credit()?.spendingTxid === r.txid);
outspend.set(key, { spent: true, txid: r.txid, status: { confirmed: true } });
later();
await unspentKeys();
ok('confirmed spend: the record is pruned', credit() === undefined);

console.log('\nA spend that is gone');
T.recordSpCredit({ txidHex: C.txid, vout: C.vout, sats: C.sats, tweakHex: '07'.repeat(32), blockTime: 1, keyVersion: 0 });
outspend.delete(key);
later();
const lost = 'dd'.repeat(32);
T.markSpCreditSpending(C.txid, C.vout, lost);
ok('just marked: out of selection', !(await unspentKeys()).includes(key));
credit().spendingAt = Date.now() - 11 * 60_000;
ok('still known to a node: out of selection', !(await unspentKeys()).includes(key));
goneTx.add(lost);
later();
ok('no node knows the spend: spendable again', (await unspentKeys()).includes(key) && !credit().spendingTxid);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
