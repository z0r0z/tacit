// The market behind the pool: what TAC trades at on the Bitcoin orderbook, the asks standing on that book,
// and the state of the TAC/ETH precision pool and its farm on Ethereum.
//
// Two very different sources. The Bitcoin side comes from the worker, which stamps a trade-derived price
// series onto /market. The Ethereum side is read straight from the chain; nothing indexes its history, so
// that half is a snapshot rather than a chart, and says so instead of drawing a line through one point.

const WORKER = 'https://api.tacit.finance';
const ASSET = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';

// Confirmed canonical with the team that owns them. TacBuyback hard-codes this pool, so it is not to be
// swapped for another venue. token0 is ETH as address(0); token1 is TAC.
const POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E';
const FARM = '0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0';
const SEL = { reserve0: '443cb4bc', reserve1: '5a76f25e', totalSupply: '18160ddd', totalStaked: '817b1cd2', rewardRate: '7b0a47ee', periodFinish: 'ebe2b12b' };
const RPCS = ['https://cloudflare-eth.com', 'https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'];

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...kids.filter((x) => x != null).map((x) => (typeof x === 'string' ? document.createTextNode(x) : x)));
  return n;
};
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  return n;
};
const num = (v, d = 2) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d });
const pct = (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;

async function ethCall(to, data) {
  let lastErr;
  for (const rpc of RPCS) {
    try {
      const r = await fetch(rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data: '0x' + data }, 'latest'] }),
      });
      const j = await r.json();
      if (j?.result && j.result !== '0x') return BigInt(j.result);
      lastErr = new Error(j?.error?.message || 'empty result');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no RPC answered');
}

async function loadBitcoinMarket() {
  const r = await fetch(`${WORKER}/market?network=mainnet`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`market: HTTP ${r.status}`);
  const j = await r.json();
  const row = (j.assets || []).find((a) => String(a.asset_id).toLowerCase() === ASSET);
  if (!row) throw new Error('TAC is not on the market feed');
  return row;
}

async function loadAsks() {
  const r = await fetch(`${WORKER}/assets/${ASSET}/preauth-sales?network=mainnet`, { cache: 'no-store' });
  if (!r.ok) return null;
  const j = await r.json();
  return Array.isArray(j.sales) ? j.sales : [];
}

async function loadPrecision() {
  const [r0, r1, supply, staked, rate, finish] = await Promise.all([
    ethCall(POOL, SEL.reserve0), ethCall(POOL, SEL.reserve1), ethCall(POOL, SEL.totalSupply),
    ethCall(FARM, SEL.totalStaked), ethCall(FARM, SEL.rewardRate), ethCall(FARM, SEL.periodFinish),
  ]);
  return { r0, r1, supply, staked, rate, finish: Number(finish) };
}

// A line through the worker's trade-derived series. Few points and uneven spacing are normal here, so the
// marks are drawn as well as the line — a smooth curve through ten trades would imply data that isn't there.
function priceChart(series, { w = 660, h = 132, pad = 4 } = {}) {
  const pts = [...series].sort((a, b) => a.ts - b.ts).filter((p) => Number.isFinite(p.u) && p.u > 0);
  if (pts.length < 2) return el('p', { class: 'note' }, 'Not enough trades yet to draw a line.');
  const xs = pts.map((p) => p.ts), ys = pts.map((p) => p.u);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const span = hi - lo || hi || 1;
  const X = (t) => pad + ((t - x0) / (x1 - x0 || 1)) * (w - pad * 2);
  const Y = (u) => pad + (1 - (u - lo) / span) * (h - pad * 2);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.ts).toFixed(1)},${Y(p.u).toFixed(1)}`).join(' ');
  const area = `${line} L${X(x1).toFixed(1)},${h - pad} L${X(x0).toFixed(1)},${h - pad} Z`;
  const up = ys[ys.length - 1] >= ys[0];
  const stroke = up ? 'var(--ok)' : 'var(--err)';

  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', class: 'chart', role: 'img', 'aria-label': `TAC price, ${num(lo)} to ${num(hi)} sats` });
  const grad = svgEl('linearGradient', { id: 'tacfill', x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(svgEl('stop', { offset: '0', 'stop-color': stroke, 'stop-opacity': '.20' }),
              svgEl('stop', { offset: '1', 'stop-color': stroke, 'stop-opacity': '0' }));
  const defs = svgEl('defs'); defs.append(grad); svg.append(defs);
  svg.append(svgEl('path', { d: area, fill: 'url(#tacfill)', stroke: 'none' }));
  svg.append(svgEl('path', { d: line, fill: 'none', stroke, 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
  for (const p of pts) svg.append(svgEl('circle', { cx: X(p.ts).toFixed(1), cy: Y(p.u).toFixed(1), r: '2', fill: stroke, 'vector-effect': 'non-scaling-stroke' }));
  return svg;
}

// The asks actually standing on the book, cheapest first. These are what a buyer can take right now; with `onBuy`, each
// row has a button that buys it.
function askDepth(sales, decimals = 8, mark = null, onBuy = null) {
  // The listing carries its size in its opening, and the feed keeps sales past their expiry — an expired
  // one is not takeable, so counting it would overstate the book.
  const now = Math.floor(Date.now() / 1000);
  const live = sales.filter((s) => !s.expired && Number(s.expiry || 0) > now);
  const rows = live
    .map((s) => {
      const d = Number.isInteger(s.decimals) ? s.decimals : decimals;
      const units = Number(s.asset_opening?.amount ?? 0) / 10 ** d;
      const sats = Number(s.min_price_sats ?? 0);
      return units > 0 && sats > 0 ? { units, sats, unit: sats / units, sale: s } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.unit - b.unit);
  if (!rows.length) {
    return el('p', { class: 'note' }, sales.length
      ? `All ${sales.length} listings on the book have expired.`
      : 'No asks standing on the book right now.');
  }
  // One listing priced hundreds of times over the market would otherwise dominate any total and read as
  // depth that is not really there, so the aggregate covers asks near the market and the rest is counted
  // separately rather than dropped silently.
  const band = mark ? mark * 5 : Infinity;
  const near = rows.filter((r) => r.unit <= band);
  const far = rows.length - near.length;
  const shown = near.length ? near : rows;
  const best = shown[0];
  const totalTac = shown.reduce((t, r) => t + r.units, 0);
  const totalSats = shown.reduce((t, r) => t + r.sats, 0);
  const max = Math.max(...shown.map((r) => r.units));

  const list = el('div', { class: 'depth' });
  for (const r of shown.slice(0, 8)) {
    // An ask far over the market is shown, not offered: one press from paying many times what TAC trades at.
    const buy = onBuy && r.sale?.sale_id && r.unit <= band ? el('button', { class: 'buy', type: 'button' }, 'Buy') : null;
    if (buy) buy.onclick = () => onBuy(r, buy, list);
    list.append(el('div', { class: `dep${buy ? ' buyable' : ''}` },
      el('span', { class: 'bar', style: `width:${Math.max(4, (r.units / max) * 100)}%` }),
      el('b', { class: 'num' }, `${num(r.unit, 1)}`),
      el('span', { class: 'num' }, `${num(r.units, 0)} TAC`),
      el('span', { class: 'num mute' }, `${num(r.sats, 0)} sats`),
      buy));
  }
  return el('div', {},
    el('div', { class: 'kv' }, el('span', {}, 'Best ask'), el('b', { class: 'num' }, `${num(best.unit, 1)} sats / TAC`)),
    el('div', { class: 'kv' }, el('span', {}, `${shown.length} ask${shown.length === 1 ? '' : 's'} near the market`), el('b', { class: 'num' }, `${num(totalTac, 0)} TAC for ${num(totalSats, 0)} sats`)),
    el('div', { class: 'kv' }, el('span', {}, 'Highest of those'), el('b', { class: 'num' }, `${num(shown[shown.length - 1].unit, 1)} sats / TAC`)),
    list,
    shown.length > 8 ? el('p', { class: 'note' }, `Showing the 8 cheapest of ${shown.length}.`) : null,
    far ? el('p', { class: 'note' }, `${far} further ask${far === 1 ? '' : 's'} priced above ${num(band, 0)} sats — far over the market, and left out of the total.`) : null);
}

// ── buying with sats ──
// An ask is bought whole, from this key's own Bitcoin address, in two transactions: a commit, then the reveal that hands
// the TAC over. tacit.js takes it as the classic order book does: it checks the seller's listing on chain before any sats
// move, and records the commit before sending it, so sats it locks can be recovered should another buyer get there first.
const STAGE = { 'fetch-start': 'Checking the listing on chain…', 'commit-start': 'Sending the commit…', 'wait-visible': 'Waiting for the commit to show…', 'broadcast-start': 'Sending the reveal that hands the TAC over…' };
// Sats at this key's Bitcoin address a purchase can spend: the take's own picker, which leaves out outputs that carry an
// asset or a cBTC lock, and refuses to guess when it cannot tell them apart.
async function freeSats(T) {
  const addr = T.wallet.address();
  const safe = await T.pickSafeCommitSats(await T.getUtxos(addr));
  return { addr, sats: safe.reduce((t, u) => t + Number(u.value || 0), 0) };
}
// What the buyer was last told, kept across a re-read of the book so the result of a purchase is not wiped with it.
let notice = null;
// How a failed purchase reads, from the message tacit.js's takePreauthSale throws. Sats a commit locked come first: they
// are the one case where something was sent, and the same message can also say "insufficient sats" (for the reveal).
export function buyFailure(message) {
  const said = String(message || '');
  if (/locked at|recovery record/i.test(said)) return 'locked';
  if (/insufficient sats for commit/i.test(said)) return 'short';
  return 'other';
}
function buyer(host, ctx, mark) {
  if (!ctx.ensureKey || !ctx.turn) return null;
  const st = 'st-market', fund = el('div', { class: 'fund' });
  let pending = null, rate = null, shown = null, seq = 0;
  const paintFund = async () => {
    const mine = ++seq;                                          // a read for an earlier wallet state never paints over a later one
    if (!ctx.unlocked?.()) {
      shown = null;
      const open = el('button', { class: 'link', type: 'button' }, 'Open your wallet');
      open.onclick = () => ctx.busy(open, st, async () => { await ctx.ensureKey(); await paintFund(); });
      fund.replaceChildren(el('p', { class: 'note' }, 'Buying takes sats from your Tacit wallet’s Bitcoin address. ', open, ' to buy.'));
      return;
    }
    fund.replaceChildren(el('p', { class: 'note' }, 'Reading your Bitcoin address…'));
    try {
      const T = ctx.T, f = await freeSats(T);
      if (mine !== seq) return;
      shown = f.addr;
      const copy = el('button', { class: 'link', type: 'button' }, 'copy');
      copy.onclick = () => navigator.clipboard?.writeText(f.addr).then(() => { copy.textContent = 'copied'; }).catch(() => {});
      fund.replaceChildren(
        el('div', { class: 'kv' }, el('span', {}, 'Pay from'), el('b', { class: 'num' }, `${f.addr.slice(0, 10)}…${f.addr.slice(-6)} `, copy)),
        el('div', { class: 'kv' }, el('span', {}, 'Sats there'), el('b', { class: 'num' }, `${num(f.sats, 0)} sats`)),
        f.sats ? null : el('p', { class: 'note' }, 'Send sats to that address from any Bitcoin wallet, then buy.'));
    } catch (e) { if (mine === seq) { shown = null; fund.replaceChildren(el('p', { class: 'note err' }, `Could not read your Bitcoin address: ${e?.message || e}`)); } }
  };
  // The first press says what it costs; a second press on the same ask pays.
  const ask = (r) => {
    const vs = mark ? ` (${num(Math.abs((r.unit / mark - 1) * 100), 0)}% ${r.unit >= mark ? 'above' : 'below'} the recent trade price of ${num(mark, 0)})` : '';
    ctx.say(st, `Buy ${num(r.units, 2)} TAC for ${num(r.sats, 0)} sats, ${num(r.unit, 1)} sats per TAC${vs}, plus the fees for two Bitcoin transactions${rate ? `, at about ${rate} sat/vB` : ''}. Press Confirm to pay.`);
  };
  const onBuy = (r, btn, list) => {
    notice = null;
    if (pending !== r) {
      pending = r;
      for (const b of list.querySelectorAll('.buy')) b.textContent = 'Buy';
      btn.textContent = 'Confirm';
      ask(r);
      ctx.T?.getFeeRate?.().then((x) => { if (Number.isFinite(Number(x))) { rate = Math.ceil(Number(x)); if (pending === r) ask(r); } }).catch(() => {});
      return;
    }
    pending = null;
    btn.textContent = 'Buy';
    return ctx.busy(btn, st, async () => {
      await ctx.ensureKey();
      // What was shown must be what pays: if the open key is not the address above, say so and show the new one.
      if (!shown || ctx.T.wallet.address() !== shown) { await paintFund(); throw new Error('The wallet changed since the address above was read. Check it, then press Buy again.'); }
      try {
        const res = await ctx.turn(() => ctx.T.takePreauthSale({ assetIdHex: ASSET, saleIdHex: r.sale.sale_id, sale: r.sale, onProgress: (s) => ctx.say(st, STAGE[s] || 'Working…') }));
        notice = () => [el('span', { class: 'ok' }, `Bought ${num(r.units, 2)} TAC.`), ' ', ctx.txLink(res.reveal_txid)];
        ctx.say(st, ...notice());
        ctx.refresh?.();
        setTimeout(() => mount(host, ctx), 2000);                  // that ask has left the book; the result stays
      } catch (e) {
        const kind = buyFailure(e?.message);
        if (kind === 'locked') {
          ctx.errSay(st, e);
          document.getElementById(st)?.append(' ', el('a', { href: '/classic.html#tab=holdings' }, 'Recover the locked sats in the classic app →'));
          return;
        }
        if (kind === 'short') throw new Error(`Your Bitcoin address has too few sats for this ask: it costs ${num(r.sats, 0)} sats, plus the fees for two transactions. Nothing was sent.`);
        throw e;
      }
    });
  };
  paintFund();
  if (host.__fund) window.removeEventListener('tac:wallet', host.__fund);      // a re-read of the book replaces the last listener
  host.__fund = paintFund;
  window.addEventListener('tac:wallet', paintFund);
  return { fund, onBuy, status: el('div', { class: 'status', id: st, role: 'status' }, ...(notice ? notice() : [])) };
}

export async function mount(host, ctx = {}) {
  const wrap = el('div');
  host.replaceChildren(el('p', { class: 'note', style: 'margin-top:0' }, 'Loading the market…'));

  let row, sales;
  try { [row, sales] = await Promise.all([loadBitcoinMarket(), loadAsks()]); }
  catch (e) { host.replaceChildren(el('p', { class: 'note err' }, `Could not load the market: ${e?.message || e}`)); return; }

  const mark = Number(row?.mark_price?.unit) || null;
  const chg = Number(row.price_24h_change_pct);
  const buy = buyer(host, ctx, mark);
  wrap.append(
    el('p', { class: 'eyebrow' }, 'TAC on the Bitcoin orderbook'),
    el('div', { class: 'bal' },
      el('div', {},
        el('div', { class: 'uu' }, el('span', { class: 'v num' }, mark == null ? '—' : num(mark, 2)), el('span', { class: 'u' }, 'sats / TAC')),
        el('div', { class: 'fiat' }, Number.isFinite(chg) ? el('span', { class: chg >= 0 ? 'ok' : 'err' }, `${pct(chg)} · 24h`) : '')),
      el('div', { class: 'side' }, 'traded, 24h', el('b', { class: 'num' }, `${num(row.volume_24h_sats || 0, 0)} sats`))),
    priceChart(row.price_summary || []),
    el('div', { class: 'chips' }, ...[['1h', row.price_1h_change_pct], ['4h', row.price_4h_change_pct], ['24h', row.price_24h_change_pct], ['7d', row.price_7d_change_pct], ['all', row.price_all_change_pct]]
      .filter(([, v]) => Number.isFinite(Number(v)))
      .map(([k, v]) => el('span', { class: 'chipx' }, el('i', {}, k), el('b', { class: Number(v) >= 0 ? 'ok' : 'err' }, pct(v))))),
    el('p', { class: 'note' }, `Price comes from real trades on the book, not a quote. ${(row.price_summary || []).length} points, holders ${num(row.holder_count || 0, 0)}.`),
    el('p', { class: 'eyebrow', style: 'margin-top:22px' }, 'Asks on the book'),
    ...(buy ? [buy.fund] : []),
    sales ? askDepth(sales, Number(row.decimals) || 8, mark, buy?.onBuy) : el('p', { class: 'note' }, 'Could not read the book.'),
    ...(buy ? [buy.status] : []),
    el('p', { class: 'eyebrow', style: 'margin-top:22px' }, 'TAC / ETH precision pool'),
    el('div', { id: 'prec-body' }, el('p', { class: 'note' }, 'Reading Ethereum…')),
  );
  host.replaceChildren(wrap);

  // Ethereum side. Nothing indexes this pool's history, so this is deliberately a snapshot.
  try {
    const p = await loadPrecision();
    const eth = Number(p.r0) / 1e18, tac = Number(p.r1) / 1e18;
    const tacPerEth = tac / (eth || 1);
    const staked = Number(p.staked) / 1e18, supply = Number(p.supply) / 1e18;
    const perDay = (Number(p.rate) / 1e18) * 86400;
    const ended = p.finish * 1000 < Date.now();
    const days = Math.max(0, Math.round((p.finish * 1000 - Date.now()) / 86400000));
    // Reward is TAC, stake is LP; value both in TAC via the pool's own reserves.
    const tacPerLp = supply > 0 ? (tac * 2) / supply : 0;
    const stakedTac = staked * tacPerLp;
    const apr = stakedTac > 0 ? ((perDay * 365) / stakedTac) * 100 : null;
    document.getElementById('prec-body').replaceChildren(
      el('div', { class: 'kv' }, el('span', {}, 'Pool'), el('b', { class: 'num' }, `${num(eth, 3)} ETH · ${num(tac, 0)} TAC`)),
      el('div', { class: 'kv' }, el('span', {}, 'Rate'), el('b', { class: 'num' }, `${num(tacPerEth, 0)} TAC / ETH`)),
      el('div', { class: 'kv' }, el('span', {}, 'Staked in the farm'), el('b', { class: 'num' }, `${num((staked / (supply || 1)) * 100, 1)}% of LP`)),
      el('div', { class: 'kv' }, el('span', {}, 'Streaming'), el('b', { class: 'num' }, ended ? 'ended' : `${num(perDay, 0)} TAC / day`)),
      el('div', { class: 'kv' }, el('span', {}, ended ? 'Ended' : 'Runs for'), el('b', { class: 'num' }, ended ? new Date(p.finish * 1000).toISOString().slice(0, 10) : `${days} more days`)),
      apr != null && !ended ? el('div', { class: 'kv' }, el('span', {}, 'Rewards vs staked value'), el('b', { class: 'num' }, `≈ ${num(apr, 0)}% a year`)) : null,
      el('p', { class: 'note' }, ended
        ? 'The stream has ended: withdrawing and claiming still work, but a new stake earns nothing until it is refunded.'
        : 'That rate moves sharply as stake joins or leaves — it is a snapshot, not a promise. Nothing indexes this pool over time, so there is no line to draw here yet.'),
      el('p', { class: 'note' }, 'A one-sided deposit into a pool this thin moves the price against itself. Add both sides when you hold both.'),
    );
  } catch (e) {
    document.getElementById('prec-body').replaceChildren(el('p', { class: 'note err' }, `Could not read the pool: ${e?.message || e}`));
  }
}
