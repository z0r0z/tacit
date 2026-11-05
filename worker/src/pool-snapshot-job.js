// tacit-api's half of the pool snapshot (dapp/pool-snapshot.js): on the cron tick, read the pool's logs past what the snapshot holds (up to 64
// blocks behind the head, so no reorg reaches it), re-cut the last piece with them, pin the pieces and a manifest, and record the manifest for
// GET /pool/snapshot. Pieces before the last never change, so a day's run pins one or two pieces and the manifest. The trees are kept as the pool
// keeps them (counts, roots and the 32 filled subtrees each), so a run needs only the last piece's logs and the new ones, never the history.
//
// The header relay points snapshot.tacit.wei at the manifest once its roots check out on chain (worker-relay/src/lib/snapshot-pointer.js).
//
// Storage (KV): snap:state ({ v, to, pieces: [{ cid, n, from, to }], frontiers, at }), snap:pub ({ cid, to, at, trees }: the newest manifest).
import { SNAPSHOT, cutPieces, encodePiece, unpackPiece, gunzip, fetchBlock, emptyFrontiers, addToFrontiers, treesOfFrontiers, byChainOrder, rawCid } from '../../dapp/pool-snapshot.js';

export const SNAPSHOT_JOB = Object.freeze({
  final: 64,            // blocks behind the head the snapshot stops at
  span: 50_000,         // blocks per eth_getLogs to start with; narrowed on a refusal
  minSpan: 500,
  budgetMs: 90_000,     // wall clock per run; the next run resumes from the stored block
  everyMs: 60 * 60_000, // once caught up, a run at most this often
  cutChars: SNAPSHOT.cutChars,
});

// kv: { get, put }. rpcs: [(method, params) → result, throwing on any error]. pin(bytes) → its raw CID (Filebase), throwing on failure.
// fetchImpl: for the last piece when this process has not kept it. Everything else is the pool's: pool, manager, deployBlock, topics.
export function makePoolSnapshotJob({ kv, rpcs, pin, fetchImpl, sha256, keccak256, decodeLogs, pool, manager, deployBlock, topics, chainId = 1, now = Date.now, cfg = SNAPSHOT_JOB }) {
  const addresses = [pool, ...(manager ? [manager] : [])];
  const read = async (k) => { const s = await kv.get(k); try { return s == null ? null : JSON.parse(s); } catch { return null; } };
  let tail = null; // { cid, logs }: the last piece's logs, kept between runs in this process
  let spanNow = cfg.span;

  async function call(method, params) {
    let last = null;
    for (const r of rpcs) { try { return await r(method, params); } catch (e) { last = e; } }
    throw last || new Error('no rpc');
  }
  // Logs of [from, to], narrowing the range while every node refuses it.
  async function logsIn(from, to, until) {
    const out = [];
    for (let a = from; a <= to;) {
      if (now() > until) return { logs: out, to: a - 1 };
      const b = Math.min(a + spanNow - 1, to);
      try {
        out.push(...await call('eth_getLogs', [{ address: addresses, topics: [topics], fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }]));
        a = b + 1;
      } catch (e) {
        if (spanNow <= cfg.minSpan) throw e;
        spanNow = Math.max(cfg.minSpan, Math.floor(spanNow / 4));
      }
    }
    return { logs: out, to };
  }
  async function tailLogs(piece) {
    if (!piece) return [];
    if (tail && tail.cid === piece.cid) return tail.logs;
    return unpackPiece(await gunzip(await fetchBlock(piece.cid, { fetchImpl, sha256 })));
  }

  // One run → { status: 'idle' | 'behind' | 'published', to, cid? }.
  async function run() {
    const st = (await read('snap:state')) || { v: 1, to: Number(deployBlock) - 1, pieces: [], frontiers: emptyFrontiers(keccak256), at: 0 };
    const pub = await read('snap:pub');
    const head = parseInt(await call('eth_blockNumber', []), 16) - cfg.final;
    if (pub && pub.to >= st.to && now() - pub.at < cfg.everyMs) return { status: 'idle', to: st.to };
    const until = now() + cfg.budgetMs;
    const got = st.to < head ? await logsIn(st.to + 1, head, until) : { logs: [], to: st.to };
    got.logs.sort(byChainOrder);
    const last = st.pieces[st.pieces.length - 1];
    const prior = await tailLogs(last);
    const sealed = st.pieces.slice(0, last ? -1 : undefined);
    const all = [...prior, ...got.logs];
    const pieces = [];
    for (const p of cutPieces(all, cfg.cutChars)) pieces.push(...await encodePiece(p, addresses, sha256));
    const known = new Set(st.pieces.map((p) => p.cid));
    for (const p of pieces) if (!known.has(p.cid)) { const cid = await pin(p.bytes); if (cid !== p.cid) throw new Error(`pin gave ${cid} for ${p.cid}`); }
    const next = {
      v: 1, to: got.to, at: now(),
      pieces: [...sealed, ...pieces.map(({ cid, n, from, to }) => ({ cid, n, from, to }))],
      frontiers: addToFrontiers(st.frontiers, got.logs, { decodeLogs, keccak256, pool }),
    };
    const lastPiece = pieces[pieces.length - 1];
    tail = lastPiece ? { cid: lastPiece.cid, logs: all.slice(-lastPiece.n) } : null;
    await kv.put('snap:state', JSON.stringify(next));
    if (got.to < head - 300) return { status: 'behind', to: got.to };
    const trees = treesOfFrontiers(next.frontiers);
    const manifest = new TextEncoder().encode(JSON.stringify({ v: SNAPSHOT.version, chainId, pool, addresses, topics, deployBlock: Number(deployBlock), to: next.to, pieces: next.pieces, trees, at: next.at }));
    const cid = await pin(manifest);
    if (cid !== rawCid(manifest, sha256)) throw new Error(`pin gave ${cid} for the manifest`);
    await kv.put('snap:pub', JSON.stringify({ v: 1, cid, to: next.to, at: next.at, trees }));
    return { status: 'published', to: next.to, cid };
  }
  return { run };
}
