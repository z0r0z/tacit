// The front page keeps its own copy of where the tacit chain is (TACIT_CHAIN_PAGE), so a page without the chain loads nothing of it: the copy must
// be tacit-chain-config.js's TACIT_CHAIN, and a leader set there must be in the connect-src of every page that talks to it (the front page and
// /chain/, which reads the config module itself). tools/tacit-chain-golive.mjs sets all of it.
//   node tests/tacit-chain-page.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { TACIT_CHAIN } from '../dapp/tacit-chain-config.js';

const read = (rel) => readFileSync(new URL(`../dapp/${rel}`, import.meta.url), 'utf8');
const page = read('index.html');
const m = /var TACIT_CHAIN_PAGE = (\{[^}]*\});/.exec(page);
assert.ok(m, 'the page names TACIT_CHAIN_PAGE');
const copy = Function(`return (${m[1]})`)();
assert.deepEqual(copy, TACIT_CHAIN, 'the page\'s copy is the config\'s');
assert.ok((TACIT_CHAIN.blocks == null) === (TACIT_CHAIN.leader == null), 'the config names both the contract and the leader, or neither');
const connect = (html) => /connect-src ([^;"]+)/.exec(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1])[1].trim().split(/\s+/);
for (const rel of ['index.html', 'chain/index.html']) {
  const list = connect(read(rel));
  assert.ok(!list.includes('https:') && !list.includes('*'), `${rel}: connect-src names its hosts`);
  if (TACIT_CHAIN.leader) {
    assert.ok(/^https:\/\//.test(TACIT_CHAIN.leader), 'the leader is https');
    assert.ok(list.includes(new URL(TACIT_CHAIN.leader).origin), `${rel}: the leader is in connect-src`);
  }
}
console.log(`ok tacit chain page config (${TACIT_CHAIN.leader ? `live: ${TACIT_CHAIN.leader}` : 'not deployed'})`);
