#!/usr/bin/env node
// A private swap whose every secret is proved on the holder's own machine in seconds, end to end on a mainnet fork: the pay pool's wallet
// (the standalone bundle, in a real browser, proving its Groth16 in the page) moves private ETH out of the pay pool straight into the key's
// own pending V1 deposit at a wrap index (toV1: one transaction, the pool's withdrawal into a wrap box the router completes). That deposit is
// the staged deposit of dapp/confidential-stage.js: a fresh V1 wallet finds it from the key alone, its wrap-swap (whose program input holds no
// secret) is proved ahead while the amount is on screen, and the press sends it from the open board. The V1 side runs through the worker's
// job queue, the pinned SETTLE GUEST in SP1 execute mode and pool.settle(); only the pool's SP1 verifier is replaced. The pay pool's own
// verifier is the live one: its proofs are real.
//
//   node tests/paypool-press-fork.mjs   (FORK=<rpc url>; FORK_BLOCK=<n>; EXEC=<exec-stdin>; PAY_ARTIFACTS=<dir with transact.wasm and
//                                         transact_final.zkey>, default /Users/z/tacit/dapp/evm-pool; PLAYWRIGHT=<playwright-core>)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
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

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { encodeFunctionData, parseAbi, keccak256, decodeErrorResult } = require('viem');
const FORK = process.env.FORK || 'https://mainnet.gateway.tenderly.co';
const PORT = 25700 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`, RPORT = PORT + 400, RELAY = `http://127.0.0.1:${RPORT}`;
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992', AMM = '0x00000000E36C7EC997CC59DCda9E03673B448119';
const SP1_VERIFIER = '0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2';
const SETTLER = '0x00000000000000000000000000000000005e771e', FROM = '0x00000000000000000000000000000000000dE922';
const TETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
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

const procs = [], tmp = mkdtempSync(join(tmpdir(), 'wrapswap-'));
const stop = () => { for (const p of procs) p.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); };
process.on('exit', stop);
const head = BigInt((await (await realFetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) })).json()).result) - 2n;
procs.push(spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', process.env.FORK_BLOCK || String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit', '--timeout', '900000', '--retries', '20'], { stdio: 'ignore' }));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(200); } }
for (const a of [SETTLER, FROM]) { await rpcA('anvil_impersonateAccount', [a]); await rpcA('anvil_setBalance', [a, hex(100n * 10n ** 18n)]); }
{
  const pin = JSON.parse(readFileSync(join(ROOT, 'contracts/sp1/confidential/elf-vkey-pin.json'), 'utf8'));
  ok((await rpcA('eth_getCode', [POOL, 'latest'])).toLowerCase().includes(pin.program_vkey.slice(2).toLowerCase()) && pin.elf_sha256 === elfSha, `the guest run here is the one the live pool's immutable vkey names (${pin.program_vkey.slice(0, 14)}…)`);
}
await rpcA('anvil_setCode', [SP1_VERIFIER, '0x00']);

// ── the relay: the worker's job queue, the guest in execute mode, pool.settle ──
const { stdinFor } = await import('../dapp/sp1-stdin.js');
const poolAbi = (() => { try { return JSON.parse(readFileSync('/Users/z/tacit/contracts/out/ConfidentialPool.sol/ConfidentialPool.json', 'utf8')).abi; } catch { return []; } })();
const why = (e) => { try { return decodeErrorResult({ abi: poolAbi, data: e.data }).errorName; } catch { return String(e.message || e).slice(0, 160) + (e.data ? ` ${String(e.data).slice(0, 74)}` : ''); } };
const { makeConfidentialSettler } = await import('../worker/src/confidential-settle.js');
const store = (() => { const m = new Map(); let pending = [], open = []; return { getPending: async () => pending.slice(), putPending: async (ids) => { pending = ids.slice(); }, getOpen: async () => open.slice(), putOpen: async (ids) => { open = ids.slice(); }, getJob: async (id) => (m.has(id) ? JSON.parse(JSON.stringify(m.get(id))) : null), putJob: async (id, j) => { m.set(id, JSON.parse(JSON.stringify(j))); } }; })();
// The relay's check of a posted proof: the pool would take it now (the real one also verifies the proof, which the stub verifier here does not).
const settleData = (pv, pf, ms) => encodeFunctionData({ abi: parseAbi(['function settle(bytes publicValues, bytes proof, bytes[] memos)']), functionName: 'settle', args: [pv, pf || '0x', (ms || []).map((m) => (m.startsWith('0x') ? m : `0x${m}`))] });
const verifyPosted = async ({ publicValues, proof, memos: ms }) => { try { await rpcA('eth_call', [{ from: SETTLER, to: POOL, data: settleData(publicValues, proof, ms) }, 'latest']); return { ok: true }; } catch (e) { return { ok: false, error: why(e) }; } };
const settler = makeConfidentialSettler({ storage: store, hash: (str) => keccak256(`0x${Buffer.from(str).toString('hex')}`), sleep: async () => {}, verifyPosted });
const { exitCheck, activationCover, ROUTER_EXIT_ABI, recipeArgs } = await import('../worker-relay/src/lib/exit-activate.js');
let queue = Promise.resolve();
const log = [];
const lastStdin = {};
async function send(from, to, data, value = '0x0') {
  let gas = 3_000_000n;
  try { gas = (BigInt(await rpcA('eth_estimateGas', [{ from, to, data, value }])) * 13n) / 10n; } catch (e) { throw Object.assign(new Error(`it would revert: ${why(e)}`), { data: e.data }); }
  const h = await rpcA('eth_sendTransaction', [{ from, to, data, value, gas: hex(gas) }]);
  for (let i = 0; i < 1200; i++) { const rc = await rpcA('eth_getTransactionReceipt', [h]); if (rc) { if (rc.status !== '0x1') throw new Error(`reverted ${h}`); return { hash: h, rc }; } await sleep(100); }
  throw new Error('no receipt');
}
const execGuest = (env) => new Promise((resolve) => {
  const c = spawn(EXEC, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
  c.on('close', (status) => resolve({ status, stdout, stderr }));
});
async function runJob(job) {
  const { jobId: id, type, op, memos: jm, mode } = job;
  try {
    const ms = jm || [];
    let pv;
    if (mode === 'open') { pv = job.publicValues; log.push(`${type}: sent from the open board, from the proof alone`); }
    else {
      const memoHashes = ms.map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`));
      const f = join(tmp, `${id.slice(2, 14)}.stdin`), out = join(tmp, `${id.slice(2, 14)}.pv`);
      const bytes = stdinFor(type, { ...JSON.parse(JSON.stringify(op)), memoHashes });
      writeFileSync(f, bytes);
      lastStdin[type] = Buffer.from(bytes).toString('hex');
      const t = Date.now(), r = await execGuest({ ...process.env, STDIN: f, OUT: out });
      const line = (r.stdout || '').split('\n').find((l) => l.startsWith('EXECUTE_OK')) || '';
      if (r.status !== 0 || !existsSync(out)) throw new Error(`the settle guest rejected the op: ${((r.stderr || '') + (r.stdout || '')).split('\n').filter((l) => /panick|assert|error|failed/i.test(l)).slice(0, 3).join(' | ').slice(0, 300)}`);
      log.push(`${type}${mode === 'prove' ? ' (prove only)' : ''}: ${line} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
      pv = `0x${readFileSync(out, 'utf8').trim()}`;
      if (mode === 'prove') { await settler.ackJob(id, { publicValues: pv, proof: '0x' }); return; }
    }
    const s = await send(SETTLER, POOL, settleData(pv, '0x', ms));
    await settler.ackJob(id, { txHash: s.hash });
    if (job.exit) await activate(job, s);
  } catch (e) { const m = String(e.message || e).slice(0, 400); log.push(`${type} failed: ${m}`); await settler.ackJob(id, { error: m }); }
}
// The relay's activation of a settled exit's recipe, behind its own checks: the recipe maps to the escrow the proof paid, and the bound fee
// covers the settle and the activation at the gas price and estimate of the moment.
async function activate(job, s) {
  try {
    const args = recipeArgs(job.exit);
    const escrowHex = await rpcA('eth_call', [{ to: ROUTER, data: encodeFunctionData({ abi: ROUTER_EXIT_ABI, functionName: 'escrowAddressFor', args: [args] }) }, 'latest']);
    const escrow = '0x' + escrowHex.slice(-40);
    const check = exitCheck({ job, escrow, nowSecs: Number(BigInt((await rpcA('eth_getBlockByNumber', ['latest', false])).timestamp)), ethAssetId: TETH });
    if (!check.ok) throw new Error(check.reason);
    const data = encodeFunctionData({ abi: ROUTER_EXIT_ABI, functionName: 'activateExit', args: [args] });
    const gasEstimate = BigInt(await rpcA('eth_estimateGas', [{ from: SETTLER, to: ROUTER, data }]));
    const gp = BigInt(await rpcA('eth_gasPrice'));
    const settleCostWei = BigInt(s.rc.gasUsed) * BigInt(s.rc.effectiveGasPrice || gp);
    const cover = activationCover({ job, settleCostWei, gasEstimate, gasPriceWei: gp, weiPerUnit: 10n ** 10n, gasCap: 1_500_000n });
    activations.push({ gasEstimate, cover });
    if (!cover.ok) throw new Error(cover.reason);
    const a = await send(SETTLER, ROUTER, data);
    await settler.ackJob(job.jobId, { activateTx: a.hash });
  } catch (e) { log.push(`activation failed: ${e.message}`); await settler.ackJob(job.jobId, { activateError: String(e.message || e).slice(0, 200) }); }
}
const activations = [];
const server = createServer(async (req, res) => {
  const u = new URL(req.url, RELAY);
  const json = (code, b) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); };
  const body = req.method === 'POST' ? JSON.parse(await new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => r(s || '{}')); })) : null;
  if (u.pathname === '/confidential/relay') return json(200, { state: 'ok', proving: true, settling: true, board: false });
  if (u.pathname === '/confidential/quote') return json(200, { recommendedWrapTipWei: '60000000000000', tipSplitter: '0xf5eBBE5Db610F64D29A0dC5e9534074Af12834F9', gasAwareFloorUnits: '20000', staticFloorUnits: '20000' });
  if (u.pathname === '/confidential/submit' && req.method === 'POST') {
    let r;
    try { r = await settler.submitJob({ type: body.type, op: body.op, memos: body.memos, mode: body.mode || 'settle', feeAsset: body.feeAsset || null, exit: body.exit || null, publicValues: body.publicValues || null, proof: body.proof || null }); }
    catch (e) { return json(400, { error: String(e.message || e) }); }
    queue = queue.then(async () => { const claimed = body.mode === 'preproven' ? await settler.nextOpen({ id: r.jobId }) : await settler.nextJob(); if (claimed) await runJob(claimed); });
    return json(200, { ok: true, ...r });
  }
  if (u.pathname === '/confidential/status') { const j = await settler.jobStatus(u.searchParams.get('id')); return j ? json(200, j) : json(404, { error: 'unknown' }); }
  return json(404, { error: 'no such path here' });
}).listen(RPORT);
server.keepAliveTimeout = 120_000;
procs.push({ kill: () => server.close() });
const again = async (go, what) => { for (let i = 0; ; i++) { try { return await go(); } catch (e) { if (i >= 3) { log.push(`fetch to ${what} failed: ${e.cause?.code || e.message}`); throw e; } await sleep(700 * (i + 1)); } } };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/^https:\/\/api\.tacit\.finance\/confidential\//.test(u)) return realFetch(u.replace('https://api.tacit.finance', RELAY), init);
  if (/^https:\/\/api\.tacit\.finance\//.test(u)) return new Response('{}', { status: 404 });
  if (/^https?:\/\/[^/]*(rpc|node|gateway|eth\.|llama|ankr|drpc|merkle|infura|alchemy|cloudflare|1rpc)/i.test(u) && init?.method === 'POST') return again(() => realFetch(RPC, { ...init, signal: AbortSignal.timeout(180_000) }), 'the fork');
  return again(() => realFetch(url, init), new URL(u).host);
};

const { secp, sha256, keccak_256, hmac } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { setActiveNetwork } = await import('../dapp/confidential-deployments.js');
setActiveNetwork('mainnet');
const mkUx = () => makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: (u, o) => globalThis.fetch(u, o), network: 'mainnet' });
const ux = mkUx();
const priv = crypto.getRandomValues(new Uint8Array(32));
ux.identity(priv);
const wait = { timeoutMs: 15 * 60e3, intervalMs: 1000, sleep: (t) => sleep(Math.min(t, 1000)) };
const fmtTac = (u) => (Number(BigInt(u ?? 0)) / 1e8).toFixed(4);
const t0 = Date.now();
const WRAP_TIP = '0x000000D218B03db5837943b0b05DeA2965AE956e', TIPTO = '0x00000000000000000000000000000000000071F0';
const word = (h, i) => BigInt('0x' + String(h).replace(/^0x/, '').slice(i * 64, i * 64 + 64));
const depositStatus = async (id) => word(await rpcA('eth_call', [{ to: POOL, data: '0x7da9874f' + String(id).slice(2).padStart(64, '0') }, 'latest']), 0);
const tac = String(ux.assetByTicker.cTAC.assetId).toLowerCase(), teth = String(ux.assetByTicker.cETH.assetId).toLowerCase();
const notesOf = async (k, x, asset) => (await x.balance(k, { bridge: false })).notes.filter((n) => String(n.asset).toLowerCase() === asset);
// the live tETH/TAC pool's fee tier
let feeBps = null;
for (const f of [30, 5, 100, 1]) { const lo = BigInt(teth) < BigInt(tac); const r = await ux.poolReserves(ux.routePoolId(lo ? teth : tac, lo ? tac : teth, f)).catch(() => null); if (r && BigInt(r.reserveA) > 0n) { feeBps = f; break; } }
ok(feeBps != null, `the live tETH/TAC pool is found (${feeBps} bps)`);
const sendCall = (c, from = FROM) => send(from, c.to, c.data, hex(c.value));
const ETH = 10n ** 16n;

const { makeConfidentialStage } = await import('../dapp/confidential-stage.js');
const st = makeConfidentialStage({ ux });
const PAY_ARTIFACTS = process.env.PAY_ARTIFACTS || '/Users/z/tacit/dapp/evm-pool';
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const { extname } = await import('node:path');

// ── the holder's machine: the pay pool's wallet in a browser, its proofs made in the page ──
const PAGE = `<!doctype html><script type="module">
import { makeEvmPoolWallet } from '/evm-pool/tacit-evm-pool-wallet.js';
const rpc = async (method, params = []) => { const r = await (await fetch('${RPC}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw Object.assign(new Error(r.error.message), { data: r.error.data }); return r.result; };
const provider = (account) => ({ request: ({ method, params }) => (method === 'eth_requestAccounts' || method === 'eth_accounts' ? [account] : rpc(method, params)) });
const until = async (f) => { for (let i = 0; i < 240; i++) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 500)); } throw new Error('timed out'); };
const receipt = (h) => until(async () => { const r = await rpc('eth_getTransactionReceipt', [h]); if (r && r.status !== '0x1') throw new Error('reverted ' + h); return r; });
const bytes = async (f) => new Uint8Array(await (await fetch('/evm-pool/' + f)).arrayBuffer());
window.run = async (commit, amount) => {
  const out = {};
  const [acc] = await rpc('eth_accounts');
  const artifacts = { wasm: await bytes('transact.wasm'), zkey: await bytes('transact_final.zkey'), vk: await bytes('transact_vk.json') };
  const w = await makeEvmPoolWallet({ chainId: 1, confirmations: 0, artifacts, provider: provider(acc), identityKey: new Uint8Array(32).fill(0x5a) });
  let t = performance.now();
  await w.sync(); out.syncMs = Math.round(performance.now() - t);
  t = performance.now();
  await receipt(await w.deposit(BigInt(amount) * 2n)); out.depositMs = Math.round(performance.now() - t);
  out.before = String((await w.sync()).balance);
  t = performance.now();
  const h = await w.toV1(BigInt(amount), commit, { via: 'self' });
  out.toV1Ms = Math.round(performance.now() - t);
  await receipt(h);
  out.after = String((await w.sync()).balance);
  out.tx = h;
  w.terminate();
  return out;
};
window.ready = true;
</script>`;
const TYPES = { '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.zkey': 'application/octet-stream' };
const web = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
  const name = u.pathname.replace(/^\/evm-pool\//, '');
  const f = /^(transact\.wasm|transact_final\.zkey|transact_vk\.json)$/.test(name) ? join(PAY_ARTIFACTS, name) : join(ROOT, 'dapp', u.pathname);
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
procs.push({ kill: () => web.close() });

const AMT = 2n * ETH;
const index = await ux.nextWrapIndex({ walletPriv: priv, ticker: 'cETH' });
const wrap = ux.buildWrap({ walletPriv: priv, amountWei: AMT, ticker: 'cETH', index });
let page;
{
  const browser = await chromium.launch();
  procs.push({ kill: () => browser.close().catch(() => {}) });
  page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${web.address().port}/`);
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const r = await page.evaluate(([c, a]) => window.run(c, a).catch((e) => ({ error: String(e && e.message || e) })), [wrap.commit, AMT.toString()]);
  ok(!r.error && BigInt(r.before) - BigInt(r.after) >= AMT, `the holder's browser proves the pay pool's withdrawal into the key's own V1 deposit: ${r.error || `toV1 ${r.toV1Ms} ms including the in-page proof (deposit ${r.depositMs} ms, sync ${r.syncMs} ms)`}${errs.length ? `; page errors: ${errs.slice(0, 2).join(' | ')}` : ''}`);
  ok(await depositStatus(wrap.depositId) === 1n, `and the V1 deposit of ${Number(AMT) / 1e18} ETH at wrap index ${index} waits, consumable by the key alone`);
}

// ── the V1 side: found from the key, the swap proved ahead, the press ──
{
  const fresh = makeConfidentialStage({ ux: mkUx() });
  const found = (await fresh.staged({ walletPriv: priv })).find((d) => String(d.depositId).toLowerCase() === String(wrap.depositId).toLowerCase());
  ok(!!found && found.index === index && found.wei === AMT, `a fresh V1 wallet holding only the key finds it (${found ? `index ${found.index}, ${Number(found.wei) / 1e18} ETH` : 'not found'})`);
  const d = found || { index, wei: AMT, depositId: wrap.depositId };
  const a = await st.proveSwap({ walletPriv: priv, deposit: d, toTicker: 'cTAC', feeBps, ahead: true, waitOpts: wait }).catch((e) => ({ error: e }));
  const nk = wrap.note;
  const secrets = [['the wallet key', '0x' + Buffer.from(priv).toString('hex')], ['the deposit\'s blinding', nk.blinding], ['the deposit\'s nullifier key', nk.secret]];
  const leaked = a.error ? ['(not proved)'] : secrets.filter(([, v]) => (lastStdin.wrapswap || '').includes(BigInt(v).toString(16).padStart(64, '0'))).map(([w]) => w);
  ok(!a.error && leaked.length === 0, `its swap is proved ahead by any prover, its input holding none of the key's secrets (${a.error ? a.error.message : `${fmtTac(a.built.amountOut)} TAC; ${log.slice(-1)[0]}`})`);
  const t = Date.now();
  const r = await st.pressSwap({ walletPriv: priv, deposit: d, toTicker: 'cTAC', feeBps, ready: a.error ? null : a, waitOpts: wait }).catch((e) => ({ error: e }));
  const got = r.error ? [] : (await notesOf(priv, ux, tac)).filter((x) => BigInt(x.value) === r.amountOut);
  ok(!r.error && r.ahead === true && got.length === 1, `the press sends the proof made ahead: a private ${fmtTac(r.amountOut)} TAC note in V1, ${Date.now() - t} ms from press to settled here (${r.error ? r.error.message : log.slice(-1)[0]})`);
}

if (fails) console.error(log.join('\n'));
console.log(`\n${n} passed, ${fails} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
stop();
process.exit(fails ? 1 : 0);
