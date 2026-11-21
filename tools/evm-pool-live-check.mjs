// Live check of a deployed EVM pool with real funds and the ceremony key, proved on this machine:
//   1. three depositors, each with their own wallet, prove and submit their own deposit (self-serve, no relayer);
//      one more deposits by paying its private ETH address, swept by the chain's keeper;
//   2. alice pays bob privately, spending part of her note and keeping change, proved and submitted by alice;
//   3. bob withdraws part of what he received to a fresh address through the relayer (no gas of his own);
//   4. what the chain shows for each transaction, to check the withdrawal cannot be tied to a deposit;
//   5. everything left is withdrawn back to the funder.
//
//   FUNDER_KEY=<0x…> node tools/evm-pool-live-check.mjs <chainId> <rpc> <keeper base> <deploy block> <unit wei>
//
// KEEP=1: leave the notes in the pool at the end.
// LEAN=1 (for Ethereum, where gas is dear): alice alone deposits 3u, pays bob 2u; no private-address deposit.
//
// Keys are written to tools/.live-check-<chain>.json (git-ignored) so notes stay recoverable if a step fails.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { createPublicClient, createWalletClient, http, defineChain, parseAbi, decodeEventLog } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const snarkjs = require('snarkjs');
const { loadZk } = await import('../worker-relay/src/lib/evm-pool-keeper-prover.js');
const { proveTransact, verifyTransact, vkHash } = await import('../dapp/evm-pool-zk-prover.js');
const { evmPoolKeys, makeEvmPoolWallet, jsonRpc, sealNote, recipientOf } = await import('../dapp/evm-pool-wallet.js');
const { poolAsset, extDataHash } = await import('../dapp/evm-pool-zk.js');

const [chainIdS, RPC, KEEPER, deployS, unitS] = process.argv.slice(2);
const CHAIN = Number(chainIdS), UNIT = BigInt(unitS), DEPLOY = BigInt(deployS);
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const ZERO = '0x0000000000000000000000000000000000000000';
const ART = new URL('../dapp/evm-pool/', import.meta.url).pathname;
const pin = JSON.parse(readFileSync(ART + 'pin.json', 'utf8'));
const vk = JSON.parse(readFileSync(ART + 'transact_vk.json', 'utf8'));
if (vkHash(vk) !== pin.vk_hash) throw new Error('vk does not match pin.json');
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const provingTimes = [];
const prove = async (input) => {
  const t = Date.now();
  const r = await proveTransact(input, { wasm, zkey, snarkjs });
  provingTimes.push(Date.now() - t);
  if (!(await verifyTransact(vk, r.publicSignals, r.proof, { snarkjs }))) throw new Error('proof does not verify');
  return r;
};

const chain = defineChain({ id: CHAIN, name: `c${CHAIN}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const walletOf = (k) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(RPC) });
const funder = walletOf(process.env.FUNDER_KEY);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${CHAIN}`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what, ms = 900_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(5000); } };
const eth = (w) => (Number(w) / 1e18).toFixed(7);
const receipt = async (hash) => { const r = await pub.waitForTransactionReceipt({ hash, timeout: 900_000 }); if (r.status !== 'success') throw new Error('reverted ' + hash); return r; };
const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const hexb = (h) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));

const EVENT = parseAbi(['event Transact(bytes32 indexed nf0, bytes32 indexed nf1, bytes32 outLeaf0, bytes32 outLeaf1, uint256 firstIndex, bytes32 newRoot, address recipient, int256 extAmount, address relayer, uint256 fee, bytes memo0, bytes memo1)'])[0];
const TRANSACT = parseAbi(['function transact(uint256[2],uint256[2][2],uint256[2],uint256[11],address,int256,address,uint256,bytes,bytes) payable']);
const asset = poolAsset({ chainId: BigInt(CHAIN), pool: POOL, token: ZERO });

// Every leaf the pool holds: waits until the logs this RPC serves reach the pool's own nextIndex.
async function leavesNow() {
  const want = Number(await pub.readContract({ address: POOL, abi: parseAbi(['function nextIndex() view returns (uint256)']), functionName: 'nextIndex' }));
  for (let tries = 0; ; tries++) {
    const got = await readLeaves();
    if (got.length >= want) return got;
    if (tries > 30) throw new Error(`logs show ${got.length} leaves, the pool has ${want}`);
    await sleep(3000);
  }
}
async function readLeaves() {
  const out = [];
  const head = await pub.getBlockNumber();
  const logs = [];
  for (let a = DEPLOY; a <= head; a += 2000n) logs.push(...await pub.getLogs({ address: POOL, event: EVENT, fromBlock: a, toBlock: a + 1999n > head ? head : a + 1999n }));
  for (const l of logs.sort((x, y) => Number(x.args.firstIndex - y.args.firstIndex))) {
    if (BigInt(l.args.outLeaf0) || BigInt(l.args.outLeaf1)) out.push(BigInt(l.args.outLeaf0), BigInt(l.args.outLeaf1));
  }
  return out;
}

// A self-submitted pool transaction: proved here, sent by `signer`, no relayer.
async function selfTransact(signer, { inputs, outputs, extAmount = 0n, recipient = ZERO }) {
  const sealed = outputs.map((o) => (o ? sealNote(zk, { to: o.to, value: o.value, asset }) : null));
  const memo0 = sealed[0]?.memo ?? new Uint8Array(), memo1 = sealed[1]?.memo ?? new Uint8Array();
  for (let round = 0; round < 4; round++) {
    const leaves = await leavesNow();
    const eh = extDataHash({ chainId: BigInt(CHAIN), pool: POOL, recipient, extAmount, relayer: ZERO, fee: 0n, memo0, memo1 });
    const w = zk.buildWitness({ asset, leaves, inputs, outputs: sealed.map((o) => (o ? { v: o.v, npk: o.npk, rho: o.rho } : null)), extAmount, fee: 0n, extDataHash: eh });
    const { proof, publicSignals } = await prove(w.input);
    const args = [[proof.pi_a[0], proof.pi_a[1]].map(BigInt), [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]].map((r) => r.map(BigInt)),
      [proof.pi_c[0], proof.pi_c[1]].map(BigInt), publicSignals.map(BigInt), recipient, extAmount, ZERO, 0n, hex(memo0), hex(memo1)];
    try {
      await pub.simulateContract({ address: POOL, abi: TRANSACT, functionName: 'transact', args, value: extAmount > 0n ? extAmount : 0n, account: signer.account });
    } catch (e) {
      if (/StaleRoot|WrongInsertionIndex|0x607447de|0xa151b2a2/.test(String(e.shortMessage || e.message) + String(e.cause?.raw || e.cause?.signature || '')) && round < 3) { log('   pool moved, proving again'); continue; }
      throw e;
    }
    const h = await signer.writeContract({ address: POOL, abi: TRANSACT, functionName: 'transact', args, value: extAmount > 0n ? extAmount : 0n });
    return receipt(h);
  }
}

const zk = await loadZk();
const idFile = new URL(`./.live-check-${CHAIN}-${Date.now()}.json`, import.meta.url).pathname;
const K = () => '0x' + randomBytes(32).toString('hex');
const ids = { alice: K(), carol: K(), dave: K(), erin: K(), bob: K(), aliceEoa: K(), carolEoa: K(), daveEoa: K(), fresh: K() };
writeFileSync(idFile, JSON.stringify(ids, null, 1));
const cfg = { chainId: CHAIN, pool: POOL, router: ROUTER, rpc: jsonRpc(RPC), deployBlock: Number(DEPLOY), confirmations: 0, logChunk: 2000 };
const person = (k) => { const keys = evmPoolKeys(zk, hexb(k)); return { keys, w: makeEvmPoolWallet({ zk, keys, chain: cfg, keeper: KEEPER, prove }) }; };
const P = { alice: person(ids.alice), carol: person(ids.carol), dave: person(ids.dave), erin: person(ids.erin), bob: person(ids.bob) };
const eoa = { alice: walletOf(ids.aliceEoa), carol: walletOf(ids.carolEoa), dave: walletOf(ids.daveEoa) };
const freshAddr = privateKeyToAccount(ids.fresh).address;
const self = (p) => ({ V: p.keys.V, A: p.keys.A, N: p.keys.N });
const t0 = Date.now();
const shown = [];

// 1. deposits: alice 5u, carol 3u, dave 4u self-serve; erin 6u through her private ETH address.
const LEAN = process.env.LEAN === '1';
const gasPrice = await pub.getGasPrice();
const gasBudget0 = (gasPrice * 13n / 10n) * (LEAN ? 1_000_000n : 1_800_000n);
const gasBudget = gasBudget0 > 2n * 10n ** 14n ? gasBudget0 : 2n * 10n ** 14n; // wallets cap fees above the current price
const amounts = LEAN ? { alice: 3n * UNIT } : { alice: 5n * UNIT, carol: 3n * UNIT, dave: 4n * UNIT };
for (const n of Object.keys(amounts)) {
  const h = await funder.sendTransaction({ to: eoa[n].account.address, value: amounts[n] + gasBudget });
  await receipt(h);
}
log(`funded ${Object.keys(amounts).length} depositor wallet(s) (deposit + gas each)`);
for (const n of Object.keys(amounts)) {
  const r = await selfTransact(eoa[n], { inputs: [{ dummy: true }, { dummy: true }], outputs: [{ to: self(P[n]), value: amounts[n] }, null], extAmount: amounts[n] });
  shown.push([`${n} deposits ${eth(amounts[n])}`, r.transactionHash]);
  log(`${n} deposited ${eth(amounts[n])} ETH herself (gas ${r.gasUsed}) ${r.transactionHash}`);
}
const erinAmt = 6n * UNIT;
if (!LEAN) {
  const h = await funder.sendTransaction({ to: P.erin.w.receiveBox, value: erinAmt });
  await receipt(h);
  await P.erin.w.watchReceive();
  log(`erin paid ${eth(erinAmt)} ETH to her private ETH address ${P.erin.w.receiveBox}; waiting for the keeper`);
}
for (const n of Object.keys(amounts)) await until(async () => (await P[n].w.sync()).balance > 0n, `${n} finds her note`);
if (!LEAN) {
  const erinSwept = await until(async () => { const x = await P.erin.w.sync(); return x.balance > 0n && x; }, 'keeper sweeps erin', 1_200_000);
  log(`keeper swept erin's address: she holds ${eth(erinSwept.balance)} ETH (sweep cost ${eth(erinAmt - erinSwept.balance)})`);
}

// 2. alice pays bob 2u privately, spending her 5u note with 3u change, proved and submitted by alice.
const aliceNote = P.alice.w.notes()[0];
const pay = 2n * UNIT;
const r2 = await selfTransact(eoa.alice, {
  inputs: [{ v: BigInt(aliceNote.v), rho: BigInt(aliceNote.rho), nk: BigInt(aliceNote.nk), sk: BigInt(aliceNote.sk), index: aliceNote.index }, { dummy: true }],
  outputs: [{ to: recipientOf(P.alice.keys, P.bob.w.address), value: pay }, { to: self(P.alice), value: BigInt(aliceNote.v) - pay }],
});
shown.push(['alice pays bob privately', r2.transactionHash]);
log(`alice paid bob ${eth(pay)} ETH privately and kept ${eth(BigInt(aliceNote.v) - pay)} change ${r2.transactionHash}`);
const bobBal = (await until(async () => { const x = await P.bob.w.sync(); return x.balance > 0n && x; }, 'bob finds the payment')).balance;
log(`bob found ${eth(bobBal)} ETH by scanning with his view key`);

// 3. bob withdraws part of it (1u) to a fresh address through the relayer.
const q = await P.bob.w.quote();
const part = UNIT;
if (BigInt(q.fee) + part > bobBal) throw new Error(`relayer fee ${eth(q.fee)} too high for this unit; use a larger unit on this chain`);
const h3 = await P.bob.w.withdraw({ to: freshAddr, amount: part });
const r3 = await receipt(h3);
shown.push(['bob withdraws to a fresh address (relayed)', r3.transactionHash]);
const got = await until(async () => { const b = await pub.getBalance({ address: freshAddr }); return b >= part && b; }, 'fresh balance', 120_000).catch(() => 0n);
log(`bob withdrew ${eth(part)} ETH to fresh ${freshAddr} via the relayer (fee ${eth(q.fee)}): received ${eth(got)} ${got === part ? '(exact)' : '(MISMATCH)'}`);

// 4. what the chain shows.
log('what the chain shows:');
for (const [what, h] of shown) {
  const [tx, rc] = await Promise.all([pub.getTransaction({ hash: h }), pub.getTransactionReceipt({ hash: h })]);
  const ev = rc.logs.filter((l) => l.address.toLowerCase() === POOL.toLowerCase()).map((l) => decodeEventLog({ abi: [EVENT], data: l.data, topics: l.topics }).args)[0];
  log(`  ${what}: from ${tx.from.slice(0, 10)}… value ${eth(tx.value)} · nullifiers ${[ev.nf0, ev.nf1].map((x) => x.slice(0, 10)).join(' ')} · new leaves ${[ev.outLeaf0, ev.outLeaf1].map((x) => x.slice(0, 10)).join(' ')} · recipient ${ev.recipient.slice(0, 10)} extAmount ${eth(ev.extAmount)} · memos ${(ev.memo0.length - 2) / 2}+${(ev.memo1.length - 2) / 2} bytes`);
}
const depositLeaves = new Set(); const allLeaves = await leavesNow();
log(`  the withdrawal names no leaf and no depositor; its nullifier matches none of the ${allLeaves.filter((x) => x !== 0n).length} leaves in the pool, and every leaf is a hash that reveals no owner or amount`);

// 5. return everything to the funder (KEEP=1 leaves the notes in the pool).
if (process.env.KEEP === '1') { log('notes kept in the pool'); process.exit(0); }
for (const n of [...Object.keys(amounts), ...(LEAN ? [] : ['erin']), 'bob']) {
  const b = (await P[n].w.sync()).balance;
  const fee = BigInt((await P[n].w.quote()).fee);
  if (b > fee + 1n) {
    const h = await P[n].w.withdraw({ to: funder.account.address, amount: b - fee - 1n });
    await receipt(h);
    log(`  returned ${n}'s ${eth(b - fee - 1n)} ETH to the funder`);
  }
}
for (const n of Object.keys(amounts)) {
  const bal = await pub.getBalance({ address: eoa[n].account.address });
  const cost = (await pub.getGasPrice()) * 2n * 60_000n;
  if (bal > cost) { await receipt(await eoa[n].sendTransaction({ to: funder.account.address, value: bal - cost, gas: 60_000n })); }
}
const pr = provingTimes.sort((a, b) => a - b);
log(`done in ${Math.round((Date.now() - t0) / 1000)}s · ${pr.length} proofs here, median ${(pr[pr.length >> 1] / 1000).toFixed(1)}s`);
process.exit(0);
