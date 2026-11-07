// A JSON-RPC client with retries, and the transaction sender the leader uses (EIP-1559, signed in-process).
import { secp, keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { makeEvmTx } from '../dapp/evm-tx.js';
import { hexOf, bytesOf } from './abi.mjs';

export function makeRpc(url, { retries = 4 } = {}) {
  let id = 0;
  async function call(method, params = []) {
    let last;
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
        const j = await r.json();
        if (j.error) { const e = new Error(`${method}: ${j.error.message}`); e.rpc = j.error; if (j.error.code !== -32005 && j.error.code !== 429) throw e; last = e; } else return j.result;
      } catch (e) { if (e.rpc && ![-32005, 429].includes(e.rpc.code)) throw e; last = e; }
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
    throw last;
  }
  return { call };
}

export const num = (h) => Number(BigInt(h));
const evmTx = makeEvmTx({ secp, keccak256: keccak_256 });

/// The address of a private key.
export function addressOf(priv) {
  const pub = secp.getPublicKey(bytesOf(priv).length === 32 ? bytesOf(priv) : bytesOf(priv), false).slice(1);
  return hexOf(keccak_256(pub).slice(12));
}

/// Signs and sends a call to `to` with `data` from `priv`, waits for its receipt: → the receipt.
export async function send(rpc, priv, to, data, { chainId, gasPad = 1.25, tip = 1_000_000_000n, wait = true } = {}) {
  const from = addressOf(priv);
  const [nonce, block, est] = await Promise.all([
    rpc.call('eth_getTransactionCount', [from, 'pending']),
    rpc.call('eth_getBlockByNumber', ['latest', false]),
    rpc.call('eth_estimateGas', [{ from, to, data: hexOf(data) }]),
  ]);
  const base = BigInt(block.baseFeePerGas || 0);
  const maxFee = base * 2n + tip;
  const { raw, hash } = evmTx.signEip1559({ chainId, nonce: BigInt(nonce), maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gasLimit: BigInt(Math.ceil(num(est) * gasPad)), to, value: 0n, data: hexOf(data) }, hexOf(bytesOf(priv)).slice(2));
  const txHash = await rpc.call('eth_sendRawTransaction', [raw]);
  if (!wait) return { hash: txHash };
  for (let i = 0; i < 180; i++) {
    const r = await rpc.call('eth_getTransactionReceipt', [txHash]);
    if (r) { if (r.status !== '0x1') throw new Error(`tx ${txHash} reverted`); return r; }
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  throw new Error(`tx ${txHash} not mined in time`);
}
