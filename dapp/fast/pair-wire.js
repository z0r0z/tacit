// Bitcoin for ETH and ETH for Bitcoin for a page that holds a Tacit key: the Bitcoin and pool sides built from the key, the providers there are to swap with, the market
// price read through the pool's RPC, and the pair client (dapp/fastbridge-pair.js) over them. No DOM. The swap tile's lane (swap/atomic.js) opens this.
//
//   const { pair, address, run, lists, keep } = await openPair({ T, ux, priv, pubHex, wallet, ask })
//   pair.quote({ dir, amount })  pair.start(q)  pair.pump()  pair.records()  pair.recover()  pair.balances()  pair.reference()  pair.providers()
//
//   T  tacit.js with the key's wallet open (its Bitcoin address must be the one the key makes)     ux  the pool module (trade/poolux.js)     priv  the key's private bytes
//   wallet()  the page's EIP-1193 provider (a settle the relay holds is then sent from it), or null     ask(on)  told while that wallet is being asked
//
// Imports carry cache tokens the way fast/wire.js's do (build/build.mjs writes them: this file is in FAST_CB_FILES), and the same token for the same file, so a module the front
// page already has loaded is the same instance here.

import { makeBtcWallet } from '/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit } from '/adaptor-btc-tx.js';
import { makeEsploraBtcChain } from '/fastbridge-btc.js?cb=f83053ce';
import { makeFastBridgeEvm, makeTxTracer, makeOwnLockFinder, TRACE_NODES } from '/fastbridge-evm.js?cb=381416cc';
import { makeHttpCall } from '/fastbridge-reverse-client.js?cb=2913bc2e';
import { makeMailboxCall } from '/fastbridge-mailbox.js?cb=9003c49b';
import { makeBoardClient } from '/fastbridge-board-client.js?cb=129356b4';
import { makeLocalStore } from '/fastbridge-client.js?cb=09156465';
import { makePairClient, ETH_ASSET, SATS_ASSET } from '/fastbridge-pair.js?cb=b2f4cb9a';
import { makeRateFeed, chainlinkEthBtc } from '/fastbridge-rate.js?cb=0385e0ce';
import { discoverProviders } from '/fast/discover.js?cb=cf4a0fcc';
import { keptStorage, saveCopy, loadCopy } from '/fast/pair-keep.js?cb=4d1d7c96';
import { walletSettle, counterFor, EXPLORERS } from '/fast/wire.js?cb=7769c408';
import { secp, sha256, keccak_256, hmac } from '/vendor/tacit-deps.min.js';

const enc = new TextEncoder();
const hmacSha256 = (k, m) => hmac(sha256, k, m);

// The providers and boards the fast page names (/fast/lp.json); none when the file cannot be read, which leaves no provider to ask
export async function loadLists(fetchImpl = (...a) => fetch(...a)) {
  try {
    const r = await fetchImpl('/fast/lp.json', { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
    const j = r.ok ? await r.json() : null;
    return { providers: Array.isArray(j && j.providers) ? j.providers : [], boards: Array.isArray(j && j.boards) ? j.boards : [] };
  } catch { return { providers: [], boards: [] }; }
}

export async function openPair({ T, ux, priv, pubHex, wallet = null, ask, fetchImpl = (...a) => fetch(...a), bases = EXPLORERS, hrp = 'bc', now, lists = null, storage = globalThis.localStorage, discover: discoverO = null, feed: feedO = null, log = () => {} }) {
  const { prims } = makeBtcWallet({ priv, hrp, fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
  // the lock spends the wallet's own coins: tacit.js and this must name the same address
  if (T && prims.wallet.address() !== T.wallet.address()) throw new Error('The Bitcoin address of this key is not the one the wallet reads. Nothing was done.');
  const builder = makeAdaptorBtcTx({ prims, kit: T ? tacitKit(T) : undefined });
  // the lock goes out for the next block or two and not under 2 sat/vB (see fastbridge-btc.js minFeeRate)
  const btc = makeEsploraBtcChain({ bases, prims, builder, fetchImpl, feeTarget: '1', minFeeRate: 2 });
  const seed = hmac(sha256, priv, enc.encode('tacit-fastbridge-user-pair-seed'));
  const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256, walletPriv: priv, seed, asset: ETH_ASSET, poolAddress: ux.cfg.pool, selfSettle: wallet ? walletSettle({ ux, wallet, ask }) : null, log, trace: makeTxTracer({ fetchImpl, nodes: TRACE_NODES.filter((u) => !/tatum/.test(u)) }) });   // (the nodes the page's CSP reaches)
  // an ETH-for-Bitcoin swap is found again from the key by its pool lock's memo (pair.recover)
  evm.findOwnLocks = makeOwnLockFinder({ ux, hmacSha256, walletPriv: priv });

  const list = lists || (await loadLists(fetchImpl));
  const clock = () => (now ? now() : Math.floor(Date.now() / 1000));
  let found = { at: -Infinity, list: [] };
  const discover = discoverO || (async () => { if (clock() - found.at > 60) found = { at: clock(), list: await discoverProviders({ ...list, fetchImpl, assets: { btcAsset: SATS_ASSET, evmAsset: ETH_ASSET }, ...(now ? { now } : {}) }) }; return found.list; });
  // the page's own reading of the market: Chainlink's ETH / BTC aggregator through the pool's RPC. Alone, since the page is held to what the aggregator says (it updates on a
  // half-percent move or once a day, which is why a quote is only blocked a good deal under it), and none of the exchanges' tickers is on the page's CSP.
  const feed = feedO || makeRateFeed({ sources: [chainlinkEthBtc({ call: (to, data) => ux.rpc('eth_call', [{ to, data }, 'latest']), ...(now ? { now } : {}) })], minSources: 1, maxAgeSecs: 600, ...(now ? { now } : {}) });

  const prefix = `tacit-fastbridge-pair-v1:mainnet:${pubHex}:`;
  // the page's own storage is copied to IndexedDB as it is written, and what was lost is put back (fast/pair-keep.js): a swap of ETH for BTC is not found again from the key
  const plainStorage = storage;
  if (storage && storage === globalThis.localStorage) storage = await keptStorage(prefix, storage);
  const stores = { fwd: makeLocalStore(`${prefix}fwd:`, storage), index: makeLocalStore(`${prefix}providers:`, storage), swaps: (id) => makeLocalStore(`${prefix}${id}:swaps:`, storage), quotes: (id) => makeLocalStore(`${prefix}${id}:quotes:`, storage) };
  const reverseCallFor = (ref) => (ref && ref.kind === 'mailbox'
    ? makeMailboxCall({ board: makeBoardClient({ base: ref.boardBase, fetchImpl }), gateway: ref.gateway, claimPub: ref.claimPub || null, ...(now ? { now } : {}) })
    : makeHttpCall({ base: ref && ref.base, fetchImpl }));
  // one page at a time takes the steps of a key's swaps (the others show what is kept): a pass that finds the lock held by another tab only reads
  const tend = (work, passive) => {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
    if (!locks || typeof locks.request !== 'function') return work();
    return locks.request(`tacit-fastbridge-pair-tend:${pubHex}`, { ifAvailable: true }, (lock) => (lock ? work() : passive()));
  };
  const pair = makePairClient({ btc, evm, seed, stores, discover, counterFor: (ref) => counterFor(ref, { fetchImpl }), reverseCallFor, feed, ...(now ? { now } : {}), tend });
  const run = ({ everyMs = 15000, onChange = () => {} } = {}) => {
    let busy = false, stopped = false;
    const once = async () => { if (busy || stopped) return; busy = true; try { onChange(await pair.pump()); } catch { /* the next pass */ } finally { busy = false; } };
    once();
    const timer = setInterval(once, everyMs);
    return () => { stopped = true; clearInterval(timer); };
  };
  // a copy of the swaps as a file, and one read back (only this key's records, only where this browser has none)
  const keep = { save: () => saveCopy(prefix, plainStorage), load: (json) => loadCopy(json, prefix, plainStorage) };
  return { pair, address: btc.address, run, lists: list, keep };
}
