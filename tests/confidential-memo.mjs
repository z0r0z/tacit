#!/usr/bin/env node
// Validates note memos + recovery (dapp/confidential-memo.js): the owner recovers
// (value, blinding, secret) from the seed alone, a non-owner can't, the
// commitment authenticates, and a full balance scan (with a spent note filtered)
// recovers the right active notes.
//
// Run: node tests/confidential-memo.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar, G } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialMemo } from '../dapp/confidential-memo.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const m = makeConfidentialMemo({ secp, sha256 });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const pubHex = (priv) => '0x' + Buffer.from(G.multiply(priv).toRawBytes(true)).toString('hex');
const ASSET = '0x' + 'a5'.repeat(32);
const OWNER = '0x' + '00'.repeat(32);
const nullifierOf = (secret) => '0x' + Buffer.from(keccak_256(Uint8Array.from(Buffer.from(secret.replace(/^0x/, ''), 'hex')))).toString('hex');

// recipient + a stranger
const rPriv = randomScalar(), rPub = pubHex(rPriv);
const sPriv = randomScalar();

// a note + its leaf (commit via the same H)
const note = { value: 4242n, blinding: randomScalar(), secret: '0x' + '7'.repeat(64) };
const { cx, cy } = m.commitXY(note.value, note.blinding);
const leaf = { cx, cy };
const memo = m.sealMemo(rPub, note, randomScalar);

// ── owner recovers ──
const rec = m.openMemo(rPriv, leaf, memo);
assert.ok(rec, 'owner recovers the note');
assert.strictEqual(rec.value, 4242n, 'value');
assert.strictEqual(BigInt(rec.blinding), note.blinding, 'blinding');
assert.strictEqual(rec.secret, note.secret, 'secret');
ok('owner recovers (value, blinding, secret) from the memo');

// ── stranger cannot ──
assert.strictEqual(m.openMemo(sPriv, leaf, memo), null, 'stranger gets null');
ok('non-owner recovery returns null (commitment authenticates)');

// ── tampered ciphertext rejected ──
const bad = { ...memo, ciphertext: '0x' + (memo.ciphertext.slice(2, 4) === 'ff' ? '00' : 'ff') + memo.ciphertext.slice(4) };
assert.strictEqual(m.openMemo(rPriv, leaf, bad), null, 'tampered memo rejected');
ok('tampered memo decrypts to a non-matching commitment → rejected');

// ── full balance scan: two of my notes + one stranger's; one of mine spent ──
const mine = [note, { value: 10n, blinding: randomScalar(), secret: '0x' + '8'.repeat(64) }];
const others = [{ value: 99n, blinding: randomScalar(), secret: '0x' + '9'.repeat(64) }];
const events = [];
mine.forEach((nt, i) => { const c = m.commitXY(nt.value, nt.blinding); events.push({ leaf: c, leafIndex: i, memo: m.sealMemo(rPub, nt, randomScalar) }); });
others.forEach((nt, i) => { const c = m.commitXY(nt.value, nt.blinding); events.push({ leaf: c, leafIndex: 100 + i, memo: m.sealMemo(pubHex(sPriv), nt, randomScalar) }); });
const spent = [nullifierOf(mine[1].secret)]; // second note already spent
const recovered = m.scan(rPriv, events, spent, nullifierOf);
assert.strictEqual(recovered.length, 1, 'one active note recovered');
assert.strictEqual(recovered[0].value, 4242n, 'recovered the unspent note');
ok('balance scan recovers my active notes only (stranger + spent filtered)');

console.log(`\n${n}/4 confidential-memo checks passed`);
