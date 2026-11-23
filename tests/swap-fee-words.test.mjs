// The swap card's words for a relay that turns a fee back at submit ("relay 400: submitJob: relay fee below the current floor — re-quote higher or self-settle"):
// it was shown as the relay sent it. dapp/teth/wrap.js is loaded as the page loads it, with the three modules it imports by site path stood in for.
//   node --test tests/swap-fee-words.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

const STUBS = {
  '/trade/poolux.js': 'export const getUx = async () => ({}); export const forgetUx = () => {};',
  '/teth/read.js': 'export const WRAP_TIP = "0x0"; export const WRAP_WITH_TIP = "0x0"; export const CETH_ID = "0x0"; export const POOL = "0x0";',
  '/trade/util.js': 'export const strip = (s) => s; export const word = (s) => s; export const rpc = async () => null; export const ethCall = async () => null; export const api = async () => null; export const E10 = 10n ** 10n;',
};
register('data:text/javascript,' + encodeURIComponent(`const S = ${JSON.stringify(STUBS)};
export async function resolve(spec, ctx, next) {
  const path = spec.split('?')[0];
  if (path in S) return { url: 'data:text/javascript,' + encodeURIComponent(S[path]), shortCircuit: true };
  return next(spec, ctx);
}`));
const { relayWords } = await import('../dapp/teth/wrap.js');

const RAW = 'relay 400: submitJob: relay fee below the current floor — re-quote higher or self-settle';

test('a fee turned back at submit is explained as the gas it is, not shown as the relay sent it', () => {
  const w = relayWords(new Error(RAW));
  assert.doesNotMatch(w, /relay 400|submitJob|re-quote|self-settle/, w);
  assert.match(w, /gas is high/i);
  assert.match(w, /press again/i);
});

test('the same words for a fee turned back after a note was combined, and for the page\'s own "fee moved" error', () => {
  assert.match(relayWords(new Error('settle failed: relay fee below the current floor (bound fee is below the marginal cost of $0.24)')), /gas is high/i);
  assert.match(relayWords(Object.assign(new Error('The network fee rose while this was being sent.'), { code: 'FEE_MOVED' })), /gas is high/i);
});

test('they do not claim nothing was spent (a note may already have been combined) or say the relay is short of anything', () => {
  const w = relayWords(new Error(RAW));
  assert.doesNotMatch(w, /nothing was spent/i);
  const sentences = w.split(/(?<=[.!?])\s+/);
  assert.ok(!sentences.some((x) => /\brelay/i.test(x) && /\b(gas|funds?|balance|allowance|budget)\b/i.test(x)), 'no sentence has the relay and gas together');
});

test('other refusals keep their words', () => {
  assert.match(relayWords(new Error('relay 400: submitJob: queue full, retry later')), /queue full/);
  assert.match(relayWords(new Error('Failed to fetch')), /Could not reach the relay/);
  assert.match(relayWords(new Error('execution reverted 0x29b3c833')), /pool moved/i);
});
