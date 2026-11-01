// A page's side of the private route (dapp/private-route.js): off it is fetch; on, a request to the relay's service goes through a forwarder as a
// sealed envelope and is never sent directly, whatever fails; and every keeper request of the pay page goes through it.
//   node tests/private-route.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gatewayKeys, newGatewayKey, openRequest } from '../dapp/sealed-request.js';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const te = new TextEncoder();

// The module as a page loads it, with its one absolute import pointed at the file.
const sealedUrl = pathToFileURL(new URL('../dapp/sealed-request.js', import.meta.url).pathname).href;
const source = readFileSync(new URL('../dapp/private-route.js', import.meta.url), 'utf8');
assert.match(source, /import\('\/sealed-request\.js\?cb=[A-Za-z0-9_-]+'\)/, 'it loads the sealed fetch on demand, by the page\'s own URL');
const dir = mkdtempSync(join(tmpdir(), 'private-route-'));
writeFileSync(join(dir, 'private-route.mjs'), source.replace(/\/sealed-request\.js\?cb=[A-Za-z0-9_-]+/, sealedUrl));
const route = await import(pathToFileURL(join(dir, 'private-route.mjs')).href);
const { ROUTE, available, enabled, turn, keeperFetch } = route;

const secret = newGatewayKey(), keys = gatewayKeys(secret);
const PUB = Buffer.from(keys.pub).toString('hex');
const KEEPER = 'https://tacit-evm-pool-keepers.onrender.com';
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

// fetch as the page has it: direct requests are logged, and a forwarder opens each envelope at a gateway in this process.
const calls = [];
let forwarderUp = true;
const seen = new Set();
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push(u);
  if (u.startsWith('https://f1.test/f/k') || u.startsWith('https://f2.test/f/k')) {
    if (!forwarderUp) throw new Error('connection refused');
    const opened = await openRequest(keys, init.body, { seen: (id) => (seen.has(id) ? false : (seen.add(id), true)) });
    const answers = opened.requests.map((r) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: te.encode(JSON.stringify({ via: 'route', path: r.path })), gzip: false }));
    return new Response(opened.batch ? await opened.replyMany(answers) : await opened.reply(200, answers[0].headers, answers[0].body), { status: 200 });
  }
  return new Response(JSON.stringify({ via: 'direct', url: u }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const get = async (url, init) => (await keeperFetch(url, init)).json();

await check('the route is off until the page names a gateway and a forwarder and the person turns it on, and off it is fetch', async () => {
  assert.equal(available(), false);
  assert.equal(enabled(), false);
  turn(true);
  assert.equal(enabled(), false, 'the person\'s choice is not enough without a forwarder to carry it');
  turn(false);
  Object.assign(ROUTE, { gateway: PUB, forwarders: ['https://f1.test', 'https://f2.test'] });
  assert.equal(available(), true);
  assert.equal(enabled(), false, 'and a forwarder is not enough without the choice');
  calls.length = 0;
  assert.deepEqual(await get(`${KEEPER}/1/evm-pool/keeper/head`), { via: 'direct', url: `${KEEPER}/1/evm-pool/keeper/head` });
  assert.deepEqual(calls, [`${KEEPER}/1/evm-pool/keeper/head`]);
  assert.equal(keeperFetch.sealed, false, 'a wallet on a direct fetch asks for a reservation');
});

await check('on, a request to the relay\'s service is a sealed envelope to a forwarder and never a direct request', async () => {
  turn(true);
  assert.equal(enabled(), true);
  assert.equal(keeperFetch.sealed, true, 'a wallet on the route sends without a reservation');
  assert.equal(store.get('tacit-private-route-v1'), '1', 'the choice is kept');
  calls.length = 0;
  assert.deepEqual(await get(`${KEEPER}/8453-x833589fcd6/evm-pool/keeper/quote`), { via: 'route', path: '/8453-x833589fcd6/evm-pool/keeper/quote' });
  const post = await keeperFetch(`${KEEPER}/1/evm-pool/keeper/receive`, { method: 'POST', body: JSON.stringify({ chainId: 1, npk: '7' }) });
  assert.equal((await post.json()).path, '/1/evm-pool/keeper/receive');
  assert.ok(calls.every((u) => /^https:\/\/f[12]\.test\/f\/k$/.test(u)), calls.join(' '));
  assert.ok(!calls.some((u) => u.startsWith(KEEPER)), 'nothing went to the relay itself');
});

await check('a burst of reads made on the route shares envelopes, and each caller has its own answer', async () => {
  calls.length = 0;
  const paths = Array.from({ length: 12 }, (_, i) => `/${i % 2 ? '1' : '8453'}/evm-pool/keeper/${i % 3 ? 'quote' : 'events'}?n=${i}`);
  const answers = await Promise.all(paths.map((p) => get(`${KEEPER}${p}`)));
  assert.deepEqual(answers.map((a) => a.path), paths);
  assert.ok(calls.length <= 3, `${calls.length} envelopes for ${paths.length} reads`);
});

await check('when no forwarder answers a request fails, and is not sent to the relay instead', async () => {
  forwarderUp = false;
  calls.length = 0;
  await assert.rejects(keeperFetch(`${KEEPER}/1/evm-pool/keeper/head`), /refused/);
  await assert.rejects(keeperFetch(`${KEEPER}/1/evm-pool/keeper/relay`, { method: 'POST', body: '{}' }), /refused/);
  assert.ok(calls.every((u) => /\/f\/k$/.test(u)), calls.join(' '));
  assert.ok(!calls.some((u) => u.startsWith(KEEPER)), 'not one request went to the relay');
  forwarderUp = true;
  assert.equal((await get(`${KEEPER}/1/evm-pool/keeper/head`)).via, 'route', 'and it works again when a forwarder does');
});

await check('another relay is refused while the route is on, and what is not a relay is fetched as it was', async () => {
  calls.length = 0;
  await assert.rejects(keeperFetch('https://another.example/1/evm-pool/keeper/head'), /does not reach this relay/);
  await assert.rejects(keeperFetch('https://another.example/evm-pool/keeper'), /does not reach this relay/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await get('https://api.tacit.finance/stats?network=mainnet'), { via: 'direct', url: 'https://api.tacit.finance/stats?network=mainnet' });
  assert.deepEqual(calls, ['https://api.tacit.finance/stats?network=mainnet']);
});

await check('turning it off is a plain fetch again, and a browser that keeps nothing keeps the choice for the visit', async () => {
  turn(false);
  assert.equal(store.has('tacit-private-route-v1'), false);
  assert.equal(enabled(), false);
  calls.length = 0;
  assert.equal((await get(`${KEEPER}/1/evm-pool/keeper/head`)).via, 'direct');
  const real = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  turn(true);
  assert.equal(enabled(), true, 'kept in memory for the visit');
  turn(false);
  assert.equal(enabled(), false);
  globalThis.localStorage = real;
});

// The pay page: every request it makes to a relay goes through keeperFetch.
const page = readFileSync(new URL('../dapp/pay/eth/index.html', import.meta.url), 'utf8');
await check('the pay page sends every request to a relay through keeperFetch, and its wallets ask it whether they are on the route', () => {
  const direct = page.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => /(^|[^\w.])fetch\(/.test(line) && /chainKeeper\(|\.keeper\b|POOL_KEEPERS|onrender\.com\/\$\{|evm-pool\/keeper/.test(line));
  assert.deepEqual(direct, [], `a relay request that does not go through keeperFetch: ${direct.map(([i]) => i)}`);
  assert.match(page, /import \{ keeperFetch, available as routeAvailable, enabled as routeOn, turn as routeTurn \} from '\/private-route\.js\?cb=[A-Za-z0-9_-]+';/);
  assert.match(page, /const timedFetch = \(url, init = \{\}\) => keeperFetch\(url,/);
  assert.match(page, /Object\.defineProperty\(timedFetch, 'sealed', \{ get: routeOn \}\)/);
  const wallets = [...page.matchAll(/makeEvmPoolWallet\(/g)].map((m) => {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < page.length; i++) { if (page[i] === '(') depth++; else if (page[i] === ')' && --depth === 0) break; }
    return page.slice(m.index, i + 1);
  });
  assert.equal(wallets.length, 4, 'the page makes four wallets: two for a chain, two for a token');
  for (const w of wallets) {
    assert.match(w, /keeper:/, w.slice(0, 80));
    assert.match(w, /fetchImpl: timedFetch/, `a wallet made without it would ask the relay directly: ${w.slice(0, 80)}`);
  }
});

await check('the pay page shows the switch only when the route is available, says what it hides, and keeps it on only if the route answers', () => {
  assert.match(page, /\$\{routeAvailable\(\) \? html`<label class="kv chk"><span>Hide my address from the relay<\/span><input type="checkbox" id="w-route"/);
  assert.match(page, /The nodes you read the chain through still see it\./);
  assert.match(page, /routeTurn\(true\);\s*\n\s*\/\/ on only if the route answers/);
  assert.match(page, /catch \(err\) \{ routeTurn\(false\); toast\(`The private route did not answer, so it is off\./);
});

console.log(`\n${n} checks passed`);
