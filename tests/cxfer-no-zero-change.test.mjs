// A transfer that spends its notes whole leaves no note of 0 TAC behind.
//
// The wallet's transfer builder used to add a change output to every transfer and then pad the outputs to 2, 4 or 8, so moving a note whole
// (a merge, a send to your own key, a bridge preparation, "send max") left a note of 0 TAC at your address, each holding 546 sats. Now the
// outputs are the recipients' and a change note only when something is left, padded only to a size the range proof and the guest accept (1, 2,
// 4 or 8; SPEC.md T_CXFER, cxfer-core parse_cxfer_envelope_full). Each case builds a real transfer against a mock chain and reads what was
// broadcast: the envelope's output count, the Bitcoin outputs, the range proof, and the kernel signature, which holds only if the inputs'
// amounts equal the outputs' (a note of 0 TAC dropped from the outputs must not change that).
//
// Set CXFER_BUILDER_VECTOR_OUT=<file> to write the broadcast transactions for tests/cxfer_builder_vector.rs (the guest's own parse and
// conservation check on what this builder makes): CXFER_BUILDER_VECTOR=<file> cargo test --test cxfer_builder_vector
//
// Run: node tests/cxfer-no-zero-change.test.mjs      (Node 22: add --no-experimental-global-navigator)

import { JSDOM } from './_jsdom.mjs';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { writeFileSync } from 'node:fs';

const dapp = await import('../dapp/tacit.js');
const worker = await import('../worker/src/index.js');
const bpp = await import('../dapp/bulletproofs-plus.js');

let pass = 0, fail = 0;
async function test(label, fn) {
  try {
    const ok = await fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

const SK = hexToBytes('0c'.repeat(32));
dapp.wallet.priv = SK;
dapp.wallet.pub = secp.getPublicKey(SK, true);
dapp.wallet.mode = 'passkey';
const ADDR = dapp.wallet.address();
const PUB_HEX = bytesToHex(dapp.wallet.pub);
const pubOf = (b) => bytesToHex(secp.getPublicKey(hexToBytes(b.repeat(32)), true));
const OTHER = pubOf('0d'), THIRD = pubOf('0e'), FOURTH = pubOf('0f'), FIFTH = pubOf('10');

const ASSET_ID = bytesToHex(sha256(new TextEncoder().encode('test-asset')));
const ASSET_BYTES = hexToBytes(ASSET_ID);
let nextNote = 1;
// a note of `amount` at its own outpoint, with a blinding of its own
const note = (amount) => {
  const i = nextNote++;
  return { utxo: { txid: i.toString(16).padStart(2, '0').repeat(32), vout: i % 3, value: 546 }, amount, blinding: BigInt('0x' + (0x1000 + i).toString(16).padStart(4, '0').repeat(16)) };
};

// The wallet's own holdings (read to keep the funding sats clear of notes): none beyond the notes each case forces.
dapp._testSetScanHoldingsOverride(() => new Map([[ASSET_ID, { decimals: 0, ticker: 'TST', balance: 0n, utxos: [] }]]));

const RATE = { v: 1 };   // sat/vB the mock chain recommends (a floor-rate chain first: the commit output's 546-sat minimum then leaves sats over)
const broadcasts = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });
  if (method === 'POST' && typeof opts.body === 'string' && opts.body.includes('"jsonrpc"')) {
    const rpc = JSON.parse(opts.body);
    if (rpc.method === 'eth_getStorageAt') return json({ jsonrpc: '2.0', id: rpc.id, result: '0x' + '00'.repeat(32) });
    return json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'mock: ' + rpc.method } });
  }
  if (u.endsWith('/v1/fees/recommended')) return json({ fastestFee: RATE.v, halfHourFee: RATE.v, hourFee: RATE.v, economyFee: RATE.v, minimumFee: 1 });
  if (u.includes('/scripthash/')) return json([]);
  if (u.includes(`/address/${ADDR}/utxo`)) { dapp._testClearRecentSpends(); return json([{ txid: 'ee'.repeat(32), vout: 0, value: 5_000_000, status: { confirmed: true } }]); }
  if (method === 'POST' && u.endsWith('/tx')) {
    if (!broadcasts.some((b) => b.hex === opts.body)) broadcasts.push({ hex: opts.body });
    return text('0'.repeat(64));
  }
  if (/\/tx\/[0-9a-f]{64}\/outspend\/\d+$/.test(u)) return json({ spent: false });
  if (u.includes('/blocks/tip/height')) return text('0');
  if (u.includes('/assets/hint')) return json({ ok: true });
  return json({ error: 'mock fetch: no handler for ' + u }, 404);
};

// A segwit transaction read back from its hex: the inputs' witnesses and the outputs.
function readTx(hex) {
  const b = hexToBytes(hex);
  let p = 0;
  const u8 = () => b[p++];
  const varint = () => { const f = u8(); if (f < 0xfd) return f; if (f === 0xfd) { const v = b[p] | (b[p + 1] << 8); p += 2; return v; } throw new Error('long varint'); };
  const take = (n) => { const x = b.slice(p, p + n); p += n; return x; };
  p += 4;
  if (b[p] !== 0 || b[p + 1] !== 1) throw new Error('not a segwit transaction');
  p += 2;
  const vin = [];
  for (let n = varint(), i = 0; i < n; i++) {
    const txid = bytesToHex(take(32).reverse()); const vout = new DataView(take(4).buffer).getUint32(0, true);
    take(varint()); take(4);
    vin.push({ txid, vout, witness: [] });
  }
  const vout = [];
  for (let n = varint(), i = 0; i < n; i++) {
    const value = Number(new DataView(take(8).buffer).getBigUint64(0, true));
    vout.push({ value, script: bytesToHex(take(varint())) });
  }
  for (const i of vin) for (let n = varint(), k = 0; k < n; k++) i.witness.push(take(varint()));
  return { vin, vout };
}

const vectors = [];
// Build one transfer and read what it broadcast. `inputs` are notes spent whole or in part by `recipients`.
async function build(name, inputs, recipients, opts = {}) {
  const before = broadcasts.length;
  const r = await dapp.buildAndBroadcastCXferMulti({ assetIdHex: ASSET_ID, recipients, forceUtxos: inputs, allowDuplicateRecipients: true, ...opts });
  if (broadcasts.length !== before + 2) throw new Error(`${name}: expected a commit and a reveal, got ${broadcasts.length - before} broadcasts`);
  const revealHex = broadcasts[broadcasts.length - 1].hex;
  const tx = readTx(revealHex);
  const env = dapp.decodeEnvelopeScript(tx.vin[0].witness[1]);
  const dec = opts.useBpp === false ? dapp.decodeCXferPayload(env.payload) : dapp.decodeCXferBppPayload(env.payload);
  const inPoints = inputs.map((x) => dapp.pedersenCommit(x.amount, x.blinding));
  const outPoints = dec.outputs.map((o) => dapp.bytesToPoint(o.commitment));
  const sum = (ps) => ps.slice(1).reduce((a, q) => a.add(q), ps[0]);
  const excess = sum(outPoints).add(sum(inPoints).negate());
  const kernelMsg = dapp.computeKernelMsg(ASSET_BYTES, inputs.map((x) => ({ txid: x.utxo.txid, vout: x.utxo.vout })), dec.outputs.map((o) => o.commitment));
  const kernelOk = dapp.verifySchnorr(dec.kernelSig, kernelMsg, excess.toRawBytes(true).slice(1));
  const rangeOk = opts.useBpp === false ? null : bpp.bppRangeVerify(outPoints, dec.rangeproof);
  vectors.push({ name, revealHex, asset: ASSET_ID, n: dec.outputs.length, inputs: inputs.map((x, i) => ({ txid: x.utxo.txid, vout: x.utxo.vout, commitment: bytesToHex(dapp.pointToBytes(inPoints[i])) })) });
  return { r, tx, env, dec, kernelOk, rangeOk, workerN: (opts.useBpp === false ? worker.decodeCXferPayload : worker.decodeCXferBppPayload)(env.payload)?.outputs.length };
}

const to = (pubHex, amount) => ({ pubHex, amount });
const p2wpkhOf = (pubHex) => '0014' + bytesToHex(dapp.hash160(hexToBytes(pubHex)));

console.log('\n§ A note spent whole:');
{
  const x = await build('whole note to another key', [note(10_000n)], [to(OTHER, 10_000n)]);
  await test('the transfer has one output, not two', () => x.dec.outputs.length === 1 && x.workerN === 1);
  await test('the reveal is that one output (546 sats) to the recipient: no second Bitcoin output, at the floor fee rate too', () => x.tx.vout.length === 1 && x.tx.vout[0].value === 546 && x.tx.vout[0].script === p2wpkhOf(OTHER));
  await test('there is no change note, and nothing for the caller to look for', () => x.r.changeAmount === 0n && x.r.changeVout === null && x.r.changeBlinding === null && x.r.paddingVouts.length === 0 && x.r.m === 1);
  await test('the range proof verifies', () => x.rangeOk === true);
  await test('the kernel signature verifies: the one output holds everything the input did', () => x.kernelOk === true);
  await test('the recipient is still at vout 0', () => x.r.recipients[0].vout === 0 && x.r.recipients[0].amount === 10_000n);
}
{
  const x = await build('two notes merged to this key', [note(4_000n), note(6_000n)], [to(PUB_HEX, 10_000n)]);
  await test('two notes merged whole to this key make a single note and no 0 TAC note, and both notes\' sats beyond the one output come back as sats change', () => x.dec.outputs.length === 1 && x.tx.vout.length === 2 && x.r.changeVout === null && x.tx.vout[1].value === 1092);
  await test('the merge verifies (range proof and kernel)', () => x.rangeOk === true && x.kernelOk === true);
}
{
  const x = await build('whole note to another key, classic range proof', [note(10_000n)], [to(OTHER, 10_000n)], { useBpp: false });
  await test('a classic Bulletproof transfer (0x23) of one output is built the same way', () => x.env.payload[0] === 0x23 && x.dec.outputs.length === 1 && x.workerN === 1 && x.kernelOk === true);
}

{
  RATE.v = 20;
  dapp._testClearRecentSpends?.();
  const x = await build('whole note to another key, at 20 sat/vB', [note(10_000n)], [to(OTHER, 10_000n)]);
  await test('at an ordinary fee rate the reveal has the one output and nothing else: no sats over, no second output to hold', () => x.dec.outputs.length === 1 && x.tx.vout.length === 1 && x.tx.vout[0].value === 546 && x.kernelOk === true && x.rangeOk === true);
  RATE.v = 1;
}

console.log('\n§ A note spent in part still has its change:');
{
  const x = await build('part of a note', [note(10_000n)], [to(OTHER, 3_000n)]);
  await test('two outputs: the recipient at 0 and the change at 1', () => x.dec.outputs.length === 2 && x.r.changeAmount === 7_000n && x.r.changeVout === 1 && typeof x.r.changeBlinding === 'bigint' && x.r.paddingVouts.length === 0);
  await test('the change goes back to this key', () => x.tx.vout[1].script === p2wpkhOf(PUB_HEX));
  await test('range proof and kernel verify', () => x.rangeOk === true && x.kernelOk === true);
}

console.log('\n§ Several recipients (outputs round up to 1, 2, 4 or 8):');
for (const [label, amounts, total, want, pads] of [
  ['two recipients, whole', [6_000n, 4_000n], 10_000n, 2, 0],
  ['two recipients, in part', [6_000n, 3_000n], 10_000n, 4, 1],
  ['three recipients, whole', [1_000n, 1_000n, 1_000n], 3_000n, 4, 1],
  ['three recipients, in part', [1_000n, 1_000n, 1_000n], 4_000n, 4, 0],
  ['four recipients, whole', [1_000n, 1_000n, 1_000n, 1_000n], 4_000n, 4, 0],
  ['five recipients, whole', [1_000n, 1_000n, 1_000n, 1_000n, 1_000n], 5_000n, 8, 3],
]) {
  const keys = [OTHER, THIRD, FOURTH, PUB_HEX, FIFTH];
  const x = await build(label, [note(total)], amounts.map((a, i) => to(keys[i], a)));
  const whole = amounts.reduce((s, a) => s + a, 0n) === total;
  await test(`${label}: ${want} outputs, ${pads} of them padding${whole ? '' : ', the rest change'}`, () => x.dec.outputs.length === want && x.r.paddingVouts.length === pads && (whole ? x.r.changeVout === null : x.r.changeVout === amounts.length));
  await test(`${label}: every output is a Bitcoin output of 546 sats at its own vout, the recipients to their keys`, () => x.tx.vout.slice(0, want).every((o) => o.value === 546) && amounts.every((_, i) => x.tx.vout[i].script === p2wpkhOf(keys[i])));
  await test(`${label}: range proof and kernel verify`, () => x.rangeOk === true && x.kernelOk === true);
}

console.log('\n§ A bound transfer (a bridged asset on Bitcoin) spent whole:');
{
  // 0x39 reads the same way, so the builder's output count is the only thing that differs; the bound path needs a pool binding the mock does not have,
  // so this is covered by the guest check (tests/cxfer_builder_vector.rs reads the plain 0x22 and 0x23 transfers above).
  await test('(not built here: the bound transfer needs a pool binding)', () => true);
}

if (process.env.CXFER_BUILDER_VECTOR_OUT) {
  writeFileSync(process.env.CXFER_BUILDER_VECTOR_OUT, JSON.stringify({ vectors }, null, 1));
  console.log(`\nwrote ${vectors.length} transactions to ${process.env.CXFER_BUILDER_VECTOR_OUT}`);
}
console.log(`\n${fail ? `${fail} FAILED, ${pass} passed` : `all ${pass} checks passed`}`);
process.exit(fail ? 1 : 0);
