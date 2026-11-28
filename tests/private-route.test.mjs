// A page's side of the private route (dapp/private-route.js): a request to the relay's service always goes through a forwarder as a sealed
// envelope and is never sent directly, whatever fails; and every keeper request of the pay page goes through it.
//   node tests/private-route.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gatewayKeys, newGatewayKey, openRequest } from '../dapp/sealed-request.js';
import { frontPage } from './lib/front-page.mjs';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const te = new TextEncoder();

// The module as a page loads it, with its one absolute import pointed at the file.
const sealedUrl = pathToFileURL(new URL('../dapp/sealed-request.js', import.meta.url).pathname).href;
const source = readFileSync(new URL('../dapp/private-route.js', import.meta.url), 'utf8');
assert.match(source, /import\('\/sealed-request\.js\?cb=[A-Za-z0-9_-]+'\)/, 'it loads the sealed fetch on demand, by the page\'s own URL');
const dir = mkdtempSync(join(tmpdir(), 'private-route-'));
const relaysUrl = pathToFileURL(new URL('../dapp/evm-pool-relays.js', import.meta.url).pathname).href;
writeFileSync(join(dir, 'private-route.mjs'), source.replace(/\/sealed-request\.js\?cb=[A-Za-z0-9_-]+/, sealedUrl).replace("'./evm-pool-relays.js'", `'${relaysUrl}'`));
const route = await import(pathToFileURL(join(dir, 'private-route.mjs')).href);
const { ROUTE, available, enabled, keeperFetch } = route;
assert.equal(route.turn, undefined, 'there is no setting that turns the route off');

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
  if (/^https:\/\/f[12]\.test\/health$/.test(u)) { if (!forwarderUp) throw new Error('connection refused'); return new Response('{"ok":true}', { status: 200 }); }
  if (u.startsWith('https://f1.test/f/k') || u.startsWith('https://f2.test/f/k')) {
    if (!forwarderUp) throw new Error('connection refused');
    const opened = await openRequest(keys, init.body, { seen: (id) => (seen.has(id) ? false : (seen.add(id), true)) });
    const answers = opened.requests.map((r) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: te.encode(JSON.stringify({ via: 'route', path: r.path })), gzip: false }));
    return new Response(opened.batch ? await opened.replyMany(answers) : await opened.reply(200, answers[0].headers, answers[0].body), { status: 200 });
  }
  return new Response(JSON.stringify({ via: 'direct', url: u }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const get = async (url, init) => (await keeperFetch(url, init)).json();

await check('the page ships with its gateway key and forwarders, and the route is always on', async () => {
  assert.match(ROUTE.gateway, /^0[23][0-9a-f]{64}$/, 'a 33-byte gateway key is pinned');
  assert.ok(ROUTE.forwarders.length >= 1 && ROUTE.forwarders.every((u) => /^https:\/\//.test(u)), 'https forwarders');
  assert.equal(available(), true);
  assert.equal(enabled(), true);
});
const SHIPPED = { keeper: ROUTE.keeper, gateway: ROUTE.gateway, forwarders: [...ROUTE.forwarders], nostr: [...(ROUTE.nostr || [])], rpc: { ...(ROUTE.rpc || {}) }, api: { ...(ROUTE.api || {}) } };
Object.assign(ROUTE, { gateway: '', forwarders: [] });   // a page with no route configured is a plain fetch

await check('a page that names no gateway or forwarder fetches as it always did', async () => {
  assert.equal(available(), false);
  assert.equal(enabled(), false);
  calls.length = 0;
  assert.deepEqual(await get(`${KEEPER}/1/evm-pool/keeper/head`), { via: 'direct', url: `${KEEPER}/1/evm-pool/keeper/head` });
  assert.equal(keeperFetch.sealed, false);
});
Object.assign(ROUTE, { gateway: PUB, forwarders: ['https://f1.test', 'https://f2.test'] });

await check('a request to the relay\'s service is a sealed envelope to a forwarder and never a direct request', async () => {
  assert.equal(enabled(), true);
  assert.equal(keeperFetch.sealed, true, 'a wallet on the route sends without a reservation');
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

await check('when no forwarder answers a request fails, and is never sent to the relay instead', async () => {
  forwarderUp = false;
  calls.length = 0;
  await assert.rejects(keeperFetch(`${KEEPER}/1/evm-pool/keeper/head`), /refused/);
  await assert.rejects(keeperFetch(`${KEEPER}/1/evm-pool/keeper/relay`, { method: 'POST', body: '{}' }), /refused/);
  assert.ok(calls.every((u) => /\/f\/k$/.test(u)), calls.join(' '));
  assert.ok(!calls.some((u) => u.startsWith(KEEPER)), 'not one request went to the relay');
  forwarderUp = true;
  assert.equal((await get(`${KEEPER}/1/evm-pool/keeper/head`)).via, 'route', 'and it works again when a forwarder does');
});

await check('one forwarder down is not an outage: the next one carries the request', async () => {
  const real = globalThis.fetch; calls.length = 0;
  globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://f1.test')) { calls.push(String(url)); throw new Error('f1 refused'); } return real(url, init); };
  assert.equal((await get(`${KEEPER}/1/evm-pool/keeper/head`)).via, 'route');
  assert.ok(!calls.some((u) => u.startsWith(KEEPER)), 'not sent to the relay');
  globalThis.fetch = real;
});

await check('another relay is refused, and what is not a relay is fetched as it was', async () => {
  calls.length = 0;
  await assert.rejects(keeperFetch('https://another.example/1/evm-pool/keeper/head'), /does not reach this relay/);
  await assert.rejects(keeperFetch('https://another.example/evm-pool/keeper'), /does not reach this relay/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await get('https://api.tacit.finance/stats?network=mainnet'), { via: 'direct', url: 'https://api.tacit.finance/stats?network=mainnet' });
  assert.deepEqual(calls, ['https://api.tacit.finance/stats?network=mainnet']);
});

// The pay page: every request it makes to a relay goes through keeperFetch.
const page = readFileSync(new URL('../dapp/pay/eth/index.html', import.meta.url), 'utf8');
await check('the pay page sends every request to a relay through keeperFetch, and its wallets ask it whether they are on the route', () => {
  const direct = page.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => /(^|[^\w.])fetch\(/.test(line) && /chainKeeper\(|\.keeper\b|POOL_KEEPERS|onrender\.com\/\$\{|evm-pool\/keeper/.test(line));
  assert.deepEqual(direct, [], `a relay request that does not go through keeperFetch: ${direct.map(([i]) => i)}`);
  assert.match(page, /import \{ keeperFetch(?:, rpcFetch)?(?:, walletRpcFetch)?(?:, bundlerFetch)?(?:, poolHistory)?, available as routeAvailable, enabled as routeOn(?:, listRelays)?(?:, setRouteEndpoints)? \} from '\/private-route\.js\?cb=[A-Za-z0-9_-]+';/);
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

await check('the pay page offers no way to turn the route off, and says what it hides', () => {
  assert.doesNotMatch(page, /id="w-route"/, 'no switch');
  assert.doesNotMatch(page, /routeTurn/, 'nothing turns it off');
  assert.match(page, /Your address is hidden from the relay: every request to it goes through a forwarder\. The nodes you read the chain through still see it\./);
});

await check('what the page pins is what the keeper serves', () => {
  assert.match(SHIPPED.gateway, /^03dcc0e9c8f2f3f2/, 'the key id 5c246719 pinned on the keepers service');
});

await check('every host the route can use is in the CSP of every page that can carry it', () => {
  const pages = ['index.html', 'spx/index.html', 'tac/index.html', 'sats/index.html', 'pay/eth/index.html'];
  for (const pg of pages) {
    const html = frontPage(new URL(`../dapp/${pg}`, import.meta.url));
    const connect = (/http-equiv="Content-Security-Policy"[^>]*?connect-src([^;]*)/s.exec(html)?.[1] || '').split(/\s+/);
    assert.ok(connect.length > 5, `${pg} has a connect-src in its CSP meta tag`);
    for (const host of [SHIPPED.keeper, ...SHIPPED.forwarders, ...SHIPPED.nostr]) assert.ok(connect.includes(host), `${pg} does not allow ${host}`);
  }
  for (const pg of ['teth/index.html', 'splitter/index.html']) {   // pages that carry only the relay API's reads
    const html = readFileSync(new URL(`../dapp/${pg}`, import.meta.url), 'utf8');
    const connect = (/http-equiv="Content-Security-Policy"[^>]*?connect-src([^;]*)/s.exec(html)?.[1] || '').split(/\s+/);
    for (const host of [...SHIPPED.forwarders, ...SHIPPED.nostr, 'https://api.tacit.finance']) assert.ok(connect.includes(host), `${pg} does not allow ${host}`);
  }
  assert.ok(SHIPPED.nostr.length >= 3 && SHIPPED.nostr.every((u) => /^wss:\/\//.test(u)), 'at least three wss relays');
});

await check('the prove page reads each forwarder\'s health, so its CSP names them, and it has the card', () => {
  const html = readFileSync(new URL('../dapp/prove/index.html', import.meta.url), 'utf8');
  const connect = (/http-equiv="Content-Security-Policy"[^>]*?connect-src([^;]*)/s.exec(html)?.[1] || '').split(/\s+/);
  for (const host of SHIPPED.forwarders) assert.ok(connect.includes(host), `prove/index.html does not allow ${host}`);
  assert.match(html, /id="fwd-box"/);
  assert.match(html, /community-runner\.mjs forward/);
});

await check('the pay page reads the wallet\'s side through the wallet-read gateway and the relay registry straight from a node', () => {
  const page2 = readFileSync(new URL('../dapp/pay/eth/index.html', import.meta.url), 'utf8');
  assert.match(page2, /const rpcApart = async \(c\) => \{[^}]*jsonRpc\(\[\.\.\.c\.rpc\]\.reverse\(\), walletRpcFetch\(c\.chainId\)\)/, 'rpcApart goes to the wallet-read gateway');
  assert.match(page2, /const rpcRegistry = async \(c\) => \{[^}]*jsonRpc\(\[\.\.\.c\.rpc\]\.reverse\(\)\)/, 'the registry reader has no route');
  assert.match(page2, /openRelays\(\{[\s\S]{0,80}rpc = await rpcRegistry\(CHAINS\[0\]\)|rpc = await rpcRegistry\(CHAINS\[0\]\)/, 'the registry is read by rpcRegistry');
  assert.ok(!/rpc = await rpcApart\(CHAINS\[0\]\);\s*\n\s*const real/.test(page2), 'and not by the wallet reader');
  assert.match(SHIPPED.rpc.gateway, /^0[23][0-9a-f]{64}$/); assert.notEqual(SHIPPED.rpc.gateway, SHIPPED.gateway, 'its own key, not the relay\'s');
  assert.match(SHIPPED.api.gateway, /^0[23][0-9a-f]{64}$/); assert.ok(![SHIPPED.gateway, SHIPPED.rpc.gateway].includes(SHIPPED.api.gateway), 'the relay API\'s gateway has its own key');
  assert.equal(SHIPPED.api.url, 'https://api.tacit.finance');
});

await check('every module that talks to the relay takes the route\'s fetch, and every page that calls the relay sets it and names the forwarders', () => {
  const read = (f) => frontPage(new URL(`../dapp/${f}`, import.meta.url));
  for (const [f, min] of [['confidential-pool-ux.js', 1], ['confidential-relay.js', 1], ['confidential-bridge-mint.js', 3], ['community-ops.js', 1], ['activity.js', 2], ['prove/app.js', 1], ['index.html', 3]]) {
    const hits = (read(f).match(/__tacitRelayFetch/g) || []).length;
    assert.ok(hits >= min, `${f} takes the route's fetch (${hits} of at least ${min})`);
  }
  for (const f of ['index.html', 'tacit.js']) assert.match(read(f), /__tacitRelayFetch \|\|= m\.apiFetch\(\)/, `${f} sets the hook`);
  for (const f of ['prove/app.js', 'relay/app.js']) assert.match(read(f), /import '\/relay-route\.js\?cb=[0-9a-f]+';/, `${f} loads the hook module`);
  assert.match(read('relay-route.js'), /globalThis\.__tacitRelayFetch \|\|= apiFetch\(\)/);
  for (const pg of ['prove/index.html', 'relay/index.html']) {
    const csp = (/http-equiv="Content-Security-Policy"[^>]*?connect-src([^;]*)/s.exec(read(pg))?.[1] || '').split(/\s+/);
    for (const host of [...SHIPPED.forwarders, ...SHIPPED.nostr]) assert.ok(csp.includes(host), `${pg} allows ${host}`);
  }
});

await check('the pay page hands the fixed-pool flow the route\'s bundler fetch, and the flow takes it', () => {
  assert.match(readFileSync(new URL('../dapp/pay/eth/index.html', import.meta.url), 'utf8'), /__tacitBundlerFetch \|\|= bundlerFetch\(\)/);
  assert.match(readFileSync(new URL('../dapp/fixed-pool-flow.js', import.meta.url), 'utf8'), /__tacitBundlerFetch \|\| globalThis\.fetch/);
});

await check('the pay page gives each fixed-pool flow the route\'s pool history, and the flow hands it to the sync', () => {
  const page = readFileSync(new URL('../dapp/pay/eth/index.html', import.meta.url), 'utf8');
  assert.equal((page.match(/history: poolHistory,/g) || []).length, 3, 'attach, attachWithdraw and attachIntake');
  assert.match(readFileSync(new URL('../dapp/fixed-pool-pay.js', import.meta.url), 'utf8'), /history: env\.history\?\.\(chainId\)/);
});

await check('the pay page\'s policy does not allow the published history host, so the page cannot contact it', () => {
  const page = readFileSync(new URL('../dapp/pay/eth/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(/http-equiv="Content-Security-Policy"[^>]*>/s.exec(page)?.[0] || '', /saga\.0000000000\.org/);
});

console.log(`\n${n} checks passed`);
