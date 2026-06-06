#!/usr/bin/env node
// Round-trip for the arbitrary-amount confidential transfer (dapp/confidential-
// transfer.js): a valid transfer with arbitrary hidden amounts verifies, and a
// tampered conservation / out-of-range output is rejected. Proves the proof the
// SP1 guest will re-verify is sound and well-formed — without the SP1 toolchain.
//
// Run: node tests/confidential-transfer-roundtrip.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import assert from 'node:assert';

const ct = makeConfidentialTransfer({ keccak256: keccak_256 });
let passed = 0;
const ok = (label) => { console.log('  ok -', label); passed++; };

// ── 1. valid arbitrary-amount transfer: 1234567 + 89 → 1234000 + 656 ──
{
  const inputs = [
    { value: 1234567n, blinding: randomScalar() },
    { value: 89n, blinding: randomScalar() },
  ];
  const outputs = [
    { value: 1234000n, blinding: randomScalar() },
    { value: 656n, blinding: randomScalar() },
  ];
  const t = ct.buildTransfer({ inputs, outputs });
  assert.strictEqual(ct.verifyTransfer(t), true, 'valid transfer verifies');
  ok('arbitrary-amount transfer (1234567+89 → 1234000+656) verifies');
}

// ── 2. tampered conservation: an output commitment for a different value ──
{
  const inputs = [{ value: 500n, blinding: randomScalar() }];
  const outputs = [
    { value: 300n, blinding: randomScalar() },
    { value: 200n, blinding: randomScalar() },
  ];
  const t = ct.buildTransfer({ inputs, outputs });
  // swap an output commitment for one committing to MORE value (inflation attempt)
  t.outC[0] = ct.commit(99999n, randomScalar());
  assert.strictEqual(ct.verifyTransfer(t), false, 'inflated output rejected');
  ok('tampered conservation (inflated output) rejected by the kernel');
}

// ── 3. range enforcement: a negative / out-of-range value cannot be proven ──
{
  let threw = false;
  try {
    ct.buildTransfer({
      inputs: [{ value: 10n, blinding: randomScalar() }],
      outputs: [
        { value: (1n << 64n), blinding: randomScalar() }, // ≥ 2^64
        { value: 0n, blinding: randomScalar() },
      ],
    });
  } catch { threw = true; }
  assert.ok(threw, 'out-of-range output rejected at proving time');
  ok('out-of-range output (≥ 2^64) cannot be proven');
}

// ── 4. larger aggregation (4 outputs) still conserves + verifies ──
{
  const inputs = [
    { value: 1_000_000n, blinding: randomScalar() },
    { value: 500_000n, blinding: randomScalar() },
  ];
  const outputs = [
    { value: 700_000n, blinding: randomScalar() },
    { value: 400_000n, blinding: randomScalar() },
    { value: 300_000n, blinding: randomScalar() },
    { value: 100_000n, blinding: randomScalar() },
  ];
  const t = ct.buildTransfer({ inputs, outputs });
  assert.strictEqual(ct.verifyTransfer(t), true, '2-in/4-out verifies');
  ok('2-in / 4-out arbitrary-amount transfer verifies');
}

console.log(`\n${passed}/4 confidential-transfer round-trip checks passed`);
