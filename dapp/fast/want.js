// Waiting for a fast bridge provider. A key with TAC on Bitcoin that no provider online can take keeps a want in this browser and posts
// it to the boards, signed with a key made for it alone, so providers see what is waiting; any page of the site then tells the holder
// when a provider can take it. No DOM; the front page and /fast/ both use it.
//
//   const w = makeWants({ boards, providers, storage, fetchImpl, now })
//   w.kept(pub)             the want this browser keeps for a key, or null: { amount, at, until }
//   w.start(pub, amount)    keeps one for `amount` (base units) and posts it -> the want kept
//   w.stop(pub)             takes it down and forgets it
//   w.takers(amount)        the providers online that take `amount` now: [{ id, name }]
//   w.waiting()             what is waiting on the boards: { count, total }

import { signWant, checkWant, checkAd } from '/fastbridge-board.js?cb=0152bd20';
import { makeBoardClient } from '/fastbridge-board-client.js?cb=850e1c5e';
import { secp, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';

export const TAC_ASSET = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const KEY = (pub) => `tacit-fastbridge-want-v1:${pub}`;
const DAY = 86400;

export function makeWants({ boards = [], providers = [], storage = globalThis.localStorage, fetchImpl = (...a) => fetch(...a), now = () => Math.floor(Date.now() / 1000), asset = TAC_ASSET }) {
  const clients = boards.map((base) => makeBoardClient({ base, fetchImpl, timeoutMs: 8000 }));
  const read = (pub) => { try { return JSON.parse(storage.getItem(KEY(pub))); } catch { return null; } };
  const write = (pub, v) => { try { if (v) storage.setItem(KEY(pub), JSON.stringify(v)); else storage.removeItem(KEY(pub)); } catch { /* a convenience */ } };
  // a board that does not take it is left out: the want is kept here all the same, and this browser still looks for a provider
  const post = (want) => Promise.all(clients.map((c) => c.putWant(want).catch(() => null)));

  function kept(pub) {
    const v = read(pub);
    if (!v || !(Number(v.until) > now())) { if (v) write(pub, null); return null; }
    return { amount: BigInt(v.amount), at: v.at, until: v.until };
  }
  async function start(pub, amount) {
    const priv = secp.utils.randomPrivateKey(), at = now();
    const want = signWant({ pub: bytesToHex(secp.getPublicKey(priv, true)), btcAsset: asset, amount: String(amount), at, until: at + DAY }, priv);
    write(pub, { amount: String(amount), at, until: want.until, priv: bytesToHex(priv) });
    await post(want);
    return kept(pub);
  }
  async function stop(pub) {
    const v = read(pub);
    write(pub, null);
    if (!v || !v.priv) return;
    const priv = hexToBytes(v.priv), t = Math.max(now(), Number(v.at) + 1);
    await post(signWant({ pub: bytesToHex(secp.getPublicKey(priv, true)), btcAsset: asset, amount: '0', at: t, until: t + 60 }, priv));
  }

  // what each provider takes now: its least, and its most or what it says it can take now
  async function online() {
    const out = new Map(), t = now();
    await Promise.all(providers.map(async (p) => {
      try {
        const r = await fetchImpl(String(p.base).replace(/\/$/, '') + '/info', { signal: AbortSignal.timeout(8000) });
        const i = r.ok ? await r.json() : null, id = String(i?.claimPub || '').toLowerCase();
        if (!id || (p.claimPub && p.claimPub.toLowerCase() !== id)) return;
        out.set(id, { id, name: p.name || 'Provider', min: BigInt(i.minAmount), max: BigInt(i.maxAmount), available: i.available == null ? null : BigInt(i.available) });
      } catch { /* a provider that does not answer is not online */ }
    }));
    await Promise.all(clients.map(async (c) => {
      try {
        for (const ad of await c.ads()) {
          try { checkAd(ad, t); } catch { continue; }
          if (String(ad.btcAsset).replace(/^0x/, '').toLowerCase() !== asset || out.has(ad.claimPub)) continue;
          out.set(ad.claimPub, { id: ad.claimPub, name: ad.name || 'Provider', min: BigInt(ad.minAmount), max: BigInt(ad.maxAmount), available: ad.available == null ? null : BigInt(ad.available) });
        }
      } catch { /* a board that does not answer has no providers here */ }
    }));
    return [...out.values()];
  }
  async function takers(amount) {
    const a = BigInt(amount);
    return (await online()).filter((p) => a >= p.min && a <= (p.available != null && p.available < p.max ? p.available : p.max)).map(({ id, name }) => ({ id, name }));
  }

  async function waiting() {
    const seen = new Map(), t = now();
    await Promise.all(clients.map(async (c) => {
      try {
        for (const w of await c.wants()) {
          try { checkWant(w, t); } catch { continue; }
          if (String(w.btcAsset).replace(/^0x/, '').toLowerCase() === asset && BigInt(w.amount) > 0n) seen.set(w.pub, BigInt(w.amount));
        }
      } catch { /* a board that does not answer, or one that keeps no wants yet */ }
    }));
    return { count: seen.size, total: [...seen.values()].reduce((s, x) => s + x, 0n) };
  }

  return { kept, start, stop, takers, waiting };
}
