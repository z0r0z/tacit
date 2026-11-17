// The relays a wallet may use on a chain, and how one is chosen for a spend.
//
// A chain lists its relays as { url, relayer, weight? }. `relayer` is the address that relay's quote must name: a page pins it, as it pins the one relay it
// ships with, so a host that is not the one listed cannot send a fee anywhere else. `weight` is how likely the relay is among those priced alike
// (1 when absent): a registry of staked or proven relays sets it, and nothing here cares where a weight came from.
//
// A spend asks every relay for a quote and takes among the cheapest: the relays within NEAR_PCT of the lowest fee are drawn from by weight, so a
// busy relay is not the only one used and a cheap one is not the only one tried. The rest follow in order of fee, for a spend that has to go elsewhere.

export const QUOTE_MS = 6_000;      // a relay that has not quoted by then is left out of this spend
export const NEAR_PCT = 25n;        // how far above the lowest fee a quote may be and still be drawn from

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// A relay's base URL ends where the relay software serves: `/evm-pool/keeper`. The private route (dapp/private-route.js) knows a relay by that path and
// refuses to send one directly while it is on, so a listed URL without it would be fetched past the route.
const KEEPER_PATH = /\/evm-pool\/keeper$/;
const LOCAL = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/;

// The entries a wallet works with, from a chain's `keepers` list and its single `keeper` (the one a chain config has always named), with `relayer`
// the address pinned for that one (which is kept as it is, pinned or not). `pinned`: on a real origin every other relay must name the address it is to be
// paid at; off one (a test, a local page) a relay may go without. A listed relay that is not a plain https URL ending in `/evm-pool/keeper`, or lacks its
// pin where one is wanted, is left out, not guessed at.
export function relaysOf({ keeper = null, keepers = null, relayer = null, pinned = true } = {}) {
  const out = [], seen = new Set();
  const add = (url, addr, weight, listed) => {
    if (typeof url !== 'string') return;
    const u = url.replace(/\/+$/, '');
    if (!/^https:\/\/[\w.-]+(?::\d+)?(?:\/[\w./-]*)?$/.test(u) && !LOCAL.test(u)) return;
    if (listed && !KEEPER_PATH.test(u)) return;
    if (seen.has(u.toLowerCase())) return;
    const a = typeof addr === 'string' && ADDRESS.test(addr) ? addr : null;
    if (listed && pinned && !a) return;
    const w = Number(weight);
    seen.add(u.toLowerCase());
    out.push({ url: u, relayer: a, weight: Number.isFinite(w) && w > 0 ? w : 1 });
  };
  if (keeper) add(keeper, relayer, 1, false);
  for (const k of keepers || []) add(k?.url, k?.relayer, k?.weight, true);
  return out;
}

const feeOf = (x) => BigInt(x.q.fee);

// `quotes`: [{ e, q }] (a relay's entry and its vetted quote) → the same, the one to use first, then the others by fee. `random` → [0, 1).
export function orderQuotes(quotes, random = Math.random) {
  if (quotes.length < 2) return [...quotes];
  const byFee = [...quotes].sort((a, b) => (feeOf(a) < feeOf(b) ? -1 : feeOf(a) > feeOf(b) ? 1 : 0));
  const low = feeOf(byFee[0]);
  const near = byFee.filter((x) => feeOf(x) * 100n <= low * (100n + NEAR_PCT));
  const total = near.reduce((t, x) => t + x.e.weight, 0);
  let draw = random() * total, pick = near[near.length - 1];
  for (const x of near) { draw -= x.e.weight; if (draw < 0) { pick = x; break; } }
  return [pick, ...byFee.filter((x) => x !== pick)];
}
