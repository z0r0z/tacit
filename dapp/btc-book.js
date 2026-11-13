
export const DUST = 546;
export const MOVE_SATS_FLAT = 5000;
export async function moveSatsNeeded(feeRate) {
  let rate = 0;
  try { rate = Number(await feeRate()); } catch {}
  if (!(rate > 0)) return MOVE_SATS_FLAT;
  const fee = (vb) => Math.max(500, Math.ceil(vb * rate * 1.5));
  return Math.ceil((DUST + fee(153) + fee(435)) / 500) * 500;
}
export const STALE_INTENT_SEC = 12 * 3600;
export const EXPIRY_GUARD_SEC = 60;
export const BID_CLAIM_WINDOW_SEC = 1800 + 120;
export const FEE_EST_TAKE_SATS = 800;
export const FEE_EST_BATCH_EXTRA_SATS = 250;
export const FEE_EST_SELL_SATS = 1600;

const toBig = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
const pow10 = (d) => 10n ** BigInt(d);

export function unitPrice(priceSats, amountBase, decimals) {
  const p = Number(priceSats);
  const a = toBig(amountBase);
  if (!Number.isFinite(p) || p <= 0 || a <= 0n) return null;
  return (p * Math.pow(10, decimals)) / Number(a);
}

export function scaledSats(fillBase, priceSats, fullBase) {
  const full = toBig(fullBase);
  if (full <= 0n) return 0;
  return Number((toBig(fillBase) * toBig(priceSats)) / full);
}

export function amountForSats(sats, unit, decimals) {
  if (!(unit > 0) || !(sats > 0)) return 0n;
  const scaledUnit = BigInt(Math.max(1, Math.round(unit * 1e8)));
  return (BigInt(Math.floor(sats)) * pow10(decimals) * 100_000_000n) / scaledUnit;
}

export function satsForAmount(amountBase, unit, decimals) {
  if (!(unit > 0)) return 0;
  const scaledUnit = BigInt(Math.max(1, Math.round(unit * 1e8)));
  return Number((toBig(amountBase) * scaledUnit) / (pow10(decimals) * 100_000_000n));
}

export function cleanNumber(text) {
  let s = String(text ?? '').trim().replace(/[_\s]/g, '');
  if (/^\d{1,3}(?:\.\d{3})+,\d*$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d*,\d*$/.test(s) && !/^[1-9]\d{0,2},\d{3}$/.test(s)) s = s.replace(',', '.');
  s = s.replace(/,/g, '');
  return /^\d*\.?\d*$/.test(s) && s !== '' && s !== '.' ? s : null;
}
export const parseNumber = (text) => { const s = cleanNumber(text); return s == null ? NaN : Number(s); };

export function parseAmount(text, decimals) {
  const s = cleanNumber(text);
  if (s == null) return null;
  const [w, f = ''] = s.split('.');
  const frac = f.slice(0, decimals).padEnd(decimals, '0');
  const v = BigInt(w || '0') * pow10(decimals) + BigInt(frac || '0');
  return v;
}

const NF = {};
const NF_INT = { format: (v) => (NF.int ||= new Intl.NumberFormat('en-US')).format(v) };
const NF_UNIT = [{ format: (v) => (NF.u0 ||= new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })).format(v) }, { format: (v) => (NF.u1 ||= new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })).format(v) }, { format: (v) => (NF.u2 ||= new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 })).format(v) }];

export function fmtAmount(base, decimals, maxFrac = decimals) {
  const a = toBig(base);
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const div = pow10(decimals);
  let whole = abs / div;
  let frac = abs % div;
  if (maxFrac < decimals) {
    const cut = pow10(decimals - maxFrac);
    frac = frac / cut;
    decimals = maxFrac;
  }
  const fracStr = decimals > 0 ? frac.toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return (neg ? '-' : '') + NF_INT.format(whole) + (fracStr ? '.' + fracStr : '');
}

export function fmtUnit(u) {
  if (u == null || !Number.isFinite(u)) return '—';
  if (u >= 1000) return NF_UNIT[0].format(u);
  if (u >= 10) return NF_UNIT[1].format(u);
  if (u >= 1) return NF_UNIT[2].format(u);
  if (u > 0) return Number(u.toPrecision(3)).toString();
  return '0';
}

export function fmtSats(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return NF_INT.format(Math.round(n));
}

export function normalizeAsks(listings, ctx) {
  const { assetId, decimals, myPubHex = null, myH160 = null, nowSec, varIntents = false } = ctx;
  const taken = ctx.takenIds || new Set();
  const asks = [];
  const excluded = { expired: 0, claimed: 0, stale: 0, otc: 0, disabled: 0, reserved: 0, taken: 0, invalid: 0 };
  for (const l of listings || []) {
    if (!l || (l.asset_id && l.asset_id !== assetId)) continue;
    if (l.kind !== 'preauth' && l.kind !== 'intent') { excluded.otc++; continue; }
    const expiry = Number(l.expiry || 0);
    if (l.expired || expiry <= nowSec + EXPIRY_GUARD_SEC) { excluded.expired++; continue; }
    if (l.kind === 'preauth') {
      const id = 'p:' + l.sale_id;
      if (l._takenPending || taken.has(id)) { excluded.taken++; continue; }
      const amount = toBig(l.asset_opening?.amount);
      const sats = Number(l.min_price_sats || 0);
      const unit = unitPrice(sats, amount, decimals);
      if (unit == null || !Number.isInteger(sats) || sats < DUST) { excluded.invalid++; continue; }
      asks.push({
        id, kind: 'preauth', unit, amount, sats, fullAmount: amount, minTake: null,
        whole: true, instant: true, mine: !!myPubHex && l.seller_pubkey === myPubHex,
        expiry, createdAt: Number(l.created_at || 0), maker: l.seller_pubkey || '', raw: l,
      });
    } else if (l.kind === 'intent') {
      const id = 'i:' + l.intent_id;
      if (l._takenPending || taken.has(id)) { excluded.taken++; continue; }
      const tgt = String(l.intended_buyer_h160 || '').toLowerCase();
      const rcp = String(l.recipient_pubkey || '').toLowerCase();
      const forMe = (tgt && tgt === myH160) || (rcp && rcp === myPubHex);
      if ((tgt || rcp) && !forMe) { excluded.reserved++; continue; }
      const mine = !!myPubHex && l.maker_pubkey === myPubHex;
      if (!mine && (l.claim || l.fulfilment_pending)) { excluded.claimed++; continue; }
      if (!mine && nowSec - Number(l.created_at || 0) > STALE_INTENT_SEC) { excluded.stale++; continue; }
      const fullAmount = toBig(l.amount);
      const sats = Number(l.price_sats || 0);
      const unit = unitPrice(sats, fullAmount, decimals);
      if (unit == null || !Number.isInteger(sats) || sats < DUST) { excluded.invalid++; continue; }
      const variable = l.min_take_amount != null && l.min_take_amount !== '' && l.min_take_amount !== '0';
      if (variable && !varIntents) { excluded.disabled++; continue; }
      const amount = variable ? toBig(l.remaining_amount ?? l.amount) : fullAmount;
      if (amount <= 0n) { excluded.invalid++; continue; }
      asks.push({
        id, kind: variable ? 'intent-var' : 'intent', unit, amount,
        sats: variable ? scaledSats(amount, sats, fullAmount) : sats,
        fullAmount, fullSats: sats, minTake: variable ? toBig(l.min_take_amount) : null,
        whole: !variable, instant: false, mine,
        expiry, createdAt: Number(l.created_at || 0), maker: l.maker_pubkey || '', raw: l,
      });
    }
  }
  asks.sort(compareAsks);
  return { asks, excluded };
}

export function compareAsks(a, b) {
  if (a.unit !== b.unit) return a.unit - b.unit;
  if (a.instant !== b.instant) return a.instant ? -1 : 1;
  return a.createdAt - b.createdAt;
}

export function normalizeBids(bids, ctx) {
  const { decimals, myPubHex = null, nowSec } = ctx;
  const autoIds = ctx.autoBidIds || new Set();
  const out = [];
  const excluded = { expired: 0, closed: 0, claimed: 0, invalid: 0 };
  for (const b of bids || []) {
    if (!b || !b.bid_id) continue;
    const expiry = Number(b.expiry || 0);
    if (expiry <= nowSec + EXPIRY_GUARD_SEC) { excluded.expired++; continue; }
    const mine = !!myPubHex && b.buyer_pubkey === myPubHex;
    if (!mine && expiry <= nowSec + BID_CLAIM_WINDOW_SEC) { excluded.expired++; continue; }
    const fullAmount = toBig(b.amount);
    const priceSats = Number(b.price_sats || 0);
    const unit = unitPrice(priceSats, fullAmount, decimals);
    if (unit == null || !Number.isInteger(priceSats)) { excluded.invalid++; continue; }
    const variable = b.min_fill_amount != null && b.min_fill_amount !== '' && b.min_fill_amount !== '0';
    let amount = fullAmount;
    let minFill = fullAmount;
    if (variable) {
      amount = toBig(b.remaining_amount ?? b.amount);
      minFill = toBig(b.min_fill_amount);
      if (!mine && String(b.state || '').toUpperCase() === 'CLOSED') { excluded.closed++; continue; }
      if (!mine && amount < minFill) { excluded.closed++; continue; }
    } else if (!mine && b.claim && Number(b.claim.expires_at || 0) > nowSec) {
      excluded.claimed++; continue;
    }
    if (amount <= 0n) { excluded.closed++; continue; }
    out.push({
      id: 'b:' + b.bid_id, kind: variable ? 'bid-var' : 'bid', unit, amount, minFill, fullAmount, priceSats,
      sats: scaledSats(amount, priceSats, fullAmount),
      mine, auto: !!b.watchtower || autoIds.has(b.bid_id),
      expiry, createdAt: Number(b.created_at || 0), raw: b,
    });
  }
  out.sort(compareBids);
  return { bids: out, excluded };
}

export function compareBids(a, b) {
  if (a.unit !== b.unit) return b.unit - a.unit;
  if (a.auto !== b.auto) return a.auto ? -1 : 1;
  return a.createdAt - b.createdAt;
}

export function buildBook(input) {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const ctx = { ...input, nowSec };
  const { asks, excluded: askEx } = normalizeAsks(input.listings, ctx);
  const { bids, excluded: bidEx } = normalizeBids(input.bids, ctx);
  const bestAsk = asks.length ? asks[0].unit : null;
  const bestBid = bids.length ? bids[0].unit : null;
  const mid = bestAsk != null && bestBid != null ? (bestAsk + bestBid) / 2 : null;
  return {
    assetId: input.assetId, decimals: input.decimals, nowSec,
    asks, bids, bestAsk, bestBid, mid,
    spread: bestAsk != null && bestBid != null ? bestAsk - bestBid : null,
    overlap: bestAsk != null && bestBid != null && bestBid > bestAsk,
    excluded: { asks: askEx, bids: bidEx },
  };
}

export function ladderLevels(rows, side) {
  const out = [];
  const byKey = new Map();
  for (const r of rows) {
    const flag = side === 'ask'
      ? (r.mine ? 'mine' : r.instant ? (r.whole ? 'lot' : 'part') : 'maker')
      : (r.mine ? 'mine' : r.auto ? 'auto' : 'manual');
    const key = fmtUnit(r.unit) + '|' + flag;
    let lvl = byKey.get(key);
    if (!lvl) {
      lvl = { key, unit: r.unit, flag, amount: 0n, sats: 0, count: 0, rows: [] };
      byKey.set(key, lvl);
      out.push(lvl);
    }
    lvl.amount += r.amount;
    lvl.sats += r.sats;
    lvl.count++;
    lvl.rows.push(r);
  }
  return out;
}

export function planBuy(book, { spendSats = null, receiveBase = null, maxUnit = Infinity, maxBase = null, includeIntents = true, excludeIds = null } = {}) {
  const dec = book.decimals;
  const skip = excludeIds || new Set();
  const cands = book.asks.filter((a) => !a.mine && !skip.has(a.id) && a.unit <= maxUnit && (includeIntents || a.instant));
  const fills = [];
  const skipped = [];
  let sats = 0;
  let amount = 0n;
  if (spendSats != null) {
    const budget = Math.floor(spendSats);
    for (const a of cands) {
      const room = budget - sats;
      if (room < DUST) break;
      const cap = maxBase != null ? BigInt(maxBase) - amount : null;
      if (cap != null && cap <= 0n) break;
      if (a.whole) {
        if (a.sats > room || (cap != null && a.amount > cap)) { skipped.push({ ask: a, reason: 'too-big' }); continue; }
        fills.push({ ask: a, amount: a.amount, sats: a.sats, unit: a.unit });
        sats += a.sats; amount += a.amount;
      } else {
        let want = (BigInt(room) * a.fullAmount) / BigInt(a.fullSats);
        if (want > a.amount) want = a.amount;
        if (cap != null && want > cap) want = cap;
        if (want < a.minTake) { skipped.push({ ask: a, reason: 'too-small' }); continue; }
        const s = scaledSats(want, a.fullSats, a.fullAmount);
        if (s < DUST || s > room) { skipped.push({ ask: a, reason: 'too-small' }); continue; }
        fills.push({ ask: a, amount: want, sats: s, unit: a.unit });
        sats += s; amount += want;
      }
    }
  } else if (receiveBase != null) {
    const target = BigInt(receiveBase);
    for (const a of cands) {
      const need = target - amount;
      if (need <= 0n) break;
      if (a.whole) {
        if (a.amount > need * 2n && a.amount - need > need) { skipped.push({ ask: a, reason: 'too-big' }); continue; }
        fills.push({ ask: a, amount: a.amount, sats: a.sats, unit: a.unit });
        sats += a.sats; amount += a.amount;
      } else {
        let want = need < a.amount ? need : a.amount;
        if (want < a.minTake) want = a.minTake <= a.amount ? a.minTake : 0n;
        if (want <= 0n) { skipped.push({ ask: a, reason: 'too-small' }); continue; }
        const s = scaledSats(want, a.fullSats, a.fullAmount);
        if (s < DUST) { skipped.push({ ask: a, reason: 'too-small' }); continue; }
        fills.push({ ask: a, amount: want, sats: s, unit: a.unit });
        sats += s; amount += want;
      }
    }
  } else {
    throw new Error('planBuy needs spendSats or receiveBase');
  }
  const aboveMax = book.asks.filter((a) => !a.mine && !skip.has(a.id) && a.unit > maxUnit).length;
  const preauthFills = fills.filter((f) => f.ask.kind === 'preauth').length;
  const intentFills = fills.length - preauthFills;
  const feesEst = (preauthFills > 1 ? FEE_EST_TAKE_SATS + FEE_EST_BATCH_EXTRA_SATS * (preauthFills - 1) : preauthFills * FEE_EST_TAKE_SATS)
    + intentFills * FEE_EST_TAKE_SATS;
  return {
    side: 'buy',
    mode: spendSats != null ? 'spend' : 'receive',
    fills, amount, sats,
    avgUnit: amount > 0n ? (sats * Math.pow(10, dec)) / Number(amount) : null,
    worstUnit: fills.reduce((m, f) => Math.max(m, f.unit), 0) || null,
    leftoverSats: spendSats != null ? Math.max(0, Math.floor(spendSats) - sats) : 0,
    shortBase: receiveBase != null && amount < BigInt(receiveBase) ? BigInt(receiveBase) - amount : 0n,
    overBase: receiveBase != null && amount > BigInt(receiveBase) ? amount - BigInt(receiveBase) : 0n,
    skipped, aboveMax, feesEst,
    needsMaker: intentFills > 0,
  };
}

export function planSell(book, { sellBase, minUnit = 0, includeManual = false, excludeIds = null } = {}) {
  const dec = book.decimals;
  const skip = excludeIds || new Set();
  const target = BigInt(sellBase);
  const cands = book.bids.filter((b) => !b.mine && !skip.has(b.id) && b.unit >= minUnit && (includeManual || b.auto));
  const fills = [];
  const skipped = [];
  let sats = 0;
  let amount = 0n;
  for (const b of cands) {
    const left = target - amount;
    if (left <= 0n) break;
    let fill;
    if (b.kind === 'bid') {
      if (b.amount > left) { skipped.push({ bid: b, reason: 'too-big' }); continue; }
      fill = b.amount;
    } else {
      fill = left < b.amount ? left : b.amount;
      if (fill < b.minFill) { skipped.push({ bid: b, reason: 'too-small' }); continue; }
    }
    const s = scaledSats(fill, b.priceSats, b.fullAmount);
    if (s < DUST) { skipped.push({ bid: b, reason: 'too-small' }); continue; }
    fills.push({ bid: b, amount: fill, sats: s, unit: b.unit });
    sats += s; amount += fill;
  }
  const manualAvailable = book.bids.filter((b) => !b.mine && !b.auto && !skip.has(b.id) && b.unit >= minUnit).length;
  return {
    side: 'sell',
    fills, amount, sats,
    avgUnit: amount > 0n ? (sats * Math.pow(10, dec)) / Number(amount) : null,
    worstUnit: fills.length ? fills.reduce((m, f) => Math.min(m, f.unit), Infinity) : null,
    leftoverBase: target > amount ? target - amount : 0n,
    skipped, manualAvailable: includeManual ? 0 : manualAvailable,
    feesEst: fills.length * FEE_EST_SELL_SATS,
    needsBidder: fills.some((f) => !f.bid.auto),
  };
}

export function withinBounds(plan, bounds) {
  if (!plan || !plan.fills.length) return false;
  if (plan.side === 'buy') {
    if (plan.sats > bounds.maxSats) return false;
    return plan.fills.every((f) => f.unit <= bounds.maxUnit * (1 + 1e-9));
  }
  if (plan.amount > bounds.maxBase) return false;
  return plan.fills.every((f) => f.unit >= bounds.minUnit * (1 - 1e-9));
}

export function limitCrossesBook(book, side, unit) {
  if (!(unit > 0)) return false;
  if (side === 'buy') return book.bestAsk != null && unit >= book.bestAsk;
  return book.bestBid != null && unit <= book.bestBid;
}

export function listingShape(amountBase, unit, decimals) {
  const amt = BigInt(amountBase);
  const totalSats = satsForAmount(amt, unit, decimals);
  if (amt <= 0n || totalSats < DUST) return { k: 0, totalSats, listedBase: 0n };
  for (let k = 7; k >= 2; k--) {
    const perLotBase = amt / BigInt(k);
    const perLotSats = satsForAmount(perLotBase, unit, decimals);
    if (perLotBase <= 0n || perLotSats < DUST * 2) continue;
    return { k, perLotBase, perLotSats, listedBase: perLotBase * BigInt(k), totalSats: perLotSats * k };
  }
  return { k: 1, perLotBase: amt, perLotSats: totalSats, listedBase: amt, totalSats };
}
