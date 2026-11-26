// The prober service: registered endpoints, a probe schedule, signed records, the signed list and status, and the allowlisted relay.
//
//   GET  /nodes/list        the signed list the pages read (community nodes out of shadow, with weights and independence groups)
//   GET  /nodes/status      the signed status: every endpoint and operator with its figures (the /nodes/ page)
//   GET  /nodes/records?id= the last signed probe records of one endpoint
//   POST /nodes/ad          an operator's signed ad (dapp/nodes-list.js signAd); answered after the node is asked once
//   POST /nodes/relay       {node, method, params} or {node, path}: a public-data read through a listed node (nodes-list.js ethPublic/btcPublic)
//   GET  /nodes/credits?day=N   the points feed, empty and disabled unless POINTS_ENABLED=1
//   GET  /healthz
//
// The relay is how a page reaches a community host without its connect-src naming one: the page calls the site's API origin, which forwards here.
// The operator then sees this service's address, not the visitor's; this service sees the (public-data) question. No request is logged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { signDoc, checkAd, ethPublic, btcPublic, endpointUrl, NodesError, LIMITS, ROLES, KIND_OF, fronted, slash24 } from '../../dapp/nodes-list.js';
import { secp, bytesToHex, hexToBytes } from '../../dapp/vendor/tacit-deps.min.js';
import { makeProber } from './probes.mjs';
import { addRecord, board, listFrom, standing, dayOf, DAY } from './score.mjs';
import { credits } from './credits.mjs';
import { BASELINE, REFS } from './baseline.mjs';

const idOf = (url) => crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
const BASELINE_OPERATOR = 'baseline';

export function makeService({ key, fetch, now = () => Math.floor(Date.now() / 1000), rnd = Math.random, statePath = null, asnOf = async () => null, baseline = BASELINE, refs = REFS, pointsEnabled = false, maxEndpoints = 120, intervalSecs = 20 * 60, relayFetch = null, vantage = 'prober-1' }) {
  const priv = hexToBytes(String(key).replace(/^0x/, ''));
  const signer = bytesToHex(secp.getPublicKey(priv, true));
  const prober = makeProber({ fetch, refs, rnd });
  let S = { endpoints: {}, ads: {} };
  try { if (statePath && fs.existsSync(statePath)) S = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { S = { endpoints: {}, ads: {} }; }
  const save = () => { if (!statePath) return; const t = statePath + '.tmp'; fs.writeFileSync(t, JSON.stringify(S)); fs.renameSync(t, statePath); };
  const eps = () => Object.values(S.endpoints);

  const seed = () => {
    const t = now();
    for (const b of baseline) {
      const id = idOf(b.url);
      S.endpoints[id] ||= { id, url: b.url, kind: b.kind, roles: b.roles, name: b.name, operator: BASELINE_OPERATOR + (b.own ? '-tacit' : '-public'), baseline: true, own: !!b.own, firstSeen: t - 30 * DAY, nextAt: t + Math.floor(rnd() * 120), agg: {}, strikes: [], recent: [] };
    }
  };
  seed();

  // an ad -> its endpoints, after the node answers once from the pages' origin; replaces the operator's earlier ad
  async function register(ad) {
    const t = now();
    checkAd(ad, t);
    const prev = S.ads[ad.operator];
    const mine = eps().filter((e) => e.operator === ad.operator && !e.baseline);
    if (!prev && eps().filter((e) => !e.baseline).length + ad.endpoints.length > maxEndpoints) throw new NodesError(503, 'the board is full');
    const urls = ad.endpoints.map((e) => endpointUrl(e.url));
    for (const other of eps()) if (other.operator !== ad.operator && urls.includes(other.url)) throw new NodesError(409, 'another operator already holds that endpoint');
    const added = [];
    for (const e of ad.endpoints) {
      const url = endpointUrl(e.url), id = idOf(url);
      if (!S.endpoints[id]) {
        const ok = await answers(url, e.kind);
        if (!ok.ok) throw new NodesError(400, `${url}: ${ok.why}`);
        added.push({ url, kind: e.kind, id, ip: ok.ip });
      }
    }
    for (const e of mine) if (!urls.includes(e.url)) delete S.endpoints[e.id];       // endpoints left out of the new ad are dropped
    for (const e of ad.endpoints) {
      const url = endpointUrl(e.url), id = idOf(url), a = added.find((x) => x.id === id);
      const cur = S.endpoints[id] ||= { id, url, kind: e.kind, firstSeen: t, nextAt: t + 30, agg: {}, strikes: [], recent: [] };
      Object.assign(cur, { roles: e.roles, operator: ad.operator, payTo: ad.payTo || null, name: ad.name || null, until: ad.until });
      if (a) { cur.ip = a.ip; cur.asn = await asnOf(a.ip); cur.fronted = fronted(a.ip); cur.net = slash24(a.ip); }
    }
    S.ads[ad.operator] = { until: ad.until, at: ad.at };
    save();
    return { ok: true, endpoints: ad.endpoints.map((e) => idOf(endpointUrl(e.url))) };
  }

  // the node must answer a plain read, with the page's origin allowed (CORS), before it is taken in
  async function answers(url, kind) {
    try {
      const o = { headers: { origin: 'https://tacit.finance', accept: 'application/json', ...(kind === 'eth' ? { 'content-type': 'text/plain' } : {}) } };
      const r = kind === 'eth'
        ? await fetch(url, { ...o, method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
        : await fetch(url + '/blocks/tip/height', { ...o, method: 'GET' });
      if (r.status !== 200) return { ok: false, why: `answered ${r.status}` };
      if (kind === 'eth' && JSON.parse(r.text).result !== '0x1') return { ok: false, why: 'not Ethereum mainnet' };
      if (kind === 'btc' && !/^\d{6,7}$/.test(r.text.trim())) return { ok: false, why: 'not an esplora tip' };
      const allow = String(r.headers?.['access-control-allow-origin'] ?? '*');
      if (allow !== '*' && allow !== 'https://tacit.finance') return { ok: false, why: 'does not allow the site\'s origin (CORS)' };
      return { ok: true, ip: r.ip || null };
    } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 80) }; }
  }

  const signRecord = (ep, r, t) => signDoc('record', { v: 1, node: ep.id, role: r.role, probe: r.probe, at: t, answered: r.answered, ok: r.ok, hard: r.hard, fresh: r.fresh ?? null, ms: r.ms ?? null, exp: r.exp ?? null, got: r.got ?? null, net: slash24(r.ip || ep.ip) || null, vantage, signer }, priv);

  async function probeOne(ep) {
    const t = now();
    const planned = prober.plan(ep);
    for (const p of planned) {
      let r; try { r = await p.run(); } catch (e) { r = { probe: p.name, role: ep.roles[0], answered: false, ok: null, hard: false, note: String(e.message).slice(0, 60) }; }
      const t2 = now();
      if (r.ip && !ep.baseline && (!ep.ip || ep.ip !== r.ip)) { ep.ip = r.ip; ep.asn = await asnOf(r.ip); ep.fronted = fronted(r.ip); }
      addRecord(ep, { ...r, at: t2 }, t2);
      (ep.recent ||= []).push(signRecord(ep, r, t2));
      if (ep.recent.length > 60) ep.recent.splice(0, ep.recent.length - 60);
    }
    // the next visit is at a random time, a third to five thirds of the interval from now
    ep.nextAt = t + Math.floor(intervalSecs * (0.33 + rnd() * 1.34) * (ep.baseline ? 1.5 : 1));
  }

  async function tick(concurrency = 4) {
    const t = now();
    // an ad that has run out takes its endpoints with it
    for (const [op, a] of Object.entries(S.ads)) if (a.until <= t) { for (const e of eps()) if (e.operator === op && !e.baseline) delete S.endpoints[e.id]; delete S.ads[op]; }
    const due = eps().filter((e) => (e.nextAt ?? 0) <= t);
    for (let i = 0; i < due.length; i += concurrency) await Promise.all(due.slice(i, i + concurrency).map((e) => probeOne(e)));
    if (due.length) { save(); cache = {}; }
    return due.length;
  }

  let cache = {};
  const cached = (k, ttl, make) => { const t = now(); if (cache[k] && cache[k].t > t - ttl) return cache[k].v; const v = make(t); cache[k] = { t, v }; return v; };
  const list = () => cached('list', 60, (t) => signDoc('list', { v: 1, at: t, until: t + LIMITS.listSecs - 60, signer, nodes: listFrom(eps(), t) }, priv));
  const status = () => cached('status', 60, (t) => {
    const b = board(eps(), t);
    return signDoc('status', { v: 1, at: t, day: dayOf(t), signer, points: pointsEnabled ? 'on' : 'off', nodes: b.nodes.map(({ ip, ...n }) => ({ ...n, net: slash24(ip) })), operators: b.operators.map((o) => ({ ...o, operator: o.baseline || o.own ? o.operator : o.operator.slice(0, 16) })) }, priv);
  });

  // the relay: only a listed community node, only a public-data read
  const buckets = new Map();
  const allow = (who, cost = 1, perMin = 120) => { const t = Date.now(), b = buckets.get(who) || { n: perMin, t }; b.n = Math.min(perMin, b.n + ((t - b.t) / 60000) * perMin); b.t = t; if (buckets.size > 5000) buckets.clear(); buckets.set(who, b); if (b.n < cost) return false; b.n -= cost; return true; };
  async function relay(body) {
    const node = list().nodes.find((n) => n.id === body?.node);
    if (!node) throw new NodesError(404, 'no such node');
    const send = relayFetch || fetch;
    if (node.kind === 'eth') {
      if (!ethPublic(body.method, body.params)) throw new NodesError(403, 'not a public-data read');
      const r = await send(node.url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: body.method, params: body.params }), timeoutMs: 10_000, maxBytes: 2 << 20 });
      return { status: r.status, text: r.text };
    }
    if (!btcPublic(body.path)) throw new NodesError(403, 'not a public-data read');
    const r = await send(node.url + body.path, { method: 'GET', headers: { accept: 'application/json, text/plain' }, timeoutMs: 10_000, maxBytes: 2 << 20 });
    return { status: r.status, text: r.text };
  }

  const handler = async (req, res) => {
    const origin = req.headers.origin || '';
    const okOrigin = /^https:\/\/(www\.)?tacit\.finance$/.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const send = (code, obj, extra = {}) => { const b = typeof obj === 'string' ? obj : JSON.stringify(obj); res.writeHead(code, { 'content-type': typeof obj === 'string' ? 'text/plain' : 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': okOrigin ? origin : '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin', 'x-content-type-options': 'nosniff', ...extra }); res.end(b); };
    try {
      const u = new URL(req.url, 'http://x');
      const who = req.headers['x-forwarded-for']?.split(',').pop().trim() || req.socket.remoteAddress || '?';
      if (req.method === 'OPTIONS') return send(204, '');
      if (u.pathname === '/healthz') return send(200, 'ok');
      if (req.method === 'GET' && u.pathname === '/nodes/list') return send(200, list());
      if (req.method === 'GET' && u.pathname === '/nodes/status') return send(200, status());
      if (req.method === 'GET' && u.pathname === '/nodes/records') { const ep = S.endpoints[u.searchParams.get('id')]; return ep ? send(200, { v: 1, node: ep.id, records: ep.recent || [] }) : send(404, { error: 'no such node' }); }
      if (req.method === 'GET' && u.pathname === '/nodes/credits') { const d = Number(u.searchParams.get('day')); return Number.isInteger(d) ? send(200, credits({ endpoints: eps(), day: d, now: now(), enabled: pointsEnabled })) : send(400, { error: 'day?' }); }
      if (req.method === 'POST' && (u.pathname === '/nodes/ad' || u.pathname === '/nodes/relay')) {
        let n = 0; const chunks = [];
        for await (const c of req) { n += c.length; if (n > 8192) return send(413, { error: 'too large' }); chunks.push(c); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'not JSON' }); }
        if (u.pathname === '/nodes/ad') { if (!allow('ad' + who, 1, 6)) return send(429, { error: 'slow down' }); return send(200, await register(body)); }
        if (!allow(who, 1, 240)) return send(429, { error: 'slow down' });
        return send(200, await relay(body));
      }
      return send(404, { error: 'not found' });
    } catch (e) { return send(e instanceof NodesError ? e.status : 502, { error: e instanceof NodesError ? e.message : 'the node did not answer' }); }
  };

  return { handler, tick, register, list, status, relay, probeOne, state: () => S, signer, endpoints: eps, standing: (ep) => standing(ep, now()), server: () => http.createServer(handler), save };
}
void ROLES; void KIND_OF;
