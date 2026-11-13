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
const FROM = '0x00000000000000000000000000000000000Fa2E5', WEI = 5n * 10n ** 16n;
// the tETH/TAC farm as the farm program lists it
const pool = { pid: 0, pair: 'TAC/cETH', poolId: '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00', lpAsset: '0x17c56713a7e4a5d679a71def3ff9fa186f1556ef757b0ee6b7a3ed8c9249ef99', feeBps: 30, lockSeconds: 0, totalShares: '74648514809', tacPerDayForPool: '553.8888' };

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
const { readReserves, zapQuote, zapProve, zapSend, shareNote, looseOf, ZAP_GAS } = await import('../dapp/farm/zap.js');
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

try {
  ok(lc(t.cfg.router) === lc(ROUTER) && lc(t.cfg.pool) === lc(POOL), 'the pool module names the live pool and router');
  const q = await zapQuote({ pool, wei: WEI, reserves: () => readReserves(call, POOL, pool.poolId), gasPrice: () => rpcA('eth_gasPrice').then(BigInt), balance: () => balanceOf(FROM), tacEth: 0.00014 });
  ok(!!q.plan && q.plan.value <= WEI && q.plan.shares > 0n && !q.over, `0.05 ETH is priced at the pool’s reserves now: ${q.plan?.shares} shares for ${Number(q.plan?.value) / 1e18} ETH, the swap moving the price ${q.impact.toFixed(2)}%`);
  const res = await t.poolReserves(pool.poolId);
  ok(res.reserveA === q.res.reserveA && res.reserveB === q.res.reserveB && res.totalShares === q.res.totalShares && lc(res.assetA) === lc(q.res.assetA), 'the one call the quote reads the reserves with agrees with the pool module’s');

  // step 1: the proof, with nothing sent
  const before = await balanceOf(FROM), says = [];
  const ready = await zapProve({ t, priv, pool, q, owned: async () => [], say: (k) => says.push(k) });
  ok(asked.length === 1 && asked[0].type === 'wrap' && asked[0].mode === 'prove', 'the relay is asked for one proof, of a wrap, and to send nothing');
  ok(ready.shares === q.plan.shares && await depositStatus(ready.built.depositId) === 0n && await balanceOf(FROM) === before && sent.length === 0, 'with the proof in hand nothing has left the wallet and no deposit exists');
  ok(t.wrapProofFits(ready.built, ready.proven), 'the proof is for this share note: its leaf and its deposit');

  // step 2: the one transaction
  const out = await zapSend({ t, rpc, wallet, from: FROM, pool, ready, say: (k) => says.push(k) });
  const rc = await rpcA('eth_getTransactionReceipt', [out.hash]), gasUsed = BigInt(rc.gasUsed), paid = before - await balanceOf(FROM), gasCost = gasUsed * BigInt(rc.effectiveGasPrice);
  ok(rc.status === '0x1' && sent.length === 1 && lc(sent[0].to) === lc(ROUTER) && sent[0].data.startsWith('0xc4294fac'), `one transaction, to the router’s zap (${gasUsed} gas)`);
  // (the verifier here is a stand-in that costs nothing: the live one's check of a proof is about 270,000 gas more)
  ok(gasUsed + 300000n <= ZAP_GAS, `inside the gas the page reckons its fee and its balance check with (${gasUsed} here and the proof’s verification on top, of ${ZAP_GAS})`);
  ok(await depositStatus(ready.built.depositId) === 2n, 'the share deposit goes 0 → 2: minted, shielded and settled into the private note in that transaction');
  ok(JSON.stringify(rc.logs).toLowerCase().includes(strip(ready.built.leaf).toLowerCase()), 'the share note’s leaf is inserted');
  ok(out.value <= WEI + WEI / 50n && paid - gasCost <= out.value && paid - gasCost > out.value * 99n / 100n, `the wallet paid the planned ${Number(out.value) / 1e18} ETH and its gas, no more (${Number(paid - gasCost) / 1e18} ETH went in of 0.05 entered)`);
  ok(await balanceOf(ROUTER) === 0n, 'the router keeps no ETH');
  ok(says.join() === 'prepare,proving,check,confirm,sent', `the steps were said in order (${says.join(', ')})`);

  // the key alone finds the share: what the farm entry takes
  const note = await shareNote({ t, priv, built: ready.built, tries: 4, every: 2000 });
  ok(!!note && BigInt(note.value) === ready.shares && lc(note.asset) === lc(pool.lpAsset) && lc(note.owner) === lc(ready.built.note.owner), `the key’s balance, read from the chain, holds the share note: ${note?.value} shares of the pool’s LP asset (${Math.round((Date.now() - t0) / 1000)} s)`);
  const loose = looseOf(note ? [note] : [], [pool, { pid: 1, lpAsset: '0x' + 'd6'.repeat(32) }]);
  ok(loose.length === 1 && loose[0].pool.pid === 0 && loose[0].note === note, 'and the page lists it as a share that is in no farm yet, under its farm');
  ok(note && note.leafIndex != null && note.path && note.root && note.blinding && note.secret, 'with what a farm entry spends it by: its place in the tree, its path and its opening');

  // the same proof pressed again
  let again = null;
  try { await zapSend({ t, rpc, wallet, from: FROM, pool, ready }); } catch (e) { again = e; }
  ok(again?.already === true && sent.length === 1, `the same proof pressed again sends nothing: ${again?.message}`);
} catch (e) { bad++; console.log('FAIL   the run stopped: ' + (e?.stack || e)); }

console.log(`\n${n} passed, ${bad} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
anvil.kill('SIGKILL');
process.exit(bad ? 1 : 0);
