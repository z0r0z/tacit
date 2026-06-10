#!/usr/bin/env node
// Round-trips a bridge-burn (Ethereum → Bitcoin) built by dapp/confidential-
// transfer.js: arbitrary hidden amounts burned on Ethereum, conserved into
// destination notes minted on Bitcoin, each carrying a non-malleable crossOut
// {destChain, destCommitment, nullifier, assetId, claimId}. The SP1 guest only
// re-verifies this exact proof, so a passing round-trip here locks the format.
// Also emits a fixture for the Solidity KAT to lock claimId/destCommitment
// encoding across JS ↔ contract.
//
// Run: node tests/confidential-bridge-burn.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialMemo } from '../dapp/confidential-memo.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const ct = makeConfidentialTransfer({ keccak256: keccak_256 });
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const memo = makeConfidentialMemo({ secp, sha256, keccak256: keccak_256 });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const ASSET = '0x' + 'a5'.repeat(32);
const OWNER_B = '0x' + '00'.repeat(31) + '0b'; // recipient's Bitcoin owner field
const BITCOIN = 1; // destChain id

// Burn two Ethereum notes (1000 + 500) into two Bitcoin notes (900 + 600).
const inputs = [
  { value: 1000n, blinding: randomScalar(), secret: '0x' + '11'.repeat(32) },
  { value: 500n, blinding: randomScalar(), secret: '0x' + '22'.repeat(32) },
];
const outputs = [
  { value: 900n, blinding: randomScalar(), owner: OWNER_B },
  { value: 600n, blinding: randomScalar(), owner: OWNER_B },
];
// Note-bound ν (spec B3): keccak(Cx ‖ Cy ‖ "spent") of the first burned input — what the
// guest derives (main.rs OP_BRIDGE_BURN), so the fixture locks the guest's real claimId.
const c0 = memo.commitXY(inputs[0].value, inputs[0].blinding);
const bindNullifier = pool.nullifier(c0.cx, c0.cy);

const burn = ct.buildBridgeBurn({ inputs, outputs, assetId: ASSET, destChain: BITCOIN, bindNullifier });

// ── conserved + ranged + claimIds bind ──
assert.ok(ct.verifyBridgeBurn(burn), 'bridge-burn verifies (conservation + range + claim binding)');
ok('arbitrary-amount bridge-burn conserves Σin=Σout across the chain boundary and verifies');

// ── one crossOut per destination, each claimId distinct + correctly derived ──
assert.strictEqual(burn.crossOuts.length, 2, 'one crossOut per Bitcoin output');
assert.notStrictEqual(burn.crossOuts[0].claimId, burn.crossOuts[1].claimId, 'distinct claimIds');
const legacyNu = '0x' + Buffer.from(keccak_256(Uint8Array.from(Buffer.from(inputs[0].secret.slice(2), 'hex')))).toString('hex');
assert.notStrictEqual(bindNullifier, legacyNu, 'binding ν is note-bound (B3), not the legacy secret hash');
for (const c of burn.crossOuts) {
  assert.strictEqual(c.claimId, ct.claimId(c.destChain, c.destCommitment, c.nullifier, c.assetId), 'claimId re-derives');
  assert.strictEqual(c.destCommitment, ct.destLeaf(c.assetId, c.cx, c.cy, c.owner), 'destCommitment = Bitcoin leaf');
  assert.strictEqual(c.nullifier, bindNullifier, 'every crossOut binds the same note-bound burn ν (B3)');
}
ok('each Bitcoin output yields a distinct, self-deriving crossOut (claimId binds destChain‖dest‖ν‖asset)');

// ── non-conservation is rejected at build ──
assert.throws(() => ct.buildBridgeBurn({
  inputs, outputs: [{ value: 900n, blinding: randomScalar(), owner: OWNER_B }, { value: 700n, blinding: randomScalar(), owner: OWNER_B }],
  assetId: ASSET, destChain: BITCOIN, bindNullifier,
}), /not conserved/, 'inflated burn rejected');
ok('a burn that mints more on Bitcoin than it burns on Ethereum is rejected (no value creation)');

// ── tampered crossOut (swapped owner → wrong destCommitment) rejected ──
const tampered = { ...burn, crossOuts: burn.crossOuts.map((c, i) => i === 0 ? { ...c, owner: '0x' + '00'.repeat(31) + 'cc' } : c) };
assert.strictEqual(ct.verifyBridgeBurn(tampered), false, 'tampered destination rejected');
ok('a crossOut whose owner no longer matches its destCommitment is rejected');

// ── fixture for the Solidity claimId/destCommitment KAT ──
const here = dirname(fileURLToPath(import.meta.url));
const fx = {
  note: 'bridge-burn claimId/destCommitment vectors for the Solidity KAT',
  assetId: ASSET,
  destChain: BITCOIN,
  bindNullifier,
  count: burn.crossOuts.length,
  crossOuts: burn.crossOuts.map((c) => ({ cx: c.cx, cy: c.cy, owner: c.owner, destCommitment: c.destCommitment, claimId: c.claimId })),
};
const fxJson = JSON.stringify(fx, null, 2) + '\n';
writeFileSync(join(here, '..', 'contracts', 'test', 'fixtures', 'bridge_burn.json'), fxJson);       // Solidity KAT
writeFileSync(join(here, '..', 'contracts', 'sp1', 'confidential', 'fixtures', 'bridge_burn.json'), fxJson); // cxfer-core native test
ok('wrote bridge_burn.json fixtures for the Solidity + Rust cross-impl KATs');

console.log(`\n${n}/5 confidential-bridge-burn checks passed`);
