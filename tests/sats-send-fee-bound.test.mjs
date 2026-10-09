// Fees in dapp/tacit.js's sats send (buildAndBroadcastSatsSend).
//
// With no change output the fee is everything above the amount, and that is the fee reported. A Confirm passes the
// previewed fee as maxFee: a rebuilt fee above it by more than satsSendFeeMargin stops before signing, with nothing sent.
//
// Run: `node tests/sats-send-fee-bound.test.mjs`

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
const priv = new Uint8Array(32); priv[31] = 13;
T.wallet.priv = priv; T.wallet.pub = secp.getPublicKey(priv, true);
const addr = T.wallet.address();
const ownScript = bytesToHex(T.p2wpkhScript(T.wallet.pub));
const P = { txid: 'a7'.repeat(32), vout: 0, value: 60000, status: { confirmed: true, block_height: 100 } };

const broadcasts = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, opts = {}) => {
  const u = String(input?.url ?? input);
  if ((opts.method || 'GET').toUpperCase() === 'POST' && u.endsWith('/tx')) {
    if (!broadcasts.includes(opts.body)) broadcasts.push(opts.body);
    return new Response('0'.repeat(64), { status: 200 });
  }
  if (u.includes('/scripthash/')) return json([]);
  if (u.endsWith(`/address/${addr}/utxo`)) return json([P]);
  if (u.endsWith('/v1/fees/recommended')) return json({ fastestFee: 2, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 });
  const m = /\/tx\/([0-9a-f]{64})$/.exec(u);
  if (m && m[1] === P.txid) return json({ txid: P.txid, version: 2, locktime: 0, vin: [{ txid: 'ee'.repeat(32), vout: 0, witness: ['00'.repeat(71), '02' + '11'.repeat(32)], prevout: { scriptpubkey_type: 'v0_p2wpkh', value: 70000 } }], vout: [{ scriptpubkey: ownScript, scriptpubkey_type: 'v0_p2wpkh', scriptpubkey_address: addr, value: P.value }], status: P.status });
  throw new Error('offline: ' + u);
};

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
};
const TO = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

console.log('The rebuilt fee is above the previewed one');
{
  let err = null;
  try { await T.buildAndBroadcastSatsSend({ recipientAddr: TO, amountSats: 59000, maxFee: 300 }); } catch (e) { err = e; }
  ok('Confirm stops before signing', err?.feeRose === true && /up from 300 in the preview\. Nothing was sent/.test(err.message));
  ok('nothing was broadcast', broadcasts.length === 0);
  ok('the margin is 10% with a 100-sat floor', T.satsSendFeeMargin(300) === 100 && T.satsSendFeeMargin(5000) === 500);
}

console.log('\nNo change output');
{
  const r = await T.buildAndBroadcastSatsSend({ recipientAddr: TO, amountSats: 59000, maxFee: 950 });
  ok('within the margin it is sent', broadcasts.length === 1);
  ok('the fee reported is everything above the amount', r.fee === 1000 && r.changeValue === 0 && r.recipientValue === 59000);
  ok('inputs = amount + reported fee', r.inputsSpent.reduce((s, u) => s + u.value, 0) === r.recipientValue + r.fee);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
