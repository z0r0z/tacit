// splitDepositCall (dapp/evm-pool-wallet.js): the one call of the split deposit (contracts/src/TacitSplitDeposit.sol), as the `selfCall` of a Tacit deposit.
// The calldata is checked against foundry's `cast calldata` for the same arguments (skipped where cast is not installed), and the value against the rule
// the contract enforces: the notes' sizes plus the proof's extAmount, to the wei.
//   node --test tests/split-deposit-call.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { splitDepositCall } from '../dapp/evm-pool-wallet.js';

const CAST = process.env.CAST || '/Users/z/.foundry/bin/cast';
const SIG = 'splitDeposit(address[],bytes32[],(uint256[2],uint256[2][2],uint256[2],uint256[11],address,int256,address,uint256,bytes,bytes))';
const E = 10n ** 18n;
const FWD = '0x' + 'f0'.repeat(20);
const P01 = '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc', P1 = '0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936';
const pools = [{ address: P1, denomination: E }, { address: P01, denomination: E / 10n }, { address: P1, denomination: E }];
const commitments = ['0x' + '11'.repeat(32), '0x' + '22'.repeat(31) + '33', 0x44n];
const tx = {
  pA: [1n, 2n], pB: [[3n, 4n], [5n, 6n]], pC: [7n, 8n], publicInputs: Array.from({ length: 11 }, (_, i) => BigInt(100 + i)),
  recipient: '0x' + '00'.repeat(20), extAmount: 50_000_000_000_000_000n, relayer: '0x' + '00'.repeat(20), fee: 0n, memo0: '0xaabbcc', memo1: new Uint8Array([1, 2, 3, 4, 5]),
};

test('the value is the notes plus the Tacit amount, to the wei, sent to the forwarder', () => {
  const c = splitDepositCall(FWD, tx, { pools, commitments });
  assert.equal(c.to, FWD);
  assert.equal(c.value, 2n * E + E / 10n + 50_000_000_000_000_000n);
});

test('the calldata is what Solidity reads: the same bytes as cast makes for the same arguments', { skip: !existsSync(CAST) && 'cast is not installed' }, () => {
  const c = splitDepositCall(FWD, tx, { pools, commitments });
  const word = (b) => '0x' + b.toString(16).padStart(64, '0');
  const want = execFileSync(CAST, ['calldata', SIG,
    `[${pools.map((p) => p.address).join(',')}]`,
    `[${commitments.map((x) => (typeof x === 'bigint' ? word(x) : x)).join(',')}]`,
    `([1,2],[[3,4],[5,6]],[7,8],[${tx.publicInputs.join(',')}],${tx.recipient},${tx.extAmount},${tx.relayer},${tx.fee},0xaabbcc,0x0102030405)`,
  ]).toString().trim();
  assert.equal(c.data, want);
});

test('a bigint commitment is the 32-byte word, and a short or long hex is refused', () => {
  const a = splitDepositCall(FWD, tx, { pools: [pools[0]], commitments: [0x44n] });
  const b = splitDepositCall(FWD, tx, { pools: [pools[0]], commitments: ['0x' + '00'.repeat(31) + '44'] });
  assert.equal(a.data, b.data);
  assert.throws(() => splitDepositCall(FWD, tx, { pools: [pools[0]], commitments: ['0x1234'] }), /32 bytes/);
});

test('one note for each pool, a deposit with an amount, and no Tacit part is not this call', () => {
  assert.throws(() => splitDepositCall(FWD, tx, { pools, commitments: commitments.slice(1) }), /a note for each pool/);
  assert.throws(() => splitDepositCall(FWD, { ...tx, extAmount: 0n }, { pools, commitments }), /positive amount/);
  assert.throws(() => splitDepositCall(FWD, { ...tx, extAmount: -1n }, { pools, commitments }), /positive amount/);
});
