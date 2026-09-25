// Bitcoin-native shielded pool: wallet side of DESIGN-btc-shielded-pool.md §2–§4.
// Keys and addresses, note creation and scanning, the T_BTC_SHIELD envelope with its kernel, and the
// T_BTC_SPEND body, spend signatures and prover witness.
//
// Address strings are bech32m over the 99-byte (V ‖ A ‖ N), HRP "bp" on mainnet and "tbp" on signet.
// Wallet keys are derived per network, so one seed's signet and mainnet addresses are unlinkable. Change and
// padding go to an internal address (V_int ‖ A ‖ N); v alone does not see them, (v, v_int, n) does.

export const T_BTC_SHIELD = 0x6c;
export const T_BTC_SPEND = 0x6d;
export const BTC_POOL_SHIELD_MAX_IN = 8;
export const BTC_POOL_MAX_IN = 2;
export const BTC_POOL_MAX_OUT = 3;
export const EXIT_LEN = 100; // exit_vout ‖ Cx ‖ Cy ‖ dest_spk_hash
export const BIND_LEN = 36; // txid ‖ vout, all zero for none
export const WANT_LEN = 44; // vout ‖ value ‖ spk_hash
export const BTC_POOL_MAX_PROOF = 512;
export const BTC_POOL_TREE_DEPTH = 32;
export const SHIELD_ENVELOPE_LEN = 316;
export const POOL_NOTE_LEN = 218; // Cx ‖ Cy ‖ spend_key ‖ nk_pub ‖ pk_eph ‖ ct_note
export const CT_NOTE_LEN = 56;
export const ADDRESS_LEN = 99;
export const ADDRESS_HRP = { mainnet: 'bp', signet: 'tbp' };

const U64_MAX = (1n << 64n) - 1n;
const U32_LIMIT = 2 ** 32;
export const ANCHOR_STEP = 6;

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
    auth: te.encode('tacit-btc-pool-auth-tweak-v1'),
    nk: te.encode('tacit-btc-pool-nk-tweak-v1'),
    aead: te.encode('tacit-btc-pool-aead-v1'),
    tag: te.encode('tacit-btc-pool-aead-tag-v1'),
    note: te.encode('tacit-btc-pool-note-v1'),
    nf: te.encode('tacit-btc-pool-nf-v1'),
    shield: te.encode('tacit-btc-pool-shield-v1'),
    spend: te.encode('tacit-btc-pool-spend-v1'),
    keyV: te.encode('tacit-btc-pool-wallet-view-v1'),
    keyA: te.encode('tacit-btc-pool-wallet-spend-v1'),
    keyN: te.encode('tacit-btc-pool-wallet-nk-v1'),
    keyVInt: te.encode('tacit-btc-pool-wallet-view-internal-v1'),
    keyX: te.encode('tacit-btc-pool-wallet-exit-v1'),
    exitKey: te.encode('tacit-btc-pool-exit-key-v1'),
    exitBlind: te.encode('tacit-btc-pool-exit-v1'),
    eph: te.encode('tacit-btc-pool-eph-v1'),
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

  // ── curve ──
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

  // Hs(x): keccak(x) as a big-endian integer mod n, rejected if zero.
  function Hs(...parts) {
    const s = modN(bToBig(k(...parts)));
    if (s === 0n) throw new Error('btc-pool: Hs reduced to zero');
    return s;
  }
  const randomScalar = () => { for (;;) { const s = modN(bToBig(rand(32))); if (s !== 0n) return s; } };

  // ── BIP-340 ──
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

  // ── bech32m (no length cap: a 99-byte address exceeds BIP-173's 90-char limit) ──
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

  // Every scalar is bound to the network, so one seed yields unlinkable signet and mainnet wallets.
  function walletFromSeed(seed, network = 'signet') {
    const sd = toBytes(seed, 32);
    const net = te.encode(checkNetwork(network));
    const v = Hs(D.keyV, net, sd), a = Hs(D.keyA, net, sd), n = Hs(D.keyN, net, sd);
    const vInt = Hs(D.keyVInt, net, sd);
    const exitRoot = k(D.keyX, net, sd);
    return walletFromScalars({ v, a, n, vInt, exitRoot }, network);
  }
  // vInt and exitRoot are optional: without vInt the wallet has no internal address, without exitRoot no exit keys.
  function walletFromScalars({ v, a, n, vInt, exitRoot }, network = 'signet') {
    checkNetwork(network);
    const V = G.multiply(BigInt(v)), A = G.multiply(BigInt(a)), Nk = G.multiply(BigInt(n));
    const address = concat(compress(V), compress(A), compress(Nk));
    const w = {
      network,
      v: hx(be(v, 32)), a: hx(be(a, 32)), n: hx(be(n, 32)),
      V: hx(compress(V)), A: hx(compress(A)), N: hx(compress(Nk)),
      address: hx(address), addressString: encodeAddress(address, network),
    };
    if (vInt != null) {
      const VInt = G.multiply(BigInt(vInt));
      w.vInt = hx(be(vInt, 32));
      w.VInt = hx(compress(VInt));
      w.internalAddress = hx(concat(compress(VInt), compress(A), compress(Nk)));
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
  // A raw 99-byte address carries no network, so it is accepted only with an explicit one.
  function decodeAddress(input, network) {
    if (network != null) checkNetwork(network);
    let bytes, net = network;
    if (typeof input === 'string' && !/^(0x)?[0-9a-f]{198}$/i.test(input)) {
      const d = bech32mDecode(input);
      net = Object.keys(ADDRESS_HRP).find((key) => ADDRESS_HRP[key] === d.hrp);
      if (!net) throw new Error(`btc-pool: unknown address prefix ${d.hrp}`);
      if (network && network !== net) throw new Error(`btc-pool: address is for ${net}, expected ${network}`);
      bytes = d.bytes;
    } else {
      if (network == null) throw new Error('btc-pool: raw address needs an explicit network');
      bytes = toBytes(input, ADDRESS_LEN);
    }
    if (bytes.length !== ADDRESS_LEN) throw new Error('btc-pool: address must be 99 bytes');
    const V = pointFromCompressed(bytes.slice(0, 33));
    const A = pointFromCompressed(bytes.slice(33, 66));
    const Nk = pointFromCompressed(bytes.slice(66, 99));
    return { V, A, N: Nk, bytes, network: net };
  }

  // ── §2 note construction ──
  function tweaks(sBytes) {
    return { ta: Hs(D.auth, sBytes), tn: Hs(D.nk, sBytes), key: k(D.aead, sBytes) };
  }
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
    const ct = sealed.subarray(0, 40);
    if (!eqBytes(sealed.subarray(40, 56), k(D.tag, key, ct).slice(0, 16))) return null;
    const ks = keystream(key, 40);
    return ct.map((b, i) => b ^ ks[i]);
  }

  function noteLeaf(asset, cx, cy, spendKey, nkPub) {
    return hx(k(toBytes(asset, 32), toBytes(cx, 32), toBytes(cy, 32), toBytes(spendKey, 32), toBytes(nkPub, 33), D.note));
  }
  // nf = keccak(domain ‖ leaf ‖ nk_note(32 BE) ‖ leaf_index(8 BE)): byte-identical leaves at different
  // positions are distinct notes and must be independently spendable.
  function nullifier(leaf, nkNote, leafIndex) {
    const nk = toBytes(nkNote, 32);
    const x = bToBig(nk);
    if (x === 0n || x >= N) throw new Error('btc-pool: nk_note out of range');
    if (leafIndex == null) throw new Error('btc-pool: nullifier needs the note\'s leaf_index');
    const idx = BigInt(leafIndex);
    if (idx < 0n || idx >= (1n << 32n)) throw new Error('btc-pool: leaf_index out of range');
    return hx(k(D.nf, toBytes(leaf, 32), nk, be(idx, 8)));
  }

  // opts.e pins the otherwise fresh ephemeral scalar (tests and vectors). opts.network is required for a raw
  // address and, when given, must match a bech32m one.
  function createNote(address, asset, value, blinding, opts = {}) {
    const addr = decodeAddress(address, opts.network);
    const v = BigInt(value);
    if (v < 0n || v > U64_MAX) throw new Error('btc-pool: value must be a u64');
    const r = blinding != null ? modN(BigInt(blinding)) : randomScalar();
    const e = opts.e != null ? modN(BigInt(opts.e)) : randomScalar();
    if (e === 0n) throw new Error('btc-pool: zero ephemeral scalar');
    const s = compress(addr.V.multiply(e));
    const { ta, tn, key } = tweaks(s);
    const P = addr.A.add(G.multiply(ta));
    const NK = addr.N.add(G.multiply(tn));
    if (P.equals(ZERO) || NK.equals(ZERO)) throw new Error('btc-pool: degenerate note key');
    const { cx, cy } = commitXY(v, r);
    const spendKey = hx(xOnly(P));
    const nkPub = hx(compress(NK));
    const pkEph = hx(compress(G.multiply(e)));
    const ctNote = hx(aeadSeal(key, concat(be(v, 8), be(r, 32))));
    const assetHex = hx(toBytes(asset, 32));
    return {
      asset: assetHex, cx, cy, spendKey, nkPub, pkEph, ctNote,
      leaf: noteLeaf(assetHex, cx, cy, spendKey, nkPub),
      value: v, blinding: hx(be(r, 32)),
    };
  }

  function noteBytes(note) {
    return concat(toBytes(note.cx, 32), toBytes(note.cy, 32), toBytes(note.spendKey, 32), toBytes(note.nkPub, 33), toBytes(note.pkEph, 33), toBytes(note.ctNote, CT_NOTE_LEN));
  }
  function parseNoteBytes(b, asset) {
    const f = { cx: hx(b.slice(0, 32)), cy: hx(b.slice(32, 64)), spendKey: hx(b.slice(64, 96)), nkPub: hx(b.slice(96, 129)), pkEph: hx(b.slice(129, 162)), ctNote: hx(b.slice(162, 218)) };
    if (asset != null) { f.asset = hx(toBytes(asset, 32)); f.leaf = noteLeaf(f.asset, f.cx, f.cy, f.spendKey, f.nkPub); }
    return f;
  }

  // Receipt (§2): decrypts, the opening matches (Cx, Cy), spend_key and nk_pub are the ones (A, N, s) give.
  // v alone yields value and blinding; n adds nk_note, and nf once the note's leafIndex is known; a adds sk_spend.
  // A wallet holding v_int also receives notes paid to its internal address; those carry internal: true.
  function tryReceive(wallet, f) {
    const got = receiveUnder(wallet, wallet.v, f);
    if (got || wallet.vInt == null) return got;
    const own = receiveUnder(wallet, wallet.vInt, f);
    if (own) own.internal = true;
    return own;
  }
  function receiveUnder(wallet, viewKey, f) {
    try {
      const vScalar = bToBig(toBytes(viewKey, 32));
      const A = pointFromCompressed(wallet.A), Nk = pointFromCompressed(wallet.N);
      const E = pointFromCompressed(f.pkEph);
      const s = compress(E.multiply(vScalar));
      const { ta, tn, key } = tweaks(s);
      const pt = aeadOpen(key, toBytes(f.ctNote));
      if (!pt) return null;
      const value = bToBig(pt.subarray(0, 8));
      const r = bToBig(pt.subarray(8, 40));
      if (r >= N) return null;
      const C = pointFromXY(f.cx, f.cy);
      if (!commitPoint(value, r).equals(C)) return null;
      const P = A.add(G.multiply(ta));
      const NK = Nk.add(G.multiply(tn));
      if (P.equals(ZERO) || NK.equals(ZERO)) return null;
      if (!eqBytes(xOnly(P), toBytes(f.spendKey, 32))) return null;
      if (!eqBytes(compress(NK), toBytes(f.nkPub, 33))) return null;
      const asset = hx(toBytes(f.asset, 32));
      const leaf = noteLeaf(asset, f.cx, f.cy, f.spendKey, f.nkPub);
      if (f.leaf != null && !eqBytes(toBytes(f.leaf, 32), toBytes(leaf, 32))) return null;
      const out = {
        asset, cx: hx(toBytes(f.cx, 32)), cy: hx(toBytes(f.cy, 32)), spendKey: hx(toBytes(f.spendKey, 32)),
        nkPub: hx(toBytes(f.nkPub, 33)), pkEph: hx(toBytes(f.pkEph, 33)), ctNote: hx(toBytes(f.ctNote, CT_NOTE_LEN)),
        leaf, value, blinding: hx(be(r, 32)),
      };
      if (f.leafIndex != null) out.leafIndex = Number(f.leafIndex);
      if (wallet.n != null) {
        const nk = modN(bToBig(toBytes(wallet.n, 32)) + tn);
        if (nk === 0n) return null;
        out.nkNote = hx(be(nk, 32));
        if (out.leafIndex != null) out.nf = nullifier(leaf, out.nkNote, out.leafIndex);
      }
      if (wallet.a != null) {
        const sk = modN(bToBig(toBytes(wallet.a, 32)) + ta);
        if (sk === 0n) return null;
        out.skSpend = hx(be(sk, 32));
      }
      return out;
    } catch { return null; }
  }
  const scan = (wallet, notes) => notes.map((f) => tryReceive(wallet, f)).filter(Boolean);

  // ── T_BTC_SHIELD (§3) ──
  function shieldKernelMsg({ asset, inputs, note }) {
    const parts = [D.shield, toBytes(asset, 32), Uint8Array.of(inputs.length)];
    for (const i of inputs) parts.push(reverse(toBytes(i.txid, 32)), le(checkU32(i.vout, 'vout'), 4));
    parts.push(toBytes(note.cx, 32), toBytes(note.cy, 32), toBytes(note.spendKey, 32), toBytes(note.nkPub, 33), toBytes(note.pkEph, 33), toBytes(note.ctNote, CT_NOTE_LEN));
    return sha256(concat(...parts));
  }

  // inputs[i].txid is the display (RPC) txid; the kernel message carries it byte-reversed, as T_CXFER's does.
  function buildShieldEnvelope({ asset, inputs, recipientAddress, network, rPool, e, aux }) {
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
    let r = rPool != null ? modN(BigInt(rPool)) : randomScalar();
    while (r === rIn && rPool == null) r = randomScalar();
    const excess = modN(r - rIn);
    if (excess === 0n) throw new Error('btc-pool: kernel excess is zero');
    const note = createNote(recipientAddress, asset, total, r, { e, network });
    const E = pointFromXY(note.cx, note.cy).add(Cin.negate());
    if (!E.equals(G.multiply(excess))) throw new Error('btc-pool: kernel excess mismatch');
    const msg = shieldKernelMsg({ asset, inputs, note });
    const kernelSig = schnorrSign(msg, excess, aux);
    const payload = concat(Uint8Array.of(T_BTC_SHIELD), toBytes(asset, 32), Uint8Array.of(inputs.length), noteBytes(note), kernelSig);
    if (payload.length !== SHIELD_ENVELOPE_LEN) throw new Error(`btc-pool: shield envelope is ${payload.length} bytes`);
    return { payload, payloadHex: hx(payload), note, kernelSig: hx(kernelSig), kernelMsg: hx(msg), excessX: hx(xOnly(E)) };
  }

  function parseShieldEnvelope(bytes) {
    const b = toBytes(bytes);
    if (b.length !== SHIELD_ENVELOPE_LEN || b[0] !== T_BTC_SHIELD) throw new Error('btc-pool: not a shield envelope');
    const nIn = b[33];
    if (nIn < 1 || nIn > BTC_POOL_SHIELD_MAX_IN) throw new Error('btc-pool: shield n_in out of range');
    const asset = hx(b.slice(1, 33));
    const note = parseNoteBytes(b.slice(34, 34 + POOL_NOTE_LEN), asset);
    return { asset, nIn, note, kernelSig: hx(b.slice(34 + POOL_NOTE_LEN)) };
  }

  // Independent check of a shield: E = C_pool − ΣC_in, BIP-340 under x(E).
  function verifyShield(bytes, inputs) {
    try {
      const env = parseShieldEnvelope(bytes);
      if (inputs.length !== env.nIn) return false;
      let E = pointFromXY(env.note.cx, env.note.cy);
      for (const i of inputs) E = E.add(pointFromXY(i.Cx ?? i.cx, i.Cy ?? i.cy).negate());
      if (E.equals(ZERO)) return false;
      return schnorrVerify(env.kernelSig, shieldKernelMsg({ asset: env.asset, inputs, note: env.note }), xOnly(E));
    } catch { return false; }
  }

  // ── T_BTC_SPEND (§3, §4) ──
  function merkleRootFrom(leaf, index, path) {
    if (path.length !== BTC_POOL_TREE_DEPTH) throw new Error('btc-pool: path must have 32 entries');
    let h = toBytes(leaf, 32), i = BigInt(index);
    for (const sib of path) { const s = toBytes(sib, 32); h = (i & 1n) === 0n ? k(h, s) : k(s, h); i >>= 1n; }
    return hx(h);
  }
  const exitDestHash = (scriptPubKey) => hx(sha256(toBytes(scriptPubKey)));
  const spendMsg = (body) => hx(k(D.spend, toBytes(body)));

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
    if (exit) parts.push(le(exit.exitVout, 4), toBytes(exit.cx, 32), toBytes(exit.cy, 32), toBytes(exit.destSpkHash, 32));
    parts.push(Uint8Array.of(w ? 1 : 0));
    if (w) parts.push(le(w.vout, 4), le(w.value, 8), toBytes(w.spkHash, 32));
    return concat(...parts);
  }

  // Parses either a bare body or a full payload; rejects anything non-canonical (§3).
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
    for (let i = 0; i < nIn; i++) nullifiers.push(hx(take(32)));
    if (new Set(nullifiers).size !== nIn) throw new Error('btc-pool: repeated nullifier');
    const nOut = take(1)[0];
    if (nOut > BTC_POOL_MAX_OUT) throw new Error('btc-pool: n_out out of range');
    const out = { asset, hAnchor, bind, nullifiers, outputs: [], exit: null, want: null };
    for (let j = 0; j < nOut; j++) {
      const f = parseNoteBytes(take(POOL_NOTE_LEN), asset);
      pointFromXY(f.cx, f.cy); liftX(f.spendKey); pointFromCompressed(f.nkPub); pointFromCompressed(f.pkEph);
      out.outputs.push(f);
    }
    const hasExit = take(1)[0];
    if (hasExit > 1) throw new Error('btc-pool: has_exit must be 0 or 1');
    if (hasExit) {
      out.exit = { exitVout: Number(leToBig(take(4))), cx: hx(take(32)), cy: hx(take(32)), destSpkHash: hx(take(32)) };
      pointFromXY(out.exit.cx, out.exit.cy);
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

  const spkKey = (spk) => hx(toBytes(spk)).toLowerCase();
  const usedHas = (used, spkHex, hashHex) => {
    if (!used) return false;
    const list = used instanceof Set ? used : new Set([...used].map((x) => hx(toBytes(x)).toLowerCase()));
    return (spkHex != null && list.has(spkHex)) || list.has(hashHex);
  };

  // Seed-recoverable randomness of a spend, keyed by the first input's nk_note (secret) and bound to public
  // body data, so a wallet can rebuild the exit opening from chain data and its seed.
  //   e_j    = Hs("tacit-btc-pool-eph-v1"  ‖ nk_note_0 ‖ nf_0 ‖ j(1) ‖ Cx_j ‖ Cy_j)
  //   r_exit = Hs("tacit-btc-pool-exit-v1" ‖ nk_note_0 ‖ body with the exit's Cx, Cy zeroed)
  const ZERO32 = new Uint8Array(32);
  const outputEph = (nk0, nf0, j, C) => Hs(D.eph, toBytes(nk0, 32), toBytes(nf0, 32), Uint8Array.of(j), toBytes(C.cx, 32), toBytes(C.cy, 32));
  const exitBlinding = (nk0, bodyZeroedExitC) => Hs(D.exitBlind, toBytes(nk0, 32), toBytes(bodyZeroedExitC));

  // Rebuilds the exit opening of a spend this wallet signed, from the body (or full payload), the wallet and
  // its scanned notes (the inputs, with nf). Outputs the wallet receives are read by scanning; another
  // recipient's output is read when its address is in `addresses`. Any remaining third-party value is found
  // by search up to `maxSearch`.
  function recoverExit(wallet, bytes, ownNotes, { addresses = [], maxSearch = 1 << 16 } = {}) {
    let sp;
    try { sp = parseSpend(bytes); } catch { sp = parseSpend(bytes, { full: true }); }
    if (!sp.exit) throw new Error('btc-pool: spend has no exit');
    const byNf = new Map(ownNotes.filter((x) => x && x.nf).map((x) => [x.nf.toLowerCase(), x]));
    const ins = sp.nullifiers.map((nf) => byNf.get(nf.toLowerCase()));
    if (ins.some((x) => !x || !x.nkNote)) throw new Error('btc-pool: spend inputs are not among the wallet\'s notes');
    const nk0 = ins[0].nkNote, nf0 = sp.nullifiers[0];
    const zeroed = Uint8Array.from(sp.body);
    const exitEnd = zeroed.length - 1 - (sp.want ? WANT_LEN : 0);
    zeroed.fill(0, exitEnd - 96, exitEnd - 32);
    const r = exitBlinding(nk0, zeroed);
    const cands = addresses.map((a) => decodeAddress(a, wallet.network));
    let known = ins.reduce((t, x) => t + BigInt(x.value), 0n), unknown = 0;
    sp.outputs.forEach((o, j) => {
      const own = tryReceive(wallet, o);
      if (own) { known -= own.value; return; }
      const e = outputEph(nk0, nf0, j, o);
      for (const c of cands) {
        const pt = aeadOpen(tweaks(compress(c.V.multiply(e))).key, toBytes(o.ctNote, CT_NOTE_LEN));
        if (!pt) continue;
        const v = bToBig(pt.subarray(0, 8)), rr = bToBig(pt.subarray(8, 40));
        if (rr < N && commitPoint(v, rr).equals(pointFromXY(o.cx, o.cy))) { known -= v; return; }
      }
      unknown++;
    });
    if (known < 0n) throw new Error('btc-pool: outputs exceed inputs');
    const target = pointFromXY(sp.exit.cx, sp.exit.cy).add(mul(G, r).negate());
    const negH = H.negate();
    let T = mul(H, known);
    const limit = unknown ? BigInt(maxSearch) : 0n;
    for (let s = 0n; s <= limit && s <= known; s++, T = T.add(negH)) {
      if (T.equals(target)) return { exitVout: sp.exit.exitVout, value: known - s, blinding: hx(be(r, 32)), cx: sp.exit.cx, cy: sp.exit.cy, destSpkHash: sp.exit.destSpkHash };
    }
    throw new Error('btc-pool: exit opening not recovered');
  }

  // Picks up to two inputs of `asset` covering `amount`. When one note covers it and another exists, the
  // smallest other note (a zero-value padding note when there is one) is added so the spend has 2 inputs;
  // a wallet holding a single note spends it alone.
  function selectInputs(notes, amount, { asset } = {}) {
    const want = BigInt(amount);
    if (want < 0n || want > U64_MAX) throw new Error('btc-pool: amount must be a u64');
    const assetHex = asset != null ? hx(toBytes(asset, 32)) : null;
    const seen = new Set();
    const pool = [];
    for (const x of notes) {
      if (!x || !x.skSpend || !x.nkNote || x.leafIndex == null) continue;
      if (assetHex && hx(toBytes(x.asset, 32)) !== assetHex) continue;
      const id = x.nf ?? nullifier(x.leaf, x.nkNote, x.leafIndex);
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
  // First exit key from `from` whose script is not in `used` (scripts or their SHA-256, hex).
  function freshExitKey(wallet, used, { type = 'p2tr', from = 0 } = {}) {
    for (let c = from; c < U32_LIMIT; c++) {
      const x = deriveExitKey(wallet, c, type);
      if (!usedHas(used, spkKey(x.scriptPubKey), x.destSpkHash)) return x;
    }
    throw new Error('btc-pool: exit keys exhausted');
  }

  // inputs: owned notes from scan(), each with leafIndex and, for the witness, path (32 siblings).
  // outputs: [{ address, value }] pool notes (payment, fee). exit: { exitVout, scriptPubKey | destSpkHash,
  // value?, blinding? }. Outputs plus exit must equal the inputs. bind: { txid, vout } the carrier must spend
  // (a relayer's quoted UTXO), default none. want: { vout, value, scriptPubKey | spkHash }, sats the carrier
  // must pay back, default none.
  // hAnchor defaults to defaultAnchor(tip). With `wallet`: change of a pay goes to its internal address and
  // a pay is padded to 3 outputs with zero-value internal notes (pad: false disables padding), outputs are
  // shuffled, and an exit to a script in `usedScripts` (default wallet.usedScripts) is refused; a Set is
  // updated with the new exit script's hash.
  function buildSpendBody({ asset, hAnchor, tip, root, inputs, outputs = [], exit = null, bind = null, want = null, aux, wallet, network, usedScripts, pad = true }) {
    const anchor = hAnchor != null ? hAnchor : tip != null ? defaultAnchor(tip) : null;
    if (anchor == null) throw new Error('btc-pool: h_anchor or tip required');
    checkU32(anchor, 'h_anchor');
    const net = network ?? wallet?.network;
    if (!inputs || !inputs.length || inputs.length > BTC_POOL_MAX_IN) throw new Error('btc-pool: n_in must be 1..2');
    const assetHex = hx(toBytes(asset, 32));
    let total = 0n;
    for (const i of inputs) {
      if (i.asset && hx(toBytes(i.asset, 32)) !== assetHex) throw new Error('btc-pool: input asset mismatch');
      if (!i.skSpend || !i.nkNote) throw new Error('btc-pool: input is not a spendable owned note');
      if (i.leafIndex == null) throw new Error('btc-pool: input needs its leafIndex');
      total += BigInt(i.value);
    }
    const nullifiers = inputs.map((i) => nullifier(i.leaf, i.nkNote, i.leafIndex));
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
    const defaults = wallet != null && !exitRec;
    if (defaults) {
      if (wallet.internalAddress == null) throw new Error('btc-pool: wallet has no internal address');
      const self = { address: wallet.internalAddress, network: wallet.network };
      if (outSum < total) { outs.push({ ...self, value: total - outSum }); outSum = total; }
      if (pad) while (outs.length < BTC_POOL_MAX_OUT) outs.push({ ...self, value: 0n });
      for (let i = outs.length - 1; i > 0; i--) { const j = Number(bToBig(rand(4)) % BigInt(i + 1)); [outs[i], outs[j]] = [outs[j], outs[i]]; }
    }
    if (outSum + (exitRec ? exitRec.value : 0n) !== total) throw new Error(`btc-pool: outputs ${outSum} + exit ${exitRec ? exitRec.value : 0n} != inputs ${total}`);
    const nk0 = inputs[0].nkNote, nf0 = nullifiers[0];
    const outNotes = outs.map((o, j) => {
      const r = o.blinding != null ? modN(BigInt(o.blinding)) : randomScalar();
      const e = o.e ?? outputEph(nk0, nf0, j, commitXY(BigInt(o.value), r));
      return createNote(o.address, assetHex, o.value, r, { e, network: o.network ?? net });
    });
    if (exitRec) {
      const r = exit.blinding != null ? modN(BigInt(exit.blinding)) : exitBlinding(nk0, encodeSpendBody({ asset: assetHex, hAnchor: anchor, bind, nullifiers, outputs: outNotes, exit: { ...exitRec, cx: ZERO32, cy: ZERO32 }, want: wantRec }));
      Object.assign(exitRec, commitXY(exitRec.value, r), { blinding: hx(be(r, 32)) });
    }
    const openings = [...outNotes, ...(exitRec ? [exitRec] : [])].map((o) => ({ value: o.value, blinding: o.blinding }));

    const body = encodeSpendBody({ asset: assetHex, hAnchor: anchor, bind, nullifiers, outputs: outNotes, exit: exitRec, want: wantRec });
    const msg = spendMsg(body);
    const sigs = inputs.map((i) => hx(schnorrSign(msg, bToBig(toBytes(i.skSpend, 32)), aux)));

    let witness = null;
    if (root != null && inputs.every((i) => Array.isArray(i.path) && i.leafIndex != null)) {
      for (const i of inputs) {
        if (merkleRootFrom(i.leaf, i.leafIndex, i.path) !== hx(toBytes(root, 32))) throw new Error(`btc-pool: path for leaf ${i.leafIndex} does not reach root`);
      }
      witness = {
        body: hx(body),
        root: hx(toBytes(root, 32)),
        inputs: inputs.map((i, j) => ({
          cx: hx(toBytes(i.cx, 32)), cy: hx(toBytes(i.cy, 32)),
          value: BigInt(i.value).toString(10),
          blinding: hx(toBytes(i.blinding, 32)),
          spend_key: hx(toBytes(i.spendKey, 32)),
          nk_pub: hx(toBytes(i.nkPub, 33)),
          nk_note: hx(toBytes(i.nkNote, 32)),
          leaf_index: Number(i.leafIndex),
          path: i.path.map((s) => hx(toBytes(s, 32))),
          sig: sigs[j],
        })),
        outputs: openings.map((o) => ({ value: BigInt(o.value).toString(10), blinding: hx(toBytes(o.blinding, 32)) })),
      };
    }
    const used = usedScripts ?? wallet?.usedScripts;
    if (exitRec && used instanceof Set) used.add(exitRec.destSpkHash);
    return { body, bodyHex: hx(body), msg, sigs, nullifiers, hAnchor: anchor, bind: bind ?? null, outputs: outNotes, exit: exitRec, want: wantRec, witness };
  }

  function assembleSpendEnvelope(body, proof) {
    const b = toBytes(body), pf = toBytes(proof);
    if (pf.length > BTC_POOL_MAX_PROOF) throw new Error(`btc-pool: proof is ${pf.length} bytes, max ${BTC_POOL_MAX_PROOF}`);
    const out = concat(b, le(pf.length, 2), pf);
    parseSpend(out, { full: true });
    return out;
  }

  return {
    H, G, commitXY, Hs, defaultAnchor,
    walletFromSeed, walletFromScalars, viewWallet, fullViewWallet, encodeAddress, decodeAddress,
    selectInputs, deriveExitKey, freshExitKey, recoverExit,
    createNote, noteLeaf, nullifier, tryReceive, scan,
    shieldKernelMsg, buildShieldEnvelope, parseShieldEnvelope, verifyShield,
    encodeSpendBody, parseSpend, buildSpendBody, assembleSpendEnvelope, spendMsg, exitDestHash, merkleRootFrom,
    schnorrSign, schnorrVerify,
    _aead: { seal: aeadSeal, open: aeadOpen, keystream },
  };
}
