// Every page that reads a chain through the shared node lists (dapp/eth-nodes.js) names every node of those lists in its connect-src, or the browser blocks
// the read of that node and the page falls to the next one with an error in the console. A node added to a list must be added to these pages.
//   node tests/csp-rpc-nodes.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ETH_NODES, ETH_LOG_NODES, ETH_ARCHIVE_NODES, BASE_NODES, ROBINHOOD_NODES } from '../dapp/eth-nodes.js';

// the pages whose script imports the lists (the front page and TAC's page, the pay page for Ethereum pools, the Bitcoin pool's Ethereum side, the tasks page)
const PAGES = ['index.html', 'tac/index.html', 'pay/eth/index.html', 'sats/index.html', 'tasks/index.html'];
const origin = (u) => new URL(u).origin;
const nodes = [...new Set([...ETH_NODES, ...ETH_LOG_NODES, ...ETH_ARCHIVE_NODES, ...BASE_NODES, ...ROBINHOOD_NODES].map(origin))];

let n = 0;
for (const page of PAGES) {
  const html = readFileSync(new URL(`../dapp/${page}`, import.meta.url), 'utf8');
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
  assert.ok(csp, `${page} carries a CSP`);
  const connect = (csp.match(/connect-src([^;]*)/)?.[1] || '').split(/\s+/).filter(Boolean);
  if (connect.includes('https:')) { console.log(`  ok - ${page}: any https host`); n++; continue; }
  const missing = nodes.filter((o) => !connect.includes(o));
  assert.deepEqual(missing, [], `${page} leaves out ${missing.join(', ')}`);
  console.log(`  ok - ${page}: all ${nodes.length} node hosts`); n++;
}
console.log(`csp-rpc-nodes: ${n} pages ok`);
