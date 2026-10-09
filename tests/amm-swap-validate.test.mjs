// dapp/tacit.js validateOutpoint on AMM outputs — network-free.
//
// Builds real T_SWAP_VAR / T_SWAP_ROUTE envelopes through the dapp builders over a real CETCH input and runs
// them through the dapp validator with the worker's answers stubbed:
//   - honest swap receipts and change validate (the change carries an m=1 BP+ proof; a whole-input swap none);
//   - a swap whose vin[1] is not a note committing to c_in, or is a note of another asset, is not credited;
//   - an input that cannot be fetched is transient (fetch-failed), never invalid;
//   - T_PROTOCOL_FEE_CLAIM / LP outputs follow /amm/op-accepted: absent endpoint, records that predate
//     since_height and unreachable workers credit as before; a final missing record is invalid.
//
// Run: node tests/amm-swap-validate.test.mjs

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { randomBytes } from 'node:crypto';
import { pointToBytes, randomScalar, _bpGens, bpRangeAggProve, pedersenCommit } from './bulletproofs.mjs';
import { assetIdFor, encodeCEtchPayload } from './composition.mjs';
import { encodeEnvelopeScript } from './indexer.mjs';
import { encodeProtocolFeeClaim } from '../dapp/amm-envelope.js';

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

// Worker stub: per-test answers for the AMM endpoints the validator reads.
const W = { pools: [], swapAccepted: new Map(), opAccepted: () => ({ status: 404 }), down: false };
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.origin !== 'https://worker.test') throw new TypeError('offline');
  if (W.down) throw new TypeError('Failed to fetch');
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/amm/pools') return json({ pools: W.pools, cursor: null });
  if (u.pathname === '/amm/swap-accepted') {
    const rec = W.swapAccepted.get(u.searchParams.get('txid'));
    return json(rec ? { accepted: true, outcome: 'execute', scanned_height: 200, ...rec } : { accepted: false, scanned_height: 200 });
  }
  if (u.pathname === '/amm/op-accepted') {
    const a = W.opAccepted(u.searchParams.get('txid'));
    return a.status === 404 ? json({ error: 'not found' }, 404) : json(a.body, a.status || 200);
  }
  return json({ error: 'not found' }, 404);
};

const dapp = await import('../dapp/tacit.js');
_bpGens();

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
const nextTxid = () => { const b = new Uint8Array(32); new DataView(b.buffer).setUint32(28, ++counter, false); b[0] = 0x5a; return bytesToHex(b); };
const txs = new Map();
const fetchTx = async (id) => txs.get(id) || null;
const witnessFor = (script) => [bytesToHex(new Uint8Array(64)), bytesToHex(script), bytesToHex(new Uint8Array(33))];
const confirmed = (h = 100) => ({ confirmed: true, block_height: h });

function etch(amount, blinding = randomScalar()) {
  const { proof, commitments } = bpRangeAggProve([amount], [blinding]);
  const payload = encodeCEtchPayload({
    ticker: 'TST', decimals: 0, commitment: pointToBytes(commitments[0]), rangeproof: proof,
    encryptedAmount: new Uint8Array(8), mintAuthority: null,
  });
  const txid = nextTxid();
  txs.set(txid, { txid, status: confirmed(90), vin: [{ txid: nextTxid(), vout: 0, witness: witnessFor(encodeEnvelopeScript(randomBytes(32), payload)) }] });
  return { txid, vout: 0, amount, blinding, assetIdHex: bytesToHex(assetIdFor(txid, 0)) };
}
function swapTx(payload, input, h = 100) {
  const txid = nextTxid();
  const script = dapp.encodeEnvelopeScript(dapp.wallet.xonly(), payload);
  txs.set(txid, { txid, status: confirmed(h), vin: [
    { txid: nextTxid(), vout: 0, witness: witnessFor(script) },
    { txid: input.txid, vout: input.vout, witness: [bytesToHex(new Uint8Array(71)), bytesToHex(PUB)] },
  ] });
  return txid;
}
const utxoOf = (n) => ({ txid: n.txid, vout: n.vout, amount: n.amount.toString(), blinding: n.blinding.toString(16).padStart(64, '0'), asset_id_hex: n.assetIdHex });
async function verdict(txid, vout) {
  dapp.clearValidatorCaches();
  const set = new Map(), reasons = new Map();
  const v = await dapp.validateOutpoint(txid, vout, set, fetchTx, 0, null, null, null, reasons);
  return { v, reason: reasons.get(`${txid}:${vout}`) || null };
}

const OTHER = 'ff'.repeat(32);   // the asset the swaps buy; sorts after any etch id that starts 0x00..0xfe
function poolFor(assetA, assetB) {
  return { pool_id: bytesToHex(randomBytes(32)), asset_a: assetA, asset_b: assetB, lp_asset_id: bytesToHex(randomBytes(32)),
    fee_bps: 30, reserve_a: '100000000000', reserve_b: '100000000000', validation: 'verified' };
}

console.log('T_SWAP_VAR:');
{
  const input = etch(1_000_000n);
  const pool = poolFor(input.assetIdHex, OTHER);
  W.pools = [pool];
  const reserves = { pool_id_hex: pool.pool_id, reserve_a: pool.reserve_a, reserve_b: pool.reserve_b, fee_bps: 30 };
  const built = await dapp.buildSwapVarEnvelopeSelfFulfill({
    poolReserves: reserves, assetInputUtxo: utxoOf(input), direction: 0, deltaIn: 400_000n, minOut: 1n,
    expiryHeight: 900000, receiveAssetIdHex: OTHER,
  });
  const txid = swapTx(built.payload, input);
  W.swapAccepted.set(txid, {
    receipt: { asset_id: OTHER, commitment: bytesToHex(built.cReceiptSecp) },
    change: { asset_id: input.assetIdHex, commitment: bytesToHex(built.cChangeOrSentinel) },
  });
  const r1 = await verdict(txid, 1);
  ok('an honest swap receipt validates', r1.v === true, JSON.stringify(r1));
  const r2 = await verdict(txid, 2);
  ok('its change validates (m=1 BP+ over the change)', r2.v === true, JSON.stringify(r2));

  const whole = etch(500_000n);
  W.pools = [poolFor(whole.assetIdHex, OTHER)];
  const wholeBuilt = await dapp.buildSwapVarEnvelopeSelfFulfill({
    poolReserves: { ...reserves, pool_id_hex: W.pools[0].pool_id }, assetInputUtxo: utxoOf(whole), direction: 0, deltaIn: 500_000n, minOut: 1n,
    expiryHeight: 900000, receiveAssetIdHex: OTHER,
  });
  const wholeTx = swapTx(wholeBuilt.payload, whole);
  W.swapAccepted.set(wholeTx, { receipt: { asset_id: OTHER, commitment: bytesToHex(wholeBuilt.cReceiptSecp) } });
  const r3 = await verdict(wholeTx, 1);
  ok('a whole-input swap receipt validates', r3.v === true, JSON.stringify(r3));
  ok('a whole-input swap has no change at vout 2', (await verdict(wholeTx, 2)).v === false);

  // Same envelope, but vin[1] is a different note than the one it commits to.
  W.pools = [pool];
  const stranger = etch(1_000_000n);
  const wrongInput = swapTx(built.payload, stranger);
  W.swapAccepted.set(wrongInput, W.swapAccepted.get(txid));
  const r4 = await verdict(wrongInput, 1);
  ok('a swap whose input does not commit to c_in is invalid', r4.v === false && r4.reason === 'invalid', JSON.stringify(r4));

  // A note of another asset that opens to the same commitment (same amount and blinding).
  const twin = etch(input.amount, input.blinding);
  const twinTx = swapTx(built.payload, twin);
  W.swapAccepted.set(twinTx, W.swapAccepted.get(txid));
  const r5 = await verdict(twinTx, 1);
  ok('a swap spending a note of another asset is invalid', r5.v === false && r5.reason === 'invalid', JSON.stringify(r5));

  // The input's tx cannot be fetched: transient.
  const ghost = { txid: nextTxid(), vout: 0 };
  const ghostTx = swapTx(built.payload, ghost);
  W.swapAccepted.set(ghostTx, W.swapAccepted.get(txid));
  const r6 = await verdict(ghostTx, 1);
  ok('an unfetchable input is fetch-failed, not invalid', r6.v === false && r6.reason === 'fetch-failed', JSON.stringify(r6));

  // Not in the worker's accepted set.
  const unaccepted = swapTx(built.payload, input);
  const r7 = await verdict(unaccepted, 1);
  ok('a swap the worker has not accepted is not credited', r7.v === false, JSON.stringify(r7));

  // The pool list does not name the swap's pool: the input asset cannot be compared.
  const unlisted = poolFor(input.assetIdHex, OTHER);
  const lone = etch(1_000_000n);
  const loneBuilt = await dapp.buildSwapVarEnvelopeSelfFulfill({
    poolReserves: { ...reserves, pool_id_hex: unlisted.pool_id }, assetInputUtxo: utxoOf(lone), direction: 0,
    deltaIn: 400_000n, minOut: 1n, expiryHeight: 900000, receiveAssetIdHex: OTHER,
  });
  const loneTx = swapTx(loneBuilt.payload, lone);
  W.swapAccepted.set(loneTx, { receipt: { asset_id: OTHER, commitment: bytesToHex(loneBuilt.cReceiptSecp) } });
  const r8 = await verdict(loneTx, 1);
  ok('an unlisted pool skips the asset check outside strict validation', r8.v === true, JSON.stringify(r8));
  dapp.setStrictValidation({ failures: [] });
  let threw = null;
  try { await dapp.validateOutpoint(loneTx, 1, new Map(), fetchTx); } catch (e) { threw = e; }
  dapp.setStrictValidation(null);
  ok('strict: an unlisted pool is unavailable, not a verdict', threw?.name === 'ValidationUnavailableError', threw?.message);
  dapp.setStrictValidation({ failures: [] });
  let strictOk = null;
  try { strictOk = await dapp.validateOutpoint(txid, 1, new Map(), fetchTx); } catch (e) { strictOk = e; }
  dapp.setStrictValidation(null);
  ok('strict: an honest swap receipt validates', strictOk === true, String(strictOk?.message || strictOk));
}

console.log('\nT_SWAP_ROUTE:');
{
  let input = etch(2_000_000n);
  while (input.assetIdHex >= 'fe') input = etch(2_000_000n);
  const MID = 'fe'.repeat(32);
  const p1 = poolFor(input.assetIdHex, MID);
  const p2 = poolFor(MID, OTHER);
  W.pools = [p1, p2];
  const pools = [p1, p2].map(p => ({ ...p }));
  const built = await dapp.buildSwapRouteEnvelopeSelfFulfill({
    pools, assetInputUtxo: utxoOf(input), traderOutputAssetIdHex: OTHER, minOut: 1n, expiryHeight: 900000,
  });
  const txid = swapTx(built.payload, input);
  W.swapAccepted.set(txid, { receipt: { asset_id: OTHER, commitment: bytesToHex(built.cReceiptSecp) } });
  const r1 = await verdict(txid, 1);
  ok('an honest route receipt validates', r1.v === true, JSON.stringify(r1));
  const other = etch(2_000_000n);
  const moved = swapTx(built.payload, other);
  W.swapAccepted.set(moved, W.swapAccepted.get(txid));
  const r2 = await verdict(moved, 1);
  ok('a route whose vin[1] is not the outpoint it names is invalid', r2.v === false && r2.reason === 'invalid', JSON.stringify(r2));
}

console.log('\nT_PROTOCOL_FEE_CLAIM / op-accepted:');
{
  const amt = 12345n, r = randomScalar();
  const payload = encodeProtocolFeeClaim({
    poolId: randomBytes(32), claimerPubkey: PUB, feeBps: 30, claimAmount: amt,
    claimCSecp: pointToBytes(pedersenCommit(amt, r)), claimBlinding: hexToBytes(r.toString(16).padStart(64, '0')), claimSig: new Uint8Array(64),
  });
  const claimAt = (h) => {
    const txid = nextTxid();
    txs.set(txid, { txid, status: confirmed(h), vin: [{ txid: nextTxid(), vout: 0, witness: witnessFor(dapp.encodeEnvelopeScript(dapp.wallet.xonly(), payload)) }] });
    return txid;
  };
  const t = claimAt(150);
  W.opAccepted = () => ({ status: 404 });
  ok('no endpoint (404): credited as before', (await verdict(t, 0)).v === true);
  W.opAccepted = () => ({ body: { accepted: true, since_height: 120, scanned_height: 200 } });
  ok('recorded: credited', (await verdict(t, 0)).v === true);
  W.opAccepted = () => ({ body: { accepted: false, since_height: 160, scanned_height: 200 } });
  ok('confirmed before since_height: credited as before', (await verdict(t, 0)).v === true);
  W.opAccepted = () => ({ body: { accepted: false, since_height: null, scanned_height: 200 } });
  ok('no since_height yet: credited as before', (await verdict(t, 0)).v === true);
  W.opAccepted = () => ({ body: { accepted: false, since_height: 120, scanned_height: 200 } });
  const n1 = await verdict(t, 0);
  ok('not recorded and scanned past: invalid', n1.v === false && n1.reason === 'invalid', JSON.stringify(n1));
  W.opAccepted = () => ({ body: { accepted: false, since_height: 120, scanned_height: 150 } });
  const n2 = await verdict(t, 0);
  ok('not recorded, not yet scanned to depth: fetch-failed', n2.v === false && n2.reason === 'fetch-failed', JSON.stringify(n2));
  W.opAccepted = () => ({ status: 503, body: { error: 'busy' } });
  ok('worker error: credited outside strict validation', (await verdict(t, 0)).v === true);
  W.down = true;
  ok('worker unreachable: credited outside strict validation', (await verdict(t, 0)).v === true);
  W.down = false;

  const strict = async () => {
    dapp.setStrictValidation({ failures: [] });
    try { return { v: await dapp.validateOutpoint(t, 0, new Map(), fetchTx) }; }
    catch (e) { return { err: e }; }
    finally { dapp.setStrictValidation(null); }
  };
  W.opAccepted = () => ({ status: 404 });
  ok('strict, no endpoint: credited as before', (await strict()).v === true);
  W.opAccepted = () => ({ body: { accepted: false, since_height: 120, scanned_height: 150 } });
  ok('strict, undecided: unavailable', (await strict()).err?.name === 'ValidationUnavailableError');
  W.opAccepted = () => ({ body: { accepted: false, since_height: 120, scanned_height: 200 } });
  ok('strict, decided not recorded: false', (await strict()).v === false);
  W.down = true;
  ok('strict, unreachable: unavailable', (await strict()).err?.name === 'ValidationUnavailableError');
  W.down = false;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
