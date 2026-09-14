#!/usr/bin/env node
// The settle relay's recognition of a spent nonce (worker-relay/src/settle-relay.js NONCE_TAKEN): when another
// sender on the key uses the nonce a settle was built with, the relay re-reads it and sends again instead of
// failing the job. These are the wordings real clients return, plus ones it must NOT treat as a spent nonce.
//
// Run: node tests/settle-relay-nonce.mjs

import assert from 'node:assert';

Object.assign(process.env, {
  WORKER_BASE: 'http://127.0.0.1:1', BOX_TOKEN: 'x', RPC_URL: 'http://127.0.0.1:1',
  RELAY_KEY: '0x0000000000000000000000000000000000000000000000000000000000000001',
});
const { NONCE_TAKEN } = await import('../worker-relay/src/settle-relay.js');

const taken = [
  'Nonce provided for the transaction (2195) is lower than the current nonce of the account.\nTry increasing the nonce or find the latest nonce with `getTransactionCount`.', // viem NonceTooLowError
  'nonce too low: next nonce 2196, tx nonce 2195', // geth
  'NonceTooLow', // nethermind / erigon code names
  'nonce has already been used', // alchemy / ethers
  'NONCE_EXPIRED', // ethers error code
];
const other = [
  'replacement transaction underpriced',
  'Nonce provided for the transaction (2199) is higher than the next one to be included by the chain.',
  'insufficient funds for gas * price + value',
  'execution reverted: EscrowEmpty()',
  'The request took too long to respond.',
];
for (const m of taken) assert.ok(NONCE_TAKEN.test(m), `should read as a spent nonce: ${m}`);
for (const m of other) assert.ok(!NONCE_TAKEN.test(m), `should not read as a spent nonce: ${m}`);
console.log(`  ok - ${taken.length} spent-nonce wordings recognised, ${other.length} other errors left alone`);
