// Community nodes: the signed documents (an operator's ad, a probe record, the list the pages read, the public status), the rules for reading them,
// and what a community node may be asked. The prober (node-prober/) makes and signs them; the pages only check them.
//
//   signDoc(kind, body, priv) / checkDoc(kind, doc, pubs, now)   Schnorr over a tagged hash of the sorted members; the signer is one of `pubs`
//   signAd(ad, priv) / checkAd(ad, now)                          an operator's ad: the endpoints it serves, signed with the operator's own key
//   verifyList(list, now, pubs)                                  the signed list -> its nodes, or [] (a list that does not check is no list)
//   ethPublic(method, params) / btcPublic(path)                  the public-data reads a community node is given; anything else is refused
//   independent(nodes)                                           nodes grouped so that one operator, one /24 or one ASN counts once
//
// PROBER_PUBS is the key the pages believe. It is empty until the prober's key is made and pinned here: with none pinned no list ever
// verifies, the pages keep their built-in lists and never ask the prober for anything.

import { sha256, concatBytes, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';
import { signSchnorr, verifySchnorr } from './bulletproofs.js';

export const PROBER_PUBS = Object.freeze([]);
// where the pages reach the signed list and the allowlisted relay: the site's API origin, which every page's connect-src already names
export const NODES_API = 'https://api.tacit.finance/nodes';

export const ROLES = Object.freeze(['eth-reads', 'eth-logs', 'eth-proofs', 'eth-archive', 'btc-esplora', 'btc-index']);
export const KIND_OF = Object.freeze({ 'eth-reads': 'eth', 'eth-logs': 'eth', 'eth-proofs': 'eth', 'eth-archive': 'eth', 'btc-esplora': 'btc', 'btc-index': 'btc' });
// points per day for one perfect endpoint of a role (the scarcity weights of the design); a score, not a payment
export const BASE = Object.freeze({ 'eth-reads': 10, 'eth-logs': 20, 'eth-proofs': 25, 'eth-archive': 40, 'btc-esplora': 15, 'btc-index': 30 });

export const LIMITS = { adSecs: 30 * 86400, skewSecs: 300, maxEndpoints: 6, maxAd: 4096, maxName: 40, listSecs: 1800, maxNodes: 200 };

const te = new TextEncoder();
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const isStr = (v) => typeof v === 'string';
const hex = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const canonical = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
const NAME_OK = /^[^<>\p{Cc}\p{Zl}\p{Zp}؜‎‏‪-‮⁦-⁩]*$/u;
export class NodesError extends Error { constructor(status, message) { super(message); this.status = status; } }

// ── signed documents ──
const TAGS = { ad: 'tacit-node-ad-v1', record: 'tacit-node-probe-v1', list: 'tacit-node-list-v1', status: 'tacit-node-status-v1' };
export const docDigest = (kind, doc) => { const { sig, ...body } = doc; return sha256(concatBytes(te.encode(TAGS[kind]), te.encode(canonical(body)))); };
const scalar32 = (priv) => (priv instanceof Uint8Array ? priv : hexToBytes(strip(priv)));
export const signDoc = (kind, body, priv) => ({ ...body, sig: bytesToHex(signSchnorr(docDigest(kind, body), scalar32(priv))) });
// the key (33-byte hex, x-only is what verifies) that signed `doc` is `by` for ads and `signer` for the prober's documents
export function sigOk(kind, doc, pub33) {
  try {
    if (!isStr(doc?.sig) || !hex(128).test(doc.sig) || !isStr(pub33) || !hex(66).test(strip(pub33))) return false;
    return verifySchnorr(hexToBytes(doc.sig), docDigest(kind, doc), hexToBytes(strip(pub33)).slice(1));
  } catch { return false; }
}
export const pinned = (pub, pubs = PROBER_PUBS) => isStr(pub) && pubs.map(strip).includes(strip(pub));
export function checkDoc(kind, doc, pubs = PROBER_PUBS) {
  return !!doc && typeof doc === 'object' && pinned(doc.signer, pubs) && sigOk(kind, doc, doc.signer);
}

// ── an operator's ad ──
// {v, operator: <33-byte key>, payTo?: 0x address, name?, endpoints: [{kind:'eth'|'btc', url, roles:[...]}], at, until, sig}
// The operator is its key, and signs; the prober lists no one whose ad does not check. The URL is https, a name and not an address, and
// answers for the pages' origin; the prober checks that by asking (node-prober/src/net.mjs), not by what the ad says.
export const AD_MEMBERS = ['v', 'operator', 'payTo', 'name', 'endpoints', 'at', 'until', 'sig'];
export const signAd = (ad, priv) => signDoc('ad', { v: 1, ...ad }, priv);

const IP_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$|:/;
export function endpointUrl(u) {
  let x; try { x = new URL(u); } catch { return null; }
  if (x.protocol !== 'https:' || x.username || x.password || x.hash || x.search.length > 200) return null;
  if (IP_LITERAL.test(x.hostname.replace(/^\[|\]$/g, '')) || !x.hostname.includes('.') || /\.(local|internal|localhost|onion)$/i.test(x.hostname)) return null;
  if (x.port && !/^(443|8443)$/.test(x.port)) return null;
  return x.origin + x.pathname.replace(/\/+$/, '');
}

export function checkAd(ad, now) {
  const bad = (m) => { throw new NodesError(400, m); };
  if (!ad || typeof ad !== 'object' || Array.isArray(ad) || ad.v !== 1) bad('not an ad');
  for (const k of Object.keys(ad)) if (!AD_MEMBERS.includes(k)) bad(`the ad has a member it does not take${/^\w{1,24}$/.test(k) ? `: ${k}` : ''}`);
  if (!isStr(ad.operator) || !hex(66).test(strip(ad.operator))) bad('the ad\'s operator is not a key');
  if (ad.payTo != null && (!isStr(ad.payTo) || !/^0x[0-9a-fA-F]{40}$/.test(ad.payTo))) bad('the ad\'s payTo is not an address');
  if (ad.name != null && (!isStr(ad.name) || ad.name.length > LIMITS.maxName || !NAME_OK.test(ad.name))) bad('the ad\'s name is not a name');
  if (!Array.isArray(ad.endpoints) || !ad.endpoints.length || ad.endpoints.length > LIMITS.maxEndpoints) bad('the ad names no endpoint, or too many');
  const seen = new Set();
  for (const e of ad.endpoints) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) bad('an endpoint is not an endpoint');
    for (const k of Object.keys(e)) if (!['kind', 'url', 'roles'].includes(k)) bad('an endpoint has a member it does not take');
    if (e.kind !== 'eth' && e.kind !== 'btc') bad('an endpoint is neither eth nor btc');
    const u = endpointUrl(e.url);
    if (!u) bad('an endpoint\'s url is not an https name');
    if (seen.has(u)) bad('an endpoint is named twice');
    seen.add(u);
    if (!Array.isArray(e.roles) || !e.roles.length || e.roles.length > ROLES.length || !e.roles.every((r) => ROLES.includes(r) && KIND_OF[r] === e.kind) || new Set(e.roles).size !== e.roles.length) bad('an endpoint\'s roles are not roles of its kind');
  }
  if (JSON.stringify(ad).length > LIMITS.maxAd) bad('the ad is too large');
  if (!Number.isInteger(ad.at) || !Number.isInteger(ad.until) || ad.until <= ad.at || ad.until - ad.at > LIMITS.adSecs) bad('the ad\'s time is not valid');
  if (ad.until <= now) bad('the ad has run out');
  if (ad.at > now + LIMITS.skewSecs) bad('the ad is from the future');
  if (!isStr(ad.sig) || !hex(128).test(ad.sig)) bad('the ad is not signed');
  if (!sigOk('ad', ad, ad.operator)) bad('the ad is not signed by its operator');
  return ad;
}

// ── the signed list ──
// {v, at, until, signer, nodes: [{id, url, kind, roles, operator, group, weight, reliability, lastOk}], sig}. `id` is what the relay is asked for;
// `group` names the independence class (operator, /24 and ASN collapsed), so a page can tell two voters of one operator from two operators.
export function verifyList(list, now, pubs = PROBER_PUBS) {
  try {
    if (!list || list.v !== 1 || !Array.isArray(list.nodes) || list.nodes.length > LIMITS.maxNodes) return [];
    if (!Number.isInteger(list.at) || !Number.isInteger(list.until) || list.until <= now || list.at > now + LIMITS.skewSecs || list.until - list.at > LIMITS.listSecs) return [];
    if (!checkDoc('list', list, pubs)) return [];
    return list.nodes.filter((n) => n && /^[0-9a-f]{16}$/.test(n.id) && (n.kind === 'eth' || n.kind === 'btc') && typeof n.group === 'string' && n.group.length <= 64
      && Array.isArray(n.roles) && n.roles.every((r) => ROLES.includes(r)) && Number.isFinite(n.weight) && n.weight > 0 && n.weight <= 1);
  } catch { return []; }
}
// distinct independence groups among nodes, best weight first
export function independent(nodes) {
  const by = new Map();
  for (const n of nodes) if (!by.has(n.group) || by.get(n.group).weight < n.weight) by.set(n.group, n);
  return [...by.values()].sort((a, b) => b.weight - a.weight);
}

// ── what a community node may be asked ──
// Public data only: heads and fees, blocks and transactions by hash, receipts, and the public pool's events. Nothing that names a user's address
// (balances, nonces, code, calls, an address's history or outputs), and nothing that sends. Pool logs only for the public contracts below, by the
// event signature alone, in a bounded span, so a filter cannot be made to carry an address.
export const PUBLIC_LOG_CONTRACTS = Object.freeze(['0x000000000ed1eabd231be41d93b719056f7febfc']);
const ETH_PLAIN = new Set(['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBlockByHash',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockReceipts', 'eth_getBlockTransactionCountByHash', 'eth_getBlockTransactionCountByNumber']);
const H32 = /^0x[0-9a-fA-F]{64}$/;
const BLOCKISH = /^(0x[0-9a-fA-F]{1,16}|latest|finalized|safe)$/;
const qty = (v) => (isStr(v) && /^0x[0-9a-fA-F]{1,16}$/.test(v) ? parseInt(v, 16) : null);
export function ethPublic(method, params = [], logContracts = PUBLIC_LOG_CONTRACTS) {
  if (!isStr(method) || !Array.isArray(params)) return false;
  const p = params;
  if (ETH_PLAIN.has(method)) {
    if (method === 'eth_getBlockByHash' || method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt' || method === 'eth_getBlockTransactionCountByHash') return p.length >= 1 && p.length <= 2 && H32.test(p[0]);
    if (method === 'eth_getBlockReceipts' || method === 'eth_getBlockTransactionCountByNumber') return p.length === 1 && BLOCKISH.test(String(p[0]));
    if (method === 'eth_feeHistory') return p.length >= 2 && p.length <= 3 && Number.isInteger(Number(p[0])) && Number(p[0]) <= 1024 && BLOCKISH.test(String(p[1]));
    return p.length === 0;
  }
  if (method === 'eth_getBlockByNumber') return p.length >= 1 && p.length <= 2 && BLOCKISH.test(String(p[0])) && (p[1] === undefined || typeof p[1] === 'boolean');
  if (method === 'eth_getLogs') {
    const f = p[0];
    if (p.length !== 1 || !f || typeof f !== 'object' || Array.isArray(f)) return false;
    for (const k of Object.keys(f)) if (!['fromBlock', 'toBlock', 'address', 'topics'].includes(k)) return false;
    const a = Array.isArray(f.address) ? f.address : [f.address];
    if (!a.length || !a.every((x) => isStr(x) && logContracts.includes(x.toLowerCase()))) return false;
    if (f.topics != null && !(Array.isArray(f.topics) && f.topics.length <= 1 && f.topics.every((t) => t === null || (isStr(t) && H32.test(t))))) return false;
    const from = qty(f.fromBlock), to = qty(f.toBlock);
    return from != null && to != null && to >= from && to - from < 10_000;
  }
  return false;
}
// the esplora reads that name no address: the tip, a block, a transaction by id and its status, the fee estimates
const BTC_OK = [/^\/blocks\/tip\/(height|hash)$/, /^\/block-height\/\d{1,8}$/, /^\/block\/[0-9a-f]{64}(\/(status|txids|header))?$/, /^\/tx\/[0-9a-f]{64}(\/(status|outspends|hex|merkle-proof))?$/, /^\/fee-estimates$/];
export const btcPublic = (path) => isStr(path) && path.length < 200 && BTC_OK.some((r) => r.test(path));

// ── Sybil grouping, shared by the prober (which scores) and the tests ──
const ip4 = (s) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s); return m && m.slice(1).every((x) => +x < 256) ? m.slice(1).map(Number) : null; };
export const slash24 = (ip) => { const a = ip4(ip); return a ? `${a[0]}.${a[1]}.${a[2]}` : ip ? String(ip).split(':').slice(0, 3).join(':') : null; };
const inCidr = (a, base, bits) => { const b = ip4(base); const n = (x) => ((x[0] << 24) | (x[1] << 16) | (x[2] << 8) | x[3]) >>> 0; const mask = bits ? (~0 << (32 - bits)) >>> 0 : 0; return (n(a) & mask) === (n(b) & mask); };
// the ranges of the big fronting services: a name that lands there is somebody's gateway, not a machine of the operator
const FRONTS = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
export const fronted = (ip) => { const a = ip4(ip); return !!a && FRONTS.some((c) => { const [b, bits] = c.split('/'); return inCidr(a, b, +bits); }); };
// one operator's endpoints: the ones that share a /24 or an ASN are one machine's worth; across the rest the best counts in full, the second a quarter, the rest a twentieth
export function diversity(endpoints) {
  const groups = new Map();
  for (const e of endpoints) {
    const k = e.asn ? `as${e.asn}` : `net${slash24(e.ip) || e.url}`;
    if (!groups.has(k) || groups.get(k).score < e.score) groups.set(k, e);
  }
  return [...groups.values()].sort((a, b) => b.score - a.score).map((e, i) => ({ ...e, share: i === 0 ? 1 : i === 1 ? 0.25 : 0.05 }));
}
