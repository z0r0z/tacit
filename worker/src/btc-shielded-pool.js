// Bitcoin-native shielded pool: envelope parsing, note/nullifier hashing, the keccak note tree and the
// block-by-block replay state (contracts/sp1/confidential/DESIGN-btc-shielded-pool.md §2, §3, §5).
// Pure logic: no I/O. Transparent-note resolution and proof verification are injected by the caller.

import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 as sha256Hash } from '@noble/hashes/sha256';

export const T_BTC_SHIELD = 0x6c;
export const T_BTC_SPEND = 0x6d;

export const SHIELD_LEN = 316;
export const SHIELD_MAX_IN = 8;
export const SPEND_MAX_IN = 2;
export const SPEND_MAX_OUT = 3;
export const PROOF_MAX = 512;
export const ANCHOR_WINDOW = 144;
export const UNDO_DEPTH = 288;
export const TREE_DEPTH = 32;
export const MAX_LEAVES = 2 ** TREE_DEPTH;
export const PV_VERSION = 1;

export const OUTPUT_LEN = 32 + 32 + 32 + 33 + 33 + 56;
export const EXIT_LEN = 4 + 32 + 32 + 32;

const enc = (s) => new TextEncoder().encode(s);
const NOTE_DOMAIN = enc('tacit-btc-pool-note-v1');
const NF_DOMAIN = enc('tacit-btc-pool-nf-v1');
const SPEND_DOMAIN = enc('tacit-btc-pool-spend-v1');
const SHIELD_DOMAIN = enc('tacit-btc-pool-shield-v1');

const Point = secp.ProjectivePoint;
const P_FIELD = secp.CURVE.p;
const N_ORDER = secp.CURVE.n;

// ── bytes ──
export const hexToBytes = (h) => {
  const s = String(h).replace(/^0x/, '');
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};
export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const hx = (b) => '0x' + bytesToHex(b);
export const concat = (...arr) => {
  const out = new Uint8Array(arr.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of arr) { out.set(x, p); p += x.length; }
  return out;
};
const toBytes = (v) => (typeof v === 'string' ? hexToBytes(v) : v);
export const keccak = (...parts) => keccak_256(concat(...parts.map(toBytes)));
export const sha256 = (...parts) => sha256Hash(concat(...parts.map(toBytes)));
const bytesToBig = (b) => (b.length ? BigInt('0x' + bytesToHex(b)) : 0n);
const bigTo32 = (n) => hexToBytes(n.toString(16).padStart(64, '0'));
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000)) >>> 0;
const u32leBytes = (v) => Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
const beBytes = (v, len) => {
  const out = new Uint8Array(len);
  let x = BigInt(v);
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
};
const eqBytes = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// ── curve ──
// SPEC §2.1: H = first valid 0x02 ‖ SHA-256(SHA-256("tacit-generator-H-v1") ‖ ctr).
export const H = (() => {
  const seed = sha256Hash(enc('tacit-generator-H-v1'));
  for (let ctr = 0; ctr < 256; ctr++) {
    try { return Point.fromHex(concat(Uint8Array.of(0x02), sha256Hash(concat(seed, Uint8Array.of(ctr))))); } catch {}
  }
  throw new Error('no H');
})();
export const G = Point.BASE;
export const ZERO = Point.ZERO;

// Scalar multiply tolerating 0 and reducing mod n (noble rejects 0).
export const mulPoint = (P, k) => {
  const s = ((BigInt(k) % N_ORDER) + N_ORDER) % N_ORDER;
  return s === 0n ? ZERO : P.multiply(s);
};
export const pedersen = (value, blinding) => mulPoint(H, value).add(mulPoint(G, blinding));

// (Cx, Cy) as a curve point, both coordinates < p; null otherwise.
export function pointFromXY(cx, cy) {
  const x = bytesToBig(toBytes(cx)), y = bytesToBig(toBytes(cy));
  if (x >= P_FIELD || y >= P_FIELD) return null;
  try { return Point.fromAffine({ x, y }).assertValidity(); } catch { return null; }
}
export function pointFromCompressed(b) {
  b = toBytes(b);
  if (b.length !== 33 || (b[0] !== 0x02 && b[0] !== 0x03)) return null;
  if (bytesToBig(b.subarray(1)) >= P_FIELD) return null;
  try { return Point.fromHex(b); } catch { return null; }
}
export function liftX(x32) {
  x32 = toBytes(x32);
  if (x32.length !== 32) return null;
  return pointFromCompressed(concat(Uint8Array.of(0x02), x32));
}
export const pointXY = (P) => {
  const { x, y } = P.toAffine();
  return { cx: bigTo32(x), cy: bigTo32(y) };
};

const taggedHash = (tag, ...parts) => {
  const t = sha256Hash(enc(tag));
  return sha256Hash(concat(t, t, ...parts));
};

// BIP-340 verification over a 32-byte message.
export function bip340Verify(sig, msg, pubX) {
  sig = toBytes(sig); msg = toBytes(msg); pubX = toBytes(pubX);
  if (sig.length !== 64 || msg.length !== 32 || pubX.length !== 32) return false;
  const P = liftX(pubX);
  if (!P) return false;
  const r = bytesToBig(sig.subarray(0, 32));
  const s = bytesToBig(sig.subarray(32));
  if (r >= P_FIELD || s >= N_ORDER) return false;
  const e = bytesToBig(taggedHash('BIP0340/challenge', sig.subarray(0, 32), pubX, msg)) % N_ORDER;
  const R = mulPoint(G, s).add(mulPoint(P, e).negate());
  if (R.equals(ZERO)) return false;
  const { x, y } = R.toAffine();
  return (y & 1n) === 0n && x === r;
}

// ── note, nullifier, messages (§2, §3, §4) ──
export function noteLeaf({ asset, cx, cy, spendKey, nkPub }) {
  return keccak(asset, cx, cy, spendKey, nkPub, NOTE_DOMAIN);
}

// nf = keccak("tacit-btc-pool-nf-v1" ‖ leaf ‖ nk_note(32, BE) ‖ leaf_index(8, BE)). Wallet/test side only:
// the indexer never sees nk_note, it takes nf from the body.
export function nullifier(leaf, nkNote, leafIndex) {
  const nk = typeof nkNote === 'bigint' ? bigTo32(nkNote) : toBytes(nkNote);
  return keccak(NF_DOMAIN, leaf, nk, beBytes(leafIndex, 8));
}

export const spendMsg = (body) => keccak(SPEND_DOMAIN, body);

// Outpoint txids are given in display hex; the message carries the byte order the transaction's input
// serializes, exactly as the T_CXFER kernel does.
export function shieldKernelMsg(s, outpoints) {
  const parts = [SHIELD_DOMAIN, s.asset, Uint8Array.of(s.nIn)];
  for (const op of outpoints) parts.push(hexToBytes(op.txid).reverse(), u32leBytes(op.vout >>> 0));
  parts.push(s.cx, s.cy, s.spendKey, s.nkPub, s.pkEph, s.ctNote);
  return sha256(...parts);
}

// abi.encode(uint16 1, bytes32 root, bytes32 keccak(body)): three static words.
export function spendPublicValues(root, body) {
  const v = new Uint8Array(32);
  v[31] = PV_VERSION;
  return concat(v, toBytes(root), keccak(body));
}

// ── canonical parsers (§3) ──
function readNoteKeys(e, p, out) {
  out.spendKey = e.slice(p, p + 32); p += 32;
  out.nkPub = e.slice(p, p + 33); p += 33;
  out.pkEph = e.slice(p, p + 33); p += 33;
  return p;
}
function noteKeysValid(n) {
  return !!(liftX(n.spendKey) && pointFromCompressed(n.nkPub) && pointFromCompressed(n.pkEph));
}

export function parseShield(bytes) {
  const e = toBytes(bytes);
  if (!e || e.length !== SHIELD_LEN || e[0] !== T_BTC_SHIELD) return null;
  let p = 1;
  const s = { kind: 'shield' };
  s.asset = e.slice(p, p + 32); p += 32;
  s.nIn = e[p]; p += 1;
  if (s.nIn < 1 || s.nIn > SHIELD_MAX_IN) return null;
  s.cx = e.slice(p, p + 32); p += 32;
  s.cy = e.slice(p, p + 32); p += 32;
  p = readNoteKeys(e, p, s);
  s.ctNote = e.slice(p, p + 56); p += 56;
  s.kernelSig = e.slice(p, p + 64); p += 64;
  if (p !== e.length) return null;
  if (!pointFromXY(s.cx, s.cy) || !noteKeysValid(s)) return null;
  return s;
}

// 0x6D ‖ asset ‖ h_anchor(4) ‖ n_in ‖ nf×n_in ‖ n_out ‖ output×n_out ‖ has_exit ‖ [exit] ‖ proof_len(2) ‖ proof.
// `body` is every byte before proof_len.
export function parseSpend(bytes) {
  const e = toBytes(bytes);
  if (!e || e.length < 1 + 32 + 4 + 1 || e[0] !== T_BTC_SPEND) return null;
  let p = 1;
  const s = { kind: 'spend' };
  s.asset = e.slice(p, p + 32); p += 32;
  s.hAnchor = u32le(e, p); p += 4;
  s.nIn = e[p]; p += 1;
  if (s.nIn < 1 || s.nIn > SPEND_MAX_IN) return null;
  if (e.length < p + 32 * s.nIn + 1) return null;
  s.nullifiers = [];
  for (let i = 0; i < s.nIn; i++) { s.nullifiers.push(e.slice(p, p + 32)); p += 32; }
  const nOut = e[p]; p += 1;
  if (nOut > SPEND_MAX_OUT) return null;
  if (e.length < p + nOut * OUTPUT_LEN + 1) return null;
  s.outputs = [];
  for (let i = 0; i < nOut; i++) {
    const o = {};
    o.cx = e.slice(p, p + 32); p += 32;
    o.cy = e.slice(p, p + 32); p += 32;
    p = readNoteKeys(e, p, o);
    o.ctNote = e.slice(p, p + 56); p += 56;
    if (!pointFromXY(o.cx, o.cy) || !noteKeysValid(o)) return null;
    s.outputs.push(o);
  }
  const hasExit = e[p]; p += 1;
  if (hasExit > 1) return null;
  s.exit = null;
  if (hasExit) {
    if (e.length < p + EXIT_LEN) return null;
    const x = {};
    x.exitVout = u32le(e, p); p += 4;
    x.cx = e.slice(p, p + 32); p += 32;
    x.cy = e.slice(p, p + 32); p += 32;
    x.destSpkHash = e.slice(p, p + 32); p += 32;
    if (!pointFromXY(x.cx, x.cy)) return null;
    s.exit = x;
  }
  if (nOut + hasExit < 1) return null;
  s.body = e.slice(0, p);
  if (e.length < p + 2) return null;
  s.proofLen = e[p] | (e[p + 1] << 8); p += 2;
  if (s.proofLen > PROOF_MAX) return null;
  if (e.length !== p + s.proofLen) return null;
  s.proof = e.slice(p);
  return s;
}

export function parseEnvelope(payload) {
  const e = toBytes(payload);
  if (!e || !e.length) return null;
  if (e[0] === T_BTC_SHIELD) return parseShield(e);
  if (e[0] === T_BTC_SPEND) return parseSpend(e);
  return null;
}

// Which of a carrier's envelopes the pool reads (§3 Carriers). `envs[i]` is the Tacit envelope on vin[i]
// ({ opcode, payload }) or null. A T_BTC_SHIELD rides vin[0], and then only vin[0] is read. Otherwise every
// T_BTC_SPEND is read in input order. A T_BTC_SHIELD on a later input is returned so it can be recorded as
// rejected. `vin0TacitOp` is true when vin[0] holds a transparent Tacit op.
export function carrierPoolEnvelopes(envs) {
  const e0 = envs[0] || null;
  const isPool = (e) => e && (e.opcode === T_BTC_SHIELD || e.opcode === T_BTC_SPEND);
  const vin0TacitOp = !!e0 && !isPool(e0);
  if (e0 && e0.opcode === T_BTC_SHIELD) return { vin0TacitOp, items: [{ vin: 0, ...e0 }] };
  const items = [];
  envs.forEach((e, vin) => { if (isPool(e)) items.push({ vin, ...e }); });
  return { vin0TacitOp, items };
}

// ── depth-32 keccak tree ──
// Same shape as dapp/confidential-pool.js Tree: zero leaf 0, zeros[i+1] = keccak(zeros[i] ‖ zeros[i]), an
// absent sibling at level i is zeros[i]. Kept incrementally (every level materialized) so append, root and
// path are O(depth) and truncate restores the exact prior tree.
const ZERO32 = new Uint8Array(32);
export const ZEROS = (() => {
  const z = [ZERO32];
  for (let i = 1; i <= TREE_DEPTH; i++) z.push(keccak_256(concat(z[i - 1], z[i - 1])));
  return z;
})();

export class KeccakTree {
  constructor() { this.levels = Array.from({ length: TREE_DEPTH + 1 }, () => []); }
  get size() { return this.levels[0].length; }
  append(leaf) {
    const idx = this.levels[0].length;
    this.levels[0].push(toBytes(leaf).slice());
    this._rehash(idx);
    return idx;
  }
  _rehash(idx) {
    let k = idx;
    for (let i = 0; i < TREE_DEPTH; i++) {
      const pk = k >>> 1;
      const lv = this.levels[i];
      const l = lv[2 * pk];
      const r = 2 * pk + 1 < lv.length ? lv[2 * pk + 1] : ZEROS[i];
      this.levels[i + 1][pk] = keccak_256(concat(l, r));
      k = pk;
    }
  }
  truncate(n) {
    if (n > this.size) throw new Error('truncate beyond size');
    for (let i = 0; i <= TREE_DEPTH; i++) this.levels[i].length = Math.ceil(n / 2 ** i);
    if (n > 0) this._rehash(n - 1);
  }
  leaf(i) { return this.levels[0][i]; }
  root() { return this.size ? this.levels[TREE_DEPTH][0] : ZEROS[TREE_DEPTH]; }
  rootAndPath(index) {
    const path = [];
    for (let i = 0; i < TREE_DEPTH; i++) {
      const sib = Math.floor(index / 2 ** i) ^ 1;
      const lv = this.levels[i];
      path.push(sib < lv.length ? lv[sib] : ZEROS[i]);
    }
    return { root: this.root(), path };
  }
}

export function rootFromPath(leaf, index, path) {
  let h = toBytes(leaf);
  for (let i = 0; i < TREE_DEPTH; i++) {
    const sib = toBytes(path[i]);
    h = Math.floor(index / 2 ** i) % 2 ? keccak_256(concat(sib, h)) : keccak_256(concat(h, sib));
  }
  return h;
}

// ── replay state (§5) ──
export class VerifierUnavailableError extends Error {
  constructor() { super('spend proof verifier unavailable'); this.name = 'VerifierUnavailableError'; }
}
export class ReorgTooDeepError extends Error {
  constructor(h) { super(`no undo record for height ${h}`); this.name = 'ReorgTooDeepError'; }
}

const outKey = (txid, vout) => `${txid}:${vout}`;
const reject = (reason) => ({ accepted: false, reason });

export class BtcPoolState {
  constructor() {
    this.tree = new KeccakTree();
    this.leafHeights = [];
    this.nullifiers = new Map(); // hex nf -> { height, txid }
    this.exits = new Map(); // "txid:vout" -> { txid, vout, asset, cx, cy, height }
    this.roots = new Map(); // height -> root bytes
    this.undo = new Map(); // height -> undo record
    this.tip = null;
    this.pending = null;
    this.maxLeaves = MAX_LEAVES;
  }

  beginBlock(height) {
    if (this.pending) throw new Error('block already open');
    if (this.tip !== null && height !== this.tip + 1) throw new Error(`expected block ${this.tip + 1}, got ${height}`);
    this.pending = { height, leafStart: this.tree.size, leaves: [], nullifiers: [], exits: [] };
  }

  abortBlock() {
    const b = this.pending;
    if (!b) return;
    this.tree.truncate(b.leafStart);
    this.leafHeights.length = b.leafStart;
    for (const n of b.nullifiers) this.nullifiers.delete(n.nf);
    for (const x of b.exits) this.exits.delete(outKey(x.txid, x.vout));
    this.pending = null;
  }

  _appendLeaf(rec) {
    const b = this.pending;
    const leafIndex = this.tree.append(rec.leaf);
    this.leafHeights.push(b.height);
    const full = { ...rec, leafIndex, height: b.height };
    b.leaves.push(full);
    return full;
  }

  // ctx.txid, ctx.inputs [{txid, vout}] (every carrier input), ctx.resolveInput(outpoint, assetHex) →
  // { cx, cy } for a valid transparent note of that asset, null when it is not one; throws on I/O failure.
  async acceptShield(s, ctx) {
    const b = this.pending;
    if (!b) throw new Error('no open block');
    if (!s || s.kind !== 'shield') return reject('not a shield');
    if (this.tree.size + 1 > this.maxLeaves) return reject('note tree is full');
    if (!ctx.inputs || ctx.inputs.length < s.nIn + 1) return reject('carrier has too few inputs');
    const outpoints = ctx.inputs.slice(1, 1 + s.nIn);
    const assetHex = bytesToHex(s.asset);
    let sum = ZERO;
    for (const op of outpoints) {
      const note = await ctx.resolveInput(op, assetHex);
      if (!note) return reject(`input ${op.txid}:${op.vout} is not a valid note of the asset`);
      const C = pointFromXY(note.cx, note.cy);
      if (!C) return reject(`input ${op.txid}:${op.vout} commitment is not a curve point`);
      sum = sum.add(C);
    }
    const Cpool = pointFromXY(s.cx, s.cy);
    if (!Cpool || Cpool.equals(ZERO)) return reject('pool commitment is infinity');
    const E = Cpool.add(sum.negate());
    if (E.equals(ZERO)) return reject('excess is infinity');
    const ex = pointXY(E).cx;
    if (!bip340Verify(s.kernelSig, shieldKernelMsg(s, outpoints), ex)) return reject('kernel signature does not verify');
    const leaf = noteLeaf(s);
    const note = this._appendLeaf({
      leaf, txid: ctx.txid, asset: s.asset, cx: s.cx, cy: s.cy,
      spendKey: s.spendKey, nkPub: s.nkPub, pkEph: s.pkEph, ctNote: s.ctNote,
    });
    return { accepted: true, leaves: [note] };
  }

  // ctx.txid; ctx.outputs [{ scriptPubKey: Uint8Array }]; ctx.vin0TacitOp, true when the carrier's vin[0]
  // holds a transparent Tacit op; ctx.verifyProof({ proof, publicValues }) → bool. Earlier accepted envelopes
  // of the same carrier are already applied, so their nullifiers and exit outputs count as taken. A missing
  // verifier throws instead of rejecting, so an indexer without one halts rather than diverges.
  async acceptSpend(s, ctx) {
    const b = this.pending;
    if (!b) throw new Error('no open block');
    if (!s || s.kind !== 'spend') return reject('not a spend');
    const H_ = b.height;
    if (s.hAnchor < H_ - ANCHOR_WINDOW || s.hAnchor > H_ - 1) return reject('h_anchor outside window');
    const root = this.roots.get(s.hAnchor);
    if (!root) return reject('no root retained for h_anchor');
    const nfHex = s.nullifiers.map(bytesToHex);
    if (new Set(nfHex).size !== nfHex.length) return reject('duplicate nullifier in body');
    for (const nf of nfHex) if (this.nullifiers.has(nf)) return reject('nullifier already spent');
    if (s.exit) {
      if (ctx.vin0TacitOp) return reject('exit in a carrier whose vin[0] holds a transparent Tacit op');
      const out = ctx.outputs && ctx.outputs[s.exit.exitVout];
      if (!out) return reject('exit_vout is not an output of the carrier');
      if (this.exits.has(outKey(ctx.txid, s.exit.exitVout))) return reject('exit_vout already claimed by an earlier exit');
      if (!eqBytes(sha256(out.scriptPubKey), s.exit.destSpkHash)) return reject('exit scriptPubKey does not match dest_spk_hash');
    }
    if (this.tree.size + s.outputs.length > this.maxLeaves) return reject('note tree is full');
    if (typeof ctx.verifyProof !== 'function') throw new VerifierUnavailableError();
    const ok = await ctx.verifyProof({ proof: s.proof, publicValues: spendPublicValues(root, s.body) });
    if (ok !== true) return reject('proof does not verify');

    for (const nf of nfHex) {
      const rec = { nf, height: H_, txid: ctx.txid };
      this.nullifiers.set(nf, rec);
      b.nullifiers.push(rec);
    }
    const res = { accepted: true, nullifiers: nfHex, leaves: [], exit: null };
    for (const o of s.outputs) {
      res.leaves.push(this._appendLeaf({
        leaf: noteLeaf({ asset: s.asset, ...o }), txid: ctx.txid, asset: s.asset, cx: o.cx, cy: o.cy,
        spendKey: o.spendKey, nkPub: o.nkPub, pkEph: o.pkEph, ctNote: o.ctNote,
      }));
    }
    if (s.exit) {
      const x = { txid: ctx.txid, vout: s.exit.exitVout, asset: s.asset, cx: s.exit.cx, cy: s.exit.cy, height: H_ };
      this.exits.set(outKey(x.txid, x.vout), x);
      b.exits.push(x);
      res.exit = x;
    }
    return res;
  }

  // Records R[H]. Roots stay available through the block; after it commits only R[H−143..H] are needed
  // by the next block's window, so older ones are pruned here.
  endBlock() {
    const b = this.pending;
    if (!b) throw new Error('no open block');
    const root = this.tree.root();
    this.roots.set(b.height, root);
    const pruned = [];
    for (const [h, r] of this.roots) if (h < b.height + 1 - ANCHOR_WINDOW) pruned.push([h, r]);
    for (const [h] of pruned) this.roots.delete(h);
    this.undo.set(b.height, { leafStart: b.leafStart, nullifiers: b.nullifiers.map((n) => n.nf), exits: b.exits.map((x) => outKey(x.txid, x.vout)), pruned });
    for (const h of this.undo.keys()) if (h <= b.height - UNDO_DEPTH) this.undo.delete(h);
    this.tip = b.height;
    this.pending = null;
    return { height: b.height, root, leaves: b.leaves, nullifiers: b.nullifiers, exits: b.exits, pruned };
  }

  // Undo every block at or above `height`. Throws ReorgTooDeepError (state untouched) when any of them has
  // no undo record; the caller then rescans from the start height.
  rollbackFrom(height) {
    if (this.pending) this.abortBlock();
    if (this.tip === null || height > this.tip) return;
    for (let h = this.tip; h >= height; h--) if (!this.undo.has(h)) throw new ReorgTooDeepError(h);
    for (let h = this.tip; h >= height; h--) {
      const u = this.undo.get(h);
      this.tree.truncate(u.leafStart);
      this.leafHeights.length = u.leafStart;
      for (const nf of u.nullifiers) this.nullifiers.delete(nf);
      for (const k of u.exits) this.exits.delete(k);
      this.roots.delete(h);
      for (const [ph, r] of u.pruned) this.roots.set(ph, r);
      this.undo.delete(h);
    }
    this.tip = height - 1;
  }

  // Rebuild from persisted rows. `roots` must include every recorded height at least back to
  // tip − UNDO_DEPTH − ANCHOR_WINDOW so undo records can restore pruned roots.
  static restore({ tip, leaves, nullifiers, exits, roots }) {
    const st = new BtcPoolState();
    if (tip === null || tip === undefined) return st;
    st.tip = tip;
    const sorted = [...leaves].sort((a, b) => a.leafIndex - b.leafIndex);
    sorted.forEach((l, i) => {
      if (l.leafIndex !== i) throw new Error(`leaf index gap at ${i}`);
      st.tree.append(l.leaf);
      st.leafHeights.push(l.height);
    });
    const rootMap = new Map(roots.map(([h, r]) => [h, toBytes(r)]));
    for (const n of nullifiers) st.nullifiers.set(n.nf, { nf: n.nf, height: n.height, txid: n.txid });
    for (const x of exits) st.exits.set(outKey(x.txid, x.vout), x);
    for (const [h, r] of rootMap) if (h >= tip + 1 - ANCHOR_WINDOW && h <= tip) st.roots.set(h, r);
    const firstLeafAt = (h) => {
      let lo = 0, hi = st.leafHeights.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (st.leafHeights[m] < h) lo = m + 1; else hi = m; }
      return lo;
    };
    const byHeight = (arr, key) => {
      const m = new Map();
      for (const x of arr) { if (!m.has(x.height)) m.set(x.height, []); m.get(x.height).push(key(x)); }
      return m;
    };
    const nfBy = byHeight(nullifiers, (n) => n.nf);
    const exBy = byHeight(exits, (x) => outKey(x.txid, x.vout));
    for (let h = tip; h > tip - UNDO_DEPTH; h--) {
      if (!rootMap.has(h)) break;
      const ph = h - ANCHOR_WINDOW;
      st.undo.set(h, {
        leafStart: firstLeafAt(h),
        nullifiers: nfBy.get(h) || [],
        exits: exBy.get(h) || [],
        pruned: rootMap.has(ph) ? [[ph, rootMap.get(ph)]] : [],
      });
    }
    return st;
  }
}
