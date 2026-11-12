// Catch the price feed up from anyone's wallet: the same records the keeper sends (vault/feed.js builds them from an
// archive node and the oracle checks them again), in batches through Multicall3. The sale reads its pair oracle like a
// vault does (`ORACLE()`), so the vault page's feed reader works on the sale's address as it is.
import { makeFeed, encBatch, MULTICALL3 } from '/vault/feed.js?cb=6d915237';
import { ETH_ARCHIVE_NODES } from '/eth-nodes.js';

const PER_BATCH = 8; // about 7.6M gas a batch

async function post(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20e3) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'node error');
  return j.result;
}
// Old headers and proofs: each archive node in turn (from `skip`), the first answer that passes `check`.
async function archive(method, params, { check, skip = 0 } = {}) {
  let last;
  for (let i = 0; i < ETH_ARCHIVE_NODES.length; i++) {
    const url = ETH_ARCHIVE_NODES[(i + skip) % ETH_ARCHIVE_NODES.length];
    try {
      const res = await post(url, method, params);
      if (check && !check(res)) { last = new Error('incomplete answer'); continue; }
      return res;
    } catch (e) { last = e; }
  }
  throw last || new Error('no archive node answered');
}

/** `rpc` the page's reader, `wallet` the connected wallet (sendTx, receipt), `say(text)` for progress. */
export function makeCatchUp({ rpc, sale, wallet, account, say }) {
  const feed = makeFeed({ rpc, proofRpc: archive, headerRpc: archive });
  const missing = async () => (await feed.read(sale)).missing;
  async function run() {
    for (let round = 1; ; round++) {
      const st = await feed.read(sale);
      const list = feed.nextBatch(st, PER_BATCH);
      if (!list.length) { say('Prices are up to date.'); return; }
      say(`Building batch ${round} (${st.missing} to record)…`);
      const recs = await feed.build(list);
      const data = encBatch(recs.map((r) => ({ to: r.to, data: r.data })));
      await rpc('eth_call', [{ from: account(), to: MULTICALL3, data }, 'latest']); // a record that would fail stops here, before the wallet
      say(`Confirm batch ${round} in your wallet. No popup? Reconnect your wallet.`);
      const hash = await wallet.sendTx({ to: MULTICALL3, data });
      say(`Batch ${round} sent. Waiting for it to land…`);
      const rc = await wallet.receipt(hash);
      if (rc.status !== '0x1') throw new Error('A batch did not go through. Nothing more was sent.');
    }
  }
  return { missing, run };
}
