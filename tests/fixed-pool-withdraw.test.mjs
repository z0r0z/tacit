// The withdraw side of dapp/fixed-pool-flow.js with the real prover (the wasm in dapp/vendor, run in this
// process) against stand-in pools: the note's leaf is found among other deposits, the tree's root must be one the
// pool knows, the proved call is read back field by field before it is sent, and a spent note, a wrong network,
// a bad recipient and a root the pool does not know are all refused before any proof is made.
//
// Run: node tests/fixed-pool-withdraw.test.mjs

import { register } from 'node:module';
// the page's modules import each other by site path ("/x.js?cb="); this maps those to dapp/
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

import { readFileSync } from 'node:fs';
const { makeFlow, checkWithdrawCall } = await import('../dapp/fixed-pool-flow.js');
const { directProver } = await import('../dapp/fixed-pool-prover.js');
const { FIXED_POOLS, deriveSecrets, noteString, commitmentBytes32 } = await import('../dapp/fixed-pool-notes.js');
import { keccak_256, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import init, { Tree, initSync } from '../dapp/vendor/fixed-pool-prover.js';

void init;
initSync({ module: readFileSync(new URL('../dapp/vendor/fixed-pool-prover_bg.wasm', import.meta.url)) });

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`); };
const rejects = async (p, re) => {
  try { await p; } catch (e) { if (!re.test(e.message)) throw new Error(`wrong error: ${e.message}`); return e; }
  throw new Error('did not throw');
};
const enc = new TextEncoder();
const sel = (s) => bytesToHex(keccak_256(enc.encode(s)).slice(0, 4));
const E = 10n ** 18n;
const CHAIN = 11155111;
const POOL = FIXED_POOLS[CHAIN][0]; // 0.1 ETH
const ACCOUNT = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const RECIPIENT = '0x00000000000000000000000000000000000dEaD1';

// a note, from one of the keychain's vectors
const SIG = '0xff77f2f406c836e7ee02cc09f19e6f2ce516f56a7d032e48b07a0e440b9aec4321b29d04f2764724b5939222b736e5067a6a485b669487e6c7e5d045177e10b01b';
const secrets = deriveSecrets({ signature: SIG, pool: POOL.address });
const noteText = noteString({ denomination: POOL.denomination, chainId: CHAIN, preimage: secrets.preimage });

// deposits: pseudo-random field elements around the note's leaf
const MINE_AT = 17, COUNT = 40;
const leavesBytes = () => {
  const out = new Uint8Array(COUNT * 32);
  for (let i = 0; i < COUNT; i++) {
    const c = i === MINE_AT ? hexToBytes(commitmentBytes32(secrets.commitment).slice(2)) : keccak_256(enc.encode(`leaf ${i}`));
    out.set(c, i * 32);
    if (i !== MINE_AT) out[i * 32] &= 0x0f; // keep below the field's modulus
  }
  return out;
};
const rootOf = (bytes) => { const t = new Tree(bytes); const r = t.root(); t.free(); return r; };

function world({ spent = false, knownRoots = new Set(), chainIdOnWallet = CHAIN } = {}) {
  const log = { sends: [], proofs: 0 };
  const provider = {
    async request({ method, params = [] }) {
      switch (method) {
        case 'eth_getCode': return '0x6080';
        case 'eth_call': {
          const { data } = params[0], s = data.slice(2, 10), arg = data.slice(10);
          if (s === sel('denomination()')) return '0x' + POOL.denomination.toString(16).padStart(64, '0');
          if (s === sel('isSpent(bytes32)')) return '0x' + (spent || log.sends.length ? '1' : '0').padStart(64, '0');
          if (s === sel('isKnownRoot(bytes32)')) return '0x' + (knownRoots.has('0x' + arg) ? '1' : '0').padStart(64, '0');
          throw new Error('call ' + s);
        }
        case 'eth_sendTransaction': log.sends.push(params[0]); return '0x' + '11'.repeat(32);
        case 'eth_getTransactionReceipt': return { status: '0x1' };
        default: throw new Error('unexpected ' + method);
      }
    },
  };
  return { provider, log, chainId: chainIdOnWallet };
}
const flowOf = (w) => makeFlow({ provider: w.provider, account: ACCOUNT, chainId: w.chainId, poll: 1, timeout: 2000 });
const leaves = async () => ({ bytes: leavesBytes(), count: COUNT });

console.log('checks on a proved call');
const good = { target: POOL.address, root: '0x' + '22'.repeat(32), nullifierHash: commitmentBytes32(secrets.nullifierHash) };
const callData = ({ root = good.root, nh = good.nullifierHash, to = RECIPIENT, relayer = '0'.repeat(40), fee = 0n, refund = 0n, offset = 224n, len = 256n, proof = '00'.repeat(256), selector = sel('withdraw(bytes,bytes32,bytes32,address,address,uint256,uint256)') } = {}) =>
  '0x' + selector + offset.toString(16).padStart(64, '0') + root.slice(2) + nh.slice(2) + to.slice(2).toLowerCase().padStart(64, '0') + relayer.padStart(64, '0') + fee.toString(16).padStart(64, '0') + refund.toString(16).padStart(64, '0') + len.toString(16).padStart(64, '0') + proof;
const expectOf = { pool: POOL, recipient: RECIPIENT, root: good.root, nullifierHash: secrets.nullifierHash };
await test('a call that says what was asked passes', () => checkWithdrawCall({ ...good, input: callData() }, expectOf));
for (const [name, bad, why] of [
  ['another pool', { target: FIXED_POOLS[CHAIN][1].address, input: callData() }, /pool/],
  ['another function', { input: callData({ selector: 'deadbeef' }) }, /call/],
  ['another recipient', { input: callData({ to: '0x000000000000000000000000000000000000bEEF' }) }, /recipient/],
  ['a relayer', { input: callData({ relayer: '11'.repeat(20) }) }, /relayer/],
  ['a fee', { input: callData({ fee: 1n }) }, /fee/],
  ['a refund', { input: callData({ refund: 1n }) }, /fee/],
  ['another root', { input: callData({ root: '0x' + '33'.repeat(32) }) }, /root/],
  ['another note', { input: callData({ nh: '0x' + '44'.repeat(32) }) }, /note/],
  ['a short proof', { input: callData({ len: 255n, proof: '00'.repeat(255) }) }, /proof size/],
  ['trailing bytes', { input: callData() + '00' }, /length/],
]) {
  await test(`a call with ${name} is refused`, () => {
    let threw = null;
    try { checkWithdrawCall({ ...good, ...bad }, expectOf); } catch (e) { threw = e.message; }
    if (!threw) throw new Error('accepted');
    if (!why.test(threw)) throw new Error(`wrong reason: ${threw}`);
  });
}

const PM = '0x835ce2da8ad0d1f5d5a8462a58594006514c39b0';
await test('a call that names the paymaster and its fee passes when asked for, and not for another fee or relayer', () => {
  const out = { ...good, input: callData({ relayer: PM.slice(2), fee: 777n }) };
  checkWithdrawCall(out, { ...expectOf, relayer: PM, fee: 777n });
  for (const [why, ask] of [['fee', { relayer: PM, fee: 778n }], ['relayer', { relayer: '0x' + '22'.repeat(20), fee: 777n }], ['relayer', {}]]) {
    let threw = null; try { checkWithdrawCall(out, { ...expectOf, ...ask }); } catch (e) { threw = e.message; }
    if (!threw || !threw.includes(why)) throw new Error(`accepted or wrong reason (${why}): ${threw}`);
  }
});
await test('a proof that is not the one in the call is refused', () => {
  let threw = null; try { checkWithdrawCall({ ...good, input: callData(), proof: '0x' + '11'.repeat(256) }, expectOf); } catch (e) { threw = e.message; }
  if (!threw || !threw.includes('proof')) throw new Error('accepted: ' + threw);
  checkWithdrawCall({ ...good, input: callData(), proof: '0x' + '00'.repeat(256) }, expectOf);
});

console.log('refusals before any proof');
const prover = directProver(Tree);
await test('a note for another network is refused', async () => {
  await rejects(flowOf(world({ chainIdOnWallet: 1 })).withdraw({ noteText, recipient: RECIPIENT, prover, leaves }), /network/);
});
await test('a bad recipient is refused', async () => {
  for (const r of ['', '0x1234', '0x' + '0'.repeat(40), 'not an address']) await rejects(flowOf(world()).withdraw({ noteText, recipient: r, prover, leaves }), /address that should receive/);
});
await test('a spent note is refused', async () => {
  await rejects(flowOf(world({ spent: true })).withdraw({ noteText, recipient: RECIPIENT, prover, leaves }), /already spent/);
});
await test('a note whose deposit is not among the deposits read is refused', async () => {
  const other = noteString({ denomination: POOL.denomination, chainId: CHAIN, preimage: new Uint8Array(62).fill(7) });
  await rejects(flowOf(world()).withdraw({ noteText: other, recipient: RECIPIENT, prover, leaves }), /not among the pool's deposits/);
});
await test('a root the pool does not know is refused before the proof', async () => {
  await rejects(flowOf(world()).withdraw({ noteText, recipient: RECIPIENT, prover, leaves }), /root the pool knows/);
});

console.log('withdraw');
const known = new Set([rootOf(leavesBytes())]);
await test('prepare only: proves, checks the call, sends nothing', async () => {
  const w = world({ knownRoots: known });
  const steps = [];
  const t0 = Date.now();
  const out = await flowOf(w).withdraw({ noteText, recipient: RECIPIENT, prover, leaves, send: false, onStep: (s) => steps.push(s.step) });
  console.log(`        (proved in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  eq(out.sent, false); eq(w.log.sends.length, 0);
  eq(out.call.target.toLowerCase(), POOL.address.toLowerCase());
  eq(out.call.nullifierHash, commitmentBytes32(secrets.nullifierHash));
  eq(steps.join(), 'read,tree,prove');
});
await test('send: the wallet is asked once, with the proved call, and the pool then shows the note spent', async () => {
  const w = world({ knownRoots: known });
  const out = await flowOf(w).withdraw({ noteText, recipient: RECIPIENT, prover, leaves });
  eq(out.sent, true); eq(out.spent, true); eq(w.log.sends.length, 1);
  const tx = w.log.sends[0];
  eq(tx.to.toLowerCase(), POOL.address.toLowerCase()); eq(tx.value, '0x0'); eq(tx.from, ACCOUNT); eq(tx.data, out.call.input);
});
await test('wallet-sent confirm: asked once proved, with no fee and the whole note; no is a cancel and the wallet is never asked', async () => {
  const w = world({ knownRoots: known }); let asked = null;
  const e = await rejects(flowOf(w).withdraw({ noteText, recipient: RECIPIENT, prover, leaves, confirm: async (q) => { asked = q; return false; } }), /Cancelled. Nothing was sent/);
  eq(e.cancelled, true); eq(w.log.sends.length, 0, 'nothing sent');
  eq(asked.fee, 0n); eq(asked.receive, POOL.denomination); eq(asked.denomination, POOL.denomination);
});
await test('wallet-sent confirm yes sends it, and the result says the whole note was received', async () => {
  const w = world({ knownRoots: known });
  const out = await flowOf(w).withdraw({ noteText, recipient: RECIPIENT, prover, leaves, confirm: async () => true });
  eq(out.sent, true); eq(w.log.sends.length, 1); eq(out.receive, POOL.denomination); eq(out.spent, true);
});
await test('wallet-sent: a read of the pool that fails after the withdrawal was sent leaves it a sent withdrawal, not an error', async () => {
  const w = world({ knownRoots: known });
  const base = w.provider.request.bind(w.provider);
  let failed = 0;
  w.provider.request = async (r) => {
    if (r.method === 'eth_call' && w.log.sends.length && r.params[0].data.startsWith('0x' + sel('isSpent(bytes32)'))) { failed++; throw new Error('rpc busy'); }
    return base(r);
  };
  const out = await flowOf(w).withdraw({ noteText, recipient: RECIPIENT, prover, leaves });
  eq(out.sent, true); eq(w.log.sends.length, 1); eq(out.spent, false, 'not shown yet'); eq(failed > 0, true, 'the read did fail');
});
await test('another recipient gives another call, to that recipient', async () => {
  const w = world({ knownRoots: known });
  const other = '0x000000000000000000000000000000000000bEEF';
  const a = await flowOf(w).withdraw({ noteText, recipient: RECIPIENT, prover, leaves, send: false });
  const b = await flowOf(w).withdraw({ noteText, recipient: other, prover, leaves, send: false });
  eq(a.call.input === b.call.input, false);
  eq('0x' + b.call.input.slice(10 + 3 * 64 + 24, 10 + 4 * 64), other.toLowerCase());
});

console.log('paid from the note');
const { PAYMASTERS, encodePaymasterData } = await import('../dapp/fixed-pool-paymaster.js');
const bundlerFor = (log, { receiptOk = true } = {}) => ({
  async request(method, params) {
    log.push(method);
    if (method === 'pimlico_getUserOperationGasPrice') return { standard: { maxFeePerGas: '0x' + (400_000_000n).toString(16), maxPriorityFeePerGas: '0x' + (100_000_000n).toString(16) } };
    if (method === 'eth_estimateUserOperationGas') return { callGasLimit: '0x0', verificationGasLimit: '0x9c40', preVerificationGas: '0xea60', paymasterVerificationGasLimit: '0x55730', paymasterPostOpGasLimit: '0x7530' };
    if (method === 'eth_sendUserOperation') { log.sent = params[0]; return '0x1'; }
    if (method === 'eth_getUserOperationReceipt') return receiptOk ? { success: true, receipt: { transactionHash: '0x' + 'ee'.repeat(32) } } : null;
    throw new Error('unexpected ' + method);
  },
});
const sponsoredWorld = (extra = {}) => {
  const w = world({ knownRoots: known, ...extra });
  const orig = w.provider.request;
  w.provider.request = async (r) => {
    if (r.method === 'eth_feeHistory') return { baseFeePerGas: ['0x5f5e100', '0x5f5e100', '0x5f5e100'], reward: [['0x5f5e100'], ['0x5f5e100']] };
    if (r.method === 'eth_getLogs') return [];
    if (r.method === 'eth_blockNumber') return '0x3e8';
    return orig(r);
  };
  return w;
};
await test('prepare only: the operation carries a proof that names the paymaster and takes the fee, and nothing is sent', async () => {
  const w = sponsoredWorld(); const log = [];
  const steps = [];
  const out = await flowOf(w).withdrawSponsored({ noteText, recipient: RECIPIENT, prover, leaves, bundler: bundlerFor(log), send: false, onStep: (s) => steps.push(s.step) });
  eq(out.sent, false); eq(w.log.sends.length, 0); eq(log.includes('eth_sendUserOperation'), false);
  eq(out.receive, POOL.denomination - out.fee);
  if (!(out.fee > 0n && out.fee * 10n < POOL.denomination)) throw new Error('fee out of range: ' + out.fee);
  eq(out.op.paymaster.toLowerCase(), PAYMASTERS[CHAIN].paymaster.toLowerCase()); eq(out.op.callData, '0x');
  // the data the paymaster will decode names the recipient and the fee
  const data = out.op.paymasterData.slice(2);
  const wd = (i) => data.slice(64 + i * 64, 64 + i * 64 + 64);
  eq('0x' + wd(4).slice(24), RECIPIENT.toLowerCase(), 'recipient'); eq(BigInt('0x' + wd(5)), out.fee, 'fee');
  eq(steps.includes('quote'), true);
});
await test('send: the operation goes to the bundler, the wallet is never asked, and the pool then shows the note spent', async () => {
  const w = sponsoredWorld(); const log = [];
  // the pool shows the note spent once the bundler has the operation
  const base = w.provider.request;
  w.provider.request = async (r) => { if (r.method === 'eth_call' && log.sent && r.params[0].data.startsWith('0x' + sel('isSpent(bytes32)'))) return '0x' + '1'.padStart(64, '0'); return base(r); };
  const out = await flowOf(w).withdrawSponsored({ noteText, recipient: RECIPIENT, prover, leaves, bundler: bundlerFor(log) });
  eq(out.sent, true); eq(out.spent, true); eq(out.hash, '0x' + 'ee'.repeat(32));
  eq(w.log.sends.length, 0, 'nothing from the wallet'); eq(log.filter((m) => m === 'eth_sendUserOperation').length, 1);
  eq(log.sent.sender.toLowerCase() === ACCOUNT.toLowerCase(), false, 'sent by a throwaway account');
});
await test('confirm is asked with the fee and what the address gets, before anything is sent; no is a cancel with nothing sent', async () => {
  const w = sponsoredWorld(); const log = []; let asked = null;
  const e = await rejects(flowOf(w).withdrawSponsored({
    noteText, recipient: RECIPIENT, prover, leaves, bundler: bundlerFor(log),
    confirm: async (q) => { asked = q; return false; },
  }), /Cancelled. Nothing was sent/);
  eq(e.cancelled, true); eq(log.includes('eth_sendUserOperation'), false); eq(w.log.sends.length, 0);
  eq(asked.denomination, POOL.denomination); eq(asked.receive, POOL.denomination - asked.fee);
  if (!(asked.fee > 0n && asked.fee * 100n <= POOL.denomination * 3n)) throw new Error('fee over the ceiling: ' + asked.fee);
});
await test('confirm yes sends it', async () => {
  const w = sponsoredWorld(); const log = [];
  const out = await flowOf(w).withdrawSponsored({ noteText, recipient: RECIPIENT, prover, leaves, bundler: bundlerFor(log), confirm: async () => true });
  eq(out.sent, true); eq(log.filter((m) => m === 'eth_sendUserOperation').length, 1);
});
await test('a note on a chain without a paymaster is refused before anything is read', async () => {
  const w = world({ chainIdOnWallet: 8453 });
  await rejects(flowOf(w).withdrawSponsored({ noteText: noteString({ denomination: POOL.denomination, chainId: 8453, preimage: new Uint8Array(62) }), recipient: RECIPIENT, prover, leaves }), /not available on this network/);
});
await test('a bundler that refuses stops the withdrawal with the note unspent', async () => {
  const w = sponsoredWorld();
  const b = { async request(method) { if (method === 'pimlico_getUserOperationGasPrice') return { standard: { maxFeePerGas: '0x17d78400', maxPriorityFeePerGas: '0x5f5e100' } }; throw Object.assign(new Error('AA33 reverted'), { kind: 'rpc', code: -32500, details: 'AA33 reverted' }); } };
  await rejects(flowOf(w).withdrawSponsored({ noteText, recipient: RECIPIENT, prover, leaves, bundler: b }), /Nothing was sent/);
  eq(w.log.sends.length, 0);
});

prover.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
