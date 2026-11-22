#!/usr/bin/env node
// Public ETH into a private token in one transaction, end to end on a mainnet fork, with the real pool module and the LIVE pool, router and AMM:
// a deposit swapped in the pool in one proof (OP 33, wrapswap) is proved before anything is deposited, with no fee bound in, then one router
// transaction (wrapAndSettleETH) deposits the ETH and settles the swap, the relay's tip on top, and the private TAC note is the key's in that
// block. A proof whose pool traded since is refused by the router with nothing sent. Without one made ahead, the deposit goes first and the
// relay proves the swap in one step (its fee bound in); and a deposit whose swap does not settle (the pool moved while it was proved) is
// settled as a plain wrap of the same note, so the ETH is private tETH, never stuck. Each op runs through the worker's job queue (prove-only
// jobs hand their proof back, the rest are settled), the pinned SETTLE GUEST in SP1 execute mode and pool.settle(); only the pool's SP1
// verifier is replaced.
//
//   node tests/wrapswap-first-fork.mjs        (FORK=<rpc url>; EXEC=<the exec-stdin binary>, built from tests/exec-stdin when not given;
//                                              LOG_RPC=<rpc url>; LOG_CACHE=<file>)
// FORK serves the chain's STATE at the fork block: https://ethereum-rpc.publicnode.com for a run that starts at the head (it keeps the last 128 blocks, and a run takes minutes);
// rpc.mevblocker.io serves any depth but rate-limits a state read with HTTP 429 after a few runs.
// LOG_RPC serves the pool's old LOGS (default https://rpc.mevblocker.io: any depth, spans up to 10,000 blocks), fetched once in chunks. LOG_CACHE keeps the settled chunks between
// runs (default: a file in the temp folder; empty for none): the first run on a cold cache reads the pool's history, a few minutes, and the next ones start with it.
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
procs.push(spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--no-rate-limit'], { stdio: 'ignore' }));
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
const store = (() => { const m = new Map(); let pending = []; return { getPending: async () => pending.slice(), putPending: async (ids) => { pending = ids.slice(); }, getJob: async (id) => (m.has(id) ? JSON.parse(JSON.stringify(m.get(id))) : null), putJob: async (id, j) => { m.set(id, JSON.parse(JSON.stringify(j))); } }; })();
const settler = makeConfidentialSettler({ storage: store, hash: (str) => keccak256(`0x${Buffer.from(str).toString('hex')}`), sleep: async () => {} });
let queue = Promise.resolve();
const log = [];
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
async function runJob({ jobId: id, type, op, memos: jm, mode }) {
  try {
    const body = { type, op: JSON.parse(JSON.stringify(op)), memos: jm || [] };
    if (process.env.MUTATE === 'share-value' && type === 'wrap') body.op.value = String(BigInt(body.op.value) + 1n);
    const memoHashes = body.memos.map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`));
    const f = join(tmp, `${id.slice(2, 14)}.stdin`), out = join(tmp, `${id.slice(2, 14)}.pv`);
    writeFileSync(f, stdinFor(type, { ...body.op, memoHashes }));
    const t = Date.now(), r = await execGuest({ ...process.env, STDIN: f, OUT: out });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('EXECUTE_OK')) || '';
    if (r.status !== 0 || !existsSync(out)) throw new Error(`the settle guest rejected the op: ${((r.stderr || '') + (r.stdout || '')).split('\n').filter((l) => /panick|assert|error|failed/i.test(l)).slice(0, 3).join(' | ').slice(0, 300)}`);
    log.push(`${type}${mode === 'prove' ? ' (prove only)' : ''}: ${line} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    if (mode === 'prove') { await settler.ackJob(id, { publicValues: `0x${readFileSync(out, 'utf8').trim()}`, proof: '0x' }); return; }
    const data = encodeFunctionData({ abi: parseAbi(['function settle(bytes publicValues, bytes proof, bytes[] memos)']), functionName: 'settle', args: [`0x${readFileSync(out, 'utf8').trim()}`, '0x', body.memos.map((m) => (m.startsWith('0x') ? m : `0x${m}`))] });
    const s = await send(SETTLER, POOL, data);
    await settler.ackJob(id, { txHash: s.hash });
  } catch (e) { const m = String(e.message || e).slice(0, 400); log.push(`${type} failed: ${m}`); await settler.ackJob(id, { error: m }); }
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
const again = async (go, what) => { for (let i = 0; ; i++) { try { return await go(); } catch (e) { if (i >= 3) { log.push(`fetch to ${what} failed: ${e.cause?.code || e.message}`); throw e; } await sleep(700 * (i + 1)); } } };
// The pool's log scan is made once (tests/fork-log-cache.mjs): a getLogs for blocks at or behind the fork block is answered from aligned chunks fetched once from LOG_RPC, an archive node
// that takes 10,000-block spans (the fork's own state node need not keep old logs); LOG_CACHE keeps the settled ones between runs (default: a file in the temp folder; LOG_CACHE= with
// nothing after it keeps none). Without it each page object scans the pool's whole history, an hour and more.
const FORK_AT = head;
const LOG_RPC = process.env.LOG_RPC || 'https://rpc.mevblocker.io';
const LOG_CACHE = process.env.LOG_CACHE === undefined ? join(tmpdir(), 'tacit-fork-getlogs-v1.json') : process.env.LOG_CACHE || null;
const logCache = (await import('./fork-log-cache.mjs')).makeLogCache({
  head: () => FORK_AT, file: LOG_CACHE,
  fetchChunk: async (filter, from, to) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }] });
    const j = await (await again(() => realFetch(LOG_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(180_000) }), 'the archive node')).json();
    if (!Array.isArray(j.result)) throw new Error(`getLogs ${from}-${to}: ${JSON.stringify(j.error || j).slice(0, 120)}`);
    return j.result;
  },
});
const cachedLogs = async (init) => {
  try {
    const q = JSON.parse(init.body);
    if (q.method !== 'eth_getLogs') return null;
    const out = await logCache.logs(q.params && q.params[0]);
    return out && new Response(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: out }), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch { return null; }
};
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/^https:\/\/api\.tacit\.finance\/confidential\//.test(u)) return realFetch(u.replace('https://api.tacit.finance', RELAY), init);
  if (/^https:\/\/api\.tacit\.finance\//.test(u)) return new Response('{}', { status: 404 });
  // every JSON-RPC call goes to the fork, whatever its host: a node the pattern below does not name (eth-mainnet.public.blastapi.io) answered from the live chain, whose pool had traded since the fork block
  if (init?.method === 'POST' && (/"jsonrpc"/.test(String(init.body || '')) || /^https?:\/\/[^/]*(rpc|node|gateway|eth\.|llama|ankr|drpc|merkle|infura|alchemy|cloudflare|1rpc)/i.test(u))) return (await cachedLogs(init)) || again(() => realFetch(RPC, { ...init, signal: AbortSignal.timeout(180_000) }), 'the fork');
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

// ── 1. proved ahead, then one transaction: the deposit, the swap and the TAC note, the relay's tip on top ──
{
  const r = await ux.proveWrapSwap({ walletPriv: priv, toTicker: 'cTAC', amountWei: ETH, feeBps, ahead: true, waitOpts: wait }).catch((e) => ({ error: e }));
  ok(!r.error && r.proven?.publicValues && r.built.amountOut > 0n, `0.01 ETH's swap for ${r.built ? fmtTac(r.built.amountOut) : '?'} TAC is proved before anything is deposited (${r.error ? r.error.message : 'proved'}; ${log.slice(-1)[0] || ''})`);
  if (!r.error) {
    const tip = 10n ** 14n, c = ux.wrapSettleCall({ built: r.built, proven: r.proven, ethFeeWei: tip, feeRecipient: TIPTO });
    const b0 = BigInt(await rpcA('eth_getBalance', [TIPTO, 'latest']));
    const s = await sendCall(c).catch((e) => ({ error: e }));
    const got = (await notesOf(priv, ux, tac)).find((n) => String(n.leaf || '').toLowerCase() === String(r.built.leaf).toLowerCase() || BigInt(n.value) === r.built.amountOut);
    const tipped = BigInt(await rpcA('eth_getBalance', [TIPTO, 'latest'])) - b0;
    ok(!s.error && await depositStatus(r.built.depositId) === 2n && got && BigInt(got.value) === r.built.amountOut && tipped === tip,
      `one transaction deposits it and settles the swap: a private ${fmtTac(got?.value)} TAC note in that block, the relay tipped ${tipped} wei (${s.error ? s.error.message : `${BigInt(s.rc.gasUsed)} gas`})`);
  }
}

// ── 2. a proof made ahead whose pool traded since: the router refuses it, nothing is sent ──
{
  const a = await ux.proveWrapSwap({ walletPriv: priv, toTicker: 'cTAC', amountWei: ETH, feeBps, ahead: true, waitOpts: wait });
  const other = crypto.getRandomValues(new Uint8Array(32)), ox = mkUx();
  const b = await ox.proveWrapSwap({ walletPriv: other, toTicker: 'cTAC', amountWei: ETH, feeBps, ahead: true, waitOpts: wait });
  await sendCall(ox.wrapSettleCall({ built: b.built, proven: b.proven }));
  const c = ux.wrapSettleCall({ built: a.built, proven: a.proven });
  const sim = await rpcA('eth_call', [{ from: FROM, to: c.to, data: c.data, value: hex(c.value) }, 'latest']).then(() => null, (e) => e);
  ok(!!sim && await depositStatus(a.built.depositId) === 0n, `another swap trades the pool first: the router refuses the stale proof, and nothing is deposited (${sim ? why(sim) : 'it would go through'})`);
  const left = await ux.poolReserves(a.built.pid);
  ok(BigInt(left.reserveA) !== a.built.reserveA || BigInt(left.reserveB) !== a.built.reserveB, 'and the page can tell before asking: the reserves are not the ones the proof pins');
  try { ux.releaseWrapIndex?.({ walletPriv: priv, ticker: 'cETH', index: a.built.index }); } catch { }
}

// ── 3. none made ahead: the deposit first (its tip as a wrap's), then the relay proves and settles the swap in one step ──
{
  const index = await ux.nextWrapIndex({ walletPriv: priv, ticker: 'cETH' }), fee = BigInt(await ux.quoteOpFee('cETH', 'route'));
  const built = await ux.buildWrapSwap({ walletPriv: priv, toTicker: 'cTAC', amountWei: ETH, feeBps, fee, index });
  const d = await send(FROM, WRAP_TIP, '0xfc24c435' + built.commit.slice(2).padStart(64, '0') + ETH.toString(16).padStart(64, '0') + TIPTO.slice(2).toLowerCase().padStart(64, '0'), hex(ETH + 10n ** 14n));
  ok(await depositStatus(built.depositId) === 1n, `the 0.01 ETH deposit is in the pool, waiting (${BigInt(d.rc.gasUsed)} gas)`);
  const r = await ux.submitWrapSwap({ walletPriv: priv, built, waitOpts: wait }).catch((e) => ({ error: e }));
  const got = (await notesOf(priv, ux, tac)).filter((n) => BigInt(n.value) === built.amountOut);
  ok(!r.error && await depositStatus(built.depositId) === 2n && got.length >= 1, `the relay proves and settles the swap in one step, its fee ${fmtTac(fee)} tETH bound in: a private ${fmtTac(built.amountOut)} TAC note (${r.error ? r.error.message : 'settled'}; ${log.slice(-1)[0] || ''})`);
}

// ── 4. a deposit whose swap does not settle (the pool moved while it was proved) is settled as a plain wrap of the same note ──
{
  const index = await ux.nextWrapIndex({ walletPriv: priv, ticker: 'cETH' }), fee = BigInt(await ux.quoteOpFee('cETH', 'route'));
  const built = await ux.buildWrapSwap({ walletPriv: priv, toTicker: 'cTAC', amountWei: ETH, feeBps, fee, index });
  await send(FROM, WRAP_TIP, '0xfc24c435' + built.commit.slice(2).padStart(64, '0') + ETH.toString(16).padStart(64, '0') + TIPTO.slice(2).toLowerCase().padStart(64, '0'), hex(ETH + 10n ** 14n));
  const other = crypto.getRandomValues(new Uint8Array(32)), ox = mkUx();
  const b = await ox.proveWrapSwap({ walletPriv: other, toTicker: 'cTAC', amountWei: ETH, feeBps, ahead: true, waitOpts: wait });
  await sendCall(ox.wrapSettleCall({ built: b.built, proven: b.proven }));
  const r = await ux.submitWrapSwap({ walletPriv: priv, built, waitOpts: wait }).catch((e) => ({ error: e }));
  ok(!!r.error && await depositStatus(built.depositId) === 1n, `the pool moved: the swap does not settle and the deposit still waits (${r.error ? String(r.error.message).slice(0, 120) : 'it settled'})`);
  const w = ux.buildWrap({ walletPriv: priv, amountWei: ETH, ticker: 'cETH', index });
  ok(String(w.commit).toLowerCase() === String(built.commit).toLowerCase() && String(w.depositId).toLowerCase() === String(built.depositId).toLowerCase(), 'a plain wrap at the same index is the same deposit');
  const s = await ux.submitWrapSettle({ built: w, waitOpts: wait }).catch((e) => ({ error: e }));
  const got = (await notesOf(priv, ux, teth)).filter((n) => BigInt(n.value) === ETH / 10n ** 10n);
  ok(!s.error && await depositStatus(built.depositId) === 2n && got.length >= 1, `it settles as a wrap: a private 0.01 tETH note, ready to swap from (${s.error ? s.error.message : 'settled'}; ${log.slice(-1)[0] || ''})`);
}

// ── 5. the holder's own prover: it proves the swap before anything is deposited (here by running the guest, as the Succinct network would), the
// relay is asked for nothing, and one router transaction with no tip deposits and settles it ──
{
  const own = async ({ type, op, memos: ms }) => {
    const memoHashes = (ms || []).map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`));
    const f = join(tmp, 'own.stdin'), out = join(tmp, 'own.pv');
    writeFileSync(f, stdinFor(type, { ...JSON.parse(JSON.stringify(op)), memoHashes }));
    const r = await execGuest({ ...process.env, STDIN: f, OUT: out });
    if (r.status !== 0 || !existsSync(out)) throw new Error('the guest rejected the op');
    return { requestId: 'own-1', publicValues: `0x${readFileSync(out, 'utf8').trim()}`, proof: '0x', private: true };
  };
  own.supports = (t) => t === 'wrapswap';
  const ox = mkUx();
  ox.relay.useProver(own);
  const before = log.length;
  const r = await ox.proveWrapSwap({ walletPriv: crypto.getRandomValues(new Uint8Array(32)), toTicker: 'cTAC', amountWei: ETH, feeBps, waitOpts: wait }).catch((e) => ({ error: e }));
  ok(!r.error && /^spn:/.test(String(r.proven?.jobId || '')) && log.length === before, `the holder's own prover proves it, the relay's queue untouched (${r.error ? r.error.message : r.proven.jobId})`);
  if (!r.error) {
    const b0 = BigInt(await rpcA('eth_getBalance', [TIPTO, 'latest']));
    const c = ox.wrapSettleCall({ built: r.built, proven: r.proven });
    const s2 = await sendCall(c).catch((e) => ({ error: e }));
    ok(!s2.error && await depositStatus(r.built.depositId) === 2n && c.value === ETH && BigInt(await rpcA('eth_getBalance', [TIPTO, 'latest'])) === b0,
      `one transaction deposits and settles it with no tip: the ${fmtTac(r.built.amountOut)} TAC note is in the pool (${s2.error ? s2.error.message : `${BigInt(s2.rc.gasUsed)} gas`}; value ${c.value})`);
  }
}

// ── 6. the pool moved while the swap was proved, and the swap is handed a way to build again (submitWrapSwap's `rebuild`, which the page passes): it settles on the reserves now,
// spending the deposit that was waiting, where section 4 (given none) gives up and settles the deposit as a plain wrap ──
{
  const index = await ux.nextWrapIndex({ walletPriv: priv, ticker: 'cETH' }), fee = BigInt(await ux.quoteOpFee('cETH', 'route'));
  const args = { walletPriv: priv, toTicker: 'cTAC', amountWei: ETH, feeBps, fee, index };
  const built = await ux.buildWrapSwap(args);
  await send(FROM, WRAP_TIP, '0xfc24c435' + built.commit.slice(2).padStart(64, '0') + ETH.toString(16).padStart(64, '0') + TIPTO.slice(2).toLowerCase().padStart(64, '0'), hex(ETH + 10n ** 14n));
  // another key's swap trades the pool first (the same page object, so the log scan is not made again for it)
  const b = await ux.proveWrapSwap({ walletPriv: crypto.getRandomValues(new Uint8Array(32)), toTicker: 'cTAC', amountWei: ETH, feeBps, ahead: true, waitOpts: wait });
  await sendCall(ux.wrapSettleCall({ built: b.built, proven: b.proven }));
  const now = await ux.poolReserves(built.pid);
  ok(BigInt(now.reserveA) !== built.reserveA || BigInt(now.reserveB) !== built.reserveB, 'another swap trades the pool after this one was built: the reserves its proof pins are gone');
  let again = null;
  const r = await ux.submitWrapSwap({ walletPriv: priv, built, rebuild: async () => (again = await ux.buildWrapSwap(args)), waitOpts: wait }).catch((e) => ({ error: e }));
  ok(!r.error && !!again && String(again.depositId).toLowerCase() === String(built.depositId).toLowerCase() && await depositStatus(built.depositId) === 2n,
    `the pool refused the first swap, it was built again on the reserves now, and it settles, spending the same deposit (${r.error ? r.error.message : 'settled'}; ${log.slice(-1)[0] || ''})`);
  ok(!!again && again.amountOut > 0n && again.amountOut < built.amountOut && r.amountOut === again.amountOut,
    `the answer is what the swap that settled pays, ${fmtTac(again?.amountOut)} TAC, less than the ${fmtTac(built.amountOut)} the first quote said`);
  const got = (await notesOf(priv, ux, tac)).filter((n) => BigInt(n.value) === again?.amountOut);
  ok(got.length >= 1, `a private ${fmtTac(again?.amountOut)} TAC note is the key's`);
}

if (fails) console.error(log.join('\n'));
console.log(`\n${n} passed, ${fails} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
stop();
process.exit(fails ? 1 : 0);
