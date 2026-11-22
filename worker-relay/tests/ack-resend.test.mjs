// An outcome the relay paid for (a settle that landed, a proof handed back) is not lost when the API cannot take its ack: it is kept and sent again until the API
// takes it, says no, or the keeping time is over. An error ack, or an answer that is a verdict (a 4xx), is not kept: the job is served again, or the API has decided.
// Offline: node --test worker-relay/tests/ack-resend.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let handler = () => {};
const server = createServer((req, res) => handler(req, res)).listen(0);
await new Promise((r) => server.once('listening', r));
process.env.RPC_URL = 'http://127.0.0.1:1';
process.env.RELAY_KEY = '0x' + '11'.repeat(32);
process.env.BOX_TOKEN = 'test-box-token';
process.env.WORKER_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.ACK_RESEND_MS = '40';
process.env.ACK_KEEP_MS = '700';
const { confidentialAck } = await import('../src/lib/worker-client.js');
test.after(() => { server.closeAllConnections?.(); server.close(); });

const seen = [];                                                    // the acks the stand-in received, in order: { jobId, body }
const api = (status) => (req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => { const body = JSON.parse(b); seen.push({ jobId: body.jobId, body }); res.writeHead(typeof status === 'function' ? status(body) : status, { 'content-type': 'application/json' }); res.end('{}'); });
};
const count = (jobId) => seen.filter((s) => s.jobId === jobId).length;
const until = async (f, ms = 8000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('a settled ack the API could not take is kept, and taken once the API is back; it is not sent again after that', async () => {
  let up = false;
  handler = api(() => (up ? 200 : 502));
  const r = await confidentialAck({ jobId: 'job-settled', txHash: '0x' + 'ab'.repeat(32) });
  assert.deepEqual({ ok: r.ok, kept: r.kept, status: r.status }, { ok: false, kept: true, status: 502 });
  assert.equal(count('job-settled'), 3, 'three tries first');
  up = true;
  await until(() => count('job-settled') === 4);
  assert.equal(seen.at(-1).body.txHash, '0x' + 'ab'.repeat(32), 'the same outcome');
  await pause(250);
  assert.equal(count('job-settled'), 4, 'taken, so not sent again');
});

test('a proof handed back is kept the same way', async () => {
  let up = false;
  handler = api(() => (up ? 200 : 503));
  const r = await confidentialAck({ jobId: 'job-proof', publicValues: '0x01', proof: '0x02' });
  assert.equal(r.kept, true);
  up = true;
  await until(() => count('job-proof') === 4);
  assert.deepEqual([seen.at(-1).body.publicValues, seen.at(-1).body.proof], ['0x01', '0x02']);
});

test('an error ack is not kept: the job is served again, and an old failure must not reach it later', async () => {
  handler = api(502);
  const r = await confidentialAck({ jobId: 'job-error', error: 'prove failed: something' });
  assert.equal(r.ok, false);
  assert.equal(r.kept, undefined);
  await pause(300);
  assert.equal(count('job-error'), 3, 'only the three tries');
});

test('an answer that is a verdict is not asked again, kept or not', async () => {
  handler = api(409);
  const r = await confidentialAck({ jobId: 'job-409', txHash: '0x' + 'cd'.repeat(32) });
  assert.equal(r.ok, false);
  assert.equal(r.kept, undefined);
  await pause(300);
  assert.equal(count('job-409'), 1);
});

test('a kept ack is given up on when the API stays away past the keeping time', async () => {
  handler = api(502);
  const r = await confidentialAck({ jobId: 'job-gone', txHash: '0x' + 'ef'.repeat(32) });
  assert.equal(r.kept, true);
  await pause(1200);                                                // the keeping time is 700 ms
  const after = count('job-gone');
  assert.ok(after > 3, 'it was tried again meanwhile');
  await pause(300);
  assert.equal(count('job-gone'), after, 'and then no more');
});
