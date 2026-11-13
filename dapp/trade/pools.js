// The Ethereum pools TAC trades in, read as an order book. Each pool is a constant product on its reserves (the Precision pool on the larger ones its
// price range stands for), so what it sells up to a price, or takes down to one, follows from two numbers and its fee. Added up at each price that is
// what the best split between the pools does, since a split leaves every pool at one price. No DOM and no network: a node test can feed it reserves.
//
// A pool here is { name, x, y, fee, capX, capY }: the ETH and TAC its curve runs on, the fee kept from what is paid in (a fraction), and the ETH and
// TAC it really holds (it cannot pay out more). Prices are ETH per TAC with the fee in them: what a buyer pays or a seller gets for the next TAC.

const num = (v, dec) => Number(v) / 10 ** dec;

// The Precision pool: liquidity between two prices, like one position. `sqrt`, `low` and `high` are square roots of TAC per ETH (1e18-scaled), and
// the reserves are what it holds now. Outside its range it holds one token only and is left out.
export function precisionPool({ sqrt, low, high, reserve0, reserve1, feePpm = 3000 }) {
  const s = num(sqrt, 18), lo = num(low, 18), hi = num(high, 18), x = num(reserve0, 18), y = num(reserve1, 18);
  if (!(s > lo && s < hi && x > 0 && y > 0)) return null;
  // either reserve gives the liquidity; fees not yet folded in leave them a hair apart, and the smaller is the one the pool quotes on
  const L = Math.min(y / (s - lo), x / (1 / s - 1 / hi));
  return { name: 'precision', x: L / s, y: L * s, fee: Number(feePpm) / 1e6, capX: x, capY: y };
}
// The Tacit pool: a plain constant product on what it holds (reserves in the pool's own 8-decimal units, fee in hundredths of a percent).
export function tacitPool({ rEth, rTac, feeBps }) {
  const x = num(rEth, 8), y = num(rTac, 8);
  return x > 0 && y > 0 ? { name: 'tacit', x, y, fee: Number(feeBps) / 1e4, capX: x, capY: y } : null;
}

export const askOf = (p) => p.x / (p.y * (1 - p.fee));
export const bidOf = (p) => ((1 - p.fee) * p.x) / p.y;

// What one pool sells for ETH before its price for the next TAC passes `price`, and what that costs.
export function buyTo(p, price) {
  const k = p.x * p.y;
  let x1 = Math.sqrt(price * k * (1 - p.fee));
  if (!(x1 > p.x)) return { tac: 0, eth: 0 };
  if (p.y - k / x1 > p.capY) x1 = k / (p.y - p.capY);
  return { tac: p.y - k / x1, eth: (x1 - p.x) / (1 - p.fee) };
}
// What one pool takes before what it pays for the next TAC falls under `price`, and the ETH it pays for that.
export function sellTo(p, price) {
  const k = p.x * p.y;
  let y1 = Math.sqrt(((1 - p.fee) * k) / price);
  if (!(y1 > p.y)) return { tac: 0, eth: 0 };
  if (p.x - k / y1 > p.capX) y1 = k / (p.x - p.capX);
  return { tac: (y1 - p.y) / (1 - p.fee), eth: p.x - k / y1 };
}

// The steps a ladder is cut at, as shares of the best price; the chart's are finer and run as far as it shows.
export const LADDER_STEPS = [0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5];
export const CHART_STEPS = Array.from({ length: 60 }, (_, i) => (i + 1) / 100);

// The pools as a book: `ask` and `bid` are the best prices now, and each level holds everything from the best price to its own ({ step, price, tac,
// eth }, running totals), asks climbing and bids falling. A level no pool reaches is left out; bids stop where the price would reach nothing.
export function poolBook(pools, steps = LADDER_STEPS) {
  const live = pools.filter(Boolean);
  if (!live.length) return null;
  const ask = Math.min(...live.map(askOf)), bid = Math.max(...live.map(bidOf));
  const side = (to, ref, sign) => steps.filter((s) => sign > 0 || s < 1).map((step) => {
    const price = ref * (1 + sign * step), parts = live.map((p) => to(p, price));
    return { step, price, tac: parts.reduce((a, b) => a + b.tac, 0), eth: parts.reduce((a, b) => a + b.eth, 0) };
  }).filter((l) => l.tac > 0 && l.eth > 0);
  return { ask, bid, asks: side(buyTo, ask, 1), bids: side(sellTo, bid, -1) };
}

// Running totals as what each level adds over the one before it, for a chart or bars that add them up again.
export const perLevel = (levels) => levels.map((l, i) => ({ ...l, dTac: l.tac - (levels[i - 1]?.tac || 0), dEth: l.eth - (levels[i - 1]?.eth || 0) }));

// An amount for the ticket from a level's total: cut to four figures, never rounded up past what the level holds.
export function roundDown(n, figures = 4) {
  if (!(n > 0)) return '0';
  const mag = Math.floor(Math.log10(n)), dp = Math.max(0, figures - 1 - mag), f = 10 ** dp;
  return (Math.floor(n * f) / f).toFixed(dp).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
