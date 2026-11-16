// What a confidential pool's state did over a stretch of old blocks, read from the chain: the changes between two blocks, found with few reads.
//
// The activity log (pool-activity.js) is kept from the 5-minute tick, so a record starts empty when the service starts and has gaps when it is off. The chain has the history, if
// an archive node is asked for it, so a record is filled in from there. A change is found the way a change is found in a sorted list: the pool's state is read every STEP_BLOCKS
// (an hour), and where two neighbours differ the span between them is halved until it is RES_BLOCKS (five minutes, the tick's own resolution) wide, so a change costs a handful of reads
// and a quiet day costs 25. Two changes in one RES_BLOCKS span are one change, as they are in the log, and a state that goes away and comes back inside a coarse step is not seen;
// both make the count a floor. `stateAt(block)` answers the pool's state as "reserveA:reserveB:shares" (null where the pool did not exist yet) and is the only thing that touches a node.
import { FARM_SELECTORS } from './farm-health.js';

export const STEP_BLOCKS = 300, RES_BLOCKS = 25;      // how far apart the first reads are, and how narrow a span is searched down to (the window itself is pool-activity.js's)
// Nodes that serve old state (publicnode does not; the farm program's own list is for the present), those a free tier answers least often with a rate limit first. The last is a public
// key that rate-limits readily. A deployment may name its own (FARM_ARCHIVE_RPCS, comma separated), which is the way to a reliable read from a shared address: a keyed archive node.
export const ARCHIVE_RPCS_MAINNET = ['https://rpc.mevblocker.io', 'https://mainnet.rpc.buidlguidl.com', 'https://eth.drpc.org', 'https://gateway.tenderly.co/public/mainnet', 'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7'];

const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u).replace(/^https?:\/\//, '').split(/[/?#]/)[0]; } };
const LIMITED = /rate.?limit|too many|\b429\b|exceeded|capacity|compute units|quota|unauthorized|not whitelisted|\b403\b/i;

// JSON-RPC over a list of archive nodes, for reads that come in the hundreds from one address, which a free node limits. A read goes to the first node that is not resting and the next
// when one fails. A node that rate-limits rests for REST_LIMITED_MS and one that fails otherwise for REST_FAILED_MS, so the reads after it do not walk into it again (a node that is all
// that is left is still tried). When every node fails and one of them was limiting, the round is made again after a pause, `rounds` times in all. A failure says every node's reason, by host
// and never by address (a keyed address is a secret, and this message is shown): "rpc eth_call failed: rpc.mevblocker.io HTTP 429; mainnet.rpc.buidlguidl.com not JSON; ...".
export const REST_LIMITED_MS = 60_000, REST_FAILED_MS = 30_000;
export function makeArchiveRpc(urls, { fetchFn = (...a) => globalThis.fetch(...a), timeoutMs = 10_000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), rounds = 3 } = {}) {
  const rest = new Map();
  let id = 0;
  const resting = (u) => (rest.get(u) || 0) > now();
  async function ask(url, method, params) {
    let r;
    try {
      r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) { throw new Error(e && e.name === 'TimeoutError' ? 'timed out' : 'no answer'); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    let j;
    try { j = await r.json(); } catch { throw new Error('not JSON'); }
    if (j && j.error) throw new Error(String(j.error.message || j.error.code || 'error').replace(/https?:\/\/\S+/g, '').slice(0, 70));
    if (!j || j.result === undefined || j.result === null) throw new Error('empty result');
    return j.result;
  }
  async function rpc(method, params) {
    let errs = [];
    for (let round = 0; round < rounds; round++) {
      errs = [];
      let limited = false;
      for (const u of [...urls.filter((x) => !resting(x)), ...urls.filter(resting)]) {
        try { const v = await ask(u, method, params); rest.delete(u); return v; }
        catch (e) {
          const m = String(e.message), lim = LIMITED.test(m);
          limited ||= lim;
          rest.set(u, now() + (lim ? REST_LIMITED_MS : REST_FAILED_MS));
          errs.push(`${hostOf(u)} ${m}`);
        }
      }
      if (!limited || round === rounds - 1) break;
      await sleep(1500 * (round + 1));
    }
    throw new Error(`rpc ${method} failed: ${errs.join('; ')}`);
  }
  return { call: (to, data, blockHex) => rpc('eth_call', [{ to, data }, blockHex]), resting: () => urls.filter(resting).map(hostOf) };
}

// `stateAt` for one pool: pools(poolId) on the confidential pool at a block, through `rpc` (makeArchiveRpc below, or farm-health's makeRpc: anything with `call(to, data, blockHex)`).
export function stateReader(rpc, poolAddr, poolId) {
  return async (block) => {
    const r = String(await rpc.call(poolAddr, FARM_SELECTORS.pools + String(poolId).slice(2), '0x' + block.toString(16)) || '');
    if (r.length < 2 + 64 * 7) return null;
    const w = (i) => BigInt('0x' + r.slice(2 + 64 * i, 2 + 64 * (i + 1)));
    return w(0) === 0n ? null : `${w(3)}:${w(4)}:${w(6)}`;
  };
}

// At most `n` reads at once, shared by whoever is given the gate (every pool's search at one start), so a run asks a node for a few at a time.
export function makeGate(n) {
  let running = 0;
  const queue = [];
  const next = () => {
    while (running < n && queue.length) {
      const { fn, ok, no } = queue.shift();
      running++;
      Promise.resolve().then(fn).then(ok, no).finally(() => { running--; next(); });
    }
  };
  return (fn) => new Promise((ok, no) => { queue.push({ fn, ok, no }); next(); });
}

const kindOf = (a, b) => (a.split(':')[2] !== b.split(':')[2] ? 'liquidity' : 'trade');

// The changes to the pool's state in blocks (from, to]: { from, fromState, events: [{ block, kind }], calls }. `from` moves up to the first block the pool existed at, when it did not exist
// at the one asked for. `fromState` and `toState` are used when the caller has them (a read saved), and read when not. Throws when a read fails, when more than `budget` reads are needed
// or `deadline` (ms, on `now`) passes: a record filled in from part of a search is worse than none, so there is no partial answer.
export async function changesBetween({ stateAt, from, to, fromState, toState, step = STEP_BLOCKS, res = RES_BLOCKS, budget = 700, deadline = Infinity, now = () => Date.now(), gate = makeGate(5) }) {
  if (!(to > from)) return { from: to, fromState: toState ?? null, events: [], calls: 0 };
  let calls = 0, dead = null;
  const memo = new Map();
  // the first failure (a read, the budget, the time) ends the search: the reads still waiting for the gate are not made, so a node that has just failed is not asked a hundred more times
  const at = (b) => {
    if (!memo.has(b)) {
      memo.set(b, gate(async () => {
        if (dead) throw dead;
        try {
          if (now() > deadline) throw new Error('the history read ran out of time');
          if (++calls > budget) throw new Error('the history read needed more than its budget of reads');
          return await stateAt(b);
        } catch (e) { dead ||= e; throw e; }
      }));
    }
    return memo.get(b);
  };
  if (fromState !== undefined) memo.set(from, Promise.resolve(fromState));
  if (toState !== undefined) memo.set(to, Promise.resolve(toState));
  const blocks = [];
  for (let b = from; b < to; b += step) blocks.push(b);
  blocks.push(to);
  const states = await Promise.all(blocks.map(at));
  const first = states.findIndex((s) => s != null);
  if (first < 0) return { from: to, fromState: null, events: [], calls };
  if (states.slice(first).some((s) => s == null)) throw new Error('the pool was there and then was not');
  const refine = async (b0, s0, b1, s1) => {
    if (b1 - b0 <= res) return [{ block: b1, kind: kindOf(s0, s1) }];
    const mid = b0 + Math.floor((b1 - b0) / 2), sm = await at(mid);
    if (sm == null) throw new Error('the pool was there and then was not');
    const parts = [];
    if (s0 !== sm) parts.push(refine(b0, s0, mid, sm));
    if (sm !== s1) parts.push(refine(mid, sm, b1, s1));
    return (await Promise.all(parts)).flat();
  };
  const spans = [];
  for (let i = first; i < blocks.length - 1; i++) if (states[i] !== states[i + 1]) spans.push(refine(blocks[i], states[i], blocks[i + 1], states[i + 1]));
  const events = (await Promise.all(spans)).flat().sort((a, b) => a.block - b.block);
  return { from: blocks[first], fromState: states[first], events, calls };
}
