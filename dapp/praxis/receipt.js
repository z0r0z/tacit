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

export const RELEASE = 'https://github.com/src-company/tacit/releases/download/ceremony-v1.0.0';
export const MINUTES_PER_SLOT = 20;
const ADDR40 = /^0x[0-9a-fA-F]{40}$/;
export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
// a name as the coordinator takes it: printable ASCII, 1 to 64 characters (anything else is dropped)
export const cleanName = (s) => String(s ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64);

// The lines a contributor pastes: download the release binary for their computer and run it; the handle is their 0x address when
// they give a valid one (the ceremony's points go to it).
export function runCommand({ plat = 'darwin-arm64', addr = '', name = '', coordinator = COORDINATOR } = {}) {
  const file = `tacit-ceremony-${plat}`;
  const nm = cleanName(name) || '<your name>';
  const handle = ADDR40.test(String(addr).trim()) ? String(addr).trim() : '';
  if (plat.startsWith('windows')) {
    return [
      `Invoke-WebRequest -Uri ${RELEASE}/${file} -OutFile ${file}`,
      `.\\${file} contribute --coordinator ${coordinator} --name ${psQuote(nm)}${handle ? ` --handle ${handle}` : ''}`,
    ].join('\n');
  }
  return [
    `curl -fLO ${RELEASE}/${file}`,
    `chmod +x ${file}`,
    `./${file} contribute --coordinator ${coordinator} --name ${shQuote(nm)}${handle ? ` --handle ${handle}` : ''}`,
  ].join('\n');
}

export function waitText(queue) {
  const q = Number(queue);
  if (!Number.isFinite(q) || q < 0) return '';
  if (q === 0) return 'Nobody waiting: your turn comes at once';
  const mins = q * MINUTES_PER_SLOT;
  return `${q} in the queue · about ${mins < 90 ? `${mins} min` : `${Math.round(mins / 60)} h`} to your turn`;
}

export function platformGuess(ua = '', platform = '') {
  const s = `${ua} ${platform}`.toLowerCase();
  if (s.includes('win')) return 'windows-amd64.exe';
  if (s.includes('mac')) return 'darwin-arm64';
  if (s.includes('linux') && (s.includes('aarch64') || s.includes('arm'))) return 'linux-arm64';
  if (s.includes('linux')) return 'linux-amd64';
  return 'darwin-arm64';
}

// A contribution's credit is this many points (CEREMONY_POINTS on the ceremony's proxy); a point pays at most the campaign's cap in TAC.
export const POINTS_PER_CONTRIBUTION = 100n;
export const POINTS_VIEW = 'https://tacit-points.onrender.com/ceremony';
const WAD = 10n ** 18n;
const big = (v) => { try { return BigInt(v); } catch { return null; } };

// What the points service's /ceremony view means for a contributor: the most one contribution pays, the pot, what is left and how many
// contributions that still covers. null when the campaign is off or the view is not what it should be.
export function rewardView(v) {
  if (!v || v.enabled !== true || !v.pocket || !v.terms || v.terms.off) return null;
  const cap = big(v.terms.capWeiPerPoint), total = big(v.pocket.totalWei), left = big(v.pocket.remainingWei);
  if (cap === null || total === null || left === null || cap <= 0n || total <= 0n || left < 0n || left > total) return null;
  const each = cap * POINTS_PER_CONTRIBUTION;
  return { each, total, left, count: left / each, paidFrac: Number((total - left) * 10000n / total) / 10000 };
}

// whole TAC, or two decimals when it is not whole: 5, 600, 12.5
export function tac(wei) {
  const cents = wei / (WAD / 100n);
  const whole = cents / 100n, frac = cents % 100n;
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === 0n ? w : `${w}.${frac.toString().padStart(2, '0').replace(/0$/, '')}`;
}

export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s ?? ''));
// a contribution made by a tacit-prover on its own (the tool's name when the prover takes its turn)
export const isProver = (r) => r?.name === 'tacit-prover';
// what picks a contribution's face: its 0x address when it has one (the same zOrgz invader the prover pool shows for it), else its own hash
export const faceKey = (r) => (isAddress(r?.handle) ? r.handle : isAddress(r?.name) ? r.name : `0x${r?.contribution_hash}`);
export const label = (s) => (isAddress(s) ? `${String(s).slice(0, 6)}…${String(s).slice(-4)}` : String(s ?? ''));
// a receipt's name for the wall: the name, or the address shortened; a handle only when it says something else
export const nameOf = (r) => label(isProver(r) && isAddress(r.handle) ? r.handle : r.name);

export function ago(at, now = Date.now()) {
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// the receipt a visitor means by a name, a handle, a 0x address, a contribution hash or "#20"; null when none
export function findReceipt(receipts, q) {
  const s = String(q ?? '').trim().toLowerCase();
  if (!s) return null;
  const h = normalHash(s), num = /^#?(\d{1,6})$/.exec(s);
  return (receipts || []).find((r) => (h && (r.contribution_hash === h || r.file_sha256 === h))
    || (num && r.index === Number(num[1]))
    || String(r.name).toLowerCase() === s || String(r.handle).toLowerCase() === s) || null;
}

// the post that shares a contribution, once a visitor has found theirs
export const PAGE_URL_SHARE = PAGE_URL;
