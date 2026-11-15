// The first half of opening a note memo: decrypt it with my key and check the owner it names is one this key can spend.
// That half is one point multiplication (a few milliseconds), the rest of opening a memo (the commitment, the leaf hash) is
// only done for a memo that passes it, which is almost none of a pool's. confidential-memo.js's openMemo uses this, and so
// does the worker that tries a pool's memos off the page's thread (confidential-memo-worker.js): one definition, so the
// worker can never rule out a memo openMemo would open.
//
// Deps injected for Node, the page and the worker: { secp, sha256, keccak256 }.

const MEMO_LEN = 136; // value(8) ‖ blinding(32) ‖ secret(32) ‖ asset(32) ‖ owner(32)

export function makeMemoProbe({ secp, sha256, keccak256 }) {
  const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const hexToBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
  const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
  const bToBig = (b) => (b.length ? BigInt('0x' + bytesToHex(b)) : 0n);
  const concat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const b32 = (h) => { const b = hexToBytes(h); if (b.length > 32) throw new Error('over 32 bytes'); const o = new Uint8Array(32); o.set(b, 32 - b.length); return o; };
  const pt = (hex) => secp.ProjectivePoint.fromHex(String(hex).replace(/^0x/, ''));
  const compress = (P) => P.toRawBytes(true);

  const keystream = (ss, len) => {
    const out = new Uint8Array(len);
    let off = 0, c = 0;
    while (off < len) { const blk = sha256(concat([ss, Uint8Array.of(c & 0xff)])); out.set(blk.subarray(0, Math.min(32, len - off)), off); off += 32; c++; }
    return out;
  };
  const xor = (data, ss) => { const k = keystream(ss, data.length); const o = new Uint8Array(data.length); for (let i = 0; i < data.length; i++) o[i] = data[i] ^ k[i]; return o; };

  // owner = keccak(nk ‖ "tacit-native-owner-v1") — mirror of confidential-pool.nkToOwner() and the guest.
  const NATIVE_OWNER_DOM = new TextEncoder().encode('tacit-native-owner-v1');
  const nkToOwner = (nk) => '0x' + bytesToHex(keccak256(concat([b32(nk), NATIVE_OWNER_DOM])));

  // A receive memo carries, where a note's nk goes, a tag and the receive index the receiver derives that nk from.
  const RECEIVE_TAG = sha256(new TextEncoder().encode('tacit-receive-memo-v1')).subarray(0, 24);
  const receiveIndexOf = (s) => (s.subarray(0, 24).every((x, i) => x === RECEIVE_TAG[i]) ? Number(bToBig(s.subarray(24, 32))) : null);

  // Wire form for the on-chain `bytes` memo: ephemeralPub(33) ‖ ciphertext(136).
  function decodeMemo(hex) {
    const b = hexToBytes(hex);
    if (b.length !== 33 + MEMO_LEN) return null;
    return { ephemeralPub: '0x' + bytesToHex(b.subarray(0, 33)), ciphertext: '0x' + bytesToHex(b.subarray(33)) };
  }

  // The memo as my key reads it, or null if it is not one I could own: not a memo, or one whose owner is not bound to the
  // secret it carries (noise from a memo that is not mine fails that in one hash). The leaf is not looked at here.
  // May throw on a malformed memo; callers that must be total (openMemo, the worker) catch.
  function unseal(myPriv, memo) {
    if (typeof memo === 'string') { memo = decodeMemo(memo); if (!memo) return null; }
    if (!memo || typeof memo !== 'object') return null;
    const shared = pt(memo.ephemeralPub).multiply(BigInt(myPriv));
    const ss = sha256(compress(shared));
    const plain = xor(hexToBytes(memo.ciphertext), ss);
    if (plain.length !== MEMO_LEN) return null;
    const value = bToBig(plain.subarray(0, 8));
    const blinding = beHex(bToBig(plain.subarray(8, 40)));
    const secret = '0x' + bytesToHex(plain.subarray(40, 72));
    const asset = '0x' + bytesToHex(plain.subarray(72, 104));
    const owner = '0x' + bytesToHex(plain.subarray(104, 136));
    const receiveIndex = BigInt(owner) !== 0n ? receiveIndexOf(plain.subarray(40, 72)) : null;
    if (BigInt(owner) !== 0n && receiveIndex == null && nkToOwner(secret) !== owner.toLowerCase()) return null;
    return { value, blinding, secret, asset, owner, receiveIndex };
  }

  // Could this memo be mine? Never false for a memo openMemo would open; true is only "worth opening in full".
  function maybeMine(myPriv, memo) {
    try { return !!unseal(myPriv, memo); } catch { return false; }
  }

  return { unseal, maybeMine, decodeMemo, RECEIVE_TAG, receiveIndexOf };
}
