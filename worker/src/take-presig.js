// The pre-signed takes of ETH-for-Bitcoin swaps (dapp/take-presig.js), kept where a watcher can read them whatever the swap's provider does.
//
// A user who sells ETH for Bitcoin signs the take of the provider's Bitcoin lock ahead, except for the one number only the provider's claim on the pool reveals
// (t), and posts that here. It reveals nothing without t, so it is public by design: a watcher (worker-relay/src/take-watcher.js) reads these, follows the pool for
// the claim, and finishes the take to the USER's own address (the signature commits that output; nobody can change it). The API is a mailbox for them and cannot
// change what is valid: every record is checked against the key that made it (the pre-signature must verify for exactly the take it names), and the watcher checks
// again before it broadcasts anything.
//
//   POST /take-presig               { presig }        verified, then kept until it expires; { ok: true } (the page says its BTC is watched only on this)
//   GET  /take-presig?lock=txid:vout                  the pre-signatures for that Bitcoin lock output
//   GET  /take-presig                                 every unexpired one, oldest first (a watcher's poll; capped)
//
// A pre-signature names a lock output, and nothing here can say whether the chain has that output with that script: the watcher checks that before it acts.
// Open (no key to ask for), rate limited per client, size capped, and at most MAX_PER_LOCK for one lock output and script. Off with TAKE_PRESIG_ENABLED=false (reads stay).
import { verifyPresig } from '../../dapp/take-presig.js';

const MAX_BODY = 4096, MAX_PER_LOCK = 4, LIST_CAP = 500, HOURLY = 20, MAX_TTL = 9 * 86400;
export const takePresigEnabled = (env) => String(env?.TAKE_PRESIG_ENABLED ?? 'true') !== 'false';
// A key is the lock output AND the output script its terms make (the Taproot key the pre-signature is for), so a pre-signature made up by someone else for an output
// that is not theirs fills a slot of its own and never the real user's.
const lockPrefix = (network, txid, vout, spk) => `takepresig:${network}:${txid}:${vout}:${spk}:`;

// deps: { jsonResponse(body, status, cors), ipBucket(env, ip), now? }
export function makeTakePresigs({ jsonResponse, ipBucket, now = () => Math.floor(Date.now() / 1000) }) {
  async function post(req, env, network, cors) {
    if (!takePresigEnabled(env)) return jsonResponse({ error: 'pre-signed takes are not currently accepted' }, 410, cors);
    const text = await req.text();
    if (text.length > MAX_BODY) return jsonResponse({ error: 'the body is too large' }, 413, cors);
    let body;
    try { body = JSON.parse(text); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
    const p = body && body.presig, t = now();
    // (the shape and the key's own signature first, before anything is counted or stored: garbage costs one verification and nothing else)
    const v = verifyPresig(p, { nowSecs: t });
    if (!v.ok) return jsonResponse({ error: v.reasons[0] || 'the pre-signature does not verify' }, 400, cors);
    const ip = req.headers.get('CF-Connecting-IP') || 'anon';
    const rl = `takepresig:rl:${new Date().toISOString().slice(0, 13)}:${ipBucket(env, ip)}`;
    const used = Number(await env.UPLOAD_KV.get(rl)) || 0;
    if (used >= HOURLY) return jsonResponse({ error: 'too many pre-signatures from this client this hour' }, 429, { ...cors, 'Retry-After': '3600' });
    const prefix = lockPrefix(network, p.lock.txid, p.lock.vout, v.spk.slice(4)), key = prefix + p.R;
    if (await env.REGISTRY_KV.get(key)) return jsonResponse({ ok: true, known: true }, 200, cors);   // (the same one again: kept, and said so)
    const have = await env.REGISTRY_KV.list({ prefix });
    if ((have.keys || []).length >= MAX_PER_LOCK) return jsonResponse({ error: 'this lock output already has its pre-signatures' }, 409, cors);
    await env.UPLOAD_KV.put(rl, String(used + 1), { expirationTtl: 3700 });
    const rec = { presig: p, at: t };
    await env.REGISTRY_KV.put(key, JSON.stringify(rec), { expirationTtl: Math.min(MAX_TTL, Math.max(60, p.expiresAt - t + 86400)) });
    return jsonResponse({ ok: true }, 200, cors);
  }

  async function list(url, env, network, cors) {
    const lock = String(url.searchParams.get('lock') ?? '').toLowerCase();
    let prefix = `takepresig:${network}:`;
    if (lock) {
      const m = lock.match(/^([0-9a-f]{64}):(\d{1,6})$/);
      if (!m) return jsonResponse({ error: 'lock must be txid:vout' }, 400, cors);
      prefix = `takepresig:${network}:${m[1]}:${Number(m[2])}:`;
    }
    const t = now(), out = [];
    let cursor;
    for (let i = 0; i < 10 && out.length < LIST_CAP; i++) {
      const page = await env.REGISTRY_KV.list({ prefix, cursor });
      for (const k of page.keys || []) {
        if (!/^takepresig:[a-z0-9]+:[0-9a-f]{64}:\d+:[0-9a-f]{64}:[0-9a-f]{64}$/.test(k.name)) continue;   // (not the rate-limit counters)
        const v = await env.REGISTRY_KV.get(k.name, 'json');
        if (v && v.presig && Number(v.presig.expiresAt) > t) out.push(v);
        if (out.length >= LIST_CAP) break;
      }
      if (page.list_complete !== false || !page.cursor) break;
      cursor = page.cursor;
    }
    out.sort((a, b) => (a.at || 0) - (b.at || 0));
    return jsonResponse({ count: out.length, presigs: out.map((r) => r.presig) }, 200, { ...cors, 'Cache-Control': 'no-store' });
  }
  return { post, list };
}
