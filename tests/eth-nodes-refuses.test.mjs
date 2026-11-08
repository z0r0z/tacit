// A read a public node is known to refuse is not asked of it while another node can answer (dapp/eth-nodes.js refuses/logSpan), so the browser's console does not list a
// refused request on every visit: trade/rpc.js hedgedRpc and evm-pool-wallet.js jsonRpc leave such a node out, and ask it only when it is all there is; the confidential
// pool's log reader starts each node at the widest range it serves. The log decoder's hex helpers read as they always did, only faster.
//   node tests/eth-nodes-refuses.test.mjs

import assert from 'node:assert/strict';
import { refuses, logSpan, isShared, ETH_NODES, ETH_LOG_NODES, ETH_ARCHIVE_NODES, BASE_NODES, ROBINHOOD_NODES } from '../dapp/eth-nodes.js';
import { hedgedRpc } from '../dapp/trade/rpc.js';
import { jsonRpc } from '../dapp/evm-pool-wallet.js';
import { makeConfidentialEvmLog } from '../dapp/confidential-evm-log.js';
import { keccak_256 } from '@noble/hashes/sha3';

let failed = 0;
const test = async (name, fn) => { try { await fn(); console.log('  ok - ' + name); } catch (e) { failed++; console.log('  FAIL - ' + name + '\n' + e.stack); } };

const PUBLIC = 'https://ethereum-rpc.publicnode.com', MEV = 'https://rpc.mevblocker.io', NODEREAL = 'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7';
const DRPC = 'https://eth.drpc.org', THIRDWEB = 'https://1.rpc.thirdweb.com', STAKELY = 'https://ethereum-json-rpc.stakely.io', ONERPC = 'https://1rpc.io/eth';
const hex = (n) => '0x' + n.toString(16);
const logs = (from, to) => [{ address: '0x00', fromBlock: hex(from), toBlock: typeof to === 'number' ? hex(to) : to }];
const HEAD = 26_000_000;

await test('drpc is known to refuse every eth_getLogs and nothing else; a node with no entry refuses nothing', () => {
  assert.equal(refuses(DRPC, 'eth_getLogs', logs(HEAD - 10, HEAD)), true);
  assert.equal(refuses(DRPC, 'eth_getLogs', logs(HEAD - 10, 'latest')), true);
  assert.equal(refuses(DRPC, 'eth_call', [{ to: '0x00' }, hex(HEAD - 5000)]), false);
  assert.equal(refuses(DRPC, 'eth_blockNumber', []), false);
  for (const m of ['eth_getLogs', 'eth_call', 'eth_getBalance']) assert.equal(refuses('https://example.org', m, logs(1, HEAD)), false);
  assert.equal(refuses('https://eth-mainnet.public.blastapi.io', 'eth_getLogs', logs(1, HEAD)), false);
});

await test('publicnode serves logs for a span up to 9,999 blocks and only for recent blocks', () => {
  assert.equal(refuses(PUBLIC, 'eth_getLogs', logs(HEAD - 9998, HEAD)), false, '9,999 blocks');
  assert.equal(refuses(PUBLIC, 'eth_getLogs', logs(HEAD - 9999, HEAD)), true, '10,000 blocks');
  assert.equal(refuses(PUBLIC, 'eth_getLogs', logs(HEAD - 319_130, HEAD)), true, 'a wide range');
  assert.equal(refuses(PUBLIC, 'eth_getLogs', logs(HEAD - 2000, 'latest')), false, 'an open end cannot be judged');
  assert.equal(refuses(PUBLIC, 'eth_getLogs', logs(HEAD - 200_000, HEAD - 195_000)), false, 'without the head, a chunk read alone looks recent');
  assert.equal(refuses(PUBLIC, 'eth_getLogs', logs(HEAD - 200_000, HEAD - 195_000), HEAD), true, 'with the head of the scan it is old');
  assert.equal(refuses(PUBLIC, 'eth_getLogs', logs(HEAD - 5000, HEAD - 1000), HEAD), false, 'a recent chunk is served');
});

await test('publicnode serves state only at the newest block: a numbered block goes elsewhere', () => {
  for (const [m, p] of [['eth_call', [{ to: '0x00', data: '0x' }, hex(HEAD - 13_000)]], ['eth_getBalance', ['0x00', hex(HEAD - 5)]], ['eth_getStorageAt', ['0x00', '0x0', hex(HEAD - 5)]], ['eth_getCode', ['0x00', hex(HEAD)]]]) {
    assert.equal(refuses(PUBLIC, m, p), true, m);
  }
  for (const [m, p] of [['eth_call', [{ to: '0x00', data: '0x' }, 'latest']], ['eth_getBalance', ['0x00', 'latest']], ['eth_getStorageAt', ['0x00', '0x0', 'latest']], ['eth_blockNumber', []], ['eth_gasPrice', []]]) {
    assert.equal(refuses(PUBLIC, m, p), false, m + ' at the newest block');
  }
  assert.equal(refuses(MEV, 'eth_call', [{ to: '0x00' }, hex(HEAD - 13_000)]), false, 'an archive node serves it');
});

await test('the span each node starts a log scan at, from what was measured', () => {
  assert.equal(logSpan(PUBLIC), 9999);
  assert.equal(logSpan(MEV), 45000);
  assert.equal(logSpan(NODEREAL), 49999);
  assert.equal(logSpan(THIRDWEB), 2000);
  assert.equal(logSpan(STAKELY), 25);
  assert.equal(logSpan(ONERPC), 50);
  assert.equal(logSpan('https://example.org'), Infinity, 'unknown: no limit assumed');
  assert.equal(logSpan(DRPC), Infinity, 'drpc is asked last for logs, not cut to a span');
  for (const u of [...ETH_NODES, ...ETH_LOG_NODES]) assert.ok(logSpan(u) > 0);
  assert.equal(refuses(THIRDWEB, 'eth_getLogs', logs(HEAD - 5000, HEAD)), true, 'wider than a node serves');
  assert.equal(refuses(ONERPC, 'eth_getLogs', logs(HEAD - 49, HEAD)), false);
  assert.equal(refuses(ONERPC, 'eth_getLogs', logs(HEAD - 50, HEAD)), true);
});

await test('the log list leaves out the nodes that only refuse logs (drpc) or limit them at once (thirdweb), and keeps them for plain reads', () => {
  assert.ok(!ETH_LOG_NODES.includes(DRPC) && !ETH_LOG_NODES.includes(THIRDWEB));
  assert.ok(ETH_NODES.includes(DRPC) && ETH_NODES.includes(THIRDWEB));
  for (const u of [MEV, NODEREAL, PUBLIC]) assert.ok(ETH_LOG_NODES.includes(u));
});

const B_PUBLIC = 'https://base-rpc.publicnode.com', B_BLAST = 'https://base-mainnet.public.blastapi.io', B_DRPC = 'https://base.drpc.org', B_OWN = 'https://mainnet.base.org';
const R_OWN = 'https://rpc.mainnet.chain.robinhood.com', R_PUBLIC = 'https://robinhood-rpc.publicnode.com', R_DRPC = 'https://robinhood.drpc.org';

await test('Base and Robinhood are listed once, here: Base\'s own endpoint last, Robinhood with two more', () => {
  assert.deepEqual(BASE_NODES, [B_PUBLIC, B_BLAST, B_DRPC, B_OWN]);
  assert.deepEqual(ROBINHOOD_NODES, [R_OWN, R_PUBLIC, R_DRPC]);
});

await test('on Base only publicnode serves logs; the others serve calls and state, and the ones that refuse logs are asked last for them', async () => {
  for (const u of [B_BLAST, B_DRPC, R_DRPC, R_PUBLIC]) assert.equal(refuses(u, 'eth_getLogs', logs(HEAD - 100, HEAD)), true, u);
  for (const u of [B_PUBLIC, B_OWN, R_OWN]) assert.equal(refuses(u, 'eth_getLogs', logs(HEAD - 100, HEAD)), false, u);
  for (const u of BASE_NODES) assert.equal(refuses(u, 'eth_call', [{ to: '0x00' }, hex(HEAD - 90_000)]), false, 'Base nodes keep their state: ' + u);
  for (const u of [R_DRPC, R_PUBLIC]) assert.equal(refuses(u, 'eth_call', [{ to: '0x00' }, hex(HEAD - 90_000)]), true, 'Robinhood\'s other nodes do not keep old state: ' + u);
  assert.equal(refuses(R_OWN, 'eth_call', [{ to: '0x00' }, hex(HEAD - 90_000)]), false);
  let n = nodes((url) => ({ result: url }));
  assert.equal(await hedgedRpc([B_DRPC, B_BLAST, B_PUBLIC, B_OWN], 'eth_getLogs', logs(HEAD - 4000, HEAD), { fetchImpl: n.fetchImpl, hedgeMs: 0 }), B_PUBLIC);
  assert.deepEqual(n.asked, [B_PUBLIC], 'logs go to the one node that serves them, whatever order the list is in');
  n = nodes((url) => ({ result: url }));
  const rpc = jsonRpc(BASE_NODES, n.fetchImpl);
  assert.equal(await rpc('eth_getLogs', logs(HEAD - 4000, HEAD)), B_PUBLIC);
  assert.deepEqual(n.asked, [B_PUBLIC]);
});

await test('with the first node of a chain down, the next one answers a plain read, on Base and on Robinhood', async () => {
  for (const list of [BASE_NODES, ROBINHOOD_NODES]) {
    const n = nodes((url) => (url === list[0] ? { error: 'down' } : { result: url }));
    const r = await hedgedRpc(list, 'eth_getBalance', ['0x00', 'latest'], { fetchImpl: n.fetchImpl, hedgeMs: 0 });
    assert.equal(r, list[1]);
    const m = nodes((url) => (url === list[0] ? { error: 'down' } : { result: url }));
    assert.equal(await jsonRpc(list, m.fetchImpl)('eth_getBalance', ['0x00', 'latest']), list[1]);
  }
});

const MEV_FAST = 'https://rpc.mevblocker.io/fast', XRPC = 'https://xrpc.cl/eth', FLASHBOTS = 'https://rpc.flashbots.net';

await test('nodes checked against the others: mevblocker\'s fast route serves logs; Flashbots is never asked for them; xrpc.cl is in no list', () => {
  assert.ok(ETH_LOG_NODES.includes(MEV_FAST), 'same service, same answers, another route');
  assert.ok(!ETH_LOG_NODES.includes(FLASHBOTS) && !ETH_NODES.includes(FLASHBOTS) && !ETH_ARCHIVE_NODES.includes(FLASHBOTS), 'Flashbots returned 21 of 86 logs: it only sends');
  for (const list of [ETH_NODES, ETH_LOG_NODES, ETH_ARCHIVE_NODES]) assert.ok(!list.includes(XRPC), 'xrpc.cl answers some reads with a 503 and an old balance with 0x0');
  assert.equal(logSpan(MEV_FAST), 45000, 'the fast route is the same service');
  assert.equal(refuses(FLASHBOTS, 'eth_getLogs', logs(HEAD - 10, HEAD)), true);
  assert.equal(refuses(FLASHBOTS, 'eth_call', [{ to: '0x00' }, 'latest']), false, 'its other reads are left alone');
});

await test('the key every visitor shares is asked last: only nodereal is shared, and it ends the lists of plain reads and of old state', () => {
  const shared = [...new Set([...ETH_NODES, ...ETH_LOG_NODES, ...ETH_ARCHIVE_NODES, ...BASE_NODES, ...ROBINHOOD_NODES])].filter(isShared);
  assert.deepEqual(shared, [NODEREAL]);
  assert.equal(ETH_NODES.at(-1), NODEREAL);
  assert.equal(ETH_ARCHIVE_NODES.at(-1), NODEREAL);
  assert.ok(ETH_LOG_NODES.indexOf(NODEREAL) > ETH_LOG_NODES.indexOf(PUBLIC), 'among the log nodes it follows the nodes with a quota of their own');
});

await test('the cBTC history reads (45,000-block ranges) are not turned away from the node that has served them', () => {
  assert.equal(refuses(MEV, 'eth_getLogs', logs(HEAD - 44_999, HEAD)), false);
  assert.equal(refuses(MEV, 'eth_getLogs', logs(HEAD - 45_000, HEAD)), true);
  assert.equal(refuses(NODEREAL, 'eth_getLogs', logs(HEAD - 44_999, HEAD)), false);
});

// A fetch that answers each node's URL from `serve` and notes the order it was asked in.
function nodes(serve) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push(url);
    const body = JSON.parse(init.body), r = serve(url, body);
    return { status: r.error ? 200 : 200, json: async () => ({ jsonrpc: '2.0', id: body.id, ...(r.error ? { error: { message: r.error } } : { result: r.result }) }) };
  };
  return { asked, fetchImpl };
}

await test('hedgedRpc does not ask a node that is known to refuse a read while another can answer, and asks it when it is all there is', async () => {
  const list = [PUBLIC, MEV, DRPC, NODEREAL];
  let n = nodes((url) => ({ result: url }));
  assert.equal(await hedgedRpc(list, 'eth_call', [{ to: '0x00' }, hex(HEAD - 13_000)], { fetchImpl: n.fetchImpl, hedgeMs: 0 }), MEV);
  assert.deepEqual(n.asked, [MEV], 'a read at an old block goes to an archive node, not publicnode first');
  n = nodes((url) => ({ result: url }));
  assert.equal(await hedgedRpc(list, 'eth_getLogs', logs(HEAD - 3000, HEAD), { fetchImpl: n.fetchImpl, hedgeMs: 0 }), PUBLIC);
  assert.deepEqual(n.asked, [PUBLIC], 'a short recent range is where it always was');
  n = nodes((url) => ({ result: url }));
  await hedgedRpc(list, 'eth_call', [{ to: '0x00' }, 'latest'], { fetchImpl: n.fetchImpl, hedgeMs: 0 });
  assert.deepEqual(n.asked, [PUBLIC], 'a read at the newest block starts where it always did');
  // every node that serves it fails: the one known to refuse is not asked (its answer is known), and the call fails with what the others said
  n = nodes((url) => (url === PUBLIC ? { result: 'old state' } : { error: 'nope' }));
  await assert.rejects(() => hedgedRpc(list, 'eth_call', [{ to: '0x00' }, hex(HEAD - 13_000)], { fetchImpl: n.fetchImpl, hedgeMs: 0 }), /nope/);
  assert.deepEqual(n.asked, [MEV, DRPC, NODEREAL], 'publicnode was never asked for state it does not keep');
  // a list of nothing but nodes known to refuse it is asked all the same
  n = nodes((url) => ({ result: 'served anyway' }));
  assert.equal(await hedgedRpc([PUBLIC], 'eth_call', [{ to: '0x00' }, hex(HEAD - 13_000)], { fetchImpl: n.fetchImpl, hedgeMs: 0 }), 'served anyway');
  assert.deepEqual(n.asked, [PUBLIC]);
});

await test('hedgedRpc keeps a node that is not a URL where the caller put it (the wallet stays the last resort)', async () => {
  const wallet = { id: 'wallet', usable: () => true, send: async () => 'from the wallet' };
  const n = nodes((url) => ({ error: 'nope' }));
  const r = await hedgedRpc([PUBLIC, MEV, wallet], 'eth_call', [{ to: '0x00' }, hex(HEAD - 13_000)], { fetchImpl: n.fetchImpl, hedgeMs: 0 });
  assert.equal(r, 'from the wallet');
  assert.deepEqual(n.asked, [MEV], 'the public node that serves it first, the one that refuses it not at all, then the wallet');
});

await test('jsonRpc does not ask a node known to refuse the read while another can answer, and asks it when it is all there is', async () => {
  let n = nodes((url) => ({ result: url }));
  let rpc = jsonRpc([PUBLIC, MEV, NODEREAL], n.fetchImpl);
  assert.equal(await rpc('eth_call', [{ to: '0x00' }, hex(HEAD - 13_000)]), MEV);
  assert.deepEqual(n.asked, [MEV]);
  n = nodes((url) => (url === PUBLIC ? { result: 'old state' } : { error: 'no archive' }));
  rpc = jsonRpc([PUBLIC, MEV, NODEREAL], n.fetchImpl);
  await assert.rejects(() => rpc('eth_call', [{ to: '0x00' }, hex(HEAD - 13_000)]), /no archive/);
  assert.deepEqual(n.asked, [MEV, NODEREAL], 'publicnode was not asked');
  n = nodes((url) => ({ result: 'served anyway' }));
  assert.equal(await jsonRpc([PUBLIC], n.fetchImpl)('eth_call', [{ to: '0x00' }, hex(HEAD - 13_000)]), 'served anyway');
  assert.deepEqual(n.asked, [PUBLIC], 'all there is');
  n = nodes((url) => ({ result: url }));
  rpc = jsonRpc([PUBLIC, MEV], n.fetchImpl);
  assert.equal(await rpc('eth_getBalance', ['0x00', 'latest']), PUBLIC, 'the newest block: unchanged');
  rpc = jsonRpc([PUBLIC, MEV, DRPC], n.fetchImpl);
  n.asked.length = 0;
  await rpc('eth_getLogs', logs(HEAD - 4000, HEAD));
  assert.deepEqual(n.asked, [PUBLIC], 'logs of a recent short range');
});

await test('the log decoder reads a log back as it was written, in lower or upper case, with or without 0x: random leaves and memos of many lengths', () => {
  const dec = makeConfidentialEvmLog({ keccak256: (b) => keccak_256(b) });
  const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
  let x = 12345; const rnd = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0);
  const bytes = (n) => Array.from({ length: n }, () => (rnd() >>> 8) & 255).map((b) => b.toString(16).padStart(2, '0')).join('');
  // LeavesInserted(indexed uint256 first, bytes32[] leaves, bytes[] memos): data = [offLeaves][offMemos][leaves][memos]
  for (const lens of [[0], [1], [169], [169, 169, 0, 300], [4000, 1, 33, 32, 31], [169, 169, 169, 169, 169, 169, 169, 169]]) {
    const leaves = lens.map(() => '0x' + bytes(32)), memos = lens.map((n) => bytes(n));
    const leavesPart = word(leaves.length) + leaves.map((l) => l.slice(2)).join('');
    const heads = []; let tail = '', off = 32 * lens.length;
    for (const m of memos) { heads.push(word(off)); const body = word(m.length / 2) + m.padEnd(Math.ceil(m.length / 64) * 64, '0'); tail += body; off += body.length / 2; }
    const memosPart = word(memos.length) + heads.join('') + tail;
    const data = word(64) + word(64 + leavesPart.length / 2) + leavesPart + memosPart;
    for (const form of [(d) => '0x' + d, (d) => '0x' + d.toUpperCase(), (d) => d]) {
      const ev = dec.decodeLog({ topics: [dec.TOPIC0.LeavesInserted, '0x' + word(7)], data: form(data), address: '0x0000000000000000000000000000000000000001' });
      assert.ok(ev, 'it decodes');
      assert.equal(ev.firstLeafIndex, 7);
      assert.deepEqual(ev.leaves, leaves);
      assert.deepEqual(ev.memos, memos.map((m) => '0x' + m));
    }
  }
  // a nullifier list too, and a log of no data
  const nfs = Array.from({ length: 5 }, () => bytes(32));
  const ev = dec.decodeLog({ topics: [dec.TOPIC0.NullifiersSpent], data: '0x' + word(32) + word(5) + nfs.join('') });
  assert.deepEqual(ev.nullifiers, nfs.map((n) => '0x' + n));
  assert.doesNotThrow(() => dec.decodeLog({ topics: [dec.TOPIC0.NullifiersSpent], data: '0x' }));
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
