// A page whose note waits on the reflection says so (worker/src/index.js handleReflectionWait), and the Bitcoin lane reads the heights
// back (worker-relay/src/lib/note-waits.js) to send headers and attest that block without waiting for cheap gas or company. Only a
// confirmed transaction carrying a Tacit envelope, above the attested height, is kept; the lane's read is behind the box token and
// hands on heights, not transactions. The chain is mocked: no network.
//   node tests/reflection-wait.test.mjs
import { createMemDriver } from '../server/driver-mem.mjs';
import { createCacheStorage } from '../server/cache-mem.mjs';
import { buildEnv } from '../server/harness.mjs';
import { makeNoteWaitsReader, noteWaitNeed } from '../worker-relay/src/lib/note-waits.js';

globalThis.caches = createCacheStorage({ maxBytes: 8 * 1024 * 1024 });
const worker = (await import('../worker/src/index.js')).default;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; console.log(`  FAIL - ${m}`); } };
const TOKEN = 'box-token-for-the-wait-test-0001';
const env = buildEnv(createMemDriver(), { extra: { CONFIDENTIAL_BOX_TOKEN: TOKEN } });
const ctx = { waitUntil: () => {} };
await env.REGISTRY_KV.put('reflection:scan:mainnet', JSON.stringify({ attestedHeight: 1000, tipHeight: 1000, snapshot: {} }));

// an envelope tapscript: <32-byte key> OP_CHECKSIG OP_FALSE OP_IF "TACIT" 0x01 <payload> OP_ENDIF
const hx = (b) => Buffer.from(b).toString('hex');
const envelope = hx([32, ...new Array(32).fill(7), 0xac, 0x00, 0x63, 5, ...Buffer.from('TACIT'), 1, 1, 3, 0x39, 0xaa, 0xbb, 0x68]);
const tacitTx = (h, confirmed = true) => ({ vin: [{ witness: ['aa'.repeat(64), envelope, 'c0' + '11'.repeat(32)] }], status: confirmed ? { confirmed: true, block_height: h } : { confirmed: false } });
const plainTx = (h) => ({ vin: [{ witness: ['aa'.repeat(64), '02' + '11'.repeat(32)] }], status: { confirmed: true, block_height: h } });
const chain = new Map([
  ['a1'.repeat(32), tacitTx(1010)], ['a2'.repeat(32), tacitTx(1004)], ['a3'.repeat(32), tacitTx(990)],
  ['b1'.repeat(32), plainTx(1010)], ['c1'.repeat(32), tacitTx(0, false)],
]);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const m = /\/tx\/([0-9a-f]{64})$/.exec(url);
  if (m && !url.startsWith('https://api.test')) {
    const a = chain.get(m[1]);
    return a ? new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('Transaction not found', { status: 404 });
  }
  return realFetch(input, init);
};
async function call(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
  const resp = await worker.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  let json; try { json = JSON.parse(await resp.text()); } catch { json = {}; }
  return { status: resp.status, json };
}
const wait = (txid, ip = '10.0.0.1') => call('POST', '/reflection/wait', { txid }, { 'CF-Connecting-IP': ip });

let r = await wait('a1'.repeat(32));
ok(r.status === 200 && r.json.height === 1010, `a confirmed Tacit transaction above the attested height is kept as a wait (${r.status} ${r.json.error || ''})`);
r = await wait('a1'.repeat(32));
ok(r.status === 200 && r.json.already === true, 'the same transaction again is answered from the record');
r = await wait('a3'.repeat(32), '10.0.0.2');
ok(r.status === 200 && r.json.covered === true, 'one at or under the attested height is already covered, and not kept');
r = await wait('b1'.repeat(32), '10.0.0.2');
ok(r.status === 400 && r.json.code === 'not_tacit', `a transaction with no Tacit envelope cannot ask for headers (${r.status} ${r.json.code})`);
r = await wait('c1'.repeat(32), '10.0.0.2');
ok(r.status === 409 && r.json.code === 'not_confirmed', 'an unconfirmed one is asked again later');
r = await wait('d1'.repeat(32), '10.0.0.3');
ok(r.status === 404 && r.json.code === 'not_found', 'one the chain does not know is refused');
r = await wait('nope', '10.0.0.3');
ok(r.status === 400 && r.json.code === 'bad_txid', 'a txid that is not 32-byte hex is refused');
r = await wait('a2'.repeat(32), '10.0.0.4');
ok(r.status === 200 && r.json.height === 1004, 'a second wait is kept beside the first');

r = await call('GET', '/reflection/wait');
ok(r.status === 404, 'the list is not public');
r = await call('GET', '/reflection/wait', undefined, { Authorization: `Bearer ${TOKEN}` });
ok(r.status === 200 && JSON.stringify(r.json.waits.map((w) => w.height)) === '[1004,1010]', `the lane reads the heights, lowest first (${JSON.stringify(r.json.waits)})`);
ok(r.json.waits.every((w) => !('txid' in w)), 'and not which transactions wait');

let limited = false;
for (let i = 0; i < 10 && !limited; i++) limited = (await wait('e' + i + 'e'.repeat(62), '10.9.9.9')).status === 429;
ok(limited, 'one address asking again and again is rate-limited');

// the lane's reader, against this API
const read = makeNoteWaitsReader({ workerBase: () => 'https://api.test', network: () => 'mainnet', boxToken: () => TOKEN,
  fetchImpl: (u, o) => worker.fetch(new Request(u, { headers: o.headers }), env, ctx) });
const waits = await read();
ok(Array.isArray(waits) && waits.length === 2 && waits[0].height === 1004, 'the lane reads them with its box token');
const wrong = await makeNoteWaitsReader({ workerBase: 'https://api.test', network: 'mainnet', boxToken: 'x'.repeat(32), fetchImpl: (u, o) => worker.fetch(new Request(u, { headers: o.headers }), env, ctx) })();
ok(wrong === null, 'a wrong token reads nothing (null: the lane goes on as before)');

// what the waits ask of the lane (24 confirmations)
let need = noteWaitNeed({ waits, attested: 1000, relayTip: 1020, confirmations: 24 });
ok(need.headers && !need.attest && need.waiting === 2 && need.lowest === 1004, 'blocks not yet 24 deep on the relay: headers are wanted now, no attest yet');
need = noteWaitNeed({ waits, attested: 1000, relayTip: 1028, confirmations: 24 });
ok(need.attest && need.headers, '1004 is matured (1028 = 1004 + 24): attest it now; 1010 still wants headers');
need = noteWaitNeed({ waits, attested: 1004, relayTip: 1040, confirmations: 24 });
ok(need.attest && !need.headers && need.waiting === 1, 'once 1004 is attested only 1010 waits, matured: attest, no more headers');
need = noteWaitNeed({ waits, attested: 1010, relayTip: 1040, confirmations: 24 });
ok(!need.attest && !need.headers && need.waiting === 0, 'all attested: nothing is asked');
ok(!noteWaitNeed({ waits: null, attested: 1000, relayTip: 1040, confirmations: 24 }).headers && !noteWaitNeed({ waits, attested: null, relayTip: 1040, confirmations: 24 }).attest,
  'an unread list or an unknown attested height asks nothing');

console.log(`\n${pass} reflection-wait checks passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
