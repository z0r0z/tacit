// Dapp-side orchestration for the confidential-pool UX (Sepolia pilot v1, 2026-06-14). Wires the
// already-built primitives into one tab-facing API so tacit.js stays a thin renderer over the LIVE pool:
//   - evm-account        → the persistent Sepolia EVM identity derived from the Tacit wallet scalar
//   - confidential-evm-log + confidential-indexer → seed-only confidential balance from the pool's logs
//   - confidential-relay → the settle queue (transfer/swap/lp/otc/bid) on api.tacit.finance
// The wrap (on-chain deposit) + transfer/unwrap BUILD paths layer the op assemblers + evm-tx on top of
// this; this module owns the read path (account + balance) + the live config + the settle/RPC handles.

import { makeEvmAccount } from './evm-account.js';
import { makeConfidentialIndexer } from './confidential-indexer.js';
import { makeConfidentialEvmLog } from './confidential-evm-log.js';
import { makeConfidentialRelay } from './confidential-relay.js';

// Live deployments — keyed by the dapp's EVM-chain label. Sepolia pilot v1 mirrors the on-chain core
// (the pool from the 2026-06-14 deploy) + cETH (assetId is deterministic, identical across pool versions).
export const CONFIDENTIAL_POOL_UX = {
  sepolia: {
    chainId: 11155111,
    pool: '0x32e46B097830D93d50b0CBC89c018bCFD79b7B5a',
    deployBlock: 11052948,
    rpcs: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://1rpc.io/sepolia',
      'https://sepolia.drpc.org',
      'https://sepolia.gateway.tenderly.co',
    ],
    relayBase: 'https://api.tacit.finance',
    evmNetwork: 'mainnet', // domain-separation tag for deriveEvmAccount (the persistent EVM identity)
    assets: [
      {
        ticker: 'cETH',
        assetId: '0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2',
        underlying: '0x0000000000000000000000000000000000000000', // native ETH (escrow-backed wrap)
        unitScale: '1',
        decimals: 18,
        native: true,
      },
    ],
  },
};

export function makeConfidentialPoolUx({ secp, keccak256, sha256, fetchImpl, network = 'sepolia' } = {}) {
  const cfg = CONFIDENTIAL_POOL_UX[network];
  if (!cfg || !cfg.pool) throw new Error(`confidential pool not deployed on "${network}"`);
  const _fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);

  const evm = makeEvmAccount({ secp, keccak256, sha256 });
  const indexer = makeConfidentialIndexer({ secp, keccak256, sha256 });
  const evmLog = makeConfidentialEvmLog({ keccak256 });
  const relay = makeConfidentialRelay({ base: cfg.relayBase, fetchImpl: _fetch });

  const assetByTicker = Object.fromEntries(cfg.assets.map((a) => [a.ticker, a]));

  // The user's persistent Sepolia EVM account (domain-separated derivation from the Tacit wallet scalar —
  // unlinkable from the Bitcoin address). Used to sign wrap deposits + own confidential notes.
  function account(walletPriv) { return evm.deriveEvmAccount(walletPriv, cfg.evmNetwork); }

  // Minimal JSON-RPC over the pool's RPC fallback list. Throws only if every endpoint fails.
  async function rpc(method, params) {
    if (!_fetch) throw new Error('no fetch implementation');
    let lastErr;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    for (const url of cfg.rpcs) {
      try {
        const r = await _fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        if (!r.ok) { lastErr = new Error(`rpc ${r.status}`); continue; }
        const j = await r.json();
        if (j && j.error) { lastErr = new Error(j.error.message || 'rpc error'); continue; }
        return j ? j.result : undefined;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('all RPCs failed');
  }

  function ethCall(to, data) { return rpc('eth_call', [{ to: String(to).toLowerCase(), data }, 'latest']); }

  // Fetch + decode the pool's confidential event stream (LeavesInserted + NullifiersSpent) in chain order
  // from the pool's deploy block — exactly the stream the indexer folds into notes + the spent set.
  async function fetchEvents({ fromBlock = cfg.deployBlock, toBlock = 'latest' } = {}) {
    const fb = typeof fromBlock === 'number' ? '0x' + fromBlock.toString(16) : fromBlock;
    const logs = await rpc('eth_getLogs', [{
      address: cfg.pool,
      fromBlock: fb,
      toBlock,
      topics: [[evmLog.TOPIC0.LeavesInserted, evmLog.TOPIC0.NullifiersSpent]],
    }]);
    return evmLog.decodeLogs(logs || []);
  }

  // Seed-only confidential balance: recover the wallet's unspent notes from chain + scan key, grouped by
  // asset. No off-chain note storage — a wiped wallet recovers its whole confidential balance from here.
  async function balance(scanPriv, opts) {
    const events = await fetchEvents(opts);
    const notes = indexer.recover(events, scanPriv);
    const byAsset = {};
    for (const n of notes) {
      const id = String(n.asset || '').toLowerCase();
      (byAsset[id] ||= { asset: id, ticker: tickerOf(id), value: 0n, notes: [] });
      byAsset[id].value += BigInt(n.value);
      byAsset[id].notes.push(n);
    }
    return { notes, byAsset };
  }

  function tickerOf(assetIdHex) {
    const id = String(assetIdHex || '').toLowerCase();
    const a = cfg.assets.find((x) => x.assetId.toLowerCase() === id);
    return a ? a.ticker : null;
  }

  return { cfg, assetByTicker, account, rpc, ethCall, fetchEvents, balance, tickerOf, relay, indexer, evmLog };
}
