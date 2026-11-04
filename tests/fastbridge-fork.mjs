#!/usr/bin/env node
// The fast bridge's Ethereum side against the LIVE pool on a mainnet fork: both role machines (dapp/fastbridge-bl.js,
// dapp/fastbridge-el.js) run with the real adapter (dapp/fastbridge-evm.js) on the real pool wallet module
// (dapp/confidential-pool-ux.js). The relay is stood in for by the worker's own job queue (worker/src/confidential-settle.js)
// with a box that does every step the real one does but prove: it builds the guest's input from the claimed job
// (dapp/sp1-stdin.js), runs the pinned SETTLE GUEST (the committed elf/cxfer-guest, whose vkey is the one inside the
// live pool) in SP1 execute mode, and sends pool.settle() with those public values. The pool's SP1 verifier alone is
// replaced, by code that accepts any proof: everything the pool checks of the public values (roots, nullifiers, lock
// set, deadlines, memos) is the real contract's. Bitcoin is the simulated one (tests/lib/chain-sim.mjs) on a clock that
// the fork's time follows.
//
//   node tests/fastbridge-fork.mjs     (FORK=<rpc url>; EXEC=<the exec-stdin binary> or CARGO_TARGET_DIR=<a dir holding sp1-sdk's build>;
//                                       Node 22, anvil; FORK_CACHE=<file> keeps what the fork reads, 0 for none)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire, register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const ELF = join(ROOT, 'contracts/sp1/confidential/elf/cxfer-guest');
const EXEC = process.env.EXEC || join(process.env.CARGO_TARGET_DIR || join(ROOT, 'tests/exec-stdin/target'), 'release/exec-stdin');
if (spawnSync('anvil', ['--version']).status !== 0) { console.log('skip - needs anvil'); process.exit(0); }
if (!existsSync(EXEC)) { console.log('skip - the exec-stdin binary is missing (EXEC=<binary>, or build tests/exec-stdin; see its Cargo.toml)'); process.exit(0); }
const elfSha = createHash('sha256').update(readFileSync(ELF)).digest('hex');
if (elfSha !== 'f7bc327d232ec8d1f693d5a44024c1ee732dc42196d079c5be5e3f3668b922c7') throw new Error(`the guest ELF is not the pinned one (${elfSha})`);

// the page's own modules import by site path; the key sheet, the pool-module cache and the activity journal are the page's alone
const STUBS = {
  '/trade/poolux.js': 'export const getUx = async () => globalThis.T.ux; export async function forgetUx() {}',
  '/activity.js': 'export function makeRunner() { return { wait: (label, ms) => ({ timeoutMs: ms, label, onJob() {}, sleep: (t) => new Promise((r) => setTimeout(r, Math.min(t, 500))) }) }; }',
};
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)}, S = ${JSON.stringify(STUBS)};
export async function resolve(spec, ctx, next) {
  const path = spec.split('?')[0];
  if (path in S) return { url: 'data:text/javascript,' + encodeURIComponent(S[path]), shortCircuit: true };
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + path, ctx);
  return next(spec, ctx);
}`));

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { encodeFunctionData, parseAbi, keccak256 } = require('viem');
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co';
const PORT = 25700 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`, RPORT = PORT + 400, RELAY = `http://127.0.0.1:${RPORT}`;
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', SP1_VERIFIER = '0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2';
const SETTLER = '0x00000000000000000000000000000000005e771e', FROM = '0x00000000000000000000000000000000000dE921';
const ETH_ID = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const E10 = 10n ** 10n;
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (v) => '0x' + BigInt(v).toString(16);
const realFetch = globalThis.fetch;
const rpcA = async (method, params = []) => {
  const j = await (await realFetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { data: j.error.data });
  return j.result;
};

const procs = [], tmp = mkdtempSync(join(tmpdir(), 'fastbridge-fork-'));
const stop = () => { for (const p of procs) p.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); };
process.on('exit', stop);
// anvil forks through a proxy that asks the upstream again when it drops a request and keeps what it has read at the pinned block
const { startForkProxy } = await import('./lib/fork-proxy.mjs');
const proxy = await startForkProxy({ upstream: FORK, fetchImpl: realFetch, log: (m) => console.log('  ..   fork proxy: ' + m), cacheFile: process.env.FORK_CACHE === '0' ? null : (process.env.FORK_CACHE || join(tmpdir(), 'fastbridge-fork-cache.json')) });
procs.push({ kill: () => proxy.close() });
const head = BigInt(await proxy.pickBlock());
procs.push(spawn('anvil', ['--port', String(PORT), '--fork-url', proxy.url, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit', '--retries', '2', '--fork-retry-backoff', '500', '--timeout', '900000'], { stdio: 'ignore' }));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
for (const a of [SETTLER, FROM]) { await rpcA('anvil_impersonateAccount', [a]); await rpcA('anvil_setBalance', [a, hex(100n * 10n ** 18n)]); }
{
  const pin = JSON.parse(readFileSync(join(ROOT, 'contracts/sp1/confidential/elf-vkey-pin.json'), 'utf8'));
  ok((await rpcA('eth_getCode', [POOL, 'latest'])).toLowerCase().includes(pin.program_vkey.slice(2).toLowerCase()) && pin.elf_sha256 === elfSha, `the guest run here is the one the live pool's immutable vkey names (${pin.program_vkey.slice(0, 14)}…)`);
}
await rpcA('anvil_setCode', [SP1_VERIFIER, '0x00']);                         // accepts any proof: the guest's public values are what the pool then checks

// ── the relay ──
const { stdinFor } = await import('../dapp/sp1-stdin.js');
const { makeConfidentialSettler } = await import('../worker/src/confidential-settle.js');
const store = (() => { const m = new Map(); let pending = []; return { getPending: async () => pending.slice(), putPending: async (ids) => { pending = ids.slice(); }, getJob: async (id) => (m.has(id) ? JSON.parse(JSON.stringify(m.get(id))) : null), putJob: async (id, j) => { m.set(id, JSON.parse(JSON.stringify(j))); } }; })();
const settler = makeConfidentialSettler({ storage: store, hash: (str) => keccak256(`0x${Buffer.from(str).toString('hex')}`), sleep: async () => {} });
const log = [], jobsSeen = [];
const note = (line) => { log.push(line); console.log('  ..   ' + line); };
const T00 = Date.now();
let queue = Promise.resolve();
async function send(from, to, data) {
  let gas = 3_000_000n;
  try { gas = (BigInt(await rpcA('eth_estimateGas', [{ from, to, data }])) * 13n) / 10n; } catch (e) { throw Object.assign(new Error(`the pool would revert: ${String(e.message).slice(0, 160)} ${String(e.data || '').slice(0, 74)}`), { data: e.data }); }
  const h = await rpcA('eth_sendTransaction', [{ from, to, data, gas: hex(gas) }]);
  for (let i = 0; i < 1200; i++) { const rc = await rpcA('eth_getTransactionReceipt', [h]); if (rc) { if (rc.status !== '0x1') throw new Error(`reverted ${h}`); return { hash: h, rc }; } await sleep(100); }
  throw new Error('no receipt');
}
const execGuest = (env) => new Promise((resolve) => {
  const c = spawn(EXEC, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
  c.on('close', (status) => resolve({ status, stdout, stderr }));
});
async function runJob(claimed) {
  const { jobId: id, type, op, memos: jm } = claimed;
  const rec = { id, type };
  jobsSeen.push(rec);
  try {
    const body = { type, op: JSON.parse(JSON.stringify(op)), memos: jm };
    if (process.env.MUTATE === 'claim-amount' && type === 'adaptorclaim') body.op.amount = Number(body.op.amount) + 1;      // a changed op: the guest must refuse it (not part of a normal run)
    const memos = body.memos || [];
    const memoHashes = memos.map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`));
    const stdin = stdinFor(body.type, { ...body.op, memoHashes });
    const f = join(tmp, `${id.slice(2, 14)}.stdin`), out = join(tmp, `${id.slice(2, 14)}.pv`);
    writeFileSync(f, stdin);
    const t = Date.now();
    const r = await execGuest({ ...process.env, STDIN: f, OUT: out });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('EXECUTE_OK')) || '';
    rec.exec = `${type}: ${line} in ${((Date.now() - t) / 1000).toFixed(1)} s`;
    if (r.status !== 0 || !existsSync(out)) throw new Error(`the settle guest rejected the op: ${((r.stderr || '') + (r.stdout || '')).split('\n').filter((l) => /panick|assert|error|failed/i.test(l)).slice(0, 3).join(' | ').slice(0, 300)}`);
    note(rec.exec);
    const pv = readFileSync(out, 'utf8').trim();
    const data = encodeFunctionData({ abi: parseAbi(['function settle(bytes publicValues, bytes proof, bytes[] memos)']), functionName: 'settle', args: [`0x${pv}`, '0x', memos.map((m) => (m.startsWith('0x') ? m : `0x${m}`))] });
    const s = await send(SETTLER, POOL, data);
    rec.txHash = s.hash;
    await settler.ackJob(id, { txHash: s.hash });
  } catch (e) { rec.error = String(e.message || e).slice(0, 400); note(`${type} failed: ${rec.error}`); await settler.ackJob(id, { error: rec.error }); }
}
const server = createServer(async (req, res) => {
  const u = new URL(req.url, RELAY);
  const json = (code, b) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); };
  const body = req.method === 'POST' ? JSON.parse(await new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => r(s || '{}')); })) : null;
  if (u.pathname === '/confidential/relay') return json(200, { state: 'ok', proving: true, settling: true, board: false });
  if (u.pathname === '/confidential/quote') return json(200, { recommendedWrapTipWei: '60000000000000', tipSplitter: '0xf5eBBE5Db610F64D29A0dC5e9534074Af12834F9', gasAwareFloorUnits: '20000', staticFloorUnits: '20000' });
  if (u.pathname === '/confidential/submit' && req.method === 'POST') {
    let r;
    try { r = await settler.submitJob({ type: body.type, op: body.op, memos: body.memos, mode: body.mode || 'settle', feeAsset: body.feeAsset || null, exit: body.exit || null }); }
    catch (e) { return json(400, { error: String(e.message || e) }); }
    console.log(`  ..   relay took a ${body.type} job [${Math.round((Date.now() - T00) / 1000)} s]`);
    queue = queue.then(async () => { const claimed = await settler.nextJob(); if (claimed) await runJob(claimed); });
    return json(200, { ok: true, ...r });
  }
  if (u.pathname === '/confidential/status') { const j = await settler.jobStatus(u.searchParams.get('id')); return j ? json(200, j) : json(404, { error: 'unknown' }); }
  return json(404, { error: 'no such path here' });
}).listen(RPORT);
server.keepAliveTimeout = 120_000;
procs.push({ kill: () => server.close() });

// the wallet's reads: every node goes to the fork, the relay's API to the relay above
const again = async (go, what) => { for (let i = 0; ; i++) { try { return await go(); } catch (e) { if (i >= 3) { note(`fetch to ${what} failed: ${e.cause?.code || e.message}`); throw e; } await sleep(700 * (i + 1)); } } };
const routed = async (url, init) => {
  const u = String(url);
  // the page's relay base: api.tacit.finance, or the origin of the DOM the note validator runs in (the deployment config uses it when it is localhost)
  const rel = /^(?:https:\/\/api\.tacit\.finance|http:\/\/localhost(?::80)?)(\/confidential\/.*)$/.exec(u);
  if (rel) return realFetch(RELAY + rel[1], init);
  if (/^https:\/\/api\.tacit\.finance\//.test(u) || /^http:\/\/localhost(?::80)?\//.test(u)) return new Response('{}', { status: 404 });
  if (/^https?:\/\/[^/]*(rpc|node|gateway|eth\.|llama|ankr|drpc|merkle|infura|alchemy|cloudflare|1rpc)/i.test(u) && init?.method === 'POST') {
    // a busy upstream answers some reads with an error body; those are asked again, as the page's wallet would ask another node
    for (let i = 0; ; i++) {
      const r = await again(() => realFetch(RPC, { ...init, signal: AbortSignal.timeout(180_000) }), 'the fork');
      const text = await r.text();
      if (i < 8 && /"error"/.test(text) && /unavailable|temporar|timed? ?out|rate|try again|too many|capacity|reset/i.test(text)) { await sleep(800 * (i + 1)); continue; }
      return new Response(text, { status: r.status, headers: { 'content-type': 'application/json' } });
    }
  }
  return again(() => realFetch(url, init), new URL(u).host);
};

// the simulated Bitcoin (its module loads the note validator under jsdom and installs an offline fetch, replaced just after)
const sim = await import('./lib/btc-sim.mjs');
const chainSim = await import('./lib/chain-sim.mjs');
globalThis.fetch = routed;

// the wallet keeps its scan checkpoints in localStorage: a Map stands in for it, so each read after the first continues from the last
globalThis.localStorage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; })();
const { secp, sha256, keccak_256, hmac } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { setActiveNetwork } = await import('../dapp/confidential-deployments.js');
setActiveNetwork('mainnet');
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: (u, o) => globalThis.fetch(u, o), network: 'mainnet' });
const { makeFastBridgeEvm } = await import('../dapp/fastbridge-evm.js');
const { makeBitcoinLocker } = await import('../dapp/fastbridge-bl.js');
const { makeEthereumLocker } = await import('../dapp/fastbridge-el.js');
const { makeBtcWallet } = await import('../dapp/bitcoin-taproot-wallet.js');
const { makeAdaptorBtcTx, tacitKit } = await import('../dapp/adaptor-btc-tx.js');
const { bigintToBytes32 } = await import('../dapp/bulletproofs.js');
const { wrapEth } = await import('../dapp/teth/wrap.js');
const hmacSha256 = (key, msg) => hmac(sha256, key, msg);

const lpPriv = crypto.getRandomValues(new Uint8Array(32));
ux.identity(lpPriv);
globalThis.T = { ux };
const wallet = {
  sendTx: async ({ to, data, value, from }) => rpcA('eth_sendTransaction', [{ from, to, data, value: hex(value || 0), gas: '0x7A1200' }]),
  receipt: async (h) => { for (let i = 0; i < 100; i++) { const rc = await rpcA('eth_getTransactionReceipt', [h]); if (rc) return rc; await sleep(100); } throw new Error('no receipt'); },
};

// ── the LP's inventory: 0.04 ETH made private (one note), so that each swap of 0.01 ETH needs a note cut to size ──
const UNITS = 4_000_000n, AMOUNT = 1_000_000n;
const t0 = Date.now(), t00 = t0;
await wrapEth({ priv: () => lpPriv, wei: UNITS * E10, tip: 60000000000000n, to: SETTLER, from: FROM, wallet, ux });
const held0 = ((await ux.balance(lpPriv)).byAsset[ETH_ID] || { notes: [] }).notes;
ok(held0.length === 1 && BigInt(held0[0].value) === UNITS, `the LP holds one private ETH note of ${UNITS} units, found from its key alone (${Math.round((Date.now() - t0) / 1000)} s)`);

// ── time: the simulated Bitcoin and the fork share one clock ──
const headTs = async () => parseInt((await rpcA('eth_getBlockByNumber', ['latest', false])).timestamp, 16);
const clock = chainSim.makeClock(await headTs());
async function syncChain() {
  const ts = await headTs();
  if (clock.now() > ts) { await rpcA('evm_setNextBlockTimestamp', [clock.now()]); await rpcA('evm_mine'); } else if (ts > clock.now()) clock.advance(ts - clock.now());
}

function world(tag, { value = AMOUNT } = {}) {
  const btc = chainSim.makeBitcoinSim(clock);
  const kit = tacitKit(sim.tacit);
  const wal = (name) => makeBtcWallet({ priv: bigintToBytes32(sim.scalar(`${tag}/${name}/btc-wallet`)), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });
  const uW = wal('user'), lW = wal('lp');
  const r0 = sim.scalar(`${tag}/note`);
  const etch = sim.etchNote({ ticker: 'TP', value, r: r0, script: uW.prims.p2wpkhScript(uW.wallet.pub), signerD: sim.scalar(`${tag}/etcher`) });
  btc.addConfirmed(etch);
  const note = { txid: etch.txid, vout: 0, value: 546, amount: value, blinding: r0 };
  let coinN = 0;
  const sats = () => [{ txid: Buffer.from(chainSim.sha256(sim.te(`${tag}/coin/${coinN++}`))).toString('hex'), vout: 0, value: 200_000 }];
  const uBtc = btc.adapter({ prims: uW.prims, builder: makeAdaptorBtcTx({ prims: uW.prims, kit }), sats });
  const lBtc = btc.adapter({ prims: lW.prims, builder: makeAdaptorBtcTx({ prims: lW.prims, kit }), sats });

  const userPriv = crypto.getRandomValues(new Uint8Array(32));
  ux.identity(userPriv);
  const userSeed = chainSim.sha256(userPriv), lpSeed = chainSim.sha256(new Uint8Array([...lpPriv, 1]));
  const evmU = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256, walletPriv: userPriv, seed: userSeed, asset: ETH_ID, poolAddress: POOL });
  const evmL = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256, walletPriv: lpPriv, seed: lpSeed, asset: ETH_ID, poolAddress: POOL });

  const quote = { id: 'q1', btcAsset: Buffer.from(etch.asset).toString('hex'), btcValue: value, evmAsset: ETH_ID, evmAmount: AMOUNT, validUntil: clock.now() + 1e6 };
  const offers = new Map();
  const w = { btc, etch, note, uW, lW, userPriv, quote, userStore: memStore(), lpStore: memStore(), userOnline: true, lpOnline: true };
  const toLp = { sendOffer: async (msg) => w.lp.receive(msg), getEvmOffer: async (id) => offers.get(id) || null };
  const toUser = { publishEvmOffer: async (id, o) => { offers.set(id, o); } };
  w.offers = offers;
  w.user = makeBitcoinLocker({
    seed: userSeed, now: clock.now, store: w.userStore, btc: uBtc, counter: toLp,
    policy: { csvBlocks: 144, minClaimSecs: 3600, offerWaitSecs: 2 * 3600, maxEvmWindowSecs: 6 * 3600 },
    evm: { now: evmU.now, lockPosition: evmU.lockPosition, recipient: evmU.recipient, claimOp: evmU.claimOp, submit: evmU.submit, claimStatus: evmU.claimStatus },
  });
  w.lp = makeEthereumLocker({
    seed: lpSeed, now: clock.now, store: w.lpStore, quotes: { get: async (id) => (id === quote.id ? quote : null) }, btc: lBtc, counter: toUser,
    policy: { minCsv: 72, minConfsFor: () => 1, evmWindowSecs: 4 * 3600, minClaimSecs: 3600, claimSlackSecs: 7200, minAmount: 1000, maxAmount: 100_000_000, roundSecs: 600 },
    evm: { now: evmL.now, lockNullifier: evmL.lockNullifier, prepare: evmL.prepare, lockOp: evmL.lockOp, refundOp: evmL.refundOp, submit: evmL.submit, jobStatus: evmL.jobStatus, lockPosition: evmL.lockPosition, findClaim: evmL.findClaim, refundKey: evmL.refundKey },
  });
  w.evmU = evmU; w.evmL = evmL;
  w.start = () => w.user.start({ asset: etch.asset, amount: value, notes: [note], counterClaimPub: lW.wallet.pub, evmAsset: ETH_ID, evmAmount: AMOUNT, quoteId: quote.id });
  w.rec = async (which) => (await w[which + 'Store'].list())[0];
  let ticks = 0;
  const seen = { user: null, lp: null };
  const note_ = async (which) => { const r = await w.rec(which); const p = r && `${r.phase}${r.lastError ? ' (' + String(r.lastError).slice(0, 100) + ')' : ''}`; if (p !== seen[which]) { seen[which] = p; console.log(`  ..   ${tag} ${which}: ${p}  [${Math.round((Date.now() - t00) / 1000)} s]`); } };
  w.run = async (until, max = 900) => {
    for (let i = 0; i < max; i++) {
      if (await until()) return i;
      await syncChain();
      if (w.userOnline) for (const r of await w.userStore.list()) await w.user.step(r);
      if (w.lpOnline) for (const r of await w.lpStore.list()) await w.lp.step(r);
      await note_('user'); await note_('lp');
      await sleep(250);
      clock.advance(20); ticks++;
      if (ticks % 30 === 0) btc.mine(1, { advance: false });
    }
    throw new Error(`did not finish: user ${JSON.stringify(await w.rec('user')).slice(0, 500)} lp ${JSON.stringify(await w.rec('lp')).slice(0, 500)} log ${log.slice(-4).join(' | ')}`);
  };
  return w;
}
function memStore() {
  const m = new Map();
  return { get: async (id) => (m.has(id) ? JSON.parse(m.get(id)) : null), put: async (r) => { m.set(r.id, JSON.stringify(r)); }, list: async () => [...m.values()].map((v) => JSON.parse(v)) };
}
const heldOf = async (priv) => ((await ux.balance(priv)).byAsset[ETH_ID] || { notes: [] }).notes.map((x) => BigInt(x.value));

// ── A. the swap: the LP cuts the note to size, locks it in the live pool, the user claims, the LP reads t from the settle and takes the Bitcoin ──
{
  const w = world('A');
  const t1 = Date.now();
  ok((await w.evmL.available()) === UNITS - (await w.evmL.cutReserve(UNITS)), `the LP's lockable balance is what its wallet holds (${UNITS} units), less the relay's fee for a cut`);
  await w.start();
  await w.run(async () => (await w.rec('user'))?.phase === 'done' && (await w.rec('lp'))?.phase === 'done');
  const lp = await w.rec('lp'), user = await w.rec('user');
  ok(!!lp.take && !!(await w.btc.resolveNote(lp.take.txid, 0)), `the LP took the Bitcoin lock and the validator takes its note (${Math.round((Date.now() - t1) / 1000)} s)`);
  ok(user.takenBy === lp.take.txid, 'the user sees the lock spent by the LP\'s take');
  const pos = await w.evmL.lockPosition(lp.lock.lockLeaf);
  ok(!!pos, 'the lock is in the live pool\'s lock set, which the wallet rebuilt and checked against the pool\'s own count and root');
  const zs = await w.evmL.findClaim(lp.lock.lockNu, { sinceSecs: lp.created });
  ok(Array.isArray(zs) && zs.length === 1, 'the claim\'s s was read from the real settle\'s public values');
  const mine = await heldOf(w.userPriv);
  ok(mine.length === 1 && mine[0] === AMOUNT, `the user's private ETH note of ${AMOUNT} units is found again from its key and the chain alone (${mine.join(',')})`);
  const lpNotes = await heldOf(lpPriv);
  ok(!lpNotes.includes(UNITS) && lpNotes.some((v) => v > 0n), `the LP's big note was cut: ${lpNotes.join(',')}`);
  ok((await w.evmL.available()) === lpNotes.reduce((a, b) => a + b, 0n) - (lpNotes.length ? await w.evmL.cutReserve(1n) : 0n), 'available() follows the wallet once the lock has left it');
  ok(log.filter((l) => /^adaptor/.test(l)).length === 2, `the guest ran the lock and the claim (${log.filter((l) => /^adaptor/.test(l)).map((l) => l.split(' ')[0]).join(', ')})`);
  ok(!jobsSeen.some((j) => j.error), 'no relayed job failed');
}

// ── B. the user goes silent after the LP has locked: after the deadline the LP refunds its note, and the pool takes it ──
{
  const w = world('B');
  const seenBefore = jobsSeen.length;
  await w.start();
  await w.run(async () => (await w.rec('lp'))?.phase === 'offered');
  w.userOnline = false;
  const lp0 = await w.rec('lp');
  const before = (await heldOf(lpPriv)).reduce((a, b) => a + b, 0n);
  clock.advance(lp0.deadline - clock.now() + 700);
  await w.run(async () => (await w.rec('lp'))?.phase === 'refunded');
  const lp = await w.rec('lp');
  const zs = await w.evmL.findClaim(lp.lock.lockNu, { sinceSecs: lp.created });
  ok(Array.isArray(zs) && zs.length === 0, 'the lock is spent, by a refund (no s was ever committed)');
  const after = (await heldOf(lpPriv)).reduce((a, b) => a + b, 0n);
  ok(after > before && after <= before + AMOUNT, `the refunded note is back in the LP's balance, less the relay's fee (${before} -> ${after} units)`);
  // the user's late claim would be refused by the pool: its Bitcoin comes back on the timelock instead
  w.userOnline = true;
  await w.run(async () => (await w.rec('user'))?.phase === 'refund-wait');
  ok(!jobsSeen.slice(seenBefore).some((j) => j.type === 'adaptorclaim'), 'the returning user builds no claim: its Bitcoin comes back on the timelock');
}

console.log(`\nfork reads: ${proxy.stats.hits} from the cache, ${proxy.stats.misses} asked of the upstream, ${proxy.stats.retries} asked again`);
console.log(`\n${n} ok, ${fails} failed`);
console.log(log.map((l) => '  ' + l).join('\n'));
process.exit(fails ? 1 : 0);
