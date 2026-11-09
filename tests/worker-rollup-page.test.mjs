// GET /prover/rollup: the tacit chain's blocks the API keeps, paged back from a height (worker/src/index.js rollupPage, handleRollup).
// The chain page asks for the blocks older than the newest twenty /prover/blocks gives; `first` says where what is kept begins.
//
// Run: `node worker-rollup-page.test.mjs`

import { rollupPage, handleRollup } from '../worker/src/index.js';

let pass = 0, fail = 0;
const t = (label, ok) => { console.log(`  ${ok === true ? 'PASS' : 'FAIL'}  ${label}`); ok === true ? pass++ : fail++; };
const heights = (r) => r.rollup.map((x) => x.height);
const list = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ height: from + i, ethBlock: 26000000 + (from + i) * 40, tx: '0x' + (from + i).toString(16).padStart(64, '0'), pool: String(1e10 + i), shares: String(1e10 + i) }));
const L = list(40);                                    // heights 1..40, oldest first, as the KV list is kept

let r = rollupPage(L);
t('no height: the newest 25, newest first', heights(r).join() === Array.from({ length: 25 }, (_, i) => 40 - i).join());
t('first is the lowest height kept, kept is how many', r.first === 1 && r.kept === 40);

r = rollupPage(L, '16', '100');
t('before 16: 15 down to 1, nothing at or above 16', heights(r).join() === Array.from({ length: 15 }, (_, i) => 15 - i).join());

r = rollupPage(L, '31', '10');
t('before 31, limit 10: 30 down to 21', heights(r).join() === Array.from({ length: 10 }, (_, i) => 30 - i).join());

t('limit is at most 100', rollupPage(list(300), undefined, '100000').rollup.length === 100);
t('limit below 1 or not a number is 25', rollupPage(L, null, '0').rollup.length === 25 && rollupPage(L, null, 'x').rollup.length === 25 && rollupPage(L, null, '-5').rollup.length === 1);
t('a before that is not a height is ignored', heights(rollupPage(L, 'abc', '3')).join() === '40,39,38');
t('before at the lowest height: nothing older, first still says where it starts', (() => { const x = rollupPage(L, '1', '25'); return x.rollup.length === 0 && x.first === 1 && x.kept === 40; })());
t('an empty list: nothing, first null', (() => { const x = rollupPage([]); return x.rollup.length === 0 && x.first === null && x.kept === 0; })());
t('a list that starts above 1 (a window): first says so', rollupPage(list(30, 71), '85', '5').first === 71);

// the handler, with a KV holding the list and every node offline (the refresh fails quietly; what is kept is answered)
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('offline'); };
const kv = { get: async (k) => (k === 'tc:recent' ? JSON.stringify({ to: 26999999, list: L }) : null), put: async () => {} };
try {
  const res = await handleRollup(new Request('https://api.tacit.finance/prover/rollup?before=21&limit=4'), { REGISTRY_KV: kv }, new URL('https://api.tacit.finance/prover/rollup?before=21&limit=4'), { 'Access-Control-Allow-Origin': '*' });
  const j = await res.json();
  t('handler: 200, 20 down to 17, first 1, kept 40', res.status === 200 && heights(j).join() === '20,19,18,17' && j.first === 1 && j.kept === 40);
  t('handler: cors kept, cached a few seconds', res.headers.get('access-control-allow-origin') === '*' && /max-age=5/.test(res.headers.get('cache-control')));
  const none = await (await handleRollup(null, {}, new URL('https://api.tacit.finance/prover/rollup'), {})).json();
  t('handler: no KV: an empty answer, not an error', none.rollup.length === 0 && none.first === null);
  // (rollupList reads the KV inside a try: a KV that fails reads as an empty list, so `first` is null: the page takes that as "not known", never as "nothing older")
  const bad = await (await handleRollup(null, { REGISTRY_KV: { get: async () => { throw new Error('kv down'); }, put: async () => { throw new Error('kv down'); } } }, new URL('https://api.tacit.finance/prover/rollup'), {})).json();
  t('handler: a KV that fails: empty with first null (unknown)', bad.rollup.length === 0 && bad.first === null);
} finally { globalThis.fetch = realFetch; }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
