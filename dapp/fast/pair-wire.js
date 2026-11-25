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
import { makeEsploraBtcChain } from '/fastbridge-btc.js?cb=7410374b';
import { makeFastBridgeEvm, makeTxTracer, makeOwnLockFinder, makeNodeQuorum, TRACE_NODES } from '/fastbridge-evm.js?cb=d115e531';
import { makeHttpCall } from '/fastbridge-reverse-client.js?cb=cc29143a';
import { makeMailboxCall } from '/fastbridge-mailbox.js?cb=68f14a95';
import { makeBoardClient } from '/fastbridge-board-client.js?cb=b3c3ac03';
import { makeLocalStore } from '/fastbridge-client.js?cb=8b4b5fae';
import { makePairClient, ETH_ASSET, SATS_ASSET } from '/fastbridge-pair.js?cb=1c901eb7';
import { makeRateFeed, chainlinkNodes, PRICE_NODES } from '/fastbridge-rate.js?cb=be7769e1';
import { discoverProviders } from '/fast/discover.js?cb=ba6128db';
import { keptStorage, saveCopy, loadCopy } from '/fast/pair-keep.js?cb=b7885472';
import { walletSettle, counterFor, EXPLORERS } from '/fast/wire.js?cb=33e583de';
import { secp, sha256, keccak_256, hmac, bytesToHex } from '/vendor/tacit-deps.min.js';

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

export async function openPair({ T, ux, priv, pubHex, wallet = null, ask, fetchImpl = (...a) => fetch(...a), bases = EXPLORERS, hrp = 'bc', now, lists = null, storage = globalThis.localStorage, discover: discoverO = null, feed: feedO = null, priceNodes = PRICE_NODES, log = () => {} }) {
  const { prims } = makeBtcWallet({ priv, hrp, fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
  // the lock spends the wallet's own coins: tacit.js and this must name the same address
  if (T && prims.wallet.address() !== T.wallet.address()) throw new Error('The Bitcoin address of this key is not the one the wallet reads. Nothing was done.');
  const builder = makeAdaptorBtcTx({ prims, kit: T ? tacitKit(T) : undefined });
  // the lock goes out for the next block or two and not under 2 sat/vB (see fastbridge-btc.js minFeeRate)
  const btc = makeEsploraBtcChain({ bases, prims, builder, fetchImpl, feeTarget: '1', minFeeRate: 2 });
  const seed = hmac(sha256, priv, enc.encode('tacit-fastbridge-user-pair-seed'));
  const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256, walletPriv: priv, seed, asset: ETH_ASSET, poolAddress: ux.cfg.pool, selfSettle: wallet ? walletSettle({ ux, wallet, ask }) : null, log, trace: makeTxTracer({ fetchImpl, nodes: TRACE_NODES.filter((u) => !/tatum/.test(u)), pool: ux.cfg.pool }), quorum: makeNodeQuorum({ fetchImpl }) });   // (the nodes the page's CSP reaches)
  // an ETH-for-Bitcoin swap is found again from the key by its pool lock's memo (pair.recover)
  evm.findOwnLocks = makeOwnLockFinder({ ux, hmacSha256, walletPriv: priv });

  const list = lists || (await loadLists(fetchImpl));
  const clock = () => (now ? now() : Math.floor(Date.now() / 1000));
  let found = { at: -Infinity, list: [] };
  const discover = discoverO || (async () => { if (clock() - found.at > 60) found = { at: clock(), list: await discoverProviders({ ...list, fetchImpl, assets: { btcAsset: SATS_ASSET, evmAsset: ETH_ASSET }, ...(now ? { now } : {}) }) }; return found.list; });
  // the page's own reading of the market: Chainlink's ETH / BTC aggregator (it updates on a half-percent move or once a day, which is why a quote is only blocked a good deal
  // under it; none of the exchanges' tickers is on the page's CSP), read at one block from nodes of separate operators, and taken only when two or more answer and all that
  // answer agree. The pair client then refuses a reading that rests on fewer than two.
  const feed = feedO || makeRateFeed({ sources: chainlinkNodes({ nodes: priceNodes, fetchImpl, ...(now ? { now } : {}) }), minSources: 2, maxSpreadBps: 1, unanimous: true, maxAgeSecs: 600, ...(now ? { now } : {}) });

  const prefix = `tacit-fastbridge-pair-v1:mainnet:${pubHex}:`;
  // the page's own storage is copied to IndexedDB as it is written, and what was lost is put back (fast/pair-keep.js): a swap of ETH for BTC is not found again from the key
  const plainStorage = storage;
  if (storage && storage === globalThis.localStorage) storage = await keptStorage(prefix, storage);
  const stores = { fwd: makeLocalStore(`${prefix}fwd:`, storage), index: makeLocalStore(`${prefix}providers:`, storage), swaps: (id) => makeLocalStore(`${prefix}${id}:swaps:`, storage), quotes: (id) => makeLocalStore(`${prefix}${id}:quotes:`, storage) };
  // (`timeoutMs`: how long a call waits for its answer, for a quote that is not waited on for longer than the quote's own wait)
  const reverseCallFor = (ref, o = {}) => (ref && ref.kind === 'mailbox'
    ? makeMailboxCall({ board: makeBoardClient({ base: ref.boardBase, fetchImpl }), gateway: ref.gateway, claimPub: ref.claimPub || null, ...(now ? { now } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) })
    : makeHttpCall({ base: ref && ref.base, fetchImpl, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) }));
  // one page at a time takes the steps of a key's swaps (the others show what is kept): a pass that finds the lock held by another tab only reads
  const tend = (work, passive) => {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
    if (!locks || typeof locks.request !== 'function') return work();
    return locks.request(`tacit-fastbridge-pair-tend:${pubHex}`, { ifAvailable: true }, (lock) => (lock ? work() : passive()));
  };
  // the last good market reading, kept across visits: one far from it is not taken until it holds (fastbridge-pair.js maxMarketJumpBps)
  const memo = storage ? { get: () => JSON.parse(storage.getItem('tacit-pair-market-v1') || 'null'), put: (m) => storage.setItem('tacit-pair-market-v1', JSON.stringify(m)) } : null;
  // one start at a time for the key, across its tabs: a Web Lock where there is one, else a short lease in localStorage that a second tab finds and waits out
  const exclusive = async (work) => {
    const name = `tacit-fastbridge-pair-start:${pubHex}`;
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
    if (locks && typeof locks.request === 'function') return locks.request(name, () => work());
    const ls = plainStorage, read = () => { try { return JSON.parse(ls.getItem(name) || 'null'); } catch { return null; } };
    if (!ls) return work();
    const was = read();
    if (was && Date.now() - Number(was.at) < 120000) throw new Error('a swap of this wallet is being started in another tab: try again in a moment');
    const me = Math.random().toString(36).slice(2);
    ls.setItem(name, JSON.stringify({ at: Date.now(), me }));
    if ((read() || {}).me !== me) throw new Error('a swap of this wallet is being started in another tab: try again in a moment');
    try { return await work(); } finally { if ((read() || {}).me === me) ls.removeItem(name); }
  };
  // the providers that failed lately, kept across visits so that one that does not answer is asked after the others (fastbridge-pair.js strikes)
  const strikes = storage ? { get: () => JSON.parse(storage.getItem('tacit-pair-provider-strikes-v1') || '{}'), put: (m) => storage.setItem('tacit-pair-provider-strikes-v1', JSON.stringify(m)) } : null;
  const counterOf = (ref, o = {}) => counterFor(ref, { fetchImpl, ...(o.timeoutMs ? { call: { timeoutMs: o.timeoutMs } } : {}) });
  // (a lock of sats never takes a coin tacit.js finds a note on: its holdings scan, when the page has tacit.js)
  const holdings = T && typeof T.scanHoldings === 'function' ? () => T.scanHoldings() : null;
  const pair = makePairClient({ btc, evm, seed, stores, discover, counterFor: counterOf, reverseCallFor, feed, ...(now ? { now } : {}), tend, exclusive, memo, strikes, holdings });
  const run = ({ everyMs = 15000, onChange = () => {} } = {}) => {
    let busy = false, stopped = false;
    const once = async () => { if (busy || stopped) return; busy = true; try { onChange(await pair.pump()); } catch { /* the next pass */ } finally { busy = false; } };
    once();
    const timer = setInterval(once, everyMs);
    return () => { stopped = true; clearInterval(timer); };
  };
  // a copy of the swaps as a file, and one read back (only a copy this key saved, only this key's records, only where this browser has none)
  // (signed with a MAC under a key the Tacit key derives: a file read back is one this key saved, not one anyone who knows the public key could write)
  const copyKey = hmac(sha256, priv, enc.encode('tacit-btc-eth-swaps-copy-v1'));
  const mac = (text) => bytesToHex(hmac(sha256, copyKey, enc.encode(text)));
  const keep = { save: () => saveCopy(prefix, plainStorage, mac), load: (json) => loadCopy(json, prefix, plainStorage, mac) };
  // The address's own sats, for a page that sends them (btc/send.js plans and signs): its confirmed plain-sat coins, the coins a swap under way holds, the swap locks
  // never to be paid to, the coins tacit.js finds a note on (its holdings scan, when the page has tacit.js), the explorers' fee estimates for the next block, about
  // three and about six (the same explorers and the same reading of them as the lane's own fee), the key's signer, and a broadcast to every explorer.
  const tiers = { fast: btc, normal: makeEsploraBtcChain({ bases, prims, builder, fetchImpl, feeTarget: '3', minFeeRate: 1 }), slow: makeEsploraBtcChain({ bases, prims, builder, fetchImpl, feeTarget: '6', minFeeRate: 1 }) };
  const bitcoin = {
    address: btc.address, prims,
    coins: () => btc.satsCoins(),
    held: () => pair.heldCoins(),
    locks: () => pair.lockOutputs(),
    holdings,
    feeRates: async () => { const [fast, normal, slow] = await Promise.all(['fast', 'normal', 'slow'].map((k) => tiers[k].feeRate().catch(() => null))); return { fast, normal, slow }; },
    broadcast: (hex) => btc.broadcast({ commitHex: null, revealHex: hex }),
    status: (txid) => btc.status(txid),
  };
  return { pair, address: btc.address, run, lists: list, keep, bitcoin };
}
