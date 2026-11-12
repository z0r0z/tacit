// The board where providers post what they offer and where users reach them without a server of the provider's own: a store of
// signed ads and of sealed messages (fastbridge-mailbox.js), and the rules for each. It holds nothing a user or a provider has to
// trust: an ad is signed by the provider's key, a message is sealed to the provider's gateway key and its answer to the user's
// one-time key, so the board can drop or delay a message and can read, change or answer none.
//
//   const board = makeBoard({ now })
//   board.putAd(ad)                     a signed ad (signAd) for a provider's key; replaces that provider's earlier one
//   board.ads()                         the ads still running
//   board.post(gateway, bytes)          a sealed request for the provider whose live ad names that gateway key -> { id, seq }
//   board.inbox(gateway, after)         the requests after a cursor -> { boot, next, items: [{ seq, id, bytes }] }; `boot` names this run of the board,
//                                       whose cursors start again after a restart, so a reader that sees it change reads from the start
//   board.putReply(id, bytes, sig)      the provider's sealed answer, with its signature over it (replySignature)
//   board.reply(id)                     the answer, or null
//   board.putWant(want)                 a user waiting for a provider: a signed want (signWant) under a one-time key; amount 0 takes it down
//   board.wants()                       the wants still standing, so a provider sees what is waiting
//
// A request or an answer is judged by its two ends, not by the board; the board only keeps the traffic bounded (sizes, a queue for
// each provider, lifetimes) and lets only the provider the request was for answer it.

import { sha256, concatBytes, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';
import { signSchnorr, verifySchnorr, bigintToBytes32 } from './bulletproofs.js';

export class BoardError extends Error { constructor(status, message) { super(message); this.status = status; } }

export const LIMITS = { adSecs: 600, skewSecs: 120, msgSecs: 600, replySecs: 600, maxAds: 200, maxQueue: 64, maxPosted: 512, maxMsg: 70000, minMsg: 4000, maxReply: 70000, maxName: 40, wantSecs: 86400, maxWants: 500, maxAd: 2048 };

const te = new TextEncoder();
const hex = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const uint = /^\d{1,30}$/;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
// own members only, whatever their names: `a[k] = v` for a member called __proto__ would set a prototype and leave the member out of what is signed
const canonical = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));

// what an ad says (everything but its signature), as the bytes that are signed
export const adDigest = (ad) => { const { sig, ...body } = ad; return sha256(concatBytes(te.encode('tacit-fast-ad-v1'), te.encode(canonical(body)))); };
export const wantDigest = (w) => { const { sig, ...body } = w; return sha256(concatBytes(te.encode('tacit-fast-want-v1'), te.encode(canonical(body)))); };
export const replyDigest = (id, bytes) => sha256(concatBytes(te.encode('tacit-fast-reply-v1'), te.encode(id), sha256(bytes)));
export const messageId = (bytes) => bytesToHex(sha256(bytes)).slice(0, 32);

const xonly = (pub33) => hexToBytes(pub33).slice(1);
const scalar32 = (priv) => (priv instanceof Uint8Array ? priv : typeof priv === 'bigint' ? bigintToBytes32(priv) : hexToBytes(strip(priv)));

// A provider's ad, signed with its claim key: what it takes and charges, what it can take now, and for how long the ad stands.
export function signAd(ad, claimPriv) {
  const body = { v: 1, ...ad };
  return { ...body, sig: bytesToHex(signSchnorr(adDigest(body), scalar32(claimPriv))) };
}

// Throws a BoardError for an ad that is not whole, not signed by its claim key, or not current.
export function checkAd(ad, now) {
  const bad = (m) => { throw new BoardError(400, m); };
  if (!ad || typeof ad !== 'object' || ad.v !== 1) bad('not an ad');
  for (const k of ['claimPub', 'gateway']) if (!hex(66).test(String(ad[k]))) bad(`the ad's ${k} is not a key`);
  for (const k of ['btcAsset', 'evmAsset']) if (!hex(64).test(strip(ad[k] || ''))) bad(`the ad's ${k} is not an asset`);
  for (const k of ['minAmount', 'maxAmount', 'flatFee']) if (!uint.test(String(ad[k]))) bad(`the ad's ${k} is not an amount`);
  if (ad.available != null && !uint.test(String(ad.available))) bad('the ad\'s available is not an amount');
  for (const [k, max] of [['feeBps', 10000], ['csvBlocks', 4032], ['evmWindowSecs', 86400 * 7]]) if (!Number.isInteger(ad[k]) || ad[k] < 0 || ad[k] > max) bad(`the ad's ${k} is out of range`);
  if (JSON.stringify(ad).length > LIMITS.maxAd) bad('the ad is too large');
  if (ad.name != null && (typeof ad.name !== 'string' || ad.name.length > LIMITS.maxName)) bad('the ad\'s name is too long');
  if (!Number.isInteger(ad.at) || !Number.isInteger(ad.until) || ad.until <= ad.at || ad.until - ad.at > LIMITS.adSecs) bad('the ad\'s time is not valid');
  if (ad.until <= now) bad('the ad has run out');
  if (ad.at > now + LIMITS.skewSecs) bad('the ad is from the future');
  if (typeof ad.sig !== 'string' || !hex(128).test(ad.sig)) bad('the ad is not signed');
  let ok = false;
  try { ok = verifySchnorr(hexToBytes(ad.sig), adDigest(ad), xonly(ad.claimPub)); } catch { ok = false; }
  if (!ok) bad('the ad is not signed by its key');
  return ad;
}

// A user's want: TAC on Bitcoin waiting for a provider, signed with a key made for it alone, so it names no wallet. It moves no funds;
// a provider that sees it starts providing, and the user bridges as with any provider.
export function signWant(want, priv) {
  const body = { v: 1, ...want };
  return { ...body, sig: bytesToHex(signSchnorr(wantDigest(body), scalar32(priv))) };
}

// Throws a BoardError for a want that is not whole, not signed by its key, or not current.
export function checkWant(w, now, wantSecs = LIMITS.wantSecs) {
  const bad = (m) => { throw new BoardError(400, m); };
  if (!w || typeof w !== 'object' || w.v !== 1) bad('not a want');
  if (!hex(66).test(String(w.pub))) bad('the want\'s pub is not a key');
  if (!hex(64).test(strip(w.btcAsset || ''))) bad('the want\'s btcAsset is not an asset');
  if (!uint.test(String(w.amount))) bad('the want\'s amount is not an amount');
  if (!Number.isInteger(w.at) || !Number.isInteger(w.until) || w.until <= w.at || w.until - w.at > wantSecs) bad('the want\'s time is not valid');
  if (w.until <= now) bad('the want has run out');
  if (w.at > now + LIMITS.skewSecs) bad('the want is from the future');
  if (typeof w.sig !== 'string' || !hex(128).test(w.sig)) bad('the want is not signed');
  let ok = false;
  try { ok = verifySchnorr(hexToBytes(w.sig), wantDigest(w), xonly(w.pub)); } catch { ok = false; }
  if (!ok) bad('the want is not signed by its key');
  return w;
}

export function makeBoard({ now = () => Math.floor(Date.now() / 1000), limits = {} } = {}) {
  const L = { ...LIMITS, ...limits };
  const adsBy = new Map();                 // claimPub -> ad
  const queues = new Map();                // gateway -> [{ seq, id, bytes, until }]
  const byId = new Map();                  // message id -> { gateway, claimPub, until }
  const replies = new Map();               // message id -> { bytes, until }
  const wantsBy = new Map();               // want pub -> want
  const goneBy = new Map();                // want pub -> { at, until } of a want taken down, so the original cannot be put back
  const boot = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
  let seq = 0;

  function prune() {
    const t = now();
    for (const [k, ad] of adsBy) if (ad.until <= t) adsBy.delete(k);
    for (const [k, w] of wantsBy) if (w.until <= t) wantsBy.delete(k);
    for (const [k, g] of goneBy) if (g.until <= t) goneBy.delete(k);
    for (const [g, q] of queues) {
      const live = q.filter((m) => m.until > t);
      if (live.length) queues.set(g, live); else queues.delete(g);
    }
    for (const [id, m] of byId) if (m.until <= t) byId.delete(id);
    for (const [id, r] of replies) if (r.until <= t) replies.delete(id);
  }
  const adForGateway = (gateway) => { for (const ad of adsBy.values()) if (ad.gateway === gateway) return ad; return null; };

  return {
    putAd(ad) {
      prune();
      checkAd(ad, now());
      const have = adsBy.get(ad.claimPub);
      if (have && have.at >= ad.at) return { ok: true, kept: true };
      for (const other of adsBy.values()) if (other.gateway === ad.gateway && other.claimPub !== ad.claimPub) throw new BoardError(400, 'that gateway key belongs to another provider');
      if (!have && adsBy.size >= L.maxAds) throw new BoardError(503, 'the board has all the ads it takes');
      adsBy.set(ad.claimPub, ad);
      return { ok: true };
    },
    ads() { prune(); return [...adsBy.values()].sort((a, b) => b.at - a.at); },
    post(gateway, bytes) {
      prune();
      if (!hex(66).test(String(gateway))) throw new BoardError(400, 'not a gateway key');
      if (!(bytes instanceof Uint8Array) || bytes.length < L.minMsg || bytes.length > L.maxMsg) throw new BoardError(413, 'the message is not a sealed request');
      const ad = adForGateway(gateway);
      if (!ad) throw new BoardError(404, 'no provider here has that gateway key');
      const id = messageId(bytes);
      if (byId.has(id)) return { id, seq: byId.get(id).seq, kept: true };
      // `maxQueue` bounds the requests waiting for the provider; `maxPosted` bounds all of a provider's requests that are still kept, answered or not
      let posted = 0;
      for (const x of byId.values()) if (x.gateway === gateway) posted++;
      if (posted >= L.maxPosted) throw new BoardError(503, 'the provider has all the requests it takes');
      const q = queues.get(gateway) || [];
      if (q.length >= L.maxQueue) throw new BoardError(503, 'the provider has all the requests it takes');
      const m = { seq: ++seq, id, bytes, until: now() + L.msgSecs };
      q.push(m); queues.set(gateway, q);
      byId.set(id, { gateway, claimPub: ad.claimPub, seq: m.seq, until: m.until });
      return { id, seq: m.seq };
    },
    inbox(gateway, after = 0) {
      prune();
      const q = (queues.get(gateway) || []).filter((m) => m.seq > after);
      return { boot, next: q.length ? q[q.length - 1].seq : after, items: q.map(({ seq: s, id, bytes }) => ({ seq: s, id, bytes })) };
    },
    putReply(id, bytes, sig) {
      prune();
      const m = byId.get(id);
      if (!m) throw new BoardError(404, 'no such request');
      if (!(bytes instanceof Uint8Array) || bytes.length < 1000 || bytes.length > L.maxReply) throw new BoardError(413, 'the answer is not a sealed reply');
      if (replies.has(id)) return { ok: true, kept: true };
      let ok = false;
      try { ok = verifySchnorr(hexToBytes(String(sig)), replyDigest(id, bytes), xonly(m.claimPub)); } catch { ok = false; }
      if (!ok) throw new BoardError(403, 'the answer is not signed by the provider');
      replies.set(id, { bytes, until: now() + L.replySecs });
      // an answered request no longer waits for the provider: it left in the queue it counted against `maxQueue` for the full ten minutes, and a
      // dozen pages polling the house provider filled the queue with requests it had already answered, so the board turned new ones away with a 503
      // although the provider was keeping up (2026-11-12). The request stays known (`byId`), so the same one posted again is still one request.
      const q = queues.get(m.gateway);
      if (q) { const rest = q.filter((x) => x.id !== id); if (rest.length) queues.set(m.gateway, rest); else queues.delete(m.gateway); }
      return { ok: true };
    },
    reply(id) { prune(); const r = replies.get(id); return r ? r.bytes : null; },
    putWant(w) {
      prune();
      checkWant(w, now(), L.wantSecs);
      const have = wantsBy.get(w.pub), gone = goneBy.get(w.pub);
      if ((have && have.at >= w.at) || (gone && gone.at >= w.at)) return { ok: true, kept: true };
      if (BigInt(w.amount) === 0n) {
        // the want is public, so its taker-down is remembered until it would have run out: replaying the original does not bring it back
        if (have) goneBy.set(w.pub, { at: w.at, until: have.until });
        wantsBy.delete(w.pub);
        return { ok: true, dropped: true };
      }
      if (!have && wantsBy.size >= L.maxWants) throw new BoardError(503, 'the board has all the wants it takes');
      wantsBy.set(w.pub, w);
      return { ok: true };
    },
    wants() { prune(); return [...wantsBy.values()].sort((a, b) => b.at - a.at); },
    stats() { prune(); return { ads: adsBy.size, queued: [...queues.values()].reduce((s, q) => s + q.length, 0), replies: replies.size, wants: wantsBy.size }; },
  };
}
