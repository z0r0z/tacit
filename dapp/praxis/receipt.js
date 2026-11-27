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
  const json = JSON.stringify({ index: r.index, name: r.name, handle: r.handle, contribution_hash: r.contribution_hash, file_sha256: r.file_sha256, prev_file_sha256: r.prev_file_sha256, at: r.at, support: Array.isArray(r.support) && r.support.length ? r.support : undefined });
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

// The post that shares a contribution: its number in the chain and its hash, an invitation to add one, the tags, and the page.
export function shareUrl(hash, index) {
  const text = `I contributed to the Tacit Praxis ceremony${Number.isInteger(index) ? `, #${index} in the chain` : ''}.\n\nMy contribution:\n${hash}\n\nAdd yours and earn TAC:\n\n#TAC #Praxis`;
  return `https://twitter.com/intent/tweet?${new URLSearchParams({ text, url: PAGE_URL })}`;
}

// The post anyone can make about the ceremony, before or without contributing.
export function pageShareUrl() {
  const text = 'The Tacit Praxis ceremony is open: add your randomness to a shared key and earn TAC for it.\n\n#TAC #Praxis';
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

// The address a contribution is credited to (its handle, else its name), lower-cased, or null: the same rule the points feed applies.
export const addressOf = (r) => {
  const h = String(r?.handle ?? '').trim(), n = String(r?.name ?? '').trim();
  return /^0x[0-9a-fA-F]{40}$/.test(h) ? h.toLowerCase() : /^0x[0-9a-fA-F]{40}$/.test(n) ? n.toLowerCase() : null;
};
// What is earned but not yet paid: a credit is counted once its UTC day is over, so contributions made today show as earned first.
// paid + pending never passes the pot.
export function rewardProgress(view, addresses) {
  const credited = view.total - view.left;
  let pending = BigInt(addresses) * view.each - credited;
  if (pending < 0n) pending = 0n;
  if (pending > view.left) pending = view.left;
  const leftAfter = view.left - pending;
  return { pending, leftAfter, count: leftAfter / view.each, pendFrac: Number(pending * 10000n / view.total) / 10000 };
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
// a name wrapped in <> is the command's placeholder left unchanged, which is no name at all
export const isPlaceholder = (s) => /^<[^>]*>$/.test(String(s ?? '').trim());
export const hasName = (r) => { const n = String(r?.name ?? '').trim(); return n !== '' && !isPlaceholder(n); };
export const nameOf = (r) => label(isProver(r) && isAddress(r.handle) ? r.handle : hasName(r) ? r.name : isAddress(r?.handle) ? r.handle : 'Anonymous');

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

// Contributions made by Tacit's own machines, to test the ceremony before it opened. A name is self-declared, so a badge by name could be copied
// by anyone; these are the contributions themselves, which cannot be.
export const HOUSE_CONTRIBUTIONS = new Set([
  'b027d931c74e1f0175b3f51d54df92dd8f79a152d0efe5ea3783205b7e8f33af',   // #18, the first, made on a rented machine through the public coordinator
  '2192474662e8da01db43f77d6e42ea6800d1e65334768d6f8066bdc47a79fda8',   // #20, the release binary tried through the public coordinator
]);
export const isHouse = (r) => HOUSE_CONTRIBUTIONS.has(r?.contribution_hash);

// The file after each of Succinct's 18 contributions (phase2-0 to phase2-17), from the genesis record: a mask for each link of the chain.
export const SUCCINCT_LINKS = [
  'ce10c291c194a3b4c691ec6f3ab38b104ed2a03946a22eb4903d174e9b92e0f7', '076b15320d0299c2eb6557e091a41333e9b313637d9a39ec5346d664f845f539',
  'ca3ff0bb605ac5bac11ba5b52ea0424193e2f3137fd4da02b47d8e66163069dc', '0cf0a48921bb8fdc73026aeaa75d91855bef7eda4a317d23c705c7724994885d',
  '7bd1898619ab75a15b730920e9c8fd272155bf8f0b722a287743e89972599c06', 'df9f4200fb900524ca8a26e5129531412ed95dbddac49c44ac1da68cf4804db1',
  '9a65d352d3b4763204ef0b5d6af93d2a92988349c3dcd0f9b64b54649c2eb3b3', '0eb2ef2066ebf0b2b48d9e3efc6c9b65b5a1a8cd66f5fa6963f2d5831342055a',
  '0f642b0b8b45828c061722909366a51b6662f9c513956481de6282bcbc357c38', '4bc8c342e547733603264eb6a023e48249a7ea7090a8289bac6fc61bce57cd27',
  '2d116e0d2a2cc7a4ca5ae2adc777add66e3981c065dad68b24db7dff84206770', 'e9015848fd835e07ec507c0bd3a35ecdd0f9abced3cf4c34c123f8885d0e6442',
  '60236adc1bf89a97716020210b1cfa19925eb29b7bdbeff7ba3fecad9afc5f27', '2b408ba231324f288df711107aba341192ef10f6d86cd4ad25da2de33e5bb2dc',
  '1df1541ad22b68d8d23b0825a5da6c9724f6d240e388c77510e8d65b3dfcc7f6', 'ec037ed2e2bc54b9e3106db286c921eb6d4c7ccdb3adee8d354f3958368eb988',
  'e374743ca1bac4d323471ac2a22d3a0255e00b1957a2e0d26b92b1361ea0d215', 'bf6f7799c77a90009ae356fd0d3a69a91cf153825e6762ce344fe804cf5db2df',
];
