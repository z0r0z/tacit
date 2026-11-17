// dapp/fixed-pool-paymaster.js: the operation it builds is the one the wallet keychain's own code builds, byte for
// byte (the reference below came from that code with a public test key and fixed inputs), its gas rules refuse
// what the keychain refuses, and it gets a withdrawal through a bundler that answers as the public one does.
//
// Run: node tests/fixed-pool-paymaster.test.mjs

import { register } from 'node:module';
// the page's modules import each other by site path ("/x.js?cb="); this maps those to dapp/
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

import { hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
const P = await import('../dapp/fixed-pool-paymaster.js');

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

// from the keychain's own buildSignedTornadoUserOp and encodePoolPaymasterData
const GOLDEN = {
  "key": "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
  "proofHex": "0x0b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186abd0f51a3f6489aed3f81d42678cb1d6fb20456a8fb4d9fe23486d92b7dc01264b7095badf04294e7398bde2072c51769bc0e50a2f54799ec3e80d32577ca1c6eb10355a7fa4c9ee13385d82a7ccf1163b6085aacff4193e6388add2f71c41668bb0d5fa1f44698eb3d8fd22476c91b6db00254a6f94b9de03284d7297bce1062b50759abfe4092e53789dc2e70c31567ba0c5ea0f34597ea3c8ed12375c81a6cbf0153a5f84a9cef3183d6287acd1f61b40658aafd4f91e43688db2d7fc21466b90b5daff24496e93b8dd02274c7196bbe0052a4f7499bee3082d52779cc1e6",
  "root": "0x1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
  "nullifierHash": "0x2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b",
  "recipient": "0x00000000000000000000000000000000000dead1",
  "fee": "123456789012345",
  "paymasterData": "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000008c4a04d872a6c1be37964a21ba3a138525dff50b00000000000000000000000000000000000000000000000000000000000000c01a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b00000000000000000000000000000000000000000000000000000000000dead100000000000000000000000000000000000000000000000000007048860ddf7900000000000000000000000000000000000000000000000000000000000001000b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186abd0f51a3f6489aed3f81d42678cb1d6fb20456a8fb4d9fe23486d92b7dc01264b7095badf04294e7398bde2072c51769bc0e50a2f54799ec3e80d32577ca1c6eb10355a7fa4c9ee13385d82a7ccf1163b6085aacff4193e6388add2f71c41668bb0d5fa1f44698eb3d8fd22476c91b6db00254a6f94b9de03284d7297bce1062b50759abfe4092e53789dc2e70c31567ba0c5ea0f34597ea3c8ed12375c81a6cbf0153a5f84a9cef3183d6287acd1f61b40658aafd4f91e43688db2d7fc21466b90b5daff24496e93b8dd02274c7196bbe0052a4f7499bee3082d52779cc1e6",
  "op": {
    "sender": "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23",
    "nonce": "0x0",
    "callData": "0x",
    "callGasLimit": "0x0",
    "verificationGasLimit": "0xc350",
    "preVerificationGas": "0x186a0",
    "maxFeePerGas": "0x3b9aca07",
    "maxPriorityFeePerGas": "0x3b9aca00",
    "paymaster": "0x835ce2da8ad0d1f5d5a8462a58594006514c39b0",
    "paymasterVerificationGasLimit": "0x6ddd0",
    "paymasterPostOpGasLimit": "0xc350",
    "paymasterData": "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000008c4a04d872a6c1be37964a21ba3a138525dff50b00000000000000000000000000000000000000000000000000000000000000c01a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b00000000000000000000000000000000000000000000000000000000000dead100000000000000000000000000000000000000000000000000007048860ddf7900000000000000000000000000000000000000000000000000000000000001000b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186abd0f51a3f6489aed3f81d42678cb1d6fb20456a8fb4d9fe23486d92b7dc01264b7095badf04294e7398bde2072c51769bc0e50a2f54799ec3e80d32577ca1c6eb10355a7fa4c9ee13385d82a7ccf1163b6085aacff4193e6388add2f71c41668bb0d5fa1f44698eb3d8fd22476c91b6db00254a6f94b9de03284d7297bce1062b50759abfe4092e53789dc2e70c31567ba0c5ea0f34597ea3c8ed12375c81a6cbf0153a5f84a9cef3183d6287acd1f61b40658aafd4f91e43688db2d7fc21466b90b5daff24496e93b8dd02274c7196bbe0052a4f7499bee3082d52779cc1e6",
    "signature": "0xa986c39d59f573d9966194e34f72e5266329546ff3a187992b3d9a8c218cea927a515f34df1dda44e08cbc26c37331ff62487e4e8a6f64725af804ab26f631981c",
    "eip7702Auth": {
      "address": "0xe6Cae83BdE06E4c305530e199D7217f42808555B",
      "chainId": "0xaa36a7",
      "nonce": "0x0",
      "r": "0x89504953185c6d3b89b33113cb394eb414bcda8813cd686928a84b9140047e4e",
      "s": "0x56f8935c47408aac1f65a4362b2d1eabc4e25eb78f29df4efcabb1f3da55315c",
      "yParity": "0x0"
    }
  }
};
const POOL = '0x8C4A04d872a6C1BE37964A21ba3a138525dFF50b';
const PAYMASTER = '0x835ce2da8ad0d1f5d5a8462a58594006514c39b0';
const GAS = { ...P.BASELINE };

console.log('the operation, against the keychain\'s');
await test('the paymaster data is what the keychain encodes', () => {
  eq(P.encodePaymasterData({ instance: POOL, proof: GOLDEN.proofHex, root: GOLDEN.root, nullifierHash: GOLDEN.nullifierHash, recipient: GOLDEN.recipient, fee: BigInt(GOLDEN.fee) }), GOLDEN.paymasterData);
});
await test('the signed operation matches the keychain\'s field for field, signature and authorization included', async () => {
  const op = await P.buildDirectUserOp({ key: hexToBytes(GOLDEN.key.slice(2)), chainId: 11155111, paymaster: PAYMASTER, paymasterData: GOLDEN.paymasterData, gas: GAS, maxFeePerGas: 1000000007n, maxPriorityFeePerGas: 1000000000n });
  for (const f of Object.keys(GOLDEN.op)) {
    if (f === 'eip7702Auth') { for (const g of Object.keys(GOLDEN.op.eip7702Auth)) eq(String(op.eip7702Auth[g]).toLowerCase(), String(GOLDEN.op.eip7702Auth[g]).toLowerCase(), 'auth ' + g); continue; }
    eq(String(op[f]).toLowerCase(), String(GOLDEN.op[f]).toLowerCase(), f);
  }
  eq(Object.keys(op).sort().join(), Object.keys(GOLDEN.op).sort().join(), 'the same fields');
});

console.log('gas rules');
await test('the fee is the EntryPoint prefund a fifth over', () => {
  eq(P.minimumViableFee(GAS, 1_000_000_000n), (650_000n * 1_000_000_000n * 12n) / 10n);
});
const REF = { baseFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
await test('a bundler price near the node\'s is taken', () => P.assertGasPriceWithinBounds({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }, REF));
await test('a price over three base fees plus the tip cap is refused', () => {
  let msg = null; try { P.assertGasPriceWithinBounds({ maxFeePerGas: 5_100_000_000n, maxPriorityFeePerGas: 1_000_000_000n }, REF); } catch (e) { msg = e.message; }
  if (!msg || !/over what the wallet/.test(msg)) throw new Error('accepted: ' + msg);
});
await test('a tip over the cap, or over the fee, or below zero is refused', () => {
  for (const p of [{ maxFeePerGas: 9_000_000_000n, maxPriorityFeePerGas: 3_000_000_000n }, { maxFeePerGas: 1n, maxPriorityFeePerGas: 2n }, { maxFeePerGas: -1n, maxPriorityFeePerGas: -2n }]) {
    let threw = false; try { P.assertGasPriceWithinBounds(p, REF); } catch { threw = true; }
    if (!threw) throw new Error('accepted ' + JSON.stringify(p, (_, v) => typeof v === 'bigint' ? String(v) : v));
  }
});
await test('limits past twice the baseline are refused; the verification ceiling is 250k', () => {
  P.assertGasLimitsWithinBounds({ ...GAS, verificationGasLimit: 250_000n }, GAS);
  for (const bad of [{ verificationGasLimit: 250_001n }, { paymasterVerificationGasLimit: 900_001n }, { paymasterPostOpGasLimit: 100_001n }, { preVerificationGas: 700_001n }]) {
    let threw = false; try { P.assertGasLimitsWithinBounds({ ...GAS, ...bad }, GAS); } catch { threw = true; }
    if (!threw) throw new Error('accepted ' + Object.keys(bad));
  }
});
await test('the fallback raises a direct note\'s limits to the keychain\'s targets and keeps higher ones', () => {
  const op = { callData: '0x', paymasterData: '0x' + '00'.repeat(600) };
  const fb = P.fallbackGas(GAS, op);
  eq(fb.verificationGasLimit, 150_000n); eq(fb.paymasterVerificationGasLimit, 650_000n); eq(fb.preVerificationGas, 300_000n + 88n * 40n);
  const high = P.fallbackGas({ ...GAS, verificationGasLimit: 200_000n, paymasterVerificationGasLimit: 700_000n, preVerificationGas: 500_000n }, op);
  eq(high.verificationGasLimit, 200_000n); eq(high.paymasterVerificationGasLimit, 700_000n); eq(high.preVerificationGas, 500_000n);
});
await test('a failure is told from a refusal: transport and the opaque estimator error fall back, a revert does not', () => {
  const op = { callData: '0x', callGasLimit: '0x0' };
  eq(P.estimationUnavailableReason({ kind: 'network' }, op), 'transport-unavailable');
  eq(P.estimationUnavailableReason({ kind: 'http', status: 503 }, op), 'transport-unavailable');
  eq(P.estimationUnavailableReason({ kind: 'http', status: 400 }, op), undefined);
  eq(P.estimationUnavailableReason({ kind: 'rpc', code: -32603, details: 'Unknown error, could not parse simulate validation result' }, op), 'bundler-internal');
  eq(P.estimationUnavailableReason({ kind: 'rpc', code: -32500, details: 'AA33 reverted' }, op), undefined);
  eq(P.estimationUnavailableReason({ kind: 'rpc', code: -32500, details: 'revert 0x54107e37' + '0'.repeat(63) + '5' }, op), 'bundler-internal');
  eq(P.estimationUnavailableReason({ kind: 'rpc', code: -32500, details: 'revert 0x54107e37' + '0'.repeat(64) }, op), undefined);
});

console.log('preparing and sending');
const DENOM = 10n ** 17n;
const REFERENCE = { baseFeePerGas: 100_000_000n, maxPriorityFeePerGas: 0n };
const PRICE = { slow: { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' }, standard: { maxFeePerGas: '0x' + (400_000_000n).toString(16), maxPriorityFeePerGas: '0x' + (100_000_000n).toString(16) }, fast: { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' } };
const proofFields = () => ({ proof: GOLDEN.proofHex, root: GOLDEN.root, nullifierHash: GOLDEN.nullifierHash });
const fakeBundler = (handlers) => ({ calls: [], async request(method, params) { this.calls.push(method); const h = handlers[method]; if (!h) throw Object.assign(new Error('no ' + method), { kind: 'rpc', code: -32601 }); return typeof h === 'function' ? h(params) : h; } });
const est = (o = {}) => ({ callGasLimit: '0x0', verificationGasLimit: '0x' + (40_000n).toString(16), preVerificationGas: '0x' + (60_000n).toString(16), paymasterVerificationGasLimit: '0x' + (350_000n).toString(16), paymasterPostOpGasLimit: '0x' + (30_000n).toString(16), ...o });
const prep = (bundler, extra = {}) => {
  const proved = [];
  return P.prepareSponsoredWithdrawal({ chainId: 11155111, pool: POOL, denomination: DENOM, recipient: GOLDEN.recipient, prove: async (fee) => { proved.push(fee); return proofFields(); }, bundler, reference: REFERENCE, key: hexToBytes(GOLDEN.key.slice(2)), sleep: async () => {}, ...extra, proved }).then((r) => ({ ...r, proved }));
};
await test('an estimate under the baseline keeps the baseline: one proof, the fee for the baseline gas', async () => {
  const b = fakeBundler({ pimlico_getUserOperationGasPrice: PRICE, eth_estimateUserOperationGas: est() });
  const r = await prep(b);
  eq(r.proved.length, 1); eq(r.proved[0], P.minimumViableFee(GAS, 400_000_000n)); eq(r.fee, r.proved[0]); eq(r.gasEstimation.status, 'estimated');
  eq(r.op.callData, '0x'); eq(r.op.callGasLimit, '0x0'); eq(r.op.paymaster, PAYMASTER);
});
await test('an estimate over the baseline raises the limit by a fifth and makes a new proof for the new fee', async () => {
  let n = 0;
  const b = fakeBundler({ pimlico_getUserOperationGasPrice: PRICE, eth_estimateUserOperationGas: () => est(n++ === 0 ? { preVerificationGas: '0x' + (110_000n).toString(16) } : { preVerificationGas: '0x' + (110_000n).toString(16) }) });
  const r = await prep(b);
  eq(r.proved.length, 2); if (!(r.proved[1] > r.proved[0])) throw new Error('fee did not rise');
  eq(BigInt(r.op.preVerificationGas), (110_000n * 12n + 9n) / 10n);
});
await test('a bundler that cannot estimate leaves the keychain\'s fallback limits, and says so', async () => {
  const b = fakeBundler({ pimlico_getUserOperationGasPrice: PRICE, eth_estimateUserOperationGas: () => { throw Object.assign(new Error('x'), { kind: 'network' }); } });
  const r = await prep(b);
  eq(r.gasEstimation.status, 'fallback'); eq(r.gasEstimation.reason, 'transport-unavailable'); eq(BigInt(r.op.verificationGasLimit), 150_000n);
});
await test('a bundler that refuses the operation stops it, with nothing sent', async () => {
  const b = fakeBundler({ pimlico_getUserOperationGasPrice: PRICE, eth_estimateUserOperationGas: () => { throw Object.assign(new Error('AA33 reverted'), { kind: 'rpc', code: -32500, details: 'AA33 reverted' }); } });
  await rejects(prep(b), /would not take the withdrawal: AA33 reverted. Nothing was sent/);
  if (b.calls.includes('eth_sendUserOperation')) throw new Error('sent');
});
await test('a gas price far over the node\'s view is refused before any proof', async () => {
  const b = fakeBundler({ pimlico_getUserOperationGasPrice: { standard: { maxFeePerGas: '0x' + (90_000_000_000n).toString(16), maxPriorityFeePerGas: '0x1' } } });
  const r = await rejects(prep(b), /over what the wallet/);
});
const priceOf = (gwei) => ({ standard: { maxFeePerGas: '0x' + BigInt(Math.round(gwei * 1e9)).toString(16), maxPriorityFeePerGas: '0x' + (100_000_000n).toString(16) } });
const generousRef = { baseFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 10_000_000_000n }; // bounds wide enough for the prices below
await test('the ceiling is 3% of the note: at it passes, a wei over does not', () => {
  const d = 10n ** 17n;
  eq(P.MAX_FEE_PERCENT, 3n);
  eq(P.withinCeiling(3n * 10n ** 15n, d), true); eq(P.withinCeiling(3n * 10n ** 15n + 1n, d), false); eq(P.withinCeiling(0n, d), true);
});
await test('a price at which even the fallback limits stay under the ceiling goes straight to proving', async () => {
  const b = fakeBundler({ pimlico_getUserOperationGasPrice: priceOf(1.0), eth_estimateUserOperationGas: est() });
  const steps = [];
  await prep(b, { reference: generousRef, onStep: (x) => steps.push(x.step) });
  eq(b.calls.filter((m) => m === 'pimlico_getUserOperationGasPrice').length, 1); eq(steps.includes('price'), false);
});
await test('a high price is waited out before any proof, and the fee is made at the calmer one', async () => {
  const prices = [priceOf(2.6), priceOf(2.4), priceOf(0.8)]; let i = 0; const steps = [];
  const b = fakeBundler({ pimlico_getUserOperationGasPrice: () => prices[Math.min(i++, 2)], eth_estimateUserOperationGas: est() });
  const r = await prep(b, { reference: generousRef, onStep: (x) => steps.push(x.step) });
  eq(steps.filter((x) => x === 'price').length, 2, 'waited twice'); eq(r.proved.length, 1);
  eq(r.proved[0], P.minimumViableFee(GAS, 800_000_000n), 'the fee uses the calm price');
});
await test('a price that stays high is an error after the tries, with no proof made and nothing sent', async () => {
  const b = fakeBundler({ pimlico_getUserOperationGasPrice: priceOf(2.6), eth_estimateUserOperationGas: est() });
  const r = await rejects(prep(b, { reference: generousRef, priceTries: 3 }), /Gas is high right now: the fee could come to over 3% of the note/);
  eq(b.calls.filter((m) => m === 'pimlico_getUserOperationGasPrice').length, 4); eq(b.calls.includes('eth_estimateUserOperationGas'), false); eq(b.calls.includes('eth_sendUserOperation'), false);
});
await test('estimates that push the fee over the ceiling stop it, with the fee that was proved not sent', async () => {
  const b = fakeBundler({ pimlico_getUserOperationGasPrice: priceOf(2.1), eth_estimateUserOperationGas: est({ preVerificationGas: '0x' + (580_000n).toString(16) }) });
  await rejects(prep(b, { reference: generousRef }), /over 3% of the note at the limits the bundler asks for/);
  eq(b.calls.includes('eth_sendUserOperation'), false);
});
await test('a fee that would use up the whole note is refused too', async () => {
  const b = fakeBundler({ pimlico_getUserOperationGasPrice: priceOf(2.0), eth_estimateUserOperationGas: est() });
  await rejects(prep(b, { reference: generousRef, denomination: 1_000_000_000_000_000n, maxFeePercent: 100n, priceTries: 0 }), /whole note|over 100%/);
});
await test('a pool the paymaster does not take, or a chain without one, is refused', async () => {
  const b = fakeBundler({ pimlico_getUserOperationGasPrice: PRICE });
  await rejects(prep(b, { pool: '0x' + '11'.repeat(20) }), /does not take this pool/);
  await rejects(prep(b, { chainId: 8453 }), /No paymaster/);
});

const OP = { ...GOLDEN.op };
const okReceipt = { success: true, receipt: { transactionHash: '0x' + 'ab'.repeat(32) } };
await test('a sent operation is waited for and its transaction returned', async () => {
  let polls = 0;
  const b = fakeBundler({ eth_sendUserOperation: '0x1', eth_getUserOperationReceipt: () => (polls++ < 2 ? null : okReceipt) });
  const r = await P.sendSponsoredOperation({ op: OP, chainId: 11155111, bundler: b, sleep: async () => {}, poll: 1 });
  eq(r.txHash, '0x' + 'ab'.repeat(32)); eq(polls, 3);
});
await test('a refusal of the send says nothing was sent', async () => {
  const b = fakeBundler({ eth_sendUserOperation: () => { throw Object.assign(new Error('AA25 invalid nonce'), { kind: 'rpc', code: -32500, details: 'AA25 invalid nonce' }); }, eth_getUserOperationByHash: null });
  await rejects(P.sendSponsoredOperation({ op: OP, chainId: 11155111, bundler: b, sleep: async () => {} }), /did not accept the withdrawal: AA25 invalid nonce. Nothing was sent/);
});
await test('a send whose reply was lost, and which the bundler knows, is waited for; one it does not know is reported as unknown', async () => {
  const lost = () => { throw Object.assign(new Error('timeout'), { kind: 'network' }); };
  const known = fakeBundler({ eth_sendUserOperation: lost, eth_getUserOperationByHash: { sender: OP.sender }, eth_getUserOperationReceipt: okReceipt });
  eq((await P.sendSponsoredOperation({ op: OP, chainId: 11155111, bundler: known, sleep: async () => {} })).txHash, '0x' + 'ab'.repeat(32));
  const unknown = fakeBundler({ eth_sendUserOperation: lost, eth_getUserOperationByHash: null });
  await rejects(P.sendSponsoredOperation({ op: OP, chainId: 11155111, bundler: unknown, sleep: async () => {} }), /Could not tell whether the bundler took/);
});
await test('a resend the bundler already has is taken as sent', async () => {
  const b = fakeBundler({ eth_sendUserOperation: () => { throw Object.assign(new Error('x'), { kind: 'rpc', code: -32500, details: 'userOperation already known' }); }, eth_getUserOperationReceipt: okReceipt });
  eq((await P.sendSponsoredOperation({ op: OP, chainId: 11155111, bundler: b, sleep: async () => {} })).hash.length, 66);
});
await test('an operation that fails on chain is an error with its reason', async () => {
  const b = fakeBundler({ eth_sendUserOperation: '0x1', eth_getUserOperationReceipt: { success: false, reason: 'AA23 reverted', receipt: { transactionHash: '0x' + 'cd'.repeat(32) } } });
  await rejects(P.sendSponsoredOperation({ op: OP, chainId: 11155111, bundler: b, sleep: async () => {} }), /failed on chain: AA23 reverted/);
});
await test('an operation that never shows is reported as maybe still coming', async () => {
  const b = fakeBundler({ eth_sendUserOperation: '0x1', eth_getUserOperationReceipt: null });
  await rejects(P.sendSponsoredOperation({ op: OP, chainId: 11155111, bundler: b, sleep: async () => {}, timeout: 0 }), /may still go through/);
});

console.log('a second bundler');
// Each host answers from its own handlers (a value is the result, a function is called with the params); 'down' fails the fetch, rpcErr / httpErr answer as a bundler does.
const rpcErr = (code, message) => ({ __rpc: { code, message } });
const httpErr = (status) => ({ __status: status });
const hostFetch = (hosts) => {
  const calls = [];
  const f = async (url, init) => {
    const { method, params, id } = JSON.parse(init.body), host = new URL(url).host;
    calls.push(`${host.split('.')[1]} ${method}`);
    let h = hosts[host]?.[method];
    if (h === undefined) h = rpcErr(-32600, `Unsupported method - ${method} not supported`);
    if (h === 'down') throw new Error('fetch failed');
    if (typeof h === 'function') h = h(params);
    if (h?.__status) return { ok: false, status: h.__status, json: async () => { throw new Error('not json'); } };
    if (h?.__rpc) return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, error: h.__rpc }) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result: h }) };
  };
  f.calls = calls;
  return f;
};
const PIM = 'public.pimlico.io', CAN = 'api.candide.dev';
const URLS = ['https://public.pimlico.io/v2/11155111/rpc', 'https://api.candide.dev/public/v3/11155111'];
const setOf = (hosts, urls = URLS) => { const fetchImpl = hostFetch(hosts); return { set: P.bundlerSet(urls, fetchImpl), calls: fetchImpl.calls }; };

await test('every chain with a paymaster names Pimlico first and Candide second, the first is `bundler`, and the Pay page lets the browser reach both', async () => {
  const page = (await import('node:fs')).readFileSync(new URL('../dapp/pay/eth/index.html', import.meta.url), 'utf8');
  const connect = /connect-src([^;]*)/.exec(page)[1].split(/\s+/);
  for (const [chainId, c] of Object.entries(P.PAYMASTERS)) {
    eq(c.bundlers.length, 2, `chain ${chainId}`);
    eq(c.bundlers[0], `https://public.pimlico.io/v2/${chainId}/rpc`); eq(c.bundlers[1], `https://api.candide.dev/public/v3/${chainId}`);
    eq(c.bundler, c.bundlers[0], 'the first');
    for (const u of c.bundlers) if (!connect.includes(new URL(u).origin)) throw new Error(`${new URL(u).origin} is not in connect-src`);
  }
});
await test('one bundler: an error comes back as the plain client gives it', async () => {
  const { set } = setOf({ [PIM]: { eth_estimateUserOperationGas: rpcErr(-32500, 'AA33 reverted') } }, [URLS[0]]);
  const e = await set.request('eth_estimateUserOperationGas', [{}, P.ENTRY_POINT]).catch((x) => x);
  eq(e.kind, 'rpc'); eq(e.details, 'AA33 reverted');
  const { set: down } = setOf({ [PIM]: { eth_sendUserOperation: 'down' } }, [URLS[0]]);
  eq((await down.request('eth_sendUserOperation', [{}, P.ENTRY_POINT]).catch((x) => x)).kind, 'network');
});
await test('the price: the first bundler\'s quote is used when it answers, and the second is never asked', async () => {
  const { set, calls } = setOf({ [PIM]: { pimlico_getUserOperationGasPrice: PRICE, eth_estimateUserOperationGas: est() } });
  const r = await prep(set);
  eq(calls.some((c) => c.startsWith('candide')), false); eq(BigInt(r.op.maxFeePerGas), 400_000_000n);
});
await test('the price: with the first bundler down and the second giving no quote, the node\'s own price is used, within the same bounds', async () => {
  const { set, calls } = setOf({ [PIM]: { pimlico_getUserOperationGasPrice: 'down', eth_estimateUserOperationGas: 'down' }, [CAN]: { eth_estimateUserOperationGas: est() } });
  const r = await prep(set, { nodePrice: async () => ({ maxFeePerGas: 450_000_000n, maxPriorityFeePerGas: 20_000_000n }) });
  eq(BigInt(r.op.maxFeePerGas), 450_000_000n, 'the node price in the operation'); eq(BigInt(r.op.maxPriorityFeePerGas), 20_000_000n);
  eq(r.proved[0], P.minimumViableFee(GAS, 450_000_000n)); eq(r.gasEstimation.status, 'estimated', 'and the second bundler\'s estimate was used');
  eq(calls.includes('candide pimlico_getUserOperationGasPrice'), true, 'the second was asked for a quote first');
  await rejects(prep(setOf({ [PIM]: { pimlico_getUserOperationGasPrice: 'down' } }).set, { nodePrice: async () => ({ maxFeePerGas: 90_000_000_000n, maxPriorityFeePerGas: 1n }) }), /over what the wallet/);
});
await test('the price: with no node price given, a bundler that cannot quote is an error as before; a quote over the bounds is not replaced by the node\'s', async () => {
  await rejects(prep(setOf({ [PIM]: { pimlico_getUserOperationGasPrice: 'down' } }).set), /could not be reached/);
  const over = { standard: { maxFeePerGas: '0x' + (90_000_000_000n).toString(16), maxPriorityFeePerGas: '0x1' } };
  let asked = 0;
  await rejects(prep(setOf({ [PIM]: { pimlico_getUserOperationGasPrice: over } }).set, { nodePrice: async () => { asked++; return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }; } }), /over what the wallet/);
  eq(asked, 0, 'the node price was not asked for');
});
await test('the estimate: a first bundler that cannot be reached passes it to the second; a refusal by the first is final and the second is not asked', async () => {
  const { set } = setOf({ [PIM]: { pimlico_getUserOperationGasPrice: PRICE, eth_estimateUserOperationGas: httpErr(503) }, [CAN]: { eth_estimateUserOperationGas: est() } });
  eq((await prep(set)).gasEstimation.status, 'estimated');
  const refused = setOf({ [PIM]: { pimlico_getUserOperationGasPrice: PRICE, eth_estimateUserOperationGas: rpcErr(-32500, 'AA33 reverted') }, [CAN]: { eth_estimateUserOperationGas: est() } });
  await rejects(prep(refused.set), /would not take the withdrawal: AA33 reverted/);
  eq(refused.calls.includes('candide eth_estimateUserOperationGas'), false);
});
await test('the estimate: the first bundler\'s "cannot tell" followed by the second\'s refusal is still the first\'s answer: the fallback limits, not a refusal', async () => {
  const internal = rpcErr(-32603, 'Unknown error, could not parse simulate validation result');
  const { set } = setOf({ [PIM]: { pimlico_getUserOperationGasPrice: PRICE, eth_estimateUserOperationGas: internal }, [CAN]: { eth_estimateUserOperationGas: rpcErr(-32500, 'AA33 reverted: Cannot find your merkle root') } });
  const r = await prep(set);
  eq(r.gasEstimation.status, 'fallback'); eq(r.gasEstimation.reason, 'bundler-internal');
});
// What the two public bundlers answered for a valid sponsored withdrawal on mainnet (11-17): Pimlico's estimator reverts with the paymaster's gas-ceiling
// error, and Candide answers with the limits it was sent, without the paymaster's. Taken as estimates, those grow by a fifth at every try and never settle.
const QUIRK = rpcErr(-32501, 'UserOperation reverted during simulation with reason: AA33 reverted 0x54107e37' + (20_000_000n).toString(16).padStart(64, '0'));
const echoed = (params) => ({ callGasLimit: '0xda2', preVerificationGas: params[0].preVerificationGas, verificationGasLimit: params[0].verificationGasLimit });
await test('the estimate: a second bundler that hands back the limits it was sent, with none for the paymaster, gives no estimate: the first\'s "cannot tell" stands and the fallback limits are used', async () => {
  const { set, calls } = setOf({ [PIM]: { pimlico_getUserOperationGasPrice: PRICE, eth_estimateUserOperationGas: QUIRK }, [CAN]: { eth_estimateUserOperationGas: echoed } });
  const r = await prep(set);
  eq(r.gasEstimation.status, 'fallback'); eq(r.gasEstimation.reason, 'bundler-internal');
  eq(calls.filter((c) => c === 'candide eth_estimateUserOperationGas').length, 1, 'the second was asked once, not once per try');
  eq(calls.filter((c) => c === 'pimlico eth_estimateUserOperationGas').length, 1);
});
await test('the estimate: with the first bundler down and the second giving no paymaster limits, the fallback limits are used too', async () => {
  const { set } = setOf({ [PIM]: { pimlico_getUserOperationGasPrice: PRICE, eth_estimateUserOperationGas: 'down' }, [CAN]: { eth_estimateUserOperationGas: echoed } });
  const r = await prep(set);
  eq(r.gasEstimation.status, 'fallback'); eq(r.gasEstimation.reason, 'transport-unavailable');
});
await test('the estimate: a lone bundler that answers without the paymaster limits is no more an estimate: the fallback limits, not zeros for the paymaster', async () => {
  const { set } = setOf({ [PIM]: { pimlico_getUserOperationGasPrice: PRICE, eth_estimateUserOperationGas: echoed } }, [URLS[0]]);
  const r = await prep(set);
  eq(r.gasEstimation.status, 'fallback'); eq(r.gasEstimation.reason, 'bundler-internal');
  if (BigInt(r.op.paymasterVerificationGasLimit) < 450_000n) throw new Error('the paymaster verification limit fell below the baseline');
});
await test('the estimate: an answer with the paymaster limits is used from whichever bundler gives it, and an operation with no paymaster is not held to them', async () => {
  const { set } = setOf({ [PIM]: { pimlico_getUserOperationGasPrice: PRICE, eth_estimateUserOperationGas: QUIRK }, [CAN]: { eth_estimateUserOperationGas: est() } });
  eq((await prep(set)).gasEstimation.status, 'estimated');
  const bare = setOf({ [PIM]: { eth_estimateUserOperationGas: { callGasLimit: '0x1', preVerificationGas: '0x1', verificationGasLimit: '0x1' } } }, [URLS[0]]);
  eq((await bare.set.request('eth_estimateUserOperationGas', [{ callData: '0x' }, P.ENTRY_POINT])).verificationGasLimit, '0x1');
  eq(P.estimationUnavailableReason({ kind: 'incomplete-estimate' }, { callData: '0x', callGasLimit: '0x0' }), 'bundler-internal');
});
await test('the send: a first bundler that cannot be reached passes it to the second, which is then the one asked for the receipt (an unknown there is final)', async () => {
  let polls = 0;
  const { set, calls } = setOf({ [PIM]: { eth_sendUserOperation: 'down', eth_getUserOperationReceipt: okReceipt }, [CAN]: { eth_sendUserOperation: '0x1', eth_getUserOperationReceipt: () => (polls++ < 2 ? null : okReceipt) } });
  const r = await P.sendSponsoredOperation({ op: OP, chainId: 11155111, bundler: set, sleep: async () => {}, poll: 1 });
  eq(r.txHash, '0x' + 'ab'.repeat(32));
  eq(calls.filter((c) => c === 'candide eth_getUserOperationReceipt').length, 3);
  eq(calls.filter((c) => c === 'pimlico eth_getUserOperationReceipt').length, 0, 'the first was not asked for it');
});
await test('the send: a refusal by the first bundler says nothing was sent, and the second is not asked', async () => {
  const { set, calls } = setOf({ [PIM]: { eth_sendUserOperation: rpcErr(-32500, 'AA33 reverted') }, [CAN]: { eth_sendUserOperation: '0x1' } });
  await rejects(P.sendSponsoredOperation({ op: OP, chainId: 11155111, bundler: set, sleep: async () => {}, poll: 1 }), /did not accept the withdrawal: AA33 reverted. Nothing was sent/);
  eq(calls.includes('candide eth_sendUserOperation'), false);
});
await test('the send: the first cannot be reached and the second says it already has it: the operation is known, and waited for', async () => {
  const { set } = setOf({ [PIM]: { eth_sendUserOperation: 'down', eth_getUserOperationByHash: 'down', eth_getUserOperationReceipt: null }, [CAN]: { eth_sendUserOperation: rpcErr(-32500, 'already known'), eth_getUserOperationByHash: { sender: '0x1' }, eth_getUserOperationReceipt: okReceipt } });
  const r = await P.sendSponsoredOperation({ op: OP, chainId: 11155111, bundler: set, sleep: async () => {}, poll: 1 });
  eq(r.txHash, '0x' + 'ab'.repeat(32));
});
await test('the send: neither can be reached, and the first\'s error is the one said (it may still go through)', async () => {
  const { set } = setOf({ [PIM]: { eth_sendUserOperation: 'down', eth_getUserOperationByHash: 'down' }, [CAN]: { eth_sendUserOperation: 'down', eth_getUserOperationByHash: 'down' } });
  await rejects(P.sendSponsoredOperation({ op: OP, chainId: 11155111, bundler: set, sleep: async () => {}, poll: 1 }), /Could not tell whether the bundler took the withdrawal/);
});
await test('before any send, a receipt is looked for at both: the first that has it answers, and none having it is unknown', async () => {
  const has = setOf({ [PIM]: { eth_getUserOperationReceipt: null }, [CAN]: { eth_getUserOperationReceipt: okReceipt } });
  eq((await has.set.request('eth_getUserOperationReceipt', ['0x1'])).success, true);
  const none = setOf({ [PIM]: { eth_getUserOperationReceipt: null }, [CAN]: { eth_getUserOperationReceipt: null } });
  eq(await none.set.request('eth_getUserOperationReceipt', ['0x1']), null);
  const broken = setOf({ [PIM]: { eth_getUserOperationReceipt: 'down' }, [CAN]: { eth_getUserOperationReceipt: null } });
  eq(await broken.set.request('eth_getUserOperationReceipt', ['0x1']), null);
});
await test('the node\'s own price: twice the coming block\'s base fee plus the highest median tip, a token tip when the tips are zero, a malformed history refused', async () => {
  const hist = (base, rewards) => ({ request: async ({ method, params }) => { eq(method, 'eth_feeHistory'); eq(JSON.stringify(params), '["0xa","latest",[50]]'); return { baseFeePerGas: base, reward: rewards }; } });
  const g = (n) => '0x' + BigInt(n).toString(16);
  const p = await P.readFallbackGasPrice(hist([g(160_000_000), g(162_000_000), g(170_000_000)], [[g(10_000_000)], [g(150_000_000)]]));
  eq(p.maxFeePerGas, 2n * 170_000_000n + 150_000_000n); eq(p.maxPriorityFeePerGas, 150_000_000n);
  const zero = await P.readFallbackGasPrice(hist([g(100), g(100)], [[g(0)]]));
  eq(zero.maxPriorityFeePerGas, 1_000_000n); eq(zero.maxFeePerGas, 200n + 1_000_000n);
  await rejects(P.readFallbackGasPrice(hist([g(1)], [[g(0)]])), /Invalid host fee history/);
  await rejects(P.readFallbackGasPrice(hist([g(1), g(1)], [[g(0), g(1)]])), /Invalid host fee history/);
  await rejects(P.readFallbackGasPrice({ request: async () => null }), /Invalid host fee history/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
