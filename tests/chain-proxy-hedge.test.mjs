// /chain proxy upstream racing: a slow host is hedged after a short wait, a failing host is skipped at once,
// and hosts that keep failing drop behind the healthy ones.
//
// Offline, stubbed fetch: node tests/chain-proxy-hedge.test.mjs

const calls = []; // [{ host, at, aborted }]
let scenario = () => new Response('{}', { status: 200 });
globalThis.fetch = (url, init) => {
  const host = new URL(url).host;
  const rec = { host, at: Date.now(), aborted: false };
  calls.push(rec);
  return new Promise((resolve, reject) => {
    if (init && init.signal) init.signal.addEventListener('abort', () => { rec.aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    Promise.resolve(scenario(host, calls.filter((c) => c.host === host).length, calls.length)).then((r) => { if (r) resolve(r); });
  });
};
const worker = await import('../worker/src/index.js');
const env = { CHAIN_HEDGE_MS: '150', REGISTRY_KV: { get: async () => null, put: async () => {}, delete: async () => {} } };
let seq = 0;
const call = () => { const T = (++seq).toString(16).padStart(64, '0'); return worker.default.fetch(new Request('https://api.test/chain/address/bc1qxyz' + 'a'.repeat(20) + '/utxo?network=mainnet&n=' + T), env, { waitUntil() {} }); };
const reset = () => { calls.length = 0; worker._upstreamHealth.clear(); worker._upstreamScore.clear(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? ' - ' + d : '')); fail++; } };

console.log('\na slow first host is hedged:');
{
  reset();
  let firstHost = null;
  scenario = (host, n, total) => { if (total === 1) { firstHost = host; return null; } return new Response('[]', { status: 200 }); }; // first call hangs
  const t0 = Date.now();
  const r = await call();
  const dt = Date.now() - t0;
  ok('the answer comes from the second host', r.status === 200);
  ok('after the hedge delay, not after the full timeout', dt >= 140 && dt < 1500, dt + 'ms');
  await sleep(30);
  ok('the slow host was aborted once the other answered', calls[0].aborted === true);
  ok('exactly two hosts were contacted', calls.length === 2 && calls[0].host !== calls[1].host);
}

console.log('\na rate-limited first host is skipped without waiting:');
{
  reset();
  scenario = (host, n, total) => total === 1 ? new Response('{"e":1}', { status: 429, headers: { 'Retry-After': '20' } }) : new Response('[]', { status: 200 });
  const t0 = Date.now();
  const r = await call();
  ok('falls through to the next host', r.status === 200 && calls.length === 2);
  ok('without waiting out the hedge delay', Date.now() - t0 < 120, (Date.now() - t0) + 'ms');
  ok('the limited host is cooling for its Retry-After', worker._upstreamHealth.size === 1);
}

console.log('\nevery host limited:');
{
  reset();
  scenario = () => new Response('{"e":1}', { status: 429, headers: { 'Retry-After': '9' } });
  const r = await call();
  ok('the caller gets a 429 with the upstream Retry-After', r.status === 429 && r.headers.get('Retry-After') === '9', r.status + ' ' + r.headers.get('Retry-After'));
}

console.log('\nfailing hosts drop behind healthy ones:');
{
  reset();
  const bases = ['https://a.test/api', 'https://b.test/api', 'https://c.test/api'];
  for (let i = 0; i < 3; i++) { const h = worker._upstreamScore; h.set(bases[0], { ewmaMs: 0, fails: 2, lastFailAt: Date.now() }); }
  const order = worker._orderedUpstreams(bases, 'k');
  ok('a host with repeated failures is tried last', order[order.length - 1] === bases[0], order.join(' '));
  worker._upstreamScore.set(bases[1], { ewmaMs: 9000, fails: 0, lastFailAt: 0 });
  const order2 = worker._orderedUpstreams(bases, 'k2');
  ok('a host that is far slower than usual is also demoted', order2.indexOf(bases[2]) < order2.indexOf(bases[1]) && order2.indexOf(bases[2]) < order2.indexOf(bases[0]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
