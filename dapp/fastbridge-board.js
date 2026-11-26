// The board where providers post what they offer and where users reach them without a server of the provider's own: a store of
// signed ads and of sealed messages (fastbridge-mailbox.js), and the rules for each. It holds nothing a user or a provider has to
// trust: an ad is signed by the provider's key, a message is sealed to the provider's gateway key and its answer to the user's
// one-time key, so the board can drop or delay a message and can read, change or answer none.
//
//   const board = makeBoard({ now })
//   board.putAd(ad)                     a signed ad (signAd) for a provider's key; replaces that provider's earlier one
//   board.ads()                         the ads still running
//   board.post(gateway, bytes, { claimPub?, client? })
//                                       a sealed request for the provider whose live ad names that gateway key (for the one of `claimPub`, when named) -> { id, seq }
//   board.inbox(gateway, after)         the requests after a cursor -> { boot, next, items: [{ seq, id, bytes, from? }] }; `boot` names this run of the board,
//                                       whose cursors start again after a restart, so a reader that sees it change reads from the start; `from` tells the
//                                       requests of one client address apart (a tag keyed by a secret of this board, for this gateway, that changes every few
//                                       hours: it names no address), so a provider can give each client its own share
//   board.putReply(id, bytes, sig)      the provider's sealed answer, with its signature over it (replySignature)
//   board.drop(id, sig)                 the provider sets aside a request it cannot open, signed over dropDigest(id), so it waits in the queue no longer
//   board.reply(id)                     the answer, or null
//   board.putWant(want)                 a user waiting for a provider: a signed want (signWant) under a one-time key; amount 0 takes it down
//   board.wants()                       the wants still standing, so a provider sees what is waiting
//
// A request or an answer is judged by its two ends, not by the board; the board only keeps the traffic bounded (sizes, a queue for
// each provider, lifetimes) and lets only the provider the request was for answer it.

import { sha256, hmac, concatBytes, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';
import { signSchnorr, verifySchnorr, bigintToBytes32 } from './bulletproofs.js';

export class BoardError extends Error { constructor(status, message) { super(message); this.status = status; } }

export const LIMITS = {
  adSecs: 600, skewSecs: 120, msgSecs: 600, replySecs: 600, maxAds: 200, maxQueue: 64, maxPosted: 512, maxMsg: 70000, minMsg: 4000, maxReply: 70000, maxName: 40, wantSecs: 86400, maxWants: 500, maxAd: 2048,
  // one address's share of a provider's queue, the bytes a provider's queue and its answers may hold, the answers' bytes on the whole board, and how much one inbox read returns
  maxQueueFrom: 24, maxQueueBytes: 1 << 20, maxReplyBytes: 2 << 20, maxRepliesBytes: 128 << 20, maxInboxItems: 32, maxInboxBytes: 1 << 20,
  // the requests one address has posted to a provider that are still known, the bytes waiting in all the queues together, the requests the whole board keeps
  // known (answered ones past it are forgotten oldest first), and how often the tag of a client address changes
  maxPostedFrom: 600, maxQueuesBytes: 64 << 20, maxKept: 200000, fromSecs: 6 * 3600,
};

const te = new TextEncoder();
const hex = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const uint = /^\d{1,30}$/;
const isStr = (v) => typeof v === 'string';
// an amount is digits in a string, or a whole number written as one; nothing else (a list holding one, a fraction) reads as an amount
const isAmount = (v) => (isStr(v) && uint.test(v)) || (Number.isSafeInteger(v) && v >= 0);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
// own members only, whatever their names: `a[k] = v` for a member called __proto__ would set a prototype and leave the member out of what is signed
const canonical = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));

// The members an ad, its reverse terms and a want may have, and no others: the board and every page that reads an ad check them (checkAd, checkWant), so a
// signed ad with a member of its own (a name like __proto__, junk, a field no reader looks for) is not listed, and a new member reaches the board and the pages
// that read it together. A provider whose ad carries one a page does not yet know is not shown by that page until it is updated.
export const AD_MEMBERS = ['v', 'claimPub', 'gateway', 'btcAsset', 'evmAsset', 'minAmount', 'maxAmount', 'available', 'feeBps', 'flatFee', 'csvBlocks', 'evmWindowSecs', 'anyTac', 'reverse', 'name', 'at', 'until', 'sig'];
export const REVERSE_MEMBERS = ['minAmount', 'maxAmount', 'available', 'feeBps', 'flatFee', 'csvBlocks', 'evmWindowSecs'];
export const WANT_MEMBERS = ['v', 'pub', 'btcAsset', 'amount', 'maxFeeBps', 'at', 'until', 'sig'];
// a name is shown as it is written: no markup brackets, no control, line or paragraph separator characters, and no marks that turn the direction of text
const NAME_OK = /^[^<>\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]*$/u;
const onlyMembers = (o, allowed, what, bad) => {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`${what} has a member it does not take${/^\w{1,24}$/.test(k) ? `: ${k}` : ''}`);
};

// what an ad says (everything but its signature), as the bytes that are signed
export const adDigest = (ad) => { const { sig, ...body } = ad; return sha256(concatBytes(te.encode('tacit-fast-ad-v1'), te.encode(canonical(body)))); };
export const wantDigest = (w) => { const { sig, ...body } = w; return sha256(concatBytes(te.encode('tacit-fast-want-v1'), te.encode(canonical(body)))); };
export const replyDigest = (id, bytes) => sha256(concatBytes(te.encode('tacit-fast-reply-v1'), te.encode(id), sha256(bytes)));
export const messageId = (bytes) => bytesToHex(sha256(bytes)).slice(0, 32);
export const dropDigest = (id) => sha256(concatBytes(te.encode('tacit-fast-drop-v1'), te.encode(id)));
// A provider is shown by a label made from its key and the name it gives, never by that name as written; the site's own providers (their claim keys, which sign
// their ads, so no other ad can wear them) are shown by the site's name for them. The label is 12 hex digits (48 bits): another key does not come by the same one.
export const OWN_PROVIDERS = Object.freeze({
  '0328522a56ebeba820c4bcf23ed102026702b711caea618e32f8a050e4b25b7d84': 'Tacit',      // TAC for TAC (fastbridge-lp/config.render.json)
  '028bfd499e1c84805a3d8ceaf671e6bb46507fb13c02102f27f65f1682a2cf4171': 'Tacit',      // Bitcoin and ETH (fastbridge-lp/config.btc-eth.render.json)
});
export const adLabel = (ad) => OWN_PROVIDERS[String(ad.claimPub || '').replace(/^0x/, '').toLowerCase()] || `Provider ${bytesToHex(sha256(te.encode(`${String(ad.claimPub || '').replace(/^0x/, '').toLowerCase()}:${String(ad.name || '')}`))).slice(0, 12)}`;

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
  for (const k of ['claimPub', 'gateway']) if (!isStr(ad[k]) || !hex(66).test(ad[k])) bad(`the ad's ${k} is not a key`);
  for (const k of ['btcAsset', 'evmAsset']) if (!isStr(ad[k]) || !hex(64).test(strip(ad[k]))) bad(`the ad's ${k} is not an asset`);
  for (const k of ['minAmount', 'maxAmount', 'flatFee']) if (!isAmount(ad[k])) bad(`the ad's ${k} is not an amount`);
  if (ad.available != null && !isAmount(ad.available)) bad('the ad\'s available is not an amount');
  if (ad.anyTac != null && typeof ad.anyTac !== 'boolean') bad('the ad\'s anyTac is not true or false');
  for (const [k, max] of [['feeBps', 10000], ['csvBlocks', 4032], ['evmWindowSecs', 86400 * 7]]) if (!Number.isInteger(ad[k]) || ad[k] < 0 || ad[k] > max) bad(`the ad's ${k} is out of range`);
  // A provider that also sells the other way (TAC on Bitcoin for private TAC in the pool) says so with the terms of that direction. The assets are the ad's own.
  if (ad.reverse != null) {
    const r = ad.reverse;
    if (!r || typeof r !== 'object' || Array.isArray(r)) bad('the ad\'s reverse terms are not terms');
    for (const k of ['minAmount', 'maxAmount', 'flatFee']) if (!isAmount(r[k])) bad(`the ad's reverse ${k} is not an amount`);
    if (r.available != null && !isAmount(r.available)) bad('the ad\'s reverse available is not an amount');
    for (const [k, max] of [['feeBps', 10000], ['csvBlocks', 4032], ['evmWindowSecs', 86400 * 7]]) if (!Number.isInteger(r[k]) || r[k] < 0 || r[k] > max) bad(`the ad's reverse ${k} is out of range`);
  }
  if (JSON.stringify(ad).length > LIMITS.maxAd) bad('the ad is too large');
  onlyMembers(ad, AD_MEMBERS, 'the ad', bad);
  if (ad.reverse != null) onlyMembers(ad.reverse, REVERSE_MEMBERS, 'the ad\'s reverse terms', bad);
  if (ad.name != null && (typeof ad.name !== 'string' || ad.name.length > LIMITS.maxName)) bad('the ad\'s name is too long');
  if (ad.name != null && !NAME_OK.test(ad.name)) bad('the ad\'s name has characters a name may not');
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
// a provider that sees it starts providing, and the user bridges as with any provider. It may name the most the holder will pay, `maxFeeBps`:
// what the provider keeps (its rate and its flat part together) as hundredths of a percent of the amount. A want that names none takes any fee
// the page quotes. The price is signed with the rest, so no one on the way can change it, and a board that knows nothing of it keeps it as it came.
export function signWant(want, priv) {
  const body = { v: 1, ...want };
  return { ...body, sig: bytesToHex(signSchnorr(wantDigest(body), scalar32(priv))) };
}

// Throws a BoardError for a want that is not whole, not signed by its key, or not current.
export function checkWant(w, now, wantSecs = LIMITS.wantSecs) {
  const bad = (m) => { throw new BoardError(400, m); };
  if (!w || typeof w !== 'object' || w.v !== 1) bad('not a want');
  onlyMembers(w, WANT_MEMBERS, 'the want', bad);
  if (!isStr(w.pub) || !hex(66).test(w.pub)) bad('the want\'s pub is not a key');
  if (!isStr(w.btcAsset) || !hex(64).test(strip(w.btcAsset))) bad('the want\'s btcAsset is not an asset');
  if (!isAmount(w.amount)) bad('the want\'s amount is not an amount');
  if (w.maxFeeBps != null && (!Number.isInteger(w.maxFeeBps) || w.maxFeeBps < 0 || w.maxFeeBps > 10000)) bad('the want\'s maxFeeBps is out of range');
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
  const queues = new Map();                // gateway -> [{ seq, id, bytes, until, from }]
  const byId = new Map();                  // message id -> { gateway, claimPub, until, from, open }
  const openBy = new Map();                // gateway -> its requests not yet answered or set aside
  const postedBy = new Map();              // gateway|client -> the requests of that address still known
  const replies = new Map();               // message id -> { bytes, until, gateway }
  const replyBytes = new Map();            // gateway -> bytes of its answers still kept
  const wantsBy = new Map();               // want pub -> want
  const goneBy = new Map();                // want pub -> { at, until } of a want taken down, so the original cannot be put back
  const boot = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
  const secret = crypto.getRandomValues(new Uint8Array(32));
  let seq = 0, repliesTotal = 0, queuedTotal = 0, pruned = null;
  const bump = (m, k, d) => { const n = (m.get(k) || 0) + d; if (n > 0) m.set(k, n); else m.delete(k); };
  // a request is no longer waiting (answered, set aside, or run out): it leaves the provider's count of open ones
  const close = (m) => { if (m.open) { m.open = false; bump(openBy, m.gateway, -1); } };
  const forget = (id) => {
    const m = byId.get(id);
    if (!m) return;
    close(m); byId.delete(id);
    if (m.from != null) bump(postedBy, `${m.gateway}|${m.from}`, -1);
  };
  // the tag of a client address in a provider's inbox: keyed by this board's secret and the time, so it names no address and changes every `fromSecs`
  const tagOf = (gateway, client) => (client == null ? null : bytesToHex(hmac(sha256, secret, te.encode(`${Math.floor(now() / L.fromSecs)}|${gateway}|${client}`))).slice(0, 16));

  const forgetReply = (id) => {
    const r = replies.get(id);
    if (!r) return;
    replies.delete(id);
    repliesTotal -= r.bytes.length;
    const left = (replyBytes.get(r.gateway) || 0) - r.bytes.length;
    if (left > 0) replyBytes.set(r.gateway, left); else replyBytes.delete(r.gateway);
  };
  const unqueue = (gateway, id) => {
    const q = queues.get(gateway);
    if (!q) return;
    const rest = [];
    for (const x of q) { if (x.id === id) queuedTotal -= x.bytes.length; else rest.push(x); }
    if (rest.length) queues.set(gateway, rest); else queues.delete(gateway);
  };
  // once a second at most: every call prunes, and what runs out does so by the second
  function prune() {
    const t = now();
    if (t === pruned) return;
    pruned = t;
    for (const [k, ad] of adsBy) if (ad.until <= t) adsBy.delete(k);
    for (const [k, w] of wantsBy) if (w.until <= t) wantsBy.delete(k);
    for (const [k, g] of goneBy) if (g.until <= t) goneBy.delete(k);
    for (const [g, q] of queues) {
      const live = [];
      for (const m of q) { if (m.until > t) live.push(m); else queuedTotal -= m.bytes.length; }
      if (live.length) queues.set(g, live); else queues.delete(g);
    }
    for (const [id, m] of byId) if (m.until <= t) forget(id);
    for (const [id, r] of replies) if (r.until <= t) forgetReply(id);
  }
  // The ad a request is for. A user's page names the provider it chose (`claimPub`), and the request is for that provider's ad alone. A page that
  // names none reaches the ad that has named the gateway longest, as it always did. More than one key may name a gateway: each ad is signed by
  // its own key, and the request is answered only under the key it is for, so a second ad that names a gateway reaches no request of the first.
  const adFor = (gateway, claimPub) => {
    if (claimPub != null) { const ad = adsBy.get(claimPub); return ad && ad.gateway === gateway ? ad : null; }
    let first = null;
    for (const ad of adsBy.values()) if (ad.gateway === gateway && (!first || ad.since < first.since)) first = ad;
    return first;
  };

  return {
    putAd(ad) {
      prune();
      checkAd(ad, now());
      const have = adsBy.get(ad.claimPub);
      if (have && have.at >= ad.at) return { ok: true, kept: true };
      // (the site's own keys are taken whatever else is on the board: no run of other ads keeps them off it)
      if (!have && adsBy.size >= L.maxAds && !OWN_PROVIDERS[ad.claimPub]) throw new BoardError(503, 'the board has all the ads it takes');
      // `since`: when this key first named this gateway in an ad that has stood since, which orders the ads of one gateway for a page that names no key
      const since = have && have.gateway === ad.gateway ? have.since : now();
      adsBy.set(ad.claimPub, Object.defineProperty({ ...ad }, 'since', { value: since, enumerable: false }));
      return { ok: true };
    },
    ads() { prune(); return [...adsBy.values()].sort((a, b) => b.at - a.at); },
    post(gateway, bytes, { claimPub = null, client = null } = {}) {
      prune();
      if (!hex(66).test(String(gateway))) throw new BoardError(400, 'not a gateway key');
      if (claimPub != null && !hex(66).test(String(claimPub))) throw new BoardError(400, 'not a provider key');
      if (!(bytes instanceof Uint8Array) || bytes.length < L.minMsg || bytes.length > L.maxMsg) throw new BoardError(413, 'the message is not a sealed request');
      const ad = adFor(gateway, claimPub);
      if (!ad) throw new BoardError(404, 'no provider here has that gateway key');
      const id = messageId(bytes);
      if (byId.has(id)) return { id, seq: byId.get(id).seq, kept: true };
      // `maxQueue` and `maxPosted` bound the requests waiting for the provider (one answered or set aside waits no longer, though it stays known for a while);
      // `maxPostedFrom` the requests one address has posted to it that are still known, answered or not, so one address's traffic turns only itself away
      if ((openBy.get(gateway) || 0) >= L.maxPosted) throw new BoardError(503, 'the provider has all the requests it takes');
      if (client != null && (postedBy.get(`${gateway}|${client}`) || 0) >= L.maxPostedFrom) throw new BoardError(503, 'the provider has all the requests it takes from this address');
      const q = queues.get(gateway) || [];
      if (q.length >= L.maxQueue) throw new BoardError(503, 'the provider has all the requests it takes');
      // and no one address takes the whole of it, nor large requests all of its room, nor all the providers' queues together the board's memory
      if (client != null && q.filter((m) => m.from === client).length >= L.maxQueueFrom) throw new BoardError(503, 'the provider has all the requests it takes from this address');
      if (q.reduce((n, m) => n + m.bytes.length, 0) + bytes.length > L.maxQueueBytes) throw new BoardError(503, 'the provider has all the requests it takes');
      if (queuedTotal + bytes.length > L.maxQueuesBytes) throw new BoardError(503, 'the board has all the requests it takes just now');
      // the requests known to the board are bounded as a whole: past it, the oldest that wait no longer are forgotten (the provider drops a request it sees again)
      if (byId.size >= L.maxKept) {
        for (const [k, x] of byId) { if (byId.size < L.maxKept) break; if (!x.open) forget(k); }
        if (byId.size >= L.maxKept) throw new BoardError(503, 'the board has all the requests it takes just now');
      }
      const m = { seq: ++seq, id, bytes, until: now() + L.msgSecs, from: client };
      q.push(m); queues.set(gateway, q); queuedTotal += bytes.length;
      byId.set(id, { gateway, claimPub: ad.claimPub, seq: m.seq, until: m.until, from: client, open: true, tag: tagOf(gateway, client) });
      bump(openBy, gateway, 1);
      if (client != null) bump(postedBy, `${gateway}|${client}`, 1);
      return { id, seq: m.seq };
    },
    // the requests after a cursor, a page at a time: `next` is the last one returned, so a reader that goes on from it reads the rest
    inbox(gateway, after = 0) {
      prune();
      const items = [];
      let size = 0;
      for (const m of queues.get(gateway) || []) {
        if (m.seq <= after) continue;
        if (items.length >= L.maxInboxItems || (items.length && size + m.bytes.length > L.maxInboxBytes)) break;
        const tag = byId.get(m.id)?.tag;
        items.push({ seq: m.seq, id: m.id, bytes: m.bytes, ...(tag ? { from: tag } : {}) }); size += m.bytes.length;
      }
      return { boot, next: items.length ? items[items.length - 1].seq : after, items };
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
      if ((replyBytes.get(m.gateway) || 0) + bytes.length > L.maxReplyBytes || repliesTotal + bytes.length > L.maxRepliesBytes) throw new BoardError(503, 'the board has all the answers it keeps just now');
      replies.set(id, { bytes, until: now() + L.replySecs, gateway: m.gateway });
      replyBytes.set(m.gateway, (replyBytes.get(m.gateway) || 0) + bytes.length);
      repliesTotal += bytes.length;
      // an answered request no longer waits for the provider: it left in the queue it counted against `maxQueue` for the full ten minutes, and a
      // dozen pages polling the house provider filled the queue with requests it had already answered, so the board turned new ones away with a 503
      // although the provider was keeping up (2026-11-12). The request stays known (`byId`), so the same one posted again is still one request.
      unqueue(m.gateway, id); close(m);
      return { ok: true };
    },
    // A request the provider could not open leaves the queue, as an answered one does, and stays known, so the same bytes posted again are not queued again.
    drop(id, sig) {
      prune();
      const m = byId.get(id);
      if (!m) throw new BoardError(404, 'no such request');
      let ok = false;
      try { ok = verifySchnorr(hexToBytes(String(sig)), dropDigest(id), xonly(m.claimPub)); } catch { ok = false; }
      if (!ok) throw new BoardError(403, 'not signed by the provider');
      unqueue(m.gateway, id); close(m);
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
    stats() { prune(); return { ads: adsBy.size, queued: [...queues.values()].reduce((s, q) => s + q.length, 0), queuedBytes: queuedTotal, known: byId.size, replies: replies.size, replyBytes: repliesTotal, wants: wantsBy.size }; },
  };
}
