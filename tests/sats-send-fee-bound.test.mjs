// Fees in dapp/tacit.js's sats send (buildAndBroadcastSatsSend).
//
// With no change output the fee is everything above the amount, and that is the fee reported. A Confirm passes the
// previewed fee as maxFee: a rebuilt fee above it by more than satsSendFeeMargin stops before signing, with nothing sent.
//
// And its sweep (the TAC page's "Combine my coins"): every coin worth its own fee, and the address's silent payments, go to this key's own address as one coin, after one fee;
// a preview says what that would be and signs nothing; a result under the least wanted stops before signing; the address passed is ignored, so a sweep can only pay this key.
//
// Run: `node tests/sats-send-fee-bound.test.mjs`

import { JSDOM } from './_jsdom.mjs';
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
const coin = (t, value) => ({ txid: t.repeat(32), vout: 0, value, status: { confirmed: true, block_height: 100 } });
let COINS = [P];

const broadcasts = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, opts = {}) => {
  const u = String(input?.url ?? input);
  if ((opts.method || 'GET').toUpperCase() === 'POST' && u.endsWith('/tx')) {
    if (!broadcasts.includes(opts.body)) broadcasts.push(opts.body);
    return new Response('0'.repeat(64), { status: 200 });
  }
  if (u.includes('/scripthash/')) return json([]);
  if (u.endsWith(`/address/${addr}/utxo`)) return json(COINS);
  if (/\/outspend\/\d+$/.test(u)) return json({ spent: false });
  if (u.endsWith('/v1/fees/recommended')) return json({ fastestFee: 2, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 });
  const m = /\/tx\/([0-9a-f]{64})$/.exec(u);
  const own = m && COINS.find((c) => c.txid === m[1] && c !== P);
  if (own) return json({ txid: own.txid, version: 2, locktime: 0, vin: [{ txid: 'ee'.repeat(32), vout: 0, witness: ['00'.repeat(71), '02' + '11'.repeat(32)], prevout: { scriptpubkey_type: 'v0_p2wpkh', value: own.value + 1000 } }], vout: [{ scriptpubkey: ownScript, scriptpubkey_type: 'v0_p2wpkh', scriptpubkey_address: addr, value: own.value }], status: own.status });
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

console.log('\nSweeping coins into one');
{
  const c = (v, sp = false) => ({ value: v, ...(sp ? { _sp: true } : {}) });
  let p = T.planSatsSweep([c(800), c(3000), c(2500)], 2);
  ok('three coins make one coin after one fee', p.ok && p.n === 3 && p.total === 6300 && p.fee === 500 && p.out === 5800);
  p = T.planSatsSweep([c(10000), c(100)], 5);
  ok('a coin worth less than its own input costs is left out', p.ok && p.n === 1 && p.total === 10000 && p.out === 9450);
  p = T.planSatsSweep([c(600), c(600)], 2, 1000);
  ok('a result under the least wanted is not ok, and says what it would be', !p.ok && p.out === 700);
  ok('a result under the dust line is not ok', !T.planSatsSweep([c(600), c(300)], 2).ok);
  ok('no coins is not ok', !T.planSatsSweep([], 2).ok && T.planSatsSweep([], 2).n === 0);
  ok('at most the largest 400 coins go in one transaction', T.planSatsSweep(Array.from({ length: 500 }, () => c(2000)), 2).n === 400);

  const before = broadcasts.length;
  COINS = [coin('c1', 3000), coin('c2', 2500), coin('c3', 800)]; T.invalidateUtxoCache?.();
  const pv = await T.buildAndBroadcastSatsSend({ sweep: { minOut: 1000 }, preview: true });
  ok('a preview says what it would be and sends nothing', pv.ok && pv.n === 3 && pv.sp === 0 && pv.fee === 500 && pv.out === 5800 && broadcasts.length === before);
  ok('and carries no coins (they hold spending keys)', pv.picked === undefined);

  let err = null;
  try { await T.buildAndBroadcastSatsSend({ sweep: { minOut: 1000 }, maxFee: 100 }); } catch (e) { err = e; }
  ok('a fee above the previewed one stops before signing', err?.feeRose === true && broadcasts.length === before);

  err = null;
  try { await T.buildAndBroadcastSatsSend({ sweep: { minOut: 9000 } }); } catch (e) { err = e; }
  ok('a result under the least wanted stops before signing, with nothing sent', /Nothing was sent/.test(err?.message || '') && broadcasts.length === before);

  const r = await T.buildAndBroadcastSatsSend({ recipientAddr: TO, sweep: { minOut: 1000 }, maxFee: 500 });
  const hex = broadcasts[broadcasts.length - 1];
  ok('it sends one transaction', broadcasts.length === before + 1);
  ok('three coins in, one coin out, no change', r.inputsSpent.length === 3 && r.recipientValue === 5800 && r.changeValue === 0 && r.fee === 500);
  ok('inputs = the coin + the fee', r.inputsSpent.reduce((s, u) => s + u.value, 0) === r.recipientValue + r.fee);
  ok('the one output pays this key whatever address was passed', hex.includes(ownScript) && !hex.includes('751e76e8199196d454941c45d1b3a323f1433bd6'));

  // a silent payment is a coin the key can spend but the address does not hold: the sweep brings it in
  T.recordSpCredit({ txidHex: 'd1'.repeat(32), vout: 0, sats: 4000, tweakHex: '11'.repeat(32), blockTime: 1700000000, keyVersion: 0 });
  COINS = [coin('c6', 1500)]; T.invalidateUtxoCache?.();
  const pv2 = await T.buildAndBroadcastSatsSend({ sweep: { minOut: 1000 }, preview: true });
  ok('a silent payment counts toward the one coin', pv2.ok && pv2.n === 2 && pv2.sp === 1 && pv2.total === 5500 && pv2.out === 5000 && pv2.picked === undefined);
  const r2 = await T.buildAndBroadcastSatsSend({ sweep: { minOut: 1000 }, maxFee: 500 });
  ok('and is spent with the address\'s own coin', r2.inputsSpent.length === 2 && r2.recipientValue === 5000 && broadcasts.length === before + 2);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
