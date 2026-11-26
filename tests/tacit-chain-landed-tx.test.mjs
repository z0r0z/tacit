// The Etherscan link on "Settled on Ethereum": landedTxOf finds the Ethereum tx that landed a Tacit block from TacitBlocks' Landed(height indexed, ...).
//
// Run: node tests/tacit-chain-landed-tx.test.mjs
import assert from 'node:assert/strict';
import { landedTxOf } from '../dapp/tacit-chain-client.js';

const cfg = { blocks: '0x' + 'ab'.repeat(20) }, TX = '0x' + '12'.repeat(32);
const asked = [];
const node = (logsFor) => async (m, [p]) => { asked.push([m, p]); if (m === 'eth_blockNumber') return '0x1000'; if (m === 'eth_getLogs') return logsFor(p); throw new Error('unexpected ' + m); };

// found in the recent range, keyed on the contract and the height topic
assert.equal(await landedTxOf({ cfg, rpcCall: node(() => [{ transactionHash: TX }]) }, 815), TX);
const q = asked.find(([m]) => m === 'eth_getLogs')[1];
assert.equal(q.address, cfg.blocks);
assert.equal(q.topics[1], '0x' + (815).toString(16).padStart(64, '0'), 'the height is the second topic');
assert.equal(q.topics[0].length, 66);
// not in the recent range: the wider one is tried
asked.length = 0;
assert.equal(await landedTxOf({ cfg, rpcCall: node((p) => (parseInt(p.fromBlock, 16) < 0x1000 - 300 ? [{ transactionHash: TX }] : [])) }, 1), TX);
assert.equal(asked.filter(([m]) => m === 'eth_getLogs').length, 2);
// nothing found, a node that refuses, a bad height, a malformed hash: null, never a throw
assert.equal(await landedTxOf({ cfg, rpcCall: node(() => []) }, 5), null);
assert.equal(await landedTxOf({ cfg, rpcCall: async () => { throw new Error('range too wide'); } }, 5), null);
assert.equal(await landedTxOf({ cfg, rpcCall: node(() => []) }, null), null);
assert.equal(await landedTxOf({ cfg, rpcCall: node(() => [{ transactionHash: 'nope' }]) }, 5), null);
console.log('ok   landedTxOf: found, widens, and never throws');
