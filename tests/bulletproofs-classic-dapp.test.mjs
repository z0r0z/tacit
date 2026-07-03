// Parity test: dapp/bulletproofs.js classic-BP verifier (the reflection JS mirror) must
// accept the real mainnet TAC (f0bbe868…) classic-Bulletproofs range proof — the same
// 754-byte proof the guest verify_range_classic accepts — and reject a tampered one.
// Locks the JS↔guest dual-scheme parity that makes legacy classic-BP notes bridgeable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bpRangeVerify, bpClassicProofLen } from '../dapp/bulletproofs.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, '../contracts/sp1/confidential/fixtures');
const C0 = '02d7da737e7313ed32594ce7134033c74a675343e17cbc45156236ef3d5b758eee';
const C1 = readFileSync(join(fx, 'tac_classic_c1.hex'), 'utf8').trim();
const RP = readFileSync(join(fx, 'tac_classic_rp.hex'), 'utf8').trim();
const h2b = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));

test('classic proof length is distinct from BP+ for every m', () => {
  for (const m of [1, 2, 4, 8]) {
    const logmn = Math.log2(64 * m);
    const bpp = 99 + 96 + logmn * 66;
    assert.notEqual(bpClassicProofLen(m), bpp, `m=${m} lengths must not collide`);
  }
});

test('dapp classic verifier accepts real TAC proof, rejects tamper', () => {
  const commits = [C0, C1];
  const rp = h2b(RP);
  assert.equal(rp.length, 754, 'classic proof m=2');
  assert.equal(rp.length, bpClassicProofLen(2), 'length dispatch matches');
  assert.equal(bpRangeVerify(commits, rp), true, 'must accept real classic-BP TAC proof');
  const bad = rp.slice();
  bad[100] ^= 0x01;
  assert.equal(bpRangeVerify(commits, bad), false, 'tampered proof must reject');
});
