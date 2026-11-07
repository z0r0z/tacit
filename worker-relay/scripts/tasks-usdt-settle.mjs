// Settles the places held in the usdt-bridge-test job: for each held tester whose step is not yet approved, reads the claim they sent (a transaction to themselves naming a
// Bitcoin transaction of their round trip), follows the trip from that transaction to its burn (dapp/tasks/inspect.js, the same reading the claim card shows) and, once the
// pool has minted the USDT again, approves the claim. Nothing is asked of the tester and nobody has to be found in Discord.
//
//   node worker-relay/scripts/tasks-usdt-settle.mjs            what each held place is waiting on
//   node worker-relay/scripts/tasks-usdt-settle.mjs --apply    also approve the ones that are complete (rewrites the job files through tasks-usdt-bridge.mjs;
//                                                               then push, deploy the points service and name the claims to POST /tasks/claim)
//   node worker-relay/scripts/tasks-usdt-settle.mjs --trace <txid>  where the round trip of one Bitcoin transaction stands
//   node worker-relay/scripts/tasks-usdt-settle.mjs --wait     poll every five minutes and exit as soon as one is complete and not yet approved
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readJobs } from './tasks-merge.mjs';
import { trace } from '../../dapp/tasks/inspect.js';
import { classifyConfidentialTx } from '../../dapp/burn-deposit-bitcoin.js';
import { makeCrossLaneGuard } from '../../dapp/confidential-crosslane-guard.js';
import { keccak_256 } from '../../dapp/vendor/tacit-deps.min.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SERVICE = `${root}worker-relay/src/lib/points-tasks-jobs.json`, PAGE = `${root}dapp/tasks/jobs.json`;
const JOB = 'usdt-bridge-test';
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const API = process.env.TASKS_API || 'https://api.tacit.finance';
const ETH = (process.env.TASKS_ETH_RPC ? process.env.TASKS_ETH_RPC.split(',') : ['https://ethereum-rpc.publicnode.com', 'https://rpc.mevblocker.io', 'https://eth.drpc.org']);
const ESPLORA = ['https://blockstream.info/api', 'https://mempool.space/api'];
const FLAG = { '01-tester': 'tester', '02-tester-second': 'tester2', '03-tester-third': 'tester3', '04-tester-fourth': 'tester4' };
const has = (f) => process.argv.includes(`--${f}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (s) => String(s || '').toLowerCase();

async function json(url, opts) { const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20e3) }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
// An explorer's answer: { data }, null when every explorer says there is no such transaction, and a throw when they could not be read.
async function esplora(path, text = false) {
  let missing = 0;
  for (const base of ESPLORA) {
    try { const r = await fetch(base + path, { signal: AbortSignal.timeout(20e3) }); if (r.ok) return { data: text ? (await r.text()).trim() : await r.json() }; if (r.status === 404) missing++; } catch { /* the next explorer */ }
  }
  if (missing === ESPLORA.length) return null;
  throw new Error(`explorers: ${path}`);
}
async function eth(method, params) {
  for (const u of ETH) { try { const j = await json(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); if (j.result != null) return j.result; } catch { /* the next node */ } }
  return null;
}
const guard = makeCrossLaneGuard({ keccak256: keccak_256 });
const deps = {
  look: async (txid) => {
    const j = await esplora(`/tx/${txid}`);
    if (!j) return null;
    const hex = (await esplora(`/tx/${txid}/hex`, true))?.data;
    let c = null;
    try { c = hex ? classifyConfidentialTx('0x' + hex) : null; } catch { /* not a bridge transaction */ }
    const st = j.data.status || {};
    return { confirmed: !!st.confirmed, height: st.block_height ?? null, time: st.block_time ?? null, kind: c?.type === 'burn' ? 'burn' : c?.type === 'crossout_mint' ? 'crossout_mint' : 'other', assetId: c?.assetId, nullifier: c?.nullifier };
  },
  outspends: async (txid) => (await esplora(`/tx/${txid}/outspends`))?.data ?? null,
  minted: async (nullifier) => (nullifier ? guard.evmNullifierSpent(async (a, slot, tag) => { const r = await eth('eth_getStorageAt', [a, slot, tag || 'latest']); if (r == null) throw new Error('eth read'); return r; }, POOL, nullifier) : null),
  attested: async () => (await json(`${API}/reflection/status?network=mainnet`)).attestedHeight ?? null,
};

// The claim a held tester sent: a successful transaction from the account to itself, twelve blocks deep, naming a Bitcoin transaction. → the named id, or why not.
async function claimNames(held) {
  const [tx, rc, head] = await Promise.all([eth('eth_getTransactionByHash', [held.claim]), eth('eth_getTransactionReceipt', [held.claim]), eth('eth_blockNumber', [])]);
  if (!tx || !rc) return { why: 'the claim is not on Ethereum' };
  if (rc.status !== '0x1') return { why: 'the claim failed' };
  if (lc(tx.from) !== lc(held.address) || lc(tx.to) !== lc(held.address)) return { why: 'the claim is not a transaction from the held account to itself' };
  if (!/^0x[0-9a-f]{64}$/i.test(tx.input || '')) return { why: 'the claim does not name a transaction' };
  if (parseInt(head, 16) - parseInt(tx.blockNumber, 16) < 12) return { why: 'the claim has fewer than twelve confirmations' };
  return { named: tx.input.slice(2).toLowerCase() };
}

async function once() {
  const page = readJobs(PAGE).find((j) => j.id === JOB), service = readJobs(SERVICE).find((j) => j.id === JOB);
  const ready = [];
  for (const s of page.steps) {
    if (!s.held) continue;
    const approved = service.steps.find((x) => x.id === s.id)?.approved ?? [];
    if (approved.some((h) => lc(h) === lc(s.held.claim))) { console.log(`${s.id}  ${s.held.address}  approved`); continue; }
    const c = await claimNames(s.held);
    if (!c.named) { console.log(`${s.id}  ${s.held.address}  held: ${c.why}`); continue; }
    const r = await trace(c.named, deps);
    console.log(`${s.id}  ${s.held.address}  ${r.state}${r.burn ? `  burn ${r.burn.slice(0, 12)}` : ''}${r.eta ? `  mint expected ${new Date(r.eta * 1000).toISOString().slice(11, 16)} UTC` : ''}  ${r.text}`);
    if (r.state === 'complete') ready.push({ step: s.id, claim: s.held.claim });
  }
  return ready;
}

const at = process.argv.indexOf('--trace');
if (at > 0) { console.log(JSON.stringify(await trace(process.argv[at + 1], deps), null, 1)); process.exit(0); }
let ready = await once();
if (has('wait')) while (!ready.length) { await sleep(300e3); console.log(`-- ${new Date().toISOString()}`); ready = await once(); }
for (const r of ready) console.log(`READY ${r.step} --${FLAG[r.step]} ${r.claim}`);
if (has('apply') && ready.length) {
  execFileSync('node', [`${root}worker-relay/scripts/tasks-usdt-bridge.mjs`, ...ready.flatMap((r) => [`--${FLAG[r.step]}`, r.claim])], { stdio: 'inherit' });
  console.log(`approved ${ready.length}: push, deploy the points service, then POST /tasks/claim with ${ready.map((r) => r.claim).join(', ')}`);
}
