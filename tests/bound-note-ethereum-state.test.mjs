// dapp/tacit.js validateOutpoint on notes whose validity rests on Ethereum state — network-free.
//
//   - A T_CXFER_BOUND output homed to this deployment is credited only while its bound nullifier is unspent in the
//     pool (the fast lane can move it to Ethereum while the Bitcoin output stays unspent); an unreadable pool leaves
//     it pending; an output bound to another deployment is pending too, its standing unknowable here.
//   - A transfer out of a bound output is pending until the reflection has passed its block, then final; the
//     attested height is read from Ethereum (the pool's attested tip, looked up in the header relay).
//   - A T_CROSSOUT_MINT note is credited only when the pool's crossOutCommitment[claimId] holds its leaf.
//   - A purchase reads every transaction of the lot from two sources and refuses when they differ, and refuses a
//     bound lot outright (its holder could still move it to Ethereum and void the buyer's side).
//
// Run: node tests/bound-note-ethereum-state.test.mjs

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from 'node:crypto';
import { pointToBytes, randomScalar, _bpGens, bpRangeAggProve } from './bulletproofs.mjs';
import { assetIdFor, encodeCEtchPayload } from './composition.mjs';
import { encodeEnvelopeScript } from './indexer.mjs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

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

const txs = new Map();
// Ethereum stub: storage slot → 32-byte value; anything absent reads as zero. `ethDown` fails every call.
// Explorer stub: serves `txs`, except `explorerOverride` (txid → tx), which blockstream answers differently.
const E = { storage: new Map(), ethDown: false, reflected: 0, crossoutMinted: true, explorerOverride: new Map() };
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (u.origin === 'https://worker.test') {
    if (u.pathname === '/reflection/status') return json({ attestedHeight: E.reflected });
    if (u.pathname === '/crossout/minted') return json({ decided: true, minted: E.crossoutMinted });
    if (u.pathname === '/chain/txs/batch') {
      const ids = JSON.parse(opts.body).txids;
      return json({ txs: Object.fromEntries(ids.filter((i) => txs.has(i)).map((i) => [i, txs.get(i)])) });
    }
    const m = u.pathname.match(/\/tx\/([0-9a-f]{64})$/);
    if (m) return txs.has(m[1]) ? json(txs.get(m[1])) : json({ error: 'not found' }, 404);
    return json({ error: 'not found' }, 404);
  }
  const tm = u.pathname.match(/\/tx\/([0-9a-f]{64})$/);
  if (tm && E.explorerDown) return json({ error: 'unavailable' }, 500);
  if (tm) {
    const t = (u.hostname === 'blockstream.info' && E.explorerOverride.get(tm[1])) || txs.get(tm[1]);
    return t ? json(t) : json({ error: 'not found' }, 404);
  }
  if (opts.method === 'POST' && typeof opts.body === 'string' && opts.body.includes('eth_')) {
    if (E.ethDown) throw new TypeError('Failed to fetch');
    const req = JSON.parse(opts.body);
    if (req.method === 'eth_getStorageAt') return json({ jsonrpc: '2.0', id: req.id, result: E.storage.get(String(req.params[1]).toLowerCase()) || '0x' + '00'.repeat(32) });
    if (req.method === 'eth_call') {
      const { to, data } = req.params[0];
      if (String(to).toLowerCase() === E.pool && data === E.sel.tip) return json({ jsonrpc: '2.0', id: req.id, result: E.tipHash });
      if (String(to).toLowerCase() === E.relay && data === E.sel.height + E.tipHash.slice(2)) return json({ jsonrpc: '2.0', id: req.id, result: '0x' + BigInt(E.reflected).toString(16).padStart(64, '0') });
      return json({ jsonrpc: '2.0', id: req.id, result: '0x' + '00'.repeat(32) });
    }
    if (req.method === 'eth_chainId') return json({ jsonrpc: '2.0', id: req.id, result: '0x1' });
    return json({ jsonrpc: '2.0', id: req.id, error: { message: 'unsupported' } });
  }
  throw new TypeError('offline');
};

const dapp = await import('../dapp/tacit.js');
const { CONFIDENTIAL_DEPLOYMENTS } = await import('../dapp/confidential-deployments.js');
_bpGens();
const kit = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

const PRIV = randomBytes(32);
const PUB = secp.getPublicKey(PRIV, true);
dapp.wallet.priv = PRIV;
dapp.wallet.pub = PUB;
try { localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(PUB), '1'); } catch {}

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; }
};

let counter = 0;
const nextTxid = () => { const b = new Uint8Array(32); new DataView(b.buffer).setUint32(28, ++counter, false); b[0] = 0x7e; return bytesToHex(b); };
const fetchTx = async (id) => txs.get(id) || null;
const witnessFor = (script) => [bytesToHex(new Uint8Array(64)), bytesToHex(script), bytesToHex(new Uint8Array(33))];
const confirmed = (h) => ({ confirmed: true, block_height: h });
const N = secp.CURVE.n;
const modN = (x) => ((x % N) + N) % N;
const b32 = (x) => hexToBytes(modN(x).toString(16).padStart(64, '0'));
const hex32 = (x) => '0x' + BigInt(x).toString(16).padStart(64, '0');
const p2tr = () => '5120' + bytesToHex(secp.getPublicKey(randomBytes(32), true).slice(1));
const slotOf = (keyHex, slot) => '0x' + bytesToHex(keccak_256(hexToBytes(String(keyHex).replace(/^0x/, '').padStart(64, '0') + slot.toString(16).padStart(64, '0'))));

const dep = CONFIDENTIAL_DEPLOYMENTS.signet;
// The attested height comes from the pool's attestedReflectionTip() and the header relay's blockHeight(bytes32).
dep.headerRelay = '0x' + '2e'.repeat(20);
const sel = (sig) => '0x' + bytesToHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);
Object.assign(E, { pool: dep.pool.toLowerCase(), relay: dep.headerRelay, tipHash: '0x' + 'ab'.repeat(32), sel: { tip: sel('attestedReflectionTip()'), height: sel('blockHeight(bytes32)') } });
const BINDING = '0x' + bytesToHex(keccak_256(hexToBytes(BigInt(dep.chainId).toString(16).padStart(64, '0') + dep.pool.replace(/^0x/, '').toLowerCase())));

function etch(amount) {
  const blinding = randomScalar();
  const { proof, commitments } = bpRangeAggProve([amount], [blinding]);
  const payload = encodeCEtchPayload({ ticker: 'TST', decimals: 0, commitment: pointToBytes(commitments[0]), rangeproof: proof, encryptedAmount: new Uint8Array(8), mintAuthority: null });
  const txid = nextTxid();
  txs.set(txid, { txid, status: confirmed(90), vin: [{ txid: nextTxid(), vout: 0, witness: witnessFor(encodeEnvelopeScript(randomBytes(32), payload)) }], vout: [{ scriptpubkey: '0014' + '11'.repeat(20), value: 546 }] });
  return { txid, vout: 0, amount, blinding, assetId: assetIdFor(txid, 0) };
}
// An etch whose range proof is for another commitment than the one it states.
function etchWithWrongProof(amount) {
  const { proof } = bpRangeAggProve([amount], [randomScalar()]);
  const { commitments } = bpRangeAggProve([amount + 1n], [randomScalar()]);
  const payload = encodeCEtchPayload({ ticker: 'TST', decimals: 0, commitment: pointToBytes(commitments[0]), rangeproof: proof, encryptedAmount: new Uint8Array(8), mintAuthority: null });
  const txid = nextTxid();
  txs.set(txid, { txid, status: confirmed(90), vin: [{ txid: nextTxid(), vout: 0, witness: witnessFor(encodeEnvelopeScript(randomBytes(32), payload)) }], vout: [{ scriptpubkey: '0014' + '11'.repeat(20), value: 546 }] });
  return txid;
}
// A two-output T_CXFER_BOUND (identity vouts) or T_CXFER spending one note, kernel signed by r_out − r_in.
function transfer(input, { bound, binding = BINDING, h = 100, wrongProof = false }) {
  const amounts = [input.amount / 2n, input.amount - input.amount / 2n];
  const rs = [randomScalar(), randomScalar()];
  const { proof: honest, commitments } = bpRangeAggProve(amounts, rs);
  const proof = wrongProof ? bpRangeAggProve(amounts, [randomScalar(), randomScalar()]).proof : honest;      // a proof of the right shape for other commitments
  const outs = commitments.map((c) => pointToBytes(c));
  const msg = dapp.computeKernelMsg(input.assetId, [{ txid: input.txid, vout: input.vout }], outs, 0n);
  const kernelSig = dapp.signSchnorr(msg, b32(rs[0] + rs[1] - input.blinding));
  const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, proof.length, true);
  const parts = bound
    ? [new Uint8Array([0x39]), hexToBytes(binding.slice(2)), input.assetId, kernelSig, new Uint8Array([2])]
    : [new Uint8Array([0x23]), input.assetId, kernelSig, new Uint8Array([2])];
  for (const o of outs) parts.push(o, new Uint8Array(8));
  parts.push(rpLen, proof);
  const payload = Uint8Array.from(parts.flatMap((p) => [...p]));
  const txid = nextTxid();
  const vout = [p2tr(), p2tr()].map((s) => ({ scriptpubkey: s, value: 546 }));
  txs.set(txid, { txid, status: confirmed(h), vin: [
    { txid: nextTxid(), vout: 0, witness: witnessFor(dapp.encodeEnvelopeScript(dapp.wallet.xonly(), payload)) },
    { txid: input.txid, vout: input.vout, witness: [bytesToHex(new Uint8Array(64))] },
  ], vout });
  return { txid, outs, amounts, rs, vout, assetId: input.assetId };
}
function boundNu(t, j) {
  const C = secp.ProjectivePoint.fromHex(t.outs[j]).toAffine();
  return kit.nullifier(kit.btcNoteLeafBound('0x' + bytesToHex(t.assetId), hex32(C.x), hex32(C.y), '0x' + t.vout[j].scriptpubkey.slice(4), BINDING));
}
async function verdict(txid, vout) {
  dapp.clearValidatorCaches();
  const set = new Map(), reasons = new Map();
  const v = await dapp.validateOutpoint(txid, vout, set, fetchTx, 0, null, null, null, reasons);
  return { v, reason: reasons.get(`${txid}:${vout}`) || null };
}

console.log('T_CXFER_BOUND outputs:');
{
  const t = transfer(etch(1000n), { bound: true });
  const r1 = await verdict(t.txid, 0);
  ok('a bound output whose nullifier is unspent on Ethereum validates', r1.v === true, JSON.stringify(r1));

  E.storage.set(slotOf(boundNu(t, 1), 70).toLowerCase(), hex32(1));
  const r2 = await verdict(t.txid, 1);
  ok('a bound output spent on Ethereum is invalid on Bitcoin', r2.v === false && r2.reason === 'invalid', JSON.stringify(r2));
  const r2b = await verdict(t.txid, 0);
  ok('its sibling, unspent on Ethereum, still validates', r2b.v === true, JSON.stringify(r2b));

  const t3 = transfer(etch(1000n), { bound: true });
  E.ethDown = true;
  const r3 = await verdict(t3.txid, 0);
  E.ethDown = false;
  ok('an unreadable pool leaves a bound output pending', r3.v === false && r3.reason === 'fetch-failed', JSON.stringify(r3));

  const t4 = transfer(etch(1000n), { bound: true, binding: '0x' + bytesToHex(randomBytes(32)) });
  E.ethDown = true;
  const r4 = await verdict(t4.txid, 0);
  E.ethDown = false;
  ok('an output bound to another deployment is pending, its pool unread', r4.v === false && r4.reason === 'fetch-failed', JSON.stringify(r4));
}

console.log('\nA transfer out of a bound output:');
{
  const t = transfer(etch(1000n), { bound: true, h: 100 });
  const child = transfer({ txid: t.txid, vout: 0, amount: t.amounts[0], blinding: t.rs[0], assetId: t.assetId }, { bound: false, h: 120 });
  E.reflected = 110;
  const r1 = await verdict(child.txid, 0);
  ok('pending while the reflection has not passed its block', r1.v === false && r1.reason === 'fetch-failed', JSON.stringify(r1));
  E.reflected = 130;
  const r2 = await verdict(child.txid, 0);
  ok('final once the reflection has passed it', r2.v === true, JSON.stringify(r2));
  E.storage.set(slotOf(boundNu(t, 0), 70).toLowerCase(), hex32(1));
  const r3 = await verdict(child.txid, 0);
  ok('invalid when the bound note it spent was taken on Ethereum', r3.v === false && r3.reason === 'invalid', JSON.stringify(r3));
}

console.log('\nT_CROSSOUT_MINT:');
{
  const asset = randomBytes(32), claimId = randomBytes(32);
  const P = secp.ProjectivePoint.BASE.multiply(randomScalar()).toAffine();
  const payload = new Uint8Array(161);
  payload[0] = 0x65; payload.set(asset, 1); payload.set(claimId, 33);
  payload.set(hexToBytes(P.x.toString(16).padStart(64, '0')), 65); payload.set(hexToBytes(P.y.toString(16).padStart(64, '0')), 97);
  const spk = p2tr();
  const txid = nextTxid();
  txs.set(txid, { txid, status: confirmed(100), vin: [{ txid: nextTxid(), vout: 0, witness: witnessFor(dapp.encodeEnvelopeScript(dapp.wallet.xonly(), payload)) }], vout: [{ scriptpubkey: spk, value: 546 }] });
  const leaf = kit.btcNoteLeaf('0x' + bytesToHex(asset), hex32(P.x), hex32(P.y), '0x' + spk.slice(4));
  const slot = slotOf(bytesToHex(claimId), 77).toLowerCase();

  const r1 = await verdict(txid, 0);
  ok('a mint the pool has no cross-out record for is invalid', r1.v === false && r1.reason === 'invalid', JSON.stringify(r1));
  E.ethDown = true;
  const r2 = await verdict(txid, 0);
  E.ethDown = false;
  ok('an unreadable pool leaves the mint pending', r2.v === false && r2.reason === 'fetch-failed', JSON.stringify(r2));
  E.storage.set(slot, leaf);
  const r3 = await verdict(txid, 0);
  ok('a mint whose leaf the pool recorded validates', r3.v === true, JSON.stringify(r3));
  E.crossoutMinted = false;
  const r4 = await verdict(txid, 0);
  E.crossoutMinted = true;
  ok('a mint the worker does not name for its claim is not credited', r4.v === false, JSON.stringify(r4));
}

console.log('\nA transfer that spends a cross-out mint note (a bridged note moved to its trading address):');
{
  const crossoutPair = (recorded) => {
    const asset = randomBytes(32), claimId = randomBytes(32), amount = 1000n, r = randomScalar();
    const { commitments } = bpRangeAggProve([amount], [r]);
    const C = commitments[0].toAffine();
    const payload = new Uint8Array(161);
    payload[0] = 0x65; payload.set(asset, 1); payload.set(claimId, 33);
    payload.set(hexToBytes(C.x.toString(16).padStart(64, '0')), 65); payload.set(hexToBytes(C.y.toString(16).padStart(64, '0')), 97);
    const spk = p2tr(), mint = nextTxid();
    txs.set(mint, { txid: mint, status: confirmed(100), vin: [{ txid: nextTxid(), vout: 0, witness: witnessFor(dapp.encodeEnvelopeScript(dapp.wallet.xonly(), payload)) }], vout: [{ scriptpubkey: spk, value: 546 }] });
    if (recorded) E.storage.set(slotOf(bytesToHex(claimId), 77).toLowerCase(), kit.btcNoteLeaf('0x' + bytesToHex(asset), hex32(C.x), hex32(C.y), '0x' + spk.slice(4)));
    return transfer({ txid: mint, vout: 0, amount, blinding: r, assetId: asset }, { bound: false, h: 120 });
  };
  const good = await verdict(crossoutPair(true).txid, 0);
  ok('a transfer of a cross-out mint note validates once the pool holds the mint\'s leaf', good.v === true, JSON.stringify(good));
  const bad = await verdict(crossoutPair(false).txid, 0);
  ok('and does not when the pool never recorded the mint', bad.v === false, JSON.stringify(bad));
}

console.log('\nPurchases:');
{
  E.reflected = 1000;
  const note = etch(1000n);
  const plainLot = transfer(note, { bound: false, h: 100 });
  let err = null;
  try { await dapp.requireValidatedLot(plainLot.txid, 0); } catch (e) { err = e; }
  ok('a lot both sources agree on is accepted', err === null, String(err?.message || ''));

  ok('what the check proved is kept for the session: the lot and its ancestry', dapp._lotProvedSession.has(`${plainLot.txid}:0`) && dapp._lotProvedSession.size >= 2, `${dapp._lotProvedSession.size} kept`);
  let sizeBefore = dapp._lotProvedSession.size;
  err = null;
  try { await dapp.requireValidatedLot(plainLot.txid, 0); } catch (e) { err = e; }
  ok('and the same lot checked again is accepted from it', err === null && dapp._lotProvedSession.size === sizeBefore, String(err?.message || ''));

  // A history of three hops: the proofs of every hop are checked together, so one wrong proof in the middle refuses a lot whose own proof is sound.
  const hop = (n) => ({ txid: n.txid, vout: 0, amount: n.amounts[0], blinding: n.rs[0], assetId: n.assetId });
  const goodChain = transfer(hop(transfer(etch(1000n), { bound: false })), { bound: false });
  err = null;
  try { await dapp.requireValidatedLot(goodChain.txid, 0); } catch (e) { err = e; }
  ok('a three-hop history with sound proofs, of mixed sizes in one batch, is accepted', err === null, String(err?.message || ''));
  const midBad = transfer(etch(1000n), { bound: false, wrongProof: true });
  const badChain = transfer(hop(midBad), { bound: false });
  err = null;
  try { await dapp.requireValidatedLot(badChain.txid, 0); } catch (e) { err = e; }
  ok('the same history with one wrong proof in its middle hop is refused', /does not validate/.test(String(err?.message)), String(err?.message || 'accepted'));
  ok('and none of its outpoints is kept for the session', !dapp._lotProvedSession.has(`${badChain.txid}:0`) && !dapp._lotProvedSession.has(`${midBad.txid}:0`));

  const badTxid = etchWithWrongProof(1000n);
  err = null;
  try { await dapp.requireValidatedLot(badTxid, 0); } catch (e) { err = e; }
  ok('a lot whose history holds a range proof that does not match its commitment is refused, and nothing of it is kept', /does not validate/.test(String(err?.message)) && !dapp._lotProvedSession.has(`${badTxid}:0`), String(err?.message || 'accepted'));

  const lot2 = transfer(etch(1000n), { bound: false, h: 100 });
  E.explorerOverride.set(lot2.txid, { ...structuredClone(txs.get(lot2.txid)), vout: [{ scriptpubkey: p2tr(), value: 546 }, txs.get(lot2.txid).vout[1]] });
  err = null;
  try { await dapp.requireValidatedLot(lot2.txid, 0); } catch (e) { err = e; }
  ok('a lot whose sources disagree is refused before anything is sent', /could not verify/.test(String(err?.message)), String(err?.message || ''));
  E.explorerOverride.clear();

  const t = transfer(etch(1000n), { bound: true, h: 100 });
  err = null;
  try { await dapp.requireValidatedLot(t.txid, 0); } catch (e) { err = e; }
  ok('a bound lot is refused even while unspent on Ethereum', /bound to the Ethereum pool/.test(String(err?.message)), String(err?.message || 'accepted'));
  ok('and its outpoints are not kept for the session', !dapp._lotProvedSession.has(`${t.txid}:0`) && !dapp._lotProvedSession.has(`${t.txid}:1`));
  E.storage.set(slotOf(boundNu(t, 0), 70).toLowerCase(), hex32(1));
  err = null;
  try { await dapp.requireValidatedLot(t.txid, 0); } catch (e) { err = e; }
  ok('the same lot after it moved to Ethereum is refused (not reused as proven)', /does not validate/.test(String(err?.message)), String(err?.message || ''));
}

console.log('\nFailed reads in the asset checks:');
{
  const note = etch(1000n);
  const asset = { asset_id: bytesToHex(note.assetId), etch_txid: note.txid, ticker: 'TST', decimals: 0 };
  E.explorerDown = true;
  const down = await dapp.verifyDiscoverAsset(asset);
  E.explorerDown = false;
  ok('an asset whose etch could not be read is unverified for now, and says the read failed', down.ok === false && down.transient === true, JSON.stringify({ ok: down.ok, transient: down.transient }));
  const back = await dapp.verifyDiscoverAsset(asset);
  ok('and it is asked again rather than kept: the next check verifies it', back.ok === true, JSON.stringify({ ok: back.ok, error: back.error }));

  const bogusMint = nextTxid();
  E.explorerDown = true;
  await dapp.enrichDiscoverMints({ asset_id: asset.asset_id, mints: [{ mint_txid: bogusMint }] }, { ok: true, verifiedMints: {} });
  E.explorerDown = false;
  ok('a mint that could not be read is not written to the stored record as invalid', !dapp.getCachedDiscoverMint(bogusMint), JSON.stringify(dapp.getCachedDiscoverMint(bogusMint)));
  txs.set(bogusMint, { txid: bogusMint, status: confirmed(95), vin: [{ txid: nextTxid(), vout: 0, witness: ['00', '00'], prevout: { scriptpubkey_type: 'v0_p2wpkh', value: 1000 } }], vout: [{ scriptpubkey: '0014' + '11'.repeat(20), value: 546 }] });
  await dapp.enrichDiscoverMints({ asset_id: asset.asset_id, mints: [{ mint_txid: bogusMint }] }, { ok: true, verifiedMints: {} });
  ok('while a mint that was read and is not a mint is still recorded as invalid', dapp.getCachedDiscoverMint(bogusMint)?.ok === false, JSON.stringify(dapp.getCachedDiscoverMint(bogusMint)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
