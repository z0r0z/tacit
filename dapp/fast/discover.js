// What the fast bridge page reads before a key opens: the providers there are to bridge with, and the terms a key's own provider starts
// from. The bridge itself (fast/wire.js) loads once a key opens. No DOM.
//
//   const list = await discoverProviders({ providers, boards })                         who there is to bridge with

import { makeHttpCounter } from '/fastbridge-http.js';
import { termsOf } from '/fastbridge-client.js?cb=a59760d0';
import { readProviders } from '/fastbridge-mailbox.js?cb=e88908a8';
import { makeBoardClient } from '/fastbridge-board-client.js?cb=850e1c5e';

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

// A provider's defaults, in base units of TAC (8 places): 0.30% and 1 TAC, from 10 to 1,000 TAC.
// a flat fee of 0.1 TAC keeps the smallest bridge (10 TAC) at 1.3% with the default 0.3%, well inside the 5% a bridger's page accepts
export const PROVIDER_DEFAULTS = { feeBps: 30, flatFee: 10_000_000n, minAmount: 1_000_000_000n, maxAmount: 100_000_000_000n };
