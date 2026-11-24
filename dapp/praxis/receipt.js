// The Tacit Praxis ceremony's receipts: the bytes the coordinator signs, the check of a signature, how the receipts link into one chain,
// and the share link a contributor posts. No DOM here, so a test can import it as it is.

export const COORDINATOR = 'http://143.55.45.86:53874';
export const COORDINATOR_KEY = 'c22b59ae8acf7a1c2b78c4da8cfd2a3e7a21f2d2809a4d35e3a71e0fd2052eb7';
export const BASE_INDEX = 17;   // Succinct's last file of the SP1 v6.1.0 setup, phase2-17
export const BASE_SHA256 = 'bf6f7799c77a90009ae356fd0d3a69a91cf153825e6762ce344fe804cf5db2df';
export const SUCCINCT_CONTRIBUTORS = 18;
export const PAGE_URL = 'https://tacit.finance/praxis/';

const HEX64 = /^[0-9a-f]{64}$/;

export function hexBytes(h) {
  if (typeof h !== 'string' || h.length % 2 || /[^0-9a-f]/i.test(h)) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// What the coordinator signs: the receipt as Go's encoding/json writes it, without the signature. The fields go in the struct's order,
// and Go writes <, > and & (and U+2028, U+2029) as \u escapes where JSON.stringify leaves them as they are.
export function signedBytes(r) {
  const json = JSON.stringify({ index: r.index, name: r.name, handle: r.handle, contribution_hash: r.contribution_hash, file_sha256: r.file_sha256, prev_file_sha256: r.prev_file_sha256, at: r.at });
  return new TextEncoder().encode(json.replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
}

// true or false; null where the browser has no Ed25519 in WebCrypto, so the page says the check was not made rather than that it failed
export async function verifyReceipt(r, keyHex = COORDINATOR_KEY, subtle = globalThis.crypto?.subtle) {
  const pub = hexBytes(keyHex), sig = hexBytes(r?.signature);
  if (!subtle || !pub || pub.length !== 32) return null;
  let key;
  try { key = await subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']); } catch { return null; }
  if (!sig || sig.length !== 64) return false;
  try { return await subtle.verify({ name: 'Ed25519' }, key, sig, signedBytes(r)); } catch { return false; }
}

// Each receipt continues the file before it: the first from the base file, each next from the last one's file, and the last is the head.
// Returns the index of the first receipt that does not link (or -1 when all do, and the head is the last file).
export function brokenLink(t) {
  let prevSha = t.base_sha256, prevIdx = t.base_index;
  const rs = t.receipts || [];
  for (let i = 0; i < rs.length; i++) {
    if (rs[i].prev_file_sha256 !== prevSha || rs[i].index !== prevIdx + 1) return i;
    prevSha = rs[i].file_sha256; prevIdx = rs[i].index;
  }
  return prevSha === t.head_sha256 && prevIdx === t.head_index ? -1 : rs.length;
}

export const short = (h) => (typeof h === 'string' && h.length > 20 ? `${h.slice(0, 8)}…${h.slice(-8)}` : String(h ?? ''));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function when(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return String(at ?? '');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// a hash as someone pastes it: spaces, quotes, 0x and capitals dropped; null unless 32 bytes of hex are left
export function normalHash(s) {
  const h = String(s ?? '').trim().replace(/^["']|["',]$/g, '').trim().replace(/^0x/i, '').toLowerCase();
  return HEX64.test(h) ? h : null;
}

export function shareUrl(hash) {
  const text = `I contributed to the Tacit Praxis ceremony.\n\nMy contribution hash:\n${hash}\n\nCheck it, or add yours:`;
  return `https://twitter.com/intent/tweet?${new URLSearchParams({ text, url: PAGE_URL })}`;
}
