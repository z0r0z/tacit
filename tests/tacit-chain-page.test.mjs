// The front page keeps its own copy of where the tacit chain is (TACIT_CHAIN_PAGE), so a page without the chain loads nothing of it: the copy must
// be tacit-chain-config.js's TACIT_CHAIN, and a leader set there must be in the page's connect-src.
//   node tests/tacit-chain-page.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { TACIT_CHAIN } from '../dapp/tacit-chain-config.js';

const page = readFileSync(new URL('../dapp/index.html', import.meta.url), 'utf8');
const m = /var TACIT_CHAIN_PAGE = (\{[^}]*\});/.exec(page);
assert.ok(m, 'the page names TACIT_CHAIN_PAGE');
const copy = Function(`return (${m[1]})`)();
assert.deepEqual(copy, TACIT_CHAIN, 'the page\'s copy is the config\'s');
if (TACIT_CHAIN.leader) {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(page)[1], connect = /connect-src ([^;]+)/.exec(csp)[1].split(/\s+/);
  assert.ok(connect.includes(new URL(TACIT_CHAIN.leader).origin), 'the leader is in connect-src');
}
console.log('ok tacit chain page config');
