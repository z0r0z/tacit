// The L1 data fee an OP-stack chain (Base, Fraxtal …) charges on top of L2 gas.
//
// A send there costs gas × price on the L2 and, separately, a fee for posting its bytes to Ethereum, paid out of the signer's balance
// and not counted in gas. The keeper prices every send as gas × price, so on a chain where the second part is the larger one (Fraxtal's
// is about 1e-4 ETH for a proof-sized call, against 1e-9 for the gas) it quotes and accepts fees that do not pay for the send, and a
// receive-box sweep, whose fee is capped at 25 bps of the box, loses the difference every time.
//
// This module turns a call into the fee the chain's gas price oracle (OP's GasPriceOracle predeploy: getL1Fee(bytes), the signed
// transaction's bytes) gives for it. The oracle is told the call's own calldata when the caller has it, and a typical call of the same
// function when it has not (a quote, sized on two 65-byte memos and bytes that do not compress, so it runs a little over a withdrawal);
// either way with a stand-in for the transaction's envelope. Against the oracle's answer for the real signed bytes of the keeper's own
// sends on Fraxtal the exact estimate was within 2.5% (under); the L1 base fee itself follows Ethereum's and moved a third in an hour on
// 22 November, which is why the keeper reads it again for every send and keeps its margin on the whole cost. Off by default: a chain
// with no such fee, or one that already counts it in its gas (Arbitrum's estimate does), quotes as before.

import { encodeFunctionData, getAddress, keccak256, parseAbi, toBytes, toHex } from 'viem';

// The GasPriceOracle predeploy, at the same address on every OP-stack chain.
export const OP_GAS_PRICE_ORACLE = getAddress('0x420000000000000000000000000000000000000f');
export const L1_ORACLE_ABI = parseAbi(['function getL1Fee(bytes data) view returns (uint256)']);

// What a signed EIP-1559 transaction carries besides its calldata: type, chain id, nonce, two fees, gas, `to`, value, the access list
// and the 65-byte signature, in RLP. Measured on the keeper's own sends on Fraxtal: 1076 signed bytes for 964 of calldata.
export const TX_ENVELOPE_BYTES = 112;
// A memo as the wallet sends it (a sealed note: 65 bytes). A call with two memos is a payment, with one a withdrawal.
const MEMO_BYTES = 65;

// Bytes that do not compress and have no zero byte, which is what a proof and a hash look like to the oracle: a run of one byte, or
// zeros, would be priced as nearly free by its compression estimate and the keeper would undercount. Deterministic, so a test and a
// second keeper agree.
export function filler(length, seed = 'tacit-l1-fee') {
  const out = new Uint8Array(length);
  for (let i = 0, block = 0; i < length; block++) {
    const h = toBytes(keccak256(toHex(`${seed}:${block}`)));
    for (let j = 0; j < h.length && i < length; j++, i++) out[i] = h[j] || 1;
  }
  return out;
}

// A value of an ABI type that fills its bytes (nothing zero), for the typical calldata of a function whose arguments the caller does not
// have yet. `next()` draws the filler so no two values repeat.
function sample(param, next) {
  const { type } = param;
  const array = /^(.*)\[(\d*)\]$/.exec(type);
  if (array) {
    const inner = { ...param, type: array[1] };
    const n = array[2] === '' ? 1 : Number(array[2]);
    return Array.from({ length: n }, () => sample(inner, next));
  }
  if (type === 'tuple') return Object.fromEntries(param.components.map((c) => [c.name, sample(c, next)]));
  if (type === 'address') return toHex(next(20));
  if (type === 'bool') return true;
  if (type === 'bytes') return toHex(next(MEMO_BYTES));
  const fixed = /^bytes(\d+)$/.exec(type);
  if (fixed) return toHex(next(Number(fixed[1])));
  const int = /^(u?)int(\d*)$/.exec(type);
  if (int) {
    const bits = int[2] === '' ? 256 : Number(int[2]);
    const signed = int[1] === '';
    const v = BigInt(toHex(next(Math.ceil(bits / 8)))) & ((1n << BigInt(signed ? bits - 1 : bits)) - 1n);
    return v === 0n ? 1n : v;
  }
  throw new Error(`no sample for the ABI type ${type}`);
}

// The calldata of one typical call of `functionName`: what a quote is sized on.
export function typicalCalldata({ abi, functionName }) {
  const item = abi.find((x) => x.type === 'function' && x.name === functionName);
  if (!item) throw new Error(`no function ${functionName} in the ABI`);
  let seed = 0;
  const next = (n) => filler(n, `sample:${functionName}:${seed++}`);
  return encodeFunctionData({ abi, functionName, args: item.inputs.map((p) => sample(p, next)) });
}

// `target(functionName)` gives { address, abi, functionName } (the chain wrapper's own); `readFee(rawTx)` asks the oracle and returns
// a bigint. With `args` the fee is for exactly that call; without, for a typical one, kept `ttlMs` (a quote is asked for often and the
// L1 price moves slowly). A read that fails serves the last answer for up to an hour, and with none to serve it throws: a keeper that
// cannot tell what a send costs refuses it, which is safe, and does not guess zero, which is the bug this module exists to remove.
export function makeL1Fee({ target, readFee, ttlMs = 10_000, staleMs = 3_600_000, now = Date.now }) {
  const envelope = toHex(filler(TX_ENVELOPE_BYTES, 'envelope'));
  const typical = new Map();   // functionName → { at, wei }
  const calldataOf = (functionName, args) => {
    const t = target(functionName);
    return args === undefined ? typicalCalldata(t) : encodeFunctionData({ abi: t.abi, functionName: t.functionName, args });
  };
  const rawOf = (data) => envelope + data.slice(2);

  return async function l1Fee(functionName, args) {
    const t = now();
    const last = typical.get(functionName);
    if (args === undefined && last && t - last.at < ttlMs) return last.wei;
    let wei;
    try { wei = BigInt(await readFee(rawOf(calldataOf(functionName, args)))); }
    catch (e) {
      // the typical answer stands in for an exact one: the same function, and what the fee is made of is the byte count
      if (last && t - last.at < staleMs) return last.wei;
      throw new Error(`the L1 data fee of ${functionName} could not be read: ${e?.shortMessage || e?.message || e}`);
    }
    if (args === undefined) typical.set(functionName, { at: t, wei });
    return wei;
  };
}
