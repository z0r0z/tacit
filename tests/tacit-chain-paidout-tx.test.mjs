// The payout link on an exit's "Settled on Ethereum" line: paidOutTxOf finds the TAC Transfer(TacitBlocks -> recipient) at or after the landing block.
//
// Run: node tests/tacit-chain-paidout-tx.test.mjs
import assert from 'node:assert/strict';
import { paidOutTxOf } from '../dapp/tacit-chain-client.js';

const cfg = { blocks: '0x' + 'ab'.repeat(20) }, TO = '0x' + 'cd'.repeat(20), LAND = '0x' + '11'.repeat(32), PAY = '0x' + '22'.repeat(32);
const asked = [];
const node = (logs, rc = { blockNumber: '0x64' }) => async (m, [p]) => { asked.push([m, p]); if (m === 'eth_getTransactionReceipt') return rc; if (m === 'eth_getLogs') return logs; throw new Error('unexpected ' + m); };

assert.equal(await paidOutTxOf({ cfg, rpcCall: node([{ transactionHash: PAY }]) }, TO, LAND), PAY);
const q = asked.find(([m]) => m === 'eth_getLogs')[1];
assert.equal(q.address, '0xa1313eb9f3a445606d9583bcac3ebeb56a858279', 'the TAC token');
assert.equal(q.topics[1], '0x' + 'ab'.repeat(20).padStart(64, '0'), 'from TacitBlocks');
assert.equal(q.topics[2], '0x' + 'cd'.repeat(20).padStart(64, '0'), 'to the recipient');
assert.equal(q.fromBlock, '0x64', 'from the landing block');
assert.equal(await paidOutTxOf({ cfg, rpcCall: node([]) }, TO, LAND), null, 'not paid out yet');
assert.equal(await paidOutTxOf({ cfg, rpcCall: node([], null) }, TO, LAND), null, 'landing tx not indexed');
assert.equal(await paidOutTxOf({ cfg, rpcCall: async () => { throw new Error('range'); } }, TO, LAND), null, 'a node that refuses');
assert.equal(await paidOutTxOf({ cfg, rpcCall: node([{ transactionHash: PAY }]) }, 'tacit1abc', LAND), null, 'a tacit1 recipient has no payout');
assert.equal(await paidOutTxOf({ cfg, rpcCall: node([{ transactionHash: 'nope' }]) }, TO, LAND), null, 'a malformed hash');
console.log('ok   paidOutTxOf: finds the payout from the landing block, null otherwise, never throws');
