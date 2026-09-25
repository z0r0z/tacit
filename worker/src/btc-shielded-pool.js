// Bitcoin-native shielded pool: envelope parsing, the Poseidon note tree and the block-by-block replay state
// (contracts/sp1/confidential/DESIGN-btc-shielded-pool.md §3, §5). Client-proved relation: spend.circom, verified
// natively. Pure logic: no I/O. Transparent-note resolution and proof verification are injected by the caller.

import * as secp from '@noble/secp256k1';
import { sha256 as sha256Hash } from '@noble/hashes/sha256';
import { poseidon2 } from '../../dapp/vendor/tacit-poseidon.min.js';
import { spendPublics, P_FR } from '../../dapp/btc-pool-zk.js';
import { verifyBoundary, decodeBoundary, BOUNDARY_LEN } from '../../dapp/btc-pool-zk-boundary.js';

export const T_BTC_SHIELD = 0x6c;
export const T_BTC_SPEND = 0x6d;

export const SHIELD_MAX_IN = 8;
export const SPEND_MAX_IN = 2;
export const SPEND_MAX_OUT = 3;
export const PROOF_MAX = 4096;
export const ANCHOR_WINDOW = 144;
export const UNDO_DEPTH = 288;
export const TREE_DEPTH = 32;
export const MAX_LEAVES = 2 ** TREE_DEPTH;

export const CT_NOTE_LEN = 24;
export const OUTPUT_LEN = 32 + 33 + CT_NOTE_LEN;
export const BIND_LEN = 32 + 4;
export const WANT_LEN = 4 + 8 + 32;
export const EXIT_LEN = 4 + 32 + BOUNDARY_LEN;
export const KERNEL_SIG_LEN = 64;
export { BOUNDARY_LEN };

const enc = (s) => new TextEncoder().encode(s);
const SHIELD_DOMAIN = enc('tacit-btc-pool-zk-shield-v1');

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
export const sha256 = (...parts) => sha256Hash(concat(...parts.map(toBytes)));
export const bytesToBig = (b) => (b.length ? BigInt('0x' + bytesToHex(b)) : 0n);
export const bigTo32 = (n) => hexToBytes(BigInt(n).toString(16).padStart(64, '0'));
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000)) >>> 0;
const u64le = (b, o) => { let x = 0n; for (let k = 7; k >= 0; k--) x = (x << 8n) | BigInt(b[o + k]); return x; };
const u32leBytes = (v) => Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
const eqBytes = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// ── secp256k1 (transparent side) ──
export const G = Point.BASE;
export const ZERO = Point.ZERO;
export function pointFromCompressed(b) {
  b = toBytes(b);
  if (b.length !== 33 || (b[0] !== 0x02 && b[0] !== 0x03)) return null;
  if (bytesToBig(b.subarray(1)) >= P_FIELD) return null;
  try { return Point.fromHex(b); } catch { return null; }
}
export function pointFromXY(cx, cy) {
  const x = bytesToBig(toBytes(cx)), y = bytesToBig(toBytes(cy));
  if (x >= P_FIELD || y >= P_FIELD) return null;
  try { return Point.fromAffine({ x, y }).assertValidity(); } catch { return null; }
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
const mulPoint = (P, k) => {
  const s = ((BigInt(k) % N_ORDER) + N_ORDER) % N_ORDER;
  return s === 0n ? ZERO : P.multiply(s);
};
const taggedHash = (tag, ...parts) => {
  const t = sha256Hash(enc(tag));
  return sha256Hash(concat(t, t, ...parts));
};
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

// Kernel message of a shield: SHA-256(domain ‖ (txid ‖ vout_LE) × n_in ‖ body). Outpoint txids are given in
// display hex and carried in the byte order a transaction input serializes them, as the T_CXFER kernel does.
export function shieldKernelMsg(body, outpoints) {
  const parts = [SHIELD_DOMAIN];
  for (const op of outpoints) parts.push(hexToBytes(op.txid).reverse(), u32leBytes(op.vout >>> 0));
  parts.push(toBytes(body));
  return sha256(...parts);
}

// ── canonical parsers (§3) ──
// A field element on the wire: 32 bytes big-endian, below p.
const fieldOk = (b) => bytesToBig(b) < P_FR;

function readOutputs(e, p, n, out) {
  for (let i = 0; i < n; i++) {
    const o = {};
    o.leaf = e.slice(p, p + 32); p += 32;
    o.pkEph = e.slice(p, p + 33); p += 33;
    o.ctNote = e.slice(p, p + CT_NOTE_LEN); p += CT_NOTE_LEN;
    if (!fieldOk(o.leaf) || bytesToBig(o.leaf) === 0n || !pointFromCompressed(o.pkEph)) return -1;
    out.push(o);
  }
  return p;
}
function readBoundary(e, p) {
  const bd = decodeBoundary(e.slice(p, p + BOUNDARY_LEN));
  if (!bd || !pointFromCompressed(bd.cSecp)) return null;
  return bd;
}

// 0x6C ‖ asset ‖ n_in ‖ n_out ‖ output×n_out ‖ boundary ‖ kernel_sig ‖ proof_len(2) ‖ proof.
// `body` is every byte before kernel_sig.
export function parseShield(bytes) {
  const e = toBytes(bytes);
  if (!e || e.length < 35 || e[0] !== T_BTC_SHIELD) return null;
  let p = 1;
  const s = { kind: 'shield' };
  s.asset = e.slice(p, p + 32); p += 32;
  s.nIn = e[p]; p += 1;
  if (s.nIn < 1 || s.nIn > SHIELD_MAX_IN) return null;
  const nOut = e[p]; p += 1;
  if (nOut < 1 || nOut > SPEND_MAX_OUT) return null;
  if (e.length < p + nOut * OUTPUT_LEN + BOUNDARY_LEN + KERNEL_SIG_LEN + 2) return null;
  s.outputs = [];
  p = readOutputs(e, p, nOut, s.outputs);
  if (p < 0) return null;
  s.boundary = readBoundary(e, p); p += BOUNDARY_LEN;
  if (!s.boundary) return null;
  s.body = e.slice(0, p);
  s.kernelSig = e.slice(p, p + KERNEL_SIG_LEN); p += KERNEL_SIG_LEN;
  s.proofLen = e[p] | (e[p + 1] << 8); p += 2;
  if (s.proofLen > PROOF_MAX || e.length !== p + s.proofLen) return null;
  s.proof = e.slice(p);
  return s;
}

// 0x6D ‖ asset ‖ h_anchor(4) ‖ bind(36) ‖ n_in ‖ nf×n_in ‖ n_out ‖ output×n_out ‖ has_exit ‖ [exit] ‖ has_want ‖
// [want] ‖ proof_len(2) ‖ proof. `body` is every byte before proof_len. `bind` is null when all zero; its txid
// is returned in display hex (the byte order reversed), as carrier inputs name their outpoints.
export function parseSpend(bytes) {
  const e = toBytes(bytes);
  if (!e || e.length < 1 + 32 + 4 + BIND_LEN + 1 || e[0] !== T_BTC_SPEND) return null;
  let p = 1;
  const s = { kind: 'spend' };
  s.asset = e.slice(p, p + 32); p += 32;
  s.hAnchor = u32le(e, p); p += 4;
  const bind = e.slice(p, p + BIND_LEN); p += BIND_LEN;
  s.bind = bind.every((x) => x === 0) ? null : { txid: bytesToHex(bind.slice(0, 32).reverse()), vout: u32le(bind, 32) };
  s.nIn = e[p]; p += 1;
  if (s.nIn < 1 || s.nIn > SPEND_MAX_IN) return null;
  if (e.length < p + 32 * s.nIn + 1) return null;
  s.nullifiers = [];
  for (let i = 0; i < s.nIn; i++) {
    const nf = e.slice(p, p + 32); p += 32;
    if (!fieldOk(nf) || bytesToBig(nf) === 0n) return null;
    s.nullifiers.push(nf);
  }
  const nOut = e[p]; p += 1;
  if (nOut > SPEND_MAX_OUT) return null;
  if (e.length < p + nOut * OUTPUT_LEN + 1) return null;
  s.outputs = [];
  p = readOutputs(e, p, nOut, s.outputs);
  if (p < 0) return null;
  const hasExit = e[p]; p += 1;
  if (hasExit > 1) return null;
  s.exit = null;
  if (hasExit) {
    if (e.length < p + EXIT_LEN) return null;
    const x = {};
    x.exitVout = u32le(e, p); p += 4;
    x.destSpkHash = e.slice(p, p + 32); p += 32;
    x.boundary = readBoundary(e, p); p += BOUNDARY_LEN;
    if (!x.boundary) return null;
    s.exit = x;
  }
  if (e.length < p + 1) return null;
  const hasWant = e[p]; p += 1;
  if (hasWant > 1) return null;
  s.want = null;
  if (hasWant) {
    if (e.length < p + WANT_LEN) return null;
    s.want = { vout: u32le(e, p), value: u64le(e, p + 4), spkHash: e.slice(p + 12, p + WANT_LEN) };
    p += WANT_LEN;
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

// Public inputs of spend.circom for a parsed envelope. `root` is R[h_anchor] (32 bytes); a shield proves
// against root 0 with every input slot empty. The boundary's BabyJub commitment enters as depC (shield) or
// exitC (exit); pass it once the boundary has verified.
export function envelopePublics(s, { root = null, boundaryC = null } = {}) {
  const leaves = s.outputs.map((o) => bytesToBig(o.leaf));
  if (s.kind === 'shield') {
    return spendPublics({ root: 0n, body: s.body, asset: s.asset, nullifiers: [], outLeaves: leaves, depC: boundaryC });
  }
  return spendPublics({
    root: bytesToBig(toBytes(root)), body: s.body, asset: s.asset,
    nullifiers: s.nullifiers.map(bytesToBig), outLeaves: leaves, exitC: s.exit ? boundaryC : null,
  });
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

// ── depth-32 Poseidon tree ──
// circomlib Poseidon(2) nodes, zero leaf 0, zeros[i+1] = H(zeros[i], zeros[i]); an absent sibling at level i
// is zeros[i]. Every level is materialized, so append, root and path are O(depth) and truncate restores the
// exact prior tree. Leaves, roots and path entries are 32-byte big-endian field elements at the API.
const H2 = (a, b) => poseidon2([a, b]);
export const ZEROS_F = (() => {
  const z = [0n];
  for (let i = 1; i <= TREE_DEPTH; i++) z.push(H2(z[i - 1], z[i - 1]));
  return z;
})();
export const ZEROS = ZEROS_F.map(bigTo32);

export class PoseidonTree {
  constructor() { this.levels = Array.from({ length: TREE_DEPTH + 1 }, () => []); }
  get size() { return this.levels[0].length; }
  append(leaf) {
    const v = bytesToBig(toBytes(leaf));
    if (v >= P_FR) throw new Error('leaf is not a field element');
    const idx = this.levels[0].length;
    this.levels[0].push(v);
    this._rehash(idx);
    return idx;
  }
  _rehash(idx) {
    let k = idx;
    for (let i = 0; i < TREE_DEPTH; i++) {
      const pk = k >>> 1;
      const lv = this.levels[i];
      const l = lv[2 * pk];
      const r = 2 * pk + 1 < lv.length ? lv[2 * pk + 1] : ZEROS_F[i];
      this.levels[i + 1][pk] = H2(l, r);
      k = pk;
    }
  }
  truncate(n) {
    if (n > this.size) throw new Error('truncate beyond size');
    for (let i = 0; i <= TREE_DEPTH; i++) this.levels[i].length = Math.ceil(n / 2 ** i);
    if (n > 0) this._rehash(n - 1);
  }
  leaf(i) { return bigTo32(this.levels[0][i]); }
  rootF() { return this.size ? this.levels[TREE_DEPTH][0] : ZEROS_F[TREE_DEPTH]; }
  root() { return bigTo32(this.rootF()); }
  rootAndPath(index) {
    const path = [];
    for (let i = 0; i < TREE_DEPTH; i++) {
      const sib = Math.floor(index / 2 ** i) ^ 1;
      const lv = this.levels[i];
      path.push(bigTo32(sib < lv.length ? lv[sib] : ZEROS_F[i]));
    }
    return { root: this.root(), path };
  }
  // Root and path of leaf `index` in the tree of the first `n` leaves. A node whose span lies inside the
  // first n leaves is unchanged by later appends; one straddling n is recomputed.
  rootAndPathAt(index, n) {
    if (!(index < n && n <= this.size)) throw new Error('leaf outside the prefix');
    const node = (i, j) => {
      const lo = j * 2 ** i;
      if (lo >= n) return ZEROS_F[i];
      if (lo + 2 ** i <= n) return this.levels[i][j];
      return H2(node(i - 1, 2 * j), node(i - 1, 2 * j + 1));
    };
    const path = [];
    for (let i = 0; i < TREE_DEPTH; i++) path.push(bigTo32(node(i, Math.floor(index / 2 ** i) ^ 1)));
    return { root: bigTo32(node(TREE_DEPTH, 0)), path };
  }
}

export function rootFromPath(leaf, index, path) {
  let h = bytesToBig(toBytes(leaf));
  for (let i = 0; i < TREE_DEPTH; i++) {
    const sib = bytesToBig(toBytes(path[i]));
    h = Math.floor(index / 2 ** i) % 2 ? H2(sib, h) : H2(h, sib);
  }
  return bigTo32(h);
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
    this.tree = new PoseidonTree();
    this.leafHeights = [];
    this.nullifiers = new Map(); // hex nf -> { height, txid }
    this.exits = new Map(); // "txid:vout" -> { txid, vout, asset, cx, cy, height }
    this.roots = new Map(); // height -> root bytes
    this.undo = new Map(); // height -> undo record
    this.tip = null;
    this.pending = null;
    this.maxLeaves = MAX_LEAVES;
  }

  // Leaves appended in blocks at or below `height`.
  leafCountAt(height) {
    let lo = 0, hi = this.leafHeights.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.leafHeights[m] <= height) lo = m + 1; else hi = m; }
    return lo;
  }

  beginBlock(height) {
    if (this.pending) throw new Error('block already open');
    if (this.tip !== null && height !== this.tip + 1) throw new Error(`expected block ${this.tip + 1}, got ${height}`);
    // `wants` holds the outputs claimed by accepted wants in this block; a want binds only its own carrier.
    this.pending = { height, leafStart: this.tree.size, leaves: [], nullifiers: [], exits: [], wants: new Set() };
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

  _appendLeaves(s, txid) {
    const b = this.pending;
    return s.outputs.map((o) => {
      const leafIndex = this.tree.append(o.leaf);
      this.leafHeights.push(b.height);
      const full = { leaf: o.leaf, txid, asset: s.asset, pkEph: o.pkEph, ctNote: o.ctNote, leafIndex, height: b.height };
      b.leaves.push(full);
      return full;
    });
  }

  // ctx.txid, ctx.inputs [{txid, vout}] (every carrier input), ctx.resolveInput(outpoint, assetHex) →
  // { cx, cy } for a valid transparent note of that asset, null when it is not one; throws on I/O failure.
  // ctx.verifyProof({ proof, publics }) → bool; missing, it throws so the indexer halts rather than diverges.
  async acceptShield(s, ctx) {
    const b = this.pending;
    if (!b) throw new Error('no open block');
    if (!s || s.kind !== 'shield') return reject('not a shield');
    if (this.tree.size + s.outputs.length > this.maxLeaves) return reject('note tree is full');
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
    const Cpool = pointFromCompressed(s.boundary.cSecp);
    const E = Cpool.add(sum.negate());
    if (E.equals(ZERO)) return reject('excess is infinity');
    if (!bip340Verify(s.kernelSig, shieldKernelMsg(s.body, outpoints), pointXY(E).cx)) return reject('kernel signature does not verify');
    const depC = verifyBoundary(s.boundary);
    if (!depC) return reject('boundary does not verify');
    if (typeof ctx.verifyProof !== 'function') throw new VerifierUnavailableError();
    const ok = await ctx.verifyProof({ proof: s.proof, publics: envelopePublics(s, { boundaryC: depC }) });
    if (ok !== true) return reject('proof does not verify');
    return { accepted: true, leaves: this._appendLeaves(s, ctx.txid) };
  }

  // ctx.txid; ctx.inputs [{ txid, vout }] (every carrier input, txid in display hex); ctx.outputs
  // [{ value: bigint, scriptPubKey: Uint8Array }]; ctx.vin0TacitOp, true when the carrier's vin[0] holds a
  // transparent Tacit op; ctx.verifyProof({ proof, publics }) → bool. Earlier accepted envelopes of the same
  // carrier are already applied, so their nullifiers, exit outputs and want outputs count as taken. A missing
  // verifier throws instead of rejecting, so an indexer without one halts rather than diverges.
  async acceptSpend(s, ctx) {
    const b = this.pending;
    if (!b) throw new Error('no open block');
    if (!s || s.kind !== 'spend') return reject('not a spend');
    const H_ = b.height;
    if (s.hAnchor < H_ - ANCHOR_WINDOW || s.hAnchor > H_ - 1) return reject('h_anchor outside window');
    const root = this.roots.get(s.hAnchor);
    if (!root) return reject('no root retained for h_anchor');
    if (s.bind && !(ctx.inputs || []).some((i) => i.txid === s.bind.txid && i.vout === s.bind.vout)) return reject('carrier does not spend the bound outpoint');
    const nfHex = s.nullifiers.map(bytesToHex);
    if (new Set(nfHex).size !== nfHex.length) return reject('duplicate nullifier in body');
    for (const nf of nfHex) if (this.nullifiers.has(nf)) return reject('nullifier already spent');
    const claimed = (vout) => this.exits.has(outKey(ctx.txid, vout)) || b.wants.has(outKey(ctx.txid, vout));
    if (s.exit) {
      if (ctx.vin0TacitOp) return reject('exit in a carrier whose vin[0] holds a transparent Tacit op');
      const out = ctx.outputs && ctx.outputs[s.exit.exitVout];
      if (!out) return reject('exit_vout is not an output of the carrier');
      if (claimed(s.exit.exitVout)) return reject('exit_vout already claimed by an earlier exit or want');
      if (!eqBytes(sha256(out.scriptPubKey), s.exit.destSpkHash)) return reject('exit scriptPubKey does not match dest_spk_hash');
    }
    if (s.want) {
      const out = ctx.outputs && ctx.outputs[s.want.vout];
      if (!out) return reject('want vout is not an output of the carrier');
      if (s.exit && s.exit.exitVout === s.want.vout) return reject('want and exit name the same output');
      if (claimed(s.want.vout)) return reject('want vout already claimed by an earlier exit or want');
      if (BigInt(out.value) < s.want.value) return reject('want output pays less than the want value');
      if (!eqBytes(sha256(out.scriptPubKey), s.want.spkHash)) return reject('want scriptPubKey does not match spk_hash');
    }
    if (this.tree.size + s.outputs.length > this.maxLeaves) return reject('note tree is full');
    let exitC = null;
    if (s.exit) {
      exitC = verifyBoundary(s.exit.boundary);
      if (!exitC) return reject('exit boundary does not verify');
    }
    if (typeof ctx.verifyProof !== 'function') throw new VerifierUnavailableError();
    const ok = await ctx.verifyProof({ proof: s.proof, publics: envelopePublics(s, { root, boundaryC: exitC }) });
    if (ok !== true) return reject('proof does not verify');

    for (const nf of nfHex) {
      const rec = { nf, height: H_, txid: ctx.txid };
      this.nullifiers.set(nf, rec);
      b.nullifiers.push(rec);
    }
    const res = { accepted: true, nullifiers: nfHex, leaves: this._appendLeaves(s, ctx.txid), exit: null, want: null };
    if (s.exit) {
      const { cx, cy } = pointXY(pointFromCompressed(s.exit.boundary.cSecp));
      const x = { txid: ctx.txid, vout: s.exit.exitVout, asset: s.asset, cx, cy, height: H_ };
      this.exits.set(outKey(x.txid, x.vout), x);
      b.exits.push(x);
      res.exit = x;
    }
    if (s.want) {
      b.wants.add(outKey(ctx.txid, s.want.vout));
      res.want = { txid: ctx.txid, vout: s.want.vout, value: s.want.value };
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
