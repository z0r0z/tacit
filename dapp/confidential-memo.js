// Note memos + recovery for the confidential pool. A note's full opening
// (value, blinding, secret, asset, owner) is sealed to the owner via ECDH
// (ephemeral · ownerPub), so only the owner can open it — and recovery is
// therefore "from the seed alone": derive the scan key from the seed, scan the
// on-chain leaf+memo events, decrypt, and the *leaf hash itself* authenticates
// the result. A wrong key, or a tampered memo, decrypts to an opening whose
// recomputed leaf keccak(asset ‖ Cx ‖ Cy ‖ owner) won't match the on-chain leaf,
// so it's rejected. Closes the recover-after-wipe gap for the EVM pool.
//
// Deps injected for Node + browser: { secp, sha256, keccak256 }. Uses the same
// NUMS H as the notes (bulletproofs-plus / confidential-pool) and the same leaf
// layout as the contract + guest, so a recovered opening recommits and rehashes
// to exactly the on-chain leaf.

import { bppGens, G } from './bulletproofs-plus.js';

const MEMO_LEN = 136; // value(8) ‖ blinding(32) ‖ secret(32) ‖ asset(32) ‖ owner(32)

export function makeConfidentialMemo({ secp, sha256, keccak256 }) {
  const H = bppGens().H;
  const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const hexToBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
  const beBytes = (n, len) => hexToBytes(BigInt(n).toString(16).padStart(len * 2, '0'));
  const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
  const bToBig = (b) => (b.length ? BigInt('0x' + bytesToHex(b)) : 0n);
  const concat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const b32 = (h) => { const b = hexToBytes(h); if (b.length > 32) throw new Error('over 32 bytes'); const o = new Uint8Array(32); o.set(b, 32 - b.length); return o; };
  const u8 = (x) => Uint8Array.of(x);
  const pt = (hex) => secp.ProjectivePoint.fromHex(String(hex).replace(/^0x/, ''));
  const compress = (P) => P.toRawBytes(true);

  const keystream = (ss, len) => {
    const out = new Uint8Array(len);
    let off = 0, c = 0;
    while (off < len) { const blk = sha256(concat([ss, u8(c & 0xff)])); out.set(blk.subarray(0, Math.min(32, len - off)), off); off += 32; c++; }
    return out;
  };
  const xor = (data, ss) => { const k = keystream(ss, data.length); const o = new Uint8Array(data.length); for (let i = 0; i < data.length; i++) o[i] = data[i] ^ k[i]; return o; };
  const commitXY = (value, blinding) => { const a = H.multiply(BigInt(value)).add(G.multiply(BigInt(blinding))).toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
  // leaf = keccak(asset ‖ Cx ‖ Cy ‖ owner) — mirror of confidential-pool.leaf() and the contract.
  const leafHash = (asset, cx, cy, owner) => '0x' + bytesToHex(keccak256(concat([b32(asset), b32(cx), b32(cy), b32(owner)])));

  // Seal a note's opening to ownerPub. note = {value, blinding, secret, asset,
  // owner}; ephRand() → a fresh scalar.
  function sealMemo(ownerPubHex, note, ephRand) {
    const e = BigInt(ephRand());
    const shared = pt(ownerPubHex).multiply(e);
    const ss = sha256(compress(shared));
    const plain = concat([beBytes(note.value, 8), beBytes(note.blinding, 32), beBytes(note.secret, 32), b32(note.asset), b32(note.owner)]);
    return { ephemeralPub: '0x' + bytesToHex(compress(G.multiply(e))), ciphertext: '0x' + bytesToHex(xor(plain, ss)) };
  }

  // Wire form for the on-chain `bytes` memo: ephemeralPub(33) ‖ ciphertext(136).
  function encodeMemo(memo) { return '0x' + String(memo.ephemeralPub).replace(/^0x/, '') + String(memo.ciphertext).replace(/^0x/, ''); }
  function decodeMemo(hex) {
    const b = hexToBytes(hex);
    if (b.length !== 33 + MEMO_LEN) return null;
    return { ephemeralPub: '0x' + bytesToHex(b.subarray(0, 33)), ciphertext: '0x' + bytesToHex(b.subarray(33)) };
  }

  // Try to open a memo against an on-chain leaf hash with my private key. Returns
  // the recovered opening iff the decrypted fields rehash to `leaf`; else null
  // (not mine / garbage / tampered). The leaf hash is the authenticator.
  function openMemo(myPriv, leaf, memo) {
    if (typeof memo === 'string') { memo = decodeMemo(memo); if (!memo) return null; }
    let plain;
    try {
      const shared = pt(memo.ephemeralPub).multiply(BigInt(myPriv));
      const ss = sha256(compress(shared));
      plain = xor(hexToBytes(memo.ciphertext), ss);
    } catch { return null; }
    if (plain.length !== MEMO_LEN) return null;
    const value = bToBig(plain.subarray(0, 8));
    const blinding = beHex(bToBig(plain.subarray(8, 40)));
    const secret = '0x' + bytesToHex(plain.subarray(40, 72));
    const asset = '0x' + bytesToHex(plain.subarray(72, 104));
    const owner = '0x' + bytesToHex(plain.subarray(104, 136));
    const { cx, cy } = commitXY(value, blinding);
    if (leafHash(asset, cx, cy, owner).toLowerCase() !== String(leaf).toLowerCase()) return null;
    return { value, blinding, secret, asset, owner, cx, cy };
  }

  // Scan on-chain leaf+memo events; return the notes recoverable to myPriv that
  // are still active (not in spentNullifiers). Each event is {leaf, leafIndex,
  // memo} as emitted by LeavesInserted. nullifierOf maps a note's (Cx,Cy) → ν
  // (note-bound, spec B3).
  function scan(myPriv, events, spentNullifiers, nullifierOf) {
    const spent = new Set((spentNullifiers || []).map((n) => n.toLowerCase()));
    const mine = [];
    for (const ev of events) {
      const note = openMemo(myPriv, ev.leaf, ev.memo);
      if (!note) continue;
      const nullifier = nullifierOf(note.cx, note.cy);
      if (spent.has(nullifier.toLowerCase())) continue;
      mine.push({ ...note, leaf: ev.leaf, leafIndex: ev.leafIndex, nullifier });
    }
    return mine;
  }

  return { sealMemo, openMemo, scan, commitXY, leafHash, encodeMemo, decodeMemo };
}
