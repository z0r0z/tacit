#!/usr/bin/env node
// The private swap's steps through the Tacit pool (dapp/swap/private.js: make the ETH private, cut a note to size, route it, exit it, send it
// on) on a mainnet fork, with the page's own code, the real pool module (dapp/confidential-pool-ux.js) and the LIVE pool, router and AMM pools.
// What the relay does is stood in for by a relay here that is the worker's own job queue (worker/src/confidential-settle.js: the admission, the
// exit recipe's normalisation, the status the page reads) with a box that does every step the real one does but prove: it builds the guest's
// input from the claimed job (dapp/sp1-stdin.js, the module the relay's own proving uses), runs the pinned SETTLE GUEST (the committed
// elf/cxfer-guest, the program the live pool's immutable vkey names) in SP1 execute mode over it, and sends pool.settle() with those public
// values, and the router's activateExit after an unwrap that carries an exit recipe. The pool's SP1 verifier alone is replaced (by code that
// accepts any proof): everything the pool checks of the public values (roots, nullifiers, deadlines, fees, memos, amounts) is the real
// contract's. A guest that rejects an op, or a pool that reverts the settle, fails here as it would live.
//
//   node tests/swap-private-relay-fork.mjs        (FORK=<rpc url>; EXEC=<the exec-stdin binary>, built from tests/exec-stdin when not given; CARGO_TARGET_DIR is passed to that build)
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
if (!existsSync(EXEC)) {
  console.log('building tests/exec-stdin (the settle guest in execute mode)...');
  const b = spawnSync('cargo', ['build', '--release', '--offline', '--manifest-path', join(ROOT, 'tests/exec-stdin/Cargo.toml')], { env: { ...process.env, GUEST_ELF: ELF }, stdio: 'inherit' });
  if (b.status !== 0 || !existsSync(EXEC)) { console.log('skip - the exec-stdin binary could not be built (EXEC=<binary>, or see tests/exec-stdin/Cargo.toml)'); process.exit(0); }
}
const elfSha = createHash('sha256').update(readFileSync(ELF)).digest('hex');
if (elfSha !== 'f7bc327d232ec8d1f693d5a44024c1ee732dc42196d079c5be5e3f3668b922c7') throw new Error(`the guest ELF is not the pinned one (${elfSha})`);

// the page's own modules import by site path; the key sheet, the pool-module cache and the activity journal are the page's alone
const STUBS = {
  '/trade/key.js': `export class Cancelled extends Error {}
    export function makeKeySession() { const s = { open: false, get unlocked() { return s.open; }, get key() { return s.open ? { pubHex: globalThis.T.pubHex } : null; }, priv: () => globalThis.T.priv, lock() { s.open = false; } }; return s; }
    export async function signInSheet(s) { s.open = true; }`,
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
const { encodeFunctionData, parseAbi, keccak256, decodeErrorResult } = require('viem');
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co';
const PORT = 25300 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`, RPORT = PORT + 400, RELAY = `http://127.0.0.1:${RPORT}`;
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992';
const SP1_VERIFIER = '0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2';
const SETTLER = '0x00000000000000000000000000000000005e771e', FROM = '0x00000000000000000000000000000000000dE921';
const ETH_ID = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', ZERO = '0x0000000000000000000000000000000000000000';
const E10 = 10n ** 10n;
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (v) => '0x' + BigInt(v).toString(16);
const rpcA = async (method, params = []) => {
  const j = await (await realFetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { data: j.error.data });
  return j.result;
};
const realFetch = globalThis.fetch;

const procs = [], tmp = mkdtempSync(join(tmpdir(), 'swap-private-relay-'));
const stop = () => { for (const p of procs) p.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); };
process.on('exit', stop);
const head = BigInt((await (await realFetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) })).json()).result) - 2n;
procs.push(spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' }));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
for (const a of [SETTLER, FROM]) { await rpcA('anvil_impersonateAccount', [a]); await rpcA('anvil_setBalance', [a, hex(100n * 10n ** 18n)]); }
{
  const pin = JSON.parse(readFileSync(join(ROOT, 'contracts/sp1/confidential/elf-vkey-pin.json'), 'utf8'));
  ok((await rpcA('eth_getCode', [POOL, 'latest'])).toLowerCase().includes(pin.program_vkey.slice(2).toLowerCase()) && pin.elf_sha256 === elfSha, `the guest run here is the one the live pool's immutable vkey names (${pin.program_vkey.slice(0, 14)}…)`);
}
await rpcA('anvil_setCode', [SP1_VERIFIER, '0x00']);                         // accepts any proof: the guest's public values are what the pool then checks

// ── the relay ──
const { stdinFor } = await import('../dapp/sp1-stdin.js');
const { ROUTER_EXIT_ABI, recipeArgs, exitCheck, activationCover } = await import('../worker-relay/src/lib/exit-activate.js');
const poolAbi = (() => { try { return JSON.parse(readFileSync('/Users/z/tacit/contracts/out/ConfidentialPool.sol/ConfidentialPool.json', 'utf8')).abi; } catch { return []; } })();
const why = (e) => { try { return decodeErrorResult({ abi: poolAbi, data: e.data }).errorName; } catch { return String(e.message || e).slice(0, 160) + (e.data ? ` ${String(e.data).slice(0, 74)}` : ''); } };
const { makeConfidentialSettler } = await import('../worker/src/confidential-settle.js');
const store = (() => { const m = new Map(); let pending = []; return { getPending: async () => pending.slice(), putPending: async (ids) => { pending = ids.slice(); }, getJob: async (id) => (m.has(id) ? JSON.parse(JSON.stringify(m.get(id))) : null), putJob: async (id, j) => { m.set(id, JSON.parse(JSON.stringify(j))); } }; })();
const settler = makeConfidentialSettler({ storage: store, hash: (str) => keccak256(`0x${Buffer.from(str).toString('hex')}`), sleep: async () => {} });
const jobs = new Map(); let queue = Promise.resolve();   // what the box saw of each job, for the checks below
const log = [];
async function send(from, to, data, value = '0x0') {
  let gas = 3_000_000n;
  try { gas = (BigInt(await rpcA('eth_estimateGas', [{ from, to, data, value }])) * 13n) / 10n; } catch (e) { throw Object.assign(new Error(`the pool would revert: ${why(e)}`), { data: e.data }); }
  const h = await rpcA('eth_sendTransaction', [{ from, to, data, value, gas: hex(gas) }]);
  for (let i = 0; i < 1200; i++) { const rc = await rpcA('eth_getTransactionReceipt', [h]); if (rc) { if (rc.status !== '0x1') throw new Error(`reverted ${h}`); return { hash: h, rc }; } await sleep(100); }   // a cold fork reads the pool's state from the node first: the first settle can take a minute
  throw new Error('no receipt');
}
// not spawnSync: the relay's server keeps answering the page's status polls while the guest runs
const execGuest = (env) => new Promise((resolve) => {
  const c = spawn(EXEC, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
  c.on('close', (status) => resolve({ status, stdout, stderr }));
});
async function runJob(claimed) {
  const { jobId: id, type, op, memos: jm, exit } = claimed;
  const body = { type, op, memos: jm, exit };
  const job = { jobId: id, type };
  jobs.set(id, job);
  try {
    if (process.env.MUTATE === 'unwrap-fee' && body.type === 'unwrap') body.op.fee = String(BigInt(body.op.fee) + 1n);       // a check that the guest and pool would refuse a changed op (not part of a normal run)
    const memos = body.memos || [];
    const memoHashes = memos.map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`));
    const stdin = stdinFor(body.type, { ...body.op, memoHashes });
    const f = join(tmp, `${id.slice(2, 14)}.stdin`), out = join(tmp, `${id.slice(2, 14)}.pv`);
    writeFileSync(f, stdin);
    const t = Date.now();
    const r = await execGuest({ ...process.env, STDIN: f, OUT: out });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('EXECUTE_OK')) || '';
    job.exec = `${body.type}: ${line} in ${((Date.now() - t) / 1000).toFixed(1)} s`;
    if (r.status !== 0 || !existsSync(out)) throw new Error(`the settle guest rejected the op: ${((r.stderr || '') + (r.stdout || '')).split('\n').filter((l) => /panick|assert|error|failed/i.test(l)).slice(0, 3).join(' | ').slice(0, 300)}`);
    const pv = readFileSync(out, 'utf8').trim();
    log.push(job.exec);
    const data = encodeFunctionData({ abi: parseAbi(['function settle(bytes publicValues, bytes proof, bytes[] memos)']), functionName: 'settle', args: [`0x${pv}`, '0x', memos.map((m) => (m.startsWith('0x') ? m : `0x${m}`))] });
    const s = await send(SETTLER, POOL, data);
    job.txHash = s.hash; job.gasUsed = BigInt(s.rc.gasUsed);
    await settler.ackJob(id, { txHash: s.hash });
    if (body.exit) {
      // the relay's own pre-flight (worker-relay/src/settle-relay.js activateRelayedExit), with its default settings: the recipe is this exit's, the fee covers the settle plus the activation
      const refuse = async (reason) => { job.activation = 'failed'; job.activateError = reason; await settler.ackJob(id, { activateError: reason }); };
      try {
        const recipe = recipeArgs(body.exit), act = encodeFunctionData({ abi: ROUTER_EXIT_ABI, functionName: 'activateExit', args: [recipe] });
        const escrow = '0x' + String(await rpcA('eth_call', [{ to: ROUTER, data: encodeFunctionData({ abi: ROUTER_EXIT_ABI, functionName: 'escrowAddressFor', args: [recipe] }) }, 'latest'])).slice(-40);
        const check = exitCheck({ job: { type: body.type, op: body.op, exit: body.exit }, escrow, nowSecs: Math.floor(Date.now() / 1000), ethAssetId: ETH_ID });
        if (!check.ok) await refuse(check.reason);
        else {
          const gasEstimate = BigInt(await rpcA('eth_estimateGas', [{ from: SETTLER, to: ROUTER, data: act }])), gasPriceWei = BigInt(await rpcA('eth_gasPrice'));
          const cover = activationCover({ job: { op: body.op }, settleCostWei: BigInt(s.rc.gasUsed) * BigInt(s.rc.effectiveGasPrice), gasEstimate, gasPriceWei, weiPerUnit: E10, gasCap: 1_500_000n, marginBps: 0n });
          job.cover = { fee: String(cover.feeWei ?? ''), cost: String(cover.cost ?? ''), gasPriceWei: String(gasPriceWei), gasEstimate: String(gasEstimate) };
          if (!cover.ok) await refuse(cover.reason);
          else {
            await rpcA('eth_call', [{ from: SETTLER, to: ROUTER, data: act, gas: hex(cover.gas) }, 'latest']);
            const h = await rpcA('eth_sendTransaction', [{ from: SETTLER, to: ROUTER, data: act, gas: hex(cover.gas) }]);
            for (let i = 0; i < 1200; i++) { const rc = await rpcA('eth_getTransactionReceipt', [h]); if (rc) break; await sleep(100); }
            job.activation = 'done'; job.activateTx = h;
            await settler.ackJob(id, { activateTx: h });
          }
        }
      } catch (e) { await refuse(`activation failed: ${String(e.message || e).slice(0, 180)}`); }
    }
  } catch (e) { job.error = String(e.message || e).slice(0, 400); log.push(`${type} failed: ${job.error}`); await settler.ackJob(id, { error: job.error }); }
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
    queue = queue.then(async () => { const claimed = await settler.nextJob(); if (claimed) await runJob(claimed); });
    return json(200, { ok: true, ...r });
  }
  if (u.pathname === '/confidential/status') { const j = await settler.jobStatus(u.searchParams.get('id')); return j ? json(200, j) : json(404, { error: 'unknown' }); }
  return json(404, { error: 'no such path here' });
}).listen(RPORT);
server.keepAliveTimeout = 120_000;
procs.push({ kill: () => server.close() });

// the page's reads: every node goes to the fork, the relay's API to the relay above
// a socket dropped or a node that did not answer is asked again, as the page's wallet would be; what still fails is named in the report
const again = async (go, what) => { for (let i = 0; ; i++) { try { return await go(); } catch (e) { if (i >= 3) { log.push(`fetch to ${what} failed: ${e.cause?.code || e.message}`); throw e; } await sleep(700 * (i + 1)); } } };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/^https:\/\/api\.tacit\.finance\/confidential\//.test(u)) return realFetch(u.replace('https://api.tacit.finance', RELAY), init);
  if (/^https:\/\/api\.tacit\.finance\//.test(u)) return new Response('{}', { status: 404 });
  if (/^https?:\/\/[^/]*(rpc|node|gateway|eth\.|llama|ankr|drpc|merkle|infura|alchemy|cloudflare|1rpc)/i.test(u) && init?.method === 'POST') return again(() => realFetch(RPC, { ...init, signal: AbortSignal.timeout(180_000) }), 'the fork');   // the page's own ten-second limit is for a real node: a cold fork reads the state it is asked for from its upstream first
  return again(() => realFetch(url, init), new URL(u).host);
};

const { secp, sha256, keccak_256, hmac } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { setActiveNetwork } = await import('../dapp/confidential-deployments.js');
setActiveNetwork('mainnet');
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: (u, o) => globalThis.fetch(u, o), network: 'mainnet' });
const priv = crypto.getRandomValues(new Uint8Array(32));
const id = ux.identity(priv);
globalThis.T = { ux, priv, pubHex: id.pubHex };
const { makePrivate } = await import('../dapp/swap/private.js');
const P = makePrivate({ getUx: async () => ux });

// the wallet the page hands the deposit to: an unlocked fork account
const wallet = {
  sendTx: async ({ to, data, value, from }) => rpcA('eth_sendTransaction', [{ from, to, data, value: hex(value || 0), gas: '0x7A1200' }]),
  receipt: async (h) => { for (let i = 0; i < 100; i++) { const rc = await rpcA('eth_getTransactionReceipt', [h]); if (rc) return rc; await sleep(100); } throw new Error('no receipt'); },
};
const steps = [];
const say = (s) => steps.push(s);
const t0 = Date.now();

// ── 1. ETH made private: the deposit the wallet sends, the wrap the guest checks, the pool's settle ──
const wei = 10n ** 17n, units = wei / E10;
const made = await P.swap({ wallet: true, wei, units, path: [], label: 'Shield' }, { wallet, from: FROM, say }).catch((e) => ({ error: e }));
ok(!made.error && made.made === units, `ETH is made private: the wrap is checked by the settle guest and settled by the pool (${made.error ? made.error.message : `${made.made} units`}; ${log.join('; ')})`);
const held = await P.read(true);
const tNotes = held?.byAsset?.[ETH_ID]?.notes || [];
ok(tNotes.length === 1 && BigInt(tNotes[0].value) === units, `the key's tETH balance is that note, ${tNotes.map((x) => x.value).join(',')} units (${Math.round((Date.now() - t0) / 1000)} s)`);

// ── what the card computes for each plan, from the same pool reads ──
const idOf = (tk) => String(ux.assetByTicker[tk].assetId).toLowerCase();
const TAC_ID = idOf('cTAC');
const quotePath = async (cur, next, amt) => {
  const tiers = await Promise.all([30, 5, 100, 1].map((feeBps) => ux.quoteRoute({ asset0: cur, amountIn: amt, path: [{ assetNext: next, feeBps }] }).then((r) => (r && r.amountOut > 0n ? r : null), () => null)));
  return tiers.filter(Boolean).reduce((a, c) => (!a || c.amountOut > a.amountOut ? c : a), null);
};
const routePlan = async (u, extra = {}) => {
  const fee = BigInt(await ux.quoteOpFee('cETH', 'route'));
  const best = await quotePath(ETH_ID, TAC_ID, u - fee);
  if (!best) throw new Error('no tETH/cTAC price on the pool');
  return { plan: { wallet: false, asset: ETH_ID, units: u, ticker: 'cETH', fee, path: [{ assetNext: TAC_ID, feeBps: Number(best.hops[0].feeBps) }], minOut: (best.amountOut * 99n) / 100n, label: 'Swap tETH for cTAC privately', ...extra }, best };
};
const notesOf = async (asset) => ((await P.read(true))?.byAsset?.[asset]?.notes || []).map((x) => BigInt(x.value));

// ── 2. a private swap from the balance: no note is the amount, so the larger note is spent in one route through the pool's AMM and the rest comes back as change ──
const u2 = 2_000_000n;
{
  const { plan, best } = await routePlan(u2);
  const tac0 = (await notesOf(TAC_ID)).length;
  const r = await P.swap(plan, { say }).catch((e) => ({ error: e }));
  ok(!r.error, `a private swap from the balance goes through (${r.error ? r.error.message : `${steps.slice(-4).join(' > ')}; quote ${best.amountOut} cTAC, min ${plan.minOut}`})`);
  const tac = await notesOf(TAC_ID), eth = await notesOf(ETH_ID);
  ok(tac.length === tac0 + 1 && tac.some((v) => v >= plan.minOut), `a cTAC note of at least the least asked is in the balance (${tac.join(',')})`);
  ok(!eth.includes(u2) && eth.reduce((a, b) => a + b, 0n) > 0n && eth.reduce((a, b) => a + b, 0n) < units - u2 + 1n, `the tETH left is the change, less the fees (${eth.join(',')})`);
  ok(!steps.includes('split') && steps.includes('route'), `the larger note covers it, so no note is cut first: one route, the rest back as change (${steps.join(' > ')})`);
}

// ── 3. out of the pool as ETH: a note cut to size, then an unwrap to the address ──
const R = await import('../dapp/swap/route.js');
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DEST_ETH = '0x00000000000000000000000000000000000De583', DEST_TOK = '0x00000000000000000000000000000000000De584';
const ethBal = async (a) => BigInt(await rpcA('eth_getBalance', [a, 'latest']));
const tokBal = async (tok, who) => BigInt(await rpcA('eth_call', [{ to: tok, data: '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));
const stepsAt = () => steps.length;
const retried = (q) => async (w) => { for (let i = 0; i < 4; i++) { const r = await q(w).catch(() => null); if (r) return r; await sleep(1500); } return null; };    // the upstream node answered nothing: asked again
const quoted = async (q, w) => (await q(w)) || Promise.reject(new Error('zQuoter gave no price for the sale'));
{
  const u = 500_000n, xmin = BigInt(await ux.quoteOpFee('cETH', 'unwrap')), { net } = ux.quoteUnwrapFee(u, 'cETH', { minFee: xmin });
  const plan = { asset: ETH_ID, units: u, ticker: 'cETH', fee: 0n, eth: ETH_ID, path: [], minOut: u, label: 'Swap tETH for ETH', out: { token: null, to: DEST_ETH, minFee: xmin, min: net * E10, wei: net * E10 } };
  const k = stepsAt();
  const r = await P.swapOut(plan, { say }).catch((e) => ({ error: e }));
  ok(!r.error && r.txHash, `a tETH note leaves the pool as ETH (${r.error ? r.error.message : steps.slice(k).join(' > ')})`);
  ok((await ethBal(DEST_ETH)) === net * E10, `the address got exactly the note less the relay's fee: ${(await ethBal(DEST_ETH))} wei (expected ${net * E10})`);
}

// ── 4. out of the pool as a token: the unwrap pays an exit recipe's escrow, the relay activates it, one zRouter call sells the ETH ──
{
  const u = 500_000n, gp = BigInt(await rpcA('eth_gasPrice')), xmin = BigInt(await ux.quoteOpFee('cETH', 'unwrap')) + ((450000n * gp * 4n) / 3n + E10 - 1n) / E10;
  const { net } = ux.quoteUnwrapFee(u, 'cETH', { minFee: xmin }), wei2 = net * E10;
  const UP = process.env.QUOTE_RPC || 'https://mainnet.gateway.tenderly.co', BLOCK = hex(head);
  const upCall = async (to, data, _b, o = {}, tries = 4) => { try { const j = await (await realFetch(UP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data, ...(o.gas ? { gas: o.gas } : {}) }, BLOCK] }) })).json(); if (j.error) throw new Error(j.error.message); return j.result; } catch (e) { if (tries <= 1) throw e; await sleep(1500); return upCall(to, data, _b, o, tries - 1); } };
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 1800);
  const quote = retried((w) => R.quoteEthToToken({ ethCall: upCall, to: DEST_TOK, tokenOut: USDC, amount: w, slippageBps: 100, deadline: deadline() }));
  const sale0 = await quoted(quote, wei2);
  const plan = { asset: ETH_ID, units: u, ticker: 'cETH', fee: 0n, eth: ETH_ID, path: [], minOut: u, label: 'Swap tETH for USDC', out: { token: USDC, to: DEST_TOK, minFee: xmin, min: sale0.amountLimit, wei: wei2, quote } };
  const k = stepsAt(), u0 = await tokBal(USDC, DEST_TOK);
  const r = await P.swapOut(plan, { say }).catch((e) => ({ error: e }));
  ok(!r.error && r.txHash, `a tETH note leaves the pool as USDC through an exit recipe (${r.error ? `${r.error.message} ${JSON.stringify(r.error.stuck || {}).slice(0, 200)}` : steps.slice(k).join(' > ')})`);
  const got = (await tokBal(USDC, DEST_TOK)) - u0;
  ok(got >= sale0.amountLimit, `the address got ${Number(got) / 1e6} USDC, at least the ${Number(sale0.amountLimit) / 1e6} shown`);
  ok(r.settleTx && r.txHash && r.settleTx !== r.txHash, 'the settle and the relay\'s activation are two transactions');
  const rc = r.txHash ? await rpcA('eth_getTransactionReceipt', [r.txHash]) : null;
  ok(rc?.to?.toLowerCase() === ROUTER.toLowerCase(), 'the activation was sent to the router');
}

// ── 4b. gas rises past the exit's fee: the relay settles it and then refuses to run the swap (the fee cannot pay for both), the page says so and keeps
//        the recipe, and a wallet's own activateExit runs the swap and pays the address ──
{
  const u = 300_000n, DEST2 = '0x00000000000000000000000000000000000De585', xmin = BigInt(await ux.quoteOpFee('cETH', 'unwrap'));
  const { net } = ux.quoteUnwrapFee(u, 'cETH', { minFee: xmin }), wei2 = net * E10;
  const UP = process.env.QUOTE_RPC || 'https://mainnet.gateway.tenderly.co', BLOCK = hex(head);
  const upCall = async (to, data, _b, o = {}, tries = 4) => { try { const j = await (await realFetch(UP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data, ...(o.gas ? { gas: o.gas } : {}) }, BLOCK] }) })).json(); if (j.error) throw new Error(j.error.message); return j.result; } catch (e) { if (tries <= 1) throw e; await sleep(1500); return upCall(to, data, _b, o, tries - 1); } };
  const quote = retried((w) => R.quoteEthToToken({ ethCall: upCall, to: DEST2, tokenOut: USDC, amount: w, slippageBps: 100, deadline: BigInt(Math.floor(Date.now() / 1000) + 1800) }));
  const sale0 = await quoted(quote, wei2);
  const plan = { asset: ETH_ID, units: u, ticker: 'cETH', fee: 0n, eth: ETH_ID, path: [], minOut: u, label: 'Swap tETH for USDC', out: { token: USDC, to: DEST2, minFee: xmin, min: sale0.amountLimit, wei: wei2, quote } };
  // the fee was priced at today's gas; before the relay sends, gas rises twenty-fold (the page's margin is a third)
  await rpcA('anvil_setNextBlockBaseFeePerGas', [hex(40n * 10n ** 9n)]); await rpcA('evm_mine');
  const r = await P.swapOut(plan, { say }).catch((e) => ({ error: e }));
  await rpcA('anvil_setNextBlockBaseFeePerGas', [hex(10n ** 9n)]); await rpcA('evm_mine');
  const job = [...jobs.values()].filter((j) => j.type === 'unwrap').pop();   // what the box saw of the last exit
  ok(r.error?.stuck && job?.activation === 'failed', `a gas rise past the exit's fee: the relay's own rule refuses to activate it, and the page keeps the recipe (${job?.activateError || r.error?.message || 'no refusal'}; ${JSON.stringify(job?.cover || {})})`);
  if (r.error?.stuck) {
    const u0 = await tokBal(USDC, DEST2);
    const { router, activate } = await P.exitCalls(r.error.stuck.recipe);
    const h = await rpcA('eth_sendTransaction', [{ from: FROM, to: router, data: activate, gas: '0x2DC6C0' }]);
    const rc = await wallet.receipt(h);
    const got = (await tokBal(USDC, DEST2)) - u0;
    ok(rc.status === '0x1' && got >= sale0.amountLimit, `a wallet's own activateExit then runs the swap: ${Number(got) / 1e6} USDC reached the address (at least ${Number(sale0.amountLimit) / 1e6})`);
  }
}

// ── 5. a private swap paid to another Tacit address: routed, then the note locked for them (a stealth lock they claim) ──
{
  const priv2 = crypto.getRandomValues(new Uint8Array(32)), pub2 = ux.identity(priv2).pubHex;
  ux.identity(priv);                                                          // the pool module keeps keys by public key: the first key is still the one signing
  const u = 1_000_000n, { plan } = await routePlan(u, { sendTo: { pubHex: pub2 }, outTicker: 'cTAC' });
  const k = stepsAt();
  const r = await P.swap(plan, { say }).catch((e) => ({ error: e }));
  ok(!r.error && r.sent, `a private swap is paid to another Tacit address (${r.error ? `${r.error.message}` : steps.slice(k).join(' > ')})`);
  const found = await ux.scanStealthLocks({ walletPriv: priv2 });
  const lock = found.mine.find((m) => BigInt(m.amount) >= plan.minOut);
  ok(!!lock, `the recipient finds the lock with their key alone: ${found.mine.map((m) => m.amount).join(',')} cTAC units (minimum ${plan.minOut})`);
  if (lock) {
    const c = await ux.stealthClaim({ walletPriv: priv2, lockRecord: lock, lockSetRoot: found.lockSetRoot }).catch((e) => ({ error: e }));
    ok(!c.error, `and claims it: the claim passes the settle guest and the pool (${c.error ? c.error.message : 'settled'})`);
    const bal2 = await ux.balance(priv2, { bridge: false });
    ok(BigInt(bal2.byAsset?.[TAC_ID]?.notes?.[0]?.value || 0) === BigInt(lock.amount), `their private balance holds the cTAC note: ${bal2.byAsset?.[TAC_ID]?.notes?.map((x) => x.value).join(',')}`);
  }
  const mine = (await P.read(true)).byAsset?.[TAC_ID]?.notes || [];
  ok(mine.length === 1, 'the sender kept the first swap\'s cTAC note and not the one sent on');
}

if (fails) console.error(log.join('\n'));
console.log(`\n${n} passed, ${fails} failed`);
stop();
process.exit(fails ? 1 : 0);
