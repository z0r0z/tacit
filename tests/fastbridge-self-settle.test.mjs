// A settle the relay proved but holds (its sender is under its gas floor, the relay is 'held') is sent by the page itself, from the
// Ethereum wallet it is connected to (dapp/fastbridge-evm.js selfSettle, dapp/fast/wire.js walletSettle): only after the relay has had a
// while to send it, once at a time, again after a wait when a try fails, and the cut of a note as well as the lock, claim and refund.
//   node tests/fastbridge-self-settle.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { secp, keccak_256, hmac, sha256 } from '../dapp/vendor/tacit-deps.min.js';
import { makeFastBridgeEvm } from '../dapp/fastbridge-evm.js';

// wire.js imports by the site's absolute paths: walletSettle is read from its source alone, which needs nothing it imports
const src = await (await import('node:fs/promises')).readFile(new URL('../dapp/fast/wire.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('export function walletSettle('), src.indexOf('// What both roles need of a key'));
const walletSettle = new Function(`${body.replace('export function', 'function')}; return walletSettle;`)();

const ASSET = 'ab'.repeat(32);
const OPEN = { status: 'open', publicValues: '0xaa', proof: '0xbb', memos: ['0xcc'] };
function adapter({ status = OPEN, selfSettle = null, notes = [], transfer = null } = {}) {
  let t = 0;
  const landed = [];
  const ux = {
    pool: { leaf: (a, x) => x, nullifier: (l) => l }, rpc: async () => null, identity: () => ({ pubHex: '03' }), chainBindingHex: () => '0x00',
    balance: async () => ({ byAsset: { ['0x' + ASSET]: { notes } } }),
    relay: { status: async (id) => ({ jobId: id, ...(typeof status === 'function' ? status() : status) }), landed: async (id, h) => { landed.push([id, h]); } },
    transfer: transfer || (async () => ({})),
  };
  const logs = [];
  const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256: (k, m) => hmac(sha256, k, m), walletPriv: new Uint8Array(32).fill(1), seed: new Uint8Array(32), asset: ASSET, poolAddress: '0x' + '11'.repeat(20), selfSettle, openGraceMs: 1000, selfRetryMs: 5000, clock: () => t, log: (o) => logs.push(o) });
  return { evm, landed, logs, at: (ms) => { t = ms; } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a held settle is sent from the wallet only after the relay has had its while, once, and then counts as settled', async () => {
  const sent = [];
  const a = adapter({ selfSettle: async (x) => { sent.push(x); return { txHash: '0xfeed' }; } });
  assert.equal(await a.evm.jobStatus('j1'), 'pending'); assert.equal(sent.length, 0, 'the relay may still send it');
  a.at(999); assert.equal(await a.evm.jobStatus('j1'), 'pending'); assert.equal(sent.length, 0);
  a.at(1000); assert.equal(await a.evm.jobStatus('j1'), 'pending'); await tick();
  assert.deepEqual(sent, [{ jobId: 'j1', publicValues: '0xaa', proof: '0xbb', memos: ['0xcc'] }]);
  assert.equal(await a.evm.jobStatus('j1'), 'settled', 'it landed, whatever the relay still says');
  assert.equal(await a.evm.claimStatus('j1'), 'settled'); assert.equal(sent.length, 1, 'sent once');
  assert.deepEqual(a.landed, [['j1', '0xfeed']], 'the relay is told where it landed');
});

test('a try that fails waits before the next, and one send at a time', async () => {
  let n = 0, release;
  const a = adapter({ selfSettle: () => { n++; if (n === 1) return new Promise((_, no) => { release = () => no(new Error('User rejected the request')); }); return Promise.resolve({ txHash: '0x1' }); } });
  await a.evm.jobStatus('j'); a.at(2000);
  await a.evm.jobStatus('j'); await a.evm.jobStatus('j'); assert.equal(n, 1, 'not sent again while the wallet is asked');
  release(); await tick(); await tick();
  assert.match(a.logs.find((l) => l.level === 'warn').error, /User rejected/);
  a.at(6999); await a.evm.jobStatus('j'); assert.equal(n, 1, 'waits after a refusal');
  a.at(7000); await a.evm.jobStatus('j'); await tick(); assert.equal(n, 2);
  assert.equal(await a.evm.jobStatus('j'), 'settled');
});

test('without a wallet a held settle waits for the relay; what the relay says of a job is kept otherwise', async () => {
  const a = adapter();
  a.at(1e9); assert.equal(await a.evm.jobStatus('j'), 'pending');
  for (const [s, want] of [['settled', 'settled'], ['failed', 'failed'], ['unknown', 'failed'], ['proving', 'pending']]) {
    const b = adapter({ status: { status: s }, selfSettle: async () => { throw new Error('not asked'); } });
    b.at(1e9); assert.equal(await b.evm.jobStatus('j'), want, s);
  }
  const bare = adapter({ status: { status: 'open' }, selfSettle: async () => { throw new Error('not asked'); } });
  bare.at(1e9); assert.equal(await bare.evm.jobStatus('j'), 'pending', 'an open job without its proof is not sent');
});

test('the cut of a note that the relay holds is sent from the wallet with the memos the page sealed', async () => {
  const sent = [];
  const held = Object.assign(new Error('settle held: proved and waiting for a sender (job c1); it can be sent from any account now'), { code: 'open', open: { jobId: 'c1', publicValues: '0x1', proof: '0x2', memos: ['0x3'] } });
  const a = adapter({ notes: [{ leaf: '0x' + '0'.repeat(63) + '1', value: '5000' }], transfer: async () => { throw held; }, selfSettle: async (x) => { sent.push(x); return { txHash: '0x9' }; } });
  await a.evm.prepare({ rec: { offer: { evm: { amount: '1000' } } } });
  assert.deepEqual(sent, [{ jobId: 'c1', publicValues: '0x1', proof: '0x2', memos: ['0x3'] }]);
  const b = adapter({ notes: [{ leaf: '0x' + '0'.repeat(63) + '1', value: '5000' }], transfer: async () => { throw held; } });
  await assert.rejects(b.evm.prepare({ rec: { offer: { evm: { amount: '1000' } } } }), /settle held/, 'without a wallet the hold is said, as before');
});

function walletStub({ chain = '0x1', switchTo = '0x1', receipt = { status: '0x1' }, call = null } = {}) {
  const asked = [], rpcs = [];
  let c = chain;
  const w = { request: async ({ method, params }) => {
    asked.push(method);
    if (method === 'eth_chainId') return c;
    if (method === 'wallet_switchEthereumChain') { c = switchTo; return null; }
    if (method === 'eth_requestAccounts') return ['0xabc'];
    if (method === 'eth_sendTransaction') { asked.push(params[0]); return '0xhash'; }
    throw new Error('unexpected ' + method);
  } };
  const ux = { cfg: { pool: '0xpool' }, settleCalldata: (x) => '0xdata' + x.proof.slice(2), rpc: async (m, p) => { rpcs.push(m); if (m === 'eth_call' && call) throw call; if (m === 'eth_getTransactionReceipt') return receipt; return '0x'; } };
  return { w, ux, asked, rpcs };
}

test('the wallet sends the settle on mainnet (switching to it), tries it first, and counts it once its receipt is good', async () => {
  const s = walletStub({ chain: '0x2105' });
  const r = await walletSettle({ ux: s.ux, wallet: () => s.w, sleep: async () => {} })({ publicValues: '0x1', proof: '0x77', memos: [] });
  assert.deepEqual(r, { txHash: '0xhash' });
  assert.deepEqual(s.asked.slice(0, 4), ['eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_requestAccounts']);
  assert.deepEqual(s.asked.find((x) => typeof x === 'object'), { from: '0xabc', to: '0xpool', data: '0xdata77' });
  assert.deepEqual(s.rpcs.slice(0, 2), ['eth_call', 'eth_getTransactionReceipt'], 'tried before it is sent');
});

test('the wallet sends nothing off mainnet, nor what the pool would refuse; a failed receipt is a failure; no wallet is said', async () => {
  const off = walletStub({ chain: '0x2105', switchTo: '0x2105' });
  await assert.rejects(walletSettle({ ux: off.ux, wallet: () => off.w })({ proof: '0x1' }), /not on Ethereum mainnet/);
  assert.equal(off.asked.includes('eth_sendTransaction'), false);
  const refused = walletStub({ call: new Error('execution reverted') });
  await assert.rejects(walletSettle({ ux: refused.ux, wallet: () => refused.w })({ proof: '0x1' }), /reverted/);
  assert.equal(refused.asked.includes('eth_sendTransaction'), false, 'nothing is sent that would fail');
  const bad = walletStub({ receipt: { status: '0x0' } });
  await assert.rejects(walletSettle({ ux: bad.ux, wallet: () => bad.w, sleep: async () => {} })({ proof: '0x1' }), /failed \(0xhash\)/);
  await assert.rejects(walletSettle({ ux: bad.ux, wallet: () => null })({ proof: '0x1' }), /no Ethereum wallet/);
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} self-settle checks passed`);
process.exit(process.exitCode || 0);
