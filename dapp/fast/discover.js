// What the fast bridge page reads before a key opens: the providers there are to bridge with, and the terms a key's own provider starts
// from. The bridge itself (fast/wire.js) loads once a key opens. No DOM.
//
//   const list = await discoverProviders({ providers, boards })                         who there is to bridge with

import { makeHttpCounter } from '/fastbridge-http.js';
import { termsOf } from '/fastbridge-client.js?cb=efcb17bc';
import { readProviders } from '/fastbridge-mailbox.js?cb=4c2ccb36';
import { makeBoardClient } from '/fastbridge-board-client.js?cb=b3c3ac03';

// The terms of the other direction (private TAC sent for TAC on Bitcoin), from an ad that has them. A provider that sells only the one way has no `reverse`.
export const reverseTermsOf = (r) => ({
  feeBps: Number(r.feeBps) || 0, flatFee: BigInt(r.flatFee ?? 0), minAmount: BigInt(r.minAmount), maxAmount: BigInt(r.maxAmount),
  available: r.available == null ? null : BigInt(r.available), csvBlocks: r.csvBlocks, evmWindowSecs: r.evmWindowSecs,
});

// Every provider there is to bridge with: the ones that serve HTTP (checked against the key the page pins for each) and the ones on the
// boards (their ads, checked). One entry for each provider key, the one that serves HTTP first.
// What a provider swaps is named by its ad (or its /info): the asset it takes on Bitcoin and the one it pays in the pool. The bridge page lists only providers of TAC for TAC
// (the default `assets`), so a provider of another pair on the same board (Bitcoin for ETH, dapp/fastbridge-pair.js) is never taken for one that bridges TAC, with its
// amounts read in the wrong unit; a page of another pair names its own. A provider that names no asset (an ad from before they were named) is taken as TAC's.
export const TAC_PAIR = { btcAsset: 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', evmAsset: 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b' };
const bare = (h) => String(h == null ? '' : h).replace(/^0x/, '').toLowerCase();
const assetsOf = (x, want) => {
  const a = { btcAsset: bare(x.btcAsset), evmAsset: bare(x.evmAsset) };
  return (!a.btcAsset || a.btcAsset === bare(want.btcAsset)) && (!a.evmAsset || a.evmAsset === bare(want.evmAsset)) ? { btcAsset: a.btcAsset || bare(want.btcAsset), evmAsset: a.evmAsset || bare(want.evmAsset) } : null;
};

export async function discoverProviders({ providers = [], boards = [], fetchImpl = (...a) => fetch(...a), now, assets = TAC_PAIR }) {
  const out = [];
  let reached = 0; // providers and boards that answered at all: none of them means "not reached", which is not "none online"
  await Promise.all(providers.map(async (p) => {
    try {
      // the other direction's terms, read beside the forward ones: a provider that sells only one way answers no /reverse/info, and is listed without them
      const [i, ri] = await Promise.all([
        makeHttpCounter({ base: p.base, fetchImpl }).info(),
        fetchImpl(`${String(p.base).replace(/\/$/, '')}/reverse/info`, { signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      reached++;
      const claimPub = String(i.claimPub || '').toLowerCase(), a = assetsOf(i, assets);
      if (p.claimPub && p.claimPub.toLowerCase() !== claimPub) return;
      if (!a) return;
      let reverse = null;
      try { if (ri && ri.direction === 'out' && bare(ri.btcAsset) === a.btcAsset && bare(ri.evmAsset) === a.evmAsset) reverse = reverseTermsOf(ri); } catch { reverse = null; }
      out.push({ id: claimPub, name: p.name || 'Provider', ref: { kind: 'http', base: p.base, claimPub }, terms: termsOf(i), assets: a, http: true, ...(reverse ? { reverse } : {}) });
    } catch { /* a provider that does not answer is not listed */ }
  }));
  await Promise.all(boards.map(async (boardBase) => {
    try {
      const listed = await readProviders({ board: makeBoardClient({ base: boardBase, fetchImpl }), ...(now ? { now } : {}) });
      reached++;
      for (const p of listed) {
        const a = assetsOf(p.ad, assets);
        if (!a) continue;
        out.push({ id: p.id, name: p.name, ref: { kind: 'mailbox', boardBase, gateway: p.ad.gateway, claimPub: p.ad.claimPub }, terms: termsOf(p.ad), assets: a, ...(p.ad.reverse ? { reverse: reverseTermsOf(p.ad.reverse) } : {}) });
      }
    } catch { /* a board that does not answer has no providers here */ }
  }));
  const seen = new Set();
  const list = out.sort((a, b) => (b.http ? 1 : 0) - (a.http ? 1 : 0)).filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  // (list.reached: false when there was something to ask and nothing answered; not enumerable, so the list reads as before everywhere else)
  Object.defineProperty(list, 'reached', { value: reached > 0 || !(providers.length + boards.length), enumerable: false });
  return list;
}

// A provider's defaults, in base units of TAC (8 places): 0.30% and 1 TAC, from 10 to 1,000 TAC.
// a flat fee of 0.1 TAC keeps the smallest bridge (10 TAC) at 1.3% with the default 0.3%, well under the 5% above which a bridger's page marks a fee as high (it accepts up to 90%, fastbridge-client.js maxFeeBps)
export const PROVIDER_DEFAULTS = { feeBps: 30, flatFee: 10_000_000n, minAmount: 1_000_000_000n, maxAmount: 100_000_000_000n };
