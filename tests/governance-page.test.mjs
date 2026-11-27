// The governance page and the worker build the text a wallet signs separately; they must agree or the API recovers a different signer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { govEthProposeMessage } from '../worker/src/governance.js';
import { proposeMessage, voteMessage } from '../dapp/govern/message.js';

test('page and worker build the same proposal message', async () => {
  const c = { network: 'mainnet', title: 'List TAC', body: 'Why — “quoted”\nline two', choices: ['Yes', 'No', 'Later'], category: 'general',
    voting_ends_at: 1800000000, quorum: '500000000', exec_target: '', exec_note: '' };
  assert.equal(await proposeMessage(c), govEthProposeMessage(c));
  assert.equal(await proposeMessage({ ...c, quorum: undefined }), govEthProposeMessage({ ...c, quorum: undefined }));
  assert.notEqual(await proposeMessage(c), await proposeMessage({ ...c, body: 'other' }));
});
test('vote message matches the one the worker recovers', () => {
  assert.equal(voteMessage('ab'.repeat(32), 1, 'No'),
    `Tacit governance vote\nProposal: ${'ab'.repeat(32)}\nChoice: 1 — No\nThis casts a vote weighted by your public TAC balance. No funds move.`);
});
