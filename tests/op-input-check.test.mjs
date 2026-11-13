// worker/src/op-input-check.js: an op its prover could not read (a field missing, a value not in the form the binary takes) is refused at
// submit, and nothing else is. Through the
// job queue too (worker/src/confidential-settle.js with `checkOp`): the refused op is never queued, a complete one is, and a queue built
// without the check takes anything as before.
//   node tests/op-input-check.test.mjs
import assert from 'node:assert/strict';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { opInputGap } from '../worker/src/op-input-check.js';
import { makeConfidentialSettler } from '../worker/src/confidential-settle.js';
import { stdinFor } from '../dapp/sp1-stdin.js';
import { readFileSync } from 'node:fs';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ok -', m); n++; };
const h = (b) => '0x' + b.repeat(32);
// a wrap op with every field its program reads (the values need only be well formed here)
const wrap = { chainBinding: h('cb'), asset: h('a1'), value: '1000', cx: h('c1'), cy: h('c2'), owner: h('0f'), sigR: '0x02' + '11'.repeat(32), sigZ: h('22') };
ok(stdinFor('wrap', { ...wrap, memoHashes: [h('00')] }) instanceof Uint8Array, 'the complete wrap builds a program input');
ok(opInputGap({ type: 'wrap', op: wrap, memos: ['0x01'] }) === null, 'a complete wrap is let through');
const { asset, ...noAsset } = wrap;
ok(/^the wrap op cannot be read: asset is missing$/.test(opInputGap({ type: 'wrap', op: noAsset, memos: [] }) || ''), `a wrap with no asset is refused: ${opInputGap({ type: 'wrap', op: noAsset })}`);
ok(/owner is missing/.test(opInputGap({ type: 'wrap', op: { ...wrap, owner: undefined } }) || ''), 'and one with no owner');
ok(/cx is not valid hex/.test(opInputGap({ type: 'wrap', op: { ...wrap, cx: 'not hex' } }) || ''), 'and one with a value not in the form the binary takes');
ok(/value must be a decimal string/.test(opInputGap({ type: 'wrap', op: { ...wrap, value: '-1' } }) || ''), 'and one with a value out of range');
ok(opInputGap({ type: 'nosuchop', op: {} }) === null, 'an op type the reader does not know is left alone');
ok(opInputGap({ type: 'wrap', op: null }) === null && opInputGap({ type: 'wrap', op: [] }) === null, 'and so is an op that is not an object (the queue refuses those itself)');

// a batch of transfers (exec-batchtransfer.rs): one to 256 transfers under the batch's chain binding and spend root, each input's secret read as `nk`
const tx = JSON.parse(readFileSync(new URL('./fixtures/sp1-stdin/transfer.op.json', import.meta.url), 'utf8'));
const { chainBinding, spendRoot, memoHashes, ...body } = tx;
const batch = (ops) => ({ chainBinding, spendRoot, ops });
ok(opInputGap({ type: 'batchtransfer', op: batch([body, body]) }) === null, 'a batch of two complete transfers is let through');
ok(/has no transfers/.test(opInputGap({ type: 'batchtransfer', op: batch([]) }) || '') && /has no transfers/.test(opInputGap({ type: 'batchtransfer', op: {} }) || ''),
  'an empty batch is refused (its program stops on one: "batch has no ops")');
ok(/more than 256/.test(opInputGap({ type: 'batchtransfer', op: batch(Array(257).fill(body)) }) || ''), 'and one over the program\'s 256');
ok(/transfer 1 is not an object/.test(opInputGap({ type: 'batchtransfer', op: batch([body, 7]) }) || ''), 'and one with an item that is not a transfer');
ok(/transfer 0 cannot be read: asset is missing/.test(opInputGap({ type: 'batchtransfer', op: batch([{ ...body, asset: undefined }]) }) || ''), 'and one with a transfer missing a field');
const noNk = { ...body, inputs: body.inputs.map(({ nk, ...i }) => i) };
ok(/nk is missing/.test(opInputGap({ type: 'batchtransfer', op: batch([noNk]) }) || ''), 'an input with no nk is refused even when it carries `secret` (the batch program reads nk)');
ok(/spendRoot is missing/.test(opInputGap({ type: 'batchtransfer', op: { chainBinding, ops: [body] } }) || ''), 'and a batch with no spend root');

// through the queue
const hash = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
function store() { const jobs = new Map(); let pending = []; return { getPending: async () => pending.slice(), putPending: async (ids) => { pending = ids.slice(); }, getJob: async (id) => (jobs.has(id) ? JSON.parse(JSON.stringify(jobs.get(id))) : null), putJob: async (id, j) => { jobs.set(id, JSON.parse(JSON.stringify(j))); } }; }
const q = makeConfidentialSettler({ storage: store(), hash, now: () => 1000, sleep: async () => {}, checkOp: opInputGap });
await assert.rejects(q.submitJob({ type: 'wrap', op: noAsset, memos: ['0x01'], mode: 'prove' }), /submitJob: the wrap op cannot be read: asset is missing/);
ok(await q.pendingCount() === 0, 'the incomplete wrap is refused at submit and never queued');
const a = await q.submitJob({ type: 'wrap', op: wrap, memos: ['0x01'], mode: 'prove' });
ok(a.status === 'pending' && await q.pendingCount() === 1, 'the complete one is queued');
const loose = makeConfidentialSettler({ storage: store(), hash, now: () => 1000, sleep: async () => {} });
ok((await loose.submitJob({ type: 'wrap', op: noAsset, mode: 'prove' })).status === 'pending', 'a queue built without the check takes anything, as before');

// the sender a submit counts under (worker/src/index.js queueSender): an IPv4 client by its /24, the server's IPv6 /64 as it is, a mint by its key
const { queueSender } = await import('../worker/src/index.js');
ok(queueSender('203.0.113.17') === '203.0.113.0/24' && queueSender('203.0.113.201') === '203.0.113.0/24', 'two addresses in one IPv4 /24 are one sender');
ok(queueSender('::ffff:10.1.2.3') === '10.1.2.0/24', 'and an IPv4 address written as IPv6 is the same /24');
ok(queueSender('2001:db8:1:2::/64') === '2001:db8:1:2::/64', 'an IPv6 /64 (how the server already counts one) is kept');
ok(queueSender('armed:0123456789abcdef') === 'armed:0123456789abcdef', 'a completed mint counts under its own key');
ok(queueSender('anon') === null && queueSender('') === null && queueSender(null) === null, 'a request with no address counts under none (so it meets no one\'s cap)');
console.log(`op-input-check + queueSender: ${n} passed`);
