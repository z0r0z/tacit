// Reading an EVM pool's Transact events and its own root from a node, for src/lib/evm-pool-snapshot.js: a node that refuses a
// block range is asked for less, and what has been read is kept in a cache file so a run resumes where it stopped.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, parseAbiItem, parseAbi } from 'viem';

export const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
export const CHAINS = {
  1: { name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', deployBlock: 26069245, span: 20000, maxSpan: 20000 },
  8453: { name: 'Base', rpc: 'https://mainnet.base.org', deployBlock: 51864014, span: 500, maxSpan: 500 },
  4663: { name: 'Robinhood Chain', rpc: 'https://rpc.mainnet.chain.robinhood.com', deployBlock: 73991661, span: 20000, maxSpan: 400000 },
};
const TRANSACT = parseAbiItem('event Transact(bytes32 indexed nf0, bytes32 indexed nf1, bytes32 outLeaf0, bytes32 outLeaf1, uint256 firstIndex, bytes32 newRoot, address recipient, int256 extAmount, address relayer, uint256 fee, bytes memo0, bytes memo1)');
const POOL_ABI = parseAbi(['function ASSET_FIELD() view returns (uint256)', 'function root() view returns (bytes32)', 'function nextIndex() view returns (uint256)', 'function everKnownRoot(bytes32) view returns (bool)', 'function rootSize(bytes32) view returns (uint256)']);
// Block explorers (Blockscout) that list a contract's logs by page, so history needs no archive node.
export const EXPLORERS = {
  1: { api: 'https://eth.blockscout.com/api/v2' },
  8453: { api: 'https://base.blockscout.com/api/v2' },
  4663: { api: 'https://robinhoodchain.blockscout.com/api/v2', ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const makeClient = (url, { retryCount = 2 } = {}) => createPublicClient({ transport: http(url, { retryCount }) });

export async function readTransactLogs(client, { from, head, span, maxSpan = span, cacheFile, log = () => {} }) {
  const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : { next: from, logs: [] };
  let next = cache.next, size = span;
  while (next <= head) {
    const to = Math.min(next + size - 1, head);
    try {
      const got = await client.getLogs({ address: POOL, event: TRANSACT, fromBlock: BigInt(next), toBlock: BigInt(to) });
      for (const l of got) {
        cache.logs.push({
          blockNumber: Number(l.blockNumber), logIndex: l.logIndex, tx: l.transactionHash, firstIndex: l.args.firstIndex.toString(),
          outLeaf0: l.args.outLeaf0, outLeaf1: l.args.outLeaf1, nf0: l.args.nf0, nf1: l.args.nf1, newRoot: l.args.newRoot,
          extAmount: l.args.extAmount.toString(), fee: l.args.fee.toString(),
        });
      }
      next = to + 1;
      cache.next = next;
      if (cache.logs.length % 50 < got.length || next > head) writeFileSync(cacheFile, JSON.stringify(cache));
      size = Math.min(maxSpan, size * 2);                                    // a range that worked: ask for more next time
      await sleep(120);
    } catch (err) {
      if (size > 50) { size = Math.max(50, Math.floor(size / 2)); continue; }
      log(`blocks ${next}-${to}: ${err.shortMessage || err.message}; waiting`);
      await sleep(4000);
    }
  }
  writeFileSync(cacheFile, JSON.stringify(cache));
  return cache.logs;
}

// The pool's own answer at `block`: its root and how many leaves it has inserted.
export async function poolState(client, block, pool = POOL) {
  const blockNumber = BigInt(block);
  const [root, nextIndex] = await Promise.all([
    client.readContract({ address: pool, abi: POOL_ABI, functionName: 'root', blockNumber }),
    client.readContract({ address: pool, abi: POOL_ABI, functionName: 'nextIndex', blockNumber }),
  ]);
  return { root: BigInt(root), nextIndex: Number(nextIndex) };
}

// The asset field element the pool commits notes under; it differs from chain to chain.
export async function poolAssetOf(client, pool = POOL) {
  return BigInt(await client.readContract({ address: pool, abi: POOL_ABI, functionName: 'ASSET_FIELD' }));
}

// How many leaves the pool had when `root` was its head, read from the pool's root history (a read of the latest state, so no
// archive node is needed); null for a root the pool never held.
export async function rootSizeOf(client, root, pool = POOL) {
  const known = await client.readContract({ address: pool, abi: POOL_ABI, functionName: 'everKnownRoot', args: ['0x' + BigInt(root).toString(16).padStart(64, '0')] });
  if (!known) return null;
  return Number(await client.readContract({ address: pool, abi: POOL_ABI, functionName: 'rootSize', args: ['0x' + BigInt(root).toString(16).padStart(64, '0')] }));
}

// The pool's Transact events from a Blockscout API, newest page first, down to `from`. An event the explorer returns undecoded
// is an error, never skipped: a missing event would be a hole in the tree.
export async function readTransactLogsExplorer({ api, ua = null, from, pace = 2500, log = () => {}, fetchImpl = fetch }) {
  const out = [];
  let params = '';
  for (;;) {
    let res, tries = 0;
    for (;;) {
      res = await fetchImpl(`${api}/addresses/${POOL}/logs${params}`, { headers: ua ? { 'user-agent': ua } : {}, signal: AbortSignal.timeout(30000) });
      if (res.ok) break;
      if (++tries > 8) throw new Error(`explorer ${res.status}`);
      log(`explorer ${res.status}; waiting`);
      await sleep(res.status === 429 ? 20000 : 5000);
    }
    const data = await res.json();
    const items = data.items || [];
    let reached = false;
    for (const it of items) {
      if (Number(it.block_number) < from) { reached = true; break; }
      if (!it.decoded) throw new Error(`undecoded log in block ${it.block_number}, tx ${it.transaction_hash}`);
      if (!it.decoded.method_call.startsWith('Transact(')) continue;
      const p = Object.fromEntries(it.decoded.parameters.map((x) => [x.name, x.value]));
      out.push({ blockNumber: Number(it.block_number), logIndex: Number(it.index), tx: it.transaction_hash, firstIndex: String(p.firstIndex), outLeaf0: p.outLeaf0, outLeaf1: p.outLeaf1, nf0: p.nf0, nf1: p.nf1, newRoot: p.newRoot, extAmount: String(p.extAmount), fee: String(p.fee) });
    }
    if (reached || !data.next_page_params) break;
    params = '?' + new URLSearchParams(Object.fromEntries(Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)]))).toString();
    await sleep(pace);
  }
  return out;
}
