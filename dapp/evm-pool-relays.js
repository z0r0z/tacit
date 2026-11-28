// The relays a wallet may use on a chain, and how one is chosen for a spend.
//
// A chain lists its relays as { url, relayer, weight? }. `relayer` is the address that relay's quote must name: a page pins it, as it pins the one relay it
// ships with, so a host that is not the one listed cannot send a fee anywhere else. `weight` is how likely the relay is among those priced alike
// (1 when absent): a registry of staked or proven relays sets it, and nothing here cares where a weight came from.
//
// A spend asks every relay for a quote and takes among the cheapest: the relays within NEAR_PCT of the lowest fee are drawn from by weight, and a
// relay priced above the lowest has its odds scaled by (lowest / its fee) squared, so price wins most of the time, a busy relay is not the only one used,
// and a cheap one is not the only one tried. The rest follow in order of fee, for a spend that has to go elsewhere.

export const QUOTE_MS = 6_000;      // a relay that has not quoted by then is left out of this spend
export const NEAR_PCT = 25n;        // how far above the lowest fee a quote may be and still be drawn from

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// A relay's base URL ends where the relay software serves: `/evm-pool/keeper`. The private route (dapp/private-route.js) knows a relay by that path and
// refuses to send one directly while it is on, so a listed URL without it would be fetched past the route.
const KEEPER_PATH = /\/evm-pool\/keeper$/;
// A host a page on a real origin should reach for a listed relay: a DNS name with a dot, not an address and not a local one. (A name can still point
// anywhere; the page's content-security policy is what fences that.)
const LOCAL_TLD = /\.(?:local|localhost|internal|intranet|lan|home|corp|private|invalid|arpa)$/;
function publicHost(url) {
  const host = url.replace(/^https:\/\//, '').split('/')[0].replace(/:\d+$/, '').toLowerCase();
  return /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(host) && !/\.\d+$/.test(host) && !LOCAL_TLD.test(host);
}
// A relay at a Tor onion address, listed like any other as `https://<id>.onion/evm-pool/keeper` (the relay registry takes only https URLs). Tor carries and
// encrypts the traffic, so a page on Tor asks it as plain http; a page that is not on Tor leaves these out, since it cannot reach them.
export const isOnion = (url) => /^https?:\/\/[a-z2-7]{16,56}\.onion(?::\d+)?(?:\/|$)/i.test(String(url));
export const onionHttp = (url) => String(url).replace(/^https:/i, 'http:');
// Whether this page reaches the web through Tor: served from an onion address, or switched on in this browser: a link with `?tor=1` turns it on and keeps it (localStorage
// 'tacit-tor' = '1'), `?tor=0` turns it off. A page cannot tell that it is in Tor Browser, so a person who is says so once.
export function onTor() {
  try {
    if (/\.onion$/i.test(globalThis.location?.hostname || '')) return true;
    const q = new URLSearchParams(globalThis.location?.search || '').get('tor');
    if (q === '1' || q === '0') {
      try { if (q === '1') globalThis.localStorage?.setItem('tacit-tor', '1'); else globalThis.localStorage?.removeItem('tacit-tor'); } catch { /* storage blocked: the link still decides for this page */ }
      return q === '1';
    }
    return globalThis.localStorage?.getItem('tacit-tor') === '1';
  } catch { return false; }
}
const LOCAL = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/;

// The entries a wallet works with, from a chain's `keepers` list and its single `keeper` (the one a chain config has always named), with `relayer`
// the address pinned for that one (which is kept as it is, pinned or not). `pinned`: on a real origin every other relay must name the address it is to be
// paid at, and a host that is a public name; off one (a test, a local page) a relay may go without, and a local host is fine. A listed relay that is not a
// plain https URL ending in `/evm-pool/keeper`, or lacks its pin where one is wanted, is left out, not guessed at.
export function relaysOf({ keeper = null, keepers = null, relayer = null, pinned = true, tor = onTor() } = {}) {
  const out = [], seen = new Set(), own = new Set();
  const add = (url, addr, weight, listed) => {
    if (typeof url !== 'string') return;
    const u = url.replace(/\/+$/, '');
    // the relay a config ships with is the one at its URL: a list that names the same URL (the relay itself, listed for others to find, or someone else's
    // entry for it) adds nothing, and must not pin it to an address of the list's choosing
    if (listed && own.has(u.toLowerCase())) return;
    if (isOnion(u) && !tor) return;
    if (!/^https:\/\/[\w.-]+(?::\d+)?(?:\/[\w./-]*)?$/.test(u) && !LOCAL.test(u)) return;
    if (listed && !KEEPER_PATH.test(u)) return;
    if (listed && pinned && !publicHost(u)) return;
    const a = typeof addr === 'string' && ADDRESS.test(addr) ? addr : null;
    if (listed && pinned && !a) return;
    // One entry for each URL and address. Two addresses at one URL are both kept: which of them the server at that URL is shows in its quote, which must
    // name the entry's own address, so an entry made by someone else for a URL cannot push the real relay off the list.
    const key = `${u.toLowerCase()}|${(a ?? '').toLowerCase()}`;
    if (seen.has(key)) return;
    const w = Number(weight);
    seen.add(key);
    if (!listed) own.add(u.toLowerCase());
    out.push({ url: u, relayer: a, weight: Number.isFinite(w) && w > 0 ? w : 1 });
  };
  if (keeper) add(keeper, relayer, 1, false);
  for (const k of keepers || []) add(k?.url, k?.relayer, k?.weight, true);
  return out;
}

const feeOf = (x) => BigInt(x.q.fee);

// `quotes`: [{ e, q }] (a relay's entry and its vetted quote) → the same, the one to use first, then the others by fee. `random` → [0, 1).
// `prefer`: relay URLs the person chose to prefer; when one of them is among the near-cheapest, the pick is made among those alone.
export function orderQuotes(quotes, random = Math.random, prefer = []) {
  if (quotes.length < 2) return [...quotes];
  const byFee = [...quotes].sort((a, b) => (feeOf(a) < feeOf(b) ? -1 : feeOf(a) > feeOf(b) ? 1 : 0));
  const low = feeOf(byFee[0]);
  const close = byFee.filter((x) => feeOf(x) * 100n <= low * (100n + NEAR_PCT));
  const yes = new Set((prefer || []).map((u) => String(u).replace(/\/+$/, '').toLowerCase()));
  const mine = yes.size ? close.filter((x) => yes.has(String(x.e?.url || '').replace(/\/+$/, '').toLowerCase())) : [];
  const near = mine.length ? mine : close;
  // a relay's odds: its weight, less as it is dearer than the cheapest (at NEAR_PCT above, 64% of the cheapest's odds)
  const odds = (x) => {
    const f = feeOf(x);
    const r = f === 0n ? 1 : Number((low * 1_000_000n) / f) / 1e6;
    return x.e.weight * r * r;
  };
  const total = near.reduce((t, x) => t + odds(x), 0);
  let draw = random() * total, pick = near[near.length - 1];
  for (const x of near) { draw -= odds(x); if (draw < 0) { pick = x; break; } }
  return [pick, ...byFee.filter((x) => x !== pick)];
}
