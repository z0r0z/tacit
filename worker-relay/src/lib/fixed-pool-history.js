// A fixed pool's deposit history (the Tornado Cash ETH pools), kept here and served to pages through the private route (docs/RELAY-DATA.md, "Large pools").
//
// A withdrawal builds its pool's tree from every deposit the pool has had. A page used to read them from a published cache that none of us runs, which showed that host the reader's
// address and which pool was read at the time of the withdrawal. Here the gateway keeps each pool's commitments in leaf order, read from the chain's logs (the first time seeded from that
// published cache, once, from this server), and a page asks it for them in pages through the route, so what a page's reads show is a forwarder's address and "a page of leaves".
//
// Nothing here is trusted by the page: the tree built from the leaves has to land on a root the pool knows (dapp/fixed-pool-flow.js), and a history that does not is read again
// from the chain. The leaves are public chain data, so what this keeps is not a secret.
import { readChunkCache, readTail, CHUNK_CACHES } from '../../../dapp/fixed-pool-sync.js';
import { safeErr } from './safe-err.js';

// 16,384 leaves of 32 bytes: 512 KiB a page, about 700 KiB as base64, inside one sealed reply.
export const PAGE = 16384;

// The canonical pools: the same as dapp/fixed-pool-notes.js (tests/fixed-pool-history.test.mjs checks they agree).
export const POOLS = Object.freeze({
  1: Object.freeze([
    { denomination: '0.1', address: '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc', deployBlock: 9116966 },
    { denomination: '1', address: '0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936', deployBlock: 9117609 },
    { denomination: '10', address: '0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF', deployBlock: 9117720 },
    { denomination: '100', address: '0xA160cdAB225685dA1d56aa342Ad8841c3b53f291', deployBlock: 9161895 },
  ]),
});

const hexOf = (c) => Buffer.from(c.slice(2), 'hex');

// request(method, params) → a node's answer. `seedFetch` reads the published cache (once a pool, when nothing is held yet).
export function makePoolHistory({ chainId, request, seedFetch = globalThis.fetch?.bind(globalThis), seedBase = CHUNK_CACHES[chainId], now = () => Date.now(), log = () => {}, maxAgeMs = 20_000, confirmations = 5 }) {
  const list = POOLS[chainId];
  if (!list) throw new Error(`no pools on chain ${chainId}`);
  const pools = new Map(list.map((p) => [p.address.toLowerCase(), { ...p, bytes: new Uint8Array(0), count: 0, upTo: p.deployBlock, at: 0, task: null, seeded: false, error: null }]));

  const grow = (st, n) => {
    if (n * 32 <= st.bytes.length) return;
    const next = new Uint8Array(Math.max(n * 32, st.bytes.length * 2, 1 << 16));
    next.set(st.bytes);
    st.bytes = next;
  };
  // deposits in leaf order from the pool's own count: a leaf already held is skipped, a gap is an error (the history is then dropped and read again)
  const apply = (st, deposits) => {
    for (const d of [...deposits].sort((a, b) => a.index - b.index)) {
      if (d.index < st.count) continue;
      if (d.index !== st.count) throw new Error(`leaf ${st.count} is missing`);
      grow(st, d.index + 1);
      st.bytes.set(hexOf(d.commitment), d.index * 32);
      st.count++;
    }
  };
  const reset = (st) => { Object.assign(st, { bytes: new Uint8Array(0), count: 0, upTo: st.deployBlock, seeded: false }); };

  async function refresh(st) {
    try {
      let from = st.upTo;
      if (!st.seeded) {
        st.seeded = true;
        if (seedBase && seedFetch) {
          try {
            const seed = await readChunkCache({ base: seedBase, chainId, denomination: st.denomination, address: st.address, fetchImpl: seedFetch });
            apply(st, seed.deposits);
            from = st.upTo = Math.max(seed.upTo, st.deployBlock);
          } catch (e) { reset(st); st.seeded = true; from = st.deployBlock; log(`pool ${st.denomination}: the seed was not used (${safeErr(e, 80)})`); }
        }
      }
      const tip = Number(BigInt(await request('eth_blockNumber', [])));
      const to = tip - confirmations + 1;
      if (to > from) {
        apply(st, await readTail({ getLogs: (f) => request('eth_getLogs', [f]), address: st.address, from, to }));
        st.upTo = to;
      }
      st.error = null;
    } catch (e) {
      st.error = e;
      if (/is missing/.test(String(e?.message))) reset(st);   // the history had a gap: the next refresh reads it from the start
      log(`pool ${st.denomination}: refresh failed (${safeErr(e, 80)})`);
    }
  }

  // The pool's state once it holds something: a refresh runs when the held history is older than maxAgeMs (the held one is served meanwhile), and the first read of an empty pool is waited
  // for up to `waitMs` (null: a pool that has nothing yet is not ready).
  async function ensure(address, { waitMs = 25_000 } = {}) {
    const st = pools.get(String(address).toLowerCase());
    if (!st) return null;
    if (!st.task && (st.count === 0 || now() - st.at > maxAgeMs)) {
      st.task = refresh(st).finally(() => { st.task = null; st.at = now(); });
    }
    if (st.count === 0 && st.task) await Promise.race([st.task, new Promise((r) => setTimeout(r, waitMs))]);
    return st.count > 0 ? st : null;
  }

  // A page of leaves: { total, upTo, from, n, leaves } with `leaves` as base64, or null while the pool has nothing yet.
  async function page(address, from, n, opts) {
    const st = await ensure(address, opts);
    if (!st) return null;
    const start = Math.min(Math.max(0, from | 0), st.count), count = Math.max(0, Math.min(n | 0, PAGE, st.count - start));
    return { total: st.count, upTo: st.upTo, from: start, n: count, leaves: Buffer.from(st.bytes.subarray(start * 32, (start + count) * 32)).toString('base64') };
  }

  // each pool read once, one after another, so a server that has just started is ready before the first page is asked for
  async function warm() { for (const st of pools.values()) await ensure(st.address, { waitMs: 0 }).then(() => st.task).catch(() => {}); }

  return { page, ensure, warm, has: (address) => pools.has(String(address).toLowerCase()), state: (address) => pools.get(String(address).toLowerCase()) };
}
