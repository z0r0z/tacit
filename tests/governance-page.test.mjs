// The governance page and the worker build the text a wallet signs separately; they must agree or the API recovers a different signer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { govEthProposeMessage, govDelegateMessage } from '../worker/src/governance.js';
import { proposeMessage, voteMessage, delegateMessage } from '../dapp/govern/message.js';

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
test('page and worker build the same delegation message, for a delegation and for a take-back', () => {
  const to = '0x' + 'Ab'.repeat(20);
  for (const c of [{ network: 'mainnet', delegate: to, rights: 'vote', issued: 1800000000 }, { network: 'mainnet', delegate: to, rights: 'all', issued: 1800000001 },
    { network: 'mainnet', delegate: '', rights: 'vote', issued: 1800000002 }, { network: 'mainnet', delegate: '', issued: 1800000003 }]) {
    assert.equal(delegateMessage(c), govDelegateMessage(c));
  }
  assert.notEqual(delegateMessage({ network: 'mainnet', delegate: to, rights: 'vote', issued: 1 }), delegateMessage({ network: 'mainnet', delegate: to, rights: 'all', issued: 1 }));
});
