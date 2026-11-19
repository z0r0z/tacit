// A program input sealed to one prover: the page encrypts the bincode SP1Stdin it built (sp1-stdin.js) to a worker's
// public key from the prover board (GET /prover/board), so only that worker can read the op; Tacit's API and relay only
// ever hold the ciphertext and the proof that comes back. The worker opens it with its key (prover-worker/src/main.rs
// `unseal`): secp256k1 ECDH between a one-time key made here and the worker's, SHA-256 over a domain, the shared
// x-coordinate, the worker's key and the one-time key, then AES-256-GCM with that domain as the associated data.
//   sealTo({ secp, pubkey, stdin, random? }) → { epk, iv, ct }   (epk hex, iv and ct base64)
//   pickWorker(summary, { prefer }) → the worker to seal to, or null
// Browser and Node: `secp` is @noble/secp256k1 (as the pool UX has it); hashing and the cipher come from WebCrypto.

export const SEALED_DOMAIN = 'tacit-sealed-input-v1';
const te = new TextEncoder();
const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => { const s = String(h).replace(/^0x/, ''); if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('sealed-input: bad hex'); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16); return out; };
const b64 = (b) => (typeof Buffer !== 'undefined' ? Buffer.from(b).toString('base64') : btoa(String.fromCharCode(...b)));
const concat = (...xs) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };
const subtle = () => { const c = globalThis.crypto; if (!c || !c.subtle) throw new Error('sealed-input: WebCrypto is not available'); return c; };

// The key both sides derive: SHA-256(domain ‖ ECDH x ‖ worker public key ‖ one-time public key). `priv` is the side's
// own key and `peer` the other's point: the page's one-time key with the worker's key, or the worker's key with `epk`.
export async function sealKey({ secp, priv, peer, workerPub, epk }) {
  const shared = secp.getSharedSecret(priv, peer, true).subarray(1); // the x-coordinate of the shared point
  const digest = await subtle().subtle.digest('SHA-256', concat(te.encode(SEALED_DOMAIN), shared, workerPub, epk));
  return new Uint8Array(digest);
}

export async function sealTo({ secp, pubkey, stdin, random } = {}) {
  if (!secp || typeof secp.getSharedSecret !== 'function' || typeof secp.getPublicKey !== 'function') throw new Error('sealed-input: secp (noble) is needed');
  if (!(stdin instanceof Uint8Array) || !stdin.length) throw new Error('sealed-input: stdin must be the input bytes');
  const workerPub = unhex(pubkey);
  if (workerPub.length !== 33 || (workerPub[0] !== 2 && workerPub[0] !== 3)) throw new Error('sealed-input: the worker key must be a compressed secp256k1 point');
  const rnd = random || ((n) => subtle().getRandomValues(new Uint8Array(n)));
  const priv = rnd(32);
  const epk = secp.getPublicKey(priv, true);
  const key = await sealKey({ secp, priv, peer: workerPub, workerPub, epk });
  const iv = rnd(12);
  const k = await subtle().subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle().subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(SEALED_DOMAIN) }, k, stdin));
  priv.fill(0);
  return { epk: hex(epk), iv: b64(iv), ct: b64(ct) };
}

// The opposite direction, as the worker does it, for tests and for a prover written in JavaScript.
export async function unsealWith({ secp, priv, sealed } = {}) {
  const epk = unhex(sealed.epk);
  const workerPub = secp.getPublicKey(priv, true);
  const key = await sealKey({ secp, priv, peer: epk, workerPub, epk });
  const from64 = (s) => (typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(s, 'base64')) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
  const k = await subtle().subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await subtle().subtle.decrypt({ name: 'AES-GCM', iv: from64(sealed.iv), additionalData: te.encode(SEALED_DOMAIN) }, k, from64(sealed.ct)));
}

// A worker on the board to seal to: one with a key, seen in the last half minute. A worker asks for work every second, so one not seen for more than `freshSeconds` is
// busy or restarting its GPU server (about a minute): a sealed job is addressed to one worker and waits for it, so a worker polling now is chosen over one that is not,
// and among those polling now `prefer` (a name or a prefix) goes first. With one worker nothing changes; with two, a restart of one sends the jobs to the other.
export function pickWorker(summary, { prefer = 'tacit-', maxQuietSeconds = 30, freshSeconds = 5 } = {}) {
  const live = (summary && Array.isArray(summary.workers) ? summary.workers : [])
    .filter((w) => typeof w.pubkey === 'string' && /^0x0[23][0-9a-f]{64}$/i.test(w.pubkey) && Number(w.lastSeenSeconds) <= maxQuietSeconds);
  if (!live.length) return null;
  const polling = (w) => (Number(w.lastSeenSeconds) <= freshSeconds ? 0 : 1);
  const liking = (w) => (w.name === prefer ? 0 : String(w.name).startsWith(prefer) ? 1 : 2);
  return [...live].sort((a, b) => polling(a) - polling(b) || liking(a) - liking(b) || Number(a.lastSeenSeconds) - Number(b.lastSeenSeconds))[0];
}
