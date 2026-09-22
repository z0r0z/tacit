#!/usr/bin/env node
// Reference vectors for the deposit-commitment hash chain a wrap/invoice pins on-chain:
//   depositCommit(cx, cy, owner) = keccak256(cx ‖ cy ‖ owner)
//   depositId(assetId, value, cx, cy, owner) = keccak256(assetId(32) ‖ value(BE32) ‖ depositCommit)
// buildWrap (confidential-pool-ux.js) and createInvoice (confidential-invoice.js) both derive a
// deposit through this exact chain — pinning it here catches a silent divergence in any reimplementation
// that computes the same commitment independently rather than importing dapp/confidential-pool.js.
//
// Run: node tests/gen-depositid-vectors.mjs  → writes contracts/sp1/confidential/fixtures/deposit_id_vectors.json
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

// Fixed (value, blinding) pairs run through the real commitXY, so cx/cy are real curve points, not
// placeholders — the same shape a wrap or invoice actually produces. assetId/owner vary across cases to
// exercise the hash-chain's byte packing, not the commitment math (that's a separate primitive).
const CASES = [
  { assetId: '0x' + '00'.repeat(31) + '01', value: 1n, blinding: '0x' + '11'.repeat(32), owner: '0x' + '22'.repeat(32) },
  { assetId: '0x' + '00'.repeat(31) + '02', value: 1_000_000n, blinding: '0x' + '33'.repeat(32), owner: '0x' + '44'.repeat(32) },
  { assetId: '0x' + 'ab'.repeat(32), value: 123_456_789n, blinding: '0x' + '55'.repeat(32), owner: '0x' + '66'.repeat(32) },
  { assetId: '0x' + 'cd'.repeat(32), value: (2n ** 64n) - 1n, blinding: '0x' + '77'.repeat(32), owner: '0x' + '88'.repeat(32) },
  { assetId: '0x' + 'ef'.repeat(32), value: 0n, blinding: '0x' + '99'.repeat(32), owner: '0x' + 'aa'.repeat(32) },
];

export function computeVectors() {
  return CASES.map((c) => {
    const { cx, cy } = pool.commitXY(c.value, c.blinding);
    const commit = pool.depositCommit(cx, cy, c.owner);
    const depositId = pool.depositId(c.assetId, c.value, cx, cy, c.owner);
    return {
      assetId: c.assetId, value: c.value.toString(), blinding: c.blinding, owner: c.owner,
      cx, cy, depositCommit: commit, depositId,
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = {
    _comment: 'depositCommit/depositId KAT: keccak256(cx‖cy‖owner), then keccak256(assetId‖value(BE32)‖depositCommit). Reference: dapp/confidential-pool.js. Regenerate: node tests/gen-depositid-vectors.mjs',
    vectors: computeVectors(),
  };
  const path = new URL('../contracts/sp1/confidential/fixtures/deposit_id_vectors.json', import.meta.url);
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${out.vectors.length} depositId vectors`);
}
