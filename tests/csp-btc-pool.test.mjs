// A transfer out of the Bitcoin pool is validated from the pool service's exit record, which the validator asks for by address when a lot's history
// passes through one. Every page that validates lots or notes on Bitcoin names the service in its connect-src, or the read is blocked by the page and
// a purchase of such a lot refuses ("could not verify the seller's lot").
//   node tests/csp-btc-pool.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const POOL = 'https://tacit-btc-pool-mainnet.onrender.com';
const PAGES = ['index.html', 'classic.html', 'pay/index.html', 'pay/eth/index.html', 'sats/index.html', 'trade/index.html', 'trade/tac/index.html', 'teth/index.html', 'cbtc/index.html', 'vault/index.html', 'etch/index.html'];

for (const page of PAGES) {
  const html = readFileSync(new URL(`../dapp/${page}`, import.meta.url), 'utf8');
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
  assert.ok(csp, `${page} carries a CSP`);
  const connect = (csp.match(/connect-src([^;]*)/)?.[1] || '').split(/\s+/);
  assert.ok(connect.includes(POOL), `${page} lists the Bitcoin pool service`);
}
console.log(`csp-btc-pool: ${PAGES.length} pages ok`);
