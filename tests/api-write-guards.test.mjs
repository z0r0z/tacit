// Anonymous write routes: a stored buyer opening is replaced only by the key that made it, a live drop announcement keeps its issuer, and the
// lookups that fan out to the explorer are metered per client.
import assert from 'node:assert';
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import worker, { dropAnnounceMsg } from '../worker/src/index.js';
import { signSchnorr } from './composition.mjs';

const store = new Map();
const env = {
  REGISTRY_KV: {
    get: async (k, type) => { const v = store.get(k); if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; },
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = async (path, body, ip = '203.0.113.7') => {
  const r = await worker.fetch(new Request(`https://api.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip, origin: 'https://tacit.finance' }, body: JSON.stringify(body) }), env, ctx);
  return { status: r.status, body: await r.json().catch(() => null) };
};
let n = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };

// ── buyer opening
const txid = 'ab'.repeat(32);
const pubA = '02' + '11'.repeat(32), pubB = '03' + '22'.repeat(32);
const blob = (pub, ct) => ({ declared_pubkey: pub, ciphertext: ct });
ok((await call(`/utxos/${txid}/0/buyer-opening`, blob(pubA, 'aa'.repeat(60)))).status === 200, 'a buyer opening is stored');
const other = await call(`/utxos/${txid}/0/buyer-opening`, blob(pubB, 'bb'.repeat(60)));
ok(other.status === 409, 'another key cannot replace it');
ok(JSON.parse(store.get([...store.keys()].find((k) => k.includes(txid)))).ciphertext === 'aa'.repeat(60), 'the stored blob is unchanged');
ok((await call(`/utxos/${txid}/0/buyer-opening`, blob(pubA, 'cc'.repeat(60)))).status === 200, 'the same key can write it again');
let limited = 0;
for (let i = 1; i <= 40; i++) if ((await call(`/utxos/${txid}/${i}/buyer-opening`, blob(pubA, 'dd'.repeat(60)), '198.51.100.9')).status === 429) limited++;
ok(limited > 0, `a client that writes in a flood is slowed (${limited} of 40 refused)`);

// ── drop announcement
const priv1 = new Uint8Array(32).fill(5), priv2 = new Uint8Array(32).fill(9);
const pub = (priv) => bytesToHex(secp.getPublicKey(priv, true));
const asset = 'cd'.repeat(32), root = 'ef'.repeat(32), cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const exp = Math.floor(Date.now() / 1000) + 3600;
const announce = (priv, ip) => {
  const sig = bytesToHex(signSchnorr(dropAnnounceMsg('mainnet', asset, root, cid, exp, ''), priv));
  return call('/drops?network=mainnet', { asset_id: asset, merkle_root: root, ipfs_cid: cid, issuer_pubkey: pub(priv), expires_at: exp, note: '', announce_sig: sig }, ip);
};
ok((await announce(priv1, '203.0.113.21')).status === 200, 'a drop is announced');
const taken = await announce(priv2, '203.0.113.22');
ok(taken.status === 409, 'another issuer key cannot announce the same root');
const kept = JSON.parse(store.get([...store.keys()].find((k) => k.includes(root))));
ok(kept.issuer_pubkey === pub(priv1), 'the announcement keeps its issuer');
ok((await announce(priv1, '203.0.113.21')).status === 200, 'its issuer can announce it again');

// ── the coin lookup
let refused = 0;
for (let i = 0; i < 14; i++) if ((await call('/outpoints/classify', { outpoints: [] }, '192.0.2.44')).status === 429) refused++;
ok(refused > 0, `repeated coin lookups from one client are metered (${refused} of 14 refused)`);
console.log(`${n} ok`);
process.exit(0);
