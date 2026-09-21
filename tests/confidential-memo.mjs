#!/usr/bin/env node
// Validates note memos + recovery (dapp/confidential-memo.js): the owner recovers
// the full opening (value, blinding, secret, asset, owner) from the seed alone, a
// non-owner can't, the on-chain leaf hash authenticates, and a full balance scan
// (with a spent note filtered) recovers the right active notes — all keyed off
// the leaf HASH the indexer reads from LeavesInserted, not the raw commitment.
//
// Run: node tests/confidential-memo.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar, G } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialMemo } from '../dapp/confidential-memo.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const m = makeConfidentialMemo({ secp, sha256, keccak256 });
const pool = makeConfidentialPool({ secp, sha256, keccak256 });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const pubHex = (priv) => '0x' + Buffer.from(G.multiply(priv).toRawBytes(true)).toString('hex');
const ASSET = '0x' + 'a5'.repeat(32);
// An owned note's owner is H(nk); openMemo also checks that the sealed nk commits to it.
const NK = '0x' + '7'.repeat(64);
const OWNER = pool.nkToOwner(NK);
// ν: OWNER here is non-zero (an OWNED note), so its nullifier is nk-bound via nativeNu, matching
// memo.scan's own (note, leaf) callback shape — pool.nullifier(leaf) is the BEARER (owner==0) formula
// and would record the wrong value for an owned note (this repo's own documented gotcha).
const nullifierOf = (note, leaf) => pool.nativeNu(note.owner, note.secret, leaf);

// recipient + a stranger
const rPriv = randomScalar(), rPub = pubHex(rPriv);
const sPriv = randomScalar();

// a note + its on-chain leaf hash (commit via the same H, hash via the same layout)
const note = { value: 4242n, blinding: randomScalar(), secret: NK, asset: ASSET, owner: OWNER };
const { cx, cy } = m.commitXY(note.value, note.blinding);
const leaf = m.leafHash(ASSET, cx, cy, OWNER);
const memo = m.sealMemo(rPub, note, randomScalar);

// ── owner recovers ──
const rec = m.openMemo(rPriv, leaf, memo);
assert.ok(rec, 'owner recovers the note');
assert.strictEqual(rec.value, 4242n, 'value');
assert.strictEqual(BigInt(rec.blinding), note.blinding, 'blinding');
assert.strictEqual(rec.secret, note.secret, 'secret');
assert.strictEqual(rec.asset.toLowerCase(), ASSET, 'asset');
assert.strictEqual(rec.owner.toLowerCase(), OWNER.toLowerCase(), 'owner');
ok('owner recovers full opening (value, blinding, secret, asset, owner) from the memo');

// ── stranger cannot ──
assert.strictEqual(m.openMemo(sPriv, leaf, memo), null, 'stranger gets null');
ok('non-owner recovery returns null (leaf hash authenticates)');

// ── tampered ciphertext rejected ──
const bad = { ...memo, ciphertext: '0x' + (memo.ciphertext.slice(2, 4) === 'ff' ? '00' : 'ff') + memo.ciphertext.slice(4) };
assert.strictEqual(m.openMemo(rPriv, leaf, bad), null, 'tampered memo rejected');
ok('tampered memo decrypts to a non-matching leaf hash → rejected');

// ── wrong leaf (right key, mismatched on-chain leaf) rejected ──
const wrongLeaf = m.leafHash(ASSET, cx, cy, '0x' + '00'.repeat(31) + '08');
assert.strictEqual(m.openMemo(rPriv, wrongLeaf, memo), null, 'leaf-hash binding catches wrong owner');
ok('opening that rehashes to a different leaf → rejected');

// ── full balance scan: two of my notes + one stranger's; one of mine spent ──
const mkLeaf = (nt) => { const c = m.commitXY(nt.value, nt.blinding); return m.leafHash(nt.asset, c.cx, c.cy, nt.owner); };
const nk8 = '0x' + '8'.repeat(64), nk9 = '0x' + '9'.repeat(64);
const mine = [note, { value: 10n, blinding: randomScalar(), secret: nk8, asset: ASSET, owner: pool.nkToOwner(nk8) }];
const others = [{ value: 99n, blinding: randomScalar(), secret: nk9, asset: ASSET, owner: pool.nkToOwner(nk9) }];
const events = [];
mine.forEach((nt, i) => events.push({ leaf: mkLeaf(nt), leafIndex: i, memo: m.sealMemo(rPub, nt, randomScalar) }));
others.forEach((nt, i) => events.push({ leaf: mkLeaf(nt), leafIndex: 100 + i, memo: m.sealMemo(pubHex(sPriv), nt, randomScalar) }));
const spentLeaf = mkLeaf(mine[1]);
const spent = [nullifierOf(mine[1], spentLeaf)]; // second note already spent
const recovered = m.scan(rPriv, events, spent, nullifierOf);
assert.strictEqual(recovered.length, 1, 'one active note recovered');
assert.strictEqual(recovered[0].value, 4242n, 'recovered the unspent note');
assert.strictEqual(recovered[0].leafIndex, 0, 'leaf index carried for path lookup');
ok('balance scan recovers my active notes only (stranger + spent filtered)');

// ── the sealed nk must own the note: a memo whose secret does not hash to the (authenticated) owner is refused,
//    since it would look recovered and never spend; a bearer note (owner 0) carries no nk and still opens ──
{
  const wrongNk = { ...note, secret: '0x' + '6'.repeat(64) };
  assert.strictEqual(m.openMemo(rPriv, leaf, m.sealMemo(rPub, wrongNk, randomScalar)), null, 'secret that does not commit to owner rejected');
  const bearer = { value: 5n, blinding: randomScalar(), secret: '0x' + '5'.repeat(64), asset: ASSET, owner: '0x' + '00'.repeat(32) };
  const bc = m.commitXY(bearer.value, bearer.blinding);
  assert.ok(m.openMemo(rPriv, m.leafHash(ASSET, bc.cx, bc.cy, bearer.owner), m.sealMemo(rPub, bearer, randomScalar)), 'bearer note opens');
  ok('owned note: sealed nk must hash to the owner; bearer notes unaffected');
}

// ── memo parsing is total: a memo that cannot be parsed or opened is skipped, never thrown out of a scan ──
{
  const N_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const ZERO_OWNER = '0x' + '00'.repeat(32);
  const wire = m.encodeMemo(memo);
  const hexBytes = (h) => h.replace(/^0x/, '');
  const flipByte = (h, at) => '0x' + hexBytes(h).slice(0, at * 2) + ((parseInt(hexBytes(h).slice(at * 2, at * 2 + 2), 16) ^ 0xff).toString(16).padStart(2, '0')) + hexBytes(h).slice(at * 2 + 2);
  const withEphemeral = (eph) => '0x' + eph + hexBytes(wire).slice(66);
  const offCurveX = (() => { for (let x = 5n; ; x++) { const h = '02' + x.toString(16).padStart(64, '0'); try { secp.ProjectivePoint.fromHex(h); } catch { return h; } } })();
  const badMemos = {
    'ephemeral key of all zero bytes': withEphemeral('00'.repeat(33)),
    'ephemeral key that is not on the curve': withEphemeral(offCurveX),
    'ephemeral key with an unknown prefix byte': withEphemeral('05' + hexBytes(wire).slice(2, 66)),
    'ephemeral key at the field size': withEphemeral('02' + 'ff'.repeat(32)),
    'truncated ciphertext': wire.slice(0, wire.length - 20),
    'ciphertext with trailing bytes': wire + 'aabb',
    'empty memo': '0x',
    'ephemeral key only': '0x' + hexBytes(wire).slice(0, 66),
    'non-hex characters': '0x' + 'zz'.repeat(169),
    'object without fields': {},
    'null memo': null,
    'undefined memo': undefined,
    'object with an odd ephemeral key': { ephemeralPub: '0x1', ciphertext: '0x' },
  };
  // A memo sealed to my key whose plaintext decrypts to an opening with no commitment: zero or out-of-range
  // blinding, or a zero value. These pass every length and curve check, so they only fail at the commitment.
  const unopenable = [['zero blinding', 5n, 0n], ['blinding at the curve order', 5n, N_ORDER], ['blinding above the curve order', 5n, (1n << 256n) - 1n], ['zero value', 0n, 7n]];
  for (const [name, value, blinding] of unopenable) {
    badMemos[`sealed opening with ${name}`] = m.encodeMemo(m.sealMemo(rPub, { value, blinding, secret: NK, asset: ASSET, owner: ZERO_OWNER }, randomScalar));
  }
  for (const [name, bm] of Object.entries(badMemos)) {
    assert.doesNotThrow(() => m.openMemo(rPriv, leaf, bm), `openMemo: ${name}`);
    assert.strictEqual(m.openMemo(rPriv, leaf, bm), null, `openMemo: ${name}`);
  }
  assert.strictEqual(m.openMemo(rPriv, leaf, flipByte(wire, 40)), null, 'a flipped ciphertext byte does not open');

  // A scan with every malformed shape interleaved around valid notes still recovers the valid notes.
  const good = mine.map((nt, i) => ({ leaf: mkLeaf(nt), leafIndex: 10 + i, memo: m.sealMemo(rPub, nt, randomScalar) }));
  const bad = Object.values(badMemos).map((bm, i) => ({ leaf, leafIndex: 50 + i, memo: bm }));
  const mixed = [bad[0], good[0], ...bad.slice(1, 6), good[1], ...bad.slice(6), { leaf: undefined, memo: undefined }, null];
  let got;
  assert.doesNotThrow(() => { got = m.scan(rPriv, mixed, [], nullifierOf); }, 'scan does not throw on malformed memos');
  assert.deepStrictEqual(got.map((x) => x.leafIndex), [10, 11], 'valid notes around the malformed memos are recovered in order');
  assert.strictEqual(got[0].value, 4242n, 'recovered value');
  assert.ok(m.openMemo(rPriv, leaf, wire), 'a valid wire-form memo still opens');
  // A callback that throws for one note skips that note only.
  const flaky = m.scan(rPriv, good, [], (nt, lf) => { if (nt.value === 10n) throw new Error('callback failure'); return nullifierOf(nt, lf); });
  assert.deepStrictEqual(flaky.map((x) => x.leafIndex), [10], 'a nullifier callback that throws skips that note only');
  ok('malformed memos are skipped without aborting the scan; valid notes around them are recovered');
}

console.log(`\n${n}/7 confidential-memo checks passed`);
