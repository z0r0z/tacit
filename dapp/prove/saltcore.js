// Salt grinding in plain JavaScript, for a browser tab (salt-worker.js) and for Node (the tests): the same salts tacit-prover grinds between proofs (salt.rs) and
// the API's salt pool counts (worker/src/salt-pool.js). A salt is Tacit's deployer (20 bytes), 0x00, the UTC day (2 bytes, big-endian) and 9 bytes ground here; its
// address is CreateX's CREATE3 address for that deployer, three Keccak-256 hashes away:
//   guarded = keccak(12 zero bytes ‖ deployer ‖ salt)
//   proxy   = keccak(0xff ‖ CreateX ‖ guarded ‖ keccak(proxy init code))[12..]
//   address = keccak(0xd6 0x94 ‖ proxy ‖ 0x01)[12..]
// and a share is a salt whose address starts with at least the pool's minBits zero bits.
//
// Every message here fits one 136-byte block, so each hash is one Keccak-f[1600] permutation. The state is 25 lanes of 64 bits kept as 50 32-bit words, low word
// first, which is also the byte order of the message: word i is bytes 4i..4i+3, little-endian.

export const DEPLOYER = '68575b073de49a94e3e3acf6f3a0d6e3b66267c7', CREATEX = 'ba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed';
const PROXY_INIT = [0x67, 0x36, 0x3d, 0x3d, 0x37, 0x36, 0x3d, 0x34, 0xf0, 0x3d, 0x52, 0x60, 0x08, 0x60, 0x18, 0xf3];
const hex = (s) => Uint8Array.from(s.match(/../g), (b) => parseInt(b, 16));
export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// ---- Keccak-f[1600]: the round constants (from the specification's LFSR), and the rotation and position of each lane in the ρ and π steps
const RC = new Int32Array(48), ROT = new Int32Array(24), PI = new Int32Array(24);
{
  let lfsr = 1;
  for (let r = 0; r < 24; r++) {
    for (let j = 0; j < 7; j++) {
      const bit = (1 << j) - 1;
      if (lfsr & 1) RC[2 * r + (bit >> 5)] ^= 1 << (bit & 31);
      lfsr = ((lfsr << 1) ^ (lfsr & 0x80 ? 0x71 : 0)) & 0xff;
    }
  }
  let x = 1, y = 0;
  for (let t = 0; t < 24; t++) { ROT[t] = ((t + 1) * (t + 2) / 2) % 64; const ny = (2 * x + 3 * y) % 5; x = y; y = ny; PI[t] = 2 * (x + 5 * y); }
}
const C = new Int32Array(10);
// the permutation, in place, on 50 words
export function keccakF(s) {
  for (let round = 0; round < 48; round += 2) {
    // θ
    for (let x = 0; x < 10; x++) C[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
    for (let x = 0; x < 10; x += 2) {
      const a = (x + 2) % 10, b = (x + 8) % 10, lo = C[a], hi = C[a + 1];
      const dl = C[b] ^ ((lo << 1) | (hi >>> 31)), dh = C[b + 1] ^ ((hi << 1) | (lo >>> 31));
      s[x] ^= dl; s[x + 1] ^= dh; s[x + 10] ^= dl; s[x + 11] ^= dh; s[x + 20] ^= dl; s[x + 21] ^= dh; s[x + 30] ^= dl; s[x + 31] ^= dh; s[x + 40] ^= dl; s[x + 41] ^= dh;
    }
    // ρ and π
    let lo = s[2], hi = s[3];
    for (let t = 0; t < 24; t++) {
      const n = ROT[t], p = PI[t], tl = s[p], th = s[p + 1];
      if (n < 32) { s[p] = (lo << n) | (hi >>> (32 - n)); s[p + 1] = (hi << n) | (lo >>> (32 - n)); }
      else if (n === 32) { s[p] = hi; s[p + 1] = lo; }
      else { s[p] = (hi << (n - 32)) | (lo >>> (64 - n)); s[p + 1] = (lo << (n - 32)) | (hi >>> (64 - n)); }
      lo = tl; hi = th;
    }
    // χ
    for (let y = 0; y < 50; y += 10) {
      const a0 = s[y], a1 = s[y + 1], b0 = s[y + 2], b1 = s[y + 3], c0 = s[y + 4], c1 = s[y + 5], d0 = s[y + 6], d1 = s[y + 7], e0 = s[y + 8], e1 = s[y + 9];
      s[y] = a0 ^ (~b0 & c0); s[y + 1] = a1 ^ (~b1 & c1); s[y + 2] = b0 ^ (~c0 & d0); s[y + 3] = b1 ^ (~c1 & d1); s[y + 4] = c0 ^ (~d0 & e0); s[y + 5] = c1 ^ (~d1 & e1);
      s[y + 6] = d0 ^ (~e0 & a0); s[y + 7] = d1 ^ (~e1 & a1); s[y + 8] = e0 ^ (~a0 & b0); s[y + 9] = e1 ^ (~a1 & b1);
    }
    // ι
    s[0] ^= RC[round]; s[1] ^= RC[round + 1];
  }
}

// Keccak-256 of a message shorter than one block (135 bytes at most): what everything here hashes
export function keccak256(bytes) {
  if (bytes.length > 135) throw new Error('keccak256 here takes one block');
  const block = new Uint8Array(200); block.set(bytes); block[bytes.length] ^= 0x01; block[135] ^= 0x80;
  const s = new Int32Array(block.buffer); keccakF(s);
  return new Uint8Array(s.buffer, 0, 32).slice();
}

export const PROXY_INIT_HASH = keccak256(Uint8Array.from(PROXY_INIT));
const DEP = hex(DEPLOYER), CX = hex(CREATEX);

export function zeroBits(addr) {
  let bits = 0;
  for (const b of addr) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
  return bits;
}
// The CREATE3 address of a 32-byte salt and its leading zero bits, hash by hash: the plain way, which the fast grinder below is checked against.
export function saltAddress(salt) {
  const m1 = new Uint8Array(64); m1.set(DEP, 12); m1.set(salt, 32);
  const m2 = new Uint8Array(85); m2[0] = 0xff; m2.set(CX, 1); m2.set(keccak256(m1), 21); m2.set(PROXY_INIT_HASH, 53);
  const m3 = new Uint8Array(23); m3[0] = 0xd6; m3[1] = 0x94; m3.set(keccak256(m2).subarray(12), 2); m3[22] = 0x01;
  const address = keccak256(m3).subarray(12);
  return { address, bits: zeroBits(address) };
}

export const utcDay = (ms = Date.now()) => Math.floor(ms / 86400000);
// A salt of a UTC day with 9 bytes of the grinder's own: 5 it drew at random (so no two grinders walk the same salts) and a 4-byte counter.
export function saltOf(day, prefix, n) {
  const salt = new Uint8Array(32); salt.set(DEP); salt[21] = (day >> 8) & 0xff; salt[22] = day & 0xff; salt.set(prefix.subarray(0, 5), 23);
  salt[28] = n & 0xff; salt[29] = (n >>> 8) & 0xff; salt[30] = (n >>> 16) & 0xff; salt[31] = (n >>> 24) & 0xff;
  return salt;
}

// The fast grinder. The three messages are laid out once as words; a salt changes one word of the first, and each hash's result is shifted into the next message
// by whole words. grind(count, minBits) walks `count` salts from where the last call stopped and returns the counters of those that are shares.
export function makeGrinder({ day, prefix }) {
  const le = (bytes) => new Int32Array(bytes.buffer.slice(0));
  const b1 = new Uint8Array(200); b1.set(DEP, 12); b1.set(saltOf(day, prefix, 0), 32); b1[64] = 0x01; b1[135] = 0x80;
  const b2 = new Uint8Array(200); b2[0] = 0xff; b2.set(CX, 1); b2.set(PROXY_INIT_HASH, 53); b2[85] = 0x01; b2[135] = 0x80;
  const b3 = new Uint8Array(200); b3[0] = 0xd6; b3[1] = 0x94; b3[22] = 0x01; b3[23] = 0x01; b3[135] = 0x80;
  const T1 = le(b1), T2 = le(b2), T3 = le(b3), s = new Int32Array(50);
  const c5 = T2[5], c13 = T2[13], c0 = T3[0], c5b = T3[5];
  let n = 0;
  function grind(count, minBits) {
    const found = [];
    for (let i = 0; i < count; i++) {
      n = (n + 1) | 0;
      // guarded = keccak(pad32(deployer) ‖ salt): the counter is bytes 60..63, word 15
      s.set(T1); s[15] = n; keccakF(s);
      const g0 = s[0], g1 = s[1], g2 = s[2], g3 = s[3], g4 = s[4], g5 = s[5], g6 = s[6], g7 = s[7];
      // proxy = keccak(0xff ‖ CreateX ‖ guarded ‖ init hash): guarded starts at byte 21, a word and a byte in
      s.set(T2);
      s[5] = c5 | (g0 << 8); s[6] = (g0 >>> 24) | (g1 << 8); s[7] = (g1 >>> 24) | (g2 << 8); s[8] = (g2 >>> 24) | (g3 << 8); s[9] = (g3 >>> 24) | (g4 << 8);
      s[10] = (g4 >>> 24) | (g5 << 8); s[11] = (g5 >>> 24) | (g6 << 8); s[12] = (g6 >>> 24) | (g7 << 8); s[13] = c13 | (g7 >>> 24);
      keccakF(s);
      const p3 = s[3], p4 = s[4], p5 = s[5], p6 = s[6], p7 = s[7];
      // address = keccak(0xd6 0x94 ‖ proxy ‖ 0x01): proxy (bytes 12..31 of the last hash) starts at byte 2
      s.set(T3);
      s[0] = c0 | (p3 << 16); s[1] = (p3 >>> 16) | (p4 << 16); s[2] = (p4 >>> 16) | (p5 << 16); s[3] = (p5 >>> 16) | (p6 << 16); s[4] = (p6 >>> 16) | (p7 << 16); s[5] = c5b | (p7 >>> 16);
      keccakF(s);
      // the address is bytes 12..31: its first byte is the low byte of word 3
      const a = s[3];
      if (minBits >= 8 && (a & 0xff) !== 0) continue;
      let bits = 0;
      for (let w = 3; w < 8; w++) {
        const v = s[w];
        if (v === 0) { bits += 32; continue; }
        if ((v & 0xff) !== 0) bits += Math.clz32(v & 0xff) - 24;
        else if ((v & 0xff00) !== 0) bits += 8 + Math.clz32((v >>> 8) & 0xff) - 24;
        else if ((v & 0xff0000) !== 0) bits += 16 + Math.clz32((v >>> 16) & 0xff) - 24;
        else bits += 24 + Math.clz32(v >>> 24) - 24;
        break;
      }
      if (bits >= minBits) found.push({ n, bits });
    }
    return found;
  }
  return { grind, saltOf: (k) => saltOf(day, prefix, k), day, at: () => n };
}

// ---- the same grinder as a WebAssembly module, where a lane is one 64-bit integer: many times the speed of the words above. The module is written out here
// instruction by instruction (there is no compiled file to trust): `f` is Keccak-f[1600] on the 25 lanes at the start of its memory, and `grind` lays out the three
// messages lane by lane exactly as makeGrinder does word by word, and notes each counter whose address starts with the zero bytes asked for. Its memory: the
// state at 0, the round constants at 256, the constant lanes of the first message at 512 and of the second at 640, how many salts it walked at 1020, and the
// counters it noted from 1024 (256 at most in one call).
const W = { S: 0, RC: 256, T1: 512, T2: 640, DONE: 1020, OUT: 1024, CAP: 256 };
const uleb = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const sleb = (v) => { v = BigInt.asIntN(64, BigInt(v)); const out = []; for (;;) { const b = Number(v & 0x7fn); v >>= 7n; const end = (v === 0n && !(b & 0x40)) || (v === -1n && !!(b & 0x40)); out.push(end ? b : b | 0x80); if (end) return out; } };
const op = {
  get: (i) => [0x20, ...uleb(i)], set: (i) => [0x21, ...uleb(i)], tee: (i) => [0x22, ...uleb(i)],
  i32: (n) => [0x41, ...sleb(n | 0)], i64: (v) => [0x42, ...sleb(v)],
  load64: (off) => [0x41, 0, 0x29, 3, ...uleb(off)],          // the lane at a fixed address
  store64: (off, value) => [0x41, 0, ...value, 0x37, 3, ...uleb(off)],
  xor: [0x85], and: [0x83], or: [0x84], shl: [0x86], shru: [0x88], rotl: [0x89],
};
export function grinderWasm() {
  const HIGH = -(2n ** 63n);   // 0x80 in the last byte of the block: the end of the padding
  // f: locals 0..24 the lanes, 25..49 the lanes after ρ and π, 50..54 the column sums, 55 a spare, 56 the round (as a byte offset into the constants)
  const A = (i) => i, B = (i) => 25 + i, Cc = (x) => 50 + x, T = 55, R = 56;
  const rot = Array.from({ length: 25 }, () => 0); { let x = 1, y = 0; for (let t = 0; t < 24; t++) { rot[x + 5 * y] = ((t + 1) * (t + 2) / 2) % 64; const ny = (2 * x + 3 * y) % 5; x = y; y = ny; } }
  const f = [];
  for (let i = 0; i < 25; i++) f.push(...op.load64(W.S + 8 * i), ...op.set(A(i)));
  f.push(0x03, 0x40);                                                                                    // loop: one round
  for (let x = 0; x < 5; x++) f.push(...op.get(A(x)), ...op.get(A(x + 5)), ...op.xor, ...op.get(A(x + 10)), ...op.xor, ...op.get(A(x + 15)), ...op.xor, ...op.get(A(x + 20)), ...op.xor, ...op.set(Cc(x)));   // θ
  for (let x = 0; x < 5; x++) {
    f.push(...op.get(Cc((x + 4) % 5)), ...op.get(Cc((x + 1) % 5)), ...op.i64(1), ...op.rotl, ...op.xor, ...op.set(T));
    for (let y = 0; y < 5; y++) f.push(...op.get(A(x + 5 * y)), ...op.get(T), ...op.xor, ...op.set(A(x + 5 * y)));
  }
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) f.push(...op.get(A(x + 5 * y)), ...(rot[x + 5 * y] ? [...op.i64(rot[x + 5 * y]), ...op.rotl] : []), ...op.set(B(y + 5 * ((2 * x + 3 * y) % 5))));   // ρ and π
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) f.push(...op.get(B(x + 5 * y)), ...op.get(B((x + 1) % 5 + 5 * y)), ...op.i64(-1), ...op.xor, ...op.get(B((x + 2) % 5 + 5 * y)), ...op.and, ...op.xor, ...op.set(A(x + 5 * y)));   // χ
  f.push(...op.get(A(0)), ...op.get(R), 0x29, 3, ...uleb(W.RC), ...op.xor, ...op.set(A(0)));               // ι
  f.push(...op.get(R), ...op.i32(8), 0x6a, ...op.tee(R), ...op.i32(192), 0x47, 0x0d, 0, 0x0b);              // the next round, 24 in all
  for (let i = 0; i < 25; i++) f.push(...op.store64(W.S + 8 * i, op.get(A(i))));

  // grind(n, count, mask) -> how many it noted: parameters 0..2, then 3 the salts walked, 4 the number noted, 5..8 four lanes of the last hash
  const N = 0, COUNT = 1, MASK = 2, I = 3, FOUND = 4, G = (k) => 5 + k;
  const zero = (from, to) => { const out = []; for (let l = from; l <= to; l++) out.push(...op.store64(W.S + 8 * l, op.i64(l === 16 ? HIGH : 0))); return out; };
  const shifted = (a, right, b, left) => [...op.get(a), ...op.i64(right), ...op.shru, ...op.get(b), ...op.i64(left), ...op.shl, ...op.or];
  const bump = (l) => [...op.get(l), ...op.i32(1), 0x6a];
  const g = [0x02, 0x40, 0x03, 0x40];                                                                    // block, loop
  g.push(...op.get(I), ...op.get(COUNT), 0x4f, 0x0d, 1);                                                  // walked them all: out
  g.push(...bump(N), ...op.set(N));
  // guarded = keccak(12 zero bytes ‖ deployer ‖ salt): the counter is the high half of lane 7; the padding starts lane 8
  for (let l = 0; l < 7; l++) g.push(...op.store64(W.S + 8 * l, op.load64(W.T1 + 8 * l)));
  g.push(...op.store64(W.S + 56, [...op.load64(W.T1 + 56), ...op.get(N), 0xad, ...op.i64(32), ...op.shl, ...op.or]));
  g.push(...op.store64(W.S + 64, op.i64(1)), ...zero(9, 24), 0x10, 0);
  for (let k = 0; k < 4; k++) g.push(...op.load64(W.S + 8 * k), ...op.set(G(k)));
  // proxy = keccak(0xff ‖ CreateX ‖ guarded ‖ init hash): guarded starts at byte 21, five bytes into lane 2
  g.push(...op.store64(W.S, op.load64(W.T2)), ...op.store64(W.S + 8, op.load64(W.T2 + 8)));
  g.push(...op.store64(W.S + 16, [...op.load64(W.T2 + 16), ...op.get(G(0)), ...op.i64(40), ...op.shl, ...op.or]));
  for (let k = 0; k < 3; k++) g.push(...op.store64(W.S + 24 + 8 * k, shifted(G(k), 24, G(k + 1), 40)));
  g.push(...op.store64(W.S + 48, [...op.get(G(3)), ...op.i64(24), ...op.shru, ...op.load64(W.T2 + 48), ...op.or]));
  for (let l = 7; l <= 10; l++) g.push(...op.store64(W.S + 8 * l, op.load64(W.T2 + 8 * l)));
  g.push(...zero(11, 24), 0x10, 0);
  for (let k = 1; k < 4; k++) g.push(...op.load64(W.S + 8 * k), ...op.set(G(k)));
  // address = keccak(0xd6 0x94 ‖ proxy ‖ 0x01): proxy is bytes 12..31 of that hash, the high half of lane 1 and lanes 2 and 3
  g.push(...op.store64(W.S, [...op.get(G(1)), ...op.i64(32), ...op.shru, ...op.i64(16), ...op.shl, ...op.get(G(2)), ...op.i64(48), ...op.shl, ...op.or, ...op.i64(0x94d6), ...op.or]));
  g.push(...op.store64(W.S + 8, shifted(G(2), 16, G(3), 48)));
  g.push(...op.store64(W.S + 16, [...op.get(G(3)), ...op.i64(16), ...op.shru, ...op.i64(0x0101n << 48n), ...op.or]));
  g.push(...zero(3, 24), 0x10, 0);
  // the address's first four bytes are the high half of lane 1: zero under the mask is a salt to note
  g.push(...op.load64(W.S + 8), ...op.i64(32), ...op.shru, 0xa7, ...op.get(MASK), 0x71, 0x45, 0x04, 0x40);
  g.push(...op.get(FOUND), ...op.i32(2), 0x74, ...op.get(N), 0x36, 2, ...uleb(W.OUT));
  g.push(...bump(FOUND), ...op.tee(FOUND), ...op.i32(W.CAP), 0x46, 0x04, 0x40, ...bump(I), ...op.set(I), 0x0c, 3, 0x0b, 0x0b);   // the notes are full: stop here
  g.push(...bump(I), ...op.set(I), 0x0c, 0, 0x0b, 0x0b);
  g.push(...op.i32(0), ...op.get(I), 0x36, 2, ...uleb(W.DONE), ...op.get(FOUND));

  const vec = (items) => [...uleb(items.length), ...items.flat()];
  const section = (id, body) => [id, ...uleb(body.length), ...body];
  const name = (s) => [...uleb(s.length), ...Array.from(s, (c) => c.charCodeAt(0))];
  const body = (locals, code) => { const b = [...vec(locals.map(([n, t]) => [...uleb(n), t])), ...code, 0x0b]; return [...uleb(b.length), ...b]; };
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec([[0x60, 0, 0], [0x60, 3, 0x7f, 0x7f, 0x7f, 1, 0x7f]])),     // types: f(), grind(i32, i32, i32) -> i32
    ...section(3, vec([[0], [1]])),
    ...section(5, vec([[0x00, 1]])),                                              // one page of memory
    ...section(7, vec([[...name('memory'), 0x02, 0], [...name('grind'), 0x00, 1]])),
    ...section(10, vec([body([[56, 0x7e], [1, 0x7f]], f), body([[2, 0x7f], [4, 0x7e]], g)])),
  ]);
}
// A grinder like makeGrinder's, on the module above. Each counter the module notes is checked the plain way before it counts, so nothing is sent that the pool would
// refuse. minBits under 8 is left to makeGrinder (the module looks at whole zero bytes).
export function makeWasmGrinder({ day, prefix }) {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(grinderWasm())), mem = new Uint8Array(inst.exports.memory.buffer), words = new Int32Array(inst.exports.memory.buffer);
  words.set(RC, W.RC >> 2);
  const m1 = new Uint8Array(64); m1.set(DEP, 12); m1.set(saltOf(day, prefix, 0), 32); mem.set(m1, W.T1);
  const m2 = new Uint8Array(88); m2[0] = 0xff; m2.set(CX, 1); m2.set(PROXY_INIT_HASH, 53); m2[85] = 0x01; mem.set(m2, W.T2);
  let n = 0;
  function grind(count, minBits) {
    if (minBits < 8) throw new Error('minBits under 8: use makeGrinder');
    const k = Math.min(4, minBits >> 3), mask = k >= 4 ? -1 : (1 << (8 * k)) - 1, found = [];
    for (let left = count; left > 0;) {
      const noted = inst.exports.grind(n, left, mask), walked = words[W.DONE >> 2];
      for (let j = 0; j < noted; j++) { const c = words[(W.OUT >> 2) + j], bits = saltAddress(saltOf(day, prefix, c)).bits; if (bits >= minBits) found.push({ n: c, bits }); }
      n = (n + walked) | 0; left -= walked;
    }
    return found;
  }
  return { grind, saltOf: (c) => saltOf(day, prefix, c), day, at: () => n, wasm: true };
}
// the fastest grinder this place can run
export function bestGrinder(o) { try { if (typeof WebAssembly === 'object') return makeWasmGrinder(o); } catch { /* no WebAssembly here, or it is not allowed */ } return makeGrinder(o); }

// ---- what waits to be sent. The pool takes 64 salts in one send and one send every 20 s from a connection, counts a salt once, and only salts of today or
// yesterday (UTC). Every extra zero bit doubles a share's weight, so the best go first; at most `keep` wait, the weakest beyond that are dropped.
export const SEND_MAX = 64, KEEP_MAX = 640, SEND_EVERY_MS = 21_000;
export const dayOfSalt = (saltHex) => parseInt(saltHex.slice(44, 48), 16);
export function nextBatch(found, today, { max = SEND_MAX, keep = KEEP_MAX } = {}) {
  const d0 = today % 65536, d1 = (today + 65535) % 65536, seen = new Set();
  const live = found.filter((f) => { const d = dayOfSalt(f.salt); if ((d !== d0 && d !== d1) || seen.has(f.salt)) return false; seen.add(f.salt); return true; })
    .sort((a, b) => b.bits - a.bits).slice(0, max + keep);
  return { send: live.slice(0, max), rest: live.slice(max) };
}
