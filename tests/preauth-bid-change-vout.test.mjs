// validateOutpoint records a T_PREAUTH_BID / T_PREAUTH_BID_VAR verdict under the settlement's tacit vouts: the buyer's
// note at vout 0 and the seller's change at vout 3 (4 for a partial T_PREAUTH_BID_VAR fill that pays a refund), never
// under the seller's BTC payout at vout 1. Mocked chain; no network.
//
// Run (Node 22): node --no-experimental-global-navigator tests/preauth-bid-change-vout.test.mjs
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { randomBytes } from 'node:crypto';

const dom = new JSDOM('', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, location: dom.window.location, __TACIT_NO_INIT__: true });
if (!globalThis.navigator) globalThis.navigator = dom.window.navigator;
localStorage.setItem('tacit-network-v1', 'mainnet');
globalThis.fetch = async (input) => { throw new Error('offline: ' + String(input?.url ?? input)); };

const T = await import('../dapp/tacit.js');
const BP = await import('./bulletproofs.mjs');
const { secp } = await import('../dapp/vendor/tacit-deps.min.js');

const hex = (b) => Buffer.from(b).toString('hex');
const u8 = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const le = (n, w) => { const b = new Uint8Array(w); let x = BigInt(n); for (let i = 0; i < w; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const b32 = (x) => u8(x.toString(16).padStart(64, '0'));
const rnd = () => BigInt('0x' + hex(randomBytes(32))) % T.SECP_N;

const V = new Uint8Array(randomBytes(32)); const Vpub = secp.getPublicKey(V, true);
T.wallet.priv = V; T.wallet.pub = Vpub;
const envWitness = (payload) => ['00'.repeat(64), hex(T.encodeEnvelopeScript(T.wallet.xonly(), payload)), 'c0' + '11'.repeat(32)];

// CETCH parent E (supply 1000) and a settlement P paying the buyer 400 at vout 0 and the seller 600 as change.
function settlement(tag, variant) {
  const E = tag + '1'.repeat(62), P = tag + '3'.repeat(62);
  const rE = rnd();
  const pe = BP.bpRangeAggProve([1000n], [rE]);
  const etchPayload = T.encodeCEtchPayload({ ticker: 'TST', decimals: 0, commitment: T.pointToBytes(pe.commitments[0]), rangeproof: pe.proof, encryptedAmount: new Uint8Array(8), mintAuthority: null, imageUri: null });
  const etchTx = { txid: E, vin: [{ txid: '02'.repeat(32), vout: 0, witness: envWitness(etchPayload) }], vout: [{ scriptpubkey: hex(T.p2wpkhScript(Vpub)), value: 546 }], status: { confirmed: true, block_height: 1 } };
  const aid = T.assetIdFor(E, 0);
  const r0 = rnd(), r1 = rnd();
  const pp = BP.bpRangeAggProve([400n, 600n], [r0, r1]);
  const C0 = T.pointToBytes(pp.commitments[0]), C1 = T.pointToBytes(pp.commitments[1]);
  const ksig = T.signSchnorr(T.computeKernelMsg(aid, [{ txid: E, vout: 0 }], [C0, C1], 0n), b32(T.modN(r0 + r1 - rE)));
  const inline = variant === 'exact'
    ? cat(new Uint8Array(16), Vpub, le(400n, 8), b32(r0), le(1000n, 8))
    // price 10, max_fill 500, increment 100, fill 400 (< max_fill: a refund vout precedes the change), r, refund hash, scale
    : cat(new Uint8Array(16), Vpub, le(10n, 8), le(500n, 8), le(100n, 8), le(400n, 8), b32(r0), new Uint8Array(20), new Uint8Array([0]));
  const payload = cat(new Uint8Array([variant === 'exact' ? 0x5b : 0x5c]), aid, new Uint8Array([1]), inline,
    ksig, new Uint8Array([2]), C0, C1, new Uint8Array(8), le(pp.proof.length, 2), pp.proof);
  const pTx = { txid: P, vin: [{ txid: '04'.repeat(32), vout: 0, witness: envWitness(payload) }, { txid: E, vout: 0, witness: ['30'.repeat(71), hex(Vpub)] }], vout: [], status: { confirmed: true, block_height: 2 } };
  const fetchTx = async (id) => (id === E ? etchTx : id === P ? pTx : null);
  return { E, P, fetchTx };
}

for (const [variant, changeVout] of [['exact', 3], ['var', 4]]) {
  const s = settlement(variant === 'exact' ? 'a5' : 'b5', variant);
  const set = new Map();
  assert.equal(await T.validateOutpoint(s.E, 0, set, s.fetchTx), true, 'CETCH parent');
  assert.equal(await T.validateOutpoint(s.P, 0, set, s.fetchTx), true, `${variant}: buyer note at vout 0`);
  assert.equal(set.get(`${s.P}:${changeVout}`), true, `${variant}: seller change recorded at vout ${changeVout}`);
  assert.notEqual(set.get(`${s.P}:1`), true, `${variant}: the BTC payout at vout 1 is not a tacit output`);
  assert.equal(await T.validateOutpoint(s.P, changeVout, new Map(), s.fetchTx), true, `${variant}: seller change validates on its own`);
  console.log(`ok - ${variant}: verdict recorded at vouts 0 and ${changeVout}`);
}
console.log('done');
process.exit(0);
