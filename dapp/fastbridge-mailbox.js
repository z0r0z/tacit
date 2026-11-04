// A provider reached through a board (fastbridge-board.js) instead of a server of its own: the user's calls are sealed to the
// provider's gateway key and left on the board, the provider's answers are sealed back to the call's one-time key, and each side
// polls. The requests are the ones of the HTTP API (fastbridge-provider.js `handle`), so a provider in a browser tab, which
// cannot serve a request, answers the same calls a daemon does. The sealing is the private route's (sealed-request.js).
//
//   const counter = makeMailboxCounter({ board, gateway })            the user's side: a counter for the Bitcoin locker
//   const mail = makeMailboxServer({ board, keys, handle, signReply })  the provider's side: mail.pump() answers what has arrived
//   const ads = makeAdPublisher({ board, handle, claimPriv, claimPub, keys })   ads.publish() posts the provider's current terms
//   const provider = makeProvider({ service, board, claimPriv, claimPub, keys })  all three on timers, with the service's tick
//
//   board   { post(gateway, bytes), reply(id), inbox(gateway, after), putReply(id, bytes, sig), putAd(ad), ads() }: a Board object
//           (fastbridge-board.js), or the same calls over HTTP (makeBoardClient)

import { sealRequest, openRequest, gatewayKeys } from './sealed-request.js';
import { makeCounter } from './fastbridge-http.js';
import { checkAd, messageId, replyDigest, signAd } from './fastbridge-board.js';
import { signSchnorr, bigintToBytes32 } from './bulletproofs.js';
import { hmac, sha256, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';

const te = new TextEncoder();
const td = new TextDecoder();
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const scalar32 = (priv) => (priv instanceof Uint8Array ? priv : typeof priv === 'bigint' ? bigintToBytes32(priv) : hexToBytes(strip(priv)));

// The gateway key a provider opens requests with, made from its own key and not the key its swaps are signed with.
export const gatewayOf = (claimPriv) => gatewayKeys(bytesToHex(hmac(sha256, scalar32(claimPriv), te.encode('tacit-fastbridge-gateway-v1'))));

// ── the user's side ──

export function makeMailboxCall({ board, gateway, now, pollMs = 1500, timeoutMs = 45000, sleep = sleepMs, clock = () => Date.now() }) {
  return async (method, path, body) => {
    const sealed = await sealRequest(gateway, { method, path, body: body === undefined ? null : body }, now ? { now } : undefined);
    const { id } = await board.post(gateway, sealed.bytes);
    if (id !== messageId(sealed.bytes)) throw new Error('the board kept the request under another name');
    for (const start = clock(); clock() - start < timeoutMs;) {
      await sleep(pollMs);
      const bytes = await board.reply(id);
      if (!bytes) continue;
      const out = await sealed.open(bytes);
      let json = null;
      try { json = JSON.parse(td.decode(out.body)); } catch { /* an answer with no body */ }
      return { status: out.status, body: json };
    }
    throw new Error('the provider did not answer');
  };
}
export const makeMailboxCounter = (opts) => makeCounter(makeMailboxCall(opts));

// The providers whose ads are on the board and check out: signed by their key, current, and naming the gateway key their
// requests are to be sealed to. Each comes with a counter for the Bitcoin locker.
export async function readProviders({ board, now = () => Math.floor(Date.now() / 1000), call = {} }) {
  const out = [];
  for (const ad of await board.ads()) {
    try { checkAd(ad, now()); } catch { continue; }
    out.push({ id: ad.claimPub, kind: 'mailbox', name: ad.name || 'Provider', ad, counter: makeMailboxCounter({ board, gateway: ad.gateway, now, ...call }) });
  }
  return out;
}

// ── the provider's side ──

export function makeMailboxServer({ board, keys, handle, signReply, now = () => Math.floor(Date.now() / 1000), pollMs = 2000, log = () => {} }) {
  const gw = bytesToHex(keys.pub);
  const seen = new Map();
  let after = 0, boot = null, busy = false, timer = null;
  // a request is answered once: a one-time key and nonce seen again is dropped
  const fresh = (id, until) => {
    const t = now();
    for (const [k, u] of seen) if (u <= t) seen.delete(k);
    if (seen.has(id)) return false;
    seen.set(id, until);
    return true;
  };
  async function pump() {
    if (busy) return 0;
    busy = true;
    let n = 0;
    try {
      let r = await board.inbox(gw, after);
      // a board that has restarted numbers its messages from the start: a cursor from before it would skip every new one, so a changed run is read from 0 (a request already answered is dropped by `fresh`)
      if (r.boot && r.boot !== boot) { if (boot) { after = 0; r = await board.inbox(gw, 0); } boot = r.boot; }
      const { next, items } = r;
      for (const m of items) {
        n++;
        try {
          const req = await openRequest(keys, m.bytes, { now, seen: fresh });
          const out = await handle({ method: req.method, path: req.path, body: req.body });
          const bytes = await req.reply(out.status, {}, te.encode(JSON.stringify(out.body)));
          await board.putReply(m.id, bytes, bytesToHex(signReply(replyDigest(m.id, bytes))));
        } catch (e) { log({ level: 'warn', msg: 'a request was not answered', error: String((e && e.message) || e).slice(0, 120) }); }
        after = m.seq;
      }
      if (!items.length) after = Math.max(after, next);
    } finally { busy = false; }
    return n;
  }
  return {
    pump,
    start() { if (!timer) timer = setInterval(() => { pump().catch((e) => log({ level: 'warn', msg: 'the board could not be read', error: String((e && e.message) || e).slice(0, 120) })); }, pollMs); },
    stop() { clearInterval(timer); timer = null; },
  };
}

// The provider's ad: its terms and what it can take now, read from its own handler, signed with its claim key.
export function makeAdPublisher({ board, handle, claimPriv, claimPub, keys, name = null, now = () => Math.floor(Date.now() / 1000), everySecs = 60, log = () => {} }) {
  let timer = null;
  async function publish() {
    const r = await handle({ method: 'GET', path: '/info', body: null });
    if (r.status !== 200 || !r.body) return null;
    const i = r.body, t = now();
    const ad = signAd({
      claimPub, gateway: bytesToHex(keys.pub), btcAsset: strip(i.btcAsset), evmAsset: strip(i.evmAsset), minAmount: String(i.minAmount), maxAmount: String(i.maxAmount),
      available: i.available == null ? null : String(i.available), feeBps: i.feeBps, flatFee: String(i.flatFee), csvBlocks: i.csvBlocks, evmWindowSecs: i.evmWindowSecs,
      ...(name ? { name } : {}), at: t, until: t + 2 * everySecs + 60,
    }, claimPriv);
    await board.putAd(ad);
    return ad;
  }
  return {
    publish,
    start() { if (!timer) { const go = () => publish().catch((e) => log({ level: 'warn', msg: 'the ad was not posted', error: String((e && e.message) || e).slice(0, 120) })); go(); timer = setInterval(go, everySecs * 1000); } },
    stop() { clearInterval(timer); timer = null; },
  };
}

// The whole of a provider: its service ticking, its mailbox answered and its ad kept current.
export function makeProvider({ service, board, claimPriv, claimPub, keys, name = null, now, tickSecs = 15, pollMs = 2000, adEverySecs = 60, log = () => {} }) {
  const priv = scalar32(claimPriv);
  const mail = makeMailboxServer({ board, keys, handle: service.handle, signReply: (d) => signSchnorr(d, priv), now, pollMs, log });
  const ads = makeAdPublisher({ board, handle: service.handle, claimPriv: priv, claimPub, keys, name, now, everySecs: adEverySecs, log });
  let ticker = null, busy = false;
  return {
    mail, ads,
    async start() {
      await service.start();
      mail.start(); ads.start();
      ticker = setInterval(async () => { if (busy) return; busy = true; try { await service.tick(); } finally { busy = false; } }, tickSecs * 1000);
    },
    stop() { mail.stop(); ads.stop(); clearInterval(ticker); ticker = null; },
  };
}
