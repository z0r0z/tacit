// Public index of the EVM ConfidentialPool, served at GET /confidential/index: every note leaf with its memo,
// every spent nullifier, deposit and cross-out, and the stealth lock set (lock leaves with their memos, lock
// nullifiers), in chain order behind one sequence cursor. It re-serves public chain data so an integrator can
// recover a key's notes and locks without running its own scanner; a client that wants no trust in this service
// rebuilds the identical stream from the pool's logs and settle calldata.
//
// The lock set is in no event (see dapp/confidential-lock-scan.js): lock leaves, their memos and lock nullifiers
// come from each settle call's publicValues, and a call counts only once an event the same transaction emitted
// corroborates it, because TacitRelayer skips a failed inner settle without reverting the batch. A lock-only call
// that spends nothing emits no event at all, so a log-driven index cannot see it.
//
// Corroboration cannot tell which of several settle blobs in another contract's calldata the pool ran: a contract
// can carry, ahead of its real call, a blob with the same leaves, memos and nullifiers but other lock leaves. So
// each lock row names where its transaction went (`via`: 'pool' for a settle sent straight to the pool, 'relayer'
// for TacitRelayer.relaySettle, whose calldata is exactly what it tried, 'nested' for a call decoded out of any
// other contract's calldata), and once a refresh reaches its target the lock tree rebuilt from the rows is checked
// against the pool's own lockNextLeafIndex and lockRoot (storage slots 84 and 85) at that block. If they differ,
// the nested rows no earlier match covered are set aside; if the tree then matches, those rows are marked
// `excluded` — kept in the stream, but out of the counts, the lock positions (`first`) and the tree. `lockSet`
// reports the pool's count and root and whether the rows reproduce them: null when the storage could not be read
// or no tree function was supplied, false when setting nested rows aside does not reproduce them either.
//
// Storage is a state record plus fixed-size pages of rows. Rows are written by position and the state advances
// only after its window's rows are stored, so a refresh cut short anywhere resumes and rewrites the same rows
// instead of duplicating them. Each refresh reads through the one endpoint that gave it the head block, and trails
// that head by a few blocks, so neither a short reorg nor a lagging node lands an incomplete window. The state also
// keeps the leaves of every lock row, so the lock check reads no pages.

import { makeConfidentialEvmLog } from '../../dapp/confidential-evm-log.js';
import { makeConfidentialLockScan } from '../../dapp/confidential-lock-scan.js';

export const INDEX_PAGE = 256;
export const INDEX_MAX_LIMIT = 1000;
const LOG_WINDOW = 500; // blocks per eth_getLogs — under the tightest range cap seen on the public RPCs (800)
const CONFIRMATIONS = 6;
const FRESH_MS = 12000; // refresh at most this often
const BUDGET_MS = 8000; // wall clock per refresh; the next one resumes from the stored block

const SEL_SETTLE = '717fd7f2';
const SEL_RELAY_SETTLE = 'fcccb833';
const SEL_RELAY_SETTLE_SEEDED = 'e2b28725';
const RELAYER = '0x00000000705D345449950e900271F27E7fEEABc5'; // TacitRelayer on mainnet
const SLOT_LOCK_COUNT = 84; // ConfidentialPool.lockNextLeafIndex
const SLOT_LOCK_ROOT = 85; // ConfidentialPool.lockRoot

export function makeConfidentialIndex({
  storage, rpcs, pool, deployBlock, keccak256, now, relayer = RELAYER, lockRootOf = null,
  page = INDEX_PAGE, window = LOG_WINDOW, confirmations = CONFIRMATIONS, budgetMs = BUDGET_MS, freshMs = FRESH_MS,
}) {
  // storage: { get(key) -> string|null, put(key, string) }. rpcs: [(method, params) -> result], each throwing on
  // any error rather than answering empty — an empty eth_getLogs is indistinguishable from "no events".
  // lockRootOf(leaves) -> hex root of the pool's incremental tree over `leaves` in append order; without it the
  // lock set is not checked.
  const clock = now || (() => Date.now());
  const evm = makeConfidentialEvmLog({ keccak256 });
  const calldata = makeConfidentialLockScan({ pool: null }); // its calldata decoders need no tree
  const key = `cpix:v1:${String(pool).toLowerCase()}`;
  const topics = [[evm.TOPIC0.LeavesInserted, evm.TOPIC0.NullifiersSpent, evm.TOPIC0.Wrap, evm.TOPIC0.CrossOutRecorded]];
  const hex = (n) => '0x' + n.toString(16);
  const word32 = (h) => '0x' + BigInt(h).toString(16).padStart(64, '0');
  const same = (a, b) => a.length === b.length && a.every((x, i) => String(x).toLowerCase() === String(b[i]).toLowerCase());
  const poolTo = String(pool).toLowerCase();
  const relayerTo = String(relayer).toLowerCase();
  const unread = (block) => ({ count: null, root: null, verified: null, block });

  // locks: one { seq, leaves, nullifiers (how many lock nullifiers the row spends), via } per lock row that adds
  // leaves. lockExclude: seqs of rows set aside. lockAnchor: every row below this seq was reproduced by a matching
  // root. lockSet: the last check.
  const blank = () => ({
    block: deployBlock - 1, head: null, seq: 0, at: 0,
    counts: { leaves: 0, nullifiers: 0, wraps: 0, crossOuts: 0, lockLeaves: 0, lockNullifiers: 0 },
    locks: [], lockExclude: [], lockAnchor: 0, lockSet: unread(null),
  });
  const loadState = async () => { const s = await storage.get(`${key}:state`); return s ? JSON.parse(s) : blank(); };
  const saveState = (st) => storage.put(`${key}:state`, JSON.stringify(st));
  const loadPage = async (i) => { const s = await storage.get(`${key}:p:${i}`); return s ? JSON.parse(s) : []; };
  const savePage = (i, rows) => storage.put(`${key}:p:${i}`, JSON.stringify(rows));

  // The four PublicValues arrays the index needs: 3 nullifiers, 4 leaves, 17 lockLeaves, 18 lockNullifiers. The
  // pool decodes publicValues as a one-element tuple, so the bytes open with an offset word to the struct head.
  function pvFields(pvHex) {
    const outer = String(pvHex).replace(/^0x/, '');
    const at = (d, byte) => {
      const w = d.slice(byte * 2, byte * 2 + 64);
      if (w.length !== 64) throw new Error('publicValues too short');
      return BigInt('0x' + w);
    };
    const data = outer.slice(Number(at(outer, 0)) * 2);
    const arr = (field) => {
      const off = Number(at(data, field * 32));
      const n = Number(at(data, off));
      if (n * 64 > data.length) throw new Error('publicValues array overruns its bytes');
      return Array.from({ length: n }, (_, i) => '0x' + at(data, off + 32 + i * 32).toString(16).padStart(64, '0'));
    };
    return { nullifiers: arr(3), leaves: arr(4), lockLeaves: arr(17), lockNullifiers: arr(18) };
  }

  function settleCalls(input) {
    const sel = String(input).replace(/^0x/, '').slice(0, 8).toLowerCase();
    if (sel === SEL_SETTLE) return [calldata.decodeSettleCalldata(input)];
    if (sel === SEL_RELAY_SETTLE || sel === SEL_RELAY_SETTLE_SEEDED) return calldata.decodeRelaySettleCalldata(input);
    return calldata.decodeNestedSettles(input);
  }

  // Where a transaction's settle calls came from: a settle sent to the pool, a relaySettle sent to the relayer, or
  // anything else.
  function viaOf(tx) {
    const to = String(tx.to || '').toLowerCase();
    const sel = String(tx.input).replace(/^0x/, '').slice(0, 8).toLowerCase();
    if (to === poolTo && sel === SEL_SETTLE) return 'pool';
    if (to === relayerTo && (sel === SEL_RELAY_SETTLE || sel === SEL_RELAY_SETTLE_SEEDED)) return 'relayer';
    return 'nested';
  }

  // One window of pool logs → index rows in chain order. A corroborated call's lock changes follow the event
  // that corroborated it, in the call order of its transaction (which is the lock tree's append order).
  async function rowsOf(rpc, logs) {
    const evs = evm.decodeLogs(logs).sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex));
    const settles = new Map();
    for (const ev of evs) {
      if (ev.type !== 'LeavesInserted' && ev.type !== 'NullifiersSpent') continue;
      if (!settles.has(ev.txHash)) settles.set(ev.txHash, []);
      settles.get(ev.txHash).push(ev);
    }
    for (const [txHash, group] of settles) {
      const tx = await rpc('eth_getTransactionByHash', [txHash]);
      if (!tx || typeof tx.input !== 'string') throw new Error(`transaction ${txHash} was not served`);
      const via = viaOf(tx);
      let calls;
      try { calls = settleCalls(tx.input); } catch { calls = []; }
      const used = new Set();
      for (const call of calls) {
        let f;
        try { f = pvFields(call.publicValues); } catch { continue; }
        if (!f.lockLeaves.length && !f.lockNullifiers.length) continue;
        const ordinary = call.memos.slice(0, f.leaves.length);
        const hit = group.find((ev) => !used.has(ev) && (f.leaves.length
          ? ev.type === 'LeavesInserted' && same(ev.leaves, f.leaves) && same(ev.memos, ordinary)
          : f.nullifiers.length > 0 && ev.type === 'NullifiersSpent' && same(ev.nullifiers, f.nullifiers)));
        if (!hit) continue;
        used.add(hit);
        (hit.locks || (hit.locks = [])).push({
          lockLeaves: f.lockLeaves,
          lockMemos: f.lockLeaves.map((_, i) => call.memos[f.leaves.length + i] ?? null),
          lockNullifiers: f.lockNullifiers,
          via,
        });
      }
    }
    const rows = [];
    for (const ev of evs) {
      const at = { block: ev.blockNumber, tx: ev.txHash, logIndex: ev.logIndex };
      if (ev.type === 'LeavesInserted') rows.push({ type: 'leaves', ...at, first: ev.firstLeafIndex, leaves: ev.leaves, memos: ev.memos });
      else if (ev.type === 'NullifiersSpent') rows.push({ type: 'nullifiers', ...at, nullifiers: ev.nullifiers });
      else if (ev.type === 'Wrap') rows.push({ type: 'wrap', ...at, depositId: ev.depositId, assetId: ev.assetId, amount: ev.amount.toString() });
      else if (ev.type === 'CrossOutRecorded') {
        rows.push({ type: 'crossOut', ...at, claimId: ev.claimId, destChain: ev.destChain,
          destCommitment: ev.destCommitment, nullifier: ev.nullifier, assetId: ev.assetId });
      }
      for (const l of ev.locks || []) rows.push({ type: 'locks', ...at, ...l });
    }
    return rows;
  }

  async function append(st, rows) {
    if (!rows.length) return;
    let pi = Math.floor(st.seq / page);
    let cur = (await loadPage(pi)).slice(0, st.seq % page);
    for (const r of rows) {
      const c = st.counts;
      if (r.type === 'leaves') c.leaves = Math.max(c.leaves, r.first + r.leaves.length);
      else if (r.type === 'nullifiers') c.nullifiers += r.nullifiers.length;
      else if (r.type === 'wrap') c.wraps += 1;
      else if (r.type === 'crossOut') c.crossOuts += 1;
      else if (r.type === 'locks') {
        r.first = c.lockLeaves;
        c.lockLeaves += r.lockLeaves.length;
        c.lockNullifiers += r.lockNullifiers.length;
        if (r.lockLeaves.length) st.locks.push({ seq: st.seq, leaves: r.lockLeaves, nullifiers: r.lockNullifiers.length, via: r.via });
      }
      cur.push({ seq: st.seq++, ...r });
      if (cur.length === page) { await savePage(pi, cur); pi += 1; cur = []; }
    }
    if (cur.length) await savePage(pi, cur);
  }

  // A state stored before it kept the lock rows: rebuild that record from the stored rows once, reading `via` for
  // rows stored without one.
  async function backfillLocks(rpc, st) {
    if (Array.isArray(st.locks)) return;
    const locks = [];
    const vias = new Map();
    for (let pi = 0; pi * page < st.seq; pi++) {
      const rows = await loadPage(pi);
      let changed = false;
      for (const r of rows) {
        if (r.type !== 'locks' || r.seq >= st.seq) continue;
        if (!r.via) {
          if (!vias.has(r.tx)) {
            const tx = await rpc('eth_getTransactionByHash', [r.tx]);
            if (!tx || typeof tx.input !== 'string') throw new Error(`transaction ${r.tx} was not served`);
            vias.set(r.tx, viaOf(tx));
          }
          r.via = vias.get(r.tx);
          changed = true;
        }
        if (r.lockLeaves.length) locks.push({ seq: r.seq, leaves: r.lockLeaves, nullifiers: r.lockNullifiers.length, via: r.via });
      }
      if (changed) await savePage(pi, rows);
    }
    Object.assign(st, { locks, lockExclude: [], lockAnchor: 0, lockSet: unread(null) });
  }

  // The lock tree the rows rebuild against the pool's own count and root, read at the block the index reached
  // through the endpoint that indexed it. Never throws: a failed read leaves the check unanswered.
  async function checkLocks(rpc, st) {
    if (!lockRootOf) { st.lockSet = unread(st.block); return; }
    if (st.lockSet && st.lockSet.block === st.block && st.lockSet.verified !== null) return;
    let count, root;
    try {
      const tag = hex(st.block);
      const [c, r] = await Promise.all([
        rpc('eth_getStorageAt', [pool, hex(SLOT_LOCK_COUNT), tag]),
        rpc('eth_getStorageAt', [pool, hex(SLOT_LOCK_ROOT), tag]),
      ]);
      count = Number(BigInt(c));
      root = word32(r);
    } catch { st.lockSet = unread(st.block); return; }
    let verified = null;
    try {
      const matches = (skip) => {
        const leaves = st.locks.filter((l) => !skip.has(l.seq)).flatMap((l) => l.leaves);
        return leaves.length === count && word32(lockRootOf(leaves)) === root;
      };
      let skip = new Set(st.lockExclude);
      verified = matches(skip);
      if (!verified) {
        const nested = st.locks.filter((l) => l.via === 'nested' && l.seq >= st.lockAnchor && !skip.has(l.seq));
        const wider = new Set([...skip, ...nested.map((l) => l.seq)]);
        if (nested.length && matches(wider)) { skip = wider; verified = true; }
      }
      if (verified) { st.lockExclude = [...skip].sort((a, b) => a - b); st.lockAnchor = st.seq; }
    } catch { verified = null; }
    st.lockSet = { count, root, verified, block: st.block };
  }

  async function refreshOnce() {
    const t0 = clock();
    let lastErr = null;
    for (const rpc of rpcs) {
      const st = await loadState(); // a failed endpoint's stored progress is kept; the next one resumes from it
      try {
        await backfillLocks(rpc, st);
        const head = Number(BigInt(await rpc('eth_blockNumber', [])));
        const target = head - confirmations;
        while (st.block < target) {
          const from = st.block + 1;
          const to = Math.min(target, st.block + window);
          const logs = await rpc('eth_getLogs', [{ address: pool, fromBlock: hex(from), toBlock: hex(to), topics }]);
          if (!Array.isArray(logs)) throw new Error('eth_getLogs answered without a list');
          await append(st, await rowsOf(rpc, logs));
          st.block = to;
          await saveState(st);
          if (clock() - t0 >= budgetMs) break;
        }
        st.head = head;
        st.at = st.block >= target ? clock() : 0; // still catching up: the next read refreshes again
        if (st.block >= target) await checkLocks(rpc, st);
        await saveState(st);
        return st;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no RPC endpoint configured');
  }

  // One refresh at a time per process; concurrent callers share it.
  let running = null;
  const refresh = () => running || (running = refreshOnce().finally(() => { running = null; }));
  async function fresh() {
    const st = await loadState();
    return st.at && clock() - st.at < freshMs ? st : refresh();
  }

  async function read({ from, limit } = {}) {
    const st = await loadState();
    const start = Math.min(Math.max(0, Math.floor(Number(from) || 0)), st.seq);
    const n = Math.min(INDEX_MAX_LIMIT, Math.max(1, Math.floor(Number(limit) || INDEX_MAX_LIMIT)));
    const end = Math.min(st.seq, start + n);
    const entries = [];
    for (let pi = Math.floor(start / page); pi * page < end; pi++) {
      for (const r of await loadPage(pi)) if (r.seq >= start && r.seq < end) entries.push(r);
    }
    // Excluded rows stay in the stream, marked, but out of the counts and out of every later row's lock position.
    const counts = { ...st.counts };
    const skip = new Set(st.lockExclude || []);
    if (skip.size) {
      const locks = st.locks || [];
      for (const l of locks) if (skip.has(l.seq)) { counts.lockLeaves -= l.leaves.length; counts.lockNullifiers -= l.nullifiers; }
      let li = 0, at = 0;
      for (const r of entries) {
        if (r.type !== 'locks') continue;
        while (li < locks.length && locks[li].seq < r.seq) {
          if (!skip.has(locks[li].seq)) at += locks[li].leaves.length;
          li += 1;
        }
        r.first = at;
        if (skip.has(r.seq)) r.excluded = true;
      }
    }
    const ls = st.lockSet || unread(null);
    return {
      pool, deployBlock, indexedToBlock: st.block, headBlock: st.head,
      synced: st.head != null && st.block >= st.head - confirmations,
      total: st.seq, next: start + entries.length, counts, entries,
      lockSet: { count: ls.count, root: ls.root, verified: ls.verified, block: ls.block },
    };
  }

  return { refresh, fresh, read, pvFields };
}
