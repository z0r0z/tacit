// A lost acknowledgement can no longer stall reflection: a slow receipt is waited out by polling the pool, a batch
// that landed without its ack is adopted from the API's stash, and a stalled lane or drifted cursor is detectable.
// Offline (mocked RPC, KV and API): node tests/reflection-lost-ack.test.mjs
import { readFileSync } from 'node:fs';
import { awaitAttestLanding, digestDeepEnough } from '../worker-relay/src/lib/attest-wait.js';
import { recoverLostAck, manualRecoveryHint } from '../worker-relay/src/lib/reflection-reconcile.js';
import { stallVerdict, driftVerdict } from '../worker-relay/src/lib/reflection-stall.js';

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? ' - ' + d : '')); fail++; } };

const D1 = '0x' + '11'.repeat(32), D2 = '0x' + '22'.repeat(32), TX = '0x' + 'ab'.repeat(32);

// ── awaitAttestLanding: virtual clock, scripted chain ──
function chain({ digestAt = Infinity, digest = D1, tx = () => ({ state: 'pending' }) } = {}) {
  let t = 0, polls = 0;
  return {
    now: () => t, sleep: async (s) => { t += s * 1000; },
    readDigest: async () => { polls++; return t >= digestAt * 1000 ? digest : D2; },
    txStatus: async () => tx(t),
    polls: () => polls,
  };
}
const wait = (c, o = {}) => awaitAttestLanding({ newDigest: D1, txHash: TX, readDigest: c.readDigest, txStatus: c.txStatus, sleep: c.sleep, now: c.now, windowSecs: 1800, pollSecs: 15, confirmations: 3, ...o });

{
  // The observed failure: the tx lands ~5 minutes in, long after a default receipt wait would have given up.
  const c = chain({ digestAt: 300, tx: (t) => (t >= 300_000 ? { state: 'mined', confirmations: 9 } : { state: 'pending' }) });
  const r = await wait(c);
  ok('a tx that lands minutes late is seen as landed, not as a failure', r.outcome === 'landed');
}
{
  const c = chain({ digestAt: 60, tx: () => ({ state: 'mined', confirmations: 1 }) });
  const r = await wait(c, { windowSecs: 120 });
  ok('a landed digest is not acked until the receipt is deep enough', r.outcome === 'timeout');
  const c2 = chain({ digestAt: 60, tx: (t) => ({ state: 'mined', confirmations: t >= 200_000 ? 3 : 1 }) });
  ok('and is acked once it is', (await wait(c2)).outcome === 'landed');
}
{
  const c = chain({ tx: () => ({ state: 'pending' }) });
  const r = await wait(c, { windowSecs: 600 });
  ok('a window that closes on a still-pending tx is a timeout, never a throw', r.outcome === 'timeout');
  ok('it polled the chain rather than blocking once', c.polls() > 10);
}
{
  const c = chain({ tx: () => ({ state: 'reverted' }) });
  ok('a reverted tx ends the wait early', (await wait(c)).outcome === 'reverted');
}
{
  const c = chain({ digestAt: 10, tx: () => ({ state: 'reverted' }) });
  ok('a revert of a duplicate does not hide a digest that did land', (await wait(c)).outcome === 'landed');
}
{
  const c = chain({ tx: () => ({ state: 'missing' }) });
  ok('a tx unknown to the node for many polls is dropped', (await wait(c, { dropMisses: 4 })).outcome === 'dropped');
  let n = 0;
  const c2 = chain({ digestAt: 120, tx: () => ({ state: n++ < 3 ? 'missing' : 'pending' }) });
  ok('a brief propagation gap is not a drop', (await wait(c2, { dropMisses: 4 })).outcome === 'landed');
}
{
  const c = chain({ digestAt: 30, tx: () => ({ state: 'missing' }) });
  ok('a replaced tx whose batch landed counts as landed', (await wait(c, { dropMisses: 20 })).outcome === 'landed');
}
{
  let n = 0;
  const c = chain({ digestAt: 60 });
  c.readDigest = async () => { if (n++ < 2) throw new Error('rpc down'); return c.now() >= 60_000 ? D1 : D2; };
  c.txStatus = async () => { throw new Error('rpc down'); };
  ok('endpoint errors are retried, not fatal', (await wait(c)).outcome === 'landed');
}

// ── depth: a digest seen only at the head is not enough without a receipt to count ──
{
  const c = chain({ digestAt: 30, tx: () => ({ state: 'missing' }) });
  const shallow = await wait(c, { windowSecs: 300, deepEnough: async () => false });
  ok('with no receipt, a digest that is not deep enough is not landed', shallow.outcome === 'timeout' || shallow.outcome === 'dropped');
  const c2 = chain({ digestAt: 30, tx: () => ({ state: 'pending' }) });
  ok('a pending tx with a shallow digest keeps waiting', (await wait(c2, { windowSecs: 300, deepEnough: async () => false })).outcome === 'timeout');
  let deep = false;
  const c3 = chain({ digestAt: 30, tx: () => ({ state: 'missing' }) });
  const r3 = wait(c3, { deepEnough: async () => { const d = deep; deep = c3.now() >= 90_000; return d; } });
  ok('it lands once the digest holds at depth', (await r3).outcome === 'landed');
  const c4 = chain({ digestAt: 30, tx: () => ({ state: 'mined', confirmations: 5 }) });
  ok('a deep receipt needs no separate depth read', (await wait(c4, { deepEnough: async () => false })).outcome === 'landed');
  const c5 = chain({ digestAt: 10, tx: () => ({ state: 'reverted' }) });
  ok('a duplicate revert is not landed while shallow', (await wait(c5, { deepEnough: async () => false })).outcome === 'reverted');
}
{
  const reads = [];
  const args = (digest, head = 1000n) => ({ readDigestAt: async (b) => { reads.push(b); return digest; }, getBlockNumber: async () => head, confirmations: 3, expected: D1 });
  ok('digestDeepEnough reads the digest confirmations blocks behind the head', (await digestDeepEnough(args(D1))) === true && reads[0] === 997n);
  ok('and refuses a digest that was not there yet', (await digestDeepEnough(args(D2))) === false);
  ok('and treats a read error as not deep', (await digestDeepEnough({ ...args(D1), readDigestAt: async () => { throw new Error('x'); } })) === false);
}

// ── recoverLostAck ──
{
  const acks = [];
  const r = await recoverLostAck({ onchain: D2, findPending: async (d) => (d === D2 ? { found: true, attestedTo: 968100 } : { found: false }), ack: async (a) => { acks.push(a); return { ok: true, status: 200 }; } });
  ok('a held batch for the pool digest is acked at its own height', r.recovered && r.attestedTo === 968100 && acks.length === 1 && acks[0].jobId === D2 && acks[0].attestedTo === 968100);
}
{
  const acks = [];
  const r = await recoverLostAck({ onchain: D2, findPending: async () => ({ found: false }), ack: async (a) => { acks.push(a); return { ok: true }; } });
  ok('no stash means no ack and a manual recovery command', !r.recovered && acks.length === 0 && /seed/.test(r.hint) && r.hint.includes(D2));
  const r2 = await recoverLostAck({ onchain: D2, findPending: async () => ({}), ack: async () => ({ ok: true }) });
  ok('an API without the route reads as not held', !r2.recovered);
  const r3 = await recoverLostAck({ onchain: D2, findPending: async () => { throw new Error('down'); }, ack: async () => ({ ok: true }) });
  ok('an unreachable API reads as not held', !r3.recovered);
  const r4 = await recoverLostAck({ onchain: D2, findPending: async () => ({ found: true, attestedTo: 5 }), ack: async () => ({ ok: false, status: 409 }) });
  ok('a refused ack is not a recovery', !r4.recovered && /409/.test(r4.reason));
  const acks5 = [];
  const r5 = await recoverLostAck({ onchain: D2, findPending: async () => ({ found: true, attestedTo: 9 }), ack: async (a) => { acks5.push(a); return { ok: true }; }, deepEnough: async () => false });
  ok('a landed batch that is not yet deep enough is not acked', !r5.recovered && r5.waiting === true && acks5.length === 0);
  const r6 = await recoverLostAck({ onchain: D2, findPending: async () => ({ found: true, attestedTo: 9 }), ack: async (a) => { acks5.push(a); return { ok: true }; }, deepEnough: async () => { throw new Error('rpc'); } });
  ok('a depth check that errors counts as not deep', !r6.recovered && r6.waiting === true && acks5.length === 0);
  ok('the hint names the exact ack call too', /reflection\/ack/.test(manualRecoveryHint(D1)));
}

// ── monitor verdicts ──
{
  const now = 10_000_000_000, H = 3_600_000;
  const base = { attestedHeight: 100, tipHeight: 110, now, stallHours: 3 };
  ok('4h since the last ack with blocks waiting is critical', stallVerdict({ ...base, lastAckAt: now - 4 * H }).level === 'critical');
  ok('2h since the last ack is fine', stallVerdict({ ...base, lastAckAt: now - 2 * H }).level === 'ok');
  ok('an idle lane is healthy however old its last ack', stallVerdict({ ...base, tipHeight: 100, lastAckAt: now - 50 * H }).level === 'ok');
  ok('unreadable heights give no verdict', stallVerdict({ ...base, tipHeight: NaN, lastAckAt: now }).level === 'unknown');
  ok('no recorded ack gives no verdict', stallVerdict({ ...base, lastAckAt: NaN }).level === 'unknown');
  ok('matching digests are not drift', driftVerdict({ cursorDigest: D1, onchainDigest: D1.toUpperCase().replace('0X', '0x'), streak: 5 }).drifting === false);
  ok('one drifting run is only noted', driftVerdict({ cursorDigest: D1, onchainDigest: D2, streak: 1 }).level === 'ok');
  ok('two consecutive drifting runs are critical', driftVerdict({ cursorDigest: D1, onchainDigest: D2, streak: 2 }).level === 'critical');
  ok('a missing digest gives no verdict', driftVerdict({ cursorDigest: null, onchainDigest: D2, streak: 9 }).level === 'unknown');
}

// ── API: the stash, the pending/attest-state routes, and the reconcile inside /reflection/job ──
const TOKEN = 'box-token-0123456789abcdef';
const kvStore = new Map();
const KV = { get: async (k) => (kvStore.has(k) ? kvStore.get(k) : null), put: async (k, v) => { kvStore.set(k, v); }, delete: async (k) => { kvStore.delete(k); }, list: async () => ({ keys: [], list_complete: true }) };
const env = { REGISTRY_KV: KV, CONFIDENTIAL_BOX_TOKEN: TOKEN, REFLECTION_ATTEST: '1', REFLECTION_GENESIS_HEIGHT: '99' };
const worker = await import('../worker/src/index.js');
const call = (path, { method = 'GET', body, auth = true } = {}) => worker.default.fetch(new Request('https://api.test' + path, {
  method, headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env, { waitUntil() {} });

const stashKey = (d) => `reflection:pending:mainnet:${d.slice(2)}`;
const scanKey = 'reflection:scan:mainnet';

// A scripted set of Ethereum RPC endpoints: what each says the pool's digest is, and the calls it sees.
let rpcDigest = {};
const rpcCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/publicnode|mevblocker|merkle/.test(u)) {
    const req = JSON.parse(init.body);
    rpcCalls.push({ u, method: req.method, tag: req.params[1] });
    if (req.method === 'eth_blockNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x64' }));
    if (req.method === 'eth_call') {
      const d = rpcDigest[new URL(u).host];
      return d ? new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: d })) : new Response('nope', { status: 500 });
    }
  }
  throw new Error('offline: ' + u);
};

ok('pending is box-only', (await call('/reflection/pending?digest=' + D1, { auth: false })).status === 404);
ok('attest-state is box-only', (await call('/reflection/attest-state', { auth: false })).status === 404);
ok('pending rejects a malformed digest', (await call('/reflection/pending?digest=zz')).status === 400);
ok('pending reports an unknown digest as not found', (await (await call('/reflection/pending?digest=' + D1)).json()).found === false);

// A stash written by an API that predates attestedTo: the height comes from the snapshot itself.
kvStore.set(stashKey(D1), JSON.stringify({ newSnapshot: { height: 968100, noteLeaves: [] }, ethContentHash: null }));
{
  const b = await (await call('/reflection/pending?digest=' + D1.toUpperCase().replace('0X', '0x'))).json();
  ok('pending finds a stash by digest, case-insensitively, and derives its height from the snapshot', b.found === true && b.attestedTo === 968100 && !('newSnapshot' in b));
}
kvStore.set(stashKey(D1), JSON.stringify({ newSnapshot: { height: 1 }, ethContentHash: null, attestedTo: 968150 }));
ok('a stored attestedTo wins', (await (await call('/reflection/pending?digest=' + D1)).json()).attestedTo === 968150);

{
  const g1 = await (await call('/reflection/attest-state')).json();
  ok('the first read starts the stall clock', g1.lastAck && g1.lastAck.seeded === true && g1.submitted === null && g1.driftStreak === 0);
  const g2 = await (await call('/reflection/attest-state')).json();
  ok('and keeps the original start', g2.lastAck.at === g1.lastAck.at);
  ok('a submitted tx is recorded', (await call('/reflection/attest-state', { method: 'POST', body: { network: 'mainnet', submitted: { newDigest: D1, txHash: TX, attestedTo: 968150 } } })).status === 200);
  const g3 = await (await call('/reflection/attest-state')).json();
  ok('and read back', g3.submitted && g3.submitted.newDigest === D1 && g3.submitted.txHash === TX && g3.submitted.attestedTo === 968150);
  ok('a malformed submission is refused', (await call('/reflection/attest-state', { method: 'POST', body: { network: 'mainnet', submitted: { newDigest: 'x', txHash: TX } } })).status === 400);
  const s1 = await (await call('/reflection/attest-state', { method: 'POST', body: { network: 'mainnet', driftSeen: true } })).json();
  const s2 = await (await call('/reflection/attest-state', { method: 'POST', body: { network: 'mainnet', driftSeen: true } })).json();
  ok('drift runs accumulate', s1.driftStreak === 1 && s2.driftStreak === 2);
  const s3 = await (await call('/reflection/attest-state', { method: 'POST', body: { network: 'mainnet', driftSeen: false } })).json();
  ok('and reset on a clean run', s3.driftStreak === 0);
}

// The lost-ack recovery through /reflection/job. The cursor sits at 100 with nothing new to attest, so the
// only thing the job call can do is reconcile.
kvStore.delete(stashKey(D1));
kvStore.set(stashKey(D2), JSON.stringify({ newSnapshot: { height: 105, noteLeaves: [] }, ethContentHash: null, attestedTo: 105 }));
kvStore.set(scanKey, JSON.stringify({ snapshot: null, attestedHeight: 100, tipHeight: 100 }));
const cursor = () => JSON.parse(kvStore.get(scanKey)).attestedHeight;

rpcDigest = { 'ethereum-rpc.publicnode.com': D2, 'rpc.mevblocker.io': D1 };
await call('/reflection/job?network=mainnet');
ok('endpoints that disagree on the pool digest recover nothing', cursor() === 100 && kvStore.has(stashKey(D2)));

rpcDigest = { 'ethereum-rpc.publicnode.com': D2 };
await call('/reflection/job?network=mainnet');
ok('a single answering endpoint recovers nothing', cursor() === 100 && kvStore.has(stashKey(D2)));

rpcDigest = { 'ethereum-rpc.publicnode.com': '0x' + '33'.repeat(32), 'rpc.mevblocker.io': '0x' + '33'.repeat(32) };
await call('/reflection/job?network=mainnet');
ok('a pool digest with no stash recovers nothing', cursor() === 100);

rpcCalls.length = 0;
rpcDigest = { 'ethereum-rpc.publicnode.com': D2, 'rpc.mevblocker.io': D2 };
const jr = await call('/reflection/job?network=mainnet');
ok('the job call answers normally', jr.status === 200);
ok('a stash matching the confirmed pool digest is adopted: cursor advances to its height', cursor() === 105, `cursor=${cursor()}`);
ok('the stash is consumed', !kvStore.has(stashKey(D2)));
ok('the ack time is recorded', JSON.parse(kvStore.get('reflection:lastack:mainnet')).attestedTo === 105 && JSON.parse(kvStore.get('reflection:lastack:mainnet')).jobId === D2);
ok('the digest is read a few blocks back, not at the head', rpcCalls.filter((c) => c.method === 'eth_call').every((c) => c.tag === '0x' + (100 - 3).toString(16)));

// Ack keeps its old contract.
kvStore.set(stashKey(D1), JSON.stringify({ newSnapshot: { height: 120 }, ethContentHash: null, attestedTo: 120 }));
ok('ack with an unknown job is still refused', (await call('/reflection/ack', { method: 'POST', body: { network: 'mainnet', jobId: D2, attestedTo: 105 } })).status === 409);
const ar = await call('/reflection/ack', { method: 'POST', body: { network: 'mainnet', jobId: D1, attestedTo: 120, txHash: TX } });
ok('ack with a held job advances the cursor', ar.status === 200 && cursor() === 120 && !kvStore.has(stashKey(D1)));
ok('and records the tx', JSON.parse(kvStore.get('reflection:lastack:mainnet')).txHash === TX);

// A stale or duplicate ack must not restart the stall clock.
{
  const before = kvStore.get('reflection:lastack:mainnet');
  kvStore.set(stashKey(D2), JSON.stringify({ newSnapshot: { height: 105 }, ethContentHash: null, attestedTo: 105 }));
  const r = await call('/reflection/ack', { method: 'POST', body: { network: 'mainnet', jobId: D2, attestedTo: 105 } });
  ok('a stale ack is accepted without effect', r.status === 200 && cursor() === 120);
  ok('and leaves the last-ack time alone', kvStore.get('reflection:lastack:mainnet') === before);
  ok('and still consumes its stash', !kvStore.has(stashKey(D2)));
}

// ── monitor: no job assembly for the drift probe ──
{
  const monitor = readFileSync(new URL('../worker-relay/src/balance-monitor.js', import.meta.url), 'utf8');
  const fn = monitor.slice(monitor.indexOf('async function checkReflectionStall'), monitor.indexOf('async function main'));
  ok('the stall check never assembles a job', !/reflectionJob|\/reflection\/job/.test(fn) && !/reflectionJob/.test(monitor.slice(0, monitor.indexOf('const log'))));
  ok('the drift probe needs a trusted last ack', /!att\.lastAck\.seeded/.test(fn));
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
