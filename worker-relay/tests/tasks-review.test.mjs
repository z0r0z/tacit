// A reviewed step is claimed with 32 bytes naming the work: a Bitcoin transaction id by default, or a short id from another site as text.
//   node worker-relay/tests/tasks-review.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewData, reviewText } from '../../dapp/tasks/review.js';
import { checkJob, stepsCompleted } from '../src/lib/points-tasks.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')).jobs;
const txid = 'ab'.repeat(32);

// Nothing asked for in particular: a Bitcoin transaction id, lower-cased, as it always was.
assert.equal(reviewData({}, `  ${txid.toUpperCase()}\n`), `0x${txid}`);
assert.equal(reviewData({}, 'ab'.repeat(31)), null, 'a short id is not a transaction id');
assert.equal(reviewData({}, 'zz'.repeat(32)), null, 'nor is anything but hex');
assert.equal(reviewData(undefined, txid), `0x${txid}`, 'a step with no spec is the same');
console.log('ok - a step with no input spec still asks for a Bitcoin transaction id');

// Text: the ASCII bytes, padded with zeros to 32, and read back the same.
const cg = { input: { pattern: '^[A-Za-z0-9-]{3,32}$', text: true } };
const data = reviewData(cg, ' CL12345 ');
assert.equal(data, `0x${'434c3132333435'.padEnd(64, '0')}`);
assert.equal(reviewText(data), 'CL12345');
assert.equal(reviewData(cg, 'x'.repeat(32)).length, 66, 'thirty-two characters fill it exactly');
for (const bad of ['', 'CL', 'CL 12345', 'CL12345!', 'é'.repeat(5), 'x'.repeat(33)]) assert.equal(reviewData(cg, bad), null, `refuses ${JSON.stringify(bad)}`);
console.log('ok - an id from another site is written as padded text and read back');

// The service reads 32 bytes and a listed hash, whatever they name: a text claim is credited once its transaction is listed, and not before.
const me = '0x1111111111111111111111111111111111111111', hash = `0x${'cd'.repeat(32)}`;
const step = { id: '01-filer', kind: 'review', to: '0x0000000000000000000000000000000000000000', gas: 22000, approved: [], minWei: '100', maxWei: '100' };
const job = (approved) => checkJob({ id: 'text-review', chainId: 1, opensAt: 1, steps: [{ ...step, approved }] });
const claim = { hash, from: me, to: me, input: data };
const ok = { status: 'success', logs: [] };
assert.deepEqual(stepsCompleted(job([]), claim, ok), [], 'a claim nobody has read is nothing');
assert.deepEqual(stepsCompleted(job([hash]), claim, ok).map((d) => d.step.id), ['01-filer'], 'a listed claim is the step');
assert.deepEqual(stepsCompleted(job([hash]), { ...claim, to: '0x2222222222222222222222222222222222222222' }, ok), [], 'it has to be to the sender itself');
console.log('ok - a text claim is credited once its transaction is listed');

// The shipped job: the service's file and the page's file agree, and the page names what it asks for.
const service = read('../src/lib/points-tasks-jobs.json').find((j) => j.id === 'coingecko-listing');
const page = read('../../dapp/tasks/jobs.json').find((j) => j.id === 'coingecko-listing');
assert.ok(service && page, 'the CoinGecko job is in both files');
checkJob(service);
assert.equal(service.steps.length, 1);
assert.equal(page.steps[0].id, service.steps[0].id);
assert.equal(page.steps[0].minWei, service.steps[0].minWei);
assert.ok(reviewData(page.steps[0], 'CL12345'), 'the page accepts a request id');
assert.equal(reviewData(page.steps[0], txid), reviewData(page.steps[0], txid), 'and is deterministic');
for (const l of page.links) assert.match(l.href, /^(https:\/\/|\/)/, `link ${l.label}`);
console.log('ok - the CoinGecko job is the same in the service and the page');
