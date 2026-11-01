// End to end on a local anvil chain: deploy the pool (DEV verifier), PoseidonT5 and the router; run the keeper
// (src/evm-pool-keeper.js) against them; drive two wallets (dapp/evm-pool-wallet.js) through a payment to a receive
// box that the keeper sweeps, a private send the keeper relays, and a relayed withdrawal to a fresh address. Also
// checks the receive box stays code-free, so a plain 21,000-gas transfer lands after a sweep.
// Needs anvil, the forge build (contracts/out) and the DEV circuit artifacts; skips without them.
//   node worker-relay/tests/evm-pool-e2e.test.mjs
//   E2E_MULTIPLEXED=1 node worker-relay/tests/evm-pool-e2e.test.mjs   the keeper as the multi-keeper service (src/evm-pool-keepers.js), as Render
//                                                                     runs it: its one POST /sealed also carries a burst and a withdrawal

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, encodeDeployData, encodeFunctionData, http, parseEther } from 'viem';
import { callIntent } from '../../dapp/evm-pool-gateway.js';
import { privateKeyToAccount } from 'viem/accounts';
import { loadZk } from '../src/lib/evm-pool-keeper-prover.js';
import { proveTransact } from '../../dapp/evm-pool-zk-prover.js';
import { evmPoolKeys, makeEvmPoolWallet, jsonRpc } from '../../dapp/evm-pool-wallet.js';
import { makeForwarder } from '../src/lib/evm-pool-forwarder.js';
import { gatewayKeys, makeSealedFetch } from '../../dapp/sealed-request.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = join(ROOT, 'contracts/out');
const BUILD = join(ROOT, 'dapp/circuits/evm-pool/build');
const artifact = (f, c) => JSON.parse(readFileSync(join(OUT, f, `${c}.json`), 'utf8'));
const need = [join(OUT, 'TacitEvmPool.sol/TacitEvmPool.json'), join(OUT, 'TransactVerifierDev.sol/TransactVerifierDev.json'), join(BUILD, 'transact_dev_final.zkey')];
if (spawnSync('anvil', ['--version']).status !== 0 || !need.every(existsSync)) {
  console.log('skip - needs anvil, forge build and the DEV circuit artifacts');
  process.exit(0);
}

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 18545 + Math.floor(Math.random() * 1000);
const KPORT = PORT + 1;
const RPC = `http://127.0.0.1:${PORT}`;
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
];
const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (k) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(RPC) });
const [deployer, , payer] = KEYS.map(wallet);

const procs = [];
const tmp = mkdtempSync(join(tmpdir(), 'evm-pool-e2e-'));
const cleanup = () => { for (const p of procs) p.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); };
process.on('exit', cleanup);

async function until(fn, what, ms = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(1000);
  }
}
async function deploy(abi, bytecode, args = []) {
  const hash = await deployer.sendTransaction({ data: encodeDeployData({ abi, bytecode, args }) });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
}

procs.push(spawn('anvil', ['--port', String(PORT), '--silent', '--hardfork', 'cancun'], { stdio: 'ignore' }));
await until(async () => { try { return await pub.getChainId(); } catch { return false; } }, 'anvil');

const v = artifact('TransactVerifierDev.sol', 'TransactVerifierDev');
const verifier = await deploy(v.abi, v.bytecode.object);
const require = createRequire(import.meta.url);
const poseidonT5 = require(join(ROOT, 'node_modules/poseidon-solidity/deploy/PoseidonT5.js'));
await pub.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: poseidonT5.proxyAddress, data: poseidonT5.data }) });
const p = artifact('TacitEvmPool.sol', 'TacitEvmPool');
const pool = await deploy(p.abi, p.bytecode.object, [verifier, '0x0000000000000000000000000000000000000000']);
const r = artifact('TacitEvmPoolRouter.sol', 'TacitEvmPoolRouter');
const ZERO = '0x0000000000000000000000000000000000000000';
const router = await deploy(r.abi, r.bytecode.object, [pool, ZERO, ZERO, ZERO, poseidonT5.address]);

const GATEWAY_SECRET = '5a'.repeat(32);   // the keeper's private route (dapp/sealed-request.js) is on for the whole run
const keeperLog = [];
const MULTI = !!process.env.E2E_MULTIPLEXED;
const keeper = spawn('node', [MULTI ? 'src/evm-pool-keepers.js' : 'src/evm-pool-keeper.js'], {
  cwd: join(ROOT, 'worker-relay'),
  env: {
    ...process.env, EVM_POOL_ADDR: pool, EVM_POOL_ROUTER_ADDR: router, EVM_POOL_RPC_URL: RPC, EVM_POOL_CHAIN_ID: '31337',
    EVM_POOL_KEEPER_PRIV: KEYS[1], EVM_POOL_KEEPER_DB: join(tmp, 'keeper.db'), PORT: String(KPORT),
    EVM_POOL_KEEPER_POLL_SECS: '1', EVM_POOL_KEEPER_MIN_FEES: 'eth:1000', EVM_POOL_CONFIRMATIONS: '0',
    EVM_POOL_KEEPER_GATEWAY_KEY: GATEWAY_SECRET, ...(MULTI ? { EVM_POOL_CHAINS: '31337', EVM_POOL_KEEPER_FORWARDERS: '127.0.0.1' } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
procs.push(keeper);
keeper.stdout.on('data', (d) => keeperLog.push(String(d)));
keeper.stderr.on('data', (d) => keeperLog.push(String(d)));
const KEEPER = `http://127.0.0.1:${KPORT}/evm-pool/keeper`;
await until(async () => { try { return (await fetch(`http://127.0.0.1:${KPORT}/health`)).ok; } catch { return false; } }, 'keeper');

const zk = await loadZk();
const snarkjs = await import('snarkjs');
const wasm = readFileSync(join(BUILD, 'transact_js/transact.wasm'));
const zkey = readFileSync(join(BUILD, 'transact_dev_final.zkey'));
const prove = (input) => proveTransact(input, { wasm, zkey, snarkjs });
const chainCfg = { chainId: 31337, pool, router, rpc: jsonRpc(RPC), deployBlock: 0, confirmations: 0 };
const saved = new Map();
const store = { get: (k) => saved.get(k), set: (k, v) => saved.set(k, v) };
const alice = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(0x11)), chain: chainCfg, keeper: KEEPER, prove, store });
const bob = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(0x22)), chain: chainCfg, keeper: KEEPER, prove });

try {
  await test('a payment to the receive box is swept by the keeper into a note the wallet finds', async () => {
    await pub.waitForTransactionReceipt({ hash: await payer.sendTransaction({ to: alice.receiveBox, value: parseEther('1') }) });
    const w = await alice.watchReceive();
    assert.equal(w.status, 200);
    const s = await until(async () => { const x = await alice.sync(); return x.balance > 0n && x; }, 'sweep');
    assert.ok(s.balance < parseEther('1') && s.balance >= parseEther('1') - parseEther('1') * 25n / 10000n, 'one ETH less the sweep\'s cost, at most the 25 bps cap');
    assert.equal(await pub.getCode({ address: alice.receiveBox }), undefined, 'the box keeps no code');
  });

  await test('after a sweep the box still takes a plain 21,000-gas transfer, and is swept again', async () => {
    const hash = await payer.sendTransaction({ to: alice.receiveBox, value: parseEther('0.5'), gas: 21000n });
    assert.equal((await pub.waitForTransactionReceipt({ hash })).status, 'success');
    await alice.watchReceive();
    const s = await until(async () => { const x = await alice.sync(); return x.notes === 2 && x; }, 'second sweep');
    assert.ok(s.balance < parseEther('1.5') && s.balance >= parseEther('1.5') - parseEther('1.5') * 25n / 10000n);
  });

  let sent;
  await test('a private send to a Secret Sats address, proved here and relayed by the keeper', async () => {
    const before = (await alice.sync()).balance;
    const steps = [];
    sent = await alice.send({ to: bob.address, amount: parseEther('0.3'), onStep: (m) => steps.push(m) });
    assert.match(sent, /^0x[0-9a-f]{64}$/);
    assert.equal((await pub.waitForTransactionReceipt({ hash: sent })).status, 'success');
    const b = await until(async () => { const x = await bob.sync(); return x.balance > 0n && x; }, 'bob sees the payment');
    assert.equal(b.balance, parseEther('0.3'));
    const a = await alice.sync();
    assert.ok(a.balance < before - parseEther('0.3') && a.balance > before - parseEther('0.31'), 'alice keeps her change less the relay fee');
    assert.ok(steps.includes('proving on this device'));
  });

  await test('a relayed withdrawal to a fresh address pays it exactly, with bob\'s change kept', async () => {
    const fresh = privateKeyToAccount('0x' + '42'.repeat(32)).address;
    const hash = await bob.withdraw({ to: fresh, amount: parseEther('0.1') });
    assert.equal((await pub.waitForTransactionReceipt({ hash })).status, 'success');
    assert.equal(await pub.getBalance({ address: fresh }), parseEther('0.1'));
    const b = await bob.sync();
    assert.ok(b.balance < parseEther('0.2') && b.balance > parseEther('0.19'));
  });

  await test('a relayed withdrawal through the private route and a forwarder pays exactly, with no reservation, and the forwarder reads nothing', async () => {
    const forwarded = [], paths = [];
    const fwd = createServer(makeForwarder({ gateways: { 31337: `${KEEPER}/sealed` }, fetchImpl: async (url, init) => { forwarded.push({ headers: init.headers, body: init.body }); return fetch(url, init); } }));
    await new Promise((res) => fwd.listen(0, res));
    try {
      const gateway = Buffer.from(gatewayKeys(GATEWAY_SECRET).pub).toString('hex');
      assert.equal((await (await fetch(`${KEEPER}/info`)).json()).sealed.key, gateway, 'the keeper names the key it was given');
      const sealedFetch = makeSealedFetch({ keeper: KEEPER, chainId: 31337, gateway, forwarders: [`http://127.0.0.1:${fwd.address().port}`] });
      const viaRoute = Object.assign((u, init) => { paths.push(new URL(u).pathname.slice('/evm-pool/keeper'.length)); return sealedFetch(u, init); }, { sealed: true });
      const private_ = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(0x22)), chain: chainCfg, keeper: KEEPER, prove, fetchImpl: viaRoute });
      const before = (await private_.sync()).balance;
      assert.equal(before, (await bob.sync()).balance, 'the same notes');
      const fresh = privateKeyToAccount('0x' + '46'.repeat(32)).address;
      const hash = await private_.withdraw({ to: fresh, amount: parseEther('0.05') });
      assert.equal((await pub.waitForTransactionReceipt({ hash })).status, 'success');
      assert.equal(await pub.getBalance({ address: fresh }), parseEther('0.05'));
      assert.equal((await pub.getTransaction({ hash })).from.toLowerCase(), privateKeyToAccount(KEYS[1]).address.toLowerCase(), 'sent by the keeper');
      assert.ok(paths.includes('/quote') && paths.includes('/relay'), paths.join(' '));
      assert.ok(!paths.includes('/reserve'), 'no reservation asked for');
      assert.ok(forwarded.length >= paths.length, 'every request went through the forwarder');
      for (const f of forwarded) {
        assert.deepEqual(Object.keys(f.headers), ['content-type']);
        for (const text of [fresh.slice(2).toLowerCase(), 'relay', 'withdraw', 'quote']) assert.ok(!Buffer.from(f.body).includes(Buffer.from(text)), text);
      }
      assert.ok(!keeperLog.join('').toLowerCase().includes(fresh.slice(2).toLowerCase()), 'the keeper\'s log does not name the recipient');
    } finally { fwd.close(); }
  });

  if (MULTI) await test('the service\'s one POST /sealed carries a burst of reads for its pools and a relayed withdrawal, with no reservation', async () => {
    const SERVICE = `http://127.0.0.1:${KPORT}`, forwarded = [], paths = [];
    const fwd = createServer(makeForwarder({ gateways: { k: `${SERVICE}/sealed` }, fetchImpl: async (url, init) => { forwarded.push(init.body.length); return fetch(url, init); } }));
    await new Promise((res) => fwd.listen(0, res));
    try {
      const gateway = Buffer.from(gatewayKeys(GATEWAY_SECRET).pub).toString('hex');
      const sealedFetch = makeSealedFetch({ keeper: SERVICE, chainId: 'k', gateway, forwarders: [`http://127.0.0.1:${fwd.address().port}`] });
      const base = `${SERVICE}/31337/evm-pool/keeper`;
      const viaService = Object.assign((u, init) => { paths.push(new URL(u).pathname.slice('/31337/evm-pool/keeper'.length)); return sealedFetch(u, init); }, { sealed: true });
      // a burst of reads for the pool, together, is a few envelopes, and each answer is the one a direct read gives
      const reads = await Promise.all(['info', 'head', 'quote', 'point', 'totals'].map((r) => viaService(`${base}/${r}`).then(async (x) => [r, x.status, await x.json()])));
      const direct = await (await fetch(`${base}/info`)).json();
      assert.equal(reads[0][2].pool, direct.pool);
      assert.ok(reads.every(([, status]) => status === 200 || status === 404), JSON.stringify(reads.map(([r, st]) => [r, st])));
      assert.ok(forwarded.length <= 3, `${forwarded.length} envelopes for 5 reads`);
      // and what is not a relay's is refused inside the envelope
      assert.equal((await viaService(`${base}/reserve`, { method: 'POST', body: '{}' })).status, 403);
      assert.equal((await sealedFetch(`${SERVICE}/health`).catch((e) => e.message)).status, 403);
      const wallet = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(0x22)), chain: chainCfg, keeper: base, prove, fetchImpl: viaService });
      assert.ok((await wallet.sync()).balance > parseEther('0.02'));
      const fresh = privateKeyToAccount('0x' + '47'.repeat(32)).address;
      const hash = await wallet.withdraw({ to: fresh, amount: parseEther('0.02') });
      assert.equal((await pub.waitForTransactionReceipt({ hash })).status, 'success');
      assert.equal(await pub.getBalance({ address: fresh }), parseEther('0.02'));
      assert.ok(paths.includes('/quote') && paths.includes('/relay'), paths.join(' '));
      assert.ok(!paths.includes('/reserve') || paths.indexOf('/reserve') === paths.lastIndexOf('/reserve'), 'only the refused probe asked for a reservation');
      assert.ok(!keeperLog.join('').toLowerCase().includes(fresh.slice(2).toLowerCase()), 'the keeper\'s log does not name the recipient');
    } finally { fwd.close(); }
  });

  await test('withdraw and call: one relayed transaction pays a bridge; the unspent rest returns to alice as a note', async () => {
    const b = artifact('TacitEvmPoolRouterCall.t.sol', 'MockBridge');
    const bridge = await deploy(b.abi, b.bytecode.object);
    const dest = privateKeyToAccount('0x' + '43'.repeat(32)).address;
    // A refund large enough that its capped sweep fee covers the keeper's gas, as it must on Ethereum.
    const before = (await alice.sync()).balance;
    const refund = await alice.refundBox();
    assert.notEqual(refund.toLowerCase(), alice.receiveBox.toLowerCase(), 'not the public receive address');
    const intent = callIntent({
      calls: [{ target: bridge, value: parseEther('0.05'), data: encodeFunctionData({ abi: b.abi, functionName: 'depositETH', args: [dest, 8453n] }) }],
      refund, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: 1n,
    });
    const hash = await alice.withdrawAndCall({ intent, amount: parseEther('0.45') });
    assert.equal((await pub.waitForTransactionReceipt({ hash })).status, 'success');
    assert.equal(await pub.getBalance({ address: bridge }), parseEther('0.05'));
    assert.equal(await pub.readContract({ address: bridge, abi: b.abi, functionName: 'lastRecipient' }), dest);
    const s = await until(async () => { const x = await alice.sync(); return x.balance > before - parseEther('0.45') && x; }, 'refund swept back');
    assert.ok(s.balance > before - parseEther('0.053') && s.balance < before - parseEther('0.05'), 'bridge amount, the relay fee and the sweep fee left');
  });

  await test('stored state is view-level only, and a wallet rebuilt from it matches', async () => {
    const blob = [...saved.values()].join('');
    assert.ok(blob.length > 0);
    assert.ok(!/"(sk|nk)"/.test(blob), 'no spend or nullifier keys are stored');
    const again = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(0x11)), chain: chainCfg, keeper: KEEPER, prove, store });
    assert.equal((await again.sync()).balance, (await alice.sync()).balance);
  });

  await test('a wallet restored through the keeper feed matches a chain-log rescan; a forged feed is refused', async () => {
    const want = (await alice.sync()).balance;
    const counted = () => { const c = { logs: 0 }; const rpc = jsonRpc(RPC); c.rpc = (m, p) => { if (m === 'eth_getLogs') c.logs++; return rpc(m, p); }; return c; };
    const keys = evmPoolKeys(zk, new Uint8Array(32).fill(0x11));
    await until(async () => (await (await fetch(`${KEEPER}/events?from=0`)).json()).events.length > 0, 'keeper feed');

    const a = counted();
    const viaFeed = makeEvmPoolWallet({ zk, keys, chain: { ...chainCfg, rpc: a.rpc, logChunk: 1 }, keeper: KEEPER, prove });
    assert.equal((await viaFeed.sync()).balance, want);
    const b = counted();
    const viaLogs = makeEvmPoolWallet({ zk, keys, chain: { ...chainCfg, rpc: b.rpc, logChunk: 1 }, keeper: KEEPER, prove, feed: false });
    assert.equal((await viaLogs.sync()).balance, want);
    assert.ok(a.logs < b.logs / 2, `feed sync read ${a.logs} log pages, chain-log sync ${b.logs}`);
    assert.equal((await viaFeed.rescan()).balance, want, 'rescan from chain logs alone agrees');

    // A feed that swaps one leaf builds a tree the pool never held: it is refused and the chain logs are used.
    const forge = async (url, init) => {
      const r = await fetch(url, init);
      if (!String(url).includes('/events')) return r;
      const j = await r.json();
      const t = j.events.find((e) => e.kind === 'transact');
      if (t) t.outLeaf0 = (BigInt(t.outLeaf0) ^ 1n).toString();
      return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const c = counted();
    const forged = makeEvmPoolWallet({ zk, keys, chain: { ...chainCfg, rpc: c.rpc, logChunk: 1 }, keeper: KEEPER, prove, fetchImpl: forge });
    assert.equal((await forged.sync()).balance, want);
    assert.ok(c.logs >= b.logs - 2, `the forged page was dropped and chain logs read instead (${c.logs} vs ${b.logs})`);
  });

  await test('no keeper: deposit, own-address sweep, private send and withdrawal, each submitted by the user\'s wallet', async () => {
    const signerOf = (w) => ({ address: w.account.address, send: ({ to, data, value }) => w.sendTransaction({ to, data, value }) });
    const cw = wallet(KEYS[2]);
    const dw = wallet('0x' + '44'.repeat(32));
    await pub.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: dw.account.address, value: parseEther('1') }) });
    const carol = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(0x33)), chain: chainCfg, prove, signer: signerOf(cw) });
    const dave = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(0x44)), chain: chainCfg, prove, signer: signerOf(dw) });
    const ok = async (h) => assert.equal((await pub.waitForTransactionReceipt({ hash: h })).status, 'success');

    await ok(await carol.deposit({ amount: parseEther('0.2') }));
    assert.equal((await carol.sync()).balance, parseEther('0.2'));

    await pub.waitForTransactionReceipt({ hash: await payer.sendTransaction({ to: carol.receiveBox, value: 12345n }) });
    await ok(await carol.sweep());
    assert.equal((await carol.sync()).balance, parseEther('0.2') + 12345n, 'a tiny amount, swept whole with no fee');

    await ok(await carol.send({ to: dave.address, amount: parseEther('0.15') }));
    assert.equal((await until(async () => { const x = await dave.sync(); return x.balance > 0n && x; }, 'dave sees it')).balance, parseEther('0.15'));

    const fresh = privateKeyToAccount('0x' + '45'.repeat(32)).address;
    const h = await dave.withdraw({ to: fresh, amount: parseEther('0.1') });
    await ok(h);
    assert.equal(await pub.getBalance({ address: fresh }), parseEther('0.1'));
    assert.equal((await pub.getTransaction({ hash: h })).from.toLowerCase(), dw.account.address.toLowerCase(), 'sent from dave\'s own wallet');
    assert.equal((await dave.sync()).balance, parseEther('0.05'), 'no fee taken');
    await assert.rejects(dave.withdraw({ to: fresh, amount: 1n, via: 'relay' }), /no wallet|no relayer|relayer/i);
  });

  await test('five users relaying at once all land, several per block, proving each spend once', async () => {
    const signerOf = (w) => ({ address: w.account.address, send: ({ to, data, value }) => w.sendTransaction({ to, data, value }) });
    const users = [];
    for (let i = 0; i < 5; i++) {
      const acct = wallet('0x' + (0x60 + i).toString(16).repeat(32));
      await pub.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: acct.account.address, value: parseEther('1') }) });
      const u = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(0x70 + i)), chain: chainCfg, keeper: KEEPER, prove, signer: signerOf(acct) });
      await pub.waitForTransactionReceipt({ hash: await u.deposit({ amount: parseEther('0.2') }) });
      users.push(u);
    }
    const dest = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(0x7f)), chain: chainCfg, prove });
    for (const u of users) await u.sync();
    await pub.request({ method: 'evm_setAutomine', params: [false] });
    await pub.request({ method: 'evm_setIntervalMining', params: [3] });
    try {
      const proofs = users.map(() => 0), sentAt = users.map(() => []);
      const t0 = Date.now();
      const hashes = await Promise.all(users.map((u, i) => u.send({ to: dest.address, amount: parseEther('0.05'), onStep: (m) => { if (m === 'proving on this device') proofs[i]++; if (m === 'sending through the relayer') sentAt[i].push(((Date.now() - t0) / 1000).toFixed(1)); } })));
      const blocks = await Promise.all(hashes.map(async (h) => (await pub.waitForTransactionReceipt({ hash: h })).blockNumber));
      assert.equal((await until(async () => { const x = await dest.sync(); return x.notes === 5 && x; }, 'all five payments')).balance, parseEther('0.25'));
      const perBlock = Math.max(...Object.values(blocks.reduce((m, b) => ({ ...m, [b]: (m[b] || 0) + 1 }), {})));
      const info = `proofs ${proofs.join('+')}, sent at ${sentAt.map((x) => x.join('/')).join(' ')} s, blocks ${blocks.join(' ')}`;
      assert.ok(perBlock >= 2, `the keeper put several in one block (max ${perBlock} per block): ${info}`);
      assert.ok(proofs.reduce((a, b) => a + b, 0) <= 7, `${proofs.join('+')} proofs for five spends`);
    } finally {
      await pub.request({ method: 'evm_setIntervalMining', params: [0] });
      await pub.request({ method: 'evm_setAutomine', params: [true] });
    }
  });

  await test('a spend cannot be replayed: the same calldata reverts on chain', async () => {
    const tx = await pub.getTransaction({ hash: sent });
    await assert.rejects(pub.call({ account: payer.account, to: pool, data: tx.input }), /AlreadyNullified|StaleRoot|revert/);
  });

  // run with EVM_POOL_KEEPER_NATIVE_PROVER=<rapidsnark prover> to try the keeper's native path end to end
  if (process.env.EVM_POOL_KEEPER_NATIVE_PROVER) {
    await test('with the native prover set, every proof the keeper made came from it and none fell back', () => {
      const log = keeperLog.join('');
      const via = [...log.matchAll(/proved in [\d.]+ s \((\w+)\)/g)].map((m) => m[1]);
      assert.match(log, /native prover \S+ starts/);
      assert.ok(via.length > 0 && via.every((v) => v === 'native'), `proofs by: ${via.join(', ') || 'none'}`);
      assert.doesNotMatch(log, /native prover \(/);
      console.log(`  (${via.length} keeper proofs, all native)`);
    });
  }
} catch (e) {
  console.error(keeperLog.join('').split('\n').slice(-30).join('\n'));
  throw e;
} finally {
  cleanup();
}

console.log(`\n${n} passed`);
process.exit(0);
