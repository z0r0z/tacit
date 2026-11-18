#!/usr/bin/env node
// A plain ETH send gets more than 21,000 gas wherever the receiver can be a person's account: a smart account or an EIP-7702 delegation runs code on receiving ETH, and a bare
// 21,000 reverts (found by a live sweep to a delegated address). Run: node tests/eth-send-gas.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
let n = 0;
for (const f of ['dapp/prove/ops.js', 'tools/evm-pool-live-check.mjs', 'tools/evm-pool-live-finish.mjs']) {
  assert.doesNotMatch(read(f).replace(/\/\/.*$/gm, ''), /\b21_?000n?\b/, `${f} sends ETH with a bare 21,000 gas`);
  n++; console.log(`ok - ${f} leaves room for a receiving account's code`);
}
// the pool pays a recipient so that a contract recipient cannot make the withdrawal fail
assert.match(read('contracts/src/TacitEvmPool.sol'), /forceSafeTransferETH\(recipient/);
n++; console.log('ok - the pool force-sends a withdrawal\'s ETH');
console.log(`\n${n} checks passed`);
