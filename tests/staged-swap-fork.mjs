#!/usr/bin/env node
// A private swap whose only proof made at the press holds no secret, end to end on a mainnet fork with the real pool module and the LIVE
// pool, AMM and pay-pool router. The holder's own machine proves the one op that holds the note's key, a send-and-unwrap (OP 28), at any
// time before: it pins nothing that moves, so a proof that takes minutes is as good as one that takes seconds. It pays a public amount
// from the note into a wrap box (TacitEvmPoolRouter.wrapBoxOf) whose commit is the key's own deposit at a wrap index, keeping the rest as
// a hidden change note, and anyone completes the box, which leaves a pending deposit only that key can consume. The pool then trades
// and time passes, and the staged deposit still waits. At the press the key signs a wrap-swap (OP 33) against the live reserves: its
// program input is checked to hold none of the key's secrets (nullifier keys, blindings, the wallet key), so any prover may make it, and
// it settles into a private TAC note. Each op runs through the worker's job queue, the pinned SETTLE GUEST in SP1 execute mode and
// pool.settle(); only the pool's SP1 verifier is replaced.
//
//   node tests/staged-swap-fork.mjs        (FORK=<rpc url>; EXEC=<the exec-stdin binary>, built from tests/exec-stdin when not given)
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
const store = (() => { const m = new Map(); let pending = []; return { getPending: async () => pending.slice(), putPending: async (ids) => { pending = ids.slice(); }, getJob: async (id) => (m.has(id) ? JSON.parse(JSON.stringify(m.get(id))) : null), putJob: async (id, j) => { m.set(id, JSON.parse(JSON.stringify(j))); } }; })();
const settler = makeConfidentialSettler({ storage: store, hash: (str) => keccak256(`0x${Buffer.from(str).toString('hex')}`), sleep: async () => {} });
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
async function runJob({ jobId: id, type, op, memos: jm, mode }) {
  try {
    const body = { type, op: JSON.parse(JSON.stringify(op)), memos: jm || [] };
    if (process.env.MUTATE === 'share-value' && type === 'wrap') body.op.value = String(BigInt(body.op.value) + 1n);
    const memoHashes = body.memos.map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`));
    const f = join(tmp, `${id.slice(2, 14)}.stdin`), out = join(tmp, `${id.slice(2, 14)}.pv`);
    const bytes = stdinFor(type, { ...body.op, memoHashes });
    writeFileSync(f, bytes);
    lastStdin[type] = Buffer.from(bytes).toString('hex');
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

const EVM_ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const INTENT = '(bytes32 assetId,uint256 amount,uint256 tip,address tipTo,bytes32 commit,address refund,uint64 deadline,uint256 nonce)';
const routerAbi = parseAbi([`function wrapBoxOf(${INTENT} intent) view returns (address)`, `function completeWrap(${INTENT} intent)`, 'function V1() view returns (address)']);
const callR = async (functionName, args = []) => {
  const { decodeFunctionResult } = require('viem');
  const data = encodeFunctionData({ abi: routerAbi, functionName, args });
  return decodeFunctionResult({ abi: routerAbi, functionName, data: await rpcA('eth_call', [{ to: EVM_ROUTER, data }, 'latest']) });
};
const selfSettle = async ({ publicValues, proof, memos: ms }) => {
  const data = encodeFunctionData({ abi: parseAbi(['function settle(bytes publicValues, bytes proof, bytes[] memos)']), functionName: 'settle', args: [publicValues, proof || '0x', (ms || []).map((m) => (m.startsWith('0x') ? m : `0x${m}`))] });
  const s = await send(SETTLER, POOL, data);
  return { txHash: s.hash };
};
ok(String(await callR('V1')).toLowerCase() === POOL.toLowerCase(), "the live pay-pool router's wrap boxes deposit into the live confidential pool");

// ── 1. a private tETH note to start from (a plain wrap) ──
const NOTE = 5n * ETH, STAGE = 2n * ETH;
{
  const index = await ux.nextWrapIndex({ walletPriv: priv, ticker: 'cETH' });
  const w = ux.buildWrap({ walletPriv: priv, amountWei: NOTE, ticker: 'cETH', index });
  await send(FROM, WRAP_TIP, '0xfc24c435' + w.commit.slice(2).padStart(64, '0') + NOTE.toString(16).padStart(64, '0') + TIPTO.slice(2).toLowerCase().padStart(64, '0'), hex(NOTE + 10n ** 14n));
  const s = await ux.submitWrapSettle({ built: w, waitOpts: wait }).catch((e) => ({ error: e }));
  ok(!s.error && await depositStatus(w.depositId) === 2n, `the key holds a private 0.05 tETH note (${s.error ? s.error.message : 'settled'})`);
}

// ── 2. staged ahead, on the holder's machine: the only op that holds the note's key, and it pins nothing that moves ──
const secrets = [['the wallet key', '0x' + Buffer.from(priv).toString('hex')]];
let stageIndex, stagedId, staged;
{
  const [note] = (await notesOf(priv, ux, teth)).filter((x) => BigInt(x.value) * 10n ** 10n === NOTE);
  secrets.push(['the note\'s nullifier key', note.secret], ['the note\'s blinding', note.blinding]);
  stageIndex = await ux.nextWrapIndex({ walletPriv: priv, ticker: 'cETH' });
  staged = ux.buildWrap({ walletPriv: priv, amountWei: STAGE, ticker: 'cETH', index: stageIndex });
  stagedId = staged.depositId;
  const intent = { assetId: teth, amount: STAGE, tip: 0n, tipTo: '0x0000000000000000000000000000000000000000', commit: staged.commit, refund: FROM.toLowerCase(), deadline: BigInt(Math.floor(Date.now() / 1000) + 90 * 86400), nonce: 0n };
  const box = await callR('wrapBoxOf', [intent]);
  const before = log.length;
  const t = Date.now();
  const r = await ux.sendUnwrap({ note, walletPriv: priv, recipient: box, amount: STAGE / 10n ** 10n, selfSettle }).catch((e) => ({ error: e }));
  ok(!r.error && BigInt(await rpcA('eth_getBalance', [box, 'latest'])) === STAGE, `the holder's machine proves a send-and-unwrap of 0.02 tETH into the box ${box.slice(0, 10)}…, 0.03 kept as a hidden change note (${r.error ? r.error.message : log.slice(before).join('; ')}; ${((Date.now() - t) / 1000).toFixed(1)} s)`);
  const pv = log.slice(before).join(' ');
  ok(/sendunwrap/.test(pv), 'that op is the send-and-unwrap (the one the device prover takes: no reserves, no deadline beyond its own)');
  const c = await send(SETTLER, EVM_ROUTER, encodeFunctionData({ abi: routerAbi, functionName: 'completeWrap', args: [intent] }));
  ok(await depositStatus(stagedId) === 1n, `anyone completes the box: a pending 0.02 tETH deposit only this key can consume (${BigInt(c.rc.gasUsed)} gas)`);
  const change = (await notesOf(priv, ux, teth)).filter((x) => BigInt(x.value) * 10n ** 10n === NOTE - STAGE);
  ok(change.length === 1, 'and the rest of the note is the key\'s hidden change note');
}

// ── 3. the pool trades and two days pass: nothing staged goes stale ──
{
  const other = crypto.getRandomValues(new Uint8Array(32)), ox = mkUx();
  const b = await ox.proveWrapSwap({ walletPriv: other, toTicker: 'cTAC', amountWei: ETH, feeBps, ahead: true, waitOpts: wait });
  await sendCall(ox.wrapSettleCall({ built: b.built, proven: b.proven }));
  await rpcA('evm_increaseTime', [hex(2 * 86400)]); await rpcA('evm_mine');
  ok(await depositStatus(stagedId) === 1n, 'another trader moves the pool and two days pass: the staged deposit still waits, consumable by the key alone');
}

// ── 4. the press: a wrap-swap against the live reserves, whose program input holds no secret ──
{
  const t = Date.now();
  const built = await ux.buildWrapSwap({ walletPriv: priv, toTicker: 'cTAC', amountWei: STAGE, feeBps, index: stageIndex });
  const signMs = Date.now() - t;
  ok(String(built.depositId).toLowerCase() === String(stagedId).toLowerCase(), `the press builds and signs the swap of the staged deposit in ${signMs} ms on this machine`);
  secrets.push(['the deposit\'s blinding', staged.note.blinding], ['the deposit\'s nullifier key', staged.note.secret], ['the output\'s blinding', built.outputs[0].blinding], ['the output\'s nullifier key', built.outputs[0].secret]);
  const stdin = Buffer.from(stdinFor('wrapswap', { ...JSON.parse(JSON.stringify(built.op)), memoHashes: built.memos.map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`)) })).toString('hex');
  const opJson = JSON.stringify(built.op).toLowerCase();
  const found = [];
  for (const [what, v] of secrets) {
    if (v == null) { found.push(`${what} (not read)`); continue; }
    const h = BigInt(v).toString(16).padStart(64, '0');
    if (stdin.includes(h) || opJson.includes(h)) found.push(what);
  }
  const control = ['the note\'s nullifier key', 'the note\'s blinding'].filter((w) => { const v = secrets.find(([x]) => x === w)[1]; return (lastStdin.sendunwrap || '').includes(BigInt(v).toString(16).padStart(64, '0')); });
  ok(control.length >= 1, `control: the same scan finds the note's secrets in the staged send-and-unwrap's input, which the holder's machine proves (${control.join(', ') || 'none found'})`);
  ok(found.length === 0 && secrets.length === 7, `the swap's program input (${stdin.length / 2} bytes) holds none of: ${secrets.map(([w]) => w).join(', ')}${found.length ? ` (FOUND: ${found.join(', ')})` : ''}`);
  const r = await ux.submitWrapSwap({ walletPriv: priv, built, waitOpts: wait }).catch((e) => ({ error: e }));
  const got = (await notesOf(priv, ux, tac)).filter((x) => BigInt(x.value) === built.amountOut);
  ok(!r.error && await depositStatus(stagedId) === 2n && got.length === 1, `any prover proves it and it settles: a private ${fmtTac(built.amountOut)} TAC note (${r.error ? r.error.message : 'settled'}; ${log.slice(-1)[0] || ''})`);
}

// ── 5. recovery from the key alone: a fresh wallet finds the change note and the TAC note ──
{
  const fresh = mkUx();
  const tN = (await notesOf(priv, fresh, tac)).length, eN = (await notesOf(priv, fresh, teth)).filter((x) => BigInt(x.value) * 10n ** 10n === NOTE - STAGE).length;
  ok(tN >= 1 && eN === 1, `a fresh wallet holding only the key finds the TAC note and the change note (${tN} TAC, ${eN} change)`);
}

if (fails) console.error(log.join('\n'));
console.log(`\n${n} passed, ${fails} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
stop();
process.exit(fails ? 1 : 0);
