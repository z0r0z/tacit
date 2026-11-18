// The private route over Nostr (docs/PRIVATE-ROUTE-NOSTR.md): a sealed request carried by public relays that anyone runs, for when no HTTP forwarder
// answers. The envelope is already sealed to the keeper's gateway key (dapp/sealed-request.js), so a relay sees the sender's address and a blob of a
// few fixed sizes, never what is in it, and nothing here adds trust: the answer is opened with the envelope's own keys, and an answer that does not
// pass its tag is dropped.
//
// Two ephemeral events (relays pass these on and do not keep them), each signed with a key made for it alone:
//   request  kind 21501  tags x = the gateway key id (not p: relays hold a p tag to 32 bytes), t = tacit-route-v1, expiration (NIP-40), nonce (NIP-13, REQ_BITS)  content: the envelope, base64
//   reply    kind 21502  tags e = the request's id, t = tacit-route-v1, expiration                                         content: the sealed answer, base64
import { secp, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';
import { signSchnorr, verifySchnorr } from './bulletproofs.js';
import { eventId, powBits, NOSTR_RELAYS } from './nostr-board.js';

export { NOSTR_RELAYS };
export const REQ_KIND = 21501;
export const REP_KIND = 21502;
export const TAG = 'tacit-route-v1';
export const REQ_BITS = 12;                    // leading zero bits a request's id must have: a phone mines it in well under a second, a flood pays for each one
export const MAX_ENVELOPE = 32 * 1024;         // relays commonly refuse an event over 64 KiB, and base64 adds a third
export const MAX_REPLY = 40 * 1024;
export const WINDOW_SEC = 300;                 // the envelope itself is good for five minutes (dapp/sealed-request.js)

const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s) => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const HEX64 = /^[0-9a-f]{64}$/, HEX128 = /^[0-9a-f]{128}$/;
const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const xonly = (priv) => bytesToHex(secp.getPublicKey(priv, true).slice(1));
const newKey = (randomKey) => { for (;;) { const k = randomKey(); const v = BigInt('0x' + bytesToHex(k)); if (v > 0n && v < ORDER) return k; } };
const defaultKey = () => crypto.getRandomValues(new Uint8Array(32));

// The key id the envelope names: its second to fifth bytes (version, then the 4-byte id of the gateway key).
export const kidOfEnvelope = (bytes) => bytesToHex(bytes.subarray(1, 5));

function finish(ev, priv) {
  ev.id = eventId(ev);
  ev.sig = bytesToHex(signSchnorr(hexToBytes(ev.id), priv));
  return ev;
}

// The request event for an envelope, signed with a key made for it, its id mined to `bits`.
export function makeRequestEvent(bytes, { nowSec = Math.floor(Date.now() / 1000), bits = REQ_BITS, randomKey = defaultKey } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_ENVELOPE) throw new Error('route-nostr: too large for the relays');
  const priv = newKey(randomKey);
  const ev = { pubkey: xonly(priv), created_at: nowSec, kind: REQ_KIND, tags: [['x', kidOfEnvelope(bytes)], ['t', TAG], ['expiration', String(nowSec + WINDOW_SEC)], ['nonce', '0', String(bits)]], content: toB64(bytes) };
  for (let n = 0; ; n++) {
    ev.tags[3][1] = String(n);
    if (powBits(eventId(ev)) >= bits) break;
  }
  return finish(ev, priv);
}

// The envelope in a request event for the key id `kidHex`, or null for anything that is not a well-formed, signed, mined, current request for it.
export function readRequest(ev, { kidHex, nowSec = Math.floor(Date.now() / 1000), minBits = REQ_BITS } = {}) {
  try {
    if (!ev || ev.kind !== REQ_KIND || typeof ev.content !== 'string' || !Array.isArray(ev.tags)) return null;
    if (ev.content.length > Math.ceil(MAX_ENVELOPE * 4 / 3) + 8 || !B64.test(ev.content)) return null;
    if (!HEX64.test(ev.id) || !HEX64.test(ev.pubkey) || !HEX128.test(ev.sig)) return null;
    if (!ev.tags.some((t) => t[0] === 'x' && t[1] === kidHex) || !ev.tags.some((t) => t[0] === 't' && t[1] === TAG)) return null;
    if (ev.created_at < nowSec - WINDOW_SEC || ev.created_at > nowSec + 60) return null;
    const exp = Number(ev.tags.find((t) => t[0] === 'expiration')?.[1]) || 0;
    if (!exp || exp <= nowSec) return null;
    if (eventId(ev) !== ev.id || powBits(ev.id) < minBits) return null;
    if (!verifySchnorr(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey))) return null;
    const bytes = fromB64(ev.content);
    return bytes.length <= MAX_ENVELOPE ? bytes : null;
  } catch { return null; }
}

// The reply event to request `requestId`: the sealed answer, signed with a key made for it.
export function makeReplyEvent(bytes, requestId, { nowSec = Math.floor(Date.now() / 1000), randomKey = defaultKey } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_REPLY) throw new Error('route-nostr: the answer is too large for the relays');
  const priv = newKey(randomKey);
  return finish({ pubkey: xonly(priv), created_at: nowSec, kind: REP_KIND, tags: [['e', requestId], ['t', TAG], ['expiration', String(nowSec + WINDOW_SEC)]], content: toB64(bytes) }, priv);
}

// The sealed answer in a reply event to `requestId`, or null. Whether it is the answer is for the envelope's keys to say: it opens or it does not.
export function readReply(ev, requestId) {
  try {
    if (!ev || ev.kind !== REP_KIND || typeof ev.content !== 'string' || !Array.isArray(ev.tags)) return null;
    if (ev.content.length > Math.ceil(MAX_REPLY * 4 / 3) + 8 || !B64.test(ev.content)) return null;
    if (!HEX64.test(ev.id) || !HEX64.test(ev.pubkey) || !HEX128.test(ev.sig) || eventId(ev) !== ev.id) return null;
    if (!ev.tags.some((t) => t[0] === 'e' && t[1] === requestId) || !ev.tags.some((t) => t[0] === 't' && t[1] === TAG)) return null;
    if (!verifySchnorr(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey))) return null;
    return fromB64(ev.content);
  } catch { return null; }
}

// carry(envelopeBytes, { signal }) → the sealed answer's bytes. The request goes to every relay, each asked for the answer first (these events
// are not kept, so a relay told afterwards has nothing to give); the first answer back wins. It throws when none comes in `timeoutMs`.
// `WS`: a WebSocket constructor (the browser's; `ws` on a server; a stand-in in tests).
export function makeNostrCarrier({ relays = NOSTR_RELAYS, WS = globalThis.WebSocket, timeoutMs = 12000, bits = REQ_BITS, now = () => Date.now(), randomKey } = {}) {
  if (!relays?.length) throw new Error('route-nostr: needs a relay');
  async function carry(bytes, { signal } = {}) {
    const ev = makeRequestEvent(bytes, { nowSec: Math.floor(now() / 1000), bits, ...(randomKey ? { randomKey } : {}) });
    const sub = 'tr' + Math.random().toString(36).slice(2, 10);
    const sockets = new Set();
    let timer;
    const closeAll = () => { clearTimeout(timer); for (const ws of sockets) { try { ws.close(); } catch { /* gone */ } } sockets.clear(); };
    const viaRelay = (url) => new Promise((resolve, reject) => {
      let ws;
      try { ws = new WS(url); } catch (e) { reject(e); return; }
      sockets.add(ws);
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(['REQ', sub, { kinds: [REP_KIND], '#e': [ev.id], since: Math.floor(now() / 1000) - 5 }]));
          ws.send(JSON.stringify(['EVENT', ev]));
        } catch (e) { reject(e); }
      };
      ws.onerror = () => reject(new Error(`relay ${url} failed`));
      ws.onclose = () => reject(new Error(`relay ${url} closed`));
      ws.onmessage = (m) => {
        let x; try { x = JSON.parse(typeof m.data === 'string' ? m.data : ''); } catch { return; }
        if (x[0] === 'EVENT' && x[1] === sub) { const r = readReply(x[2], ev.id); if (r) resolve(r); }
      };
    });
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('no relay carried an answer in time')), timeoutMs);
        if (signal) { if (signal.aborted) return reject(signal.reason ?? new Error('aborted')); signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true }); }
        Promise.any(relays.map(viaRelay)).then(resolve, () => reject(new Error('no relay carried the request')));
      });
    } finally { closeAll(); }
  }
  return { carry, relays };
}
