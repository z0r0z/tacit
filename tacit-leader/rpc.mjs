// A JSON-RPC client with retries, and the transaction sender the leader uses (EIP-1559, signed in-process).
import { secp, keccak_256, hmac, sha256, concatBytes } from '../dapp/vendor/tacit-deps.min.js';
import { makeEvmTx } from '../dapp/evm-tx.js';
import { hexOf, bytesOf } from './abi.mjs';

// One endpoint, or several (a list: the first that answers is used until it fails, then the next): a free endpoint can rate-limit, drop old logs
// or go down, and the leader must not stop with it. What is the call's own answer (a revert, a nonce, a fee) is thrown as it is, not tried elsewhere.
const OWN = /execution reverted|nonce too low|already known|replacement transaction|insufficient funds|intrinsic gas|max fee per gas|invalid argument|invalid params/i;
// An endpoint named by its domain alone: its path and query are where a key lives, and never go to a log.
const hostOf = (u) => { try { return new URL(u).hostname.split('.').slice(-2).join('.'); } catch { return 'endpoint'; } };
export function makeRpc(urls, { retries = 2, fetchImpl = (...a) => fetch(...a) } = {}) {
  const list = (Array.isArray(urls) ? urls : String(urls).split(',')).map((u) => u.trim()).filter(Boolean);
  if (!list.length) throw new Error('an RPC endpoint is required');
  let id = 0, at = 0;
  async function one(url, method, params) {
    let last;
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(45_000) });
        // a gateway or rate limiter in front of a node can answer with a web page: said as that, with the status, not as a parse error
        const j = await r.json().catch(() => { throw new Error(`answered ${method} with a web page, not JSON (HTTP ${r.status ?? '?'})`); });
        if (j.error) {
          const e = new Error(`${method}: ${j.error.message}`); e.rpc = j.error;
          if (j.error.code === 3 || OWN.test(j.error.message || '')) { e.own = true; throw e; }
          if (![-32005, 429].includes(j.error.code)) throw e;             // (not busy: another endpoint may know better; this one is not asked again)
          last = e;
        } else return j.result;
      } catch (e) { if (e.own || (e.rpc && ![-32005, 429].includes(e.rpc.code))) throw e; last = e; }
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
    throw last;
  }
  async function call(method, params = []) {
    let last;
    const tried = [];
    for (let k = 0; k < list.length; k++) {
      const i = (at + k) % list.length;
      try { const r = await one(list[i], method, params); at = i; return r; }
      catch (e) { if (e.own) throw e; last = e; tried.push(`${hostOf(list[i])}: ${String((e && e.message) || e).slice(0, 100)}`); }
    }
    // the last endpoint's own error is what is thrown; what each one said goes with it, for a log to name them
    if (last && typeof last === 'object') last.attempts = tried;
    throw last;
  }
  return { call, urls: list };
}

export const num = (h) => Number(BigInt(h));
// the secp library signs synchronously only once it is given an HMAC (RFC 6979 nonces)
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, concatBytes(...m));
const evmTx = makeEvmTx({ secp, keccak256: keccak_256 });

/// The address of a private key.
export function addressOf(priv) {
  const pub = secp.getPublicKey(bytesOf(priv).length === 32 ? bytesOf(priv) : bytesOf(priv), false).slice(1);
  return hexOf(keccak_256(pub).slice(12));
}

/// Signs and sends a call to `to` with `data` from `priv`, waits for its receipt: → the receipt.
/// The priority fee to offer: the node's suggestion (eth_maxPriorityFeePerGas), kept within [0.01, 2] gwei, 0.1 gwei if it has none.
export async function suggestedTip(rpc) {
  const t = await rpc.call('eth_maxPriorityFeePerGas').then((x) => BigInt(x), () => 100_000_000n);
  return t < 10_000_000n ? 10_000_000n : t > 2_000_000_000n ? 2_000_000_000n : t;
}

export async function send(rpc, priv, to, data, { chainId, gasPad = 1.25, tip = null, wait = true } = {}) {
  const from = addressOf(priv);
  const [nonce, block, est, suggested] = await Promise.all([
    rpc.call('eth_getTransactionCount', [from, 'pending']),
    rpc.call('eth_getBlockByNumber', ['latest', false]),
    rpc.call('eth_estimateGas', [{ from, to, data: hexOf(data) }]),
    tip == null ? suggestedTip(rpc) : null,
  ]);
  tip ??= suggested;
  const base = BigInt(block.baseFeePerGas || 0);
  const maxFee = base * 2n + tip;
  const { raw, hash } = evmTx.signEip1559({ chainId, nonce: BigInt(nonce), maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gasLimit: BigInt(Math.ceil(num(est) * gasPad)), to, value: 0n, data: hexOf(data) }, hexOf(bytesOf(priv)).slice(2));
  const txHash = await rpc.call('eth_sendRawTransaction', [raw]);
  if (!wait) return { hash: txHash };
  // looked for each second: a block lands (and its payouts follow) as soon as Ethereum includes it
  for (let i = 0; i < 360; i++) {
    const r = await rpc.call('eth_getTransactionReceipt', [txHash]);
    if (r) { if (r.status !== '0x1') throw new Error(`tx ${txHash} reverted`); return r; }
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  throw new Error(`tx ${txHash} not mined in time`);
}
