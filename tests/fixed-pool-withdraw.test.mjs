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
  ['a relayer', { input: callData({ relayer: '11'.repeat(20) }) }, /fee/],
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
await test('another recipient gives another call, to that recipient', async () => {
  const w = world({ knownRoots: known });
  const other = '0x000000000000000000000000000000000000bEEF';
  const a = await flowOf(w).withdraw({ noteText, recipient: RECIPIENT, prover, leaves, send: false });
  const b = await flowOf(w).withdraw({ noteText, recipient: other, prover, leaves, send: false });
  eq(a.call.input === b.call.input, false);
  eq('0x' + b.call.input.slice(10 + 3 * 64 + 24, 10 + 4 * 64), other.toLowerCase());
});

prover.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
