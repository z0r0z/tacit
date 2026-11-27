// The front page's private ETH and token pool wallets (dapp/index.html deviceWallet, tokenWallet) take the relays listed in the relay registry, as the Pay
// page's do: read once a visit from a public node, the page's own entry left out, listed on the private route, and handed to the wallet beside the page's own
// relay. A spend asks every one and goes through one of the cheapest; a registry relay is reached only through the private route, sealed to its own key, and
// the page's own relay as it always was. What is not a spend (the fee shown, a receive box) stays with the page's own relay.
//
// The page's functions are cut out of dapp/index.html and run against stand-ins for the registry's node, the private route and the relays. The wallet they
// build is the real one (dapp/evm-pool-wallet.js), so a spend's quote is asked the way a withdrawal asks it.
//
// Run: node tests/front-registry-relays.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';
import * as openRelaysMod from '../dapp/evm-pool-open-relays.js';
import { makeEvmPoolWallet, evmPoolKeys } from '../dapp/evm-pool-wallet.js';
import { makeEvmPoolZk } from '../dapp/evm-pool-zk.js';
import { encodeList } from './helpers/relay-registry-list.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(ROOT, 'dapp/index.html'), 'utf8');

let pass = 0, fail = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};

const between = (from, to) => {
  const a = page.indexOf(from), b = page.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`cannot find ${JSON.stringify(from)} .. ${JSON.stringify(to)} in dapp/index.html`);
  return page.slice(a, b);
};
// the page's dynamic imports are taken by the harness's __import, which hands each its stand-in
const src = (between('const OPEN_RELAYS = new Map();', 'const payFrom = ') + between('const tokCfg', 'const tkPin'))
  .replace(/import\('([^'?]+)(?:\?cb=[0-9a-f]+)?'\)/g, "__import('$1')");
if (/\bimport\(/.test(src)) throw new Error('an import in the cut-out code is not handed to the harness');

const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });
const ZERO = '0x0000000000000000000000000000000000000000';
const EVM_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', EVM_ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const TAC_POOL = '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe', TAC_ROUTER = '0x000000fA029Eaf69840C1490Bf9AA6C094794D5a';
const KEEPERS = 'https://tacit-evm-pool-keepers.onrender.com';
const OWN = `${KEEPERS}/1/evm-pool/keeper`, OWN_BASE = `${KEEPERS}/8453/evm-pool/keeper`, OWN_TAC = `${KEEPERS}/1-tac/evm-pool/keeper`;
const B = 'https://relay-b.example', C = 'https://relay-c.example';
const OWN_R = '0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0', B_R = '0x' + 'b2'.repeat(20), C_R = '0x' + 'c3'.repeat(20);
const STAKE = 1000n * 10n ** 18n;
const DEVICE_CHAINS = [
  { chainId: 1, name: 'Ethereum', rpc: ['https://node-a.example', 'https://node-b.example'], keeper: OWN, deployBlock: 1, confirmations: 0 },
  { chainId: 8453, name: 'Base', rpc: ['https://base-a.example'], keeper: OWN_BASE, deployBlock: 1, confirmations: 0 },
];
const TAC = { slug: 'tac', sym: 'TAC', chainId: 1, token: '0x' + 'aa'.repeat(20), keeper: OWN_TAC, relayer: OWN_R, maxRelayFee: 1000n * 10n ** 18n,
  pool: TAC_POOL, router: TAC_ROUTER, deployBlock: 1, rpc: DEVICE_CHAINS[0].rpc, confirmations: 0 };

// What the registry lists for each chain (the page's own relay among them, as it is on Ethereum), and what each relay quotes at each route it serves.
const LISTED = {
  1: [{ relayer: OWN_R, stake: STAKE, url: OWN }, { relayer: B_R, stake: STAKE, url: `${B}/1/evm-pool/keeper` }, { relayer: C_R, stake: STAKE, url: `${C}/1/evm-pool/keeper` }],
  8453: [{ relayer: B_R, stake: STAKE, url: `${B}/8453/evm-pool/keeper` }],
};
const serves = (o = {}) => ({
  [OWN]: { relayer: OWN_R, pool: EVM_POOL, chainId: 1, fee: 140n },
  [`${B}/1/evm-pool/keeper`]: { relayer: B_R, pool: EVM_POOL, chainId: 1, fee: 113n },
  [`${C}/1/evm-pool/keeper`]: { relayer: C_R, pool: EVM_POOL, chainId: 1, fee: 140n },
  [OWN_BASE]: { relayer: OWN_R, pool: EVM_POOL, chainId: 8453, fee: 30n },
  [`${B}/8453/evm-pool/keeper`]: { relayer: B_R, pool: EVM_POOL, chainId: 8453, fee: 20n },
  [OWN_TAC]: { relayer: OWN_R, pool: TAC_POOL, chainId: 1, fee: 9n },
  [`${C}/1-tac/evm-pool/keeper`]: { relayer: C_R, pool: TAC_POOL, chainId: 1, fee: 8n },
  ...o,
});

// The page, cut out: `registry` is how the registry's node answers (a list, 'never', or 'fails'); `route` whether the private route is on.
function harness({ registry = 'lists', route = true, gate = null, relays = serves() } = {}) {
  const log = { direct: [], sealed: [], listed: [], reads: 0, built: [] };
  const answer = (url, init) => {
    const base = Object.keys(relays).find((b) => url.startsWith(`${b}/`)), r = relays[base];
    if (!r) return new Response('{"error":"no such chain"}', { status: 404 });
    if (/\/quote(\?|$)/.test(url)) return new Response(JSON.stringify({ chainId: r.chainId, pool: r.pool, relayer: r.relayer, asset: ZERO, fee: String(r.fee), gas: '450000' }));
    return new Response(JSON.stringify({ ok: true, method: init?.method || 'GET' }));
  };
  const listedOn = new Set();
  const routeMod = {
    enabled: () => route,
    listRelays: (chainId, list) => { log.listed.push([chainId, list.map((e) => e.url).sort()]); for (const e of list) listedOn.add(e.url); },
    // the route reaches only a relay it was given; anything else is refused, never sent
    keeperFetch: async (url, init) => {
      if (![...listedOn].some((u) => url.startsWith(`${u}/`))) throw new Error('The private route does not reach this relay.');
      log.sealed.push(url);
      return answer(url, init);
    },
  };
  const jsonRpcMod = {
    jsonRpc: (urls) => async (method, [tx]) => {
      assert.equal(method, 'eth_call');
      assert.equal(tx.to, openRelaysMod.RELAY_REGISTRY);
      assert.deepEqual(urls, [...DEVICE_CHAINS[0].rpc].reverse(), 'the registry is read through a node other than the wallet\'s first');
      const chainId = Number(BigInt('0x' + tx.data.slice(10, 74))), start = Number(BigInt('0x' + tx.data.slice(74, 138)));
      if (start === 0) log.reads++;
      if (gate) await gate;
      if (registry === 'never') return new Promise(() => {});
      if (registry === 'fails') throw new Error('node down');
      const all = LISTED[chainId] || [];
      return encodeList(all.slice(start), all.length);
    },
  };
  const mods = { '/private-route.js': routeMod, '/evm-pool-open-relays.js': openRelaysMod, '/json-rpc.js': jsonRpcMod };
  const DEV = { chain: DEVICE_CHAINS[0], W: null, key: null }, S = { key: { pubHex: '0xab' } }, TK = { W: null, key: null };
  const getDeviceMods = async () => ({
    zk, evmPoolKeys, jsonRpc: () => async () => { throw new Error('no chain reads in this test'); },
    makeEvmPoolWallet: (o) => { log.built.push(o); return makeEvmPoolWallet(o); },
  });
  const NAMES = ['__import', 'lazy', 'DEVICE_CHAINS', 'POOL_KEEPERS', 'DEV', 'S', 'TK', 'getDeviceMods', 'walletPriv', 'lsKv', 'EVM_POOL', 'EVM_ROUTER', 'prover', 'provingNote', 'location', 'fetch', 'setTimeout'];
  const lazy = (f) => { let p = null; return () => (p ||= f().catch((e) => { p = null; throw e; })); };
  const fns = new Function(...NAMES, `${src}\nreturn { openRelaysFor, tokenRelays, relayFetch, deviceWallet, tokenWallet };`)(
    async (path) => mods[path], lazy, DEVICE_CHAINS, KEEPERS, DEV, S, TK, getDeviceMods, () => new Uint8Array(32).fill(5), { get: () => null, set: () => {} },
    EVM_POOL, EVM_ROUTER, async () => null, () => {}, { hostname: 'tacit.finance' },
    async (url, init) => { log.direct.push(url); return answer(url, init); },
    // the page's four-second wait on the registry: run at once for a registry that never answers, and never otherwise (each test's registry answers first)
    (fn) => { if (registry === 'never') fn(); return 0; },
  );
  return { ...fns, log, DEV, TK };
}
const withRandom = async (v, fn) => { const r = Math.random; Math.random = () => v; try { return await fn(); } finally { Math.random = r; } };
const settle = () => new Promise((r) => setTimeout(r, 20));
// every request this page sends in the open goes to the relay it ships with
const onlyOwnInOpen = (log) => assert.ok(log.direct.every((u) => u.startsWith(`${KEEPERS}/`)), `sent in the open: ${log.direct.filter((u) => !u.startsWith(`${KEEPERS}/`))}`);

console.log('private ETH on the front page');
await check('the wallet is given the registry\'s relays beside the page\'s own (its own entry left out), and they are listed on the private route', async () => {
  const h = harness(), W = await h.deviceWallet(), o = h.log.built[0];
  assert.ok(W);
  assert.equal(o.keeper, OWN);
  assert.equal(o.fetchImpl, h.relayFetch);
  assert.deepEqual(o.chain.keepers.map((e) => `${e.url} ${e.relayer}`).sort(), [`${B}/1/evm-pool/keeper ${B_R}`, `${C}/1/evm-pool/keeper ${C_R}`]);
  assert.deepEqual(h.log.listed, [[1, [`${B}/1/evm-pool/keeper`, `${C}/1/evm-pool/keeper`]]]);
});

await check('a spend asks every relay, the page\'s own in the open as before and a registry relay only through the private route, and takes the cheapest', async () => {
  const h = harness(), W = await h.deviceWallet();
  h.log.direct.length = 0;
  const q = await withRandom(0, () => W.spendQuote());
  assert.equal(q.relayer.toLowerCase(), B_R);
  assert.equal(q.fee, '113');
  assert.deepEqual(h.log.direct, [`${OWN}/quote`]);
  assert.deepEqual(h.log.sealed.sort(), [`${B}/1/evm-pool/keeper/quote`, `${C}/1/evm-pool/keeper/quote`]);
  onlyOwnInOpen(h.log);
});

await check('the fee the page shows and the receive box stay with the page\'s own relay', async () => {
  const h = harness(), W = await h.deviceWallet();
  await settle();
  assert.deepEqual(h.log.direct, [`${OWN}/receive`]);
  assert.equal((await W.quote()).relayer, OWN_R);
  assert.deepEqual(h.log.direct, [`${OWN}/receive`, `${OWN}/quote`]);
  assert.deepEqual(h.log.sealed, []);
});

await check('the wallet\'s fetch sends nothing for another relay in the open: one the route was not given is refused', async () => {
  const h = harness();
  await h.deviceWallet();
  await assert.rejects(h.relayFetch('https://unlisted.example/1/evm-pool/keeper/quote'), /does not reach this relay/);
  assert.equal((await (await h.relayFetch(`${B}/1/evm-pool/keeper/quote`)).json()).relayer, B_R);
  assert.deepEqual(h.log.sealed, [`${B}/1/evm-pool/keeper/quote`]);
  onlyOwnInOpen(h.log);
});

await check('a registry that does not answer in time, or fails, leaves the wallet with the page\'s own relay', async () => {
  for (const registry of ['never', 'fails']) {
    const h = harness({ registry }), W = await h.deviceWallet();
    assert.deepEqual(h.log.built[0].chain.keepers, [], registry);
    h.log.direct.length = 0;
    assert.equal((await W.spendQuote()).relayer, OWN_R, registry);
    assert.deepEqual(h.log.direct, [`${OWN}/quote`], registry);
    assert.deepEqual(h.log.sealed, [], registry);
  }
});

await check('without the private route the registry is not read and no relay is listed', async () => {
  const h = harness({ route: false });
  await h.deviceWallet();
  assert.deepEqual(h.log.built[0].chain.keepers, []);
  assert.equal(h.log.reads, 0);
  assert.deepEqual(h.log.listed, []);
});

await check('the registry is read once a visit for a chain, however many wallets are made', async () => {
  const h = harness();
  await h.deviceWallet();
  h.DEV.W = null;
  await h.deviceWallet();
  assert.equal(h.log.built.length, 2);
  assert.equal(h.log.reads, 1);
  assert.equal(h.log.built[1].chain.keepers.length, 2);
});

await check('two calls while the registry is read make one wallet', async () => {
  let open;
  const h = harness({ gate: new Promise((r) => { open = r; }) });
  const both = Promise.all([h.deviceWallet(), h.deviceWallet()]);
  await settle();
  open();
  const [a, b] = await both;
  assert.equal(a, b);
  assert.equal(h.log.built.length, 1);
});

await check('a chain changed while the registry is read gets the wallet for the chain now in use, with that chain\'s relays', async () => {
  let open;
  const h = harness({ gate: new Promise((r) => { open = r; }) });
  const made = h.deviceWallet();
  await settle();
  h.DEV.chain = DEVICE_CHAINS[1];
  open();
  await made;
  const o = h.log.built.at(-1);
  assert.equal(h.log.built.length, 1);
  assert.equal(o.chain.chainId, 8453);
  assert.equal(o.keeper, OWN_BASE);
  assert.deepEqual(o.chain.keepers.map((e) => e.url), [`${B}/8453/evm-pool/keeper`]);
  assert.equal(h.DEV.key, '0xab8453');
});

console.log('token pools on the front page');
await check('a token pool takes the registry\'s relays pointed at its own route, pinned as listed, and lists those on the route', async () => {
  const h = harness(), W = await h.tokenWallet(TAC), o = h.log.built[0];
  assert.ok(W);
  assert.equal(o.keeper, OWN_TAC);
  assert.equal(o.fetchImpl, h.relayFetch);
  assert.deepEqual(o.chain.keepers.map((e) => `${e.url} ${e.relayer}`).sort(), [`${B}/1-tac/evm-pool/keeper ${B_R}`, `${C}/1-tac/evm-pool/keeper ${C_R}`]);
  assert.ok(h.log.listed.some(([id, urls]) => id === 1 && urls.join() === [`${B}/1-tac/evm-pool/keeper`, `${C}/1-tac/evm-pool/keeper`].join()));
});

await check('a token pool\'s spend leaves out a relay that does not serve the pool, and goes through one that does', async () => {
  const h = harness(), W = await h.tokenWallet(TAC);
  const q = await withRandom(0, () => W.spendQuote());
  assert.equal(q.relayer.toLowerCase(), C_R);
  assert.ok(h.log.sealed.includes(`${B}/1-tac/evm-pool/keeper/quote`), 'the relay that does not serve it was asked, through the route');
  assert.deepEqual(h.log.direct, [`${OWN_TAC}/quote`]);
  onlyOwnInOpen(h.log);
});

await check('a token pool with no relay of its own takes none from the registry', async () => {
  const h = harness();
  await h.tokenWallet({ ...TAC, slug: 'mine', keeper: null });
  assert.deepEqual(h.log.built[0].chain.keepers, []);
  assert.equal(h.log.reads, 0);
});

await check('the sync worker is still given the page\'s own relay alone (its fetches do not go through the route)', () => {
  const sent = [...page.matchAll(/chain: \{ chainId: c\.chainId, keeper: c\.keeper,[^}]*\}/g)].map((m) => m[0]);
  assert.equal(sent.length, 2, 'the two worker messages (one pool, several pools) are where they were');
  for (const s of sent) assert.ok(!/keepers/.test(s), s);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
