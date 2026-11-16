// What a confidential pool's state did over a stretch of old blocks, read from the chain: the changes between two blocks, found with few reads.
//
// The activity log (pool-activity.js) is kept from the 5-minute tick, so a record starts empty when the service starts and has gaps when it is off. The chain has the history, if
// an archive node is asked for it, so a record is filled in from there. A change is found the way a change is found in a sorted list: the pool's state is read every STEP_BLOCKS
// (an hour), and where two neighbours differ the span between them is halved until it is RES_BLOCKS (five minutes, the tick's own resolution) wide, so a change costs a handful of reads
// and a quiet day costs 25. Two changes in one RES_BLOCKS span are one change, as they are in the log, and a state that goes away and comes back inside a coarse step is not seen;
// both make the count a floor. `stateAt(block)` answers the pool's state as "reserveA:reserveB:shares" (null where the pool did not exist yet) and is the only thing that touches a node.
import { FARM_SELECTORS } from './farm-health.js';

export const STEP_BLOCKS = 300, RES_BLOCKS = 25;      // how far apart the first reads are, and how narrow a span is searched down to (the window itself is pool-activity.js's)
// Nodes that serve old state (publicnode does not; the farm program's own list is for the present). Public keys, so a deployment may name its own (FARM_ARCHIVE_RPCS, comma separated).
export const ARCHIVE_RPCS_MAINNET = ['https://rpc.mevblocker.io', 'https://mainnet.rpc.buidlguidl.com', 'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7'];

// `stateAt` for one pool: pools(poolId) on the confidential pool at a block, through `rpc` (farm-health makeRpc: each read goes to the first node that answers).
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
