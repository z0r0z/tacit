#!/usr/bin/env node
// Locks the worker EVM-log decoder (dapp/confidential-evm-log.js) against the
// real Solidity ABI codec: every event `data` blob is produced by `cast
// abi-encode` (foundry's encoder — ground truth), and every topic0 against `cast
// keccak` of the canonical signature. So a decoded log is exactly what
// ConfidentialPool emits on-chain. Then the decoded stream is fed into the client
// indexer to confirm the worker→client handoff folds correctly.
//
// Requires foundry's `cast` on PATH. Run: node tests/confidential-evm-log.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { makeConfidentialEvmLog } from '../dapp/confidential-evm-log.js';
import { makeConfidentialIndexer } from '../dapp/confidential-indexer.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const dec = makeConfidentialEvmLog({ keccak256 });
const idx = makeConfidentialIndexer({ secp, keccak256, sha256 });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const cast = (args) => execSync(`cast ${args}`, { encoding: 'utf8' }).trim();
const kc = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
const padTopic = (n2) => '0x' + BigInt(n2).toString(16).padStart(64, '0');

// ── topic0 hashes match cast keccak of the canonical signatures (ground truth) ──
for (const [name, sig] of Object.entries(dec.SIGS)) {
  assert.strictEqual(dec.TOPIC0[name].toLowerCase(), cast(`keccak "${sig}"`).toLowerCase(), `topic0 ${name}`);
}
ok('every event topic0 matches cast keccak of its canonical signature');

// ── LeavesInserted ──
const L0 = kc('L0'), L1 = kc('L1');
const liData = cast(`abi-encode "x(bytes32[],bytes[])" "[${L0},${L1}]" "[0xdeadbeef,0xcafe]"`);
const li = dec.decodeLog({ topics: [dec.TOPIC0.LeavesInserted, padTopic(5)], data: liData });
assert.strictEqual(li.type, 'LeavesInserted');
assert.strictEqual(li.firstLeafIndex, 5, 'firstLeafIndex from indexed topic');
assert.deepStrictEqual(li.leaves.map((x) => x.toLowerCase()), [L0, L1], 'leaves array');
assert.deepStrictEqual(li.memos, ['0xdeadbeef', '0xcafe'], 'memos array (dynamic bytes[])');
ok('LeavesInserted decodes firstLeafIndex (topic) + bytes32[] leaves + bytes[] memos');

// ── NullifiersSpent ──
const NU = kc('nu');
const nsData = cast(`abi-encode "x(bytes32[])" "[${NU}]"`);
const ns = dec.decodeLog({ topics: [dec.TOPIC0.NullifiersSpent], data: nsData });
assert.strictEqual(ns.type, 'NullifiersSpent');
assert.deepStrictEqual(ns.nullifiers.map((x) => x.toLowerCase()), [NU], 'nullifiers array');
ok('NullifiersSpent decodes bytes32[] nullifiers');

// ── CrossOutRecorded ──
const destC = kc('dest'), nu2 = kc('nu2'), asset = kc('asset');
const cid = cast(`keccak $(cast abi-encode --packed "x(uint16,bytes32,bytes32,bytes32)" 1 ${destC} ${nu2} ${asset})`);
const coData = cast(`abi-encode "x(uint16,bytes32,bytes32,bytes32)" 1 ${destC} ${nu2} ${asset}`);
const co = dec.decodeLog({ topics: [dec.TOPIC0.CrossOutRecorded, cid], data: coData });
assert.strictEqual(co.type, 'CrossOutRecorded');
assert.strictEqual(co.destChain, 1, 'destChain uint16');
assert.strictEqual(co.destCommitment.toLowerCase(), destC, 'destCommitment');
assert.strictEqual(co.nullifier.toLowerCase(), nu2, 'crossOut nullifier');
assert.strictEqual(co.assetId.toLowerCase(), asset, 'assetId');
assert.strictEqual(co.claimId.toLowerCase(), cid.toLowerCase(), 'claimId from indexed topic');
ok('CrossOutRecorded decodes claimId (topic) + uint16 destChain + 3 bytes32 fields');

// ── BridgeMinted (indexed only, empty data) ──
const bm = dec.decodeLog({ topics: [dec.TOPIC0.BridgeMinted, cid], data: '0x' });
assert.strictEqual(bm.type, 'BridgeMinted');
assert.strictEqual(bm.claimId.toLowerCase(), cid.toLowerCase(), 'BridgeMinted claimId');
ok('BridgeMinted decodes its indexed claimId with empty data');

// ── Wrap (commitment coords + owner are NOT emitted — deposit-spend unlinkability) ──
const depositId = kc('dep'), assetId = kc('a');
const wData = cast(`abi-encode "x(uint256)" 100`);
const w = dec.decodeLog({ topics: [dec.TOPIC0.Wrap, depositId, assetId], data: wData });
assert.strictEqual(w.type, 'Wrap');
assert.strictEqual(w.amount, 100n, 'wrap amount uint256');
assert.strictEqual(w.cx, undefined, 'wrap no longer emits cx');
assert.strictEqual(w.owner, undefined, 'wrap no longer emits owner');
assert.strictEqual(w.depositId.toLowerCase(), depositId.toLowerCase(), 'depositId topic');
assert.strictEqual(w.assetId.toLowerCase(), assetId.toLowerCase(), 'assetId topic');
ok('Wrap decodes both indexed topics + uint256 amount (commitment/owner omitted on-chain)');

// ── unknown logs are dropped; decoded stream feeds the client indexer ──
const stream = dec.decodeLogs([
  { topics: [dec.TOPIC0.LeavesInserted, padTopic(0)], data: liData },
  { topics: ['0x' + 'ff'.repeat(32)], data: '0x' }, // foreign log
  { topics: [dec.TOPIC0.NullifiersSpent], data: nsData },
]);
assert.strictEqual(stream.length, 2, 'foreign log dropped');
const folded = idx.index(stream);
assert.strictEqual(folded.leaves.filter(Boolean).length, 2, 'indexer folds decoded leaves');
assert.strictEqual(folded.spent.size, 1, 'indexer folds decoded nullifier');
ok('decodeLogs drops foreign logs and the stream feeds the client indexer (worker→client handoff)');

console.log(`\n${n}/7 confidential-evm-log checks passed`);
