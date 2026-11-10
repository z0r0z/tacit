#!/usr/bin/env node
// Lets the page reach a seat holder's announced endpoint: the origin goes into the front page's connect-src (the page names the hosts it talks to, so
// a wallet routing a spend to the slot's leader (dapp/tacit-chain-route.js) can only reach one that is listed). The origin must be the latest endpoint a
// seat holder announced (TacitSeats.announce) on Ethereum; one that is not is refused.
//
//   node tools/tacit-chain-seat-host.mjs https://leader.example.com            add it, build, check
//   node tools/tacit-chain-seat-host.mjs https://leader.example.com --remove   take it out (no check against the chain), build, check
//   --dry-run  say what would change, change nothing      --rpc <url>  an Ethereum node that serves logs (default https://rpc.mevblocker.io)
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpointBase, endpointOf } from '../dapp/tacit-chain-route.js';
import { TACIT_SEATS, TACIT_CHAIN } from '../dapp/tacit-chain-config.js';

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), PAGE = join(ROOT, 'dapp', 'index.html');
const die = (m) => { console.error(`tacit-chain-seat-host: ${m}`); process.exit(1); };
const origin = endpointBase(argv.find((a) => /^https?:/.test(a)) || '');
if (!origin) die('give an https endpoint on a DNS name, e.g. https://leader.example.com');
if (origin === new URL(TACIT_CHAIN.leader).origin) die('that is the house leader, already listed');
const REMOVE = argv.includes('--remove'), DRY = argv.includes('--dry-run');

if (!REMOVE) {
  // the latest announcement of each holder: the origin must be one of them
  const rpc = arg('--rpc') || 'https://rpc.mevblocker.io';
  const topic0 = '0x' + Buffer.from((await import('@noble/hashes/sha3')).keccak_256(new TextEncoder().encode('Endpoint(address,string)'))).toString('hex');
  const r = await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: TACIT_SEATS.address, topics: [topic0], fromBlock: '0x' + TACIT_SEATS.from.toString(16), toBlock: 'latest' }] }) })).json();
  if (r.error) die(`the node would not list the announcements: ${r.error.message}`);
  const latest = new Map();
  for (const l of r.result) {
    const k = l.topics[1], n = Number(l.blockNumber) * 1e6 + Number(l.logIndex), b = endpointBase(endpointOf(l.data));
    if (!latest.has(k) || latest.get(k).n < n) latest.set(k, { n, b });
  }
  const who = [...latest].filter(([, v]) => v.b === origin).map(([k]) => '0x' + k.slice(26));
  if (!who.length) die(`no seat holder's latest announcement is ${origin} (${latest.size} holder(s) announced)`);
  console.log(`announced by ${who.join(', ')}`);
}

const text = readFileSync(PAGE, 'utf8');
const m = /(<meta http-equiv="Content-Security-Policy" content="[^"]*?connect-src )([^;"]+)/.exec(text);
if (!m) die('the front page has no connect-src');
let list = m[2].trim().split(/\s+/);
const had = list.includes(origin);
list = REMOVE ? list.filter((x) => x !== origin) : had ? list : [...list, origin];
if (!REMOVE && had) { console.log('already listed'); process.exit(0); }
if (REMOVE && !had) { console.log('not listed'); process.exit(0); }
console.log(`${DRY ? 'would ' : ''}${REMOVE ? 'remove' : 'add'} ${origin} ${REMOVE ? 'from' : 'to'} connect-src`);
if (DRY) process.exit(0);
writeFileSync(PAGE, text.slice(0, m.index) + m[1] + list.join(' ') + text.slice(m.index + m[0].length));
const run = (file, a = []) => execFileSync(process.execPath, [file, ...a], { cwd: ROOT, stdio: 'inherit' });
run(join(ROOT, 'build/build.mjs'));
run(join(ROOT, 'build/build.mjs'), ['--verify-only']);
run(join(ROOT, 'tests/tacit-chain-page.test.mjs'));
console.log('review the diff, then commit and push the dapp (it deploys on push)');
