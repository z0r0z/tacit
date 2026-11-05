// Points snapshot.tacit.wei at the newest pool snapshot tacit-api pinned (dapp/pool-snapshot.js, worker/src/pool-snapshot-job.js), from the
// relay wallet that holds the subname: once the record is a day behind (or empty), and only while gas is cheap. Before it signs it reads the
// manifest itself (a raw IPFS block, so its CID is the sha256 of its bytes) and checks that each of its three tree roots is a root the pool has
// had (everKnownRoot, everKnownLockRoot, everKnownCdpRoot) and each count no more than the pool's now, so a manifest the API got wrong is never
// named. A page checks every snapshot again, against the pool's storage at the block it reads to; this keeps the record from naming junk.
import { createHash } from 'node:crypto';

export const POINTER = Object.freeze({
  wns: '0x0000000000696760E15f265e828DB644A0c242EB',
  tokenId: 0x2fa0a159ce69678f7da5ab7bccc8cbcaea5c65edd657bc39cccbd79432cba8b2n, // snapshot.tacit.wei
  key: 'tacit.snapshot',
  everyBlocks: 7000,        // about a day: the record moves at most this often
  maxGasGwei: 3,            // SNAPSHOT_POINTER_MAX_GWEI
  gateway: 'https://ipfs.filebase.io/ipfs/',
  // ConfidentialPool storage: [count slot, everKnown*Root mapping slot] per tree (`forge inspect … storageLayout`)
  slots: Object.freeze({ note: [3, 69], lock: [84, 118], cdp: [128, 162] }),
});
export const WNS_ABI = [
  { type: 'function', name: 'text', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'string' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'setText', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'string' }, { type: 'string' }], outputs: [] },
];

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
// The sha256 a raw-block CID names (hex), or null for any other CID.
export function cidSha(cid) {
  const s = String(cid || '');
  if (!/^b[a-z2-7]{58}$/.test(s)) return null;
  const out = [];
  let bits = 0, acc = 0;
  for (const c of s.slice(1)) { acc = (acc << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((acc >>> (bits - 8)) & 255); bits -= 8; } }
  return out.length === 36 && out[0] === 1 && out[1] === 0x55 && out[2] === 0x12 && out[3] === 0x20 ? Buffer.from(out.slice(4)).toString('hex') : null;
}
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const keccakSlot = (keccak256, key, slot) => '0x' + Buffer.from(keccak256(Buffer.from(word(BigInt(key)) + word(slot), 'hex'))).toString('hex');

// What the record says now → { cid, to } or null.
export function parseRecord(text) {
  try { const p = JSON.parse(text); return p && p.v === 1 && cidSha(p.cid) && Number.isSafeInteger(p.to) ? p : null; } catch { return null; }
}

// Whether the manifest's trees are the pool's: each root one the pool has had, each count no more than its count now.
export async function treesKnown(trees, { getStorageAt, keccak256, slots = POINTER.slots }) {
  for (const [k, [countSlot, knownSlot]] of Object.entries(slots)) {
    const t = trees && trees[k];
    if (!t || !Number.isSafeInteger(t.count) || !/^0x[0-9a-f]{64}$/i.test(String(t.root))) return false;
    const [count, known] = await Promise.all([getStorageAt('0x' + word(countSlot)), getStorageAt(keccakSlot(keccak256, t.root, knownSlot))]);
    if (t.count > Number(BigInt(count))) return false;
    if (t.count > 0 && BigInt(known) === 0n) return false;
  }
  return true;
}

// One check → { status: 'current' | 'none' | 'dear' | 'refused' | 'set', ... }. deps: { apiBase, fetchImpl, readText, getStorageAt, keccak256,
// gasGwei, setText(value) → tx hash, everyBlocks, maxGasGwei, log }.
export async function pointSnapshot({ apiBase, fetchImpl = fetch, readText, getStorageAt, keccak256, gasGwei, setText, everyBlocks = POINTER.everyBlocks, maxGasGwei = POINTER.maxGasGwei, gateway = POINTER.gateway }) {
  const r = await fetchImpl(`${apiBase}/pool/snapshot`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) return { status: 'none' };
  const pub = await r.json();
  if (!cidSha(pub.cid) || !Number.isSafeInteger(pub.to)) return { status: 'none' };
  const now = parseRecord(await readText());
  if (now && (now.cid === pub.cid || pub.to - now.to < everyBlocks)) return { status: 'current', record: now };
  const gwei = await gasGwei();
  if (gwei == null || gwei > maxGasGwei) return { status: 'dear', gwei };
  const m = await fetchImpl(gateway + pub.cid, { signal: AbortSignal.timeout(20000) });
  if (!m.ok) return { status: 'refused', why: `the manifest did not load (HTTP ${m.status})` };
  const bytes = Buffer.from(await m.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== cidSha(pub.cid)) return { status: 'refused', why: 'the gateway sent bytes that are not the manifest' };
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.to !== pub.to) return { status: 'refused', why: 'the manifest is for another block' };
  if (!(await treesKnown(manifest.trees, { getStorageAt, keccak256 }))) return { status: 'refused', why: 'its trees are not the pool\'s' };
  const value = JSON.stringify({ v: 1, cid: pub.cid, to: pub.to });
  return { status: 'set', value, txHash: await setText(value) };
}
