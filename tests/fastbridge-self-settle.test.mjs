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
function adapter({ status = OPEN, selfSettle = null, notes = [], transfer = null, held = false, relayState = null, prove = null, submitOp = null, ownAccount = null, balance = 10n ** 18n, gasPrice = 10n ** 9n } = {}) {
  let t = 0;
  const landed = [], reads = [];
  const ux = {
    pool: { leaf: (a, x) => x, nullifier: (l) => l },
    rpc: async (m) => { reads.push(m); if (m === 'eth_getBalance') { if (balance instanceof Error) throw balance; return '0x' + (typeof balance === 'function' ? balance() : balance).toString(16); } if (m === 'eth_gasPrice') return '0x' + gasPrice.toString(16); return null; },
    identity: () => ({ pubHex: '03' }), chainBindingHex: () => '0x00',
    balance: async () => ({ byAsset: { ['0x' + ASSET]: { notes } } }),
    relay: { status: async (id) => ({ jobId: id, ...(typeof status === 'function' ? status() : status) }), landed: async (id, h) => { landed.push([id, h]); }, state: async () => ({ state: relayState || (held ? 'held' : 'ok') }), prove: prove || (async () => { throw new Error('not asked'); }), submitOp: submitOp || (async () => ({ jobId: 'relay-job' })) },
    transfer: transfer || (async () => ({})),
  };
  const logs = [];
  const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256: (k, m) => hmac(sha256, k, m), walletPriv: new Uint8Array(32).fill(1), seed: new Uint8Array(32), asset: ASSET, poolAddress: '0x' + '11'.repeat(20), selfSettle, ownAccount, openGraceMs: 1000, selfRetryMs: 5000, clock: () => t, log: (o) => logs.push(o) });
  return { evm, landed, logs, reads, at: (ms) => { t = ms; } };
}
const refuse = (message, extra = {}) => Object.assign(new Error(message), { httpStatus: 429, ...extra });
const BUNDLE = { op: { kind: 'lock' }, leaves: [], outputs: null, lockMemos: ['0x'] };
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

test('a lock, claim or refund that a held relay leaves waiting is proved prove-only and sent from the wallet; a relay that is not held is waited for', async () => {
  const proved = [], sent = [];
  const bundle = { op: { kind: 'claim' }, leaves: ['0x1'], outputs: [{ v: 1 }], lockMemos: null };
  const a = adapter({ status: { status: 'pending' }, held: true, prove: async (spec) => { proved.push(spec); return { jobId: 'p1', status: 'proven', publicValues: '0x5', proof: '0x6', memos: ['0x7'] }; }, selfSettle: async (x) => { sent.push(x); return { txHash: '0xab' }; } });
  assert.equal(await a.evm.claimStatus('j', { type: 'adaptorclaim', bundle }), 'pending'); assert.equal(proved.length, 0, 'the relay has its while first');
  a.at(1000); await a.evm.claimStatus('j', { type: 'adaptorclaim', bundle }); await tick(); await tick();
  assert.deepEqual(proved.map((x) => [x.type, x.op.kind, x.leaves[0]]), [['adaptorclaim', 'claim', '0x1']], 'the same op, proved prove-only');
  assert.deepEqual(sent, [{ jobId: 'p1', publicValues: '0x5', proof: '0x6', memos: ['0x7'] }]);
  assert.equal(await a.evm.claimStatus('j', { type: 'adaptorclaim', bundle }), 'settled');
  assert.deepEqual(a.landed.map((x) => x[0]).sort(), ['j', 'p1'], 'both jobs are told where it landed');
  const ok = adapter({ status: { status: 'pending' }, held: false, selfSettle: async () => { throw new Error('not asked'); } });
  ok.at(1e9); assert.equal(await ok.evm.jobStatus('j', { type: 'adaptorlock', bundle }), 'pending', 'a relay that is not held is waited for');
  const blind = adapter({ status: { status: 'pending' }, held: true, selfSettle: async () => { throw new Error('not asked'); } });
  blind.at(1e9); assert.equal(await blind.evm.jobStatus('j'), 'pending', 'a job whose op is not known is waited for');
});

test('with the relay held the cut is proved prove-only and sent from the wallet at once', async () => {
  const sent = [], seen = [];
  const a = adapter({ held: true, notes: [{ leaf: '0x' + '0'.repeat(63) + '1', value: '5000' }], transfer: async (o) => { seen.push(o); return o.selfSettle({ jobId: 'c2', publicValues: '0x1', proof: '0x2', memos: [] }); }, selfSettle: async (x) => { sent.push(x); return { txHash: '0x9' }; } });
  await a.evm.prepare({ rec: { offer: { evm: { amount: '1000' } } } });
  assert.equal(typeof seen[0].selfSettle, 'function'); assert.deepEqual(sent.map((x) => x.jobId), ['c2']);
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

// ── a provider with an account of its own: what the relay refuses at the door is proved prove-only and sent from the account ──

test('a lock the relay refuses at the door (its free settles for the day are used up) is proved prove-only and sent from the own account at once; the relay is not asked again while its wait runs', async () => {
  const asked = [], proved = [], sent = [];
  const a = adapter({
    ownAccount: { address: '0xabc' },
    submitOp: async (spec) => { asked.push(spec.type); throw refuse('relay 429: free relayed settles for today are used up (48/48) — attach a fee above the floor, or prove-mode and settle it yourself', { code: 'free_budget' }); },
    prove: async (spec) => { proved.push(spec); return { jobId: 'p1', status: 'proven', publicValues: '0x5', proof: '0x6', memos: ['0x7'] }; },
    selfSettle: async (x) => { sent.push(x); return { txHash: '0xfeed' }; },
  });
  const { jobId } = await a.evm.submit('adaptorlock', BUNDLE);
  assert.match(jobId, /^own-adaptorlock-/, 'a job of its own, not one the relay knows');
  assert.equal(asked.length, 1);
  assert.equal(await a.evm.jobStatus(jobId, { type: 'adaptorlock', bundle: BUNDLE }), 'pending'); await tick(); await tick();
  assert.deepEqual(proved.map((x) => [x.type, x.op.kind]), [['adaptorlock', 'lock']], 'the same op, proved prove-only: not one of the free settles');
  assert.deepEqual(sent, [{ jobId: 'p1', publicValues: '0x5', proof: '0x6', memos: ['0x7'] }], 'sent at once, with no while given to the relay');
  assert.equal(await a.evm.jobStatus(jobId, { type: 'adaptorlock', bundle: BUNDLE }), 'settled');
  assert.equal(sent.length, 1, 'sent once');
  a.at(5000); const second = await a.evm.submit('adaptorlock', BUNDLE);
  assert.match(second.jobId, /^own-/); assert.equal(asked.length, 1, 'the relay is not asked again within its wait');
  a.at(59999); await a.evm.submit('adaptorlock', BUNDLE); assert.equal(asked.length, 1, 'the wait is a minute when the relay names none');
  a.at(60000); await a.evm.submit('adaptorlock', BUNDLE); assert.equal(asked.length, 2, 'asked again once the wait is over');
});

test('an own job that is not yet sent is proved and sent again after a restart (the record has the op), and a try that fails waits before the next', async () => {
  let n = 0;
  const a = adapter({
    ownAccount: { address: '0xabc' }, submitOp: async () => { throw refuse('relay 429: the relay can’t take this one just now: it is catching up on settles. Send it from your own account instead', { code: 'relay_held', retryAfter: 300 }); },
    prove: async () => ({ jobId: 'p', status: 'proven', publicValues: '0x1', proof: '0x2', memos: [] }),
    selfSettle: async () => { n++; if (n === 1) throw new Error('insufficient funds'); return { txHash: '0x1' }; },
  });
  const { jobId } = await a.evm.submit('adaptorlock', BUNDLE);
  await a.evm.jobStatus(jobId, { type: 'adaptorlock', bundle: BUNDLE }); await tick(); await tick();
  assert.equal(n, 1); assert.match(a.logs.find((l) => l.level === 'warn' && l.error).error, /insufficient funds/);
  a.at(4999); await a.evm.jobStatus(jobId, { type: 'adaptorlock', bundle: BUNDLE }); assert.equal(n, 1, 'waits after a failure');
  a.at(5000); await a.evm.jobStatus(jobId, { type: 'adaptorlock', bundle: BUNDLE }); await tick(); await tick(); assert.equal(n, 2);
  assert.equal(await a.evm.jobStatus(jobId, { type: 'adaptorlock', bundle: BUNDLE }), 'settled');
  // a process that started after: the id is all it has, with the op from the record
  let m = 0;
  const b = adapter({ ownAccount: { address: '0xabc' }, prove: async () => ({ jobId: 'q', publicValues: '0x1', proof: '0x2', memos: [] }), selfSettle: async () => { m++; return { txHash: '0x2' }; } });
  assert.equal(await b.evm.jobStatus('own-adaptorlock-zz-1', { type: 'adaptorlock', bundle: BUNDLE }), 'pending'); await tick(); await tick();
  assert.equal(m, 1); assert.equal(await b.evm.jobStatus('own-adaptorlock-zz-1', { type: 'adaptorlock', bundle: BUNDLE }), 'settled');
  assert.equal(await b.evm.jobStatus('own-adaptorlock-yy-2'), 'pending', 'with no op to prove it waits, and is not called failed by asking the relay');
});

test('a refusal is kept per type of op: with the free settles used up for a lock, a refund that carries a fee still goes to the relay, and a refusal of a refund does not stop the provider quoting', async () => {
  const asked = [];
  const a = adapter({
    ownAccount: { address: '0xabc' }, selfSettle: async () => ({}),
    submitOp: async (spec) => { asked.push(spec.type); if (spec.type === 'adaptorlock') throw refuse('relay 429: free relayed settles for today are used up (48/48)', { code: 'free_budget' }); return { jobId: 'relay-refund' }; },
  });
  assert.match((await a.evm.submit('adaptorlock', BUNDLE)).jobId, /^own-/);
  assert.deepEqual(await a.evm.submit('adaptorrefund', BUNDLE), { jobId: 'relay-refund' }, 'the relay is asked about the refund, which pays its way');
  assert.deepEqual(asked, ['adaptorlock', 'adaptorrefund']);
  const b = adapter({ ownAccount: { address: '0xabc' }, selfSettle: async () => ({}), balance: 0n, submitOp: async () => { throw refuse('relay 429: the settle bound fee is below the marginal cost of $0.30', {}); } });
  await b.evm.submit('adaptorrefund', BUNDLE);
  assert.equal((await b.evm.ready()).ok, true, 'only a refused lock says the provider cannot lock');
});

test('a fault is not a refusal: it is thrown and not remembered; a refusal of a provider with no account of its own is thrown, and said again without asking the relay', async () => {
  let asked = 0;
  const fault = adapter({ ownAccount: { address: '0xabc' }, selfSettle: async () => ({}), submitOp: async () => { asked++; throw new Error('relay 500: boom'); } });
  await assert.rejects(fault.evm.submit('adaptorlock', BUNDLE), /boom/); await assert.rejects(fault.evm.submit('adaptorlock', BUNDLE), /boom/);
  assert.equal(asked, 2, 'a fault is asked again at once');
  asked = 0;
  const page = adapter({ selfSettle: async () => ({}), submitOp: async () => { asked++; throw refuse('relay 429: too many submit requests — retry in ~40s', { retryAfter: 40 }); } });
  await assert.rejects(page.evm.submit('adaptorclaim', BUNDLE), /too many submit requests/);
  page.at(1000); await assert.rejects(page.evm.submit('adaptorclaim', BUNDLE), /too many submit requests/);
  assert.equal(asked, 1, 'within the relay’s own wait the refusal is said again, the relay is not asked');
  page.at(41000); await assert.rejects(page.evm.submit('adaptorclaim', BUNDLE), /too many/); assert.equal(asked, 2);
  const ok = adapter({ ownAccount: { address: '0xabc' }, selfSettle: async () => ({}) });
  assert.deepEqual(await ok.evm.submit('adaptorlock', BUNDLE), { jobId: 'relay-job' }, 'a relay that takes it is used as before');
});

test('ready: the relay is a way while it proves and sends; otherwise only an own account with the gas of a settle, read at most every 20 s', async () => {
  const noop = async () => ({ txHash: '0x' });
  assert.deepEqual(await adapter().evm.ready(), { ok: true });
  assert.match((await adapter({ relayState: 'paused' }).evm.ready()).why, /not proving/);
  assert.match((await adapter({ relayState: 'down', ownAccount: { address: '0xabc' }, selfSettle: noop }).evm.ready()).why, /not proving/, 'a relay that does not prove cannot prove it for the account either');
  const held = await adapter({ held: true }).evm.ready();
  assert.deepEqual([held.ok, /not sending settles/.test(held.why)], [false, true], 'held, and no way of its own');
  assert.deepEqual(await adapter({ held: true, selfSettle: noop }).evm.ready(), { ok: true }, 'a wallet the page asks is the way, as it always was');
  const rich = adapter({ held: true, ownAccount: { address: '0xabc' }, selfSettle: noop, balance: 10n ** 16n });
  assert.deepEqual(await rich.evm.ready(), { ok: true });
  assert.ok(rich.reads.includes('eth_getBalance'));
  const poor = await adapter({ held: true, ownAccount: { address: '0xabc' }, selfSettle: noop, balance: 10n ** 12n }).evm.ready();
  assert.deepEqual([poor.ok, /low on ETH/.test(poor.why)], [false, true]);
  const cheap = await adapter({ held: true, ownAccount: { address: '0xabc' }, selfSettle: noop, balance: 489059220684905n, gasPrice: 61820471n }).evm.ready();
  assert.equal(cheap.ok, true, 'the balance the house provider holds today covers a settle at today’s gas');
  const dear = await adapter({ held: true, ownAccount: { address: '0xabc' }, selfSettle: noop, balance: 489059220684905n, gasPrice: 5n * 10n ** 9n }).evm.ready();
  assert.equal(dear.ok, false, 'and not at 5 gwei');
  const blind = await adapter({ held: true, ownAccount: { address: '0xabc' }, selfSettle: noop, balance: new Error('node down') }).evm.ready();
  assert.deepEqual([blind.ok, /cannot be read/.test(blind.why)], [false, true]);
  // a refusal at the door makes the relay not a way for its wait, whatever its state says
  const r = adapter({ ownAccount: { address: '0xabc' }, selfSettle: noop, balance: 0n, submitOp: async () => { throw refuse('relay 429: free relayed settles for today are used up (48/48)', { code: 'free_budget' }); } });
  assert.equal((await r.evm.ready()).ok, true);
  r.at(1); await r.evm.submit('adaptorlock', BUNDLE);
  const after = await r.evm.ready();
  assert.deepEqual([after.ok, /free settles for today are used up, and the provider’s own account is low on ETH/.test(after.why)], [false, true], 'the refusal is seen at once, not after the cache runs out');
  r.at(700000); assert.equal((await r.evm.ready()).ok, true, 'and forgotten once its wait is over');
  const c = adapter({ held: true, ownAccount: { address: '0xabc' }, selfSettle: noop });
  const balanceReads = () => c.reads.filter((m) => m === 'eth_getBalance').length;
  await c.evm.ready(); c.at(19999); await c.evm.ready(); assert.equal(balanceReads(), 1, 'read once within 20 s');
  c.at(20000); await c.evm.ready(); assert.equal(balanceReads(), 2, 'and again after');
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
  const told = [], t = walletStub();
  await walletSettle({ ux: t.ux, wallet: () => t.w, ask: (on) => told.push(on), sleep: async () => {} })({ proof: '0x1' });
  assert.deepEqual(told, [true, false], 'the page is told while the wallet is asked, and when it is done');
  const fails = walletStub({ call: new Error('execution reverted') }), told2 = [];
  await assert.rejects(walletSettle({ ux: fails.ux, wallet: () => fails.w, ask: (on) => told2.push(on) })({ proof: '0x1' }));
  assert.deepEqual(told2, [true, false], 'and done when it fails');
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

// ── the retry storm of 2026-11-14: a send that failed asked the relay for a new proof each minute, 240 of them for want of ETH ──
const proofOf = (id = 'p1') => ({ jobId: id, status: 'proven', publicValues: '0x5', proof: '0x6', memos: [] });
const lockAgain = { type: 'adaptorlock', bundle: BUNDLE };

test('a proof that was made but could not be sent is kept: each try sends it, the waits double, and no other proof is asked for', async () => {
  const proved = [], sent = []; let fails = 2;
  const a = adapter({ status: { status: 'pending' }, held: true, prove: async (spec) => { proved.push(spec); return proofOf(); },
    selfSettle: async (x) => { sent.push(x.jobId); if (fails-- > 0) throw new Error('insufficient ETH for gas: 0x1 holds 5 wei and this transaction reserves 9 wei up front'); return { txHash: '0xa' }; } });
  const ask = () => a.evm.jobStatus('j', lockAgain);
  await ask(); a.at(1000); await ask(); await tick(); await tick();
  assert.equal(proved.length, 1, 'proved once; the send failed');
  a.at(6000 - 1); await ask(); await tick(); assert.equal(sent.length, 1, 'the first wait is the base one, 5 s');
  a.at(6000); await ask(); await tick(); await tick();
  assert.equal(sent.length, 2); assert.equal(proved.length, 1, 'the same proof is sent again, not another asked for');
  a.at(16000 - 1); await ask(); await tick(); assert.equal(sent.length, 2, 'the second failure doubled the wait to 10 s');
  a.at(16000); await ask(); await tick(); await tick();
  assert.deepEqual([proved.length, sent.length], [1, 3]);
  assert.equal(await ask(), 'settled');
});

test('no proof is asked for while the account has too little ETH to send the settle, and one is asked for once it has', async () => {
  const proved = [], sent = []; let eth = 10n ** 12n;                              // far under what a settle reserves
  const a = adapter({ status: { status: 'pending' }, held: true, ownAccount: { address: '0x' + 'cc'.repeat(20) }, balance: () => eth,
    prove: async (spec) => { proved.push(spec); return proofOf(); }, selfSettle: async (x) => { sent.push(x.jobId); return { txHash: '0xa' }; } });
  const ask = () => a.evm.jobStatus('j', lockAgain);
  await ask(); a.at(1000); await ask(); await tick(); await tick();
  assert.equal(proved.length, 0, 'the relay is not asked for a proof that could not be sent');
  assert.ok(a.logs.some((l) => l.level === 'warn' && /too little ETH/.test(l.msg)));
  eth = 10n ** 18n; a.at(6000); await ask(); await tick(); await tick();
  assert.deepEqual([proved.length, sent.length], [1, 1]);
  assert.equal(await ask(), 'settled');
});

test('a refusal that says how long to wait is waited out, and the waits double with each failure in a row', async () => {
  let n = 0;
  const errs = [refuse('relay 429: too many submit requests — retry in ~26s'), new Error('prove timed out (box offline or backlogged)'), new Error('prove timed out (box offline or backlogged)')];
  const a = adapter({ status: { status: 'pending' }, held: true, prove: async () => { if (n < errs.length) throw errs[n++]; return proofOf(); }, selfSettle: async () => ({ txHash: '0x1' }) });
  const ask = () => a.evm.jobStatus('j', lockAgain);
  await ask(); a.at(1000); await ask(); await tick(); await tick();
  a.at(28000 - 1); await ask(); await tick(); assert.equal(n, 1, 'not before the 26 s it asked for (and a second)');
  a.at(28000); await ask(); await tick(); await tick(); assert.equal(n, 2);
  a.at(38000 - 1); await ask(); await tick(); assert.equal(n, 2, 'the second failure: 10 s');
  a.at(38000); await ask(); await tick(); await tick(); assert.equal(n, 3);
  a.at(58000 - 1); await ask(); await tick(); assert.equal(n, 3, 'the third: 20 s');
  a.at(58000); await ask(); await tick(); await tick();
  assert.equal(await ask(), 'settled');
});

test('a proof the pool refuses is not kept: the next try asks for another', async () => {
  const proved = []; let n = 0;
  const a = adapter({ status: { status: 'pending' }, held: true, prove: async (spec) => { proved.push(spec); return proofOf(); },
    selfSettle: async () => { if (n++ === 0) throw new Error('execution reverted'); return { txHash: '0x2' }; } });
  const ask = () => a.evm.jobStatus('j', lockAgain);
  await ask(); a.at(1000); await ask(); await tick(); await tick();
  assert.equal(proved.length, 1);
  a.at(6000); await ask(); await tick(); await tick();
  assert.equal(proved.length, 2, 'the pool would not take the first, so it is made again');
  assert.equal(await ask(), 'settled');
});

test('at most two sends from the account are under way at once, so a backlog does not ask the relay for every proof together', async () => {
  const started = []; let release;
  const gate = new Promise((r) => { release = r; });
  const a = adapter({ status: { status: 'pending' }, held: true, prove: async () => { started.push(1); return proofOf(); }, selfSettle: async () => { await gate; return { txHash: '0x3' }; } });
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const all = async () => { for (const id of ids) await a.evm.jobStatus(id, lockAgain); await tick(); await tick(); };
  await all(); a.at(1000); await all();
  assert.equal(started.length, 2, 'two proofs are asked for, and the other three wait');
  release(); await tick(); await tick(); await tick();
  await all();
  assert.equal(started.length, 4, 'two more once the first two are done');
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} self-settle checks passed`);
process.exit(process.exitCode || 0);
