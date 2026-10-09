// AMM commit/reveal funding — network-free unit test.
//
// The T_SWAP_VAR reveal always carries four outputs (OP_RETURN, receipt, change or the padding output in its
// place, refund) and pays three DUST note outputs. This builds real swap envelopes through dapp/tacit.js, signs
// the reveal with the same helper the broadcast wrapper uses, and checks that at 1, 2 and 50 sat/vB, with and
// without change, the reveal pays at least its planned fee and at least the requested rate on its real size.
// It also checks that assertRevealFunded refuses the earlier funding (receipt + change only), and that saved
// reveals survive network errors in _recoverPendingReveal.
//
// Run: node tests/amm-reveal-funding.test.mjs

import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { randomBytes } from 'node:crypto';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const dapp = await import('../dapp/tacit.js');

const PRIV = randomBytes(32);
const PUB = secp.getPublicKey(PRIV, true);
dapp.wallet.priv = PRIV;
dapp.wallet.pub = PUB;
try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(PUB), '1'); } catch {}

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; }
};
const throws = (label, fn, re) => {
  try { fn(); ok(label, false, 'did not throw'); }
  catch (e) { ok(label, !re || re.test(e.message), e.message); }
};

const { DUST } = dapp;
const randTxid = () => bytesToHex(randomBytes(32));
const vsizeOf = (tx) => {
  const base = dapp.serializeTx(tx, false).length;
  const total = dapp.serializeTx(tx, true).length;
  return Math.ceil((base * 3 + total) / 4);
};
const sum = (xs) => xs.reduce((s, x) => s + Number(x.value), 0);

const ASSET_A = 'aa'.repeat(32);
const ASSET_B = 'bb'.repeat(32);
const poolReserves = { pool_id_hex: randTxid(), reserve_a: '100000000000', reserve_b: '100000000000', fee_bps: 30 };

async function buildCase(hasChange) {
  const amount = 1_000_000n;
  const utxo = { txid: randTxid(), vout: 0, amount: amount.toString(), blinding: bytesToHex(randomBytes(32)), asset_id_hex: ASSET_A };
  const built = await dapp.buildSwapVarEnvelopeSelfFulfill({
    poolReserves, assetInputUtxo: utxo, direction: 0,
    deltaIn: hasChange ? amount / 2n : amount, minOut: 1n,
    expiryHeight: 900000, receiveAssetIdHex: ASSET_B,
  });
  return { built, utxo };
}

console.log('T_SWAP_VAR reveal funding:');
for (const hasChange of [true, false]) {
  const { built, utxo } = await buildCase(hasChange);
  ok(`${hasChange ? 'with' : 'without'} change: envelope shape`, built.isWholeInput === !hasChange);
  const envelopeScript = dapp.encodeEnvelopeScript(dapp.wallet.xonly(), built.payload);
  const { Q_xonly, parity } = dapp.tweakedOutputKey(dapp.TAP_NUMS, dapp.tapLeafHash(envelopeScript));
  const commitSpk = dapp.p2trScript(Q_xonly);
  const cb = dapp.controlBlock(dapp.TAP_NUMS, parity);
  const recipSpk = dapp.p2trScript(PUB.slice(1));
  const changeSpk = dapp.p2trScript(PUB.slice(1));
  for (const feeRate of [1, 2, 50]) {
    const plan = dapp.swapVarRevealPlan(envelopeScript.length, feeRate);
    const { revealTx, revealPrevouts } = dapp.buildSwapVarRevealTx({
      built, commitTxidHex: randTxid(), commitValue: plan.commitValue, commitSpk, envelopeScript, cb,
      recipSpk, changeSpk, assetInputUtxo: utxo,
    });
    const tag = `${hasChange ? 'change' : 'no change'} @ ${feeRate} sat/vB`;
    const paid = sum(revealPrevouts) - sum(revealTx.outputs);
    const vsize = vsizeOf(revealTx);
    ok(`${tag}: four outputs, three paying DUST`, revealTx.outputs.length === 4 && revealTx.outputs.filter(o => o.value === DUST).length === 3);
    ok(`${tag}: refund at vout 3 is the bound refund script`, bytesToHex(revealTx.outputs[3].script) === bytesToHex(built.refundScriptPubKey));
    ok(`${tag}: reveal pays its planned fee (${paid} >= ${plan.revealFee})`, paid >= plan.revealFee);
    ok(`${tag}: size estimate covers the signed reveal (${plan.revealVb} >= ${vsize} vB)`, plan.revealVb >= vsize);
    ok(`${tag}: effective rate >= requested (${(paid / vsize).toFixed(2)})`, paid >= Math.ceil(vsize * feeRate));
    let threw = null;
    try { dapp.assertRevealFunded(revealTx, revealPrevouts, plan.revealFee, 'T_SWAP_VAR'); } catch (e) { threw = e; }
    ok(`${tag}: assertRevealFunded accepts it`, threw === null, threw?.message);
    // The earlier funding counted only receipt + change, so the reveal came up 1-2 DUST short.
    const oldCommit = Math.max(DUST, DUST + (hasChange ? DUST : 0) + plan.revealFee - DUST);
    const oldPrevouts = [{ ...revealPrevouts[0], value: oldCommit }, revealPrevouts[1]];
    throws(`${tag}: assertRevealFunded refuses the earlier funding`,
      () => dapp.assertRevealFunded(revealTx, oldPrevouts, plan.revealFee, 'T_SWAP_VAR'), /below the planned/);
  }
}
throws('assertRevealFunded refuses a prevout count that differs from the inputs',
  () => dapp.assertRevealFunded({ inputs: [{}, {}], outputs: [] }, [{ value: 1000 }], 1), /do not match/);

console.log('\nSaved reveals:');
{
  const COMMIT = randTxid();
  const key = `tacit-pending-reveal-v1:signet:${COMMIT}`;
  const rec = { commitTxid: COMMIT, revealTxid: randTxid(), revealHex: '00', label: 'T_SWAP_VAR', savedAt: Date.now() };
  const realFetch = globalThis.fetch;
  const run = async (handler) => {
    globalThis.fetch = async (url, opts = {}) => handler(String(url), opts);
    try { await dapp._recoverPendingReveal(); } finally { globalThis.fetch = realFetch; }
  };
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

  localStorage.setItem(key, JSON.stringify(rec));
  await run(async () => { throw new TypeError('Failed to fetch'); });
  ok('a network error keeps the saved reveal', localStorage.getItem(key) !== null);

  let posted = 0;
  await run(async (url, opts) => {
    if (String(opts.method || 'GET').toUpperCase() === 'POST') { posted++; return new Response('ab'.repeat(32), { status: 200 }); }
    if (url.includes(`/tx/${COMMIT}/outspend/0`)) return json({ spent: false });
    if (url.includes(`/tx/${COMMIT}/status`)) return json({ confirmed: true, block_height: 100 });
    return new Response('not found', { status: 404 });
  });
  ok('an unspent commit output re-sends the reveal', posted >= 1, `posted ${posted}`);
  ok('and keeps the record until the spend confirms', localStorage.getItem(key) !== null);

  await run(async (url) => {
    if (url.includes(`/tx/${COMMIT}/outspend/0`)) return json({ spent: true, txid: rec.revealTxid, vin: 0, status: { confirmed: false } });
    if (url.includes(`/tx/${COMMIT}/status`)) return json({ confirmed: true, block_height: 100 });
    return new Response('not found', { status: 404 });
  });
  ok('a commit output spent in the mempool keeps the record', localStorage.getItem(key) !== null);

  await run(async (url) => {
    if (url.includes(`/tx/${COMMIT}/outspend/0`)) return json({ spent: true, txid: rec.revealTxid, vin: 0, status: { confirmed: true, block_height: 101 } });
    if (url.includes(`/tx/${COMMIT}/status`)) return json({ confirmed: true, block_height: 100 });
    return new Response('not found', { status: 404 });
  });
  ok('a commit output spent in a confirmed tx drops the record', localStorage.getItem(key) === null);

  const UNSEEN = randTxid();
  const unseenKey = `tacit-pending-reveal-v1:signet:${UNSEEN}`;
  const notFound = async () => new Response('Transaction not found', { status: 404 });
  localStorage.setItem(unseenKey, JSON.stringify({ ...rec, commitTxid: UNSEEN, savedAt: Date.now() - 3600_000 }));
  await run(notFound);
  ok('a commit not yet seen keeps a recent record', localStorage.getItem(unseenKey) !== null);
  localStorage.setItem(unseenKey, JSON.stringify({ ...rec, commitTxid: UNSEEN, savedAt: Date.now() - 15 * 24 * 3600_000 }));
  await run(notFound);
  ok('a commit unseen for 14 days drops the record', localStorage.getItem(unseenKey) === null);

  const legacy = 'tacit-pending-reveal:signet';
  localStorage.setItem(legacy, JSON.stringify({ ...rec, savedAt: Date.now() - 2 * 3600_000 }));
  await run(async () => { throw new TypeError('Failed to fetch'); });
  ok('the mixer slot survives a network error and an age over one hour', localStorage.getItem(legacy) !== null);
  localStorage.removeItem(legacy);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
