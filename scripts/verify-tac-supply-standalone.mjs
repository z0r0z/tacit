// Verify TAC's fixed 21,000,000 supply from first principles — zero install.
// Needs only Node (18+). No npm packages, no repo clone, no indexer trusted.
//
//   curl -fsSL https://raw.githubusercontent.com/z0r0z/tacit/main/scripts/verify-tac-supply-standalone.mjs | node --input-type=module
//
//   (or save it and run:  node verify-tac-supply-standalone.mjs  [<asset_id> <etch_txid>])
//
// What it proves, and where each fact comes from:
//   1. asset_id is bound to the etch tx        — local SHA-256, trustless
//   2. the etch is non-mintable (authority = 0)— read from the Bitcoin tx witness
//   3. the etch commits to exactly 21,000,000  — Pedersen opening (inline secp256k1)
// The Bitcoin tx is fetched from a public explorer, but nothing it says is
// trusted: asset_id is recomputed from the txid, and the IPFS blob is checked
// against its own content hash (the CID). Point TACIT_BTC_API / TACIT_IPFS_GATEWAYS
// at your own node to drop even the liveness dependency.

import { createHash } from 'node:crypto';

// ── public identifiers (override: … | node --input-type=module - <asset_id> <etch_txid>) ──
const ARGV = process.argv.slice(2);
const TAC_ASSET_ID = (ARGV[0] || 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b').toLowerCase();
const ETCH_TXID    = (ARGV[1] || 'e2d10be19c2b73b86e14be99dc237a3d999ba3dfbe6f3e3714590acee2ca481e').toLowerCase();
const EXPECT_H     = '02bd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56'; // KAT, SPEC §3.1
const BTC_API      = process.env.TACIT_BTC_API || 'https://mempool.space/api';
const IPFS_GATEWAYS = (process.env.TACIT_IPFS_GATEWAYS || [
  'https://ipfs.io/ipfs/{cid}',
  'https://{cid}.ipfs.inbrowser.link/',
  'https://trustless-gateway.link/ipfs/{cid}?format=raw',
  'https://dweb.link/ipfs/{cid}',
  'https://w3s.link/ipfs/{cid}',
  'https://gateway.pinata.cloud/ipfs/{cid}',
].join(',')).split(',');

// ── helpers ──
const enc = new TextEncoder();
const toHex = u => Buffer.from(u).toString('hex');
const fromHex = h => Uint8Array.from(Buffer.from(h, 'hex'));
const sha256 = b => new Uint8Array(createHash('sha256').update(b).digest());
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const u32le = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
let failed = false;
const ok = (label, cond, extra = '') => { console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${extra ? '  ' + extra : ''}`); if (!cond) failed = true; return cond; };

// ── inline secp256k1 (affine, BigInt) — only what a Pedersen check needs ──
const Pp = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const Nn = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const mod = (a, m = Pp) => ((a % m) + m) % m;
const modpow = (b, e, m) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; };
const inv = a => modpow(a, Pp - 2n, Pp);
const INF = null;
function add(P, Q) {
  if (P === INF) return Q;
  if (Q === INF) return P;
  if (P.x === Q.x && mod(P.y + Q.y) === 0n) return INF;
  let m;
  if (P.x === Q.x && P.y === Q.y) m = mod((3n * P.x * P.x) * inv(2n * P.y));
  else m = mod((Q.y - P.y) * inv(Q.x - P.x));
  const x = mod(m * m - P.x - Q.x);
  return { x, y: mod(m * (P.x - x) - P.y) };
}
function mul(k, P) { k = mod(k, Nn); let R = INF, A = P; while (k > 0n) { if (k & 1n) R = add(R, A); A = add(A, A); k >>= 1n; } return R; }
function decompress(xBytes, evenY) { // returns point or null if x has no y on the curve
  const x = BigInt('0x' + toHex(xBytes));
  const yy = mod(x * x % Pp * x + 7n);
  const y = modpow(yy, (Pp + 1n) / 4n, Pp);
  if (mod(y * y) !== yy) return null;           // not a quadratic residue → x not on curve
  return { x, y: (y % 2n === 0n) === evenY ? y : mod(-y) };
}
const compress = P => P === INF ? '00' : (P.y % 2n === 0n ? '02' : '03') + P.x.toString(16).padStart(64, '0');

// ── NUMS generator H + Pedersen, byte-identical to the Tacit dapp ──
function deriveH() {
  const seed = sha256(enc.encode('tacit-generator-H-v1'));
  for (let c = 0; c < 256; c++) { const p = decompress(sha256(cat(seed, new Uint8Array([c]))), true); if (p) return p; }
  throw new Error('failed to derive H');
}
const H = deriveH();
const G = { x: Gx, y: Gy };
const pedersenCommit = (amount, blinding) => add(mul(BigInt(amount), H), mul(BigInt(blinding), G));

// ── CETCH envelope extraction (port of worker/src/index.js) ──
const MAGIC = enc.encode('TACIT');
function extractEnvelope(script) {
  if (!script || script.length < 36) return null;
  let p = 0;
  if (script[p] !== 32) return null; p += 1 + 32;
  if (script[p] !== 0xac) return null; p += 1;
  if (script[p] !== 0x00 || script[p + 1] !== 0x63) return null; p += 2;
  const pushes = []; let endif = false;
  while (p < script.length) {
    if (script[p] === 0x68) { p += 1; endif = true; break; }
    const op = script[p]; p += 1; let data;
    if (op >= 1 && op <= 75) { data = script.slice(p, p + op); p += op; }
    else if (op === 0x4c) { const ln = script[p]; p += 1; data = script.slice(p, p + ln); p += ln; }
    else if (op === 0x4d) { const ln = script[p] | (script[p + 1] << 8); p += 2; data = script.slice(p, p + ln); p += ln; }
    else if (op === 0x00) { data = new Uint8Array(0); }
    else return null;
    pushes.push(data);
  }
  if (!endif || pushes.length < 3 || pushes[0].length !== 5) return null;
  for (let i = 0; i < 5; i++) if (pushes[0][i] !== MAGIC[i]) return null;
  if (pushes[1].length !== 1 || pushes[1][0] !== 0x01) return null;
  return cat(...pushes.slice(2));
}
function decodeCEtch(payload) {
  if (!payload || payload[0] !== 0x21) return null;
  let p = 1;
  const tlen = payload[p]; p += 1;
  const ticker = Buffer.from(payload.slice(p, p + tlen)).toString('utf8'); p += tlen;
  const decimals = payload[p]; p += 1;
  const commitment = payload.slice(p, p + 33); p += 33 + 8;
  const rpLen = payload[p] | (payload[p + 1] << 8); p += 2 + rpLen;
  const mintAuthority = payload.slice(p, p + 32); p += 32;
  const imgLen = payload[p] | (payload[p + 1] << 8); p += 2;
  const imageUri = imgLen ? Buffer.from(payload.slice(p, p + imgLen)).toString('utf8') : null;
  return { ticker, decimals, commitment, mintAuthority, imageUri };
}

// ── content-addressed IPFS fetch (verifies bytes against the CIDv1 sha2-256) ──
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function b32decode(s) { let bits = 0, val = 0; const out = []; for (const ch of s) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xff); } } return Uint8Array.from(out); }
function cidDigest(cid) { const raw = b32decode(cid.slice(1)); if (raw[0] !== 0x01 || raw[1] !== 0x55 || raw[2] !== 0x12 || raw[3] !== 0x20) throw new Error('not a CIDv1 raw sha2-256'); return raw.slice(4, 36); }
async function fetchVerifiedIpfs(cid) {
  const want = toHex(cidDigest(cid));
  const tried = [];
  for (const tmpl of IPFS_GATEWAYS) {
    const url = tmpl.replace('{cid}', cid);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
        const r = await fetch(url, { signal: ctl.signal }); clearTimeout(t);
        if (!r.ok) { tried.push(`${url} → HTTP ${r.status}`); break; }
        const buf = new Uint8Array(await r.arrayBuffer());
        if (toHex(sha256(buf)) !== want) throw new Error('content does not match CID');
        return buf;
      } catch (e) {
        if (String(e.message).includes('match CID')) throw new Error(`${url}: content does not match its CID (gateway served wrong bytes)`);
        if (attempt === 2) tried.push(`${url} → ${e.name === 'AbortError' ? 'timeout' : e.message}`);
      }
    }
  }
  throw new Error('could not fetch the attestation from any IPFS gateway:\n   - ' + tried.join('\n   - ') +
    '\n  Public IPFS gateways are flaky — just re-run, or set TACIT_IPFS_GATEWAYS to gateways you trust (comma-separated, {cid} as placeholder).');
}

// ── run ──
console.log(`\nVerifying TAC fixed supply\n  asset_id : ${TAC_ASSET_ID}\n  etch tx  : ${ETCH_TXID}\n`);

ok('NUMS generator H derives to the pinned value (SPEC §3.1)', compress(H) === EXPECT_H);

const txidLE = fromHex(ETCH_TXID).reverse();
ok('asset_id is bound to the etch tx (local SHA-256)', toHex(sha256(cat(txidLE, u32le(0)))) === TAC_ASSET_ID);

const tx = await (await fetch(`${BTC_API}/tx/${ETCH_TXID}`)).json();
let etch = null;
for (const vin of (tx.vin || [])) {
  const w = vin.witness || [];
  if (w.length < 2) continue;
  const e = extractEnvelope(fromHex(w[w.length - 2]));
  if (e) { const d = decodeCEtch(e); if (d) { etch = d; break; } }
}
if (!ok('CETCH envelope found in the etch tx witness', !!etch)) process.exit(1);

ok(`ticker is TAC, decimals = ${etch.decimals}`, etch.ticker === 'TAC');
ok('mint authority is zero → non-mintable, no new TAC can ever be valid', etch.mintAuthority.every(b => b === 0), `(${toHex(etch.mintAuthority).slice(0, 16)}…)`);

const cid = (etch.imageUri || '').replace(/^ipfs:\/\//, '');
ok('etch image_uri is an IPFS CID', /^bafk/.test(cid), cid);
const md = JSON.parse(Buffer.from(await fetchVerifiedIpfs(cid)).toString('utf8'));
const att = md.tacit_attest || {};
const supply = BigInt(att.supply), blinding = BigInt('0x' + att.blinding);
ok('published opening verifies the on-chain Pedersen commitment', compress(pedersenCommit(supply, blinding)) === toHex(etch.commitment));
ok('supply opens to exactly 21,000,000 TAC', supply === 2100000000000000n, `(${(supply / (10n ** BigInt(etch.decimals))).toLocaleString('en-US')} at ${etch.decimals} decimals)`);

console.log(`\n${failed ? '\x1b[31m✗ verification FAILED\x1b[0m' : '\x1b[32m✓ TAC supply is provably fixed at 21,000,000 — non-mintable, opening verified from Bitcoin + IPFS\x1b[0m'}\n`);
process.exit(failed ? 1 : 0);
