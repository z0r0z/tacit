// The open board on Nostr: proofs waiting for a sender, posted to public relays that anyone runs, so the board is not one API's. A proof
// on the board can be sent by any account and pays its fee legs to whoever sends it (ConfidentialPool.settle pays msg.sender), and the
// proof fixes everything else, so a post needs no author: each is signed with a key made for it alone. What a post carries is what the
// settle puts on chain when it lands. A reader trusts nothing in it: the event's id, signature and proof of work are checked here, and a
// sender runs the settle with eth_call before sending (dapp/prove/autorelay.js), so a false or spent proof costs only that call.
//
// Event: kind 30078 (NIP-78, application data, one per `d`), tags d = tacit-board-v1:<sha256 of the public values>, t = tacit-board-v1,
// expiration (NIP-40) and nonce (NIP-13, POW_BITS leading zero bits of the id). Content: JSON { v: 1, chainId, pool, type, publicValues,
// proof, memos, expiresAt (ms, 0 none) }.
import { secp, sha256, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';
import { signSchnorr, verifySchnorr } from './bulletproofs.js';

export const BOARD_KIND = 30078;
export const BOARD_TAG = 'tacit-board-v1';
export const POW_BITS = 12;
export const MAX_CONTENT = 100_000;
export const BOARD_TTL_SEC = 86_400;                         // a post with no deadline of its own leaves the relays after a day
// Public relays that take application data free of charge, each with room for a post (NIP-11 max_message_length ≥ 128 KiB).
export const NOSTR_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://offchain.pub'];
// The op types whose settle is a plain pool.settle (worker-relay/src/lib/open-board.js POSTED_TYPES).
const TYPES = new Set(['wrap', 'unwrap', 'transfer', 'swap', 'route', 'lp', 'otc', 'bid', 'bridgeburn', 'cdpmint', 'farmbond', 'farmharvest', 'farmunbond', 'cdpclose', 'cdpliquidate', 'cdptopup', 'stealthlock', 'stealthlockbatch', 'stealthclaim', 'stealthrefund', 'sendunwrap', 'lpbond', 'lpremove', 'wrapswap']);
const HEX = /^0x[0-9a-f]*$/i, HEX_BYTES = /^0x([0-9a-f]{2})+$/i;
const utf8 = (s) => new TextEncoder().encode(s);
const strip = (h) => String(h).replace(/^0x/i, '');

export const eventId = (e) => bytesToHex(sha256(utf8(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
// Leading zero bits of a hex id (NIP-13).
export function powBits(idHex) {
  let n = 0;
  for (const c of idHex) { const v = parseInt(c, 16); if (v === 0) { n += 4; continue; } return n + Math.clz32(v) - 28; }
  return n;
}
const proofKey = (publicValues) => bytesToHex(sha256(hexToBytes(strip(publicValues).toLowerCase())));

// The post for `job` ({ type, publicValues, proof, memos, expiresAt }), signed with a key made for it, its id mined to `bits`.
export function makePost(job, { pool, chainId = 1, nowSec = Math.floor(Date.now() / 1000), bits = POW_BITS, randomKey = () => crypto.getRandomValues(new Uint8Array(32)) } = {}) {
  if (!TYPES.has(job.type) || !HEX_BYTES.test(job.publicValues || '') || !HEX_BYTES.test(job.proof || '') || !Array.isArray(job.memos) || !job.memos.every((m) => HEX.test(m))) throw new Error('nostr-board: not a settle any account can send');
  const expiresAt = Number(job.expiresAt) || 0;
  const content = JSON.stringify({ v: 1, chainId, pool: String(pool).toLowerCase(), type: job.type, publicValues: job.publicValues.toLowerCase(), proof: job.proof.toLowerCase(), memos: job.memos.map((m) => m.toLowerCase()), expiresAt });
  if (content.length > MAX_CONTENT) throw new Error('nostr-board: too large for the relays');
  let priv;
  for (;;) { priv = randomKey(); try { const k = BigInt('0x' + bytesToHex(priv)); if (k > 0n && k < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n) break; } catch { } }
  const pubkey = xonly(priv);
  const exp = expiresAt ? Math.floor(expiresAt / 1000) : nowSec + BOARD_TTL_SEC;
  const ev = { pubkey, created_at: nowSec, kind: BOARD_KIND, tags: [['d', `${BOARD_TAG}:${proofKey(job.publicValues)}`], ['t', BOARD_TAG], ['expiration', String(exp)], ['nonce', '0', String(bits)]], content };
  for (let n = 0; ; n++) {
    ev.tags[3][1] = String(n);
    const id = eventId(ev);
    if (powBits(id) >= bits) { ev.id = id; break; }
  }
  ev.sig = bytesToHex(signSchnorr(hexToBytes(ev.id), priv));
  return ev;
}
// the BIP-340 public key: the x coordinate of priv·G
const xonly = (priv) => bytesToHex(secp.getPublicKey(priv, true).slice(1));

// A post read back as a board job ({ jobId, type, status: 'open', publicValues, proof, memos, expiresAt, openSince, posted, via }), or null
// for anything that is not a well-formed, signed, mined post of a proof for `pool` that is still open.
export function readPost(ev, { pool, chainId = 1, nowMs = Date.now(), minBits = POW_BITS } = {}) {
  try {
    if (!ev || ev.kind !== BOARD_KIND || typeof ev.content !== 'string' || ev.content.length > MAX_CONTENT || !Array.isArray(ev.tags)) return null;
    if (!/^[0-9a-f]{64}$/.test(ev.id) || !/^[0-9a-f]{64}$/.test(ev.pubkey) || !/^[0-9a-f]{128}$/.test(ev.sig)) return null;
    if (eventId(ev) !== ev.id || powBits(ev.id) < minBits) return null;
    if (!ev.tags.some((t) => t[0] === 't' && t[1] === BOARD_TAG)) return null;
    if (ev.created_at * 1000 > nowMs + 600e3) return null;
    const exp = Number(ev.tags.find((t) => t[0] === 'expiration')?.[1]) || 0;
    if (exp && exp * 1000 <= nowMs) return null;
    const c = JSON.parse(ev.content);
    if (c?.v !== 1 || c.chainId !== chainId || String(c.pool).toLowerCase() !== String(pool).toLowerCase() || !TYPES.has(c.type)) return null;
    if (!HEX_BYTES.test(c.publicValues || '') || !HEX_BYTES.test(c.proof || '') || !Array.isArray(c.memos) || !c.memos.every((m) => typeof m === 'string' && HEX.test(m))) return null;
    if (ev.tags.find((t) => t[0] === 'd')?.[1] !== `${BOARD_TAG}:${proofKey(c.publicValues)}`) return null;
    const expiresAt = Number(c.expiresAt) || 0;
    if (expiresAt && expiresAt <= nowMs) return null;
    if (!verifySchnorr(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey))) return null;
    return { jobId: `nostr:${ev.id}`, type: c.type, status: 'open', publicValues: c.publicValues, proof: c.proof, memos: c.memos, expiresAt, openSince: ev.created_at * 1000, posted: true, via: 'nostr' };
  } catch { return null; }
}

// `WS`: a WebSocket constructor (the browser's; a stand-in in tests). post(job) sends it to every relay and resolves with the relays that
// took it; read() asks every relay for the posts of the last day and resolves with the open jobs, one per proof, oldest post first.
export function makeNostrBoard({ pool, chainId = 1, relays = NOSTR_RELAYS, WS = globalThis.WebSocket, timeoutMs = 6000, now = () => Date.now(), minBits = POW_BITS, bits = POW_BITS } = {}) {
  const talk = (url, first, onMsg) => new Promise((resolve) => {
    let ws, done = false;
    const end = (v) => { if (done) return; done = true; clearTimeout(t); try { ws && ws.close(); } catch { } resolve(v); };
    const t = setTimeout(() => end(null), timeoutMs);
    try { ws = new WS(url); } catch { end(null); return; }
    ws.onopen = () => { try { ws.send(JSON.stringify(first)); } catch { end(null); } };
    ws.onerror = () => end(null);
    ws.onclose = () => end(null);
    ws.onmessage = (m) => { let x; try { x = JSON.parse(typeof m.data === 'string' ? m.data : ''); } catch { return; } const r = onMsg(x); if (r !== undefined) end(r); };
  });

  async function post(job) {
    const ev = makePost(job, { pool, chainId, nowSec: Math.floor(now() / 1000), bits });
    const took = await Promise.all(relays.map((u) => talk(u, ['EVENT', ev], (x) => (x[0] === 'OK' && x[1] === ev.id ? (x[2] ? u : null) : undefined))));
    return { id: ev.id, relays: took.filter(Boolean) };
  }

  async function read({ sinceSec = Math.floor(now() / 1000) - BOARD_TTL_SEC, limit = 200 } = {}) {
    const sub = 'tb' + Math.random().toString(36).slice(2, 10);
    const filter = { kinds: [BOARD_KIND], '#t': [BOARD_TAG], since: sinceSec, limit };
    const lists = await Promise.all(relays.map((u) => {
      const got = [];
      return talk(u, ['REQ', sub, filter], (x) => { if (x[0] === 'EVENT' && x[1] === sub) got.push(x[2]); else if (x[0] === 'EOSE' && x[1] === sub) return got; return undefined; })
        .then((r) => r || got);
    }));
    const by = new Map();
    for (const ev of lists.flat()) {
      const j = readPost(ev, { pool, chainId, nowMs: now(), minBits });
      if (!j) continue;
      const k = j.publicValues.toLowerCase(), had = by.get(k);
      if (!had || had.openSince > j.openSince) by.set(k, j);
    }
    return [...by.values()].sort((a, b) => a.openSince - b.openSince);
  }

  return { post, read, relays };
}

// Two boards as one: the API's jobs, then the Nostr posts of proofs it does not list. Either may be missing (null).
export function mergeBoards(api, nostr) {
  const seen = new Set((api || []).map((j) => String(j.publicValues || '').toLowerCase()));
  return [...(api || []), ...(nostr || []).filter((j) => !seen.has(String(j.publicValues).toLowerCase()))];
}
