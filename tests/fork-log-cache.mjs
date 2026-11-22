// A cache of eth_getLogs for the mainnet-fork tests (tests/*-fork.mjs), so the pool's log scan is made once and not once per page object.
//
// The pool is some 470,000 blocks old and a fresh page object (every `makeConfidentialPoolUx`, every new key) scans all of it. The dapp asks in the span its node list allows
// (50 blocks for the smallest host in dapp/eth-nodes.js, and every host in these tests is the same anvil): about 9,400 calls a scan, an hour and more, and the tests make several.
// A log at or behind the fork block cannot change, so it is kept: a request of any span is answered from aligned chunks of the SAME filter, each fetched once (an archive node takes up to
// 10,000 blocks; a chunk is 5,000), and with a file the settled chunks outlive the run, so the next test and the next run start with the scan done.
//
// Two kinds of chunk. A SETTLED one ends at least `margin` blocks behind the fork block (past any reorg): it is kept in the file. The one that reaches the fork block is fetched only up to
// the fork block and kept in memory for this run: the fork is frozen at that block, but another run's fork block is later, so a chunk kept part-filled would drop events silently there.
// Blocks past the fork block are the fork's own (what the test itself mines): a request that needs them is not answered here and goes to the fork as it was.
//
// The fetch is NOT through the fork: its state node need not serve old logs (publicnode keeps 128 blocks and answers "Archive requests require a personal token"). Give it an archive node.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const CHUNK = 5000n;
const HEX = /^0x[0-9a-f]+$/i;

// fetchChunk(filter, from, to) -> the logs (an array) of the filter for blocks from..to; it throws when it cannot.
// head() -> the fork block (BigInt). file: where to keep the settled chunks between runs (null: in memory only).
export function makeLogCache({ fetchChunk, head, file = null, margin = 64n, chunk = CHUNK, autosave = true }) {
  const chunks = new Map();      // settled: kept in the file
  const tails = new Map();       // reaching the fork block: this run only
  let dirty = 0, fetched = 0, served = 0;
  if (file && existsSync(file)) {
    try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) if (Array.isArray(v)) chunks.set(k, v); } catch { /* an unreadable file is a cold cache */ }
  }
  const save = () => {
    if (!file || !dirty) return;
    try { writeFileSync(file, JSON.stringify(Object.fromEntries(chunks))); dirty = 0; } catch { /* the next save tries again */ }
  };
  if (file && autosave) { setInterval(save, 60_000).unref(); process.on('exit', save); }

  const keyOf = (f, c) => JSON.stringify([f.address ?? null, f.topics ?? null, String(c)]);

  // -> the logs of the request, in block order, or null when this does not answer it (the caller sends it to the fork).
  async function logs(f) {
    if (!f || typeof f !== 'object' || f.blockHash || !HEX.test(String(f.fromBlock)) || !HEX.test(String(f.toBlock))) return null;
    const a = BigInt(f.fromBlock), b = BigInt(f.toBlock), fork = head(), top = fork - margin;
    if (b < a || b > fork) return null;
    const { fromBlock, toBlock, ...filter } = f;
    const out = [];
    for (let c = a / chunk; c <= b / chunk; c++) {
      const from = c * chunk, full = from + chunk - 1n, settled = full <= top;
      const store = settled ? chunks : tails, k = settled ? keyOf(f, c) : `${keyOf(f, c)}@${fork}`;
      let got = store.get(k);
      if (got) served++;
      else {
        got = await fetchChunk(filter, from, full <= fork ? full : fork);
        if (!Array.isArray(got)) throw new Error('fetchChunk did not return logs');
        store.set(k, got); fetched++;
        if (settled) dirty++;
      }
      for (const l of got) { const n = BigInt(l.blockNumber); if (n >= a && n <= b) out.push(l); }
    }
    return out;
  }
  return { logs, save, stats: () => ({ chunks: chunks.size, tails: tails.size, fetched, served }) };
}
