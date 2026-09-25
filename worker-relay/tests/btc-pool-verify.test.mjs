// Coverage for worker-relay/src/lib/btc-pool-verify.js flagged missing in review: an ABI round-trip smoke
// test (would catch a struct field-order/type slip that a live proof wouldn't surface until it silently
// failed to verify) and a mocked-RPC test for the revert-vs-network-error classification (would catch a
// regression that makes a transport failure look like a definitive reject, or vice versa).
//
// Run from worker-relay/ (not the repo root) so Node resolves this workspace's own viem: `node
// tests/btc-pool-verify.test.mjs`. Needs RPC_URL/CHAIN_ID set (any value) even though every case here
// mocks its own client — importing chain.js (transitively, via btc-pool-verify.js) requires it at
// module-load time, before any test body runs.

import assert from 'node:assert/strict';
import { decodeAbiParameters } from 'viem';
import { encodeBtcPoolSpendPublicValues, verifyBtcPoolSpendProof, SP1_VERIFIER_ADDRESS } from '../src/lib/btc-pool-verify.js';

let passed = 0;
function ok(name) { passed++; console.log('  ok -', name); }

const BTC_POOL_SPEND_VALUES_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'version', type: 'uint16' },
    { name: 'asset', type: 'bytes32' },
    { name: 'root', type: 'bytes32' },
    { name: 'hAnchor', type: 'uint32' },
    { name: 'outKind', type: 'uint8' },
    { name: 'nullifiers', type: 'bytes32[]' },
    { name: 'outputs', type: 'tuple[]', components: [
      { name: 'cx', type: 'bytes32' }, { name: 'cy', type: 'bytes32' },
      { name: 'pkEph', type: 'bytes32' }, { name: 'spendKey', type: 'bytes32' }, { name: 'ctNote', type: 'bytes' },
    ] },
    { name: 'hasExitVout', type: 'bool' },
    { name: 'exitVout', type: 'uint32' },
    { name: 'exitValue', type: 'uint64' },
    { name: 'destSpkHash', type: 'bytes32' },
  ],
};

// ── ABI round-trip: encode a realistic pay statement, decode it back independently (a second,
// hand-written tuple descriptor, not the module's own internal one — a slip in the module's own type list
// would decode wrong here too, since decodeAbiParameters would fail or return garbage for a real mismatch).
{
  const stmt = {
    version: 1,
    asset: '0x' + 'ab'.repeat(32),
    root: '0x' + 'cd'.repeat(32),
    hAnchor: 900123,
    outKind: 0,
    nullifiers: ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)],
    outputs: [
      { cx: '0x' + '33'.repeat(32), cy: '0x' + '44'.repeat(32), pkEph: '0x' + '55'.repeat(32), spendKey: '0x' + '66'.repeat(32), ctNote: '0x' + '77'.repeat(56) },
    ],
    hasExitVout: false,
    exitVout: 0,
    exitValue: 0n,
    destSpkHash: '0x' + '00'.repeat(32),
  };
  const encoded = encodeBtcPoolSpendPublicValues(stmt);
  const [decoded] = decodeAbiParameters([BTC_POOL_SPEND_VALUES_TUPLE], encoded);
  assert.equal(decoded.version, stmt.version);
  assert.equal(decoded.asset.toLowerCase(), stmt.asset.toLowerCase());
  assert.equal(decoded.hAnchor, stmt.hAnchor);
  assert.equal(decoded.nullifiers.length, 2);
  assert.equal(decoded.nullifiers[1].toLowerCase(), stmt.nullifiers[1].toLowerCase());
  assert.equal(decoded.outputs.length, 1);
  assert.equal(decoded.outputs[0].ctNote.toLowerCase(), stmt.outputs[0].ctNote.toLowerCase());
  assert.equal(decoded.exitValue, 0n);
  ok('encodeBtcPoolSpendPublicValues round-trips through an independent decoder (pay shape)');
}

// ── Same round-trip for an exit statement (empty outputs, exit fields populated) — the two `outKind`
// shapes are exactly where a conditional-field mistake would hide.
{
  const stmt = {
    version: 1, asset: '0x' + 'ab'.repeat(32), root: '0x' + 'cd'.repeat(32), hAnchor: 1, outKind: 1,
    nullifiers: ['0x' + '99'.repeat(32)], outputs: [],
    hasExitVout: true, exitVout: 3, exitValue: 12345678901234n, destSpkHash: '0x' + 'ee'.repeat(32),
  };
  const [decoded] = decodeAbiParameters([BTC_POOL_SPEND_VALUES_TUPLE], encodeBtcPoolSpendPublicValues(stmt));
  assert.equal(decoded.outputs.length, 0);
  assert.equal(decoded.hasExitVout, true);
  assert.equal(decoded.exitVout, 3);
  assert.equal(decoded.exitValue, 12345678901234n);
  ok('encodeBtcPoolSpendPublicValues round-trips through an independent decoder (exit shape, large exitValue)');
}

// ── Revert-vs-network-error classification, mocked: a real on-chain revert (viem's structured shape)
// resolves to `false`; a transport failure re-throws rather than being silently treated as "invalid".
{
  const stmt = { version: 1, asset: '0x' + '00'.repeat(32), root: '0x' + '00'.repeat(32), hAnchor: 1, outKind: 0, nullifiers: [], outputs: [], hasExitVout: false, exitVout: 0, exitValue: 0n, destSpkHash: '0x' + '00'.repeat(32) };

  const revertingClient = { call: async () => { const e = new Error('execution reverted'); e.name = 'ContractFunctionExecutionError'; e.cause = { data: '0xdeadbeef' }; throw e; } };
  assert.equal(await verifyBtcPoolSpendProof(stmt, '0x00', { client: revertingClient }), false);
  ok('a structured on-chain revert (cause.data set) resolves to false, not a throw');

  const timingOutClient = { call: async () => { const e = new Error('timeout of 10000ms exceeded'); e.name = 'TimeoutError'; throw e; } };
  await assert.rejects(() => verifyBtcPoolSpendProof(stmt, '0x00', { client: timingOutClient }), /timeout/i);
  ok('a transport timeout re-throws rather than being silently treated as an invalid proof');
}

console.log(`btc-pool-verify: all ${passed} checks passed`);
