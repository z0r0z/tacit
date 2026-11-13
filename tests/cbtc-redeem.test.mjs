// dapp/cbtc-redeem.js — the T_CBTC_REDEEM (0x67) builder. Run: node tests/cbtc-redeem.test.mjs
//
// A redeem the guest does not fold burns the notes and reads as a rug, so these tests pin the txid byte order, the exact burn
// sum, the input order, who may fund the commit and the signatures, checking the built bytes with code outside the module:
// the pool's fold mirror, tacit.js's kernel function, a BIP-340 verifier and a hand-written kernel message.
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { secp as vsecp, hmac as vhmac, sha256 as vsha256, concatBytes } from '../dapp/vendor/tacit-deps.min.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeCbtcRedeem, CBTC_ZK_ASSET_ID } from '../dapp/cbtc-redeem.js';
import { classifyConfidentialTx, extractInputs, extractTaprootEnvelope } from '../dapp/burn-deposit-bitcoin.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const _cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
if (!vsecp.etc.hmacSha256Sync) vsecp.etc.hmacSha256Sync = (k, ...m) => vhmac(vsha256, k, concatBytes(...m)); // the wallet's own bundled secp (ECDSA for a P2WPKH input)

let n = 0; const ok = (s) => { console.log('  ✓', s); n++; };
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => { const s = h.replace(/^0x/, ''); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; };
const strip = (h) => String(h).replace(/^0x/, '');
const rev = (h) => strip(h).match(/../g).reverse().join('');
const throws = (fn, re, label) => { let e = null; try { fn(); } catch (x) { e = x; } assert.ok(e, `${label}: should throw`); assert.match(String(e.message), re, `${label}: ${e.message}`); };


// BIP-340 verify, written here so the signature checks do not share code with the module (or bulletproofs.js).
const tagged = (tag, ...m) => { const t = sha256(new TextEncoder().encode(tag)); return sha256(_cat([t, t, ...m])); };
function bip340Verify(sig, msg, pubX) {
  const Nn = secp.CURVE.n, P = secp.ProjectivePoint.fromHex('02' + hex(pubX));
  const r = BigInt('0x' + hex(sig.slice(0, 32))), sc = BigInt('0x' + hex(sig.slice(32)));
  if (sc >= Nn) return false;
  const e = BigInt('0x' + hex(tagged('BIP0340/challenge', sig.slice(0, 32), pubX, msg))) % Nn;
  const R = secp.ProjectivePoint.BASE.multiply(sc).add(P.multiply(e).negate());
  const a = R.toAffine();
  return a.y % 2n === 0n && a.x === r;
}

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const PRIV = new Uint8Array(32).fill(0x22);
const { wallet, prims } = makeBtcWallet({ priv: PRIV, hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => 'x', fetchFeeRate: async () => 3 });
const R = makeCbtcRedeem({ pool, secp, sha256, prims });
const XONLY = hex(wallet.xonly());

const txid = (c) => c.repeat(32);
const lockSpkTweaked = hex(prims.p2trScript(prims.tweakedOutputKey(wallet.xonly(), new Uint8Array(0)).Q_xonly));
const lockSpkWpkh = hex(prims.p2wpkhScript(wallet.pub));
const mkLock = (spk = lockSpkTweaked, value = 100000) => ({ txid: txid('aa'), vout: 1, value, spk });
const mkNotes = () => [
  { txid: txid('bb'), vout: 0, sats: 546, amount: 40000n, blinding: 0x1111111111111111n, assetId: CBTC_ZK_ASSET_ID },
  { txid: txid('cc'), vout: 0, sats: 546, amount: 60000n, blinding: 0x2222222222222222n, assetId: CBTC_ZK_ASSET_ID },
];
const FUNDING = [{ txid: txid('dd'), vout: 0, value: 50000 }];
const build = (over = {}) => R.buildRedeemTxs({ prims, lock: mkLock(), notes: mkNotes(), funding: FUNDING, feeRate: 4, ...over });

// ── 1. a P2TR (key-path) lock: builds, and every check the module ran is also run here without it ──
const built = build();
{
  assert.equal(built.lockKind, 'p2tr-tweaked');
  assert.ok(built.checks.length >= 12, 'the module reports what it checked');
  const cls = classifyConfidentialTx(built.revealHex);
  assert.equal(cls.type, 'cbtc_redeem');
  assert.equal(cls.vBtc, '100000');
  assert.equal(cls.lockVout, 1);
  assert.equal(cls.lockTxid.replace(/^0x/, ''), rev(txid('aa')), 'lock_txid is in raw (reversed) byte order — txid(aa..) is a palindrome so this one is tested below too');
  assert.equal(extractTaprootEnvelope(built.revealHex).replace(/^0x/, '').length, 218, 'a 109-byte envelope sits at vin0');
  ok('the reveal classifies as a cBTC redeem of 100000 sats with a 109-byte envelope at vin0');
}

// ── 2. byte order: a lock txid that is NOT a palindrome must appear reversed in the envelope and the kernel message ──
{
  const odd = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
  const lock = { ...mkLock(), txid: odd };
  const b = build({ lock });
  const cls = classifyConfidentialTx(b.revealHex);
  assert.equal(cls.lockTxid.replace(/^0x/, ''), rev(odd), 'the envelope carries the lock txid as it appears in the transaction (reversed display)');
  const vins = extractInputs(b.revealHex);
  assert.equal(strip(vins[1].prevTxid), rev(odd), 'vin1 is the lock');
  assert.equal(strip(vins[1].prevTxid), strip(cls.lockTxid), 'the envelope matches the input byte for byte');
  ok('lock_txid in the envelope == the txid bytes of vin1 (raw order), for a non-palindromic txid');
}

// ── 2b. optionally export the exact built bytes for tests/cbtc_redeem_js_vector.rs (the guest's own functions) ──
if (process.env.CBTC_REDEEM_VECTOR_OUT) {
  const { writeFileSync } = await import('node:fs');
  const lockTx = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
  const notes = [
    { txid: 'f0e1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddeeff', vout: 0, sats: 546, amount: 40000n, blinding: 0x1111111111111111n },
    { txid: '1f2e3d4c5b6a79880918273645546372819a0b1c2d3e4f5061728394a5b6c7d8', vout: 0, sats: 546, amount: 60000n, blinding: 0x2222222222222222n },
  ];
  const b = build({ lock: { ...mkLock(), txid: lockTx }, notes });
  const { cx: _cx0, cy: _cy0 } = pool.commitXY(notes[0].amount, notes[0].blinding);
  writeFileSync(process.env.CBTC_REDEEM_VECTOR_OUT, JSON.stringify({
    revealHex: b.revealHex, lock: { txid: lockTx, vout: 1, value: 100000 }, authKey: XONLY,
    notes: notes.map((x) => ({ txid: x.txid, vout: x.vout, amount: x.amount.toString(), ...pool.commitXY(x.amount, x.blinding) })),
  }, null, 1));
  ok('exported the built reveal for the Rust cross-check');
}

// ── 3. the kernel message equals cxfer-core\'s (hand-written) and tacit.js\'s computeKernelMsg ──
{
  const noteTxids = ['0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20', 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100'];
  const ins = noteTxids.map((t, i) => ({ txid: t, vout: i + 2 }));
  const mine = R.kernelMsg({ inputs: ins, burned: 100000n });
  // cxfer-core: sha256(DOMAIN ‖ asset ‖ n_in ‖ (txid_raw ‖ vout_LE)×n ‖ n_out=0 ‖ burned_LE8)
  const parts = [new TextEncoder().encode('tacit-kernel-v1'), unhex(CBTC_ZK_ASSET_ID), Uint8Array.of(2)];
  for (const i of ins) { parts.push(unhex(rev(i.txid))); const v = new Uint8Array(4); new DataView(v.buffer).setUint32(0, i.vout, true); parts.push(v); }
  const burn = new Uint8Array(8); new DataView(burn.buffer).setBigUint64(0, 100000n, true);
  parts.push(Uint8Array.of(0), burn);
  assert.equal(hex(mine), hex(sha256(_cat(parts))), 'matches the cxfer-core construction');

  await import('./_domshim.mjs');
  const tacit = await import('../dapp/tacit.js');
  const theirs = tacit.computeKernelMsg(unhex(CBTC_ZK_ASSET_ID), ins.map((i) => ({ txid: i.txid, vout: i.vout })), [], 100000n);
  assert.equal(hex(mine), hex(theirs), 'matches tacit.js computeKernelMsg (the function every mainnet CBURN/CXFER was signed with)');
  ok('the kernel message matches cxfer-core and tacit.js byte for byte, including txid order');
}

// ── 4. signatures verified with noble, not the module's verifier ──
{
  const raw = built.revealHex;
  // Re-derive the prevouts the way an auditor would, from the lock and notes given.
  const lock = mkLock(), notes = mkNotes();
  const vins = extractInputs(raw);
  assert.equal(vins.length, 4, 'commit + lock + 2 notes');
  assert.equal(strip(vins[2].prevTxid), rev(notes[0].txid)); assert.equal(strip(vins[3].prevTxid), rev(notes[1].txid));
  assert.deepEqual(vins.slice(1).map((v) => v.prevVout), [1, 0, 0]);
  // The signature inside the lock input must verify under the lock's tweaked key: run the module's full check with
  // prevouts, then confirm noble agrees on one of them independently.
  const envelopeScript = unhex(built.envelopeScriptHex);
  const leaf = prims.tapLeafHash(envelopeScript);
  const commitSpk = prims.p2trScript(prims.tweakedOutputKey(prims.TAP_NUMS, leaf).Q_xonly);
  const prevouts = [{ value: built.commitValue, script: commitSpk }, { value: lock.value, script: unhex(lock.spk) }, ...notes.map((x) => ({ value: x.sats, script: unhex('5120' + XONLY) }))];
  const v = R.checkRedeemReveal({ prims, revealHex: raw, lock, notes, prevouts, envelopeScript, commitSpk, expectedFee: built.revealFee });
  assert.ok(v.ok, v.problems.join('; '));
  // noble, independent: rebuild the tx object from the hex and verify vin2's key-path signature
  const bytes = unhex(raw);
  const wit = []; // find 64-byte sigs: vin2 and vin3 are the last two witness stacks, each [0x01, 0x40, sig(64)]
  const tail = bytes.slice(bytes.length - 4 - 2 * 66);
  for (let i = 0; i < 2; i++) { assert.equal(tail[i * 66], 1); assert.equal(tail[i * 66 + 1], 64); wit.push(tail.slice(i * 66 + 2, i * 66 + 66)); }
  const txObj = { version: 2, locktime: 0, inputs: vins.map((x) => ({ txid: rev(x.prevTxid), vout: x.prevVout, sequence: 0xfffffffd, witness: [] })), outputs: [{ value: built.outputSats, script: prims.p2wpkhScript(wallet.pub) }] };
  for (let i = 0; i < 2; i++) {
    const sh = prims.tapSighashKeyPath(txObj, 2 + i, prevouts, 0x00);
    assert.ok(bip340Verify(wit[i], sh, wallet.xonly()), `noble verifies the note ${i}'s key-path signature under the key's x-only form`);
  }
  ok('every signature verifies (module check with prevouts) and noble independently verifies the note spends');
}

// ── 5. money: the output returns the lock + the notes\' dust + the commit\'s spare dust; the fee is what the commit funded ──
{
  assert.equal(built.outputSats, 100000 + 2 * 546 + 546);
  const rate = built.revealFee / built.revealVb;
  assert.ok(rate >= 4 && rate < 4.2, `reveal pays ${rate} sat/vB at a 4 sat/vB ask`);
  assert.ok(built.commitFee / built.commitVb >= 4, 'commit pays at least the asked rate');
  ok(`outputs ${built.outputSats} sats; fees ${built.commitFee}+${built.revealFee} at ${built.feeRate} sat/vB`);
}

// ── 6. an early lock held at the key's P2WPKH address ──
{
  const b = build({ lock: mkLock(lockSpkWpkh) });
  assert.equal(b.lockKind, 'p2wpkh');
  assert.equal(classifyConfidentialTx(b.revealHex).type, 'cbtc_redeem');
  ok('a lock at the key\'s P2WPKH address (early locks) builds and passes the fold');
}

// ── 7. things that would forfeit a bond are refused before anything is signed ──
{
  const notes = mkNotes();
  throws(() => build({ notes: [{ ...notes[0], amount: 40001n }, notes[1]] }), /hold 100001 but the lock is 100000/, 'sum off by one (over)');
  throws(() => build({ notes: [{ ...notes[0], amount: 39999n }, notes[1]] }), /hold 99999 but the lock is 100000/, 'sum off by one (under)');
  throws(() => build({ notes: [notes[0]] }), /hold 40000 but the lock/, 'a partial burn');
  throws(() => build({ notes: [{ ...notes[0], assetId: '0x' + '11'.repeat(32) }, notes[1]] }), /not cBTC/, 'wrong asset');
  throws(() => build({ notes: [notes[0], notes[0]] }), /listed twice/, 'duplicate note');
  throws(() => build({ notes: [] }), /at least one cBTC note/, 'no notes');
  throws(() => build({ funding: [{ txid: txid('aa'), vout: 1, value: 90000 }] }), /lock itself was offered as funding/, 'the lock as funding');
  throws(() => build({ funding: [{ txid: txid('bb'), vout: 0, value: 90000 }] }), /note was offered as funding/, 'a note as funding');
  throws(() => build({ funding: [{ txid: txid('ee'), vout: 3, value: 90000 }], protectedOutpoints: [`${txid('ee')}:3`] }), /protected lock was offered as funding/, 'another lock as funding');
  throws(() => build({ lock: { ...mkLock(), spk: '5120' + '11'.repeat(32) } }), /not held by this key/, 'a lock that is not this key\'s');
  throws(() => build({ lock: { ...mkLock(), vout: 0 } }), /at least 1/, 'vout 0 lock');
  throws(() => build({ expectedVBtc: 99999n }), /pool records this lock at 99999/, 'pool value differs from the output');
  throws(() => build({ funding: [{ txid: txid('dd'), vout: 0, value: 300 }] }), /not enough plain bitcoin/, 'too little for fees');
  throws(() => build({ feeRate: 0 }), /at least 1 sat\/vB/, 'zero fee rate');
  throws(() => build({ feeRate: 5000, funding: [{ txid: txid('dd'), vout: 0, value: 5_000_000 }] }), /over the 100000 guard/, 'absurd fee rate');
  throws(() => build({ funding: [] }), /no plain bitcoin/, 'no funding');
  throws(() => build({ notes: [{ ...notes[0], cx: '0x1', cy: '0x2' }, notes[1]] }), /does not reproduce its commitment/, 'a mismatched stored commitment');
  ok('off-by-one burns, wrong asset, duplicate notes, funding from a lock/note, a foreign lock, bad fees: all refused');
}

// ── 8. tampering with a built reveal is caught by the guest\'s own fold ──
{
  const lock = mkLock(), notes = mkNotes();
  const cls = classifyConfidentialTx(built.revealHex);
  const sig = cls.kernelSig.replace(/^0x/, '');
  assert.equal(built.revealHex.split(sig).length, 2, 'the kernel sig appears once in the transaction');
  const flip = (s) => s.slice(0, 10) + (s[10] === 'a' ? 'b' : 'a') + s.slice(11);
  let v = R.checkRedeemReveal({ revealHex: built.revealHex.replace(sig, flip(sig)), lock, notes });
  assert.ok(!v.ok && v.problems.some((p) => /REJECTS/.test(p)), 'a forged kernel signature is rejected');
  // the burn value (v_btc, 8 bytes LE at byte 37 of the frame = hex offset 74) changed: 100000 -> 100001
  const env = extractTaprootEnvelope(built.revealHex).replace(/^0x/, '');
  assert.equal(env.slice(74, 90), 'a086010000000000', 'v_btc = 100000 little-endian');
  const bad = env.slice(0, 74) + 'a186010000000000' + env.slice(90);
  v = R.checkRedeemReveal({ revealHex: built.revealHex.replace(env, bad), lock, notes });
  assert.ok(!v.ok && v.problems.some((p) => /burns 100001/.test(p)), 'a changed burn value is rejected');
  // notes handed to the checker in a different order than the transaction spends them
  v = R.checkRedeemReveal({ revealHex: built.revealHex, lock, notes: [notes[1], notes[0]] });
  assert.ok(!v.ok && v.problems.some((p) => /kernel's order/.test(p)), 'a different note order is flagged');
  // a lock named in DISPLAY order instead of raw order (the easy mistake)
  const odd = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'; // txid(aa..) is a palindrome, so use this one
  const b = build({ lock: { ...mkLock(), txid: odd } });
  const wrongEnv = extractTaprootEnvelope(b.revealHex).replace(/^0x/, '');
  const swapped = wrongEnv.slice(0, 2) + odd + wrongEnv.slice(66);
  v = R.checkRedeemReveal({ revealHex: b.revealHex.replace(wrongEnv, swapped), lock: { ...mkLock(), txid: odd }, notes });
  assert.ok(!v.ok, 'a lock txid in display order is rejected');
  ok('a forged kernel signature, a changed burn value, a reordered note list and a display-order lock txid are all caught');
}

// ── 9. the pool\'s and chain\'s verdict before sending ──
{
  const lock = mkLock();
  const live = { vBtc: 100000n, spent: false, redeemed: false, minted: true };
  const good = [{ confirmed: true, credited: true, live: true }, { confirmed: true, credited: null, live: true }];
  assert.ok(R.assessRedeem({ lock, lockState: live, unspent: { lock: true, notes: [true, true] }, notes: good }).ok);
  const bad = (over, re) => { const r = R.assessRedeem({ lock, lockState: live, unspent: { lock: true, notes: [true, true] }, notes: good, ...over }); assert.ok(!r.ok && r.problems.some((p) => re.test(p)), JSON.stringify(r)); };
  bad({ lockState: { ...live, redeemed: true } }, /already redeemed/);
  bad({ lockState: { ...live, spent: true } }, /already spent on Bitcoin/);
  bad({ lockState: { ...live, minted: false } }, /nothing to burn/);
  bad({ lockState: { ...live, vBtc: 90000n } }, /records this lock at 90000/);
  bad({ lockState: null }, /no record of this lock/);
  bad({ unspent: { lock: false, notes: [true, true] } }, /lock output is already spent/);
  bad({ unspent: { lock: true, notes: [true, false] } }, /cBTC note is already spent/);
  bad({ notes: [{ confirmed: true, credited: false, live: true }, good[1]] }, /not the transaction recorded for its bridge/);
  bad({ notes: [{ confirmed: false, credited: true, live: true }, good[1]] }, /not confirmed/);
  bad({ notes: [{ confirmed: true, credited: true, live: false }, good[1]] }, /not held by Bitcoin's proof on Ethereum, so/);
  bad({ notes: [{ confirmed: true, credited: true, live: null }, good[1]] }, /not held by Bitcoin's proof on Ethereum yet/);
  bad({ notes: [{ confirmed: true, credited: true }, good[1]] }, /not held by Bitcoin's proof on Ethereum yet/);
  assert.ok(R.assessRedeem({ lock, lockState: { ...live, minted: false }, unspent: { lock: true, notes: [true, true] }, notes: good, force: true }).ok, 'force lets an unminted lock through');
  ok('assessRedeem refuses redeemed/spent/unminted/mis-sized locks, spent notes, and notes the proof does not hold');
}

// ── 9b. choosing notes that sum to exactly the lock ──
{
  const mk = (amount, extra = {}) => ({ amount: BigInt(amount), credited: true, confirmed: true, live: true, assetId: CBTC_ZK_ASSET_ID, ...extra });
  const sum = (l) => l.reduce((s, x) => s + x.amount, 0n);
  const one = R.pickNotes([mk(30000), mk(100000), mk(70000)], 100000n);
  assert.equal(one.length, 1, 'a single exact note wins over a pair');
  const pair = R.pickNotes([mk(30000), mk(70000), mk(55000)], 100000n);
  assert.equal(sum(pair), 100000n); assert.equal(pair.length, 2);
  const three = R.pickNotes([mk(25000), mk(35000), mk(40000), mk(99999)], 100000n);
  assert.equal(sum(three), 100000n); assert.equal(three.length, 3);
  assert.equal(R.pickNotes([mk(60000), mk(50000)], 100000n), null, 'no exact subset: null, never a near miss');
  assert.equal(R.pickNotes([mk(100000, { credited: false })], 100000n), null, 'a mint that is not the one recorded for its bridge is never spent');
  assert.equal(R.pickNotes([mk(100000, { credited: null })], 100000n).length, 1, 'a note the proof holds is spendable whether or not the relay has decided its credit');
  assert.equal(R.pickNotes([mk(100000, { confirmed: false })], 100000n), null, 'an unconfirmed note is not spendable yet');
  assert.equal(R.pickNotes([mk(100000, { live: false })], 100000n), null, 'a note the proof passed but does not hold is never spent');
  assert.equal(R.pickNotes([mk(100000, { live: null })], 100000n), null, 'a note the proof has not reached yet waits for it');
  assert.equal(R.pickNotes([mk(100000, { live: undefined })], 100000n), null, 'a note whose standing in the proof could not be read is not spent');
  assert.equal(R.pickNotes([mk(100000, { assetId: '0x' + '11'.repeat(32) })], 100000n), null, 'another asset is ignored');
  assert.equal(R.pickNotes([mk(100000, { amount: null })], 100000n), null, 'a note whose amount could not be opened is ignored');
  const many = Array.from({ length: 20 }, (_, i) => mk(1000 + i));
  assert.equal(R.pickNotes(many, 5n), null, 'twenty notes, no subset: finishes');
  ok('pickNotes finds the fewest notes that sum exactly, and nothing when none do');
}

// ── 9c. planRedeem: the next step, from facts ──
{
  const live = { vBtc: 100000n, spent: false, redeemed: false, minted: true };
  const note = (amount, extra = {}) => ({ amount: BigInt(amount), credited: true, confirmed: true, live: true, assetId: CBTC_ZK_ASSET_ID, ...extra });
  const plan = (o) => R.planRedeem({ lockState: live, fee: 2000n, min: 10000n, cap: 50_000_000n, held: 0n, ...o });
  assert.equal(plan({ lockState: null }).step, 'unknown');
  assert.equal(plan({ lockState: { ...live, redeemed: true } }).step, 'done');
  assert.equal(plan({ lockState: { ...live, spent: true } }).step, 'gone');
  assert.equal(plan({ lockState: { ...live, minted: false } }).step, 'unminted');
  assert.equal(plan({ notes: [note(100000)] }).step, 'ready');
  assert.equal(plan({ notes: [note(40000), note(60000)] }).notes.length, 2, 'two notes that sum exactly are both used');
  assert.equal(plan({ notes: [note(100000, { credited: false })], bridging: 1 }).step, 'arriving');
  assert.equal(plan({ notes: [note(100000, { live: null })], held: 200000n }).step, 'arriving', 'a note the proof has not reached is waited for, not bridged again');
  assert.equal(plan({ notes: [note(100000, { live: null, credited: null, confirmed: false })], held: 200000n }).step, 'arriving', 'so is one still confirming');
  assert.equal(plan({ notes: [note(100000, { live: false })], held: 200000n }).step, 'bridge', 'an output the proof passed and does not hold is not waited for');
  assert.equal(plan({ notes: [note(100000, { live: null, credited: false })], held: 200000n }).step, 'bridge', 'nor a mint that is not the one recorded for its bridge');
  { const q = plan({ notes: [note(60000), note(40000, { live: null })], held: 200000n }); assert.deepEqual([q.step, q.have], ['arriving', 60000n], 'what the proof already holds is counted while the rest arrives'); }
  let p = plan({ held: 200000n });
  assert.deepEqual([p.step, p.short, p.bridge], ['bridge', 100000n, 102000n], 'nothing on Bitcoin: bridge the lock plus the fee');
  p = plan({ held: 50000n });
  assert.deepEqual([p.step, p.lack], ['buy', 52000n], 'short of cBTC: say by how much');
  p = plan({ notes: [note(60000)], held: 200000n });
  assert.deepEqual([p.step, p.short, p.bridge], ['bridge', 40000n, 42000n], 'part is already on Bitcoin: bridge only the rest');
  p = plan({ notes: [note(99000)], held: 200000n });
  assert.deepEqual([p.step, p.short, p.bridge], ['bridge', 100000n, 102000n], 'a remainder under the minimum cannot be bridged alone: bridge the lock again');
  p = plan({ cap: 50000n, held: 10n ** 9n });
  assert.equal(p.step, 'toobig');
  assert.equal(R.bestSubsetSum([30000n, 50000n, 70000n], 100000n), 100000n);
  assert.equal(R.bestSubsetSum([60000n, 50000n], 100000n), 60000n);
  ok('planRedeem picks done/gone/unminted/ready/arriving/bridge/buy/toobig and sizes the bridge');
}

// ── 9d. a transaction read back from Bitcoin: is it a redeem of this lock ──
{
  assert.equal(R.redeems(built.revealHex, mkLock()), true);
  assert.equal(R.redeems('0x' + built.revealHex, { txid: txid('aa'), vout: 1 }), true);
  assert.equal(R.redeems(built.revealHex, { txid: txid('aa'), vout: 2 }), false, 'another output of the same transaction');
  assert.equal(R.redeems(built.revealHex, { txid: txid('ab'), vout: 1 }), false, 'another lock');
  assert.equal(R.redeems(built.commitHex, mkLock()), false, 'the commit carries no envelope');
  const odd = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
  assert.equal(R.redeems(build({ lock: { ...mkLock(), txid: odd } }).revealHex, { txid: odd, vout: 1 }), true, 'a lock txid is matched in display order');
  ok('redeems() tells a redeem of this lock from any other spend');
}

// ── 10. send(): commit first, nothing at all if an input is already gone ──
{
  const sent = [];
  const out = await R.send({ built, broadcast: async (h) => { sent.push(h); return 'x'; }, isUnspent: async () => true });
  assert.deepEqual(sent, [built.commitHex, built.revealHex], 'commit, then reveal');
  const sentR = [];
  await R.send({ built, broadcast: async () => { throw new Error('plain broadcast must not be used when a retrying one is given'); }, broadcastWithRetry: async (h) => { sentR.push(h); return null; }, isUnspent: async () => true });
  assert.deepEqual(sentR, [built.commitHex, built.revealHex], 'with the retrying form both go through it, so a repeat after a failed reveal is safe');
  assert.equal(out.revealTxid, built.revealTxid);
  const sent2 = [];
  await assert.rejects(R.send({ built, broadcast: async (h) => { sent2.push(h); }, isUnspent: async (t) => t !== txid('bb') }), /already spent; nothing was broadcast/);
  assert.equal(sent2.length, 0, 'an already-spent note stops the send before the commit');
  ok('send broadcasts commit then reveal, and nothing when an input is already spent');
}

console.log(`cbtc-redeem: ${n} groups passed`);
process.exit(0); // tacit.js leaves timers alive
