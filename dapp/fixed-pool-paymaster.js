// Paying a fixed-pool withdrawal's gas from the note, through the pool paymaster that already runs on these
// chains (not ours: the wallet keychain's), as one ERC-4337 operation. The note's withdrawal pays the
// paymaster a fee inside validation and the rest goes straight to the recipient, so the recipient needs no ETH
// and no account of ours is involved. This is the keychain's own "direct single note" path, step for step:
//   - the operation's sender is a throwaway account (an EIP-7702 delegation to the standard Simple7702 account,
//     signed by a key made here and dropped); it never holds a thing, since the recipient is paid directly and
//     the operation has no call of its own,
//   - the fee in the proof is the least that covers the operation's gas at the bundler's price (checked against
//     the wallet's own node), and the gas limits are the keychain's baseline, raised to the bundler's estimate
//     plus a fifth, and never past its ceilings,
//   - the proof names the paymaster as relayer, so it is good for that operation only.
// The bundler is the public one the keychain uses. Nothing here is signed by, or sent from, the user's wallet.

import { keccak_256, secp, concatBytes, hexToBytes, bytesToHex } from './vendor/tacit-deps.min.js';

const enc = new TextEncoder();
const word = (n) => hexToBytes(BigInt(n).toString(16).padStart(64, '0'));
const q = (n) => '0x' + BigInt(n).toString(16);
const addr20 = (a) => hexToBytes(a.replace(/^0x/i, '').toLowerCase().padStart(40, '0'));
const hexBytes = (h) => hexToBytes(String(h).replace(/^0x/, ''));
const k = (bytes) => keccak_256(bytes);

export const ENTRY_POINT = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
// The standard EntryPoint v0.8 account for an EIP-7702 sender (eth-infinitism's Simple7702Account).
export const SIMPLE_7702 = '0xe6Cae83BdE06E4c305530e199D7217f42808555B';

// The paymasters and the pools each takes (the keychain's list for these chains; ours are a subset). The bundler
// is the public one, which asks for no key.
export const PAYMASTERS = Object.freeze({
  1: Object.freeze({
    paymaster: '0xB0FfCdC890E969579D348F519a9C3920C2DD04a5',
    bundler: 'https://public.pimlico.io/v2/1/rpc',
    pools: ['0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc', '0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936', '0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF', '0xA160cdAB225685dA1d56aa342Ad8841c3b53f291'],
  }),
  11155111: Object.freeze({
    paymaster: '0x835ce2da8ad0d1f5d5a8462a58594006514c39b0',
    bundler: 'https://public.pimlico.io/v2/11155111/rpc',
    pools: ['0x8C4A04d872a6C1BE37964A21ba3a138525dFF50b', '0x8cc930096B4Df705A007c4A039BDFA1320Ed2508', '0x8D10d506D29Fc62ABb8A290B99F66dB27Fc43585'],
  }),
});

export function paymasterFor(chainId, pool) {
  const c = PAYMASTERS[chainId];
  if (!c) throw new Error('No paymaster on this network.');
  if (!c.pools.some((p) => p.toLowerCase() === pool.toLowerCase())) throw new Error('The paymaster does not take this pool.');
  return c;
}

// ---- gas -------------------------------------------------------------------------------------------------

// A direct note has no call of its own, so callGasLimit is zero.
export const BASELINE = Object.freeze({
  preVerificationGas: 100_000n, verificationGasLimit: 50_000n, callGasLimit: 0n,
  paymasterVerificationGasLimit: 450_000n, paymasterPostOpGasLimit: 50_000n,
});
const GAS_FIELDS = ['callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit'];

// The fee at which the paymaster breaks even: the EntryPoint's required prefund, a fifth over.
export function minimumViableFee(gas, maxFeePerGas) {
  const requiredGas = gas.verificationGasLimit + gas.callGasLimit + gas.paymasterVerificationGasLimit + gas.preVerificationGas + gas.paymasterPostOpGasLimit;
  return (requiredGas * BigInt(maxFeePerGas) * 12n) / 10n;
}

const MIN_TIP_CAP = 2_000_000_000n, MAX_TIP_CAP = 20_000_000_000n;
const hostQuantity = (v) => {
  if (typeof v !== 'string' || !/^0x[0-9a-f]+$/i.test(v)) throw new Error('Invalid host gas price reference');
  return BigInt(v);
};

// What the wallet's own node says gas costs, independent of the bundler: the highest 90th-percentile tip of the
// last ten blocks and the latest block's base fee.
export async function readGasFeeReference(provider) {
  try {
    const h = await provider.request({ method: 'eth_feeHistory', params: ['0xa', 'latest', [90]] });
    if (!Array.isArray(h?.reward) || !h.reward.length || h.reward.length > 10 || !Array.isArray(h.baseFeePerGas) || h.baseFeePerGas.length !== h.reward.length + 1) throw new Error('Invalid host fee history');
    let tip = 0n;
    for (const row of h.reward) {
      if (!Array.isArray(row) || row.length !== 1) throw new Error('Invalid host fee history');
      const r = hostQuantity(row[0]);
      if (r > tip) tip = r;
    }
    return { baseFeePerGas: hostQuantity(h.baseFeePerGas.at(-2)), maxPriorityFeePerGas: tip };
  } catch { /* fall through to the block and the node's suggestion */ }
  const block = await provider.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
  if (block?.baseFeePerGas == null) throw new Error('Failed to read the latest block base fee');
  const tip = await provider.request({ method: 'eth_maxPriorityFeePerGas', params: [] }).then(hostQuantity).catch(() => 0n);
  return { baseFeePerGas: hostQuantity(block.baseFeePerGas), maxPriorityFeePerGas: tip };
}

// The fee comes out of the note, so a bundler that quotes far over the node's own view is refused.
export function assertGasPriceWithinBounds(price, reference) {
  const est = reference.maxPriorityFeePerGas * 3n;
  const tipCap = est < MIN_TIP_CAP ? MIN_TIP_CAP : est > MAX_TIP_CAP ? MAX_TIP_CAP : est;
  const feeCap = reference.baseFeePerGas * 3n + tipCap;
  if (typeof price.maxFeePerGas !== 'bigint' || typeof price.maxPriorityFeePerGas !== 'bigint' || price.maxFeePerGas < 0n || price.maxPriorityFeePerGas < 0n || price.maxPriorityFeePerGas > price.maxFeePerGas) throw new Error('Bundler returned invalid gas prices');
  if (price.maxPriorityFeePerGas > tipCap || price.maxFeePerGas > feeCap) {
    throw new Error(`The bundler's gas price is over what the wallet's node shows (asked ${price.maxFeePerGas} wei, limit ${feeCap} wei).`);
  }
}

const DIRECT_VERIFICATION_GAS_CEILING = 250_000n;
// The keychain's bound on fixed overhead and on preVerificationGas, which grows with the payload.
export function assertGasLimitsWithinBounds(gas, baseline, op) {
  const bytes = op ? BigInt(hexBytes(op.callData).length + hexBytes(op.paymasterData ?? '0x').length) : 0n;
  const caps = {
    verificationGasLimit: baseline.verificationGasLimit * 2n < DIRECT_VERIFICATION_GAS_CEILING ? DIRECT_VERIFICATION_GAS_CEILING : baseline.verificationGasLimit * 2n,
    paymasterVerificationGasLimit: baseline.paymasterVerificationGasLimit * 2n,
    paymasterPostOpGasLimit: baseline.paymasterPostOpGasLimit * 2n,
    preVerificationGas: (350_000n + 40n * bytes) * 2n,
  };
  for (const f of GAS_FIELDS) {
    if (typeof gas[f] !== 'bigint' || gas[f] < 0n) throw new Error(`Invalid paymaster gas limit: ${f}`);
    if (caps[f] !== undefined && gas[f] > caps[f]) throw new Error(`The bundler's ${f} ${gas[f]} is over the ceiling ${caps[f]}.`);
  }
}

// When the bundler cannot estimate (it is down, or cannot simulate this paymaster), the keychain falls back to
// fixed targets for a direct note. The bundler may still refuse them.
export function fallbackGas(current, op) {
  const bytes = BigInt(hexBytes(op.callData).length + hexBytes(op.paymasterData ?? '0x').length);
  const extra = bytes > 512n ? bytes - 512n : 0n;
  const pvg = 300_000n + extra * 40n;
  return {
    ...current,
    verificationGasLimit: current.verificationGasLimit < 150_000n ? 150_000n : current.verificationGasLimit,
    paymasterVerificationGasLimit: current.paymasterVerificationGasLimit < 650_000n ? 650_000n : current.paymasterVerificationGasLimit,
    preVerificationGas: current.preVerificationGas > pvg ? current.preVerificationGas : pvg,
  };
}

// ---- encoding --------------------------------------------------------------------------------------------

// abi.encode of the paymaster's one argument: (address instance, bytes proof, bytes32 root, bytes32 nullifierHash,
// address recipient, uint256 fee).
export function encodePaymasterData({ instance, proof, root, nullifierHash, recipient, fee }) {
  const p = hexBytes(proof);
  const padded = new Uint8Array(Math.ceil(p.length / 32) * 32);
  padded.set(p);
  return '0x' + bytesToHex(concatBytes(
    word(0x20), word(BigInt(instance)), word(0xc0), hexBytes(root), hexBytes(nullifierHash), word(BigInt(recipient)), word(fee), word(p.length), padded,
  ));
}

const rlpBytes = (b) => {
  if (b.length === 1 && b[0] < 0x80) return b;
  const len = b.length < 56 ? new Uint8Array([0x80 + b.length]) : (() => { const l = lenBytes(b.length); return concatBytes(new Uint8Array([0xb7 + l.length]), l); })();
  return concatBytes(len, b);
};
const lenBytes = (n) => { const out = []; while (n > 0) { out.unshift(n & 0xff); n = Math.floor(n / 256); } return Uint8Array.from(out); };
const rlpInt = (n) => { let v = BigInt(n); const out = []; while (v > 0n) { out.unshift(Number(v & 0xffn)); v >>= 8n; } return rlpBytes(Uint8Array.from(out)); };
const rlpList = (items) => {
  const body = concatBytes(...items);
  if (body.length < 56) return concatBytes(new Uint8Array([0xc0 + body.length]), body);
  const l = lenBytes(body.length);
  return concatBytes(new Uint8Array([0xf7 + l.length]), l, body);
};

// The hash an EIP-7702 authorization is signed over: keccak256(0x05 || rlp([chainId, address, nonce])).
export const authorizationDigest = (chainId, address, nonce) => k(concatBytes(new Uint8Array([0x05]), rlpList([rlpInt(chainId), rlpBytes(addr20(address)), rlpInt(nonce)])));

export async function signDigest(key, digest) {
  const sig = await secp.signAsync(digest, key);
  return { r: '0x' + sig.r.toString(16).padStart(64, '0'), s: '0x' + sig.s.toString(16).padStart(64, '0'), recovery: sig.recovery };
}

export const addressOf = (key) => '0x' + bytesToHex(k(secp.getPublicKey(key, false).slice(1)).slice(12));

const pack16 = (a, b) => concatBytes(word(a).slice(16), word(b).slice(16));

// The EntryPoint v0.8 hash of an operation (EIP-712, domain ERC4337): what its sender signs.
export function userOpDigest(op, chainId, entryPoint = ENTRY_POINT) {
  const paymasterAndData = concatBytes(addr20(op.paymaster), word(BigInt(op.paymasterVerificationGasLimit)).slice(16), word(BigInt(op.paymasterPostOpGasLimit)).slice(16), hexBytes(op.paymasterData));
  const domain = k(concatBytes(
    k(enc.encode('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), k(enc.encode('ERC4337')), k(enc.encode('1')), word(chainId), word(BigInt(entryPoint)),
  ));
  const struct = k(concatBytes(
    k(enc.encode('PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData)')),
    word(BigInt(op.sender)), word(BigInt(op.nonce)), k(new Uint8Array(0)), k(hexBytes(op.callData)),
    pack16(BigInt(op.verificationGasLimit), BigInt(op.callGasLimit)), word(BigInt(op.preVerificationGas)), pack16(BigInt(op.maxPriorityFeePerGas), BigInt(op.maxFeePerGas)), k(paymasterAndData),
  ));
  return k(concatBytes(new Uint8Array([0x19, 0x01]), domain, struct));
}

// A signed operation for the throwaway sender, in the form a bundler takes. No call: the note pays the recipient.
export async function buildDirectUserOp({ key, chainId, paymaster, paymasterData, gas, maxFeePerGas, maxPriorityFeePerGas }) {
  const sender = addressOf(key);
  const op = {
    sender, nonce: '0x0', callData: '0x',
    callGasLimit: q(gas.callGasLimit), verificationGasLimit: q(gas.verificationGasLimit), preVerificationGas: q(gas.preVerificationGas),
    maxFeePerGas: q(maxFeePerGas), maxPriorityFeePerGas: q(maxPriorityFeePerGas),
    paymaster, paymasterVerificationGasLimit: q(gas.paymasterVerificationGasLimit), paymasterPostOpGasLimit: q(gas.paymasterPostOpGasLimit), paymasterData,
  };
  const auth = await signDigest(key, authorizationDigest(chainId, SIMPLE_7702, 0));
  const sig = await signDigest(key, userOpDigest(op, chainId));
  op.signature = '0x' + sig.r.slice(2) + sig.s.slice(2) + (27 + sig.recovery).toString(16);
  op.eip7702Auth = { address: SIMPLE_7702, chainId: q(chainId), nonce: '0x0', r: auth.r, s: auth.s, yParity: q(auth.recovery) };
  return op;
}

// ---- the bundler -----------------------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);

export function bundlerClient(url, fetchImpl = globalThis.fetch.bind(globalThis)) {
  let id = 1;
  return {
    url,
    async request(method, params) {
      let res;
      try {
        res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) });
      } catch (e) {
        throw Object.assign(new Error(`the bundler could not be reached: ${e.message}`), { kind: 'network' });
      }
      let body = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      if (body?.error) throw Object.assign(new Error(body.error.message || 'the bundler refused the request'), { kind: 'rpc', code: body.error.code, details: body.error.message, data: body.error.data });
      if (!res.ok) throw Object.assign(new Error(`the bundler answered ${res.status}`), { kind: 'http', status: res.status });
      return body?.result;
    },
  };
}

// 'transport-unavailable' or 'bundler-internal' for a failure that says nothing about the operation, undefined for
// one that does (a refusal of it).
export function estimationUnavailableReason(error, op) {
  if (error?.kind === 'network') return 'transport-unavailable';
  if (error?.kind === 'http') return RETRYABLE_STATUS.has(error.status) ? 'transport-unavailable' : undefined;
  if (error?.kind === 'rpc') {
    if (op?.callData === '0x' && BigInt(op.callGasLimit) === 0n) {
      for (const v of [error.details, error.message, error.data]) {
        const m = typeof v === 'string' && /\b0x54107e37([0-9a-f]{64})(?![0-9a-f])/i.exec(v);
        if (m && BigInt('0x' + m[1]) > 0n) return 'bundler-internal';
      }
    }
    const opaque = error.code === -32603 && error.data == null && /^Unknown error, could not parse simulate validation result\.?$/i.test(String(error.details ?? error.message));
    return opaque ? 'bundler-internal' : undefined;
  }
  return undefined;
}

// One retry of a read-only estimate after a transport failure; never for a send.
async function estimateWithRetry(estimate, sleep) {
  try { return await estimate(); } catch (e) {
    if (e?.kind !== 'network' && !(e?.kind === 'http' && RETRYABLE_STATUS.has(e.status))) throw e;
    await sleep(250);
    return estimate();
  }
}

const parseGas = (r) => ({
  callGasLimit: BigInt(r.callGasLimit), verificationGasLimit: BigInt(r.verificationGasLimit), preVerificationGas: BigInt(r.preVerificationGas),
  paymasterVerificationGasLimit: BigInt(r.paymasterVerificationGasLimit ?? 0), paymasterPostOpGasLimit: BigInt(r.paymasterPostOpGasLimit ?? 0),
});

// The operation, ready to send. `prove(fee)` returns the proof's fields for a withdrawal that names `relayer`
// (the paymaster) and takes `fee`: { proof, root, nullifierHash } already checked against what was asked.
// Gas limits and the fee in the proof depend on each other, so a change in the limits makes a new proof.
export async function prepareSponsoredWithdrawal({
  chainId, pool, denomination, recipient, prove, bundler, reference, key = secp.utils.randomPrivateKey(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onStep = () => {},
}) {
  const cfg = paymasterFor(chainId, pool);
  const prices = await bundler.request('pimlico_getUserOperationGasPrice', []);
  const standard = prices?.standard;
  if (!standard) throw new Error('The bundler gave no gas price.');
  const price = { maxFeePerGas: BigInt(standard.maxFeePerGas), maxPriorityFeePerGas: BigInt(standard.maxPriorityFeePerGas) };
  assertGasPriceWithinBounds(price, reference);

  const build = async (gas) => {
    const fee = minimumViableFee(gas, price.maxFeePerGas);
    if (fee >= denomination) throw new Error('The paymaster fee would use up the whole note. Wait for lower gas prices.');
    if (fee * 10n > denomination) throw new Error('Gas is unusually high for a note this size: the fee would be over a tenth of it. Try later.');
    onStep({ step: 'prove', fee });
    const out = await prove(fee);
    const paymasterData = encodePaymasterData({ instance: pool, proof: out.proof, root: out.root, nullifierHash: out.nullifierHash, recipient, fee });
    const op = await buildDirectUserOp({ key, chainId, paymaster: cfg.paymaster, paymasterData, gas, ...price });
    return { op, fee };
  };

  let gas = { ...BASELINE };
  for (let attempt = 0; attempt < 3; attempt++) {
    assertGasLimitsWithinBounds(gas, BASELINE);
    const built = await build(gas);
    assertGasLimitsWithinBounds(gas, BASELINE, built.op);
    onStep({ step: 'estimate' });
    let estimated;
    try {
      estimated = parseGas(await estimateWithRetry(() => bundler.request('eth_estimateUserOperationGas', [built.op, ENTRY_POINT]), sleep));
    } catch (e) {
      const reason = estimationUnavailableReason(e, built.op);
      if (!reason) throw new Error(`The bundler would not take the withdrawal: ${e.details || e.message}. Nothing was sent.`);
      // rebuild at the fallback limits, with the fee and proof that go with them
      const fb = fallbackGas(gas, built.op);
      assertGasLimitsWithinBounds(fb, BASELINE, built.op);
      const again = await build(fb);
      assertGasLimitsWithinBounds(fb, BASELINE, again.op);
      if (fallbackGas(fb, again.op).preVerificationGas > fb.preVerificationGas) throw new Error('The payload changed size while it was prepared.');
      return { ...again, gasEstimation: { status: 'fallback', reason, message: e.details || e.message }, price, sender: again.op.sender };
    }
    if (estimated.preVerificationGas <= 0n || estimated.verificationGasLimit <= 0n || GAS_FIELDS.some((f) => estimated[f] < 0n)) throw new Error('The bundler returned invalid gas estimates.');
    const next = { ...gas };
    let changed = false;
    for (const f of GAS_FIELDS) {
      if (f === 'callGasLimit') continue; // a direct note's call stays empty
      const buffered = (estimated[f] * 12n + 9n) / 10n;
      if (buffered > next[f]) { next[f] = buffered; changed = true; }
    }
    if (!changed) return { ...built, gasEstimation: { status: 'estimated' }, price, sender: built.op.sender };
    assertGasLimitsWithinBounds(next, BASELINE, built.op);
    gas = next;
  }
  throw new Error('The bundler\'s gas estimates did not settle after 3 tries. Nothing was sent; try later.');
}

// Sends the operation and waits for it to be mined. A lost reply to the send does not mean it was refused: the
// bundler is asked for the operation before it is called refused.
export async function sendSponsoredOperation({ op, chainId, bundler, poll = 2000, timeout = 5 * 60 * 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onStep = () => {} }) {
  const hash = '0x' + bytesToHex(userOpDigest(op, chainId));
  try {
    await bundler.request('eth_sendUserOperation', [op, ENTRY_POINT]);
  } catch (e) {
    const known = /already known/i.test(e?.details ?? '') || (await bundler.request('eth_getUserOperationByHash', [hash]).then((r) => r !== null, () => false));
    if (!known) {
      if (e?.kind === 'rpc') throw new Error(`The bundler did not accept the withdrawal: ${e.details || e.message}. Nothing was sent.`);
      throw new Error(`Could not tell whether the bundler took the withdrawal (${e.message}). It may still go through; check the pool before trying again.`);
    }
  }
  onStep({ step: 'wait', hash });
  const end = Date.now() + timeout;
  for (;;) {
    const r = await bundler.request('eth_getUserOperationReceipt', [hash]).catch(() => null);
    if (r) {
      if (!r.success) throw new Error(`The withdrawal failed on chain${r.reason ? `: ${r.reason}` : ''} (${r.receipt?.transactionHash}).`);
      return { hash, txHash: r.receipt?.transactionHash };
    }
    if (Date.now() > end) throw new Error(`Not confirmed yet. The withdrawal may still go through (operation ${hash}); check the pool before trying again.`);
    await sleep(poll);
  }
}
