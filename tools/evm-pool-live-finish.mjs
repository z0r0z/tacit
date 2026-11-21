// Finishes a live check from its saved keys: the owner sweeps her own private ETH address (no keeper, no fee), then
// alice pays bob privately (self-submitted, with change), bob withdraws part to a fresh address through the relayer,
// the chain's view of each step is printed, and everything left returns to the funder.
//   FUNDER_KEY=<0x…> IDS=<tools/.live-check-….json> node tools/evm-pool-live-finish.mjs <chainId> <rpc> <keeper> <deploy block> <unit wei>

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { createPublicClient, createWalletClient, http, defineChain, parseAbi, decodeEventLog } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const snarkjs = require('snarkjs');
const { loadZk } = await import('../worker-relay/src/lib/evm-pool-keeper-prover.js');
const { proveTransact, verifyTransact } = await import('../dapp/evm-pool-zk-prover.js');
const { evmPoolKeys, makeEvmPoolWallet, jsonRpc, sealNote, recipientOf } = await import('../dapp/evm-pool-wallet.js');
const { poolAsset, extDataHash } = await import('../dapp/evm-pool-zk.js');
const { receiveKeys, sweepWitness, RECEIVE_FEE_BPS } = await import('../dapp/evm-pool-gateway.js');

const [chainIdS, RPC, KEEPER, deployS, unitS] = process.argv.slice(2);
const CHAIN = Number(chainIdS), UNIT = BigInt(unitS), DEPLOY = BigInt(deployS);
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const ZERO = '0x0000000000000000000000000000000000000000';
const ART = new URL('../dapp/evm-pool/', import.meta.url).pathname;
const vk = JSON.parse(readFileSync(ART + 'transact_vk.json', 'utf8'));
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const times = [];
const prove = async (input) => { const t = Date.now(); const r = await proveTransact(input, { wasm, zkey, snarkjs }); times.push(Date.now() - t); if (!(await verifyTransact(vk, r.publicSignals, r.proof, { snarkjs }))) throw new Error('bad proof'); return r; };
const chain = defineChain({ id: CHAIN, name: `c${CHAIN}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const walletOf = (k) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(RPC) });
const funder = walletOf(process.env.FUNDER_KEY);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${CHAIN}`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what, ms = 900_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(5000); } };
const eth = (w) => (Number(w) / 1e18).toFixed(7);
const receipt = async (h) => { const r = await pub.waitForTransactionReceipt({ hash: h, timeout: 900_000 }); if (r.status !== 'success') throw new Error('reverted ' + h); return r; };
const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const hexb = (h) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));
const EVENT = parseAbi(['event Transact(bytes32 indexed nf0, bytes32 indexed nf1, bytes32 outLeaf0, bytes32 outLeaf1, uint256 firstIndex, bytes32 newRoot, address recipient, int256 extAmount, address relayer, uint256 fee, bytes memo0, bytes memo1)'])[0];
const TRANSACT = parseAbi(['function transact(uint256[2],uint256[2][2],uint256[2],uint256[11],address,int256,address,uint256,bytes,bytes) payable']);
const TX = '(uint256[2] pA,uint256[2][2] pB,uint256[2] pC,uint256[11] publicInputs,address recipient,int256 extAmount,address relayer,uint256 fee,bytes memo0,bytes memo1)';
const SWEEP = parseAbi([`function sweepReceive(uint256 npk, uint16 feeBps, ${TX} t)`, 'function receiveCount(address) view returns (uint256)', 'function nextIndex() view returns (uint256)']);
const asset = poolAsset({ chainId: BigInt(CHAIN), pool: POOL, token: ZERO });
const zk = await loadZk();

async function leavesNow() {
  const want = Number(await pub.readContract({ address: POOL, abi: SWEEP, functionName: 'nextIndex' }));
  for (let tries = 0; ; tries++) {
    const head = await pub.getBlockNumber(); const logs = [];
    for (let a = DEPLOY; a <= head; a += 2000n) logs.push(...await pub.getLogs({ address: POOL, event: EVENT, fromBlock: a, toBlock: a + 1999n > head ? head : a + 1999n }));
    const out = [];
    for (const l of logs.sort((x, y) => Number(x.args.firstIndex - y.args.firstIndex))) if (BigInt(l.args.outLeaf0) || BigInt(l.args.outLeaf1)) out.push(BigInt(l.args.outLeaf0), BigInt(l.args.outLeaf1));
    if (out.length >= want) return out;
    if (tries > 30) throw new Error('logs behind the pool'); await sleep(3000);
  }
}
const proofArgs = (proof) => [[proof.pi_a[0], proof.pi_a[1]].map(BigInt), [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]].map((r) => r.map(BigInt)), [proof.pi_c[0], proof.pi_c[1]].map(BigInt)];
const stale = (e) => /StaleRoot|WrongInsertionIndex|BadIntent|0x607447de|0xa151b2a2/.test(String(e.shortMessage || e.message) + String(e.cause?.raw || e.cause?.signature || ''));

const ids = JSON.parse(readFileSync(process.env.IDS, 'utf8'));
const cfg = { chainId: CHAIN, pool: POOL, router: ROUTER, rpc: jsonRpc(RPC), deployBlock: Number(DEPLOY), confirmations: 0, logChunk: 2000 };
const person = (k) => { const keys = evmPoolKeys(zk, hexb(k)); return { keys, w: makeEvmPoolWallet({ zk, keys, chain: cfg, keeper: KEEPER, prove }) }; };
const P = Object.fromEntries(['alice', 'carol', 'dave', 'erin', 'bob'].map((n) => [n, person(ids[n])]));
const aliceEoa = walletOf(ids.aliceEoa);
const freshAddr = privateKeyToAccount(ids.fresh).address;
const self = (p) => ({ V: p.keys.V, A: p.keys.A, N: p.keys.N });
const shown = [];

// Erin sweeps her own private ETH address: no keeper, no fee, submitted from any account (here the funder).
{
  const box = P.erin.w.receiveBox;
  const bal = await pub.getBalance({ address: box });
  if (bal > 0n) {
    const npk = receiveKeys(zk, P.erin.keys.zkWallet, 0).npk;
    for (let round = 0; round < 4; round++) {
      const n = await pub.readContract({ address: ROUTER, abi: SWEEP, functionName: 'receiveCount', args: [box] });
      const w = sweepWitness(zk, { asset, leaves: await leavesNow(), npk, feeBps: RECEIVE_FEE_BPS, box, n, amount: bal, fee: 0n, chainId: CHAIN, pool: POOL });
      const { proof, publicSignals } = await prove(w.input);
      const [pA, pB, pC] = proofArgs(proof);
      const t = { pA, pB, pC, publicInputs: publicSignals.map(BigInt), recipient: ZERO, extAmount: bal, relayer: ZERO, fee: 0n, memo0: '0x', memo1: '0x' };
      try { await pub.simulateContract({ address: ROUTER, abi: SWEEP, functionName: 'sweepReceive', args: [npk, RECEIVE_FEE_BPS, t], account: funder.account }); }
      catch (e) { if (stale(e) && round < 3) { log('   pool moved, proving again'); continue; } throw e; }
      const r = await receipt(await funder.writeContract({ address: ROUTER, abi: SWEEP, functionName: 'sweepReceive', args: [npk, RECEIVE_FEE_BPS, t] }));
      shown.push(['erin sweeps her own address (no fee)', r.transactionHash]);
      log(`erin swept her own private address herself, no fee: ${eth(bal)} ETH (gas ${r.gasUsed}) ${r.transactionHash}`);
      break;
    }
  }
  if (bal > 0n || (await P.erin.w.sync()).balance > 0n) {
    const e = await until(async () => { const x = await P.erin.w.sync(); return x.balance > 0n && x; }, 'erin finds her note');
    log(`  erin holds ${eth(e.balance)} ETH, found from her keys and the router's Received event`);
  }
}

// Alice pays bob 2u privately from her 5u note, keeping 3u, proved and submitted by alice.
await P.alice.w.sync();
const aliceNote = P.alice.w.notes()[0];
const pay = 2n * UNIT;
for (let round = 0; round < 4; round++) {
  const sealed = [sealNote(zk, { to: recipientOf(P.alice.keys, P.bob.w.address), value: pay, asset }), sealNote(zk, { to: self(P.alice), value: BigInt(aliceNote.v) - pay, asset })];
  const eh = extDataHash({ chainId: BigInt(CHAIN), pool: POOL, recipient: ZERO, extAmount: 0n, relayer: ZERO, fee: 0n, memo0: sealed[0].memo, memo1: sealed[1].memo });
  const w = zk.buildWitness({ asset, leaves: await leavesNow(), inputs: [{ v: BigInt(aliceNote.v), rho: BigInt(aliceNote.rho), nk: BigInt(aliceNote.nk), sk: BigInt(aliceNote.sk), index: aliceNote.index }, { dummy: true }], outputs: sealed.map((o) => ({ v: o.v, npk: o.npk, rho: o.rho })), extAmount: 0n, fee: 0n, extDataHash: eh });
  const { proof, publicSignals } = await prove(w.input);
  const args = [...proofArgs(proof), publicSignals.map(BigInt), ZERO, 0n, ZERO, 0n, hex(sealed[0].memo), hex(sealed[1].memo)];
  try { await pub.simulateContract({ address: POOL, abi: TRANSACT, functionName: 'transact', args, account: aliceEoa.account }); }
  catch (e) { if (stale(e) && round < 3) { log('   pool moved, proving again'); continue; } throw e; }
  const r = await receipt(await aliceEoa.writeContract({ address: POOL, abi: TRANSACT, functionName: 'transact', args }));
  shown.push(['alice pays bob privately (self-submitted)', r.transactionHash]);
  log(`alice paid bob ${eth(pay)} ETH privately, keeping ${eth(BigInt(aliceNote.v) - pay)} change (gas ${r.gasUsed}) ${r.transactionHash}`);
  break;
}
const bobBal = (await until(async () => { const x = await P.bob.w.sync(); return x.balance > 0n && x; }, 'bob finds the payment')).balance;
log(`  bob found ${eth(bobBal)} ETH by scanning with his view key`);

// Bob withdraws part of it to a fresh address through the relayer (no gas of his own).
const fee = BigInt((await P.bob.w.quote()).fee);
const part = bobBal - fee > UNIT ? UNIT : bobBal - fee - 1n;
const r3 = await receipt(await P.bob.w.withdraw({ to: freshAddr, amount: part }));
shown.push(['bob withdraws to a fresh address (relayed)', r3.transactionHash]);
const got = await until(async () => { const b = await pub.getBalance({ address: freshAddr }); return b >= part && b; }, 'fresh balance', 120_000).catch(() => 0n);
log(`bob withdrew ${eth(part)} ETH to fresh ${freshAddr} through the relayer (fee ${eth(fee)}): it received ${eth(got)} ${got === part ? '(exact)' : '(MISMATCH)'}`);

log('what the chain shows:');
for (const [what, h] of shown) {
  const [tx, rc] = await Promise.all([pub.getTransaction({ hash: h }), pub.getTransactionReceipt({ hash: h })]);
  const ev = rc.logs.filter((l) => l.address.toLowerCase() === POOL.toLowerCase()).map((l) => decodeEventLog({ abi: [EVENT], data: l.data, topics: l.topics }).args)[0];
  log(`  ${what}: sender ${tx.from.slice(0, 10)}… · nullifiers ${[ev.nf0, ev.nf1].map((x) => x.slice(0, 10)).join(' ')} · new leaves ${[ev.outLeaf0, ev.outLeaf1].map((x) => x.slice(0, 10)).join(' ')} · pays ${ev.recipient.slice(0, 10)}… ${eth(ev.extAmount < 0n ? -ev.extAmount : ev.extAmount)} · encrypted memos ${(ev.memo0.length - 2) / 2}+${(ev.memo1.length - 2) / 2} bytes`);
}
const leaves = await leavesNow();
log(`  bob's withdrawal spends a note by nullifier only: it names no leaf, no depositor and no sender; the pool holds ${leaves.filter((x) => x !== 0n).length} notes from ${new Set(shown.map(([w]) => w.split(' ')[0])).size + 2} different people, any of which could have funded it`);

for (const n of ['alice', 'carol', 'dave', 'erin', 'bob']) {
  const b = (await P[n].w.sync()).balance;
  const f = BigInt((await P[n].w.quote()).fee);
  if (b > f + 1n) { await receipt(await P[n].w.withdraw({ to: funder.account.address, amount: b - f - 1n })); log(`  returned ${n}'s ${eth(b - f - 1n)} ETH`); }
}
for (const k of [ids.aliceEoa, ids.carolEoa, ids.daveEoa]) {
  const w = walletOf(k); const bal = await pub.getBalance({ address: w.account.address });
  const cost = (await pub.getGasPrice()) * 3n * 60_000n + 10n ** 12n;
  if (bal > cost) await receipt(await w.sendTransaction({ to: funder.account.address, value: bal - cost, gas: 60_000n }));
}
const s = times.sort((a, b) => a - b);
log(`done · ${s.length} proofs on this machine, median ${(s[s.length >> 1] / 1000).toFixed(1)}s`);
process.exit(0);
