// /chain proxy read cache: immutable responses are reused, concurrent identical requests share one upstream call,
// and anything that can still change is never stored.
//
// Runs offline with a stubbed fetch: node tests/chain-proxy-cache.test.mjs

let upstreamCalls = 0;
const respond = new Map();
globalThis.fetch = async (url) => {
  upstreamCalls++;
  const path = String(url).replace(/^https?:\/\/[^/]+(\/[a-z]+)?\/api/, '').replace(/^https?:\/\/[^/]+/, '');
  const bare = path.split('?')[0];
  for (const [re, fn] of respond) if (re.test(bare)) { await new Promise((r) => setTimeout(r, 15)); return fn(path); }
  return new Response('{"error":"unstubbed ' + path + '"}', { status: 404 });
};
const worker = await import('../worker/src/index.js');
const env = { REGISTRY_KV: { get: async () => null, put: async () => {}, delete: async () => {} } };
const call = (path, net = 'mainnet') => worker.default.fetch(new Request('https://api.test/chain' + path + (path.includes('?') ? '&' : '?') + 'network=' + net), env, { waitUntil() {} });
const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? ' - ' + d : '')); fail++; } };
const T1 = 'a1'.repeat(32), T2 = 'b2'.repeat(32), T3 = 'c3'.repeat(32), H = 'd4'.repeat(32);

respond.set(new RegExp('^/tx/' + T1 + '$'), () => j({ txid: T1, status: { confirmed: true, block_height: 100 } }));
respond.set(new RegExp('^/tx/' + T2 + '$'), () => j({ txid: T2, status: { confirmed: false } }));
respond.set(new RegExp('^/block/' + H + '$'), () => j({ id: H, height: 5 }));
respond.set(/^\/blocks\/tip\/height$/, () => new Response('967800', { status: 200 }));
respond.set(new RegExp('^/tx/' + T3 + '/outspend/0$'), () => j({ spent: true, txid: T1, status: { confirmed: true } }));
respond.set(new RegExp('^/tx/' + T3 + '/outspend/1$'), () => j({ spent: true, txid: T1, status: { confirmed: false } }));

console.log('\nimmutable data is served from cache:');
{
  const before = upstreamCalls;
  const a = await call('/tx/' + T1), b = await call('/tx/' + T1);
  ok('confirmed tx: one upstream call for two reads', upstreamCalls - before === 1, 'calls ' + (upstreamCalls - before));
  ok('second read is marked as a cache hit', b.headers.get('X-Chain-Cache') === 'hit' && a.headers.get('X-Chain-Cache') === 'miss');
  ok('bodies are identical', (await a.text()) === (await b.text()));
}
{
  const before = upstreamCalls;
  await call('/block/' + H); await call('/block/' + H);
  ok('block by hash cached', upstreamCalls - before === 1);
}
{
  const before = upstreamCalls;
  await call('/tx/' + T3 + '/outspend/0'); await call('/tx/' + T3 + '/outspend/0');
  ok('outspend with a confirmed spend cached', upstreamCalls - before === 1);
}

console.log('\nanything that can still change is not stored:');
{
  const before = upstreamCalls;
  await call('/tx/' + T2); await call('/tx/' + T2);
  ok('unconfirmed tx re-fetched every time', upstreamCalls - before === 2);
}
{
  const before = upstreamCalls;
  await call('/tx/' + T3 + '/outspend/1'); await call('/tx/' + T3 + '/outspend/1');
  ok('outspend whose spend is unconfirmed re-fetched', upstreamCalls - before === 2);
}
{
  const before = upstreamCalls;
  const r = await call('/tx/' + 'ee'.repeat(32));
  await call('/tx/' + 'ee'.repeat(32));
  ok('a 404 is not cached', r.status === 404 && upstreamCalls - before === 2);
}

console.log('\nconcurrent identical requests share one upstream call:');
{
  const before = upstreamCalls;
  const T = 'f5'.repeat(32);
  respond.set(new RegExp('^/tx/' + T + '$'), () => j({ txid: T, status: { confirmed: false } }));
  const rs = await Promise.all([call('/tx/' + T), call('/tx/' + T), call('/tx/' + T), call('/tx/' + T)]);
  ok('four simultaneous reads make one upstream call', upstreamCalls - before === 1, 'calls ' + (upstreamCalls - before));
  ok('three of them are marked coalesced', rs.filter((r) => r.headers.get('X-Chain-Cache') === 'coalesced').length === 3);
  ok('all four get the same body', new Set(await Promise.all(rs.map((r) => r.text()))).size === 1);
}

console.log('\nrate-limit signal survives the wrapper:');
{
  respond.set(/^\/fee-estimates$/, () => new Response('{"error":"slow down"}', { status: 429, headers: { 'Retry-After': '17' } }));
  const r = await call('/fee-estimates');
  ok('a 429 is passed through and not cached', r.status === 429);
}

console.log('\nwhen every explorer refuses, the last good answer is served:');
{
  const A = 'ab'.repeat(20);
  let limited = false;
  respond.set(new RegExp('^/address/' + A + '/utxo$'), () => (limited ? j({ error: 'slow down' }, 429) : j([{ txid: T1, vout: 0, value: 546 }])));
  const fresh = await call('/address/' + A + '/utxo', 'signet');
  limited = true;
  const again = await call('/address/' + A + '/utxo', 'signet');
  ok('a changeable read is not cached while the explorers answer', fresh.headers.get('X-Chain-Cache') === 'miss');
  const ab = await again.clone().text(); ok('a refusal is answered with the last good body, marked stale', again.status === 200 && again.headers.get('X-Chain-Cache') === 'stale' && ab.includes(T1), again.status + ' ' + again.headers.get('X-Chain-Cache') + ' ' + ab.slice(0, 80));
  const none = await call('/address/' + 'cd'.repeat(20) + '/utxo', 'signet');
  ok('a path never read before still reports the refusal', none.status !== 200);
}

console.log('\nwith every explorer cooling, one probe in each 1.5 s still goes out:');
{
  const P = 'ef'.repeat(32);
  respond.set(new RegExp('^/tx/' + P + '/hex$'), () => new Response('{"e":1}', { status: 429, headers: { 'Retry-After': '60' } }));
  await call('/tx/' + P + '/hex', 'signet');           // every signet explorer now cools for a minute
  const q = 'e1'.repeat(32);
  respond.set(new RegExp('^/tx/' + q + '/hex$'), () => new Response('00', { status: 200 }));
  await new Promise((r) => setTimeout(r, 1600));
  const before = upstreamCalls;
  const first = await call('/tx/' + q + '/hex', 'signet');
  ok('the first read after the pause is tried upstream although all are cooling', upstreamCalls - before >= 1 && first.status === 200, first.status + ' calls ' + (upstreamCalls - before));
  const mid = upstreamCalls;
  const second = await call('/tx/' + P + '/hex?x=1', 'signet');
  ok('a second read inside the 1.5 s is refused at once, with no upstream call', second.status === 429 && upstreamCalls === mid, second.status + ' calls ' + (upstreamCalls - mid));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
