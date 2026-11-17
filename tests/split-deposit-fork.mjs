#!/usr/bin/env node
// The split deposit through the DEPLOYED forwarder (contracts/src/TacitSplitDeposit.sol, 0x0000000000049541f6582aB13C0b3a8dC35165Ae), end to end on a mainnet fork with a REAL
// zero-knowledge proof: the page's own wallet module syncs the real Tacit ETH pool from its history, proves a deposit with the pool's proving key (snarkjs, as the page does in a
// worker), and hands the wallet the forwarder's call as the `selfCall` that stands in for pool.transact. One transaction from the user puts a note into the real 0.1 ETH Tornado
// pool AND a note into the real Tacit pool. Then the Tacit note is taken out again with the pool's own withdrawal (a second real proof), to show what went in comes back.
// Also: a stale proof (another deposit lands between proving and sending) is refused by the real pool through the forwarder, cheaply, and moves nothing.
//
//   node tests/split-deposit-fork.mjs        (FORK=<rpc url that serves old logs and state>, default https://rpc.mevblocker.io; needs anvil; about 3 minutes)
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

if (spawnSync('anvil', ['--version']).status !== 0) { console.log('skip - needs anvil'); process.exit(0); }
const require = createRequire(import.meta.url);
const snarkjs = require('snarkjs');
const { proveTransact } = await import('../dapp/evm-pool-zk-prover.js');
const { keccak_256, bytesToHex } = await import('../dapp/vendor/tacit-deps.min.js');
const { evmPoolKeys, makeEvmPoolWallet, jsonRpc, splitDepositCall } = await import('../dapp/evm-pool-wallet.js');
const { makeEvmPoolZk } = await import('../dapp/evm-pool-zk.js');
const { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } = await import('poseidon-lite');

const ROOT = new URL('../', import.meta.url).pathname;
const FORK = process.env.FORK || 'https://rpc.mevblocker.io';
const PORT = 26100 + Math.floor(Math.random() * 300), RPC = `http://127.0.0.1:${PORT}`;
const FORWARDER = '0x0000000000049541f6582aB13C0b3a8dC35165Ae';
const ETH_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ETH_ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const T01 = '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc';
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const USER = '0x00000000000000000000000000000000000de921', DEST = '0x00000000000000000000000000000000000de591';
const E18 = 10n ** 18n;
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (v) => '0x' + BigInt(v).toString(16);
const post = async (url, method, params) => {
  const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { data: j.error.data });
  return j.result;
};
const rpcA = (m, p = []) => post(RPC, m, p);
const bal = async (a) => BigInt(await rpcA('eth_getBalance', [a, 'latest']));
const call = async (to, data) => BigInt(await rpcA('eth_call', [{ to, data }, 'latest']));
const sel = (sig) => '0x' + bytesToHex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
const NEXT_INDEX = sel('nextIndex()'), COMMITMENTS = sel('commitments(bytes32)'), STALE_ROOT = sel('StaleRoot()');
const upstreamFault = (e) => /failed to get|HTTP error 5|timed out|504|502|503|Could not check|-32603|temporarily unavailable|service/i.test(String(e?.message) + JSON.stringify(e?.rpc || {}));
const retrying = async (fn, label = 'a call') => {   // a free node answers 5xx and times out now and then: tried again when the error is the node's (the wallet keeps its proof, so this does not prove again)
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (!upstreamFault(e) || attempt >= 6) throw e;
      console.log(`    (${label}: the fork's upstream node failed, attempt ${attempt}, trying again: ${String(e.message).replace(/\s+/g, ' ').slice(0, 80)})`);
      await sleep(5000);
    }
  }
};
const receipt = async (h) => { for (let i = 0; i < 300; i++) { const r = await rpcA('eth_getTransactionReceipt', [h]); if (r) return r; await sleep(100); } return null; };

const head = BigInt(await post(FORK, 'eth_blockNumber', [])) - 2n;
const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', FORK, '--fork-block-number', String(head), '--chain-id', '1', '--silent', '--gas-limit', '300000000', '--compute-units-per-second', '40', '--retries', '15', '--timeout', '120000', '--fork-retry-backoff', '2000'], { stdio: 'ignore' });   // patient and polite: a free node throttles and times out under a flood
process.on('exit', () => anvil.kill('SIGKILL'));
for (let i = 0; ; i++) { try { await rpcA('eth_chainId'); break; } catch { if (i > 600) throw new Error('anvil did not start'); await sleep(200); } }
await rpcA('anvil_setBalance', [USER, hx(10n * E18)]);
await rpcA('anvil_impersonateAccount', [USER]);

ok((await rpcA('eth_getCode', [FORWARDER, 'latest'])).length > 100, 'the forwarder is on the fork: the deployed one, not a copy');

// the page's own wallet module and prover, on the real pool
const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });
const ART = ROOT + 'dapp/evm-pool/';
const wasm = readFileSync(ART + 'transact.wasm'), zkey = readFileSync(ART + 'transact_final.zkey');
const proofMs = [];
const prove = async (input) => { const t = Date.now(), r = await proveTransact(input, { wasm, zkey, snarkjs }); proofMs.push(Date.now() - t); return r; };
// a fork's first call into a pool reads many cold slots from its upstream node one by one: the wallet's node gets minutes, not the page's 25 s, and a failure is said out loud
const loud = async (...a) => { try { return await fetch(...a); } catch (e) { console.log('    (the fork node did not answer: ' + (e.cause?.code || e.name) + ')'); throw e; } };
const rpc = jsonRpc([RPC], loud, { timeoutMs: 300_000 });
const sent = [];
const signer = { address: USER, rpc, send: async ({ to, data, value }) => { const h = await rpcA('eth_sendTransaction', [{ from: USER, to, data, value: hx(value || 0), gas: hx(4_000_000) }]); sent.push({ h, to, value: BigInt(value || 0) }); return h; } };
const walletFor = (priv = crypto.getRandomValues(new Uint8Array(32))) => {
  const w = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, priv), keeper: null, store: null, feed: false, prove, chain: { chainId: 1, pool: ETH_POOL, router: ETH_ROUTER, rpc, deployBlock: 26069245, confirmations: 0, logChunk: 9000 } });
  w.connect(signer);
  return w;
};

const E = walletFor();
const commitment = '0x' + (BigInt('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')) % FIELD).toString(16).padStart(64, '0');
const split = { pools: [{ address: T01, denomination: E18 / 10n }], commitments: [commitment] };
const TACIT = E18 / 20n;   // 0.05 ETH into the Tacit pool, 0.1 ETH into the Tornado pool: one transaction, 0.15 ETH

// the first call into a pool makes the fork read its cold storage slots from the upstream node one at a time; a free node can take long over that, so the notes-only call is run first, as often
// as it takes, to pull them in (the fork keeps what it has read)
{
  const warm = splitDepositCall(FORWARDER, null, split);
  for (let i = 0; i < 12; i++) {
    try { await rpcA('eth_call', [{ from: USER, to: warm.to, data: warm.data, value: hx(warm.value) }, 'latest']); console.log(`  (fork warmed after ${i + 1} call${i ? 's' : ''})`); break; }
    catch (e) { if (i === 11) throw e; await sleep(3000); }
  }
}
for (let a = 1; a <= 10; a++) {   // the precompiles (the pairing check is 0x08): a fork asks its upstream node for each account once
  for (let i = 0; i < 12; i++) { try { await rpcA('eth_getBalance', ['0x' + a.toString(16).padStart(40, '0'), 'latest']); break; } catch { await sleep(2000); } }
}
const before = { tor: await bal(T01), torIdx: await call(T01, NEXT_INDEX), tac: await bal(ETH_POOL), tacIdx: await call(ETH_POOL, NEXT_INDEX), fwd: await bal(FORWARDER), user: await bal(USER) };
console.log(`  pool state before: Tornado 0.1 pool ${before.torIdx} deposits, Tacit ETH pool ${before.tacIdx} leaves, ${Number(before.tac) / 1e18} ETH`);
const t0 = Date.now();
let h;
let lastErr = null;
try {
  h = await retrying(() => E.deposit({ amount: TACIT, selfCall: (tx) => splitDepositCall(FORWARDER, tx, split), onStep: (s) => process.stdout.write(`    [${Math.round((Date.now() - t0) / 1000)} s] ${String(s).slice(0, 60)}\n`) }), 'the deposit');
} catch (e) { lastErr = e; }
if (!h) ok(false, `the deposit through the forwarder went through: ${String(lastErr?.message).replace(/\s+/g, ' ').slice(0, 200)}`);
if (h) {
  const r = await receipt(h), tx = await rpcA('eth_getTransactionByHash', [h]);
  ok(r?.status === '0x1', `ONE transaction, mined, status 1 (${BigInt(r.gasUsed)} gas, proof made in ${Math.round(proofMs[0] / 1000)} s)`);
  ok(tx.to.toLowerCase() === FORWARDER.toLowerCase() && BigInt(tx.value) === 3n * E18 / 20n, 'it went to the forwarder, carrying exactly 0.15 ETH (the note and the Tacit part)');
  ok(sent.length === 1, 'the user sent exactly one transaction');
  const after = { tor: await bal(T01), torIdx: await call(T01, NEXT_INDEX), tac: await bal(ETH_POOL), tacIdx: await call(ETH_POOL, NEXT_INDEX), fwd: await bal(FORWARDER) };
  ok(after.tor - before.tor === E18 / 10n && after.torIdx === before.torIdx + 1n, 'the real 0.1 ETH Tornado pool took the note: +0.1 ETH, +1 deposit');
  ok((await call(T01, COMMITMENTS + commitment.slice(2))) === 1n, 'and the pool lists the note\'s commitment as deposited');
  ok(after.tac - before.tac === TACIT && after.tacIdx === before.tacIdx + 2n, 'the real Tacit ETH pool took the deposit: +0.05 ETH, +2 leaves (the real verifier accepted the real proof)');
  ok(after.fwd === before.fwd, 'the forwarder kept nothing: its balance is where it was');
  ok((await bal(USER)) <= before.user - 3n * E18 / 20n && before.user - (await bal(USER)) < 3n * E18 / 20n + E18 / 100n, 'the user paid 0.15 ETH and a little gas, nothing else');
  await E.sync();
  ok(E.summary().balance === TACIT, `the wallet sees its Tacit note: ${Number(E.summary().balance) / 1e18} ETH private`);

  // what went into the Tacit pool comes back out: the pool's own withdrawal from the wallet, a second real proof
  const destBefore = await bal(DEST);
  let w;
  try { w = await retrying(() => E.withdraw({ to: DEST, amount: 'max', via: 'self' }), 'the withdrawal'); } catch (e) { ok(false, `the Tacit note comes back out: ${e.message}`); }
  if (w) {
    const wr = await receipt(w);
    const got = (await bal(DEST)) - destBefore;
    ok(wr?.status === '0x1' && got === TACIT, `the Tacit note comes back out with the pool's own withdrawal: ${Number(got) / 1e18} ETH to the destination (a second real proof, ${Math.round(proofMs[1] / 1000)} s)`);
  }
}

// a stale proof: the proof is made, a deposit lands before it is sent, and the stale proof is then sent by hand through the forwarder: the real pool refuses it with its own error, for
// little gas, and nothing moves (the wallet reads that error to prove again, so it has to arrive unchanged). The wallet that has synced already does both, so no second sync is needed.
{
  // a note of its own: the one the main deposit made is in its pool already, and the pool would refuse it a second time before the proof ever mattered
  const fresh = '0x' + (BigInt('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')) % FIELD).toString(16).padStart(64, '0');
  const split2 = { pools: split.pools, commitments: [fresh] };
  let held = null, captured = null;
  const realSend = signer.send;
  signer.send = async (c) => { held = c; throw new Error('held back, to be sent late'); };   // the wallet proves, checks the call, and is stopped just before it would send
  await retrying(() => E.deposit({ amount: TACIT, selfCall: (tx) => { captured = tx; return splitDepositCall(FORWARDER, tx, split2); } }), 'the proof').catch(() => {});
  signer.send = realSend;
  ok(!!captured && !!held, 'a proof was made against the pool\'s head and the call to the forwarder was ready to send');
  if (held) {
    await retrying(() => E.deposit({ amount: TACIT }), 'the deposit that lands first');   // a deposit lands first and moves the head
    const b = { tor: await bal(T01), tac: await bal(ETH_POOL), fwd: await bal(FORWARDER), user: await bal(USER) };
    let ret = null;
    try { await rpcA('eth_call', [{ from: USER, to: held.to, data: held.data, value: hx(held.value) }, 'latest']); } catch (e) { ret = String(e.data || ''); }
    ok(ret && ret.startsWith(STALE_ROOT), `the real pool refuses the stale proof through the forwarder with its own error, StaleRoot() (${ret ? ret.slice(0, 10) : 'no revert'}), which the wallet reads to prove again`);
    const sh = await rpcA('eth_sendTransaction', [{ from: USER, to: held.to, data: held.data, value: hx(held.value), gas: hx(1_000_000) }]);
    const sr = await receipt(sh);
    ok(sr?.status === '0x0' && BigInt(sr.gasUsed) < 80_000n, `sent anyway, it fails early: ${BigInt(sr.gasUsed)} gas, status 0 (the notes' million gas is never reached)`);
    const a = { tor: await bal(T01), tac: await bal(ETH_POOL), fwd: await bal(FORWARDER), user: await bal(USER) };
    ok(a.tor === b.tor && a.tac === b.tac && a.fwd === b.fwd, 'nothing moved: the Tornado pool, the Tacit pool and the forwarder hold what they held');
    ok(b.user - a.user < 5n * 10n ** 15n, 'and the user lost only the gas of the failed attempt: ' + Number(b.user - a.user) / 1e18 + ' ETH');
  }
}

console.log(`\n${n} ok, ${fails} FAILED`);
process.exit(fails ? 1 : 0);
