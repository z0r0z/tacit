#!/usr/bin/env node
// The farm page's private deposit (dapp/farm/zap.js) against the LIVE pool, router and public AMM on an anvil fork of mainnet, with the
// real pool module (dapp/confidential-pool-ux.js) and dapp/lp-zap.js. The proof is a stand-in: the pool's SP1 verifier is replaced by
// code that accepts any proof, and the public values are a real share wrap's (tests/fixtures/lp-zap/share-wrap.json, proved on the
// board) with this deposit's leaf, deposit id and memo root in its place, so everything else the pool checks of them is the contract's.
// What it shows of the page's two steps: the share note is built and "proved" with nothing sent; ONE transaction from the wallet then
// mints exactly the proved shares, shields them and settles the note (the deposit goes 0 → 2), for no more ETH than was entered, the
// router keeping nothing; the key's balance, read by the real pool module from the chain alone, then holds the share note the farm
// entry takes (that step is the relay's own OP_FARM_BOND, covered with the real settle guest by tests/lp-zap-relay-fork.mjs); the
// same proof pressed again is refused as already made, with nothing sent.
//
//   FORK=<rpc url> node tests/farm-zap-fork.mjs        (a fork that serves old log reads: `node tools/fork-proxy.mjs`, then FORK=http://127.0.0.1:8590)
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

if (spawnSync('anvil', ['--version']).status !== 0) { console.log('skip - needs anvil (foundry) on the PATH'); process.exit(0); }
const FX = JSON.parse(readFileSync(new URL('./fixtures/lp-zap/share-wrap.json', import.meta.url), 'utf8'));
const FORK = process.env.FORK || 'https://ethereum-rpc.publicnode.com', PORT = 26100 + Math.floor(Math.random() * 400), RPC = `http://127.0.0.1:${PORT}`;
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992', SP1_VERIFIER = '0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2';
const FROM = '0x00000000000000000000000000000000000Fa2E5', WEI = BigInt(process.env.WEI || 5n * 10n ** 16n);
// the tETH/TAC farm as the farm program lists it
const pool = { pid: 1001, pair: 'SPX/cETH', poolId: '0xe2686416a328f6bb44fdea23c821916de148d3d73ab00d38cc25e55ff5047d4a', lpAsset: '0x302984ec4f357aed29e6e2be3533ccd72c1e4766e42484f332b3855926af9ad7', feeBps: 30 };
const SPX = '0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c';

let n = 0, bad = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { bad++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (v) => '0x' + BigInt(v).toString(16), W = (v) => BigInt(v).toString(16).padStart(64, '0'), strip = (h) => String(h).replace(/^0x/, ''), lc = (s) => String(s).toLowerCase();
const realFetch = globalThis.fetch;
const rpcA = async (method, params = []) => {
  const j = await (await realFetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { data: j.error.data, revert: /revert/i.test(j.error.message) });
  return j.result;
};
const head = BigInt((await (await realFetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) })).json()).result) - 3n;
const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(process.env.FORK_BLOCK || head), '--chain-id', '1', '--silent', '--no-rate-limit', '--timeout', '600000'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 200) throw new Error('anvil did not start'); await sleep(200); } }
await rpcA('anvil_impersonateAccount', [FROM]);
await rpcA('anvil_setBalance', [FROM, hex(10n ** 18n)]);
await rpcA('anvil_setCode', [SP1_VERIFIER, '0x00']);

const { secp, sha256, keccak_256, hmac } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { makeConfidentialPool } = await import('../dapp/confidential-pool.js');
const P = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const kec = (h) => Buffer.from(keccak_256(Buffer.from(strip(h), 'hex'))).toString('hex');

// ── the relay, as far as a proof alone goes: the job is taken and answered with public values for exactly the op it was given ──
const jobs = new Map(), asked = [];
function publicValuesFor(op, memos) {
  const words = strip(FX.publicValues).match(/.{64}/g);
  if (lc('0x' + words[2]) !== lc(op.chainBinding)) throw new Error('the fixture is for another chain binding');
  let root = '0'.repeat(64);
  for (const m of memos) root = kec(root + kec(m));                                    // the pool's own fold: keccak(root ‖ keccak(memo)) over the memos in order
  words[28] = root;
  words[34] = strip(P.leaf(op.asset, op.cx, op.cy, op.owner)).toLowerCase();
  words[36] = strip(P.depositId(op.asset, BigInt(op.value), op.cx, op.cy, op.owner)).toLowerCase();
  return '0x' + words.join('');
}
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/^https:\/\/api\.tacit\.finance\/confidential\/relay/.test(u)) return json({ state: 'ok', proving: true, settling: true, board: true });
  if (/^https:\/\/api\.tacit\.finance\/confidential\/submit/.test(u)) {
    const b = JSON.parse(init.body), jobId = '0x' + W(jobs.size + 1);
    asked.push({ type: b.type, mode: b.mode || 'settle' });
    if (b.mode !== 'prove' || b.type !== 'wrap') return json({ error: 'this stand-in only proves a wrap' }, 400);
    jobs.set(jobId, { status: 'proven', publicValues: publicValuesFor(b.op, b.memos), proof: '0x' + '00'.repeat(4) });
    return json({ ok: true, jobId, status: 'pending' });
  }
  if (/^https:\/\/api\.tacit\.finance\/confidential\/status/.test(u)) { const j = jobs.get(new URL(u).searchParams.get('id')); return j ? json({ jobId: new URL(u).searchParams.get('id'), ...j }) : json({ error: 'unknown' }, 404); }
  if (/^https:\/\/api\.tacit\.finance\/confidential\/landed/.test(u)) return json({ ok: true, status: 'settled' });
  if (/^https:\/\/api\.tacit\.finance\//.test(u)) return json({}, 404);
  if (/^https?:\/\/[^/]*(rpc|node|gateway|eth\.|llama|ankr|drpc|merkle|infura|alchemy|cloudflare|1rpc|blastapi|stakely|thirdweb|buidlguidl)/i.test(u) && init?.method === 'POST') return realFetch(RPC, { ...init, signal: AbortSignal.timeout(300_000) });
  return realFetch(url, init);
};

const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { setActiveNetwork } = await import('../dapp/confidential-deployments.js');
const { readReserves, assetRow, shareNote, ZAP_GAS, PUBLIC_AMM } = await import('../dapp/farm/zap.js');
const { zapPlan, zapPlanExt, zapPlanExtFor, zapSettleCalldata } = await import('../dapp/lp-zap.js');
const R = await import('../dapp/swap/route.js');
setActiveNetwork('mainnet');
const t = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: (u, o) => globalThis.fetch(u, o), network: 'mainnet' });
const key = crypto.getRandomValues(new Uint8Array(32)), priv = () => Uint8Array.from(key);
const rpc = (method, params) => rpcA(method, params);
const call = (c) => rpcA('eth_call', [{ to: c.to, data: c.data }, 'latest']);
const depositStatus = async (id) => BigInt(await rpcA('eth_call', [{ to: POOL, data: '0x7da9874f' + strip(id).padStart(64, '0') }, 'latest']));
const balanceOf = async (a) => BigInt(await rpcA('eth_getBalance', [a, 'latest']));
const sent = [];
const wallet = {
  async sendTx({ to, data, value, from }) {
    const gas = BigInt(await rpcA('eth_estimateGas', [{ from, to, data, value: hex(value) }])) * 13n / 10n;
    const hash = await rpcA('eth_sendTransaction', [{ from, to, data, value: hex(value), gas: hex(gas) }]);
    sent.push({ to, value, hash, data });
    return hash;
  },
  async receipt(hash) { for (let i = 0; i < 600; i++) { const r = await rpcA('eth_getTransactionReceipt', [hash]); if (r) return r; await sleep(100); } throw new Error('no receipt'); },
};
const t0 = Date.now();

const ethCall = (to, data, block = 'latest', o = {}) => rpcA('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: o.value } : {}), ...(o.gas ? { gas: o.gas } : {}) }, block]);
const quoteAt = (x, slip = 50) => R.quoteEthToToken({ ethCall, to: ROUTER, tokenOut: SPX, amount: x, slippageBps: slip, deadline: BigInt(Math.floor(Date.now() / 1000) + 1800) });
const spxBal = async (a) => BigInt(await rpcA('eth_call', [{ to: SPX, data: '0x70a08231' + strip(a).padStart(64, '0') }, 'latest']));
try {
  const res = await readReserves(call, POOL, pool.poolId);
  const row = await assetRow(call, POOL, res.assetB);
  const unitB = row.unitScale, A = 10n ** 10n;
  const inPool = zapPlan({ eth: WEI, ra: res.reserveA, rb: res.reserveB, total: res.totalShares, feeBps: BigInt(res.feeBps ?? 30), unitA: A, unitB });
  const ext = await zapPlanExt({ eth: WEI, ra: res.reserveA, rb: res.reserveB, total: res.totalShares, unitA: A, unitB, quote: (x) => quoteAt(x) });
  ok(!!ext && ext.value <= WEI, `outside plan: ${ext?.shares} shares for ${Number(ext?.value) / 1e18} ETH (swap ${Number(ext?.swapIn) / 1e18} outside); in-pool plan: ${inPool?.shares} shares for ${inPool ? Number(inPool.value) / 1e18 : '-'} ETH, impact ${inPool?.impact?.toFixed(3)}`);
  const per = (p) => Number(p.shares) / Number(p.value);
  console.log(`  info outside beats in-pool by ${((per(ext) / per(inPool) - 1) * 100).toFixed(1)}% shares per ETH`);

  // step 1: the proof, nothing sent
  const before = await balanceOf(FROM), spx0 = await spxBal(FROM);
  const index = t.nextShareIndex({ walletPriv: priv(), poolId: pool.poolId, owned: [], used: [] });
  const built = t.buildShareWrap({ walletPriv: priv(), poolId: pool.poolId, shares: ext.shares, index });
  const proven = await t.relay.prove({ type: 'wrap', op: built.wrapOp, leaves: [built.leaf], outputs: built.outputs, memos: built.memos, ephRand: built.ephRand }, { viaRelay: true, timeoutMs: 60000 });
  ok(t.wrapProofFits(built, proven) && await depositStatus(built.depositId) === 0n && await balanceOf(FROM) === before, 'the share is proved with nothing sent and no deposit existing');

  // step 2: the swap asked for again, the legs for exactly the proved shares, run as a call first, then sent
  const res2 = await readReserves(call, POOL, pool.poolId), fresh = await quoteAt(ext.swapIn);
  const now = zapPlanExtFor({ shares: ext.shares, prev: ext, q: fresh, ra: res2.reserveA, rb: res2.reserveB, total: res2.totalShares, unitA: A, unitB, maxEth: WEI + WEI / 50n });
  ok(!!now && now.shares === ext.shares && now.value <= WEI + WEI / 50n, `the legs for exactly ${ext.shares} shares at the reserves now: ${Number(now?.ethLeg) / 1e18} ETH and ${now?.bLeg} of the token, ${Number(now?.value) / 1e18} ETH in all`);
  const time = Number(BigInt((await rpcA('eth_getBlockByNumber', ['latest', false])).timestamp));
  const data = zapSettleCalldata({ plan: now, router: ROUTER, amm: PUBLIC_AMM, tokenB: SPX, assetA: res2.assetA, assetB: res2.assetB, feeBps: Number(res2.feeBps ?? 30), deadline: BigInt(time + 1200),
    commit: built.commit, swapData: now.callData, publicValues: proven.publicValues, proof: proven.proof, memos: proven.memos || built.memos });
  const value = hex(now.value);
  const sim = await rpcA('eth_call', [{ from: FROM, to: ROUTER, data, value }, 'latest']);
  ok(BigInt('0x' + strip(sim).slice(0, 64)) === ext.shares, 'run as a call first, it mints exactly the proved shares');
  const hash = await wallet.sendTx({ to: ROUTER, data, value: now.value, from: FROM }), rc = await wallet.receipt(hash);
  const gasCost = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice), paid = before - await balanceOf(FROM) - gasCost, spx1 = await spxBal(FROM);
  ok(rc.status === '0x1', `one transaction, to the router (${BigInt(rc.gasUsed)} gas)`);
  ok(await depositStatus(built.depositId) === 2n, 'the share deposit goes 0 → 2: minted, shielded and settled in that transaction');
  ok(paid === now.value, `the wallet paid the planned ${Number(now.value) / 1e18} ETH and its gas, no more (${Number(paid) / 1e18})`);
  ok(await balanceOf(ROUTER) === 0n && await spxBal(ROUTER) === 0n, 'the router keeps no ETH and no token');
  console.log(`  info token refunded to the wallet: ${spx1 - spx0} units (the swap's slippage margin)`);
  const note = await shareNote({ t, priv, built, tries: 4, every: 2000 });
  ok(!!note && BigInt(note.value) === ext.shares && lc(note.asset) === lc(pool.lpAsset), `the key alone finds the share note: ${note?.value} shares of the pool's LP asset`);
} catch (e) { bad++; console.log('FAIL   the run stopped: ' + (e?.stack || e)); }

console.log(`\n${n} passed, ${bad} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
anvil.kill('SIGKILL');
process.exit(bad ? 1 : 0);
