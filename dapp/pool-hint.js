// What a deposit's receipt says of a pool in which a trade can land while the deposit is being proved.
//
// A deposit into a pool is proved against the price the pool has at that moment, and a trade (or an add or a remove) that lands first ends that proof (the page proves it again by itself,
// up to three times, and nothing is sent or spent until one goes through). Two things say how likely that is.
//   How thin the pool is. The page knows how far a trade moves it, and a pool that a small trade moves is one that traders find worth moving: the hint is that fact, for a trade of
//   TRADE_ETH, worked out from the pool's size in ETH (both sides, as the page already counts it): constant product, the pool holding half its worth on the ETH side. A pool that
//   moves less than SHOW_AT percent for it says nothing of this.
//   How often it has changed. The server logs each pool's state at every five-minute tick (worker-relay/src/lib/pool-activity.js) and sends a summary with the farm program:
//   `activity` { at, since, hour, day, lastMoveAt }. A change counts once however many trades made it, so the count is a floor. It is spoken only while it is fresh (the server's last
//   reading is under MAX_AGE_MS old) and has been kept for MIN_SPAN_MS at least, and a pool that has not changed in that time is said to be quiet only where it is small.
export const TRADE_ETH = 0.1, SHOW_AT = 0.5, BUSY_AT = 3, MIN_SPAN_MS = 15 * 60e3, MAX_AGE_MS = 25 * 60e3;
export const TIP = 'Your deposit goes in at the price the pool has when it is proved, and a trade that lands first ends that proof. It is then proved again by itself, up to three times, and nothing is sent or spent until one goes through.';
export const MOVES_TIP = 'How many times the pool’s price changed between the server’s five-minute readings. Two trades between readings count once, so it is at least this many. Each one that lands while a deposit is being proved ends that proof.';

const shown = (n) => (n >= 10 ? String(Math.round(n)) : n >= 1 ? String(Math.round(n * 10) / 10) : String(Math.round(n * 100) / 100));
const MIN = 60e3;
const ago = (ms) => {
  const m = Math.max(1, Math.round(ms / MIN));
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export function smallPool(worthEth) {
  const w = Number(worthEth);
  if (!(w > 0) || !Number.isFinite(w)) return null;
  const move = ((1 + TRADE_ETH / (w / 2)) ** 2 - 1) * 100;
  if (!(move >= SHOW_AT)) return null;
  return { move, row: ['Small pool', `a ${TRADE_ETH} ETH trade moves its price ${shown(move)}%`, '', TIP], time: ', longer if the pool trades meanwhile' };
}

// What the server says of how often the pool has changed, in words for the receipt, or null when it says nothing usable: no record, a stale one, or one too short.
export function recentMoves(activity, now = Date.now()) {
  const a = activity;
  if (!a || !Number.isFinite(a.at) || !Number.isFinite(a.since) || !Number.isFinite(a.hour)) return null;
  if (now - a.at > MAX_AGE_MS || a.at - a.since < MIN_SPAN_MS) return null;
  const span = Math.min(60 * MIN, a.at - a.since), when = span >= 59 * MIN ? 'the last hour' : `the last ${Math.round(span / MIN)} min`, n = Math.max(0, Math.round(a.hour));
  const last = n > 0 && Number.isFinite(a.lastMoveAt) ? `, the last ${ago(now - a.lastMoveAt)}` : '';
  return { n, busy: n >= BUSY_AT, text: n === 0 ? `none in ${when}` : `${n} in ${when}${last}` };
}

// The receipt's rows for a pool, and what to add to its Time row: from the pool's size in ETH and what the server says of its activity. null where there is nothing to say.
export function poolNote(worthEth, activity, now = Date.now()) {
  const small = smallPool(worthEth), moves = recentMoves(activity, now), rows = [];
  if (small) rows.push(small.row);
  if (moves && (small || moves.n > 0)) rows.push([moves.busy ? 'Busy pool' : 'Recent moves', moves.text, '', MOVES_TIP]);
  if (!rows.length) return null;
  const quiet = moves && moves.n === 0;
  return { rows, move: small ? small.move : null, moves, time: quiet ? '' : ', longer if the pool trades meanwhile' };
}
