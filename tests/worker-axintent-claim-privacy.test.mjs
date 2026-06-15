// Atomic-intent claim privacy: the public list/get must NOT leak the taker's
// wallet-linking outpoint (taker_utxo), pre-settlement trade size
// (requested_amount), or reusable claim signature; the maker reads the full
// claim via the maker-authenticated claim-detail endpoint.
//
// Run: node tests/worker-axintent-claim-privacy.test.mjs

import { signSchnorr } from './composition.mjs';
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  _slimAtomicClaim,
  atomicIntentClaimReadMsg,
  handleAtomicIntentClaimDetail,
} from '../worker/src/index.js';

let pass = 0, fail = 0;
const test = (label, fn) => Promise.resolve().then(fn).then(ok => {
  if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}`); fail++; }
}).catch(e => { console.log(`  THROW ${label}: ${e.message}`); fail++; });

const MAKER_PRIV = hexToBytes('11'.repeat(32));
const MAKER_PUB  = bytesToHex(secp.getPublicKey(MAKER_PRIV, true));
const OTHER_PRIV = hexToBytes('22'.repeat(32));
const TAKER_PUB  = bytesToHex(secp.getPublicKey(hexToBytes('33'.repeat(32)), true));

const ASSET = 'aa'.repeat(32);
const IID = 'bb'.repeat(16);
const NET = 'signet';

const now = Math.floor(Date.now() / 1000);
const FULL_CLAIM = {
  intent_id: IID,
  taker_pubkey: TAKER_PUB,
  taker_utxo: { txid: 'cc'.repeat(32), vout: 1, value: 123456 },
  requested_amount: '4200',
  sig: 'dd'.repeat(64),
  claimed_at: now,
  expires_at: now + 300,
};

// Minimal KV mock keyed exactly like the worker's atomicIntent/claim keys.
function mockEnv({ intent, claim }) {
  const m = new Map();
  // Mirrors atomicIntentKey/atomicClaimKey for network 'signet'.
  if (intent) m.set(`axintent:${ASSET}:${IID}`, JSON.stringify(intent));
  if (claim)  m.set(`axclaim:${ASSET}:${IID}`, JSON.stringify(claim));
  return { REGISTRY_KV: {
    async get(k, t) { const v = m.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  } };
}
const reqWith = (body) => new Request('https://api.test/claim-detail', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const readJson = async (resp) => ({ status: resp.status, body: await resp.json() });

console.log('\nAtomic-intent claim privacy:');

await test('_slimAtomicClaim strips taker_utxo / requested_amount / sig, keeps taker_pubkey + expires_at', () => {
  const s = _slimAtomicClaim(FULL_CLAIM);
  return s.taker_utxo === undefined && s.requested_amount === undefined && s.sig === undefined
      && s.taker_pubkey === TAKER_PUB && s.expires_at === FULL_CLAIM.expires_at && s.claimed === true;
});

await test('claim-detail returns the FULL claim for a valid maker signature', async () => {
  const env = mockEnv({ intent: { maker_pubkey: MAKER_PUB }, claim: FULL_CLAIM });
  const sig = bytesToHex(signSchnorr(atomicIntentClaimReadMsg(ASSET, IID), MAKER_PRIV));
  const { status, body } = await readJson(await handleAtomicIntentClaimDetail(ASSET, IID, reqWith({ maker_sig: sig }), env, NET, {}));
  return status === 200 && body.claim
      && body.claim.taker_utxo?.txid === FULL_CLAIM.taker_utxo.txid
      && body.claim.requested_amount === '4200';
});

await test('claim-detail rejects a non-maker signature (403)', async () => {
  const env = mockEnv({ intent: { maker_pubkey: MAKER_PUB }, claim: FULL_CLAIM });
  const sig = bytesToHex(signSchnorr(atomicIntentClaimReadMsg(ASSET, IID), OTHER_PRIV));
  const { status } = await readJson(await handleAtomicIntentClaimDetail(ASSET, IID, reqWith({ maker_sig: sig }), env, NET, {}));
  return status === 403;
});

await test('claim-detail returns null claim when none is active', async () => {
  const env = mockEnv({ intent: { maker_pubkey: MAKER_PUB }, claim: null });
  const sig = bytesToHex(signSchnorr(atomicIntentClaimReadMsg(ASSET, IID), MAKER_PRIV));
  const { status, body } = await readJson(await handleAtomicIntentClaimDetail(ASSET, IID, reqWith({ maker_sig: sig }), env, NET, {}));
  return status === 200 && body.claim === null;
});

await test('claim-detail 404 for unknown intent', async () => {
  const env = mockEnv({ intent: null, claim: null });
  const sig = bytesToHex(signSchnorr(atomicIntentClaimReadMsg(ASSET, IID), MAKER_PRIV));
  const { status } = await readJson(await handleAtomicIntentClaimDetail(ASSET, IID, reqWith({ maker_sig: sig }), env, NET, {}));
  return status === 404;
});

console.log(`\n${pass} passed, ${fail} failed.\n`);
if (fail > 0) process.exit(1);
