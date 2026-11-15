// The headless host's Bitcoin history reads: with __TACIT_CHAIN_VIA_WORKER__ set the reader asks the Tacit API's chain proxy first (with
// its network), a page keeps the public explorers, and the proxy lets those script-history paths through.
import { readFileSync } from 'node:fs';
import { defaultEsploraBases, ESPLORA_BASES, makeBtcHistoryProvider } from '../dapp/confidential-recovery-btc.js';
import { sha256 } from '../dapp/vendor/tacit-deps.min.js';

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };

ok(defaultEsploraBases('bc', {}) === ESPLORA_BASES, 'a page reads the public explorers');
const g = { __TACIT_CHAIN_VIA_WORKER__: true, __TACIT_WORKER_BASE__: 'https://api.example/' };
ok(defaultEsploraBases('bc', g)[0] === 'https://api.example/chain?network=mainnet' && defaultEsploraBases('bc', g).length === ESPLORA_BASES.length + 1, 'a headless host reads the proxy first, the explorers after');
ok(defaultEsploraBases('tb', g) === ESPLORA_BASES, 'only mainnet goes through the proxy');

const urls = [];
const p = makeBtcHistoryProvider({ sha256, bases: ['https://api.example/chain?network=mainnet'], fetchImpl: async (u) => { urls.push(String(u)); return new Response('[]', { status: 200 }); } });
await p.history('11'.repeat(32));
ok(urls.length > 0 && urls.every((u) => /^https:\/\/api\.example\/chain\/scripthash\/[0-9a-f]{64}\/txs\?network=mainnet$/.test(u)), `the network rides after the path (${urls[0]})`);

const src = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('const ALLOWED = ['), src.indexOf('if (!ALLOWED.some'));
const ALLOWED = eval(block.replace('const ALLOWED =', '(') .replace(/\];\s*$/, '])'));
const h = 'ab'.repeat(32);
ok(ALLOWED.some((re) => re.test(`/scripthash/${h}/txs`)), 'the proxy allows a script\'s history');
ok(ALLOWED.some((re) => re.test(`/scripthash/${h}/txs/chain/${h}`)), 'and its next page');
ok(!ALLOWED.some((re) => re.test(`/scripthash/${h}/utxo/../../x`)), 'nothing else under scripthash');

console.log(`\n${n} chain-proxy-headless checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
