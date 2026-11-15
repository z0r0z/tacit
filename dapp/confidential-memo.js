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

import { bppH, G } from './bulletproofs-plus.js';
import { makeMemoProbe } from './confidential-memo-probe.js';

export function makeConfidentialMemo({ secp, sha256, keccak256 }) {
  const H = bppH();
  const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const hexToBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
  const beBytes = (n, len) => hexToBytes(BigInt(n).toString(16).padStart(len * 2, '0'));
  const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
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
  // The decrypt-and-owner-check half of opening a memo is shared with the worker that tries a pool's memos off the page's thread.
  const { unseal, decodeMemo, RECEIVE_TAG } = makeMemoProbe({ secp, sha256, keccak256 });

  // A receive memo: a payment to an owner the receiver gave out (its receive code) carries, where a note's nk goes, a tag and the receive
  // index the receiver derives that nk from. The sender never knows the nk, so only the receiver can spend the note. openMemo returns such
  // an opening with `receiveIndex` and no secret: the leaf still authenticates value, blinding, asset and owner, and the wallet, which holds
  // the spend key, derives the nk for that index and keeps the note only if it hashes to the owner.
  const receiveSecret = (index) => '0x' + bytesToHex(RECEIVE_TAG) + BigInt(index).toString(16).padStart(16, '0');

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

  // Try to open a memo against an on-chain leaf hash with my private key. Returns
  // the recovered opening iff the decrypted fields rehash to `leaf`; else null
  // (not mine / garbage / tampered). The leaf hash is the authenticator for
  // (value, blinding, asset, owner) but not for `secret`, so an owned note (non-zero
  // owner) is also rejected unless its secret is the nk that owner commits to: a memo
  // whose nk was garbled would otherwise look recovered and never spend.
  // Total: any memo, however malformed, yields null rather than an exception, so one unparseable memo can
  // never abort a scan over the rest of the chain's memos.
  function openMemo(myPriv, leaf, memo) {
    try {
      const u = unseal(myPriv, memo);
      if (!u) return null;
      const { value, blinding, secret, asset, owner, receiveIndex } = u;
      // The decrypted value/blinding are sender-chosen for a memo sealed to my public key: a zero or
      // out-of-range scalar has no commitment, so it is not an opening of any leaf.
      const { cx, cy } = commitXY(value, blinding);
      if (leafHash(asset, cx, cy, owner).toLowerCase() !== String(leaf).toLowerCase()) return null;
      if (receiveIndex != null) return { value, blinding, secret: null, receiveIndex, asset, owner, cx, cy };
      return { value, blinding, secret, asset, owner, cx, cy };
    } catch { return null; }
  }

  // Scan on-chain leaf+memo events; return the notes recoverable to myPriv that
  // are still active (not in spentNullifiers). Each event is {leaf, leafIndex,
  // memo} as emitted by LeavesInserted. nullifierOf maps a note's (Cx,Cy) → ν
  // (note-bound, spec B3).
  // `nullifierOf(note, leaf)` maps a RECOVERED note + its on-chain leaf to the ν the chain records for it.
  // It must mirror the guest's native_nu: a zero-owner note is a bearer note (leaf-bound ν), otherwise ν
  // binds the note's secret nk. Getting this wrong does not lose funds but does silently break the balance:
  // a ν that matches nothing on-chain means spent notes are never filtered and keep being offered to spend.
  function scan(myPriv, events, spentNullifiers, nullifierOf) {
    const spent = new Set((spentNullifiers || []).map((n) => n.toLowerCase()));
    const mine = [];
    for (const ev of events) {
      try {
        const note = openMemo(myPriv, ev && ev.leaf, ev && ev.memo);
        if (!note) continue;
        const nullifier = nullifierOf(note, ev.leaf);
        if (spent.has(nullifier.toLowerCase())) continue;
        mine.push({ ...note, leaf: ev.leaf, leafIndex: ev.leafIndex, nullifier });
      } catch { /* an event that cannot be processed is skipped; the rest of the scan continues */ }
    }
    return mine;
  }

  // `scan` in slices: a pool's memos are thousands of point multiplications, so the thread is handed back every `sliceMs`. Whether a
  // memo is a key's own is fixed by the key and the memo, so one found not to be is not tried again by a later scan of the same key;
  // a memo that opened is opened again. What is kept is a hash of each memo and a yes or no, no key and no opening.
  const _tried = new Map();                                    // key id -> Map(memo and leaf hash -> was it mine)
  const TRIED_CAP = 200000;
  const utf8 = new TextEncoder();
  // A message to oneself yields like a timer but is not slowed to a second a turn in a background tab.
  const handBack = () => new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') return setTimeout(resolve, 0);
    const c = new MessageChannel();
    c.port1.onmessage = () => { c.port1.close(); resolve(); };
    c.port2.postMessage(0);
  });
  // `covered` ({ upTo, mine }): an earlier scan of these same leaves and memos below `upTo` found the key's own at leaf indices `mine`
  // (the caller has checked the list is unchanged), so the rest below `upTo` are not tried.
  // `filter` (key, memos) -> Promise<Int8Array | null>: a way to rule out many memos at once, off this thread (workers running the probe,
  // confidential-memo-workers.js). One entry per memo asked about: 0 it is not the key's, 1 it may be, -1 not known. A memo it does not
  // rule out is opened here in full, exactly as without it, so a filter that is slow, fails, or says nothing changes what is found
  // only in how long it takes.
  async function scanSliced(myPriv, events, spentNullifiers, nullifierOf, { sliceMs = 12, covered = null, filter = null } = {}) {
    const known = covered ? new Set(covered.mine) : null;
    const spent = new Set((spentNullifiers || []).map((n) => n.toLowerCase()));
    const kid = bytesToHex(sha256(utf8.encode('tacit-memo-tried-v1:' + String(myPriv).toLowerCase())));
    let tried = _tried.get(kid);
    if (!tried || tried.size > TRIED_CAP) _tried.set(kid, tried = new Map());
    const mine = [];
    let t0 = Date.now();
    const plan = [];
    for (const ev of events) {
      if (Date.now() - t0 > sliceMs) { await handBack(); t0 = Date.now(); }
      try {
        if (known && ev && Number(ev.leafIndex) < covered.upTo && !known.has(Number(ev.leafIndex))) continue;
        const m = ev && ev.memo, text = typeof m === 'string' ? m : null;
        const id = text && text.length > 2 ? bytesToHex(sha256(utf8.encode(String(ev.leaf).toLowerCase() + '|' + text))).slice(0, 32) : null;
        if (id && tried.get(id) === false) continue;
        plan.push({ ev, m, text, id, said: -1 });
      } catch { /* an event that cannot be processed is skipped; the rest of the scan continues */ }
    }
    if (filter) {
      const asked = plan.filter((p) => p.id);
      if (asked.length) {
        let said = null;
        try { said = await filter(myPriv, asked.map((p) => p.text)); } catch { said = null; }
        if (said && said.length === asked.length) asked.forEach((p, i) => { p.said = said[i]; });
      }
    }
    for (const { ev, m, id, said } of plan) {
      if (Date.now() - t0 > sliceMs) { await handBack(); t0 = Date.now(); }
      try {
        if (id && tried.get(id) === false) continue;
        if (id && said === 0) { tried.set(id, false); continue; }
        const note = openMemo(myPriv, ev && ev.leaf, m);
        if (id) tried.set(id, !!note);
        if (!note) continue;
        const nullifier = nullifierOf(note, ev.leaf);
        if (spent.has(nullifier.toLowerCase())) continue;
        mine.push({ ...note, leaf: ev.leaf, leafIndex: ev.leafIndex, nullifier });
      } catch { /* an event that cannot be processed is skipped; the rest of the scan continues */ }
    }
    return mine;
  }

  return { sealMemo, openMemo, scan, scanSliced, commitXY, leafHash, encodeMemo, decodeMemo, receiveSecret };
}
