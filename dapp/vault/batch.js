// Putting the vault's call and the price records it waits for into one confirmation. A vault acts for whoever calls it, so its deposit and borrow cannot go through a shared
// batcher such as Multicall3 (the vault would see Multicall3). A wallet that is itself a smart account (EIP-5792, `wallet_sendCalls`) sends them from the account, in one
// transaction, so the records and the person's action land together or not at all. The page asks the wallet whether it can; a wallet that cannot, or does not say, is left
// to the two steps the page has always had.
import { _internal, MULTICALL3 } from '/evm-trade-venues.js?cb=10858cc2';
export { MULTICALL3 };

const strip = (h) => String(h).replace(/^0x/, '');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad32 = (h) => h.padEnd(Math.ceil(h.length / 64) * 64, '0');
const encBytes = (hex) => { const h = strip(hex); return word(h.length / 2) + pad32(h); };

// BatchRun (tools/BatchRun.sol, solc 0.8.37, optimizer 200 runs): run(address[] to, bytes[] data) calls each from its own address and reverts with the first failure.
// The page lends this code to the account's address for an eth_call, so that the batch is tested exactly as the wallet will run it: every call comes from the account.
export const BATCH_RUN = '0x608060405234801561000f575f5ffd5b5060043610610029575f3560e01c80634d618e3b1461002d575b5f5ffd5b61004061003b366004610159565b610042565b005b5f5b8381101561010a575f5f868684818110610060576100606101c5565b905060200201602081019061007591906101d9565b6001600160a01b0316858585818110610090576100906101c5565b90506020028101906100a29190610206565b6040516100b0929190610249565b5f604051808303815f865af19150503d805f81146100e9576040519150601f19603f3d011682016040523d82523d5f602084013e6100ee565b606091505b50915091508161010057805160208201fd5b5050600101610044565b5050505050565b5f5f83601f840112610121575f5ffd5b50813567ffffffffffffffff811115610138575f5ffd5b6020830191508360208260051b8501011115610152575f5ffd5b9250929050565b5f5f5f5f6040858703121561016c575f5ffd5b843567ffffffffffffffff811115610182575f5ffd5b61018e87828801610111565b909550935050602085013567ffffffffffffffff8111156101ad575f5ffd5b6101b987828801610111565b95989497509550505050565b634e487b7160e01b5f52603260045260245ffd5b5f602082840312156101e9575f5ffd5b81356001600160a01b03811681146101ff575f5ffd5b9392505050565b5f5f8335601e1984360301811261021b575f5ffd5b83018035915067ffffffffffffffff821115610235575f5ffd5b602001915036819003821315610152575f5ffd5b818382375f910190815291905056fea26469706673582212201243d7f5ed0b47ef813a8331220682dd7ab64b043fcf880e4d739d8c55b17fef64736f6c63430008250033';
const RUN = '0x4d618e3b';
export function encRun(calls) {
  const n = calls.length;
  const to = word(n) + calls.map((c) => word(BigInt(c.to))).join('');
  let head = '', tail = '', off = n * 32;
  for (const c of calls) { const t = encBytes(c.data); head += word(off); tail += t; off += t.length / 2; }
  return RUN + word(64) + word(64 + to.length / 2) + to + word(n) + head + tail;
}

// Multicall3.aggregate3 with each call's own allowFailure: the records must all succeed, the views after them may fail (a view with no price to give).
export function encMixed(calls) {
  const n = calls.length;
  let head = '', tail = '', off = n * 32;
  for (const c of calls) {
    const d = strip(c.data), body = word(BigInt(c.to)) + word(c.allowFailure === false ? 0 : 1) + word(96) + word(d.length / 2) + pad32(d);
    head += word(off); tail += body; off += body.length / 2;
  }
  return `0x82ad56cb${word(32)}${word(n)}${head}${tail}`;
}
// Runs the calls in order against the chain now and returns each one's result (null for one that was allowed to fail and did): the state one call leaves is what the next reads.
export const readMixed = async (ethCall, calls) => (calls.length ? _internal.decAggregate3(await ethCall(MULTICALL3, encMixed(calls)), calls.length) : []);

// Whether the wallet can send several calls from the account as one transaction. Only an account that already can (status "supported") counts: one a wallet would first
// have to convert to a smart account ("ready") is not asked to, here. A phone wallet over WalletConnect is left out, as it has to be told in advance what it may be asked.
export async function batchSupport(prov, account) {
  if (!prov?.request || prov.isWalletConnect || !account) return false;
  try {
    const caps = await Promise.race([prov.request({ method: 'wallet_getCapabilities', params: [account, ['0x1']] }), sleep(4000).then(() => null)]);
    const c = caps?.['0x1'] || caps?.[1];
    return c?.atomic?.status === 'supported' || c?.atomicBatch?.supported === true;
  } catch { return false; }
}

// The calls tested as the account: { ok: true }, { ok: false, e }, or { ok: null } when the node cannot lend code to an address for a call (then only the wallet's own check is left).
export async function simulateBundle(rpc, account, calls) {
  try {
    await rpc('eth_call', [{ from: '0x000000000000000000000000000000000000dEaD', to: account, data: encRun(calls) }, 'latest', { [account]: { code: BATCH_RUN } }]);
    return { ok: true };
  } catch (e) {
    const m = String(e?.message || e);
    if (/state override|override|invalid argument|not supported|method not found|unknown field|too many arguments/i.test(m) && !/revert|execution/i.test(m)) return { ok: null, e };
    return { ok: false, e };
  }
}

// Sends the calls from the account as one atomic batch and waits for the wallet to report it: the hash of the transaction that carried them.
export async function sendBundle(prov, from, calls, { every = 2000, timeoutMs = 5 * 60e3 } = {}) {
  const r = await prov.request({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', from, chainId: '0x1', atomicRequired: true, calls: calls.map((c) => ({ to: c.to, data: c.data, value: '0x0' })) }] });
  const id = typeof r === 'string' ? r : r?.id;
  if (!id) throw new Error('The wallet did not take the batch. Nothing was sent.');
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(every)) {
    const s = await prov.request({ method: 'wallet_getCallsStatus', params: [id] });
    const st = typeof s?.status === 'string' ? s.status.toUpperCase() : s?.status;
    if (st === 200 || st === 'CONFIRMED') {
      const rc = (s.receipts || []).at(-1);
      if (!rc?.transactionHash) throw new Error('The wallet confirmed the batch without saying which transaction it was. Check your wallet before trying again.');
      if (!(rc.status === '0x1' || rc.status === 1 || rc.status === '1')) throw new Error(`The batch failed (${rc.transactionHash.slice(0, 10)}…). Nothing was lost but its network fee.`);
      return rc.transactionHash;
    }
    if (st != null && st !== 100 && st !== 'PENDING') throw new Error('The wallet reports that the batch did not go through. Nothing was lost but its network fee, if that.');
  }
  throw new Error('Sent, not confirmed yet. Check your wallet before sending anything again.');
}
