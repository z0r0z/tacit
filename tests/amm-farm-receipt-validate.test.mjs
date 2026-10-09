// dapp/tacit.js validateOutpoint on farm-minted notes (T_LP_HARVEST reward, T_LP_UNBOND lp_return) — network-free.
//
// A farm mint carries no commitment on chain: its note is the one the worker decreed when it applied the op, read
// from /amm/farm-receipt. Builds real envelopes and runs them through the dapp validator with the worker stubbed:
//   - a receipt that matches the envelope (amount, public blinding, vout 1, a commitment that opens) validates,
//     and a later spend reads the note from it (getParentEnvelopeData);
//   - a receipt that disagrees with the envelope, another vout, or a final missing receipt is invalid;
//   - a receipt not yet decided or an unreachable worker is transient (unavailable under strict validation);
//   - a worker with no receipt route leaves the output uncredited by the validator, as before.
//
// Run: node tests/amm-farm-receipt-validate.test.mjs

import * as secp from '@noble/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { randomBytes } from 'node:crypto';
import { pointToBytes, randomScalar, pedersenCommit } from './bulletproofs.mjs';
import { encodeEnvelopeScript } from './indexer.mjs';
import { encodeLpHarvest, encodeLpUnbond } from '../dapp/amm-envelope.js';

const store = new Map();
const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : el()), apply: () => el(), set: () => true });
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), addEventListener() {}, body: el(), head: el(), documentElement: el(), readyState: 'complete' };
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear(), key: i => [...store.keys()][i] ?? null, get length() { return store.size; } };
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', hash: '', search: '', pathname: '/', protocol: 'http:', host: 'localhost', hostname: 'localhost' };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true, language: 'en' }, configurable: true }); } catch {}
globalThis.addEventListener = () => {};
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.__TACIT_WORKER_BASE__ = 'https://worker.test';
store.set('tacit-network-v1', 'signet');

// Worker stub: the receipt answer per txid; `route: false` answers 404 for the route itself.
const W = { receipts: new Map(), scanned: 200, route: true, down: false };
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.origin !== 'https://worker.test') throw new TypeError('offline');
  if (W.down) throw new TypeError('Failed to fetch');
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/amm/farm-receipt') {
    if (!W.route) return json({ error: 'not found' }, 404);
    const rec = W.receipts.get(u.searchParams.get('txid'));
    return json(rec ? { found: true, kind: rec.kind, farm_id: rec.farm_id, note: rec.note, scanned_height: W.scanned }
                    : { found: false, kind: null, note: null, scanned_height: W.scanned });
  }
  return json({ error: 'not found' }, 404);
};

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; }
};

let counter = 0;
const nextTxid = () => { const b = new Uint8Array(32); new DataView(b.buffer).setUint32(28, ++counter, false); b[0] = 0x6f; return bytesToHex(b); };
const txs = new Map();
const fetchTx = async (id) => txs.get(id) || null;
const XONLY = secp.getPublicKey(randomBytes(32), true).slice(1);
function farmTx(payload, h = 100) {
  const txid = nextTxid();
  const script = encodeEnvelopeScript(XONLY, payload);
  txs.set(txid, {
    txid, status: { confirmed: true, block_height: h },
    vin: [{ txid: nextTxid(), vout: 0, witness: [bytesToHex(new Uint8Array(64)), bytesToHex(script), bytesToHex(new Uint8Array(33))] }],
    vout: [{ scriptpubkey: '6a20' + '00'.repeat(32), value: 0 }, { scriptpubkey: '0014' + '11'.repeat(20), value: 546 }],
  });
  return txid;
}
async function verdict(txid, vout) {
  dapp.clearValidatorCaches();
  const set = new Map(), reasons = new Map();
  const v = await dapp.validateOutpoint(txid, vout, set, fetchTx, 0, null, null, null, reasons);
  return { v, reason: reasons.get(`${txid}:${vout}`) || null };
}
const scalarBytes = (s) => { const b = new Uint8Array(32); let x = s; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };

const FARM = new Uint8Array(32).fill(7), REWARD_ASSET = 'aa'.repeat(32), LP_ASSET = 'bb'.repeat(32);
const rewardR = randomScalar(), rewardAmount = 70n;
const harvest = encodeLpHarvest({
  farmId: FARM, bondId: new Uint8Array(36).fill(3), harvesterPubkey: secp.getPublicKey(randomBytes(32), true),
  exitAccPerShare: 0n, exitViewHeight: 99, rewardAmount, rewardR: scalarBytes(rewardR),
  ownerCommit: new Uint8Array(32).fill(4), oldNonce: new Uint8Array(32).fill(5), shares: 1000n, harvesterSig: new Uint8Array(64),
});
const rewardC = bytesToHex(pointToBytes(pedersenCommit(rewardAmount, rewardR)));
const receipt = (over = {}) => ({ kind: 'harvest', farm_id: bytesToHex(FARM),
  note: { asset_id: REWARD_ASSET, commitment: rewardC, amount: String(rewardAmount), r: bytesToHex(scalarBytes(rewardR)), vout: 1, ...over } });

console.log('T_LP_HARVEST reward:');
{
  const txid = farmTx(harvest);
  W.receipts.set(txid, receipt());
  const a = await verdict(txid, 1);
  ok('a reward the worker recorded validates', a.v === true, JSON.stringify(a));
  const pd = await dapp.getParentEnvelopeData(dapp.txOutputEnvelope(txs.get(txid)), 1, txid);
  ok('a spend reads the note from the receipt', pd?.assetIdHex === REWARD_ASSET && bytesToHex(pd.commitment) === rewardC, JSON.stringify(pd && { a: pd.assetIdHex }));
  const b = await verdict(txid, 0);
  ok('vout 0 is not a note', b.v === false);
  W.receipts.set(txid, receipt({ amount: '999' }));
  const c = await verdict(txid, 1);
  ok('a receipt whose amount is not the envelope\'s is invalid', c.v === false && c.reason === 'invalid', JSON.stringify(c));
  W.receipts.set(txid, receipt({ commitment: '02' + '22'.repeat(32) }));
  const d = await verdict(txid, 1);
  ok('a receipt whose commitment does not open is invalid', d.v === false && d.reason === 'invalid', JSON.stringify(d));
  W.receipts.set(txid, { ...receipt(), kind: 'unbond' });
  const e = await verdict(txid, 1);
  ok('a receipt of another kind is invalid', e.v === false && e.reason === 'invalid', JSON.stringify(e));

  W.receipts.delete(txid);
  W.scanned = 200;
  const f = await verdict(txid, 1);
  ok('no receipt, scanned past the op: invalid', f.v === false && f.reason === 'invalid', JSON.stringify(f));
  W.scanned = 100;
  const g = await verdict(txid, 1);
  ok('no receipt, not yet scanned to depth: fetch-failed', g.v === false && g.reason === 'fetch-failed', JSON.stringify(g));
  dapp.setStrictValidation({ failures: [] });
  let threw = null;
  try { dapp.clearValidatorCaches(); await dapp.validateOutpoint(txid, 1, new Map(), fetchTx); } catch (err) { threw = err; }
  dapp.setStrictValidation(null);
  ok('strict, undecided: unavailable', threw?.name === 'ValidationUnavailableError', threw?.message);
  W.scanned = 200;

  W.down = true;
  const h = await verdict(txid, 1);
  ok('an unreachable worker: fetch-failed', h.v === false && h.reason === 'fetch-failed', JSON.stringify(h));
  W.down = false;

  W.route = false;
  W.receipts.set(txid, receipt());
  const i = await verdict(txid, 1);
  ok('a worker with no receipt route: not credited by the validator', i.v === false, JSON.stringify(i));
  W.route = true;

  dapp.setStrictValidation({ failures: [] });
  let strictOk = null;
  try { dapp.clearValidatorCaches(); strictOk = await dapp.validateOutpoint(txid, 1, new Map(), fetchTx); } catch (err) { strictOk = err; }
  dapp.setStrictValidation(null);
  ok('strict: a recorded reward validates', strictOk === true, String(strictOk?.message || strictOk));
}

console.log('\nT_LP_UNBOND lp_return:');
{
  const lpR = randomScalar(), shares = 5000n;
  const unbond = encodeLpUnbond({ farmId: FARM, ownerCommit: new Uint8Array(32).fill(8), nonce: new Uint8Array(32).fill(9), shares,
    lpReturnR: scalarBytes(lpR), unbonderSig: new Uint8Array(64) });
  const txid = farmTx(unbond);
  W.receipts.set(txid, { kind: 'unbond', farm_id: bytesToHex(FARM),
    note: { asset_id: LP_ASSET, commitment: bytesToHex(pointToBytes(pedersenCommit(shares, lpR))), amount: String(shares), r: bytesToHex(scalarBytes(lpR)), vout: 1 } });
  const a = await verdict(txid, 1);
  ok('an lp_return the worker recorded validates', a.v === true, JSON.stringify(a));
  W.receipts.set(txid, { kind: 'unbond', farm_id: bytesToHex(FARM),
    note: { asset_id: LP_ASSET, commitment: bytesToHex(pointToBytes(pedersenCommit(shares, lpR))), amount: String(shares), r: bytesToHex(scalarBytes(lpR)), vout: 2 } });
  const b = await verdict(txid, 1);
  ok('a receipt naming another vout is invalid', b.v === false && b.reason === 'invalid', JSON.stringify(b));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
