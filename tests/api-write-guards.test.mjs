// Anonymous write routes: a buyer opening is kept only for the key its output pays and, once signed, replaced only by a signed write; a live drop announcement keeps its issuer, and the
// lookups that fan out to the explorer are metered per client.
import assert from 'node:assert';
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import worker, { dropAnnounceMsg, buyerOpeningMsg } from '../worker/src/index.js';
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

// ── buyer opening: only the key an output pays keeps a blob for it, read from the chain; a signed blob is replaced only by a signed write
const hash160 = (b) => ripemd160(sha256(b));
const spk = (pub) => '0014' + bytesToHex(hash160(hexToBytes(pub)));
const privA = new Uint8Array(32).fill(7), privB = new Uint8Array(32).fill(11);
const pubA = bytesToHex(secp.getPublicKey(privA, true)), pubB = bytesToHex(secp.getPublicKey(privB, true));
const txid = 'ab'.repeat(32), unseen = 'cd'.repeat(32);
// vout 0 pays A, vout 1 pays B, vout 2 pays a taproot-style script
const chain = new Map([[txid, { txid, vout: [{ scriptpubkey: spk(pubA) }, { scriptpubkey: spk(pubB) }, { scriptpubkey: '5120' + '00'.repeat(32) }] }]]);
let explorerDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const m = String(url).match(/\/tx\/([0-9a-f]{64})$/);
  if (!m) return realFetch(url, init);
  if (explorerDown) return new Response('bad gateway', { status: 502 });
  const t = chain.get(m[1]);
  return t ? new Response(JSON.stringify(t), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('not found', { status: 404 });
};
const slot = (id, vout) => `buyer-opening:mainnet:${id}:${vout}`;
const stored = (id, vout) => (store.has(slot(id, vout)) ? JSON.parse(store.get(slot(id, vout))) : null);
const blob = (pub, ct) => ({ declared_pubkey: pub, ciphertext: ct });
const signedBlob = (priv, pub, id, vout, ct, signAs = ct) => ({ declared_pubkey: pub, ciphertext: ct, sig: bytesToHex(signSchnorr(buyerOpeningMsg('mainnet', id, vout, signAs, pub), priv)) });

ok((await call(`/utxos/${txid}/0/buyer-opening?network=mainnet`, blob(pubA, 'aa'.repeat(60)))).status === 200 && stored(txid, 0).ciphertext === 'aa'.repeat(60), 'the key an output pays can store a blob for it (an older page, unsigned)');
const squat = await call(`/utxos/${txid}/0/buyer-opening?network=mainnet`, blob(pubB, 'bb'.repeat(60)));
ok(squat.status === 403 && stored(txid, 0).ciphertext === 'aa'.repeat(60), 'a key the output does not pay is refused, and what is stored is unchanged');
store.set(slot(txid, 1), JSON.stringify({ declared_pubkey: pubA, ciphertext: 'ee'.repeat(60), stored_at: 1 }));   // a blob put there earlier by a key the output never paid
ok((await call(`/utxos/${txid}/1/buyer-opening?network=mainnet`, blob(pubB, 'ff'.repeat(60)))).status === 200 && stored(txid, 1).declared_pubkey === pubB && stored(txid, 1).ciphertext === 'ff'.repeat(60), 'the owner\'s write replaces a blob that was stored earlier under another key');

const s1 = await call(`/utxos/${txid}/0/buyer-opening?network=mainnet`, signedBlob(privA, pubA, txid, 0, '11'.repeat(60)));
ok(s1.status === 200 && stored(txid, 0).sig && stored(txid, 0).ciphertext === '11'.repeat(60), 'a signed write by the owner is stored with its signature');
const knownKey = await call(`/utxos/${txid}/0/buyer-opening?network=mainnet`, blob(pubA, '22'.repeat(60)));
ok(knownKey.status === 409 && stored(txid, 0).ciphertext === '11'.repeat(60), 'an unsigned write naming the owner\'s public key (it is visible in the transaction) cannot replace a signed blob');
ok((await call(`/utxos/${txid}/0/buyer-opening?network=mainnet`, signedBlob(privA, pubA, txid, 0, '33'.repeat(60)))).status === 200 && stored(txid, 0).ciphertext === '33'.repeat(60), 'a signed write by the owner replaces it');
ok((await call(`/utxos/${txid}/0/buyer-opening?network=mainnet`, signedBlob(privB, pubA, txid, 0, '44'.repeat(60)))).status === 403, 'a signature from another key is refused');
ok((await call(`/utxos/${txid}/0/buyer-opening?network=mainnet`, signedBlob(privA, pubA, txid, 0, '55'.repeat(60), '66'.repeat(60)))).status === 403, 'a signature made over a different blob is refused');
ok((await call(`/utxos/${txid}/1/buyer-opening?network=mainnet`, signedBlob(privB, pubB, txid, 0, 'ff'.repeat(60)))).status === 403, 'nor does a signature for one output work at another');
ok((await call(`/utxos/${txid}/0/buyer-opening?network=mainnet`, { ...blob(pubA, '77'.repeat(60)), sig: 'zz' })).status === 400, 'a malformed signature is a 400');
ok(stored(txid, 0).ciphertext === '33'.repeat(60), 'none of the refused writes changed what is stored');

ok((await call(`/utxos/${txid}/9/buyer-opening?network=mainnet`, blob(pubA, 'aa'.repeat(60)))).status === 400, 'an output the transaction does not have is refused');
ok((await call(`/utxos/${txid}/2/buyer-opening?network=mainnet`, blob(pubA, 'aa'.repeat(60)))).status === 403 && stored(txid, 2) === null, 'an output that is not a P2WPKH to the key is refused');
ok((await call(`/utxos/${txid}/0/buyer-opening?network=mainnet`, blob(pubA, 'abc'))).status === 400, 'a ciphertext of an odd length is refused');
explorerDown = true;
const down = await call(`/utxos/${txid}/0/buyer-opening?network=mainnet`, blob(pubA, '88'.repeat(60)));
ok(down.status === 503 && down.body.retryAfter > 0 && stored(txid, 0).ciphertext === '33'.repeat(60), 'a transaction that cannot be read is a 503 to retry, and stores nothing');
explorerDown = false;
const notYet = await call(`/utxos/${unseen}/0/buyer-opening?network=mainnet`, blob(pubA, '99'.repeat(60)));
ok(notYet.status === 503 && stored(unseen, 0) === null, 'a transaction the explorers do not show yet is a 503 to retry, not a refusal');

env.BUYER_OPENING_REQUIRE_SIG = '1';
ok((await call(`/utxos/${txid}/0/buyer-opening?network=mainnet`, blob(pubA, 'aa'.repeat(60)))).status === 400 && (await call(`/utxos/${txid}/0/buyer-opening?network=mainnet`, signedBlob(privA, pubA, txid, 0, 'bc'.repeat(60)))).status === 200, 'with signatures required an unsigned write is refused and a signed one stored');
delete env.BUYER_OPENING_REQUIRE_SIG;

const m0 = buyerOpeningMsg('mainnet', txid, 0, 'aa'.repeat(60), pubA);
ok(m0.length === 32 && bytesToHex(m0) === bytesToHex(buyerOpeningMsg('mainnet', txid, 0, 'aa'.repeat(60), pubA))
  && [buyerOpeningMsg('signet', txid, 0, 'aa'.repeat(60), pubA), buyerOpeningMsg('mainnet', unseen, 0, 'aa'.repeat(60), pubA), buyerOpeningMsg('mainnet', txid, 1, 'aa'.repeat(60), pubA),
      buyerOpeningMsg('mainnet', txid, 0, 'ab'.repeat(60), pubA), buyerOpeningMsg('mainnet', txid, 0, 'aa'.repeat(60), pubB)].every((m) => bytesToHex(m) !== bytesToHex(m0)),
  'the signed message is fixed, and the network, the output, the blob and the key each change it');

let limited = 0;
for (let i = 1; i <= 40; i++) if ((await call(`/utxos/${txid}/${i}/buyer-opening?network=mainnet`, blob(pubA, 'dd'.repeat(60)), '198.51.100.9')).status === 429) limited++;
ok(limited > 0, `a client that writes in a flood is slowed (${limited} of 40 refused)`);
globalThis.fetch = realFetch;

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
