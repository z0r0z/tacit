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
const OWNER = '0x' + '00'.repeat(31) + '07';
// ν is note-bound (spec B3): keccak(Cx ‖ Cy ‖ "spent") — matches the dapp, guest, and contract.
const nullifierOf = (cx, cy) => pool.nullifier(cx, cy);

// recipient + a stranger
const rPriv = randomScalar(), rPub = pubHex(rPriv);
const sPriv = randomScalar();

// a note + its on-chain leaf hash (commit via the same H, hash via the same layout)
const note = { value: 4242n, blinding: randomScalar(), secret: '0x' + '7'.repeat(64), asset: ASSET, owner: OWNER };
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
assert.strictEqual(rec.owner.toLowerCase(), OWNER, 'owner');
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
const mine = [note, { value: 10n, blinding: randomScalar(), secret: '0x' + '8'.repeat(64), asset: ASSET, owner: OWNER }];
const others = [{ value: 99n, blinding: randomScalar(), secret: '0x' + '9'.repeat(64), asset: ASSET, owner: OWNER }];
const events = [];
mine.forEach((nt, i) => events.push({ leaf: mkLeaf(nt), leafIndex: i, memo: m.sealMemo(rPub, nt, randomScalar) }));
others.forEach((nt, i) => events.push({ leaf: mkLeaf(nt), leafIndex: 100 + i, memo: m.sealMemo(pubHex(sPriv), nt, randomScalar) }));
const c1 = m.commitXY(mine[1].value, mine[1].blinding);
const spent = [nullifierOf(c1.cx, c1.cy)]; // second note already spent (note-bound ν)
const recovered = m.scan(rPriv, events, spent, nullifierOf);
assert.strictEqual(recovered.length, 1, 'one active note recovered');
assert.strictEqual(recovered[0].value, 4242n, 'recovered the unspent note');
assert.strictEqual(recovered[0].leafIndex, 0, 'leaf index carried for path lookup');
ok('balance scan recovers my active notes only (stranger + spent filtered)');

console.log(`\n${n}/5 confidential-memo checks passed`);
