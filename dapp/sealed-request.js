// The private route: a wallet's request to a keeper, sealed so that what carries it can read none of it.
//
// A request is sealed to the keeper's gateway key and sent through a forwarder, which sees the caller's address and the
// size of the envelope, not what is in it. The keeper's gateway opens it, runs it through the handler a direct request
// would reach, and seals the answer to the same one-time key. The keeper sees the forwarder's address, not the caller's.
//
//   gateway key g (32 bytes, in the keeper's env), G = g·G0 (33 bytes), kid = keccak256("tacit-sealed-kid-v1" ‖ G)[0..4)
//   request   0x02 ‖ kid (4) ‖ E (33) ‖ nonce (16) ‖ ct ‖ tag (16)              E = e·G0, a one-time key of the caller
//   s         = compress(e·G) for the caller, compress(g·E) for the gateway
//   key(l)    = keccak256("tacit-sealed-v2" ‖ l ‖ s ‖ E ‖ nonce [‖ reply nonce]), l = 1 request key, 2 request iv,
//               3 reply key, 4 reply iv (the first 12 bytes of each iv)
//   ct ‖ tag  AES-256-GCM (WebCrypto) of the plaintext under that key and iv, the bytes before ct as additional data
//   plaintext be32(n) ‖ JSON { t, m, p, b } (time, method, path, body) ‖ zeros, up to the next of 4, 8, 16, 32, 64 KiB
//   reply     0x02 ‖ reply nonce (16) ‖ ct ‖ tag (16); plaintext be32(n) ‖ JSON { s, h, z, l } (status, headers, gzip,
//             body length) ‖ body ‖ zeros, up to the next of 1, 4, 16, 64 KiB and then each 64 KiB
//
// Every message has a key of its own (a request's from its one-time key and nonce, a reply's from its own nonce as well), so
// its iv can be derived with it and is never used twice under a key. Only the gateway's key opens a request or makes a reply
// that passes its tag, so a forwarder can drop or delay a request but cannot read it, change it, or answer it. Requests are
// single use: the gateway refuses a one-time key and nonce it has seen and a request more than a few minutes off its clock.
// A reply carries its own nonce, so a request replayed to a gateway that forgot it still gets a fresh key. The cipher is the
// platform's, which runs off the event loop and at memory speed: a page of a million bytes seals in under a millisecond.

import { secp, keccak_256, concatBytes, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';

export class SealedError extends Error {}

const te = new TextEncoder();
const td = new TextDecoder();
const G0 = secp.ProjectivePoint.BASE;
const N = secp.CURVE.n;
const VERSION = 2;
const TAG = te.encode('tacit-sealed-v2');
const KID_TAG = te.encode('tacit-sealed-kid-v1');
const REQUEST_SIZES = [4096, 8192, 16384, 32768, 65536];
const REPLY_SIZES = [1024, 4096, 16384, 65536];
const REPLY_STEP = 65536;
export const MAX_REPLY = 8 << 20;
export const REQUEST_OVERHEAD = 1 + 4 + 33 + 16 + 16;
export const MAX_REQUEST = REQUEST_SIZES[REQUEST_SIZES.length - 1] + REQUEST_OVERHEAD;
export const CLOCK_WINDOW = 300;

const fail = (why) => { throw new SealedError(why); };
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const be32 = (n) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const rd32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const toBig = (b) => { let x = 0n; for (const c of b) x = (x << 8n) | BigInt(c); return x; };
const randomScalar = () => { for (;;) { const s = toBig(random(32)) % N; if (s) return s; } };
const same = (a, b) => { let d = a.length ^ b.length; for (let i = 0; i < a.length && i < b.length; i++) d |= a[i] ^ b[i]; return d === 0; };
const keyOf = (label, s, E, nonce, extra = new Uint8Array(0)) => keccak_256(concatBytes(TAG, Uint8Array.of(label), s, E, nonce, extra));
const ivOf = (label, s, E, nonce, extra) => keyOf(label, s, E, nonce, extra).subarray(0, 12);
const subtle = () => globalThis.crypto?.subtle || fail('the private route needs WebCrypto, which a page has when it is served over https');
async function encrypt(key, iv, aad, pt) {
  const k = await subtle().importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, k, pt));
}
// null when the tag does not pass, whatever the reason.
async function decrypt(key, iv, aad, ct) {
  const k = await subtle().importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  try { return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, k, ct)); } catch { return null; }
}
function sized(n, sizes, step) {
  for (const s of sizes) if (n <= s) return s;
  if (!step) fail('the request is too large for the private route');
  return Math.ceil(n / step) * step;
}
const kidOf = (pub) => keccak_256(concatBytes(KID_TAG, pub)).subarray(0, 4);
const pointOf = (bytes, why = 'not a key') => { try { return secp.ProjectivePoint.fromHex(bytes); } catch { return fail(why); } };

// { g, pub, kid } for the 32-byte hex secret in the keeper's env.
export function gatewayKeys(secretHex) {
  const h = String(secretHex ?? '').replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) fail('the gateway key is 32 bytes of hex');
  const g = BigInt('0x' + h);
  if (g <= 0n || g >= N) fail('the gateway key is out of range');
  const pub = G0.multiply(g).toRawBytes(true);
  return { g, pub, kid: kidOf(pub) };
}

// A new gateway key as hex.
export function newGatewayKey() {
  for (;;) { const b = random(32); const v = toBig(b); if (v > 0n && v < N) return bytesToHex(b); }
}

// { bytes, open } for a request of this caller: bytes go to a forwarder, open(replyBytes) → { status, headers, body }.
export async function sealRequest(gatewayPubHex, { method, path, body = null }, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  const pub = hexToBytes(String(gatewayPubHex).replace(/^0x/, ''));
  const P = pointOf(pub);
  const e = randomScalar();
  const E = G0.multiply(e).toRawBytes(true);
  const s = P.multiply(e).toRawBytes(true);
  const nonce = random(16);
  const json = te.encode(JSON.stringify({ t: now(), m: method, p: path, b: body }));
  const size = sized(4 + json.length, REQUEST_SIZES);
  const pt = new Uint8Array(size);
  pt.set(be32(json.length));
  pt.set(json, 4);
  const head = concatBytes(Uint8Array.of(VERSION), kidOf(pub), E, nonce);
  const bytes = concatBytes(head, await encrypt(keyOf(1, s, E, nonce), ivOf(2, s, E, nonce), head, pt));
  return { bytes, open: (reply) => openReply(s, E, nonce, reply) };
}

async function gunzip(bytes) {
  const r = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
  return new Uint8Array(await r.arrayBuffer());
}

async function openReply(s, E, nonce, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 + 16 + REPLY_SIZES[0] + 16 || bytes[0] !== VERSION) fail('not a reply');
  const rn = bytes.subarray(1, 17);
  const pt = await decrypt(keyOf(3, s, E, nonce, rn), ivOf(4, s, E, nonce, rn), bytes.subarray(0, 17), bytes.subarray(17));
  if (!pt) fail('the reply did not pass its tag');
  const metaLen = rd32(pt, 0);
  if (4 + metaLen > pt.length) fail('not a reply');
  let meta;
  try { meta = JSON.parse(td.decode(pt.subarray(4, 4 + metaLen))); } catch { fail('not a reply'); }
  if (!Number.isInteger(meta.s) || !Number.isInteger(meta.l) || 4 + metaLen + meta.l > pt.length) fail('not a reply');
  let body = pt.subarray(4 + metaLen, 4 + metaLen + meta.l);
  if (meta.z) body = await gunzip(body);
  return { status: meta.s, headers: meta.h && typeof meta.h === 'object' ? meta.h : {}, body };
}

// The gateway's side. `seen(id, until)` answers whether a request is new and remembers it; a request is refused when
// its time is more than `window` seconds from `now`. Throws SealedError for anything that is not a fresh, whole request
// for this gateway, and says no more than that. → { method, path, body, reply(status, headers, body, { gzip }) }.
export async function openRequest(keys, bytes, { now = () => Math.floor(Date.now() / 1000), window = CLOCK_WINDOW, seen = () => true } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length < REQUEST_OVERHEAD + REQUEST_SIZES[0] || bytes.length > MAX_REQUEST || bytes[0] !== VERSION) fail('not a request');
  if (!same(bytes.subarray(1, 5), keys.kid)) fail('not a request');
  const E = bytes.subarray(5, 38), nonce = bytes.subarray(38, 54), sealed = bytes.subarray(54);
  if (!REQUEST_SIZES.includes(sealed.length - 16)) fail('not a request');
  const s = pointOf(E, 'not a request').multiply(keys.g).toRawBytes(true);
  const pt = await decrypt(keyOf(1, s, E, nonce), ivOf(2, s, E, nonce), bytes.subarray(0, 54), sealed);
  if (!pt) fail('not a request');
  const n = rd32(pt, 0);
  if (4 + n > pt.length) fail('not a request');
  let req;
  try { req = JSON.parse(td.decode(pt.subarray(4, 4 + n))); } catch { fail('not a request'); }
  if (!req || typeof req.m !== 'string' || typeof req.p !== 'string' || !Number.isFinite(req.t)) fail('not a request');
  const t = now();
  if (Math.abs(t - req.t) > window) fail('the request is off the clock');
  if (!seen(bytesToHex(concatBytes(E, nonce)), t + 2 * window)) fail('the request was seen');
  return {
    method: req.m, path: req.p, body: req.b ?? null,
    async reply(status, headers, body, { gzip = false } = {}) {
      const rn = random(16);
      const meta = te.encode(JSON.stringify({ s: status, h: headers, z: gzip ? 1 : 0, l: body.length }));
      const size = sized(4 + meta.length + body.length, REPLY_SIZES, REPLY_STEP);
      if (size > MAX_REPLY) fail('the reply is too large');
      const out = new Uint8Array(size);
      out.set(be32(meta.length));
      out.set(meta, 4);
      out.set(body, 4 + meta.length);
      const head = concatBytes(Uint8Array.of(VERSION), rn);
      return concatBytes(head, await encrypt(keyOf(3, s, E, nonce, rn), ivOf(4, s, E, nonce, rn), head, out));
    },
  };
}

const shuffled = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = random(4).reduce((x, b) => x * 256 + b, 0) % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

// A fetch for the wallet's `fetchImpl` that carries its requests to `keeper` through the forwarders: each is sealed to the
// gateway key `gateway` (33 bytes of hex, pinned by the page) and sent to a forwarder chosen at random, the next one if that
// fails. It answers like fetch, and never falls back to a direct request, which would show the caller's address.
// `fetch.sealed` is true: the wallet then sends without a reservation, which the private route does not carry.
export function makeSealedFetch({ keeper, chainId, gateway, forwarders, fetchImpl = globalThis.fetch?.bind(globalThis), now }) {
  const base = String(keeper).replace(/\/+$/, '');
  if (!forwarders?.length) fail('the private route needs a forwarder');
  pointOf(hexToBytes(String(gateway).replace(/^0x/, '')));
  const f = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith(base + '/')) fail('the private route carries requests to its own keeper only');
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body == null ? null : JSON.parse(init.body);
    let last = new SealedError('the private route did not answer');
    for (const fw of shuffled(forwarders)) {
      const sealed = await sealRequest(gateway, { method, path: u.slice(base.length), body }, { now });
      let r;
      try {
        r = await fetchImpl(`${String(fw).replace(/\/+$/, '')}/f/${chainId}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: sealed.bytes, signal: init.signal });
      } catch (e) { last = e; continue; }
      if (r.status !== 200) {
        last = new SealedError(`a forwarder answered ${r.status}`);
        if (r.status < 500 && r.status !== 429) throw last;
        continue;
      }
      try {
        const out = await sealed.open(new Uint8Array(await r.arrayBuffer()));
        return new Response(out.body, { status: out.status, headers: out.headers });
      } catch (e) { last = e; }
    }
    throw last;
  };
  f.sealed = true;
  return f;
}
