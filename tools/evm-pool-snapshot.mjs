#!/usr/bin/env node
// Rebuilds an EVM pool's note tree and spent set from its Transact events and checks them against the pool: every event's
// announced root must be reproduced, and the head must equal the pool's own root(). Read-only. Prints what a holding-reward
// verifier would pin for a snapshot block: the note-tree root, the spent-set root, and how many unspent notes there are
// (the size of the anonymity set a proof of holding hides among).
//
//   node tools/evm-pool-snapshot.mjs [--chain 1|8453|4663] [--at <block>] [--source explorer|rpc] [--rpc <url>] [--span <blocks>] [--cache <file>] [--from <block>]
//
// --source explorer (the default on Ethereum) pages the pool's logs from the chain's Blockscout, which needs no archive node;
// --source rpc (the default on Base and Robinhood, whose explorers refuse scripts) reads them with eth_getLogs from a node that
// serves history, growing the block span while the node allows it.
//
// Logs are cached in --cache (default under the OS temp dir) so a run resumes where it stopped.

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadZk } from '../worker-relay/src/lib/evm-pool-keeper-prover.js';
import { buildPoolHistory } from '../worker-relay/src/lib/evm-pool-snapshot.js';
import { POOL, CHAINS, EXPLORERS, makeClient, readTransactLogs, readTransactLogsExplorer, poolState, rootSizeOf } from '../worker-relay/src/lib/evm-pool-snapshot-chain.js';

const arg = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };

const chainId = Number(arg('chain', 1));
const chain = CHAINS[chainId];
if (!chain) { console.error(`chain ${chainId} is not one of ${Object.keys(CHAINS).join(', ')}`); process.exit(2); }
const client = makeClient(arg('rpc', chain.rpc));
const cacheDir = join(tmpdir(), 'tacit-evm-pool-snapshot');
mkdirSync(cacheDir, { recursive: true });
const cacheFile = arg('cache', join(cacheDir, `events-${chainId}.json`));

const t0 = Date.now();
const head = Number(await client.getBlockNumber());
const from = Number(arg('from', chain.deployBlock));
const source = arg('source', chainId === 1 ? 'explorer' : 'rpc');   // the L2 explorers refuse unauthenticated scripts
console.log(`${chain.name}: head ${head}; reading Transact events from block ${from} through ${source}`);
const logs = source === 'rpc'
  ? await readTransactLogs(client, { from, head, span: Math.min(chain.span, Number(arg('span', chain.span))), maxSpan: Number(arg('span', chain.maxSpan)), cacheFile, log: (m) => console.log('  ' + m) })
  : await readTransactLogsExplorer({ ...EXPLORERS[chainId], from, log: (m) => console.log('  ' + m) });
console.log(`  ${logs.length} events read in ${Math.round((Date.now() - t0) / 1000)} s`);

const zk = await loadZk();
const history = buildPoolHistory({ transacts: logs, zk });
// The pool's own answers, read at its latest state: the head root and size, and for every root the events announced, the size
// the pool recorded when that root was its head. Nothing here needs an archive node.
const now = await poolState(client, head);
const headSize = await rootSizeOf(client, history.head.root);
let checked = 0, bad = 0;
const seenRoots = new Map();
for (const e of logs) seenRoots.set(BigInt(e.newRoot), true);
const sample = [...seenRoots.keys()];
const stride = Math.max(1, Math.floor(sample.length / 40));
for (let i = 0; i < sample.length; i += stride) {
  const r = sample[i], expected = history.sizeOfRoot ? history.sizeOfRoot(r) : null;
  const onChainSize = await rootSizeOf(client, r);
  checked++;
  if (onChainSize === null || (expected !== null && onChainSize !== expected)) bad++;
}
console.log(`  every announced root reproduced by the rebuilt tree: yes (${history.events} events)`);
console.log(`  head: rebuilt root ${history.head.root.toString(16).slice(0, 16)}…, size ${history.head.size}; the pool knows that root: ${headSize !== null ? 'yes' : 'NO'}, recording size ${headSize}`);
console.log(`  pool now: root ${now.root.toString(16).slice(0, 16)}…, nextIndex ${now.nextIndex} ${now.root === history.head.root ? '(the same head)' : `(${now.nextIndex - history.head.size} leaves past the last event read: the explorer is behind or the pool has moved)`}`);
console.log(`  ${checked} of ${sample.length} announced roots checked against the pool's own root history: ${bad} wrong`);
const ok = headSize === history.head.size && bad === 0;

const at = Number(arg('at', head));
const st = history.at(at);
const eth = (w) => (Number(w / 10n ** 12n) / 1e6).toFixed(4);
console.log(`  at block ${at}: ${st.size} leaf slots, ${st.leaves} non-empty leaves, ${st.nullifiers} published nullifiers (zero-value padding notes included, so neither is a count of notes held)`);
console.log(`    public flows: ${st.flows.deposits} deposits ${eth(st.flows.in)} ETH in, ${st.flows.withdrawals} withdrawals ${eth(st.flows.out)} ETH out, relayer fees ${eth(st.flows.fees)} ETH, left ${eth(st.flows.net)} ETH`);
const balance = await client.getBalance({ address: POOL });
console.log(`    the pool's ETH balance now: ${eth(balance)} (in - out - fees ${st.flows.net === balance ? 'equals it exactly' : `differs by ${eth(balance - st.flows.net)}`}${at === head ? '' : '; only comparable at the head'})`);
console.log(`    note-tree root ${'0x' + st.root.toString(16)}`);
console.log(`    spent-set root ${'0x' + history.nfRootAt(at).toString(16)}`);
if (!ok) { console.error('  MISMATCH with the pool'); process.exit(1); }
