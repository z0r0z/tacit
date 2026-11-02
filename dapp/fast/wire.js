// The fast bridge for a page that holds a Tacit key: the Bitcoin and pool sides built from the key and tacit.js, the client over
// them, the providers there are to bridge with, and the key's own provider. No DOM.
//
//   const s = await openFast({ T, withKey, ux, priv, pubHex, pins })                    bridging, with any provider
//   -> { address, notes(), balance(), quoteAll(providers, units), start({ quotes }), records(), run(), recover() }
//   const p = await openProvider({ T, withKey, ux, priv, pubHex, boards, settings })    providing, for anyone
//   -> { address, claimPub, inventory(), start(), stop(), status() }
//   const list = await discoverProviders({ providers, boards })                         who there is to bridge with
//
//   T  tacit.js with the key's wallet open     withKey(fn)  a call under that key (tacit-session.js)     ux  the pool module (trade/poolux.js)

import { makeBtcWallet } from '/bitcoin-taproot-wallet.js?cb=6e90dd96';
import { makeAdaptorBtcTx, tacitKit } from '/adaptor-btc-tx.js?cb=bc74dcba';
import { makeEsploraBtcChain } from '/fastbridge-btc.js?cb=8216bdd8';
import { makeFastBridgeEvm } from '/fastbridge-evm.js?cb=2391fffd';
import { makeHttpCounter, makeCounter } from '/fastbridge-http.js?cb=11295986';
import { makeFastBridgeMarket, makeLocalStore, termsOf } from '/fastbridge-client.js?cb=99d3bb3a';
import { makeLpService } from '/fastbridge-provider.js?cb=01b88a9e';
import { makeMailboxCounter, makeMailboxServer, makeAdPublisher, readProviders, gatewayOf } from '/fastbridge-mailbox.js?cb=d00c9623';
import { makeBoardClient } from '/fastbridge-board-client.js?cb=8d928552';
import { signSchnorr } from '/bulletproofs.js?cb=132d3648';
import { secp, sha256, keccak_256, hmac } from '/vendor/tacit-deps.min.js';

export const TAC_ASSET = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
export const EXPLORERS = ['https://mempool.space/api', 'https://blockstream.info/api'];
const enc = new TextEncoder();
const hmacSha256 = (k, m) => hmac(sha256, k, m);
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const TERMINAL = ['done', 'refunded', 'rejected', 'aborted', 'lost'];

// The key's confirmed TAC notes as the lock takes them.
export async function notesOf(T, asset = TAC_ASSET) {
  const h = await T.scanHoldings();
  const e = h instanceof Map ? h.get(asset) : null;
  return ((e && e.utxos) || [])
    .filter((x) => x.utxo && x.utxo.status && x.utxo.status.confirmed)
    .map((x) => ({ txid: x.utxo.txid, vout: x.utxo.vout, value: x.utxo.value, amount: BigInt(x.amount), blinding: BigInt(x.blinding) }));
}

// The counter of a provider from the reference kept with its swaps: one that serves HTTP, or one reached through a board.
export function counterFor(ref, { fetchImpl = (...a) => fetch(...a), call = {} } = {}) {
  if (ref && ref.kind === 'http') return makeHttpCounter({ base: ref.base, fetchImpl });
  if (ref && ref.kind === 'mailbox') return makeMailboxCounter({ board: makeBoardClient({ base: ref.boardBase, fetchImpl }), gateway: ref.gateway, ...call });
  return makeCounter(async () => ({ status: 503, body: { error: 'the provider is not reachable from here' } }));
}

// Every provider there is to bridge with: the ones that serve HTTP (checked against the key the page pins for each) and the ones on the
// boards (their ads, checked). One entry for each provider key, the one that serves HTTP first.
export async function discoverProviders({ providers = [], boards = [], fetchImpl = (...a) => fetch(...a), now }) {
  const out = [];
  await Promise.all(providers.map(async (p) => {
    try {
      const i = await makeHttpCounter({ base: p.base, fetchImpl }).info();
      const claimPub = String(i.claimPub || '').toLowerCase();
      if (p.claimPub && p.claimPub.toLowerCase() !== claimPub) return;
      out.push({ id: claimPub, name: p.name || 'Provider', ref: { kind: 'http', base: p.base, claimPub }, terms: termsOf(i), http: true });
    } catch { /* a provider that does not answer is not listed */ }
  }));
  await Promise.all(boards.map(async (boardBase) => {
    try {
      for (const p of await readProviders({ board: makeBoardClient({ base: boardBase, fetchImpl }), ...(now ? { now } : {}) })) {
        out.push({ id: p.id, name: p.name, ref: { kind: 'mailbox', boardBase, gateway: p.ad.gateway, claimPub: p.ad.claimPub }, terms: termsOf(p.ad) });
      }
    } catch { /* a board that does not answer has no providers here */ }
  }));
  const seen = new Set();
  return out.sort((a, b) => (b.http ? 1 : 0) - (a.http ? 1 : 0)).filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

// What both roles need of a key: its Bitcoin wallet, which must be the one tacit.js reads, and the Bitcoin and pool sides.
function sides({ T, ux, priv, hrp, bases, fetchImpl, asset, seedTag, forNotes }) {
  const { prims } = makeBtcWallet({ priv, hrp, fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
  // the lock spends notes at the wallet's own address: both must name the same one
  if (prims.wallet.address() !== T.wallet.address()) throw new Error('The Bitcoin address of this key is not the one the wallet reads. Nothing was done.');
  const builder = makeAdaptorBtcTx({ prims, kit: tacitKit(T) });
  const btc = makeEsploraBtcChain({
    bases, prims, builder, fetchImpl,
    // a provider reads the notes it is locked to and whether they are spent on Ethereum
    ...(forNotes ? { tacit: T, pool: ux.pool, ethGetStorageAt: (to, slot, tag) => ux.rpc('eth_getStorageAt', [to, slot, tag]), poolAddress: ux.cfg.pool, binding: ux.chainBindingHex(), keccak256: keccak_256, secp } : {}),
  });
  const seed = hmac(sha256, priv, enc.encode(seedTag));
  const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256, walletPriv: priv, seed, asset: asset.evmAsset, poolAddress: ux.cfg.pool });
  return { prims, btc, seed, evm };
}

export async function openFast({ T, withKey, ux, priv, pubHex, pins = {}, fetchImpl = (...a) => fetch(...a), bases = EXPLORERS, hrp = 'bc', now, call = {}, counterFor: counterOf = (ref) => counterFor(ref, { fetchImpl, call }) }) {
  const asset = { btcAsset: TAC_ASSET, evmAsset: TAC_ASSET, ...pins };
  const { prims, btc, seed, evm } = sides({ T, ux, priv, hrp, bases, fetchImpl, asset, seedTag: 'tacit-fastbridge-user-seed' });
  const store = makeLocalStore(`tacit-fastbridge-v1:mainnet:${pubHex}:`);
  const market = makeFastBridgeMarket({ btc, evm, store, seed, pins: asset, counterFor: counterOf, ...(now ? { now } : {}) });
  const notes = () => withKey((t) => notesOf(t, asset.btcAsset));
  const balance = async () => (await notes()).reduce((s, n) => s + n.amount, 0n);
  return {
    address: prims.wallet.address(), notes, balance, market,
    quoteAll: (providers, units, o) => market.quoteAll(providers, units, o),
    start: async ({ quotes }) => market.start({ quotes, notes: await notes() }),
    records: market.records, run: market.run, recover: market.recover,
  };
}

// ── the key's own provider ──

// A provider's defaults, in base units of TAC (8 places): 0.30% and 1 TAC, from 10 to 1,000 TAC.
export const PROVIDER_DEFAULTS = { feeBps: 30, flatFee: 100_000_000n, minAmount: 1_000_000_000n, maxAmount: 100_000_000_000n };

export async function openProvider({ T, ux, priv, pubHex, boards = [], name = null, fetchImpl = (...a) => fetch(...a), bases = EXPLORERS, hrp = 'bc', now = () => Math.floor(Date.now() / 1000), tickSecs = 15, pollMs = 3000 }) {
  const asset = { btcAsset: TAC_ASSET, evmAsset: TAC_ASSET };
  const { prims, btc, seed, evm } = sides({ T, ux, priv, hrp, bases, fetchImpl, asset, seedTag: 'tacit-fastbridge-lp-seed', forNotes: true });
  const claimPub = hex(prims.wallet.pub);
  const adName = name || `Provider ${claimPub.slice(2, 8)}`;
  const swaps = makeLocalStore(`tacit-fastlp-v1:mainnet:${pubHex}:swaps:`), quoteStore = makeLocalStore(`tacit-fastlp-v1:mainnet:${pubHex}:quotes:`);
  const keys = gatewayOf(priv);
  // more Bitcoin confirmations for a larger amount
  const confs = (v) => (BigInt(v) >= 10_000n * 10n ** 8n ? 3 : BigInt(v) >= 1_000n * 10n ** 8n ? 2 : 1);
  let service = null, stops = [], running = false, accepting = false, lastError = null, busy = false;

  async function status() {
    const recs = await swaps.list();
    const done = recs.filter((r) => r.phase === 'done');
    return {
      running, accepting, open: recs.filter((r) => !TERMINAL.includes(r.phase)).length, done: done.length,
      earned: done.reduce((a, r) => a + (BigInt(r.offer.btc.value) - BigInt(r.offer.evm.amount)), 0n), lastError,
    };
  }
  async function inventory() {
    const [pool, coins] = await Promise.all([evm.available(), btc.satsUtxos()]);
    return { pool, coins: coins.length, address: btc.address, claimPub };
  }
  const configOf = (s) => ({
    claimPub, csvBlocks: 144, alertSecs: 3600,
    quote: { btcAsset: asset.btcAsset, evmAsset: asset.evmAsset, minAmount: s.minAmount, maxAmount: s.maxAmount, feeBps: s.feeBps, flatFee: s.flatFee, validSecs: 600 },
    policy: {
      minCsv: 72, evmWindowSecs: 4 * 3600, minClaimSecs: 3600, claimSlackSecs: 7200, roundSecs: 600, refundMarginSecs: 600, maxOfferAgeSecs: 3600,
      minAmount: s.minAmount, maxAmount: s.maxAmount, minConfsFor: confs,
    },
  });
  // Starts the swaps that are open on their way (the takes and the refunds are not to be left), and, when `accept` is set, answers
  // requests and posts the ad on every board. Settings: { feeBps, flatFee, minAmount, maxAmount } in base units.
  async function start({ settings = {}, accept = true } = {}) {
    if (running) return;
    service = makeLpService({ seed, btc, evm, swaps, quoteStore, config: configOf({ ...PROVIDER_DEFAULTS, ...settings }), now });
    await service.start();
    running = true; accepting = !!accept; lastError = null;
    const note = (o) => { lastError = o.error || o.msg || null; };
    if (accept) {
      for (const base of boards) {
        const board = makeBoardClient({ base, fetchImpl });
        const mail = makeMailboxServer({ board, keys, handle: service.handle, signReply: (d) => signSchnorr(d, priv), now, pollMs, log: note });
        const ads = makeAdPublisher({ board, handle: service.handle, claimPriv: priv, claimPub, keys, name: adName, now, everySecs: 60, log: note });
        mail.start(); ads.start();
        stops.push(() => { mail.stop(); ads.stop(); });
      }
    }
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await service.tick(); } catch (e) { lastError = String((e && e.message) || e).slice(0, 160); } finally { busy = false; }
    }, tickSecs * 1000);
    stops.push(() => clearInterval(timer));
  }
  function stop() { for (const f of stops) f(); stops = []; running = false; accepting = false; }
  return { address: btc.address, claimPub, inventory, start, stop, status, service: () => service };
}
