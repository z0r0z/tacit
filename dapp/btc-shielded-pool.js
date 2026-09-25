// Bitcoin-native shielded pool: wallet side of DESIGN-btc-shielded-pool.md §2–§6, client-proved relation
// (dapp/circuits/btc-pool/spend.circom; reference model dapp/btc-pool-zk.js; boundary dapp/btc-pool-zk-boundary.js).
// Keys and addresses, note creation and scanning, the T_BTC_SHIELD and T_BTC_SPEND bodies with their circuit
// witnesses, wallet defaults, and exit recovery. Proving goes through a proof system object
// (btc-pool-halo2-prover.js makeHalo2System): prove(input) → wire, verify(publics, wire) → bool.
//
// Address strings are bech32m over the 97-byte V(33, secp) ‖ A(32, BabyJub) ‖ N(32, BabyJub), HRP "bp" on mainnet
// and "tbp" on signet. Every key is derived per network. Change and padding go to an internal address
// (V_int ‖ A ‖ N): v alone does not see them, (v, v_int) does, and n adds which notes are spent.

import { poseidon2, poseidon3, poseidon4, poseidon5 } from './vendor/tacit-poseidon.min.js';
import {
  makeBtcPoolZk, assetField, bodyHash, hsL, spendPublics, pedersenBJJ, mulB8, L_BJJ, P_FR, ZK_N_IN, ZK_N_OUT,
} from './btc-pool-zk.js';
import { proveBoundary, verifyBoundary, encodeBoundary, decodeBoundary, BOUNDARY_LEN } from './btc-pool-zk-boundary.js';
import { packPoint, unpackPoint, isIdentity } from './amm-bjj.js';

export const T_BTC_SHIELD = 0x6c;
export const T_BTC_SPEND = 0x6d;
export const BTC_POOL_SHIELD_MAX_IN = 8;
export const BTC_POOL_MAX_IN = ZK_N_IN;
export const BTC_POOL_MAX_OUT = ZK_N_OUT;
export const CT_NOTE_LEN = 24; // v(8) sealed ‖ tag(16)
export const POOL_NOTE_LEN = 32 + 33 + CT_NOTE_LEN; // leaf ‖ pk_eph ‖ ct_note
export const EXIT_LEN = 4 + 32 + BOUNDARY_LEN; // exit_vout ‖ dest_spk_hash ‖ boundary
export const BIND_LEN = 36; // txid ‖ vout, all zero for none
export const WANT_LEN = 44; // vout ‖ value ‖ spk_hash
export const KERNEL_SIG_LEN = 64;
export const BTC_POOL_MAX_PROOF = 4096;
export const BTC_POOL_TREE_DEPTH = 32;
export const ADDRESS_LEN = 97;
export const ADDRESS_HRP = { mainnet: 'bp', signet: 'tbp' };
export { BOUNDARY_LEN };

const U64_MAX = (1n << 64n) - 1n;
const U32_LIMIT = 2 ** 32;
export const ANCHOR_STEP = 6;
const POSEIDON = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 };
export const zk = makeBtcPoolZk({ poseidon: (xs) => POSEIDON[xs.length](xs) });

const checkU32 = (x, name) => {
  if (!Number.isInteger(x) || x < 0 || x >= U32_LIMIT) throw new Error(`btc-pool: ${name} must be an integer in [0, 2^32)`);
  return x;
};
// A u64 given as a bigint or a safe integer; strings and fractions are refused.
const checkU64 = (x, name) => {
  const v = typeof x === 'bigint' ? x : Number.isSafeInteger(x) ? BigInt(x) : null;
  if (v === null || v < 0n || v > U64_MAX) throw new Error(`btc-pool: ${name} must be a u64 (bigint or safe integer)`);
  return v;
};

// Shared anchor policy (§6): tip − 6, rounded down to a multiple of 6.
export function defaultAnchor(tip) {
  checkU32(tip, 'tip');
  if (tip < ANCHOR_STEP) throw new Error('btc-pool: tip below the anchor offset');
  return Math.floor((tip - ANCHOR_STEP) / ANCHOR_STEP) * ANCHOR_STEP;
}

export function makeBtcShieldedPool({ secp, keccak256, sha256, randomBytes, ripemd160 }) {
  const Pt = secp.ProjectivePoint;
  const G = Pt.BASE;
  const ZERO = Pt.ZERO;
  const N = secp.CURVE.n;
  const P_FIELD = secp.CURVE.p;
  const te = new TextEncoder();
  const rand = randomBytes || ((len) => globalThis.crypto.getRandomValues(new Uint8Array(len)));

  const D = {
    aead: te.encode('tacit-btc-pool-zk-aead-v1'),
    tag: te.encode('tacit-btc-pool-zk-aead-tag-v1'),
    shield: te.encode('tacit-btc-pool-zk-shield-v1'),
    keyV: te.encode('tacit-btc-pool-wallet-view-v1'),
    keyVInt: te.encode('tacit-btc-pool-wallet-view-internal-v1'),
    keyX: te.encode('tacit-btc-pool-wallet-exit-v1'),
    exitKey: te.encode('tacit-btc-pool-exit-key-v1'),
    eph: te.encode('tacit-btc-pool-zk-eph-v1'),
    exitSecp: te.encode('tacit-btc-pool-zk-exit-secp-v1'),
    exitBjj: 'tacit-btc-pool-zk-exit-bjj-v1',
  };

  // ── bytes ──
  const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const hx = (b) => '0x' + bytesToHex(b);
  const toBytes = (v, len) => {
    let b;
    if (v instanceof Uint8Array) b = v;
    else {
      const s = String(v).replace(/^0x/i, '');
      if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('btc-pool: bad hex');
      b = new Uint8Array(s.length / 2);
      for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
    }
    if (len != null && b.length !== len) throw new Error(`btc-pool: expected ${len} bytes, got ${b.length}`);
    return b;
  };
  const concat = (...arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
  const be = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
  const le = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = 0; i < n; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
  const bToBig = (b) => { let x = 0n; for (const y of b) x = (x << 8n) | BigInt(y); return x; };
  const leToBig = (b) => { let x = 0n; for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]); return x; };
  const modN = (x) => ((x % N) + N) % N;
  const k = (...parts) => keccak256(concat(...parts));
  const eqBytes = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; };
  const reverse = (b) => Uint8Array.from(b).reverse();
  const f32 = (x) => hx(be(BigInt(x), 32)); // field element → 0x-hex 32 bytes
  const fOf = (x) => (typeof x === 'bigint' ? x : bToBig(toBytes(x, 32)));

  // ── secp256k1 (view keys, stealth ECDH, transparent commitments) ──
  const mul = (P, s) => { const x = modN(BigInt(s)); return x === 0n ? ZERO : P.multiply(x); };
  const compress = (P) => P.toRawBytes(true);
  const xOnly = (P) => P.toRawBytes(true).slice(1);
  const affineXY = (P) => { const a = P.toAffine(); return { cx: be(a.x, 32), cy: be(a.y, 32) }; };
  const pointFromXY = (cx, cy) => {
    const x = bToBig(toBytes(cx, 32)), y = bToBig(toBytes(cy, 32));
    if (x >= P_FIELD || y >= P_FIELD) throw new Error('btc-pool: coordinate out of range');
    const P = Pt.fromAffine({ x, y });
    P.assertValidity();
    return P;
  };
  const pointFromCompressed = (b) => {
    const bb = toBytes(b, 33);
    if (bb[0] !== 0x02 && bb[0] !== 0x03) throw new Error('btc-pool: point prefix');
    return Pt.fromHex(bytesToHex(bb));
  };
  const liftX = (x32) => {
    const x = bToBig(toBytes(x32, 32));
    if (x >= P_FIELD) throw new Error('btc-pool: x out of range');
    return Pt.fromHex('02' + bytesToHex(toBytes(x32, 32)));
  };

  function deriveH() {
    const seed = sha256(te.encode('tacit-generator-H-v1'));
    for (let c = 0; c < 256; c++) {
      const x = sha256(concat(seed, Uint8Array.of(c)));
      try { const p = Pt.fromHex('02' + bytesToHex(x)); if (!p.equals(ZERO)) return p; } catch { /* next counter */ }
    }
    throw new Error('btc-pool: failed to derive H');
  }
  const H = deriveH();
  const commitPoint = (value, blinding) => mul(H, value).add(mul(G, blinding));
  function commitXY(value, blinding) {
    const C = commitPoint(value, blinding);
    if (C.equals(ZERO)) throw new Error('btc-pool: commitment is the point at infinity');
    const { cx, cy } = affineXY(C);
    return { cx: hx(cx), cy: hx(cy) };
  }

  // Hs(x): keccak(x) as a big-endian integer mod n (secp), rejected if zero.
  function Hs(...parts) {
    const s = modN(bToBig(k(...parts)));
    if (s === 0n) throw new Error('btc-pool: Hs reduced to zero');
    return s;
  }
  const randomScalar = () => { for (;;) { const s = modN(bToBig(rand(32))); if (s !== 0n) return s; } };
  const randomBjj = () => { for (;;) { const s = bToBig(rand(32)) % L_BJJ; if (s !== 0n) return s; } };

  // ── BIP-340 (shield kernel) ──
  const tagged = (tag, ...msgs) => { const t = sha256(te.encode(tag)); return sha256(concat(t, t, ...msgs)); };
  function schnorrSign(msg32, secret, aux32) {
    const msg = toBytes(msg32, 32);
    const d0 = modN(BigInt(secret));
    if (d0 === 0n) throw new Error('btc-pool: zero signing key');
    const P = G.multiply(d0);
    const Pc = compress(P);
    const d = Pc[0] === 0x02 ? d0 : N - d0;
    const px = Pc.slice(1);
    const aux = aux32 ? toBytes(aux32, 32) : rand(32);
    const t = be(d ^ bToBig(tagged('BIP0340/aux', aux)), 32);
    const k0 = modN(bToBig(tagged('BIP0340/nonce', t, px, msg)));
    if (k0 === 0n) throw new Error('btc-pool: zero nonce');
    const R = G.multiply(k0);
    const Rc = compress(R);
    const kk = Rc[0] === 0x02 ? k0 : N - k0;
    const rx = Rc.slice(1);
    const e = modN(bToBig(tagged('BIP0340/challenge', rx, px, msg)));
    return concat(rx, be(modN(kk + e * d), 32));
  }
  function schnorrVerify(sig64, msg32, pubX32) {
    try {
      const sig = toBytes(sig64, 64), msg = toBytes(msg32, 32), px = toBytes(pubX32, 32);
      const r = bToBig(sig.slice(0, 32)), s = bToBig(sig.slice(32));
      if (r >= P_FIELD || s >= N) return false;
      const P = liftX(px);
      const e = modN(bToBig(tagged('BIP0340/challenge', sig.slice(0, 32), px, msg)));
      const R = mul(G, s).add(mul(P, e).negate());
      if (R.equals(ZERO)) return false;
      const Rc = compress(R);
      return Rc[0] === 0x02 && eqBytes(Rc.slice(1), sig.slice(0, 32));
    } catch { return false; }
  }

  // ── bech32m (no length cap: a 97-byte address exceeds BIP-173's 90-char limit) ──
  const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const BECH32M_CONST = 0x2bc830a3;
  const polymod = (values) => {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) { const b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i]; }
    return chk >>> 0;
  };
  const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const convertBits = (data, from, to, pad) => {
    let acc = 0, bits = 0; const out = []; const maxv = (1 << to) - 1;
    for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); } }
    if (pad) { if (bits > 0) out.push((acc << (to - bits)) & maxv); }
    else if (bits >= from || ((acc << (to - bits)) & maxv)) throw new Error('btc-pool: bech32m padding');
    return out;
  };
  function bech32mEncode(hrp, bytes) {
    const words = convertBits(bytes, 8, 5, true);
    const pm = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST;
    const chk = []; for (let i = 0; i < 6; i++) chk.push((pm >>> (5 * (5 - i))) & 31);
    return hrp + '1' + [...words, ...chk].map((w) => B32[w]).join('');
  }
  function bech32mDecode(str) {
    if (str !== str.toLowerCase() && str !== str.toUpperCase()) throw new Error('btc-pool: mixed-case address');
    const s = str.toLowerCase();
    const pos = s.lastIndexOf('1');
    if (pos < 1 || pos + 7 > s.length) throw new Error('btc-pool: malformed address');
    const hrp = s.slice(0, pos);
    const data = [...s.slice(pos + 1)].map((c) => { const i = B32.indexOf(c); if (i < 0) throw new Error('btc-pool: bad address char'); return i; });
    if (polymod([...hrpExpand(hrp), ...data]) !== BECH32M_CONST) throw new Error('btc-pool: address checksum');
    return { hrp, bytes: Uint8Array.from(convertBits(data.slice(0, -6), 5, 8, false)) };
  }

  // ── wallet keys and addresses ──
  const checkNetwork = (network) => { if (!ADDRESS_HRP[network]) throw new Error(`btc-pool: unknown network ${network}`); return network; };
  const bjj = (packedHex) => {
    const P = unpackPoint(toBytes(packedHex, 32));
    if (!P || isIdentity(P)) throw new Error('btc-pool: not a BabyJub subgroup point');
    return P;
  };

  // v, v_int (secp) and a, n (BabyJub) are bound to the network, so one seed yields unlinkable signet and
  // mainnet wallets.
  function walletFromSeed(seed, network = 'signet') {
    const sd = toBytes(seed, 32);
    const net = te.encode(checkNetwork(network));
    const v = Hs(D.keyV, net, sd), vInt = Hs(D.keyVInt, net, sd);
    const { a, n } = zk.walletKeys(sd, network);
    const exitRoot = k(D.keyX, net, sd);
    return walletFromScalars({ v, a, n, vInt, exitRoot }, network);
  }
  // vInt and exitRoot are optional: without vInt the wallet has no internal address, without exitRoot no exit keys.
  function walletFromScalars({ v, a, n, vInt, exitRoot }, network = 'signet') {
    checkNetwork(network);
    const aa = BigInt(a) % L_BJJ, nn = BigInt(n) % L_BJJ;
    if (aa === 0n || nn === 0n) throw new Error('btc-pool: zero BabyJub key');
    const V = G.multiply(BigInt(v));
    const A = packPoint(mulB8(aa)), Nk = packPoint(mulB8(nn));
    const address = concat(compress(V), A, Nk);
    const w = {
      network,
      v: hx(be(v, 32)), a: hx(be(aa, 32)), n: hx(be(nn, 32)),
      V: hx(compress(V)), A: hx(A), N: hx(Nk),
      address: hx(address), addressString: encodeAddress(address, network),
    };
    if (vInt != null) {
      const VInt = G.multiply(BigInt(vInt));
      w.vInt = hx(be(vInt, 32));
      w.VInt = hx(compress(VInt));
      w.internalAddress = hx(concat(compress(VInt), A, Nk));
    }
    if (exitRoot != null) w.exitRoot = hx(toBytes(exitRoot, 32));
    return w;
  }
  // Incoming-only tier: v finds and reads notes paid to the external address; change and padding stay hidden.
  // { internal: true } gives the (v, v_int) tier, which also reads change and padding.
  const viewWallet = (w, { internal = false } = {}) => {
    const out = { network: w.network, v: w.v, V: w.V, A: w.A, N: w.N, address: w.address, addressString: w.addressString };
    if (internal) {
      if (w.vInt == null) throw new Error('btc-pool: wallet has no v_int');
      Object.assign(out, { vInt: w.vInt, VInt: w.VInt, internalAddress: w.internalAddress });
    }
    return out;
  };
  // Full-view tier: (v, v_int, n) sees every note, internal ones included, and which are spent. Cannot spend.
  const fullViewWallet = (w) => {
    if (w.vInt == null || w.n == null) throw new Error('btc-pool: full view needs v_int and n');
    return { ...viewWallet(w, { internal: true }), n: w.n };
  };
  function encodeAddress(address, network = 'signet') {
    const hrp = ADDRESS_HRP[network];
    if (!hrp) throw new Error(`btc-pool: unknown network ${network}`);
    return bech32mEncode(hrp, toBytes(address, ADDRESS_LEN));
  }
  // A raw 97-byte address carries no network, so it is accepted only with an explicit one.
  function decodeAddress(input, network) {
    if (network != null) checkNetwork(network);
    let bytes, net = network;
    if (typeof input === 'string' && !/^(0x)?[0-9a-f]{194}$/i.test(input)) {
      const d = bech32mDecode(input);
      net = Object.keys(ADDRESS_HRP).find((key) => ADDRESS_HRP[key] === d.hrp);
      if (!net) throw new Error(`btc-pool: unknown address prefix ${d.hrp}`);
      if (network && network !== net) throw new Error(`btc-pool: address is for ${net}, expected ${network}`);
      bytes = d.bytes;
    } else {
      if (network == null) throw new Error('btc-pool: raw address needs an explicit network');
      bytes = toBytes(input, ADDRESS_LEN);
    }
    if (bytes.length !== ADDRESS_LEN) throw new Error('btc-pool: address must be 97 bytes');
    const V = pointFromCompressed(bytes.slice(0, 33));
    const A = bjj(bytes.slice(33, 65));
    const Nk = bjj(bytes.slice(65, 97));
    return { V, A, N: Nk, bytes, network: net };
  }

  // ── notes (§2) ──
  const aeadKey = (s) => k(D.aead, s);
  function keystream(key, len) {
    const out = new Uint8Array(len);
    for (let i = 0, off = 0; off < len; i++, off += 32) out.set(k(key, le(i, 2)).subarray(0, Math.min(32, len - off)), off);
    return out;
  }
  function aeadSeal(key, pt) {
    const ks = keystream(key, pt.length);
    const ct = pt.map((b, i) => b ^ ks[i]);
    return concat(ct, k(D.tag, key, ct).slice(0, 16));
  }
  function aeadOpen(key, sealed) {
    if (sealed.length !== CT_NOTE_LEN) return null;
    const ct = sealed.subarray(0, 8);
    if (!eqBytes(sealed.subarray(8, 24), k(D.tag, key, ct).slice(0, 16))) return null;
    const ks = keystream(key, 8);
    return ct.map((b, i) => b ^ ks[i]);
  }

  const assetHexOf = (asset) => hx(toBytes(asset, 32));
  const leafOf = (asset, v, npk, rho) => zk.leafOf(assetField(toBytes(asset, 32)), v, npk, rho);
  const nullifier = (nkNote, leaf, leafIndex) => {
    if (leafIndex == null) throw new Error('btc-pool: nullifier needs the note\'s leaf_index');
    return f32(zk.nullifier(fOf(nkNote), fOf(leaf), BigInt(leafIndex)));
  };

  // Output note for an address: E = e·G, s = compress(e·V); the recipient's per-note keys, rho and leaf come
  // from (A, N, s) (btc-pool-zk.js outputKeys); ct_note seals v under keccak(domain ‖ s). opts.e pins the
  // otherwise fresh ephemeral scalar; opts.network is required for a raw address.
  function createNote(address, asset, value, opts = {}) {
    const addr = decodeAddress(address, opts.network);
    const v = checkU64(typeof value === 'bigint' ? value : BigInt(value), 'value');
    const e = opts.e != null ? modN(BigInt(opts.e)) : randomScalar();
    if (e === 0n) throw new Error('btc-pool: zero ephemeral scalar');
    const s = compress(addr.V.multiply(e));
    const o = zk.outputKeys(addr.A, addr.N, s);
    const assetHex = assetHexOf(asset);
    const leaf = f32(leafOf(assetHex, v, o.npk, o.rho));
    return {
      asset: assetHex, leaf, pkEph: hx(compress(G.multiply(e))), ctNote: hx(aeadSeal(aeadKey(s), be(v, 8))),
      value: v, npk: f32(o.npk), rho: f32(o.rho),
    };
  }
  const noteBytes = (o) => concat(toBytes(o.leaf, 32), toBytes(o.pkEph, 33), toBytes(o.ctNote, CT_NOTE_LEN));
  function parseNoteBytes(b, asset) {
    const f = { leaf: hx(b.slice(0, 32)), pkEph: hx(b.slice(32, 65)), ctNote: hx(b.slice(65, 65 + CT_NOTE_LEN)) };
    if (asset != null) f.asset = assetHexOf(asset);
    return f;
  }

  // Receipt (§2): the note decrypts under the view key, and its leaf equals Poseidon(asset, v, npk, rho) with
  // npk and rho derived from (A, N, s). v alone yields the value; n adds nk_note and, with the leafIndex, the
  // nullifier; a adds the note's spend key. v_int also receives notes paid to the internal address
  // (internal: true).
  function tryReceive(wallet, f) {
    const got = receiveUnder(wallet, wallet.v, f);
    if (got || wallet.vInt == null) return got;
    const own = receiveUnder(wallet, wallet.vInt, f);
    if (own) own.internal = true;
    return own;
  }
  function receiveUnder(wallet, viewKey, f) {
    try {
      const s = compress(pointFromCompressed(f.pkEph).multiply(bToBig(toBytes(viewKey, 32))));
      const pt = aeadOpen(aeadKey(s), toBytes(f.ctNote));
      if (!pt) return null;
      const value = bToBig(pt);
      const o = zk.outputKeys(bjj(wallet.A), bjj(wallet.N), s);
      const asset = assetHexOf(f.asset);
      const leaf = leafOf(asset, value, o.npk, o.rho);
      if (leaf !== fOf(f.leaf)) return null;
      const out = {
        asset, leaf: f32(leaf), pkEph: hx(toBytes(f.pkEph, 33)), ctNote: hx(toBytes(f.ctNote, CT_NOTE_LEN)),
        value, npk: f32(o.npk), rho: f32(o.rho),
      };
      if (f.leafIndex != null) out.leafIndex = Number(f.leafIndex);
      const t = zk.noteTweaks(s);
      if (wallet.n != null) {
        const nk = (bToBig(toBytes(wallet.n, 32)) + t.tN) % L_BJJ;
        if (nk === 0n) return null;
        out.nkNote = f32(nk);
        if (out.leafIndex != null) out.nf = nullifier(nk, leaf, out.leafIndex);
      }
      if (wallet.a != null) {
        const sk = (bToBig(toBytes(wallet.a, 32)) + t.tA) % L_BJJ;
        if (sk === 0n) return null;
        out.skNote = f32(sk);
        out.ak = o.Ak.map(f32);
      }
      return out;
    } catch { return null; }
  }
  const scan = (wallet, notes) => notes.map((f) => tryReceive(wallet, f)).filter(Boolean);

  // ── bodies ──
  const exitDestHash = (scriptPubKey) => hx(sha256(toBytes(scriptPubKey)));

  // bind: null, or { txid (display hex), vout }: an outpoint the carrier must spend. Encoded as the txid in
  // the byte order a transaction input serializes it, then vout LE.
  function bindBytes(bind) {
    if (bind == null) return new Uint8Array(BIND_LEN);
    if (typeof bind !== 'object') throw new Error('btc-pool: bind must be { txid, vout } or null');
    return concat(reverse(toBytes(bind.txid, 32)), le(checkU32(bind.vout, 'bind vout'), 4));
  }
  // want: null, or { vout, value, spkHash | scriptPubKey }: the carrier's output vout pays at least value sats
  // to that script.
  function normalizeWant(want) {
    if (want == null) return null;
    if (typeof want !== 'object') throw new Error('btc-pool: want must be { vout, value, spkHash | scriptPubKey } or null');
    const vout = checkU32(want.vout, 'want vout');
    const value = checkU64(want.value, 'want value');
    const fromSpk = want.scriptPubKey != null ? exitDestHash(want.scriptPubKey) : null;
    if (fromSpk == null && want.spkHash == null) throw new Error('btc-pool: want needs spkHash or scriptPubKey');
    const spkHash = want.spkHash != null ? hx(toBytes(want.spkHash, 32)) : fromSpk;
    if (fromSpk != null && spkHash !== fromSpk) throw new Error('btc-pool: want spkHash does not match scriptPubKey');
    return { vout, value, spkHash };
  }

  // exit: { exitVout, destSpkHash, boundary (825 bytes) }.
  function encodeSpendBody({ asset, hAnchor, bind = null, nullifiers, outputs = [], exit = null, want = null }) {
    if (!nullifiers.length || nullifiers.length > BTC_POOL_MAX_IN) throw new Error('btc-pool: n_in must be 1..2');
    if (outputs.length > BTC_POOL_MAX_OUT) throw new Error('btc-pool: n_out must be 0..3');
    if (!outputs.length && !exit) throw new Error('btc-pool: a spend needs an output or an exit');
    checkU32(hAnchor, 'h_anchor');
    if (exit) checkU32(exit.exitVout, 'exit_vout');
    const w = normalizeWant(want);
    if (w && exit && w.vout === exit.exitVout) throw new Error('btc-pool: want and exit name the same output');
    if (new Set(nullifiers.map((nf) => hx(toBytes(nf, 32)))).size !== nullifiers.length) throw new Error('btc-pool: repeated nullifier');
    const parts = [Uint8Array.of(T_BTC_SPEND), toBytes(asset, 32), le(hAnchor, 4), bindBytes(bind), Uint8Array.of(nullifiers.length)];
    for (const nf of nullifiers) parts.push(toBytes(nf, 32));
    parts.push(Uint8Array.of(outputs.length));
    for (const o of outputs) parts.push(noteBytes(o));
    parts.push(Uint8Array.of(exit ? 1 : 0));
    if (exit) parts.push(le(exit.exitVout, 4), toBytes(exit.destSpkHash, 32), toBytes(exit.boundary, BOUNDARY_LEN));
    parts.push(Uint8Array.of(w ? 1 : 0));
    if (w) parts.push(le(w.vout, 4), le(w.value, 8), toBytes(w.spkHash, 32));
    return concat(...parts);
  }

  const fieldOk = (b) => { const x = bToBig(b); return x < P_FR && x !== 0n; };

  // Parses a bare spend body or a full payload; rejects anything non-canonical (§3).
  function parseSpend(bytes, { full = false } = {}) {
    const b = toBytes(bytes);
    let p = 0;
    const take = (n) => { if (p + n > b.length) throw new Error('btc-pool: spend truncated'); const s = b.slice(p, p + n); p += n; return s; };
    if (take(1)[0] !== T_BTC_SPEND) throw new Error('btc-pool: not a spend envelope');
    const asset = hx(take(32));
    const hAnchor = Number(leToBig(take(4)));
    const bindRaw = take(BIND_LEN);
    const bind = bindRaw.every((x) => x === 0) ? null : { txid: bytesToHex(reverse(bindRaw.slice(0, 32))), vout: Number(leToBig(bindRaw.slice(32))) };
    const nIn = take(1)[0];
    if (nIn < 1 || nIn > BTC_POOL_MAX_IN) throw new Error('btc-pool: n_in out of range');
    const nullifiers = [];
    for (let i = 0; i < nIn; i++) {
      const nf = take(32);
      if (!fieldOk(nf)) throw new Error('btc-pool: nullifier is not a non-zero field element');
      nullifiers.push(hx(nf));
    }
    if (new Set(nullifiers).size !== nIn) throw new Error('btc-pool: repeated nullifier');
    const nOut = take(1)[0];
    if (nOut > BTC_POOL_MAX_OUT) throw new Error('btc-pool: n_out out of range');
    const out = { asset, hAnchor, bind, nullifiers, outputs: [], exit: null, want: null };
    for (let j = 0; j < nOut; j++) out.outputs.push(readOutput(take(POOL_NOTE_LEN), asset));
    const hasExit = take(1)[0];
    if (hasExit > 1) throw new Error('btc-pool: has_exit must be 0 or 1');
    if (hasExit) {
      const exitVout = Number(leToBig(take(4)));
      const destSpkHash = hx(take(32));
      out.exit = { exitVout, destSpkHash, ...readBoundary(take(BOUNDARY_LEN)) };
    }
    const hasWant = take(1)[0];
    if (hasWant > 1) throw new Error('btc-pool: has_want must be 0 or 1');
    if (hasWant) out.want = { vout: Number(leToBig(take(4))), value: leToBig(take(8)), spkHash: hx(take(32)) };
    if (nOut + hasExit < 1) throw new Error('btc-pool: spend has no output and no exit');
    out.body = b.slice(0, p);
    if (full) {
      const len = Number(leToBig(take(2)));
      if (len > BTC_POOL_MAX_PROOF) throw new Error('btc-pool: proof too long');
      out.proof = hx(take(len));
    }
    if (p !== b.length) throw new Error('btc-pool: trailing bytes');
    return out;
  }
  function readOutput(b, asset) {
    const f = parseNoteBytes(b, asset);
    if (!fieldOk(toBytes(f.leaf))) throw new Error('btc-pool: output leaf is not a non-zero field element');
    pointFromCompressed(f.pkEph);
    return f;
  }
  function readBoundary(b) {
    const bd = decodeBoundary(b);
    if (!bd) throw new Error('btc-pool: boundary malformed');
    const C = pointFromCompressed(bd.cSecp);
    const { cx, cy } = affineXY(C);
    return { boundary: hx(b), cSecp: hx(bd.cSecp), cBjj: hx(bd.cBjj), cx: hx(cx), cy: hx(cy) };
  }

  // 0x6C ‖ asset ‖ n_in ‖ n_out ‖ output×n_out ‖ boundary ‖ kernel_sig ‖ proof_len ‖ proof; body = bytes before kernel_sig.
  function parseShield(bytes, { full = true } = {}) {
    const b = toBytes(bytes);
    let p = 0;
    const take = (n) => { if (p + n > b.length) throw new Error('btc-pool: shield truncated'); const s = b.slice(p, p + n); p += n; return s; };
    if (take(1)[0] !== T_BTC_SHIELD) throw new Error('btc-pool: not a shield envelope');
    const asset = hx(take(32));
    const nIn = take(1)[0];
    if (nIn < 1 || nIn > BTC_POOL_SHIELD_MAX_IN) throw new Error('btc-pool: shield n_in out of range');
    const nOut = take(1)[0];
    if (nOut < 1 || nOut > BTC_POOL_MAX_OUT) throw new Error('btc-pool: shield n_out out of range');
    const outputs = [];
    for (let j = 0; j < nOut; j++) outputs.push(readOutput(take(POOL_NOTE_LEN), asset));
    const bd = readBoundary(take(BOUNDARY_LEN));
    const out = { asset, nIn, outputs, ...bd, body: b.slice(0, p) };
    if (full) {
      out.kernelSig = hx(take(KERNEL_SIG_LEN));
      const len = Number(leToBig(take(2)));
      if (len > BTC_POOL_MAX_PROOF) throw new Error('btc-pool: proof too long');
      out.proof = hx(take(len));
    }
    if (p !== b.length) throw new Error('btc-pool: trailing bytes');
    return out;
  }

  // Public signals the indexer derives for a payload, with its boundary checked (sigma + BP+). `root` is
  // R[h_anchor] for a spend (hex or bytes); a shield uses root 0. Throws when the boundary does not verify.
  function payloadPublics(bytes, { root = null } = {}) {
    const b = toBytes(bytes);
    if (b[0] === T_BTC_SHIELD) {
      const sh = parseShield(b);
      const depC = verifyBoundary(decodeBoundary(toBytes(sh.boundary)));
      if (!depC) throw new Error('btc-pool: shield boundary does not verify');
      return { parsed: sh, publics: spendPublics({ root: 0n, body: sh.body, asset: toBytes(sh.asset), outLeaves: sh.outputs.map((o) => fOf(o.leaf)), depC }) };
    }
    const sp = parseSpend(b, { full: true });
    let exitC = null;
    if (sp.exit) {
      exitC = verifyBoundary(decodeBoundary(toBytes(sp.exit.boundary)));
      if (!exitC) throw new Error('btc-pool: exit boundary does not verify');
    }
    if (root == null) throw new Error('btc-pool: root required');
    return {
      parsed: sp,
      publics: spendPublics({ root: fOf(root), body: sp.body, asset: toBytes(sp.asset), nullifiers: sp.nullifiers.map(fOf), outLeaves: sp.outputs.map((o) => fOf(o.leaf)), exitC }),
    };
  }
  async function verifyPayload(system, bytes, { root = null } = {}) {
    let r;
    try { r = payloadPublics(bytes, { root }); } catch { return false; }
    return system.verify(r.publics, toBytes(r.parsed.proof));
  }

  // ── seed-recoverable randomness of a spend ──
  // Keyed by the first input's nk_note (secret) and nullifier, so a wallet rebuilds the exit opening and every
  // output's ephemeral from its seed and chain data. A note is spent once, so these are fresh per spend.
  //   e_j    = Hs("tacit-btc-pool-zk-eph-v1"       ‖ nk_0 ‖ nf_0 ‖ j(1))                          (secp)
  //   r_secp = Hs("tacit-btc-pool-zk-exit-secp-v1" ‖ nk_0 ‖ nf_0 ‖ exit_vout(4) ‖ dest_spk_hash)   (secp)
  //   r_bjj  = hsL("tacit-btc-pool-zk-exit-bjj-v1",  nk_0 ‖ nf_0 ‖ exit_vout(4) ‖ dest_spk_hash)   (BabyJub)
  const outputEph = (nk0, nf0, j) => Hs(D.eph, toBytes(nk0, 32), toBytes(nf0, 32), Uint8Array.of(j));
  const exitOpenings = (nk0, nf0, exitVout, destSpkHash) => {
    const m = concat(toBytes(nk0, 32), toBytes(nf0, 32), be(exitVout, 4), toBytes(destSpkHash, 32));
    return { rSecp: Hs(D.exitSecp, m), rBjj: hsL(D.exitBjj, m) };
  };

  // Picks up to two inputs of `asset` covering `amount`. When one note covers it and another exists, the
  // smallest other note (a zero-value padding note when there is one) is added so the spend has 2 inputs;
  // a wallet holding a single note spends it alone.
  function selectInputs(notes, amount, { asset } = {}) {
    const want = BigInt(amount);
    if (want < 0n || want > U64_MAX) throw new Error('btc-pool: amount must be a u64');
    const assetHex = asset != null ? assetHexOf(asset) : null;
    const seen = new Set();
    const pool = [];
    for (const x of notes) {
      if (!x || !x.skNote || !x.nkNote || x.leafIndex == null) continue;
      if (assetHex && assetHexOf(x.asset) !== assetHex) continue;
      const id = x.nf ?? nullifier(x.nkNote, x.leaf, x.leafIndex);
      if (seen.has(id)) continue;
      seen.add(id);
      pool.push(x);
    }
    if (!pool.length) throw new Error('btc-pool: no spendable notes');
    const byValue = [...pool].sort((p, q) => (BigInt(p.value) < BigInt(q.value) ? -1 : BigInt(p.value) > BigInt(q.value) ? 1 : 0));
    const single = byValue.find((x) => BigInt(x.value) >= want);
    if (single) {
      const pad = byValue.find((x) => x !== single);
      const inputs = pad ? [single, pad] : [single];
      return { inputs, total: inputs.reduce((t, x) => t + BigInt(x.value), 0n) };
    }
    let best = null;
    for (let i = 0; i < byValue.length; i++) {
      for (let j = i + 1; j < byValue.length; j++) {
        const t = BigInt(byValue[i].value) + BigInt(byValue[j].value);
        if (t >= want && (!best || t < best.total)) best = { inputs: [byValue[j], byValue[i]], total: t };
      }
    }
    if (!best) throw new Error(`btc-pool: two notes cannot cover ${want}`);
    return best;
  }

  // Exit key `counter` of a wallet: d = Hs(domain ‖ exit_root ‖ counter(4, BE)). P2TR is BIP-86 (key path,
  // no script tree); outputPriv signs for the tweaked key. P2WPKH needs ripemd160 in the factory deps.
  function deriveExitKey(wallet, counter, type = 'p2tr') {
    if (!wallet || wallet.exitRoot == null) throw new Error('btc-pool: wallet has no exit root');
    checkU32(counter, 'exit key counter');
    const d = Hs(D.exitKey, toBytes(wallet.exitRoot, 32), be(counter, 4));
    const P = G.multiply(d);
    const out = { counter, type, priv: hx(be(d, 32)), pub: hx(compress(P)) };
    if (type === 'p2tr') {
      const px = xOnly(P);
      const t = modN(bToBig(tagged('TapTweak', px)));
      const dEven = compress(P)[0] === 0x02 ? d : N - d;
      const Q = liftX(px).add(mul(G, t));
      if (Q.equals(ZERO)) throw new Error('btc-pool: degenerate taproot key');
      out.outputKey = hx(xOnly(Q));
      out.outputPriv = hx(be(modN(dEven + t), 32));
      out.scriptPubKey = hx(concat(Uint8Array.of(0x51, 0x20), xOnly(Q)));
    } else if (type === 'p2wpkh') {
      if (!ripemd160) throw new Error('btc-pool: p2wpkh exit keys need ripemd160');
      out.scriptPubKey = hx(concat(Uint8Array.of(0x00, 0x14), ripemd160(sha256(compress(P)))));
    } else throw new Error(`btc-pool: unknown exit key type ${type}`);
    out.destSpkHash = exitDestHash(out.scriptPubKey);
    return out;
  }
  const spkKey = (spk) => hx(toBytes(spk)).toLowerCase();
  const usedHas = (used, spkHex, hashHex) => {
    if (!used) return false;
    const list = used instanceof Set ? used : new Set([...used].map((x) => hx(toBytes(x)).toLowerCase()));
    return (spkHex != null && list.has(spkHex)) || list.has(hashHex);
  };
  // First exit key from `from` whose script is not in `used` (scripts or their SHA-256, hex).
  function freshExitKey(wallet, used, { type = 'p2tr', from = 0 } = {}) {
    for (let c = from; c < U32_LIMIT; c++) {
      const x = deriveExitKey(wallet, c, type);
      if (!usedHas(used, spkKey(x.scriptPubKey), x.destSpkHash)) return x;
    }
    throw new Error('btc-pool: exit keys exhausted');
  }

  const shuffle = (xs) => { for (let i = xs.length - 1; i > 0; i--) { const j = Number(bToBig(rand(4)) % BigInt(i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; } return xs; };
  const witnessOutput = (o) => ({ v: BigInt(o.value), npk: fOf(o.npk), rho: fOf(o.rho) });
  const padTo = (xs, n) => [...xs, ...Array(n - xs.length).fill(null)];

  // ── T_BTC_SHIELD (§3) ──
  // inputs: [{ txid (display hex), vout, value, blinding, Cx, Cy }], the transparent notes at the carrier's
  // vin[1..n_in]. outputs: [{ address, value }] summing to their total, default one note of the total to
  // recipientAddress. Returns the body, the kernel signature and the circuit witness; prove with a proof
  // system and assembleShield(built, wire).
  function buildShieldEnvelope({ asset, inputs, recipientAddress, outputs = null, network, rPool, rBjj, e, aux, seedKey }) {
    if (!inputs || inputs.length < 1 || inputs.length > BTC_POOL_SHIELD_MAX_IN) throw new Error('btc-pool: shield n_in must be 1..8');
    const outpoints = new Set(inputs.map((i) => `${hx(toBytes(i.txid, 32))}:${checkU32(i.vout, 'vout')}`));
    if (outpoints.size !== inputs.length) throw new Error('btc-pool: repeated shield input');
    let total = 0n, rIn = 0n, Cin = ZERO;
    for (const i of inputs) {
      const v = BigInt(i.value);
      if (v < 0n || v > U64_MAX) throw new Error('btc-pool: input value must be a u64');
      const Ci = pointFromXY(i.Cx ?? i.cx, i.Cy ?? i.cy);
      if (!commitPoint(v, BigInt(i.blinding)).equals(Ci)) throw new Error(`btc-pool: input ${i.txid}:${i.vout} opening does not match its commitment`);
      total += v; rIn = modN(rIn + BigInt(i.blinding)); Cin = Cin.add(Ci);
    }
    if (total > U64_MAX) throw new Error('btc-pool: shielded total exceeds u64');
    const assetHex = assetHexOf(asset);
    const outs = outputs ?? [{ address: recipientAddress, value: total }];
    if (!outs.length || outs.length > BTC_POOL_MAX_OUT) throw new Error('btc-pool: shield n_out must be 1..3');
    if (outs.reduce((t, o) => t + BigInt(o.value), 0n) !== total) throw new Error('btc-pool: shield outputs must sum to the shielded total');
    const notes = outs.map((o, j) => createNote(o.address, assetHex, BigInt(o.value), { e: j === 0 ? e : undefined, network: o.network ?? network }));

    let r = rPool != null ? modN(BigInt(rPool)) : randomScalar();
    while (r === rIn && rPool == null) r = randomScalar();
    const excess = modN(r - rIn);
    if (excess === 0n) throw new Error('btc-pool: kernel excess is zero');
    const rb = rBjj != null ? BigInt(rBjj) : randomBjj();
    const bd = proveBoundary({ v: total, rSecp: r, rBjj: rb, seedKey: seedKey ?? rand(32) });
    const boundary = encodeBoundary(bd);
    const body = concat(Uint8Array.of(T_BTC_SHIELD), toBytes(assetHex, 32), Uint8Array.of(inputs.length), Uint8Array.of(notes.length), ...notes.map(noteBytes), boundary);

    const E = pointFromCompressed(bd.cSecp).add(Cin.negate());
    if (!E.equals(G.multiply(excess))) throw new Error('btc-pool: kernel excess mismatch');
    const msg = shieldKernelMsg(body, inputs);
    const kernelSig = schnorrSign(msg, excess, aux);

    const bh = bodyHash(body);
    const witness = zk.buildWitness({
      root: 0n, bodyHash: bh, assetF: assetField(toBytes(assetHex, 32)),
      inputs: padTo([], ZK_N_IN), outputs: padTo(notes.map(witnessOutput), ZK_N_OUT), dep: { v: total, r: rb },
    });
    const note = notes[0];
    return {
      body, bodyHex: hx(body), kernelSig: hx(kernelSig), kernelMsg: hx(msg), excessX: hx(xOnly(E)),
      notes, note, total, rPool: hx(be(r, 32)), boundary: hx(boundary), witness,
    };
  }
  // SHA-256(domain ‖ (txid ‖ vout_LE) × n_in ‖ body).
  function shieldKernelMsg(body, inputs) {
    const parts = [D.shield];
    for (const i of inputs) parts.push(reverse(toBytes(i.txid, 32)), le(checkU32(i.vout, 'vout'), 4));
    parts.push(toBytes(body));
    return sha256(concat(...parts));
  }
  function assembleShield(built, proof) {
    const pf = toBytes(proof);
    if (pf.length > BTC_POOL_MAX_PROOF) throw new Error('btc-pool: proof too long');
    const out = concat(toBytes(built.body ?? built.bodyHex), toBytes(built.kernelSig, KERNEL_SIG_LEN), le(pf.length, 2), pf);
    parseShield(out);
    return out;
  }
  // Independent check of a shield's kernel: E = C_pool − ΣC_in, BIP-340 under x(E).
  function verifyShieldKernel(bytes, inputs) {
    try {
      const env = parseShield(bytes);
      if (inputs.length !== env.nIn) return false;
      let E = pointFromCompressed(env.cSecp);
      for (const i of inputs) E = E.add(pointFromXY(i.Cx ?? i.cx, i.Cy ?? i.cy).negate());
      if (E.equals(ZERO)) return false;
      return schnorrVerify(env.kernelSig, shieldKernelMsg(env.body, inputs), xOnly(E));
    } catch { return false; }
  }

  // ── T_BTC_SPEND (§3, §4) ──
  // inputs: owned notes from scan() with leafIndex and path (32 siblings, as served at hAnchor). outputs:
  // [{ address, value }] pool notes (payment, fee). exit: { exitVout, scriptPubKey | destSpkHash, value? }.
  // Outputs plus exit must equal the inputs. bind: { txid, vout } the carrier must spend (a relayer's quoted
  // UTXO), default none. want: { vout, value, scriptPubKey | spkHash }, sats the carrier must pay, default none.
  // hAnchor defaults to defaultAnchor(tip). With `wallet`: change of a pay goes to its internal address and a
  // pay is padded to 3 outputs with zero-value internal notes (pad: false disables padding), outputs are
  // shuffled, and an exit to a script in `usedScripts` (default wallet.usedScripts) is refused; a Set is
  // updated with the new exit script's hash. Returns the body and the circuit witness (with `root`).
  function buildSpendBody({ asset, hAnchor, tip, root, inputs, outputs = [], exit = null, bind = null, want = null, wallet, network, usedScripts, pad = true }) {
    const anchor = hAnchor != null ? hAnchor : tip != null ? defaultAnchor(tip) : null;
    if (anchor == null) throw new Error('btc-pool: h_anchor or tip required');
    checkU32(anchor, 'h_anchor');
    const net = network ?? wallet?.network;
    if (!inputs || !inputs.length || inputs.length > BTC_POOL_MAX_IN) throw new Error('btc-pool: n_in must be 1..2');
    const assetHex = assetHexOf(asset);
    let total = 0n;
    for (const i of inputs) {
      if (i.asset && assetHexOf(i.asset) !== assetHex) throw new Error('btc-pool: input asset mismatch');
      if (!i.skNote || !i.nkNote) throw new Error('btc-pool: input is not a spendable owned note');
      if (i.leafIndex == null) throw new Error('btc-pool: input needs its leafIndex');
      total += BigInt(i.value);
    }
    const nullifiers = inputs.map((i) => nullifier(i.nkNote, i.leaf, i.leafIndex));
    if (new Set(nullifiers).size !== nullifiers.length) throw new Error('btc-pool: repeated input');
    bindBytes(bind);
    const wantRec = normalizeWant(want);
    const outs = outputs.map((o) => ({ ...o }));
    let outSum = outs.reduce((s, o) => s + BigInt(o.value), 0n);
    let exitRec = null, spkHex = null;
    if (exit) {
      checkU32(exit.exitVout, 'exit_vout');
      spkHex = exit.scriptPubKey != null ? spkKey(exit.scriptPubKey) : null;
      const destSpkHash = spkHex != null ? exitDestHash(spkHex) : hx(toBytes(exit.destSpkHash, 32));
      if (spkHex != null && exit.destSpkHash != null && hx(toBytes(exit.destSpkHash, 32)) !== destSpkHash) throw new Error('btc-pool: destSpkHash does not match scriptPubKey');
      if (usedHas(usedScripts ?? wallet?.usedScripts, spkHex, destSpkHash)) throw new Error('btc-pool: exit script already used by this wallet');
      const value = exit.value != null ? BigInt(exit.value) : total - outSum;
      if (value < 0n || value > U64_MAX) throw new Error('btc-pool: exit value out of range');
      exitRec = { exitVout: exit.exitVout, destSpkHash, value };
    }
    if (wallet != null && !exitRec) {
      if (wallet.internalAddress == null) throw new Error('btc-pool: wallet has no internal address');
      const self = { address: wallet.internalAddress, network: wallet.network };
      if (outSum < total) { outs.push({ ...self, value: total - outSum }); outSum = total; }
      if (pad) while (outs.length < BTC_POOL_MAX_OUT) outs.push({ ...self, value: 0n });
      shuffle(outs);
    }
    if (outSum + (exitRec ? exitRec.value : 0n) !== total) throw new Error(`btc-pool: outputs ${outSum} + exit ${exitRec ? exitRec.value : 0n} != inputs ${total}`);
    const nk0 = inputs[0].nkNote, nf0 = nullifiers[0];
    const outNotes = outs.map((o, j) => createNote(o.address, assetHex, BigInt(o.value), { e: o.e ?? outputEph(nk0, nf0, j), network: o.network ?? net }));
    if (exitRec) {
      const { rSecp, rBjj } = exitOpenings(nk0, nf0, exitRec.exitVout, exitRec.destSpkHash);
      const r = exit.blinding != null ? modN(BigInt(exit.blinding)) : rSecp;
      const bd = proveBoundary({ v: exitRec.value, rSecp: r, rBjj, seedKey: toBytes(nk0, 32) });
      Object.assign(exitRec, commitXY(exitRec.value, r), { blinding: hx(be(r, 32)), rBjj: f32(rBjj), boundary: hx(encodeBoundary(bd)), cSecp: hx(bd.cSecp) });
    }
    const body = encodeSpendBody({ asset: assetHex, hAnchor: anchor, bind, nullifiers, outputs: outNotes, exit: exitRec, want: wantRec });

    let witness = null;
    if (root != null && inputs.every((i) => Array.isArray(i.path) && i.path.length === BTC_POOL_TREE_DEPTH)) {
      const rootF = fOf(root);
      for (const i of inputs) {
        if (zk.rootFromPath(fOf(i.leaf), i.leafIndex, i.path.map(fOf)) !== rootF) throw new Error(`btc-pool: path for leaf ${i.leafIndex} does not reach root`);
      }
      const bh = bodyHash(body);
      const ins = inputs.map((i) => {
        const sk = fOf(i.skNote);
        return { v: BigInt(i.value), rho: fOf(i.rho), nk: fOf(i.nkNote), Ak: i.ak ? i.ak.map(fOf) : mulB8(sk), index: BigInt(i.leafIndex), path: i.path.map(fOf), sig: zk.sign(sk, bh) };
      });
      witness = zk.buildWitness({
        root: rootF, bodyHash: bh, assetF: assetField(toBytes(assetHex, 32)),
        inputs: padTo(ins, ZK_N_IN), outputs: padTo(outNotes.map(witnessOutput), ZK_N_OUT),
        exit: exitRec ? { v: exitRec.value, r: fOf(exitRec.rBjj) } : null,
      });
      const exitC = exitRec ? pedersenBJJ(exitRec.value, fOf(exitRec.rBjj)) : null;
      const expect = spendPublics({ root: rootF, body, asset: toBytes(assetHex, 32), nullifiers: nullifiers.map(fOf), outLeaves: outNotes.map((o) => fOf(o.leaf)), exitC });
      if (expect.join() !== witness.publicSignals.join()) throw new Error('btc-pool: witness publics do not match the body');
    }
    const used = usedScripts ?? wallet?.usedScripts;
    if (exitRec && used instanceof Set) used.add(exitRec.destSpkHash);
    return { body, bodyHex: hx(body), nullifiers, hAnchor: anchor, bind: bind ?? null, outputs: outNotes, exit: exitRec, want: wantRec, witness, root: root != null ? f32(fOf(root)) : null };
  }

  function assembleSpendEnvelope(body, proof) {
    const b = toBytes(body), pf = toBytes(proof);
    if (pf.length > BTC_POOL_MAX_PROOF) throw new Error(`btc-pool: proof is ${pf.length} bytes, max ${BTC_POOL_MAX_PROOF}`);
    const out = concat(b, le(pf.length, 2), pf);
    parseSpend(out, { full: true });
    return out;
  }

  // Proves a built shield or spend with `system` and returns the full envelope. The proof's public signals
  // must equal the ones the indexer derives from the body.
  async function prove(built, system, { onProgress } = {}) {
    if (!built.witness) throw new Error('btc-pool: no witness (root and paths are needed to prove a spend)');
    const { wire, publicSignals } = await system.prove(built.witness.input, { onProgress });
    if (publicSignals.join() !== built.witness.publicSignals.join()) throw new Error('btc-pool: proof publics differ from the witness');
    const payload = built.kernelSig ? assembleShield(built, wire) : assembleSpendEnvelope(built.body, wire);
    const { publics } = payloadPublics(payload, { root: built.root });
    if (publics.join() !== publicSignals.join()) throw new Error('btc-pool: envelope publics differ from the proof');
    return { payload, payloadHex: hx(payload), proof: wire };
  }

  // Rebuilds the exit opening of a spend this wallet signed, from the payload (or body), the wallet and its
  // scanned notes (the inputs, with nf). Outputs the wallet receives are read by scanning; another recipient's
  // output is read when its address is in `addresses`. Any remaining third-party value is found by search up to
  // `maxSearch`.
  function recoverExit(wallet, bytes, ownNotes, { addresses = [], maxSearch = 1 << 16 } = {}) {
    let sp;
    try { sp = parseSpend(bytes); } catch { sp = parseSpend(bytes, { full: true }); }
    if (!sp.exit) throw new Error('btc-pool: spend has no exit');
    const byNf = new Map(ownNotes.filter((x) => x && x.nf).map((x) => [x.nf.toLowerCase(), x]));
    const ins = sp.nullifiers.map((nf) => byNf.get(nf.toLowerCase()));
    if (ins.some((x) => !x || !x.nkNote)) throw new Error('btc-pool: spend inputs are not among the wallet\'s notes');
    const nk0 = ins[0].nkNote, nf0 = sp.nullifiers[0];
    const { rSecp } = exitOpenings(nk0, nf0, sp.exit.exitVout, sp.exit.destSpkHash);
    const cands = addresses.map((a) => decodeAddress(a, wallet.network));
    let known = ins.reduce((t, x) => t + BigInt(x.value), 0n), unknown = 0;
    sp.outputs.forEach((o, j) => {
      const own = tryReceive(wallet, o);
      if (own) { known -= own.value; return; }
      const e = outputEph(nk0, nf0, j);
      for (const c of cands) {
        const pt = aeadOpen(aeadKey(compress(c.V.multiply(e))), toBytes(o.ctNote, CT_NOTE_LEN));
        if (pt) { known -= bToBig(pt); return; }
      }
      unknown++;
    });
    if (known < 0n) throw new Error('btc-pool: outputs exceed inputs');
    const target = pointFromXY(sp.exit.cx, sp.exit.cy).add(mul(G, rSecp).negate());
    const negH = H.negate();
    let T = mul(H, known);
    const limit = unknown ? BigInt(maxSearch) : 0n;
    for (let s = 0n; s <= limit && s <= known; s++, T = T.add(negH)) {
      if (T.equals(target)) return { exitVout: sp.exit.exitVout, value: known - s, blinding: hx(be(rSecp, 32)), cx: sp.exit.cx, cy: sp.exit.cy, destSpkHash: sp.exit.destSpkHash };
    }
    throw new Error('btc-pool: exit opening not recovered');
  }

  const merkleRootFrom = (leaf, index, path) => f32(zk.rootFromPath(fOf(leaf), Number(index), path.map(fOf)));

  return {
    H, G, commitXY, Hs, defaultAnchor, zk,
    walletFromSeed, walletFromScalars, viewWallet, fullViewWallet, encodeAddress, decodeAddress,
    selectInputs, deriveExitKey, freshExitKey, recoverExit,
    createNote, nullifier, tryReceive, scan,
    shieldKernelMsg, buildShieldEnvelope, assembleShield, parseShield, verifyShieldKernel,
    encodeSpendBody, parseSpend, buildSpendBody, assembleSpendEnvelope, exitDestHash, merkleRootFrom,
    payloadPublics, verifyPayload, prove,
    schnorrSign, schnorrVerify,
    _aead: { seal: aeadSeal, open: aeadOpen, keystream, key: aeadKey },
  };
}
