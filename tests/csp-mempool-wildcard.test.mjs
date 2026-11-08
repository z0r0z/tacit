// The pages that load dapp/tacit.js race the mempool.space regional servers (mempool.fra, .tk7, .va1) for fee rates and chain reads, so
// each one's connect-src names the wildcard next to mempool.space itself.
//   node tests/csp-mempool-wildcard.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGES = ['index.html', 'classic.html', 'pay/index.html', 'pay/eth/index.html', 'sats/index.html', 'trade/index.html', 'trade/tac/index.html', 'teth/index.html', 'cbtc/index.html', 'etch/index.html'];

for (const page of PAGES) {
  const html = readFileSync(new URL(`../dapp/${page}`, import.meta.url), 'utf8');
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
  assert.ok(csp, `${page} carries a CSP`);
  const connect = (csp.match(/connect-src([^;]*)/)?.[1] || '').split(/\s+/);
  assert.ok(connect.includes('https://mempool.space'), `${page} lists mempool.space`);
  assert.ok(connect.includes('https://*.mempool.space'), `${page} lists the mempool.space regional servers`);
}
console.log(`csp-mempool-wildcard: ${PAGES.length} pages ok`);
