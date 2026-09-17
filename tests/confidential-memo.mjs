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

console.log(`\n${n}/6 confidential-memo checks passed`);
