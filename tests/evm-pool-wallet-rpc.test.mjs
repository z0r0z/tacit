// jsonRpc over several nodes, and the wallet's log scan against nodes with different eth_getLogs range limits.
import assert from 'node:assert/strict';
import { jsonRpc, makeEvmPoolWallet, evmPoolKeys, recipientOf, logFailure, sealNote, openNote, paymentKey, sealState, openState, mergePlan } from '../dapp/evm-pool-wallet.js';
import { poolAsset } from '../dapp/evm-pool-zk.js';
import { makeEvmPoolZk } from '../dapp/evm-pool-zk.js';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });

// Fake nodes: `limit` is the widest eth_getLogs range served; `err(range)` shapes the refusal like the real node.
const TIP = 10_000;
function nodes(spec, calls) {
  return async (url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    const node = spec[url];
    calls.push([url, method]);
    const reply = (x) => ({ json: async () => ({ jsonrpc: '2.0', id, ...x }) });
    if (node.down) throw new Error('fetch failed');
    if (method === 'eth_blockNumber') return reply({ result: '0x' + TIP.toString(16) });
    if (method === 'eth_call') return reply({ error: { code: 3, message: 'execution reverted', data: '0x12345678' } });
    if (method === 'eth_getLogs') {
      const range = Number(BigInt(params[0].toBlock) - BigInt(params[0].fromBlock)) + 1;
      if (range > node.limit) return reply({ error: node.err(node.limit) });
      return reply({ result: [] });
    }
    return reply({ result: '0x0' });
  };
}
const SPEC = {
  tenderly: { limit: 1000, err: (l) => ({ code: -32602, message: 'invalid params', data: `Block range too large for public access: maximum ${l} blocks` }) },
  drpc: { limit: 10_000, err: () => ({ code: 35, message: 'ranges over 10000 blocks are not supported on free plan' }) },
  base: { limit: 2000, err: (l) => ({ code: -32614, message: `eth_getLogs is limited to a ${l.toLocaleString('en-US')} range` }) },
};

await check('a node that never answers is given up on after the timeout, and the next one serves', async () => {
  const calls = [];
  const hang = (url, init) => new Promise((res, rej) => { calls.push(url); init.signal?.addEventListener('abort', () => rej(init.signal.reason)); });
  const rpc = jsonRpc(['silent', 'drpc'], (url, init) => (url === 'silent' ? hang(url, init) : nodes(SPEC, calls)(url, init)), { timeoutMs: 50 });
  const t0 = Date.now(), alive = setInterval(() => {}, 1000);   // Node's AbortSignal.timeout timer does not hold the process open
  try { assert.equal(await rpc('eth_blockNumber'), '0x' + TIP.toString(16)); } finally { clearInterval(alive); }
  assert.ok(Date.now() - t0 < 2000, 'failed over within the timeout');
  assert.deepEqual(calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['silent', 'drpc']);
});

await check('any failing node is skipped: a down node, then a range refusal, then one that serves', async () => {
  const calls = [];
  const rpc = jsonRpc(['down', 'tenderly', 'drpc'], nodes({ down: { down: true }, ...SPEC }, calls));
  assert.deepEqual(await rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x1387' }]), []); // 5000 blocks
  assert.deepEqual(calls.map((c) => c[0]), ['down', 'tenderly', 'drpc']);
});

await check('a revert is final at the first node', async () => {
  const calls = [];
  const rpc = jsonRpc(['drpc', 'base'], nodes(SPEC, calls));
  await assert.rejects(rpc('eth_call', [{}, 'latest']), (e) => e.rpc.data === '0x12345678');
  assert.equal(calls.length, 1);
});

await check('when every node refuses, the error carries them all', async () => {
  const rpc = jsonRpc(['tenderly', 'base'], nodes(SPEC, []));
  await assert.rejects(rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x1387' }]), (e) => e.all.length === 2);
});

await check('the scan takes the widest limit a node names (in message or data) and rotates to that node', async () => {
  for (const [urls, want] of [[['tenderly', 'base'], 2000], [['tenderly'], 1000], [['base', 'tenderly'], 2000]]) {
    const calls = [];
    const w = makeEvmPoolWallet({
      zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(7)), prove: null,
      chain: { chainId: 8453, pool: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc: jsonRpc(urls, nodes(SPEC, calls)), deployBlock: 0, confirmations: 0, logChunk: 5000 },
    });
    await w.sync();
    const served = calls.filter(([u, m]) => m === 'eth_getLogs' && SPEC[u].limit >= want).length;
    // Two log streams (pool and router), each ceil(10001 / want) chunks served by that node, plus its refusals.
    assert.ok(served >= 2 * Math.ceil((TIP + 1) / want) && served < 2 * Math.ceil((TIP + 1) / want) + 12, `${urls}: ${served} calls for a ${want}-block step`);
  }
});

await check('a log query failure is read node by node: a named limit narrows, a result cap shrinks, a rate limit waits', async () => {
  const fail = (...msgs) => Object.assign(new Error(msgs[0]), { all: msgs.map((m) => ({ message: m })) });
  const drpcFree = 'ranges over 10000 blocks are not supported on free plan', baseRange = 'eth_getLogs is limited to a 2,000 range';
  assert.deepEqual(logFailure(fail(baseRange, drpcFree), 2_000_000), { step: 10000 });
  assert.deepEqual(logFailure(fail(baseRange, drpcFree), 10000), { step: 2000 });
  assert.deepEqual(logFailure(fail('Block range too large for public access: maximum 1000 blocks'), 2000), { step: 1000 });
  // One node rate-limited beside one that refuses every historical range: wait, never narrow below the working limit.
  assert.deepEqual(logFailure(fail('over rate limit', drpcFree), 2000), { busy: true });
  assert.deepEqual(logFailure(fail('You reached Public endpoint rate limit, please upgrade to paid plan'), 2000), { busy: true });
  assert.deepEqual(logFailure(fail('query returned more than 10000 results'), 2000), { step: 500 });
  assert.equal(logFailure(fail('execution reverted'), 2000), null);
  // A node that refuses every historical range beside one that failed for some other reason: narrow, as before.
  assert.deepEqual(logFailure(fail('upstream request timed out', drpcFree), 5000), { step: 1250 });
  assert.deepEqual(logFailure(fail('Bad Gateway', drpcFree), 5000), { step: 1250 });
});

await check('a scan through a rate-limited node beside one that refuses every range keeps its window', async () => {
  const calls = [];
  let n = 0;
  const spec = { base: { limit: 2000, err: (l) => ({ code: -32614, message: `eth_getLogs is limited to a ${l.toLocaleString('en-US')} range` }) }, drpc: { limit: 0, err: () => ({ code: 35, message: 'ranges over 10000 blocks are not supported on free plan' }) } };
  const inner = nodes(spec, calls);
  const fetchImpl = async (url, init) => {
    const { method, id } = JSON.parse(init.body);
    if (url === 'base' && method === 'eth_getLogs' && ++n % 3 === 0) return { json: async () => ({ jsonrpc: '2.0', id, error: { code: -32016, message: 'over rate limit' } }) };
    return inner(url, init);
  };
  const alive = setInterval(() => {}, 1000);
  try {
    const w = makeEvmPoolWallet({
      zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(8)), prove: null,
      chain: { chainId: 8453, pool: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc: jsonRpc(['base', 'drpc'], fetchImpl), deployBlock: 0, confirmations: 0, logChunk: 2000 },
    });
    await w.sync();
  } finally { clearInterval(alive); }
  const windows = calls.filter(([u, m]) => u === 'base' && m === 'eth_getLogs').length;
  assert.ok(windows < 3 * 2 * Math.ceil((TIP + 1) / 2000) + 6, `${windows} base windows for two 10,001-block streams at 2,000 blocks`);
});

await check('state saved with every leaf and nullifier loads as a tree of unspent notes only', async () => {
  const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(9));
  const asset = poolAsset({ chainId: 8453n, pool: POOL, token: '0x0000000000000000000000000000000000000000' });
  const self = { V: keys.V, A: keys.A, N: keys.N };
  const hex = (b) => '0x' + Buffer.from(b).toString('hex');
  const mine = [5n, 7n].map((v) => { const o = sealNote(zk, { to: self, value: v, asset }); return { ...o, leaf: zk.leafOf(asset, o.v, o.npk, o.rho) }; });
  const leaves = [11n, mine[0].leaf, 13n, 17n, mine[1].leaf, 19n];
  const idx = [1, 4];
  const notes = mine.map((m, k) => { const o = openNote(zk, keys, { memo: m.memo, leaf: m.leaf, asset }); return { index: idx[k], leaf: m.leaf.toString(), v: o.v.toString(), rho: o.rho.toString(), s: hex(o.s), kind: 'memo' }; });
  const k1 = zk.ownedKeys(keys.zkWallet, Buffer.from(notes[1].s.slice(2), 'hex'));
  const spentNf = zk.nullifier(k1.nk, mine[1].leaf, 4).toString();
  const saved = new Map();
  const skey = `tacit-evm-pool-v1:8453:${POOL.toLowerCase()}:${keys.address}`;
  saved.set(skey, JSON.stringify({ block: 100, leaves: leaves.map(String), notes, spent: ['123', spentNf], nextRefund: 1 }));
  const store = { get: (k) => saved.get(k), set: (k, v) => saved.set(k, v) };
  const rpc = async (m) => (m === 'eth_blockNumber' ? '0x64' : []);
  const w = makeEvmPoolWallet({ zk, keys, prove: null, store, chain: { chainId: 8453, pool: POOL, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc, deployBlock: 0, confirmations: 0 } });
  const sum = await w.sync();
  assert.equal(sum.balance, 5n, 'the spent note is dropped');
  assert.equal(sum.leaves, 6);
  const w2 = makeEvmPoolWallet({ zk, keys, prove: null, store: { get: () => JSON.stringify({ block: 100, leaves: leaves.map(String), notes, spent: [spentNf] }), set: (k, v) => saved.set('new', v) }, chain: { chainId: 8453, pool: POOL, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc: async (m) => (m === 'eth_blockNumber' ? '0x6e' : []), deployBlock: 0, confirmations: 0 } });
  await w2.sync();
  const now = JSON.parse(openState(keys.v, saved.get('new')));
  assert.ok(now.tree && !now.leaves && !now.spent, 'saved again as a tree, with no leaves or nullifier list');
  assert.deepEqual(Object.keys(now.tree.tracked), ['1'], 'only the unspent note keeps a path');
  assert.equal(now.tree.root, zk.tree(leaves).root.toString());
});

await check('a relayer quote for another chain or pool, an unexpected address, or an excessive fee is refused', async () => {
  const POOLA = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', RELAYER = '0xfA2afbaB631C7Eda7CeA6AE1440605C504E322Ec';
  const good = { chainId: 8453, pool: POOLA, relayer: RELAYER, fee: '5000000000000' };
  const walletFor = (q) => makeEvmPoolWallet({
    zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(5)), prove: null, store: null, keeper: 'https://k.test',
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => q }),
    chain: { chainId: 8453, pool: POOLA, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc: async () => '0x0', deployBlock: 0, confirmations: 0, relayer: RELAYER },
  });
  assert.equal((await walletFor(good).quote()).fee, good.fee);
  for (const [why, q] of [
    ['chain', { ...good, chainId: 1 }], ['pool', { ...good, pool: '0x1111111111111111111111111111111111111111' }],
    ['relayer', { ...good, relayer: '0x2222222222222222222222222222222222222222' }],
    ['fee', { ...good, fee: (10n ** 18n).toString() }], ['fee format', { ...good, fee: '-1' }],
  ]) await assert.rejects(() => walletFor(q).quote(), /nothing was signed/, why);
});

await check('saved state is ciphertext at rest, opens only under its own key, and fails its tag if altered; plain JSON still loads', async () => {
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(9));
  const text = JSON.stringify({ block: 5, notes: [{ v: '123456789' }] });
  const sealedText = sealState(keys.v, text);
  assert.ok(sealedText.startsWith('enc1:') && !sealedText.includes('123456789'));
  assert.equal(openState(keys.v, sealedText), text);
  assert.equal(openState(keys.v + 1n, sealedText), null);
  assert.equal(openState(keys.v, sealedText.slice(0, -2) + (sealedText.endsWith('00') ? '11' : '00')), null);
  assert.notEqual(sealState(keys.v, text), sealedText, 'a fresh nonce each time');
  assert.equal(openState(keys.v, text), text);
});

await check('a spend built again from the same note takes another one-time key, and attempt 0 is the plain derivation', async () => {
  const k = evmPoolKeys(zk, new Uint8Array(32).fill(5)), nf = 12345n;
  const e0 = paymentKey(k, { chainId: 1, nf, k: 0 });
  assert.equal(e0, paymentKey(k, { chainId: 1, nf, k: 0, attempt: 0 }));
  const seen = new Set([e0]);
  for (let a = 1; a < 16; a++) seen.add(paymentKey(k, { chainId: 1, nf, k: 0, attempt: a }));
  assert.equal(seen.size, 16);
});

await check('the router log read names no receive box, so a node does not see which boxes are one wallet\'s', async () => {
  const POOLA = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTERA = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
  const seen = [];
  const rpc = async (m, params) => { if (m === 'eth_getLogs') seen.push(params[0]); return m === 'eth_blockNumber' ? '0x64' : []; };
  const w = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(5)), prove: null, store: null, chain: { chainId: 8453, pool: POOLA, router: ROUTERA, rpc, deployBlock: 0, confirmations: 0 } });
  await w.sync();
  const router = seen.filter((f) => f.address === ROUTERA);
  assert.ok(router.length > 0);
  for (const f of router) assert.equal(f.topics.length, 1, 'only the event signature');
});

await check('a call starts at the node that answered last, so one that stopped answering costs one timeout, not one per call', async () => {
  const calls = [];
  const hang = (url, init) => new Promise((res, rej) => { calls.push(url); init.signal?.addEventListener('abort', () => rej(init.signal.reason)); });
  const rpc = jsonRpc(['silent', 'drpc'], (url, init) => (url === 'silent' ? hang(url, init) : (calls.push(url), nodes(SPEC, [])(url, init))), { timeoutMs: 50 });
  const alive = setInterval(() => {}, 1000);
  try { await rpc('eth_blockNumber'); await rpc('eth_blockNumber'); await rpc('eth_blockNumber'); } finally { clearInterval(alive); }
  assert.deepEqual(calls, ['silent', 'drpc', 'drpc', 'drpc']);
});

await check('a recipient address is decoded once and read back the same', async () => {
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(7));
  let decodes = 0;
  const pool = { decodeAddress: (a) => { decodes++; return keys.pool.decodeAddress(a); } };
  const first = recipientOf({ pool }, keys.address), again = recipientOf({ pool }, `  ${keys.address}\n`);
  assert.equal(decodes, 1);
  assert.deepEqual(again, first);
  assert.notEqual(again, first, 'each caller gets its own record');
});

await check('a relayed spend whose quote is above the fee shown is refused before anything is built', async () => {
  const POOLA = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', RELAYER = '0xfA2afbaB631C7Eda7CeA6AE1440605C504E322Ec';
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(5));
  const rpc = async (m) => (m === 'eth_blockNumber' ? '0x64' : m === 'eth_getLogs' ? [] : '0x0');
  const w = makeEvmPoolWallet({
    zk, keys, prove: null, store: null, keeper: 'https://k.test',
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ chainId: 8453, pool: POOLA, relayer: RELAYER, fee: '5000000000000' }) }),
    chain: { chainId: 8453, pool: POOLA, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc, deployBlock: 0, confirmations: 0, relayer: RELAYER },
  });
  const to = evmPoolKeys(zk, new Uint8Array(32).fill(6)).address;
  await assert.rejects(() => w.send({ to, amount: 1n, via: 'relay', maxFee: 4_000_000_000_000n }), (e) => e.feeMoved === 5_000_000_000_000n && /fee went up/.test(e.message));
  await assert.rejects(() => w.withdraw({ to: '0x1111111111111111111111111111111111111111', amount: 1n, via: 'relay', maxFee: 1n }), (e) => e.feeMoved === 5_000_000_000_000n);
  await assert.rejects(() => w.send({ to, amount: 1n, via: 'relay', maxFee: 6_000_000_000_000n }), (e) => e.feeMoved === undefined);
});

await check('merging plans: none when two notes cover it, one fee per merge, nothing when merges cannot', async () => {
  assert.equal(mergePlan([5n, 3n], 8n, 1n), 0);
  assert.equal(mergePlan([9n], 9n, 1n), 0);
  assert.equal(mergePlan([4n, 3n, 3n], 9n, 1n), 1, 'merging 4+3 leaves 6, and 6+3 covers it');
  assert.equal(mergePlan([4n, 3n, 3n], 10n, 1n), null, 'the second merge leaves one note of 8');
  assert.equal(mergePlan([1n, 1n], 3n, 2n), null, 'a merge that costs its whole note');
  assert.equal(mergePlan([], 1n, 0n), null);
  assert.equal(mergePlan(Array(10).fill(5n), 40n, 0n), 6, 'ten notes of 5 reach 40 only after six merges, though no single merge shows it');
  assert.equal(mergePlan(Array(10).fill(5n), 51n, 0n), null, 'and cannot reach more than they hold');
  assert.equal(mergePlan([2n, 2n, 2n, 2n, 2n, 2n, 2n, 2n, 2n], 100n, 0n), null, 'no more than 8 merges');
});

await check('mergePlan agrees with the loop prepare() ran before it, merge for merge, over random notes, needs and fees', async () => {
  // That loop: take one note, or two, covering `need`; else merge the two largest (the new note is their sum less `fee`),
  // and stop when they cannot pay the fee, when fewer than two notes are left, or after eight rounds, the last of which
  // merges without looking again. → merges made, or null.
  const loop = (values, need, fee) => {
    let u = values.map(BigInt);
    for (let guard = 0; guard < 8; guard++) {
      const asc = [...u].sort((a, b) => (a < b ? -1 : 1));
      if (asc.some((v) => v >= need)) return guard;
      for (let i = asc.length - 1; i > 0; i--) for (let j = i - 1; j >= 0; j--) if (asc[i] + asc[j] >= need) return guard;
      const desc = [...u].sort((a, b) => (b < a ? -1 : 1));
      if (desc.length < 2 || desc[0] + desc[1] <= fee) return null;
      u = [desc[0] + desc[1] - fee, ...desc.slice(2)];
    }
    return null;
  };
  let seed = 12345;
  const rand = (m) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % m; };
  let reachable = 0, merged = 0;
  for (let i = 0; i < 20_000; i++) {
    const values = Array.from({ length: rand(11) }, () => BigInt(1 + rand(50)));
    const need = BigInt(1 + rand(300)), fee = BigInt(rand(6));
    const want = loop(values, need, fee);
    assert.equal(mergePlan(values, need, fee), want, `${values} need ${need} fee ${fee}`);
    if (want != null) reachable++;
    if (want > 0) merged++;
  }
  assert.ok(reachable > 2000 && merged > 500, `the cases cover both outcomes and real merges (${reachable} reachable, ${merged} merging)`);
});

await check('a spend that merging cannot cover is refused before a merge is paid for', async () => {
  const POOLA = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', RELAYER = '0xfA2afbaB631C7Eda7CeA6AE1440605C504E322Ec';
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(5));
  const E12 = 10n ** 12n, fee = E12;
  const notes = [4n, 3n, 3n].map((v, index) => ({ index, leaf: String(1000 + index), v: String(v * E12), rho: String(index + 1), s: '0x02' + String(index + 1).padStart(2, '0').repeat(32), block: 90, tx: '0x' + '00'.repeat(32), kind: 'memo' }));
  const kv = new Map([[`tacit-evm-pool-v1:8453:${POOLA.toLowerCase()}:${keys.address}`, JSON.stringify({ block: 100, leaves: notes.map((x) => x.leaf), notes, nextRefund: 1, attempts: {} })]]);
  const urls = [];
  const rpc = async (m) => (m === 'eth_blockNumber' ? '0x64' : m === 'eth_getLogs' ? [] : '0x0');
  const w = makeEvmPoolWallet({
    zk, keys, prove: null, keeper: 'https://k.test', store: { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) },
    fetchImpl: async (url) => { urls.push(url.replace('https://k.test', '')); return { ok: true, status: 200, headers: new Map(), json: async () => ({ chainId: 8453, pool: POOLA, relayer: RELAYER, fee: fee.toString() }) }; },
    chain: { chainId: 8453, pool: POOLA, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc, deployBlock: 0, confirmations: 0, relayer: RELAYER },
  });
  const to = evmPoolKeys(zk, new Uint8Array(32).fill(6)).address;
  assert.equal((await w.sync()).balance, 10n * E12, 'the seeded notes are the wallet\'s');
  // 9 + fee needs 10: two merges leave one note of 8 (4+3-1 = 6, then 6+3-1 = 8)
  await assert.rejects(() => w.send({ to, amount: 9n * E12, via: 'relay' }), /not enough in the pool for this amount and its fee/);
  assert.deepEqual([...new Set(urls.filter((u) => !u.startsWith('/quote') && !u.startsWith('/events')))], [], 'nothing past the quote was asked of the relayer');
});

await check('the quote can be priced for a spend that burns more gas, and toV1 holds a relayed fee to maxFee', async () => {
  const POOLA = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', RELAYER = '0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0';
  const urls = [];
  const rpc = async (m) => (m === 'eth_blockNumber' ? '0x64' : m === 'eth_getLogs' ? [] : '0x0');
  const w = makeEvmPoolWallet({
    zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(5)), prove: null, store: null, keeper: 'https://k.test',
    fetchImpl: async (url) => { urls.push(url.replace('https://k.test', '')); return { ok: true, status: 200, headers: new Map(), json: async () => ({ chainId: 1, pool: POOLA, relayer: RELAYER, fee: '5000000000000' }) }; },
    chain: { chainId: 1, pool: POOLA, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc, deployBlock: 0, confirmations: 0, relayer: RELAYER },
  });
  await w.quote();
  await w.quote(700_000);
  assert.deepEqual(urls.filter((u) => u.startsWith('/quote')), ['/quote', '/quote?gas=700000']);
  await assert.rejects(() => w.toV1({ amount: 10n ** 12n, commit: '0x' + '11'.repeat(32), via: 'relay', maxFee: 4_000_000_000_000n }), (e) => e.feeMoved === 5_000_000_000_000n && /fee went up/.test(e.message));
  assert.ok(urls.includes('/quote?gas=700000'), 'toV1 asked for the quote priced for its own gas');
});

await check('toV1 counts its hour-long deadline from the chain time it is given', async () => {
  const POOLA = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', RELAYER = '0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0';
  const calls = [];
  const rpc = async (m, p) => { if (m === 'eth_call') calls.push(p[0].data); return m === 'eth_blockNumber' ? '0x64' : m === 'eth_getLogs' ? [] : '0x0'; };
  const w = makeEvmPoolWallet({
    zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(5)), prove: null, store: null, keeper: 'https://k.test',
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ chainId: 1, pool: POOLA, relayer: RELAYER, fee: '5000000000000' }) }),
    chain: { chainId: 1, pool: POOLA, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc, deployBlock: 0, confirmations: 0, relayer: RELAYER },
  });
  const now = 1_900_000_000;
  await assert.rejects(() => w.toV1({ amount: 10n ** 12n, commit: '0x' + '11'.repeat(32), via: 'relay', now }), /not enough in the pool/);
  const box = calls.find((d) => d && d.length === 10 + 64 * 8);                   // wrapBoxOf(the wrap intent, eight words)
  assert.equal(BigInt('0x' + box.slice(10 + 64 * 6, 10 + 64 * 7)), BigInt(now + 3600), 'the intent\'s deadline is that time plus an hour');
});

console.log(`\n${n} checks passed`);
