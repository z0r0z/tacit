// Note memos + recovery for the confidential pool. A note's value/blinding/secret
// are sealed to the owner via ECDH (ephemeral · ownerPub), so only the owner can
// open them — and recovery is therefore "from the seed alone": derive the scan
// key from the seed, scan the leaf+memo events, decrypt, and the commitment
// itself authenticates the result (a wrong key decrypts to a (value, blinding)
// whose commitment won't match the leaf). Closes the recover-after-wipe gap.
//
// Deps injected for Node + browser: { secp, sha256 }. Uses the same NUMS H as the
// notes (bulletproofs-plus / confidential-pool), so a recovered (value, blinding)
// recommits to exactly the leaf's (cx, cy).

import { bppGens, G } from './bulletproofs-plus.js';

const MEMO_LEN = 72; // value(8) ‖ blinding(32) ‖ secret(32)

export function makeConfidentialMemo({ secp, sha256 }) {
  const H = bppGens().H;
  const bytesToHex = (b) => Buffer.from(b).toString('hex');
  const hexToBytes = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));
  const beBytes = (n, len) => hexToBytes(BigInt(n).toString(16).padStart(len * 2, '0'));
  const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
  const bToBig = (b) => (b.length ? BigInt('0x' + bytesToHex(b)) : 0n);
  const concat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
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

  // Seal (value, blinding, secret) to ownerPub. ephRand() → a fresh scalar.
  function sealMemo(ownerPubHex, note, ephRand) {
    const e = BigInt(ephRand());
    const shared = pt(ownerPubHex).multiply(e);
    const ss = sha256(compress(shared));
    const plain = concat([beBytes(note.value, 8), beBytes(note.blinding, 32), beBytes(note.secret, 32)]);
    return { ephemeralPub: '0x' + bytesToHex(compress(G.multiply(e))), ciphertext: '0x' + bytesToHex(xor(plain, ss)) };
  }

  // Try to open a memo against a leaf with my private key. Returns the recovered
  // note iff the decrypted (value, blinding) recommits to the leaf's (cx, cy);
  // else null (not mine / garbage). The commitment is the authenticator.
  function openMemo(myPriv, leaf, memo) {
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
    const { cx, cy } = commitXY(value, blinding);
    if (cx !== leaf.cx || cy !== leaf.cy) return null;
    return { value, blinding, secret };
  }

  // Scan leaf+memo events; return the notes recoverable to myPriv that are still
  // active (not in spentNullifiers). nullifierOf maps a recovered secret → ν.
  function scan(myPriv, events, spentNullifiers, nullifierOf) {
    const spent = new Set((spentNullifiers || []).map((n) => n.toLowerCase()));
    const mine = [];
    for (const ev of events) {
      const note = openMemo(myPriv, ev.leaf, ev.memo);
      if (!note) continue;
      const nullifier = nullifierOf(note.secret);
      if (spent.has(nullifier.toLowerCase())) continue;
      mine.push({ ...note, leaf: ev.leaf, leafIndex: ev.leafIndex, nullifier });
    }
    return mine;
  }

  return { sealMemo, openMemo, scan, commitXY };
}
