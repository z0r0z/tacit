// Any token the pool escrows crosses to Bitcoin and back the way cUSDT does: under its own pool id with no Bitcoin link (a returning note resolves
// straight to the escrow), by the same burn, proof and mint as every bridged asset. What a runtime token still needs is what a built-in one has by hand:
// a limit for a crossing, the steps its row shows, and a name. The limits come from its market price (a crossing is a start, raised once round trips
// have been through, as for the others): a token no market prices has no limit, and no new crossing.
export const BRIDGE_MIN_USD = 2, BRIDGE_CAP_USD = 1000;
const MAX_RAW = 10n ** 18n;   // a note's value is a u64

// two significant digits: down for a limit's top, up for its bottom
function twoSig(x, up) {
  const s = x.toString();
  if (s.length <= 2) return x;
  const cut = 10n ** BigInt(s.length - 2), q = x / cut;
  return (up && x % cut ? q + 1n : q) * cut;
}

// The smallest and largest crossing in the token's Tacit units (tdec decimals), or null when the price or the precision leaves no sensible range.
// Exact integer arithmetic on the price at a millionth of a millionth of a dollar: a float turns $2 at $100,000 a token into 2,001 units of 2,000.
export function bridgeLimits({ usdPerToken, tdec, minUsd = BRIDGE_MIN_USD, capUsd = BRIDGE_CAP_USD }) {
  const p = Number(usdPerToken);
  if (!(p > 0) || !Number.isFinite(p) || !Number.isInteger(tdec) || tdec < 0 || tdec > 8) return null;
  const P = BigInt(Math.round(p * 1e12));
  if (P <= 0n) return null;
  const U = 10n ** 12n, ONE = 10n ** BigInt(tdec), ceilDiv = (x, y) => (x + y - 1n) / y;
  let cap = (BigInt(capUsd) * U * ONE) / P, min = ceilDiv(BigInt(minUsd) * U * ONE, P);
  if (min < 1n) min = 1n;
  if (cap > MAX_RAW) cap = MAX_RAW;
  cap = twoSig(cap, false); min = twoSig(min, true);
  return cap >= min * 10n ? { minRaw: min, capRaw: cap } : null;
}

// How many decimals a figure of this token shows: fewer for a cheap token, more for a dear one.
export const bridgeDp = (usdPerToken, tdec) => Math.min(tdec, usdPerToken >= 100 ? 6 : usdPerToken >= 1 ? 4 : 2);

const STEPS_OUT = ['Burned on Ethereum', 'Proven for Bitcoin', 'Sent to Bitcoin', 'Arrived'];
const STEPS_IN = ['Burned on Bitcoin', 'Confirmed', 'Proven on Ethereum', 'Minted privately'];

// The tracker's route entry (dapp/bridge/track.js ROUTES) for a token: its row names, where a row's link sends the page (the bridge tab: its deep-link
// grammar names only the built-in sources), and the steps.
export function bridgeRoute({ ticker, icon, dp, dec }) {
  return {
    ticker, icon, dp, ...(dec != null && dec !== 8 ? { dec } : {}),
    in: { start: '/#bridge', href: '/#bridge', go: `Bring ${ticker} back`, steps: STEPS_IN },
    out: { start: '/#bridge', href: '/#bridge', go: `Bridge ${ticker}`, steps: STEPS_OUT },
  };
}

// The tracker's limits entry: a crossing to Bitcoin between the least and the most, and back up to the most.
export const bridgeLimitEntry = ({ minRaw, capRaw }) => ({ in: { max: capRaw }, out: { min: minRaw, max: capRaw } });
