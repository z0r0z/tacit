// The pool's history as files on IPFS, so a first visit reads a few files instead of every log since launch, and still starts when Tacit's own
// servers are down. A snapshot is the raw logs the page's event read asks for (every pool event and the farm manager's, confidential-pool-ux.js
// fetchEvents) up to a settled block, cut into pieces of at most one raw IPFS block (256 KiB) and listed by a manifest. Each piece and the manifest
// are raw blocks, so a CID is the sha256 of the bytes it names: a gateway that hands back anything else is caught at once, whoever runs it.
//
// The latest manifest is named on Ethereum: the text record `tacit.snapshot` of snapshot.tacit.wei ({"v":1,"cid":"b…","to":<block>}), read from any
// public node. Nothing in it is taken on trust for the trees: the page rebuilds the note, lock and position trees from the logs it ends up with and
// compares their roots and counts with the pool's own storage at the block it read to; a mismatch drops the snapshot and the page reads from launch.
// The rest (nullifiers, deposits, farm events) has no root on chain, so the page reads the snapshot's range again from the public nodes in the
// background afterwards and keeps what they say.
//
// tacit-api builds and pins it (worker/src/pool-snapshot-job.js); the header relay points the record at it after checking its roots on chain
// (worker-relay/src/lib/snapshot-pointer.js).

export const SNAPSHOT = Object.freeze({
  version: 1,
  wns: '0x0000000000696760E15f265e828DB644A0c242EB',
  tokenId: '0x2fa0a159ce69678f7da5ab7bccc8cbcaea5c65edd657bc39cccbd79432cba8b2', // snapshot.tacit.wei
  textKey: 'tacit.snapshot',
  maxPiece: 256 * 1024,
  cutChars: 600_000, // a piece ends at the first block boundary past this many characters of rows; split again if it still packs over maxPiece
  gateways: Object.freeze([
    'https://ipfs.filebase.io/ipfs/',
    'https://trustless-gateway.link/ipfs/', // raw blocks only (?format=raw), which is all a snapshot is
    'https://ipfs.orbitor.dev/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
  ]),
});

// Storage slots of the three trees (ConfidentialPool, `forge inspect … storageLayout`): [count, root].
export const TREE_SLOTS = Object.freeze({ note: [3, 4], lock: [84, 85], cdp: [128, 129] });

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const RAW_SHA256 = [0x01, 0x55, 0x12, 0x20]; // CIDv1, raw codec, sha2-256, 32 bytes

function base32(bytes) {
  let out = '', bits = 0, acc = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  const out = [];
  let bits = 0, acc = 0;
  for (const c of s) { const v = B32.indexOf(c); if (v < 0) return null; acc = (acc << 5) | v; bits += 5; if (bits >= 8) { out.push((acc >>> (bits - 8)) & 255); bits -= 8; } }
  return Uint8Array.from(out);
}
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const lc = (s) => String(s ?? '').toLowerCase();
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

// The CID of bytes stored as one raw block.
export function rawCid(bytes, sha256) { return 'b' + base32(Uint8Array.from([...RAW_SHA256, ...sha256(bytes)])); }
// The sha256 a raw-block CID names, or null for any other CID.
export function cidSha(cid) {
  const s = String(cid || '');
  if (!/^b[a-z2-7]{58}$/.test(s)) return null;
  const b = unbase32(s.slice(1));
  return b && b.length === 36 && RAW_SHA256.every((x, i) => b[i] === x) ? b.slice(4) : null;
}

export async function gzip(text) {
  const s = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function gunzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new TextDecoder().decode(await new Response(s).arrayBuffer());
}

const blockOf = (l) => Number(BigInt(l.blockNumber));
const indexOf = (l) => Number(BigInt(l.logIndex));
export const byChainOrder = (a, b) => blockOf(a) - blockOf(b) || indexOf(a) - indexOf(b);

// A piece's text: the logs as rows [block, logIndex, tx, address index, topics, data], the addresses once. Only what the page reads of a log is kept.
export function packPiece(logs, addresses) {
  const at = new Map(addresses.map((a, i) => [lc(a), i]));
  const rows = logs.map((l) => {
    const i = at.get(lc(l.address));
    if (i === undefined) throw new Error(`pool-snapshot: a log of ${l.address}, not one of the snapshot's addresses`);
    return [blockOf(l), indexOf(l), lc(l.transactionHash), i, (l.topics || []).map(lc), lc(l.data || '0x')];
  });
  return JSON.stringify({ v: SNAPSHOT.version, addresses: addresses.map(lc), logs: rows });
}
export function unpackPiece(text) {
  const p = JSON.parse(text);
  if (!p || p.v !== SNAPSHOT.version || !Array.isArray(p.addresses) || !Array.isArray(p.logs)) throw new Error('pool-snapshot: not a snapshot piece');
  return p.logs.map(([block, logIndex, tx, i, topics, data]) => {
    if (!Number.isSafeInteger(block) || !Number.isSafeInteger(logIndex) || !p.addresses[i] || !Array.isArray(topics)) throw new Error('pool-snapshot: a malformed row');
    return { address: p.addresses[i], topics, data, blockNumber: '0x' + block.toString(16), logIndex: '0x' + logIndex.toString(16), transactionHash: tx };
  });
}

// Logs in chain order → the logs of each piece. Each piece ends at the first block boundary after `cutChars` characters of rows, so cutting the
// same logs again gives the same pieces, and a snapshot that grows changes only its last piece.
export function cutPieces(logs, cutChars = SNAPSHOT.cutChars) {
  const out = [];
  let cur = [], chars = 0;
  for (let i = 0; i < logs.length; i++) {
    cur.push(logs[i]);
    chars += (logs[i].data || '').length + 64 * ((logs[i].topics || []).length + 1);
    const next = logs[i + 1];
    if (chars >= cutChars && (!next || blockOf(next) !== blockOf(logs[i]))) { out.push(cur); cur = []; chars = 0; }
  }
  if (cur.length) out.push(cur);
  return out;
}

// One piece's logs → [{ cid, bytes, n, from, to }], split at a block boundary near the middle while it packs over maxPiece.
export async function encodePiece(logs, addresses, sha256, maxPiece = SNAPSHOT.maxPiece) {
  const bytes = await gzip(packPiece(logs, addresses));
  if (bytes.length <= maxPiece) return [{ cid: rawCid(bytes, sha256), bytes, n: logs.length, from: blockOf(logs[0]), to: blockOf(logs[logs.length - 1]) }];
  let mid = logs.length >> 1;
  while (mid < logs.length && blockOf(logs[mid]) === blockOf(logs[mid - 1])) mid++;
  if (mid >= logs.length) { mid = logs.length >> 1; while (mid > 0 && blockOf(logs[mid]) === blockOf(logs[mid - 1])) mid--; }
  if (mid <= 0) throw new Error('pool-snapshot: one block\'s logs pack over a piece');
  return [...await encodePiece(logs.slice(0, mid), addresses, sha256, maxPiece), ...await encodePiece(logs.slice(mid), addresses, sha256, maxPiece)];
}

// The three trees the logs build: { note, lock, cdp: { count, root } }. Leaves must arrive at the positions their logs name, or this throws.
export function treesOf(logs, { decodeLogs, Tree, pool }) {
  const t = { note: new Tree(), lock: new Tree(), cdp: new Tree() };
  for (const ev of decodeLogs(logs.filter((l) => lc(l.address) === lc(pool)))) {
    if (!ev) continue;
    if (ev.type === 'LeavesInserted') {
      if (ev.firstLeafIndex !== t.note.leaves.length) throw new Error(`pool-snapshot: note leaves at ${ev.firstLeafIndex}, ${t.note.leaves.length} expected`);
      for (const l of ev.leaves) t.note.insert(l);
    } else if (ev.type === 'LockLeavesInserted') {
      if (ev.firstLockIndex !== t.lock.leaves.length) throw new Error(`pool-snapshot: lock leaves at ${ev.firstLockIndex}, ${t.lock.leaves.length} expected`);
      for (const l of ev.lockLeaves) t.lock.insert(l);
    } else if (ev.type === 'CdpPositionInserted') t.cdp.insert(ev.leaf);
  }
  return Object.fromEntries(Object.entries(t).map(([k, tree]) => [k, { count: tree.leaves.length, root: tree.root() }]));
}
// The trees as the pool keeps them, so a builder adds a day's leaves without the history: { note, lock, cdp: { count, root, filled[32] } },
// each leaf inserted as ConfidentialPool._insertTreeLeaf does (keccak, zeros[i] = keccak(zeros[i-1] ‖ zeros[i-1]), depth 32).
export function emptyFrontiers(keccak256) {
  const zeros = [new Uint8Array(32)];
  for (let i = 1; i <= 32; i++) zeros.push(keccak256(Uint8Array.from([...zeros[i - 1], ...zeros[i - 1]])));
  const one = () => ({ count: 0, root: '0x' + hex(zeros[32]), filled: zeros.slice(0, 32).map((z) => '0x' + hex(z)) });
  return { note: one(), lock: one(), cdp: one() };
}
export function addToFrontiers(fr, logs, { decodeLogs, keccak256, pool }) {
  const zeros = emptyFrontiers(keccak256).note.filled.map((z) => b32(z));
  const out = JSON.parse(JSON.stringify(fr));
  const insert = (t, leaf) => {
    let h = b32(leaf), idx = t.count;
    for (let i = 0; i < 32; i++) {
      if ((idx & 1) === 0) { t.filled[i] = '0x' + hex(h); h = keccak256(Uint8Array.from([...h, ...zeros[i]])); }
      else h = keccak256(Uint8Array.from([...b32(t.filled[i]), ...h]));
      idx = Math.floor(idx / 2);
    }
    t.count++;
    t.root = '0x' + hex(h);
  };
  for (const ev of decodeLogs(logs.filter((l) => lc(l.address) === lc(pool)))) {
    if (!ev) continue;
    if (ev.type === 'LeavesInserted') {
      if (ev.firstLeafIndex !== out.note.count) throw new Error(`pool-snapshot: note leaves at ${ev.firstLeafIndex}, ${out.note.count} expected`);
      for (const l of ev.leaves) insert(out.note, l);
    } else if (ev.type === 'LockLeavesInserted') {
      if (ev.firstLockIndex !== out.lock.count) throw new Error(`pool-snapshot: lock leaves at ${ev.firstLockIndex}, ${out.lock.count} expected`);
      for (const l of ev.lockLeaves) insert(out.lock, l);
    } else if (ev.type === 'CdpPositionInserted') insert(out.cdp, ev.leaf);
  }
  return out;
}
const b32 = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
export const treesOfFrontiers = (fr) => Object.fromEntries(Object.entries(fr).map(([k, t]) => [k, { count: t.count, root: t.root }]));

// The same, as the pool's storage holds it. getStorageAt(slotHex) → a 32-byte word.
export async function poolTrees(getStorageAt) {
  const out = {};
  for (const [k, [count, root]] of Object.entries(TREE_SLOTS)) {
    const [c, r] = await Promise.all([getStorageAt('0x' + word(count)), getStorageAt('0x' + word(root))]);
    out[k] = { count: Number(BigInt(c)), root: '0x' + word(BigInt(r)) };
  }
  return out;
}
export const sameTrees = (a, b) => Object.keys(TREE_SLOTS).every((k) => a?.[k] && b?.[k] && a[k].count === b[k].count && lc(a[k].root) === lc(b[k].root));

// The record: the eth_call of WNS text(tokenId, key), and its answer → { cid, to } or null.
export function pointerCall(keccak256) {
  const sel = hex(keccak256(new TextEncoder().encode('text(uint256,string)'))).slice(0, 8);
  const key = new TextEncoder().encode(SNAPSHOT.textKey);
  return { to: SNAPSHOT.wns, data: '0x' + sel + word(SNAPSHOT.tokenId) + word(64) + word(key.length) + hex(key).padEnd(Math.ceil(key.length / 32) * 64, '0') };
}
export function readPointer(result) {
  const h = String(result || '').replace(/^0x/, '');
  if (h.length < 128) return null;
  const len = Number(BigInt('0x' + h.slice(64, 128)));
  if (!len || len > 1024) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(h.slice(128, 128 + len * 2).match(/../g).map((x) => parseInt(x, 16)))));
    return p && p.v === SNAPSHOT.version && cidSha(p.cid) && Number.isSafeInteger(p.to) ? { cid: p.cid, to: p.to } : null;
  } catch { return null; }
}

// The bytes a raw-block CID names, from the first gateway whose answer hashes to it.
export async function fetchBlock(cid, { fetchImpl, sha256, gateways = SNAPSHOT.gateways, timeoutMs = 20000 }) {
  const want = cidSha(cid);
  if (!want) throw new Error(`pool-snapshot: ${cid} is not a raw-block CID`);
  let last = null;
  for (const g of gateways) {
    try {
      const raw = /trustless-gateway/.test(g);
      const r = await fetchImpl(g + cid + (raw ? '?format=raw' : ''), { headers: raw ? { accept: 'application/vnd.ipld.raw' } : {}, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) { last = new Error(`${new URL(g).host}: HTTP ${r.status}`); continue; }
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length <= SNAPSHOT.maxPiece && hex(sha256(bytes)) === hex(want)) return bytes;
      last = new Error(`${new URL(g).host}: bytes that are not ${cid}`);
    } catch (e) { last = e; }
  }
  throw last || new Error('pool-snapshot: no gateway');
}

// The manifest and every log it lists, each piece checked against its CID. `expect`: { chainId, pool, addresses, topics } the page's read needs.
export async function loadSnapshot(cid, { fetchImpl, sha256, gateways, expect }) {
  const m = JSON.parse(new TextDecoder().decode(await fetchBlock(cid, { fetchImpl, sha256, gateways })));
  if (!m || m.v !== SNAPSHOT.version || Number(m.chainId) !== Number(expect.chainId) || lc(m.pool) !== lc(expect.pool)) throw new Error('pool-snapshot: a manifest for another pool');
  const has = new Set((m.addresses || []).map(lc)), topics = new Set((m.topics || []).map(lc));
  if (!expect.addresses.every((a) => has.has(lc(a))) || !expect.topics.every((t) => topics.has(lc(t)))) throw new Error('pool-snapshot: a manifest that leaves out logs the page reads');
  if (!Number.isSafeInteger(m.to) || !Array.isArray(m.pieces)) throw new Error('pool-snapshot: a malformed manifest');
  const pieces = new Array(m.pieces.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, m.pieces.length) }, async () => {
    while (next < m.pieces.length) { const i = next++; pieces[i] = unpackPiece(await gunzip(await fetchBlock(m.pieces[i].cid, { fetchImpl, sha256, gateways }))); }
  }));
  const logs = pieces.flat();
  for (let i = 1; i < logs.length; i++) if (byChainOrder(logs[i - 1], logs[i]) >= 0) throw new Error('pool-snapshot: logs out of chain order');
  if (logs.length && blockOf(logs[logs.length - 1]) > m.to) throw new Error('pool-snapshot: a log past the manifest\'s block');
  return { manifest: m, logs };
}

// The logs of `logs` an eth_getLogs with `params` ({ address, topics }) would return.
export function selectLogs(logs, params) {
  const addrs = params.address == null ? null : new Set([].concat(params.address).map(lc));
  const topics = params.topics || [];
  return logs.filter((l) => (!addrs || addrs.has(lc(l.address))) && topics.every((want, i) => want == null || [].concat(want).map(lc).includes(lc((l.topics || [])[i]))));
}
// Whether a snapshot can stand in for that read: the snapshot's addresses and topics cover it, and nothing narrower than a topic0 set is asked.
export const snapshotCovers = (params, { addresses, topics }) =>
  params.address != null && [].concat(params.address).every((a) => addresses.map(lc).includes(lc(a))) &&
  (params.topics || []).length === 1 && [].concat(params.topics[0]).every((t) => t != null && topics.map(lc).includes(lc(t)));
