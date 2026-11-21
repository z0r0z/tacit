// Chain reads for wallets, carried on the private route (docs/EVM-POOL.md): POST /<id>/evm-pool/keeper/rpc takes a JSON-RPC call or a batch and answers
// it from the keeper's own nodes. A wallet that reads the chain through a public node shows that node its address next to its receive-box addresses; through
// this route the keeper's nodes see the keeper's own request, and the keeper (which already holds a box's receive key if the wallet registered it) sees a
// forwarder's address, not the wallet's.
//
// Only reads are carried: a fixed list of methods, a batch of at most MAX_BATCH, a log range of at most MAX_LOG_RANGE blocks, and no state overrides. A call
// outside that is refused with 403, which a wallet answers by asking its own node. Reads of the chain's head are kept for CACHE_MS and shared. Each sender
// (the address an envelope arrived from) has a budget of calls a minute.
import { safeErr } from './safe-err.js';

export const ALLOWED = new Set([
  'eth_blockNumber', 'eth_chainId', 'eth_getBalance', 'eth_getCode', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getTransactionCount', 'eth_getLogs',
  'eth_getStorageAt', 'net_version',
]);
export const MAX_BATCH = 32;
export const MAX_LOG_RANGE = 5000;
export const MAX_BODY = 32 * 1024;
const CACHE_MS = 2000;
const HEAD_METHODS = new Set(['eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory']);
const MAX_PARAMS = { eth_call: 2, eth_estimateGas: 2, eth_getLogs: 1, eth_getBalance: 2, eth_getCode: 2, eth_getTransactionCount: 2, eth_getStorageAt: 3, eth_getBlockByNumber: 2, eth_getBlockByHash: 2, eth_feeHistory: 3, eth_getTransactionByHash: 1, eth_getTransactionReceipt: 1 };
const HEX = /^0x[0-9a-fA-F]+$/;

const refuse = (status, error) => ({ status, body: { error } });

// request(method, params) → the node's result, or throws; `now` for tests.
export function makeRpcPassthrough({ request, chainId, callsPerMin = 6000, burst = 600, maxLogRange = MAX_LOG_RANGE, now = () => Date.now() }) {
  const cache = new Map();           // method|params → { at, value } for the chain's head, and the chain id for good
  const budget = new Map();          // sender → { tokens, at }
  const take = (key, n) => {
    const t = now();
    let b = budget.get(key);
    if (!b) { b = { tokens: burst, at: t }; budget.set(key, b); }
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 60_000) * callsPerMin);
    b.at = t;
    if (b.tokens < n) return false;
    b.tokens -= n;
    if (budget.size > 5000) for (const [k, v] of budget) if (t - v.at > 600_000) budget.delete(k);
    return true;
  };

  const cached = async (method, params) => {
    const fresh = method === 'eth_chainId' || HEAD_METHODS.has(method) || (method === 'eth_getBlockByNumber' && params[0] === 'latest');
    if (!fresh) return request(method, params);
    const k = `${method}|${JSON.stringify(params)}`, hit = cache.get(k), t = now();
    if (hit && (method === 'eth_chainId' || t - hit.at < CACHE_MS)) return hit.value;
    const value = await request(method, params);
    if (cache.size > 500) cache.clear();
    cache.set(k, { at: t, value });
    return value;
  };

  // null when the call is carried, else the reason it is not.
  async function check(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.method !== 'string') return 'not a JSON-RPC call';
    if (!ALLOWED.has(c.method)) return `${c.method} is not carried`;
    const params = c.params ?? [];
    if (!Array.isArray(params) || params.length > (MAX_PARAMS[c.method] ?? 0)) return 'too many parameters (state overrides are not carried)';
    if (c.method === 'eth_chainId' && chainId == null) return null;
    if (c.method === 'eth_getLogs') {
      const f = params[0];
      if (!f || typeof f !== 'object' || Array.isArray(f)) return 'eth_getLogs takes one filter';
      if (f.blockHash) return null;
      if (!HEX.test(String(f.fromBlock ?? ''))) return 'eth_getLogs needs a numeric fromBlock';
      const from = BigInt(f.fromBlock);
      let to;
      if (HEX.test(String(f.toBlock ?? ''))) to = BigInt(f.toBlock);
      else if (f.toBlock == null || f.toBlock === 'latest') to = BigInt(await cached('eth_blockNumber', []));
      else return 'eth_getLogs needs a numeric toBlock or latest';
      if (to < from || to - from > BigInt(maxLogRange)) return `eth_getLogs covers at most ${maxLogRange} blocks`;
    }
    return null;
  }

  const fail = (id, e) => {
    const code = Number.isInteger(e?.code) ? e.code : -32603;
    const err = { code, message: safeErr(e, 200) };
    if (typeof e?.data === 'string' && /^0x[0-9a-fA-F]*$/.test(e.data) && e.data.length <= 4096) err.data = e.data;
    return { jsonrpc: '2.0', id, error: err };
  };

  // body: one call or an array of them → { status, body }: 200 with the node's answers (a node's own error is an answer), 400 not JSON-RPC, 403 not carried, 429 over the sender's budget.
  async function handle(body, sender = 'unknown') {
    const list = Array.isArray(body) ? body : [body];
    if (!list.length || list.length > MAX_BATCH) return refuse(400, `a batch is 1 to ${MAX_BATCH} calls`);
    for (const c of list) { const why = await check(c).catch((e) => `unreadable: ${safeErr(e, 80)}`); if (why) return refuse(why.startsWith('not a JSON') ? 400 : 403, why); }
    if (!take(sender, list.length)) return refuse(429, 'rate limited');
    const out = await Promise.all(list.map(async (c) => {
      try {
        if (c.method === 'eth_chainId' && chainId != null) return { jsonrpc: '2.0', id: c.id ?? null, result: '0x' + BigInt(chainId).toString(16) };
        return { jsonrpc: '2.0', id: c.id ?? null, result: await cached(c.method, c.params ?? []) };
      } catch (e) { return fail(c.id ?? null, e); }
    }));
    return { status: 200, body: Array.isArray(body) ? out : out[0] };
  }

  return { handle };
}
