// The chain page's 7-day figures read back a week of blocks from GET /prover/blocks + /prover/rollup, so the API keeps ROLLUP_KEEP blocks and fills a
// short list backwards from its lowest Ethereum block (rollupList in worker/src/index.js). Fake Ethereum RPC and KV: the list grows older without
// losing the newest blocks, stops at the contract's first block, and is never longer than ROLLUP_KEEP.
//
// Run: `node tests/worker-rollup-backfill.test.mjs`
import { rollupList, ROLLUP_KEEP } from '../worker/src/index.js';

let pass = 0, fail = 0;
const t = (label, ok) => { console.log(`  ${ok === true ? 'PASS' : 'FAIL'}  ${label}`); ok === true ? pass++ : fail++; };

const FROM = 26366005, HEAD = 26442805;
const hex = (n) => '0x' + n.toString(16);
// block h landed at Ethereum block FROM + 100 * h (h = 1..760), each with a land call input that is not a land (pool stays null: only the list is under test)
const chainBlocks = Array.from({ length: 760 }, (_, i) => ({ h: i + 1, eth: FROM + 100 * (i + 1) }));
const logsIn = (a, b) => chainBlocks.filter((x) => x.eth >= a && x.eth <= b).map((x) => ({
  topics: ['0x0', '0x' + x.h.toString(16).padStart(64, '0'), '0x' + '0'.repeat(24) + 'ab'.repeat(20)], blockNumber: hex(x.eth), transactionHash: '0x' + x.h.toString(16).padStart(64, '0') }));
globalThis.fetch = async (_u, o) => {
  const { method, params } = JSON.parse(o.body);
  const result = method === 'eth_blockNumber' ? hex(HEAD + 2)
    : method === 'eth_getLogs' ? logsIn(parseInt(params[0].fromBlock, 16), parseInt(params[0].toBlock, 16))
    : method === 'eth_getTransactionByHash' ? { input: '0x' } : null;
  return { ok: true, json: async () => ({ result }) };
};
const m = new Map(), kv = { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
const env = { REGISTRY_KV: kv };
// stored as the old cap left it: the newest 300 of 760, forward cursor at the head
const old = chainBlocks.slice(-300).map((x) => ({ height: x.h, ethBlock: x.eth, tx: '0x' + x.h.toString(16).padStart(64, '0'), by: '0x' + 'ab'.repeat(20) }));
m.set('tc:recent', JSON.stringify({ to: HEAD, list: old }));

const realNow = Date.now; let clock = realNow();
Date.now = () => clock;
let list = [];
for (let i = 0; i < 20; i++) { clock += 16000; list = await rollupList(env); }
Date.now = realNow;

t('ROLLUP_KEEP holds more than the old 300', ROLLUP_KEEP >= 1000);
t('the list reached block 1 (the older blocks the old cap dropped came back)', list[0].height === 1);
t('every block 1..760 is there once, in order', list.length === 760 && list.every((x, i) => x.height === i + 1));
t('the newest block is unchanged', list.at(-1).height === 760 && list.at(-1).ethBlock === chainBlocks.at(-1).eth);
const st = JSON.parse(m.get('tc:recent'));
t('the forward cursor was kept', st.to === HEAD);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
