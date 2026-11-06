// The eth-state stage waits for Ethereum finality to move past the head the last candidate reached, so it asks the network to prove a
// request the guest will run ("finalized head did not advance" otherwise). Offline: node --test worker-relay/tests/beacon-finality.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizedHead, finalizedSlot, finalityNotAdvanced } from '../src/lib/beacon-finality.js';

const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const update = (slot) => ({ version: 'fulu', data: { finalized_header: { beacon: { slot: String(slot) }, execution: { block_number: '26257739' } } } });

test('the finalized slot is read from the beacon finality update', async () => {
  let asked = '';
  const f = async (url, init) => { asked = url; assert.equal(init.headers.accept, 'application/json'); return reply(200, update(15496960))(); };
  assert.equal(await finalizedSlot('https://beacon.example/', { fetchImpl: f }), 15496960);
  assert.equal(asked, 'https://beacon.example/eth/v1/beacon/light_client/finality_update', 'no double slash from a trailing one');
});

test('the finalized head carries the execution block a candidate made now proves the pool at', async () => {
  assert.deepEqual(await finalizedHead('https://b', { fetchImpl: reply(200, update(15496960)) }), { slot: 15496960, block: 26257739 });
  const bare = { data: { finalized_header: { beacon: { slot: '15496960' } } } };
  assert.deepEqual(await finalizedHead('https://b', { fetchImpl: reply(200, bare) }), { slot: 15496960, block: null }, 'no execution header');
});

test('an answer that is an error or names no slot throws, so the stage proceeds as before', async () => {
  await assert.rejects(finalizedSlot('https://b', { fetchImpl: reply(503, {}) }), /503/);
  await assert.rejects(finalizedSlot('https://b', { fetchImpl: reply(200, { data: {} }) }), /no finalized slot/);
  await assert.rejects(finalizedSlot('https://b', { fetchImpl: reply(200, update(0)) }), /no finalized slot/);
});

test('the stage waits while the head has not moved past the last candidate, and goes once it has', () => {
  const committed = { bootstrap_slot: 15496960, last_block: 26257739 };   // the 20:51 UTC case
  assert.match(finalityNotAdvanced({ committed, slot: 15496960 }), /not past/, 'the same head: wait');
  assert.match(finalityNotAdvanced({ committed, slot: 15496928 }), /not past/, 'an older reading: wait');
  assert.equal(finalityNotAdvanced({ committed, slot: 15496992 }), null, 'the next checkpoint: go');
});

test('no committed file (a cold start) never makes the stage wait', () => {
  assert.equal(finalityNotAdvanced({ committed: null, slot: 15496960 }), null);
  assert.equal(finalityNotAdvanced({ committed: {}, slot: 15496960 }), null);
});
