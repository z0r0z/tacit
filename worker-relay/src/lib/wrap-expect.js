// A plain wrap's program input read the way the proof pool reads it, and what its proof must commit to (the board's community check, board-check.js). This is a
// copy of worker/src/proof-pool.js from the comment above readWrapStdin through proofFits, because the settle relay's image holds only this directory;
// tests/wrap-expect-parity.test.mjs holds the two identical.
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';

// The wrap a program input asks for, read back from its bytes, or an Error saying why it is not one wrap as exec-wrap.rs writes it.
// The bytes are bincode of SP1Stdin { buffer, ptr, proofs } (dapp/sp1-stdin.js): a u64 count of entries, each a u64 length and its
// bytes, then ptr and proofs, both 0. A wrap's sixteen entries: the chain binding, five roots (all zero: a wrap proves against
// none), one op, OP_WRAP, the asset, the value, the commitment (cx, cy), the owner, the opening signature (R, z) and one memo hash.
// Each Vec<u8> entry is itself bincode (a u64 length, then the bytes); the integers are little-endian.
export function readWrapStdin(bytes) {
  let off = 0;
  const u64 = () => {
    if (off + 8 > bytes.length) throw new Error('the input ends early');
    let x = 0n;
    for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(bytes[off + i]);
    off += 8;
    return x;
  };
  if (u64() !== 16n) throw new Error('a wrap\'s input has sixteen entries (one wrap, one memo hash)');
  const e = [];
  for (let i = 0; i < 16; i++) {
    const len = u64();
    if (len > BigInt(bytes.length - off)) throw new Error('the input ends early');
    e.push(bytes.subarray(off, off + Number(len)));
    off += Number(len);
  }
  if (u64() !== 0n || u64() !== 0n || off !== bytes.length) throw new Error('the input must end with no pointer, no proofs and nothing after');
  const vec = (i, n, what) => {
    const b = e[i];
    if (b.length !== 8 + n || b[0] !== n || b.subarray(1, 8).some((x) => x)) throw new Error(`${what} must be ${n} bytes`);
    return b.subarray(8);
  };
  const chainBinding = vec(0, 32, 'the chain binding');
  for (let i = 1; i <= 5; i++) if (vec(i, 32, 'a root').some((x) => x)) throw new Error('a wrap proves against no root, so its roots are zero');
  if (e[6].length !== 4 || e[6][0] !== 1 || e[6][1] || e[6][2] || e[6][3]) throw new Error('the input must hold one op');
  if (e[7].length !== 1 || e[7][0] !== 0) throw new Error('the op must be a wrap (OP_WRAP)');
  const asset = vec(8, 32, 'the asset');
  if (e[9].length !== 8) throw new Error('the value must be a u64');
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(e[9][i]);
  const cx = vec(10, 32, 'cx'), cy = vec(11, 32, 'cy'), owner = vec(12, 32, 'the owner');
  vec(13, 33, 'the signature\'s R'); vec(14, 32, 'the signature\'s z');
  const memoHash = vec(15, 32, 'the memo hash');
  return { chainBinding, asset, value, cx, cy, owner, memoHash };
}

// What a wrap's proof must commit to, from the wrap itself (dapp/confidential-pool.js leaf, depositId; cxfer-core memo_root): the
// leaf keccak(asset ‖ cx ‖ cy ‖ owner), the deposit keccak(asset ‖ value as 32 bytes ‖ keccak(cx ‖ cy ‖ owner)), the chain binding,
// and the memo root keccak(0³² ‖ memo hash).
export function wrapExpect(w) {
  const k = (...parts) => keccak_256(concatBytes(...parts));
  const be32 = (n) => { const b = new Uint8Array(32); let x = n; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
  const hx = (b) => '0x' + bytesToHex(b);
  return {
    depositId: hx(k(w.asset, be32(w.value), k(w.cx, w.cy, w.owner))),
    leaf: hx(k(w.asset, w.cx, w.cy, w.owner)),
    chainBinding: hx(w.chainBinding),
    memoRoot: hx(k(new Uint8Array(32), w.memoHash)),
  };
}

// Whether public values are this wrap's, read as the page reads them (confidential-pool-ux.js wrapProofFits): abi.encode of
// ConfidentialPool.PublicValues, a tuple whose field k sits in word 1 + k, so word 2 is the chain binding, words 5 and 6 point at
// `leaves` and `depositsConsumed`, and word 28 is the memo root. It consumes exactly this deposit and inserts exactly this leaf,
// for the chain and the memos its input named: any other proof, however valid, is not this job's.
export function proofFits(publicValues, expect) {
  try {
    const h = String(publicValues).replace(/^0x/, '').toLowerCase();
    if (!h.length || h.length % 64 || !/^[0-9a-f]+$/.test(h)) return false;
    const n = h.length / 64;
    const word = (i) => { if (!(i >= 0 && i < n)) throw new Error('short'); return '0x' + h.slice(i * 64, i * 64 + 64); };
    const w = (i) => BigInt(word(i));
    if (w(0) !== 32n) return false;
    const list = (head) => {
      const at = 1n + w(head) / 32n, len = w(Number(at));
      if (w(head) % 32n || at + 1n + len > BigInt(n)) throw new Error('short');
      return Array.from({ length: Number(len) }, (_, k) => word(Number(at) + 1 + k));
    };
    const lc = (x) => String(x).toLowerCase();
    const leaves = list(5), deposits = list(6);
    return leaves.length === 1 && leaves[0] === lc(expect.leaf) && deposits.length === 1 && deposits[0] === lc(expect.depositId)
      && word(2) === lc(expect.chainBinding) && word(28) === lc(expect.memoRoot);
  } catch { return false; }
}
