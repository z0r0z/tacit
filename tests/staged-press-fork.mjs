#!/usr/bin/env node
// Staged deposits (dapp/confidential-stage.js) end to end on a mainnet fork with the real pool module and the LIVE pool, router and AMM. A tETH
// note is staged: the relay proves and settles its unwrap to an exit escrow whose one call wraps exactly that ETH back as the key's own deposit at a
// wrap index, and the relay runs the call once its own checks (exitCheck, activationCover: the bound fee pays the settle and the activation) pass.
// A fresh wallet holding only the key finds the deposit waiting. The swap of it is proved ahead on the board while its amount is on screen; the
// pool moves and the page sees the proof no longer fits; it is proved again, and at the press the relay sends it from the open board, from the
// proof alone. Each op runs through the worker's job queue, the pinned SETTLE GUEST in SP1 execute mode and pool.settle(); only the pool's SP1
// verifier is replaced.
//
//   node tests/staged-press-fork.mjs        (FORK=<rpc url>; FORK_BLOCK=<n>; EXEC=<the exec-stdin binary>, built from tests/exec-stdin when not given)
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
    const cover = activationCover({ job, settleCostWei, gasEstimate, gasPriceWei: gp, weiPerUnit: 10n ** 10n, gasCap: 1_500_000n, ethAssetId: TETH });
    activations.push({ gasEstimate, cover });
    if (!cover.ok) throw new Error(cover.reason);
    const a = await send(SETTLER, ROUTER, data);
    await settler.ackJob(job.jobId, { activateTx: a.hash });
  } catch (e) { log.push(`activation failed: ${e.message}`); await settler.ackJob(job.jobId, { activateError: String(e.message || e).slice(0, 200) }); }
}
const activations = [], submitsSeen = [];
const server = createServer(async (req, res) => {
  const u = new URL(req.url, RELAY);
  const json = (code, b) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); };
  const body = req.method === 'POST' ? JSON.parse(await new Promise((r) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => r(s || '{}')); })) : null;
  if (u.pathname === '/confidential/relay') return json(200, { state: 'ok', proving: true, settling: true, board: false });
  if (u.pathname === '/confidential/quote') return json(200, { recommendedWrapTipWei: '60000000000000', tipSplitter: '0xf5eBBE5Db610F64D29A0dC5e9534074Af12834F9', gasAwareFloorUnits: '20000', staticFloorUnits: '20000' });
  if (u.pathname === '/confidential/submit' && req.method === 'POST') {
    submitsSeen.push({ type: body.type, mode: body.mode || 'settle', op: !!body.op, exit: !!body.exit });
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

const { makeConfidentialStage, rescueKey } = await import('../dapp/confidential-stage.js');
const st = makeConfidentialStage({ ux });
const NOTE = 3n * ETH;

// ── 1. three private tETH notes to stage (plain wraps) ──
for (let k = 0; k < 3; k++) {
  const index = await ux.nextWrapIndex({ walletPriv: priv, ticker: 'cETH' });
  const w = ux.buildWrap({ walletPriv: priv, amountWei: NOTE + BigInt(k) * ETH, ticker: 'cETH', index });
  await send(FROM, WRAP_TIP, '0xfc24c435' + w.commit.slice(2).padStart(64, '0') + (NOTE + BigInt(k) * ETH).toString(16).padStart(64, '0') + TIPTO.slice(2).toLowerCase().padStart(64, '0'), hex(NOTE + BigInt(k) * ETH + 10n ** 14n));
  const s = await ux.submitWrapSettle({ built: w, waitOpts: wait }).catch((e) => ({ error: e }));
  ok(!s.error && await depositStatus(w.depositId) === 2n, `the key holds a private ${Number(NOTE + BigInt(k) * ETH) / 1e18} tETH note (${s.error ? s.error.message : 'settled'})`);
}

// ── 2. staged: a relayed unwrap to the recipe's escrow, the relay's activation, the key's deposit waiting ──
const stagedList = [], stagedKeys = [];
for (const note of (await notesOf(priv, ux, teth)).sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : 1))) {
  const before = log.length;
  const r = await st.stageNote({ note, walletPriv: priv, waitOpts: wait }).catch((e) => ({ error: e }));
  stagedKeys.push(note.secret);
  const act = activations[activations.length - 1];
  ok(!r.error && await depositStatus(r.depositId) === 1n && r.wei < BigInt(note.value) * 10n ** 10n && r.wei > BigInt(note.value) * 10n ** 10n * 9n / 10n,
    `a ${Number(note.value) / 1e8} tETH note is staged as the key's deposit of ${Number(r.wei ?? 0n) / 1e18} ETH at wrap index ${r.index} (${r.error ? r.error.message : log.slice(before).join('; ')})`);
  ok(act && act.cover.ok, `the relay's own checks pass: the bound fee pays the settle and the activation (${act ? `${act.gasEstimate} gas to activate, fee ${act.cover.feeWei} wei, cost ${act.cover.cost} wei` : 'no activation'})`);
  if (!r.error) {
    const tx = await rpcA('eth_getTransactionByHash', [r.activateTx]);
    const input = String(tx.input).toLowerCase();
    ok(!input.includes(FROM.slice(2).toLowerCase()) && !input.includes(SETTLER.slice(2).toLowerCase().padStart(40, '0')) && input.includes(rescueKey(priv).address.slice(2)),
      'the activation names the rescue address made from the Tacit key, and no account of the holder\'s');
    stagedList.push(r);
  }
}
ok((await notesOf(priv, ux, teth)).length === 0, 'every note is spent: nothing of the key\'s is left as a note');

// ── 3. found again from the key alone ──
{
  const fresh = makeConfidentialStage({ ux: mkUx() });
  const found = await fresh.staged({ walletPriv: priv });
  const want = stagedList.map((r) => `${r.index}:${r.wei}`).sort().join(',');
  ok(found.map((d) => `${d.index}:${d.wei}`).sort().join(',') === want, `a fresh wallet holding only the key finds every staged deposit (${found.map((d) => `index ${d.index}, ${Number(d.wei) / 1e18} ETH`).join('; ')})`);
}

// ── 4. the swap of the first is proved ahead, its input holding no secret of the key's ──
const [d1, d2, d3] = (await st.staged({ walletPriv: priv })).sort((a, b) => a.index - b.index);
const a1 = await st.proveSwap({ walletPriv: priv, deposit: d1, toTicker: 'cTAC', feeBps, ahead: true, waitOpts: wait }).catch((e) => ({ error: e }));
ok(!a1.error && await st.stillFits(a1.built), `the swap of the first is proved ahead, while its amount is on screen (${a1.error ? a1.error.message : `${fmtTac(a1.built.amountOut)} TAC; ${log.slice(-1)[0]}`})`);
{
  const nk = ux.buildWrap({ walletPriv: priv, amountWei: d1.wei, ticker: 'cETH', index: d1.index }).note;
  const secrets = [['the wallet key', '0x' + Buffer.from(priv).toString('hex')], ['the deposit\'s blinding', nk.blinding], ['the deposit\'s nullifier key', nk.secret], ['the output\'s blinding', a1.built.outputs[0].blinding], ['the output\'s nullifier key', a1.built.outputs[0].secret]];
  const inSwap = secrets.filter(([, v]) => (lastStdin.wrapswap || '').includes(BigInt(v).toString(16).padStart(64, '0'))).map(([w]) => w);
  ok(lastStdin.wrapswap && inSwap.length === 0, `its program input holds none of: ${secrets.map(([w]) => w).join(', ')}${inSwap.length ? ` (FOUND: ${inSwap.join(', ')})` : ''}`);
  const control = (lastStdin.unwrap || '').includes(BigInt(stagedKeys[stagedKeys.length - 1]).toString(16).padStart(64, '0'));
  ok(control, 'control: the same scan finds the staged note\'s nullifier key in its unwrap\'s input (the step the relay, or the holder\'s machine, proves)');
}

// ── 5. the pool moves: the page sees the proof no longer fits, and the press proves it again ──
{
  const other = crypto.getRandomValues(new Uint8Array(32)), ox = mkUx();
  const b = await ox.proveWrapSwap({ walletPriv: other, toTicker: 'cTAC', amountWei: ETH, feeBps, ahead: true, waitOpts: wait });
  await sendCall(ox.wrapSettleCall({ built: b.built, proven: b.proven }));
  ok(!(await st.stillFits(a1.built)), 'another trader moves the pool: the swap proved ahead no longer fits');
  const r = await st.pressSwap({ walletPriv: priv, deposit: d1, toTicker: 'cTAC', feeBps, ready: a1, waitOpts: wait }).catch((e) => ({ error: e }));
  const got = (await notesOf(priv, ux, tac)).filter((x) => BigInt(x.value) === r.amountOut);
  ok(!r.error && r.ahead === false && await depositStatus(d1.depositId) === 2n && got.length === 1, `the press proves it again and the relay sends it from the open board: a private ${fmtTac(r.amountOut)} TAC note (${r.error ? r.error.message : log.slice(-1)[0]})`);
}

// ── 6. the second: proved ahead, the pool unmoved, the press sends that proof ──
{
  const a2 = await st.proveSwap({ walletPriv: priv, deposit: d2, toTicker: 'cTAC', feeBps, ahead: true, waitOpts: wait });
  const before = log.length;
  const t = Date.now();
  const r = await st.pressSwap({ walletPriv: priv, deposit: d2, toTicker: 'cTAC', feeBps, ready: a2, waitOpts: wait }).catch((e) => ({ error: e }));
  const proved = log.slice(before).filter((l) => /wrapswap.*EXECUTE_OK/.test(l)).length;
  const got = (await notesOf(priv, ux, tac)).filter((x) => BigInt(x.value) === r.amountOut);
  ok(!r.error && r.ahead === true && proved === 0 && await depositStatus(d2.depositId) === 2n && got.length === 1,
    `the press sends the proof made ahead, nothing proved at the press: a private ${fmtTac(r.amountOut)} TAC note, ${Date.now() - t} ms from press to settled here (${r.error ? r.error.message : log.slice(before).join('; ')})`);
}

// ── 7. a private payment from the third to another key, at a receive code that key gave out: the payer never learns the note's nk, the
// receiver finds the note from its key alone and spends it, the change comes back hidden, and nothing secret is in the payment's input ──
{
  const other = crypto.getRandomValues(new Uint8Array(32)), ox = mkUx();
  const code = ox.receiveCode({ walletPriv: other, index: 7 });
  const fee = BigInt(await ux.quoteOpFee('cETH', 'transfer')), give = (d3.wei / 10n ** 10n) * 4n / 10n, rest = d3.wei / 10n ** 10n - give - fee;
  const b = ux.buildWrapTransferOp({ walletPriv: priv, amountWei: d3.wei, ticker: 'cETH', receiveCode: code, amount: give, fee, index: d3.index });
  ok(String(b.depositId).toLowerCase() === String(d3.depositId).toLowerCase() && String(b.op.outputs[0].owner).toLowerCase() === code.split(':')[3].toLowerCase(),
    `the wrap-and-send spends the staged deposit and pays the owner the receiver gave out (${code.slice(0, 22)}…)`);
  const t = Date.now();
  const sub = await ux.relay.submitOp({ type: 'wraptransfer', op: b.op, leaves: b.leaves, outputs: b.outputs, ephRand: b.ephRand, memos: b.memos }, wait).catch((e) => ({ error: e }));
  const stt = sub.error ? sub : await ux.relay.waitForSettle(sub.jobId, wait).catch((e) => ({ error: e }));
  const w3 = ux.buildWrap({ walletPriv: priv, amountWei: d3.wei, ticker: 'cETH', index: d3.index }).note;
  const secrets = [['the payer\'s wallet key', '0x' + Buffer.from(priv).toString('hex')], ['the deposit\'s blinding', w3.blinding], ['the deposit\'s nullifier key', w3.secret],
    ['the payment\'s blinding', b.outputs[0].blinding], ...(b.outputs[1] ? [['the change\'s blinding', b.outputs[1].blinding], ['the change\'s nullifier key', b.outputs[1].secret]] : [])];
  const wire = JSON.stringify(b.op).toLowerCase();
  const leaked = secrets.filter(([, v]) => v && ((lastStdin.wraptransfer || '').includes(BigInt(v).toString(16).padStart(64, '0')) || wire.includes(BigInt(v).toString(16).padStart(64, '0')))).map(([w]) => w);
  ok(!stt.error && lastStdin.wraptransfer && leaked.length === 0, `the relay proves and settles it, its input and the op it was sent hold none of: ${secrets.map(([w]) => w).join(', ')}${leaked.length ? ` (FOUND: ${leaked.join(', ')})` : ''} (${stt.error ? stt.error.message : `${Date.now() - t} ms; ${log.slice(-1)[0]}`})`);
  const got = (await notesOf(other, mkUx(), teth)).filter((x) => BigInt(x.value) === give);
  const change = (await notesOf(priv, mkUx(), teth)).filter((x) => BigInt(x.value) === rest);
  ok(await depositStatus(d3.depositId) === 2n && got.length === 1 && got[0].secret && change.length === 1, `the receiver's fresh wallet finds its ${Number(give) / 1e8} tETH from its key alone, with the nk derived for index 7, and the payer's ${Number(rest) / 1e8} change comes back hidden`);
  if (got[0]) {
    const to = '0x' + 'be'.repeat(20), b0 = BigInt(await rpcA('eth_getBalance', [to, 'latest']));
    const u = await ox.unwrap({ note: got[0], walletPriv: other, recipient: to, waitOpts: wait }).catch((e) => ({ error: e }));
    const paid = BigInt(await rpcA('eth_getBalance', [to, 'latest'])) - b0;
    ok(!u.error && paid > 0n, `and the receiver spends it: the settle program takes the derived nk and the note leaves to an address (${u.error ? u.error.message : `${Number(paid) / 1e18} ETH paid; ${log.slice(-1)[0]}`})`);
  }
}

// ── 8. a note staged by the holder's own machine: its unwrap proved here (the settle guest, as tacit-prover runs it), posted with its recipe,
// sent and activated by the relay, which never receives the op that holds the note's key ──
{
  const index = await ux.nextWrapIndex({ walletPriv: priv, ticker: 'cETH' });
  const w = ux.buildWrap({ walletPriv: priv, amountWei: NOTE, ticker: 'cETH', index });
  await send(FROM, WRAP_TIP, '0xfc24c435' + w.commit.slice(2).padStart(64, '0') + NOTE.toString(16).padStart(64, '0') + TIPTO.slice(2).toLowerCase().padStart(64, '0'), hex(NOTE + 10n ** 14n));
  await ux.submitWrapSettle({ built: w, waitOpts: wait });
  const ox = mkUx();
  let ownStdin = '';
  const own = async ({ type, op, memos: ms }) => {
    const memoHashes = (ms || []).map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`));
    const f = join(tmp, 'own.stdin'), out = join(tmp, 'own.pv');
    const bytes = stdinFor(type, { ...JSON.parse(JSON.stringify(op)), memoHashes });
    ownStdin = Buffer.from(bytes).toString('hex');
    writeFileSync(f, bytes);
    const r = await execGuest({ ...process.env, STDIN: f, OUT: out });
    if (r.status !== 0 || !existsSync(out)) throw new Error('the guest rejected the op');
    return { requestId: 'own-stage', publicValues: `0x${readFileSync(out, 'utf8').trim()}`, proof: '0x' + '00'.repeat(32), private: true };
  };
  own.supports = (t) => t === 'unwrap';
  ox.relay.useProver(own);
  const so = makeConfidentialStage({ ux: ox });
  const note = (await notesOf(priv, ox, teth)).find((x) => BigInt(x.value) * 10n ** 10n === NOTE);
  const seen0 = submitsSeen.length, acts0 = activations.length;
  const r = await so.stageNote({ note, walletPriv: priv, waitOpts: wait }).catch((e) => ({ error: e }));
  const asked = submitsSeen.slice(seen0);
  ok(!r.error && r.own === true && await depositStatus(r.depositId) === 1n, `the holder's machine proves the stage and posts it: the key's deposit of ${Number(r.wei ?? 0n) / 1e18} ETH waits at wrap index ${r.index} (${r.error ? r.error.message : `activated ${String(r.activateTx).slice(0, 10)}…`})`);
  ok(asked.length === 1 && asked[0].mode === 'preproven' && !asked[0].op && asked[0].exit && ownStdin.includes(BigInt(note.secret).toString(16).padStart(64, '0')),
    `the relay was sent only the finished proof and its recipe, never the op holding the note's key, which stayed on this machine (${asked.map((x) => `${x.type}/${x.mode}${x.op ? '+op' : ''}${x.exit ? '+exit' : ''}`).join(', ')})`);
  ok(activations.length === acts0 + 1 && activations[activations.length - 1].cover.ok, 'and the relay activated the recipe of a proof it did not make, its checks reading the recipient and fee from the public values');
}

if (fails) console.error(log.join('\n'));
console.log(`\n${n} passed, ${fails} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
stop();
process.exit(fails ? 1 : 0);
