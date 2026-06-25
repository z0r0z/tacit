// Parity tests for the EVM airdrop merkle builder (tools/airdrop/build-merkle.mjs).
//
// Asserts:
//   - the builder reproduces the committed fixture root deterministically (drift guard against
//     contracts/test/fixtures/airdrop_merkle_sample.json, which the forge parity test feeds on-chain)
//   - every generated proof reconstructs the root under the Solady sorted-pair walk
//   - negative paths: tampered amount / wrong sibling / wrong leaf are rejected
//   - leaf binds (index, account, amount) — changing any field changes the leaf
//
// The Solidity side (test/MerkleDistributorParity.t.sol) reads the SAME fixture and asserts the on-chain
// MerkleDistributor (Solady MerkleProofLib) accepts each proof — so this JS suite + that forge suite
// together prove JS-builder ↔ Solidity-verifier parity.
//
// Run: node tests/airdrop-merkle-evm.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildClaims, leafHash, verifyProof } from '../tools/airdrop/build-merkle.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hb = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { pass++; console.log(`  ok  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } }

const SNAPSHOT = [
  { account: '0x00000000000000000000000000000000000000A1', amount: '10000000000' },
  { account: '0x00000000000000000000000000000000000000A2', amount: '25000000000' },
  { account: '0x00000000000000000000000000000000000000A3', amount: '500000000' },
  { account: '0x00000000000000000000000000000000000000A4', amount: '100000000000' },
  { account: '0x00000000000000000000000000000000000000A5', amount: '777000000' },
];

console.log('EVM airdrop merkle parity');

const built = buildClaims(SNAPSHOT);

// 1. Matches the committed fixture the forge test consumes.
const fixture = JSON.parse(readFileSync(join(__dirname, '../contracts/test/fixtures/airdrop_merkle_sample.json'), 'utf8'));
ok(`root matches committed fixture (${built.root})`, built.root === fixture.root);
ok(`total matches fixture (${built.total})`, built.total === fixture.total);
ok(`count matches fixture (${built.count})`, built.count === fixture.count);
ok('per-claim proofs match fixture byte-for-byte',
  JSON.stringify(built.claims) === JSON.stringify(fixture.claims));

// 2. Every proof reconstructs the root under the sorted-pair walk.
let allVerify = true;
for (const c of built.claims) {
  const leaf = leafHash(c.index, c.account, BigInt(c.amount));
  if (!verifyProof(c.proof.map(hb), hb(built.root), leaf)) allVerify = false;
}
ok('every generated proof verifies against the root', allVerify);

// 3. Odd-leaf promotion: the last (5th) leaf is promoted, so its proof is shorter.
ok('odd-count promotion produces a short proof for the lone leaf',
  built.claims[4].proof.length < built.claims[0].proof.length);

// 4. Negative paths.
const c0 = built.claims[0];
const root = hb(built.root);
ok('tampered amount is rejected',
  !verifyProof(c0.proof.map(hb), root, leafHash(c0.index, c0.account, BigInt(c0.amount) + 1n)));
ok('wrong account is rejected',
  !verifyProof(c0.proof.map(hb), root, leafHash(c0.index, '0x00000000000000000000000000000000000000ff', BigInt(c0.amount))));
ok('mutated sibling is rejected', (() => {
  const bad = c0.proof.map(hb);
  bad[0] = bad[0].map((x, i) => (i === 0 ? x ^ 1 : x));
  return !verifyProof(bad, root, leafHash(c0.index, c0.account, BigInt(c0.amount)));
})());

// 5. Leaf binding: each field is bound.
const base = leafHash(0, c0.account, 1n);
ok('leaf binds index', hbToHex(base) !== hbToHex(leafHash(1, c0.account, 1n)));
ok('leaf binds account', hbToHex(base) !== hbToHex(leafHash(0, c0.account.replace(/.$/, '2'), 1n)));
ok('leaf binds amount', hbToHex(base) !== hbToHex(leafHash(0, c0.account, 2n)));

// 6. Builder rejects duplicate indices (a duplicate would let one bitmap slot pay twice).
ok('duplicate index is rejected', (() => {
  try { buildClaims([{ index: 0, account: c0.account, amount: '1' }, { index: 0, account: c0.account, amount: '2' }]); return false; }
  catch { return true; }
})());

function hbToHex(b) { return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
