import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { feeOf } from '../../dapp/fastbridge-price.js';
import { reverseOptions } from './reverse.mjs';
import { makeMemoryStore } from './store.mjs';
import { COIN_MAX, COIN_MIN, TAC, executeFund, exposeOutpoints, fundToken, parseOutpoint, planFund, tacText, viewFetch } from '../../tools/fastbridge-lp-reverse-fund.mjs';

export const ONE_TAC = 10n ** 8n;
export const MAX_NOTE_AMOUNT = (1n << 64n) - 1n;
export const ACTIVE_STATES = new Set(['selected', 'broadcasting', 'moved']);
const DUST = 546;
const asBig = (v) => typeof v === 'bigint' ? v : BigInt(v);
const sum = (xs) => xs.reduce((n, x) => n + asBig(x), 0n);
const errorText = (e) => String((e && e.message) || e).slice(0, 240);
const clampSeconds = (v) => Number.isFinite(Number(v)) ? Math.floor(Number(v)) : 0;

export const outpointId = (o) => `${String(o.txid).toLowerCase()}:${Number(o.vout)}`;
export const journalId = (o) => `n-${String(o.txid).toLowerCase()}-${Number(o.vout)}`;
export const utcDay = (nowSecs) => new Date(clampSeconds(nowSecs) * 1000).toISOString().slice(0, 10);
export const formatTac = (v) => tacText(asBig(v).toString());

export function parseTacAmount(value, name = 'TAC amount') {
  const m = /^(\d{1,15})(?:\.(\d{1,8}))?$/.exec(String(value ?? ''));
  if (!m) throw new Error(`${name} must be a decimal TAC amount with at most 8 decimal places`);
  const n = BigInt(m[1]) * ONE_TAC + BigInt((m[2] || '').padEnd(8, '0'));
  if (n <= 0n) throw new Error(`${name} must be greater than zero`);
  if (n > MAX_NOTE_AMOUNT) throw new Error(`${name} is too large`);
  return n;
}

export function parseBaseAmount(value, name = 'note amount') {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) throw new Error(`${name} must be a positive base-unit decimal string`);
  const n = BigInt(value);
  if (n > MAX_NOTE_AMOUNT) throw new Error(`${name} is too large`);
  return n;
}

const finiteNumber = (value, name, { integer = false, min = 0 } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min) throw new Error(`${name} must be a finite ${integer ? 'integer ' : ''}of at least ${min}`);
  return n;
};

export function parseRebalanceConfig(C, { dryRun = false } = {}) {
  const rb = C && C.reverse && C.reverse.rebalance && typeof C.reverse.rebalance === 'object' ? C.reverse.rebalance : {};
  const configuredMaxStuck = rb.maxStuckTac == null ? null : parseTacAmount(rb.maxStuckTac, 'reverse.rebalance.maxStuckTac');
  const reverseOn = C?.reverse?.enabled === true;
  const baseTermsConfig = C && !reverseOn && dryRun && rb.enabled === true ? { ...C, reverse: { ...C.reverse, enabled: true } } : C;
  const termsConfig = baseTermsConfig && dryRun && rb.enabled === true && configuredMaxStuck == null
    ? { ...baseTermsConfig, reverse: { ...baseTermsConfig.reverse, rebalance: { ...rb, enabled: false } } }
    : baseTermsConfig;
  const reverseOpts = termsConfig ? reverseOptions({ ...termsConfig, policy: termsConfig.policy || {} }) : null;
  const terms = reverseOpts?.quote ? { ...reverseOpts.quote, minProceedsBps: reverseOpts.minProceedsBps } : null;
  const minProceedsBps = reverseOpts?.minProceedsBps ?? null;
  const off = {
    enabled: false, leases: null, maxNoteTac: null, maxDailyTac: null, maxInventoryTac: null, maxStuckTac: null,
    maxFeeRate: null, minSourceConfs: 1, tickSecs: 60, stallSecs: 3600,
    alertSecs: finiteNumber(C?.alertSecs ?? 3600, 'alertSecs', { min: 1 }), terms, minProceedsBps,
  };
  if (rb.enabled !== true) return off;
  if (!reverseOn && !dryRun) throw new Error('reverse.rebalance requires reverse.enabled=true for a live run');
  if (!terms) throw new Error('reverse.rebalance could not read reverse amount terms');
  if (String(C.btcAsset || '').toLowerCase() !== TAC) throw new Error('reverse.rebalance requires the TAC btcAsset');
  if (typeof rb.leases !== 'string' || !rb.leases.trim()) throw new Error('reverse.rebalance.leases must name a JSON lease manifest');
  if (rb.maxStuckTac == null && !dryRun) throw new Error('reverse.rebalance.maxStuckTac must be configured for enabled live rebalance');
  reverseOutputBounds(terms);
  return {
    enabled: true,
    leases: rb.leases.trim(),
    maxNoteTac: parseTacAmount(rb.maxNoteTac, 'reverse.rebalance.maxNoteTac'),
    maxDailyTac: parseTacAmount(rb.maxDailyTac, 'reverse.rebalance.maxDailyTac'),
    maxInventoryTac: parseTacAmount(rb.maxInventoryTac, 'reverse.rebalance.maxInventoryTac'),
    maxStuckTac: configuredMaxStuck,
    maxFeeRate: finiteNumber(rb.maxFeeRate, 'reverse.rebalance.maxFeeRate', { min: Number.MIN_VALUE }),
    minSourceConfs: finiteNumber(rb.minSourceConfs ?? 1, 'reverse.rebalance.minSourceConfs', { integer: true, min: 1 }),
    tickSecs: finiteNumber(rb.tickSecs ?? 60, 'reverse.rebalance.tickSecs', { min: 1 }),
    stallSecs: finiteNumber(rb.stallSecs ?? 3600, 'reverse.rebalance.stallSecs', { min: 1 }),
    alertSecs: off.alertSecs,
    terms, minProceedsBps,
  };
}

const exactKeys = (value, allowed, what) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} must be an object`);
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${what} has unknown field ${extra[0]}`);
};

const manifestOutpoint = (value, what) => {
  exactKeys(value, what === 'lease note' ? ['txid', 'vout', 'amount'] : ['txid', 'vout'], what);
  if (typeof value.txid !== 'string' || !Number.isInteger(value.vout)) throw new Error(`${what} must have a txid and integer vout`);
  return parseOutpoint(`${value.txid}:${value.vout}`, what);
};

export function parseLeaseManifest(value) {
  exactKeys(value, ['version', 'notes', 'feeCoins'], 'lease manifest');
  if (value.version !== 1) throw new Error('lease manifest version must be 1');
  if (!Array.isArray(value.notes) || !Array.isArray(value.feeCoins)) throw new Error('lease manifest notes and feeCoins must be arrays');
  const notes = value.notes.map((n) => {
    const o = manifestOutpoint(n, 'lease note');
    return { ...o, amount: parseBaseAmount(n.amount, `lease note ${outpointId(o)} amount`).toString() };
  });
  const feeCoins = value.feeCoins.map((c) => manifestOutpoint(c, 'lease fee coin'));
  const seen = new Set();
  for (const o of [...notes, ...feeCoins]) {
    const id = outpointId(o);
    if (seen.has(id)) throw new Error(`lease manifest names ${id} more than once or as both a note and fee coin`);
    seen.add(id);
  }
  return { version: 1, notes, feeCoins };
}

export function lineageDecision(verdict) {
  if (!verdict || verdict.state === 'unread') return { ok: false, reason: 'lineage_unread', alert: true };
  if (verdict.state === 'long') return { ok: true, reason: null, class: 'long' };
  if (verdict.state === 'unprovable' && verdict.through === 'shielded') return { ok: true, reason: null, class: 'unprovable_shielded' };
  if (verdict.state === 'unprovable') return { ok: false, reason: `lineage_unprovable_${verdict.through || 'other'}`, alert: false };
  if (verdict.state === 'tracked' || verdict.state === 'traced') return { ok: false, reason: `lineage_${verdict.state}`, alert: false };
  return { ok: false, reason: `lineage_${String(verdict.state || 'unknown').replace(/[^a-z0-9_]/gi, '_')}`, alert: false };
}

export function chainDecision({ tx, outspend, vout, address, tipHeight, minConfs = 1, kind = 'note' }) {
  if (!tx || !Array.isArray(tx.vout)) return { ok: false, reason: 'transaction_unread', alert: true };
  const out = vout == null ? null : tx.vout[vout];
  if (!out) return { ok: false, reason: 'output_missing', alert: true };
  if (out.scriptpubkey_address !== address) return { ok: false, reason: kind === 'note' ? 'wrong_source_address' : 'wrong_fee_coin_address', alert: true };
  if (!outspend || typeof outspend.spent !== 'boolean') return { ok: false, reason: 'spent_state_unread', alert: true };
  if (outspend.spent) return { ok: false, reason: 'spent', alert: false };
  if (!tx.status || tx.status.confirmed !== true) return { ok: false, reason: 'unconfirmed', alert: false };
  if (!Number.isInteger(tx.status.block_height) || !Number.isInteger(tipHeight)) return { ok: false, reason: 'confirmations_unread', alert: true };
  const confirmations = tipHeight - tx.status.block_height + 1;
  if (confirmations < minConfs) return { ok: false, reason: 'insufficient_confirmations', confirmations, alert: false };
  if (!Number.isInteger(out.value) || out.value < 0) return { ok: false, reason: 'output_value_unread', alert: true };
  if (kind === 'note' && out.value > DUST) return { ok: false, reason: 'not_a_note_sized_output', alert: true };
  if (kind === 'coin' && (out.value < COIN_MIN || out.value > COIN_MAX)) return { ok: false, reason: 'fee_coin_out_of_range', alert: true };
  return { ok: true, reason: null, confirmations, value: out.value, address: out.scriptpubkey_address, alert: false };
}

const isPending = (r) => ACTIVE_STATES.has(r.state) || (r.state === 'halted' && r.broadcastAttempted === true);
const swapInputs = (r) => Array.isArray(r?.noteInputs) ? r.noteInputs.map(outpointId) : [];
const swapTime = (r) => Number.isFinite(r?.terminalAt) ? r.terminalAt : Number.isFinite(r?.completedAt) ? r.completedAt : Number.isFinite(r?.updated) ? r.updated : Number.isFinite(r?.created) ? r.created : null;

export function reverseSwapPosition(reverseNotes = [], reverseSwaps = []) {
  const closedInputs = new Set(reverseSwaps.filter((r) => r.phase === 'done' || r.phase === 'refunded').flatMap(swapInputs));
  const visibleNotes = reverseNotes.filter((n) => !closedInputs.has(outpointId(n)));
  const visibleById = new Map(visibleNotes.map((n) => [outpointId(n), n]));
  let activeReverseSwapTac = 0n, lastSaleAt = null, lastRefundAt = null, activeReverseSwapCount = 0;
  const activeItems = [], referencedInputs = new Map();
  const refundHasFollowOn = (refunded) => {
    const refund = refunded.refund && typeof refunded.refund === 'object' ? refunded.refund : null;
    const txid = typeof refund?.txid === 'string' ? refund.txid.toLowerCase() : null;
    if (!txid) return false;
    const vout = refund.vout == null ? null : Number.isInteger(refund.vout) ? refund.vout : -1;
    const matches = [];
    for (const other of reverseSwaps) {
      if (other === refunded || (refunded.id != null && other.id === refunded.id)) continue;
      for (const input of Array.isArray(other.noteInputs) ? other.noteInputs : []) {
        if (String(input.txid).toLowerCase() === txid && (vout == null || Number(input.vout) === vout)) matches.push(input);
      }
    }
    return matches.length === 1;
  };
  for (const swap of reverseSwaps) {
    const inputs = swapInputs(swap);
    for (const input of inputs) {
      if (!referencedInputs.has(input)) referencedInputs.set(input, []);
      referencedInputs.get(input).push(swap.id);
    }
    const at = swapTime(swap);
    if (swap.phase === 'done') { if (at != null) lastSaleAt = Math.max(lastSaleAt ?? at, at); continue; }
    if (swap.phase === 'refunded') lastRefundAt = at == null ? lastRefundAt : Math.max(lastRefundAt ?? at, at);
    else activeReverseSwapCount++;
    const amount = asBig(swap.amount ?? 0);
    if (amount < 0n) throw new Error(`reverse swap ${swap.id || 'unknown'} has a negative amount`);
    if (swap.phase === 'refunded' && amount <= 0n) throw new Error(`refunded reverse swap ${swap.id || 'unknown'} has no positive amount`);
    let held;
    if (swap.phase === 'refunded') {
      const refund = swap.refund && typeof swap.refund === 'object' ? swap.refund : null;
      const txid = typeof refund?.txid === 'string' ? refund.txid.toLowerCase() : null;
      const vout = refund?.vout == null ? null : Number.isInteger(refund.vout) ? refund.vout : -1;
      const matches = txid ? visibleNotes.filter((n) => String(n.txid).toLowerCase() === txid && (vout == null || Number(n.vout) === vout) && asBig(n.amount) === amount) : [];
      held = refundHasFollowOn(swap) ? amount : matches.length === 1 ? amount : 0n;
    } else held = sum(inputs.map((input) => visibleById.get(input)?.amount ?? 0));
    const unrepresented = amount > held ? amount - held : 0n;
    activeReverseSwapTac += unrepresented;
    if (unrepresented > 0n) activeItems.push(`sale:${swap.id}:${unrepresented}`);
  }
  return {
    visibleNotes, reverseStockTac: sum(visibleNotes.map((n) => n.amount)), activeReverseSwapTac, activeItems,
    activeReverseSwapCount, lastSaleAt, lastRefundAt, referencedInputs,
  };
}

export function journalPosition(records = [], reverseNotes = [], nowSecs = 0, reverseSwaps = []) {
  const day = utcDay(nowSecs), sales = reverseSwapPosition(reverseNotes, reverseSwaps);
  const daily = records.filter((r) => r.selectedAt != null && utcDay(r.selectedAt) === day).map((r) => r.amount);
  const visibleById = new Map(sales.visibleNotes.map((n) => [outpointId(n), n]));
  const inventoryById = new Map(reverseNotes.map((n) => [outpointId(n), n]));
  const linkFor = (input) => records.find((r) => r.destinationNote && outpointId(r.destinationNote) === outpointId(input))
    || records.find((r) => !r.destinationNote && r.broadcastTxid && String(input.txid).toLowerCase() === r.broadcastTxid);
  const represented = new Map();
  const allocationFor = (record) => {
    if (!represented.has(record.id)) represented.set(record.id, { sale: 0n, change: 0n });
    return represented.get(record.id);
  };
  const pendingUnlinked = [], unknownExposure = [];
  for (const swap of reverseSwaps) {
    const inputs = Array.isArray(swap.noteInputs) ? swap.noteInputs : [];
    if (!inputs.length) continue;
    let remainingSale = asBig(swap.amount ?? 0);
    if (remainingSale < 0n) throw new Error(`reverse swap ${swap.id || 'unknown'} has a negative amount`);
    const inputIds = new Set(inputs.map(outpointId)), parts = inputs.map((input, index) => {
      const link = linkFor(input);
      let privateAmount = null;
      if (input.amount != null) {
        try { privateAmount = asBig(input.amount); } catch { privateAmount = null; }
        if (link && privateAmount != null && privateAmount !== asBig(link.amount)) throw new Error(`reverse swap ${swap.id || 'unknown'} input amount conflicts with its funding journal`);
      }
      const amount = privateAmount ?? (link ? asBig(link.amount) : inventoryById.get(outpointId(input))?.amount ?? null);
      const sale = amount == null ? 0n : remainingSale > amount ? amount : remainingSale;
      remainingSale -= sale;
      return { input, index, link, amount, sale, residual: amount == null ? null : amount - sale };
    });
    let visibleChange = 0n;
    const lock = swap.lock && typeof swap.lock === 'object' ? swap.lock : null;
    if (typeof lock?.txid === 'string' && Number.isInteger(lock.vout)) {
      visibleChange = sum(sales.visibleNotes.filter((n) => String(n.txid).toLowerCase() === lock.txid.toLowerCase() && Number(n.vout) !== lock.vout && !inputIds.has(outpointId(n))).map((n) => n.amount));
    }
    for (const part of parts) {
      if (!part.link) continue;
      const allocation = allocationFor(part.link);
      allocation.sale += part.sale;
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (part.residual == null) continue;
      const change = visibleChange > part.residual ? part.residual : visibleChange;
      visibleChange -= change;
      part.residual -= change;
      if (part.link) allocationFor(part.link).change += change;
    }
    for (const part of parts) {
      if (part.link) continue;
      const key = `${swap.id}:${part.index}:${outpointId(part.input)}`;
      if (part.amount == null) {
        unknownExposure.push({ swapId: swap.id, inputIndex: part.index, outpoint: outpointId(part.input), reason: 'reverse_input_amount_unknown' });
        pendingUnlinked.push({ key: `unknown:${key}`, amount: 0n, unknown: true });
        continue;
      }
      const originalVisible = visibleById.has(outpointId(part.input));
      const residual = originalVisible ? 0n : part.residual;
      if (residual > 0n) pendingUnlinked.push({ key: `unlinked:${key}`, amount: residual, unknown: false });
    }
  }
  const pendingRecords = [];
  for (const record of records) {
    if (!isPending(record) && !(record.state === 'done' && record.broadcastTxid)) continue;
    const amount = asBig(record.amount), allocation = allocationFor(record);
    const originalVisible = record.broadcastTxid && sales.visibleNotes.some((n) => String(n.txid).toLowerCase() === record.broadcastTxid
      && (!record.destinationNote || Number(n.vout) === Number(record.destinationNote.vout)) && asBig(n.amount) === amount);
    const residual = record.exposurePending === true ? amount : originalVisible ? 0n : amount > allocation.sale + allocation.change ? amount - allocation.sale - allocation.change : 0n;
    if (residual > 0n) pendingRecords.push({ record, amount: residual });
  }
  const reverseStockTac = sales.reverseStockTac, pendingTac = sum(pendingRecords.map((r) => r.amount)) + sum(pendingUnlinked.map((r) => r.amount));
  const unconfirmedReverseStockTac = sum(sales.visibleNotes.filter((n) => n.confirmed === false).map((n) => n.amount));
  const completed = records.filter((r) => r.state === 'done' && Number.isFinite(r.completedAt)).map((r) => r.completedAt);
  return {
    dailyTac: sum(daily), pendingTac, reverseStockTac, unconfirmedReverseStockTac, activeReverseSwapTac: sales.activeReverseSwapTac,
    totalStockTac: reverseStockTac + pendingTac + sales.activeReverseSwapTac,
    activeReverseSwapCount: sales.activeReverseSwapCount, lastSaleAt: sales.lastSaleAt, lastRefundAt: sales.lastRefundAt,
    exposureUnknown: unknownExposure.length > 0, unknownExposure,
    reverseStockItems: sales.visibleNotes.map((n) => `reverse:${outpointId(n)}:${n.amount}`),
    pendingItems: [...pendingRecords.map((r) => `funding:${r.record.id}:${r.amount}`), ...pendingUnlinked.map((r) => `${r.key}:${r.unknown ? 'unknown' : r.amount}`)], activeItems: sales.activeItems,
    sourceOutpoints: new Set(records.filter((r) => r.note).map((r) => outpointId(r.note))),
    reservedFeeCoins: new Set(records.filter((r) => isPending(r) && r.coin).map((r) => outpointId(r.coin))),
    ambiguousOutpoints: records.filter((r) => r.state === 'halted' && r.broadcastAttempted === true).map((r) => outpointId(r.note)),
    lastCompletedAt: completed.length ? Math.max(...completed) : null,
  };
}

const termInt = (value, name) => {
  if (typeof value === 'bigint') return value;
  if (!/^\d+$/.test(String(value ?? ''))) throw new Error(`reverse terms ${name} must be a nonnegative whole number`);
  return BigInt(value);
};

export function reverseOutputBounds(terms) {
  if (terms == null) return null;
  if (terms.minAmount == null || terms.maxAmount == null) throw new Error('reverse terms must include minAmount and maxAmount');
  const minIn = termInt(terms.minAmount, 'minAmount'), maxIn = termInt(terms.maxAmount, 'maxAmount');
  const feeBps = termInt(terms.feeBps ?? 0, 'feeBps'), flatFee = termInt(terms.flatFee ?? 0, 'flatFee');
  const floor = termInt(terms.minProceedsBps ?? 10000, 'minProceedsBps');
  if (minIn <= 0n || maxIn < minIn) throw new Error('reverse terms have an inverted or empty amount range');
  if (feeBps < 0n || flatFee < 0n) throw new Error('reverse terms fees must be nonnegative');
  if (feeBps > 10000n) throw new Error('reverse terms feeBps exceeds 10000');
  if (floor < 10000n || floor > 1000000n) throw new Error('reverse terms minProceedsBps is outside 10000 to 1000000');
  const priced = { ...terms, feeBps, flatFee };
  const min = minIn - feeOf(priced, minIn), max = maxIn - feeOf(priced, maxIn);
  if (min <= 0n || max <= 0n || max < min) throw new Error('reverse terms are economically invalid: their output is nonpositive or inverted');
  return { min, max, minIn, maxIn, feeBps, flatFee, minProceedsBps: floor };
}

export function exactReverseSale(terms, amount) {
  const bounds = reverseOutputBounds(terms), btcValue = asBig(amount);
  if (!bounds || btcValue < bounds.min || btcValue > bounds.max) return null;
  const priced = { ...terms, feeBps: bounds.feeBps, flatFee: bounds.flatFee };
  let lo = bounds.minIn, hi = bounds.maxIn;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (mid - feeOf(priced, mid) <= btcValue) lo = mid; else hi = mid - 1n;
  }
  const evmAmount = lo;
  if (evmAmount - feeOf(priced, evmAmount) !== btcValue) return null;
  return { evmAmount, amount: evmAmount, btcValue, minProceedsBps: bounds.minProceedsBps, proceedsOk: evmAmount * 10000n >= btcValue * bounds.minProceedsBps };
}

export function admissionDecision({ note, amount = note?.amount, config, position, feeRate, terms = config?.terms }) {
  const reasons = [];
  if (position?.exposureUnknown) reasons.push('reverse_exposure_unknown');
  let a;
  try { a = asBig(amount); } catch { a = 0n; }
  if (a <= 0n) reasons.push('invalid_amount');
  if (config.maxNoteTac != null && a > asBig(config.maxNoteTac)) reasons.push('per_note_cap');
  if (position && config.maxDailyTac != null && position.dailyTac + a > asBig(config.maxDailyTac)) reasons.push('daily_cap');
  if (position && config.maxInventoryTac != null && position.totalStockTac + a > asBig(config.maxInventoryTac)) reasons.push('inventory_cap');
  const rate = Number(feeRate);
  if (!Number.isFinite(rate) || rate <= 0) reasons.push('fee_rate_unavailable');
  else if (config.maxFeeRate != null && rate > config.maxFeeRate) reasons.push('fee_rate_above_cap');
  let bounds = null, sale = null;
  try {
    bounds = reverseOutputBounds(terms);
    if (!bounds && config.enabled) reasons.push('reverse_terms_unavailable');
    if (bounds) {
      if (a < bounds.min) reasons.push('reverse_amount_below_min');
      if (a > bounds.max) reasons.push('reverse_amount_above_max');
      else {
        sale = exactReverseSale(terms, a);
        if (!sale) reasons.push('reverse_exact_amount_unreachable');
        else if (!sale.proceedsOk) reasons.push('proceeds_floor_unreachable');
      }
    }
  } catch { reasons.push('invalid_reverse_terms'); }
  return {
    ok: reasons.length === 0, reasons, amount: a, sale,
    remaining: {
      note: config.maxNoteTac == null ? null : asBig(config.maxNoteTac) - a,
      daily: position && config.maxDailyTac != null ? asBig(config.maxDailyTac) - position.dailyTac - a : null,
      inventory: position && config.maxInventoryTac != null ? asBig(config.maxInventoryTac) - position.totalStockTac - a : null,
    },
  };
}

export function selectWholeNote({ candidates = [], records = [], reverseNotes = [], reverseSwaps = [], nowSecs = 0, feeRate, config, terms = config.terms, excluded = new Set() }) {
  const position = journalPosition(records, reverseNotes, nowSecs, reverseSwaps);
  const decisions = [];
  const eligible = [];
  for (const candidate of candidates) {
    const id = outpointId(candidate);
    const reasons = [];
    if (excluded.has(id) || position.sourceOutpoints.has(id)) reasons.push('already_journaled_or_excluded');
    if (candidate.chain && candidate.chain.ok === false) reasons.push(candidate.chain.reason || 'chain_ineligible');
    const ld = lineageDecision(candidate.lineage);
    if (!ld.ok) reasons.push(ld.reason);
    const admission = admissionDecision({ note: candidate, config, position, feeRate, terms });
    reasons.push(...admission.reasons);
    const decision = { id, amount: asBig(candidate.amount), ok: reasons.length === 0, reasons: [...new Set(reasons)], lineageClass: ld.class || null };
    decisions.push(decision);
    if (decision.ok) eligible.push({ candidate, admission });
  }
  eligible.sort((a, b) => {
    const aa = asBig(a.candidate.amount), bb = asBig(b.candidate.amount);
    if (aa !== bb) return aa < bb ? -1 : 1;
    return outpointId(a.candidate).localeCompare(outpointId(b.candidate));
  });
  const chosen = eligible[0] || null;
  return {
    note: chosen ? { ...chosen.candidate, amount: asBig(chosen.candidate.amount).toString() } : null,
    admission: chosen?.admission || null, position, decisions,
    reason: chosen ? null : 'no_eligible_whole_note',
  };
}

export const planRebalance = selectWholeNote;

export function selectFeeCoin({ coins = [], candidate, position, excluded = new Set() }) {
  const usable = coins.filter((coin) => {
    const id = outpointId(coin);
    return id !== outpointId(candidate) && !position.reservedFeeCoins.has(id) && !excluded.has(id) && (!coin.chain || coin.chain.ok !== false);
  });
  usable.sort((a, b) => Number(a.chain?.value ?? Infinity) - Number(b.chain?.value ?? Infinity) || outpointId(a).localeCompare(outpointId(b)));
  return usable[0] || null;
}

export function wholeNotePlan(plan, expected = {}) {
  const reasons = [];
  if (!plan || plan.mode !== 'plain') reasons.push('plain_mode_required');
  if (!plan?.note || !plan?.coin) reasons.push('source_and_fee_coin_required');
  if (plan && plan.note && (plan.amount !== plan.note.amount || plan.change !== '0')) reasons.push('whole_note_no_change_required');
  for (const [field, a, b] of [
    ['source', expected.note && outpointId(expected.note), plan?.note && outpointId(plan.note)],
    ['amount', expected.amount != null ? String(expected.amount) : null, plan?.amount],
    ['destination', expected.destination, plan?.destination],
    ['source address', expected.houseAddress, plan?.houseAddress],
    ['fee coin', expected.coin && outpointId(expected.coin), plan?.coin && outpointId(plan.coin)],
  ]) if (a != null && a !== b) reasons.push(`${field.replace(/ /g, '_')}_mismatch`);
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function reconcileMoved({ record, sourceOutspend, broadcastTx, reverseNotes = [], reverseSwaps = [], tipHeight, minConfs = 1 }) {
  if (!record || record.state !== 'moved' || !/^[0-9a-f]{64}$/.test(String(record.broadcastTxid || ''))) return { done: false, reason: 'broadcast_txid_unavailable' };
  if (!sourceOutspend || sourceOutspend.spent !== true) return { done: false, reason: sourceOutspend?.spent === false ? 'source_not_spent_yet' : 'source_spend_state_unread' };
  if (!sourceOutspend.txid) return { done: false, reason: 'source_spender_unread' };
  if (String(sourceOutspend.txid).toLowerCase() !== record.broadcastTxid) return { done: false, reason: 'source_spent_by_another_transaction' };
  if (!broadcastTx || !broadcastTx.status || broadcastTx.status.confirmed !== true) return { done: false, reason: 'broadcast_unconfirmed' };
  if (!Number.isInteger(broadcastTx.status.block_height) || !Number.isInteger(tipHeight) || tipHeight - broadcastTx.status.block_height + 1 < minConfs) return { done: false, reason: 'broadcast_insufficient_confirmations' };
  const outputs = (broadcastTx.vout || []).map((out, vout) => ({ ...out, txid: record.broadcastTxid, vout })).filter((out) => out.scriptpubkey_address === record.reverseAddress && out.value <= DUST);
  if (!outputs.length) return { done: false, reason: 'reverse_destination_output_missing' };
  const found = reverseNotes.find((n) => String(n.txid).toLowerCase() === record.broadcastTxid && n.confirmed !== false && outputs.some((out) => out.vout === Number(n.vout)) && asBig(n.amount) === asBig(record.amount));
  if (found) return { done: true, state: 'done', reason: null, destination: { txid: found.txid, vout: found.vout, amount: asBig(found.amount).toString() }, destinationEvidence: 'reverse_inventory' };
  const references = [];
  for (const swap of reverseSwaps) for (const input of Array.isArray(swap.noteInputs) ? swap.noteInputs : []) {
    const destination = outputs.find((out) => outpointId(out) === outpointId(input));
    if (destination) references.push({ swap, input, destination });
  }
  if (references.length > 1) return { done: false, reason: 'ambiguous_reverse_swap_destination' };
  if (references.length === 1) {
    const { swap, input, destination } = references[0];
    if (input.amount != null) {
      let amount;
      try { amount = asBig(input.amount); } catch { return { done: false, reason: 'reverse_swap_amount_mismatch' }; }
      if (amount !== asBig(record.amount)) return { done: false, reason: 'reverse_swap_amount_mismatch' };
    }
    return { done: true, state: 'done', reason: null, destination: { txid: record.broadcastTxid, vout: destination.vout, amount: asBig(record.amount).toString() }, destinationEvidence: 'reverse_swap_journal', reverseSwapIds: [swap.id] };
  }
  return { done: false, reason: 'reverse_inventory_not_visible_or_amount_mismatch' };
}

export function reconcileDone({ record, sourceOutspend, broadcastTx, tipHeight, minConfs = 1 }) {
  const retry = (reason) => ({ ok: false, transient: true, reason });
  const contradictory = (reason) => ({ ok: false, transient: false, reason });
  if (!record?.broadcastTxid || !record.destinationNote) return retry('done_destination_evidence_missing');
  if (!sourceOutspend || typeof sourceOutspend.spent !== 'boolean') return retry('done_source_spend_unreadable');
  if (sourceOutspend.spent === false) return contradictory('done_source_reappeared');
  if (typeof sourceOutspend.txid !== 'string' || !sourceOutspend.txid) return retry('done_source_spender_unreadable');
  if (sourceOutspend.txid.toLowerCase() !== record.broadcastTxid) return contradictory('done_source_spend_changed');
  if (!broadcastTx || !broadcastTx.status || broadcastTx.status.confirmed == null) return retry('done_broadcast_unreadable');
  if (broadcastTx.status.confirmed === false) return contradictory('done_broadcast_confirmations_lost');
  if (broadcastTx.status.confirmed !== true || !Number.isInteger(broadcastTx.status.block_height) || !Number.isInteger(tipHeight)) return retry('done_broadcast_block_data_unreadable');
  if (tipHeight - broadcastTx.status.block_height + 1 < minConfs) return contradictory('done_broadcast_confirmations_lost');
  if (!Array.isArray(broadcastTx.vout)) return retry('done_broadcast_outputs_unreadable');
  const out = broadcastTx.vout[record.destinationNote.vout];
  if (!out) return retry('done_destination_output_unreadable');
  if (out.scriptpubkey_address !== record.reverseAddress) return contradictory('done_destination_output_changed');
  if (!Number.isInteger(out.value) || out.value < 0) return retry('done_destination_value_unreadable');
  if (out.value > DUST) return contradictory('done_destination_output_changed');
  if (String(record.destinationNote.txid).toLowerCase() !== record.broadcastTxid || record.destinationNote.amount !== record.amount) return contradictory('done_destination_amount_changed');
  return { ok: true, reason: null };
}

export function recoverAmbiguousBroadcasts(records = [], nowSecs = 0) {
  const halted = [];
  const recordsOut = records.map((record) => {
    if (record.state !== 'broadcasting') return record;
    const next = {
      ...record, state: 'halted', haltedAt: clampSeconds(nowSecs), broadcastAttempted: true,
      haltReason: 'restart_or_tick_with_broadcast_outcome_uncertain', manualReconciliationRequired: true,
    };
    halted.push(next);
    return next;
  });
  return { records: recordsOut, halted };
}

export function buildStatusRecord({ config, dryRun = false, records = [], reverseNotes = [], reverseSwaps = [], candidates = [], nowSecs = 0, eligibleSince = null, watchSince = null, lastSaleAt = null, newFundingAllowed = null }) {
  const now = clampSeconds(nowSecs), position = journalPosition(records, reverseNotes, now, reverseSwaps);
  const eligible = candidates.filter((candidate) => {
    if (position.sourceOutpoints.has(outpointId(candidate)) || candidate.chain?.ok === false || !lineageDecision(candidate.lineage).ok) return false;
    const a = asBig(candidate.amount);
    if (config.maxNoteTac != null && a > asBig(config.maxNoteTac)) return false;
    try { return !!exactReverseSale(config.terms, a)?.proceedsOk; } catch { return false; }
  });
  const eligibleStockTac = sum(eligible.map((n) => n.amount));
  const measuredStuckTac = eligibleStockTac + position.totalStockTac;
  const above = config.maxStuckTac != null && measuredStuckTac > asBig(config.maxStuckTac);
  const missingStuckCeiling = config.enabled && !dryRun && config.maxStuckTac == null;
  const saleAt = [position.lastSaleAt, lastSaleAt].filter((v) => Number.isFinite(v)).reduce((m, v) => Math.max(m, v), -Infinity);
  const lastSale = Number.isFinite(saleAt) ? saleAt : null, watch = watchSince ?? eligibleSince;
  const reference = lastSale != null && (watch == null || lastSale >= watch) ? lastSale : watch;
  const elapsed = measuredStuckTac > 0n && reference != null ? Math.max(0, now - reference) : 0;
  const noRecovery = measuredStuckTac > 0n && reference != null && elapsed >= config.stallSecs;
  const unknown = position.exposureUnknown === true;
  const stallReason = unknown ? 'reverse_input_amount_unknown' : missingStuckCeiling ? 'max_stuck_not_configured' : above ? 'reverse_stock_above_configured_ceiling' : noRecovery ? 'no_completed_recovery_within_stallSecs' : null;
  const ambiguous = position.ambiguousOutpoints.length > 0;
  const intakeReason = dryRun ? 'dry_run' : !config.enabled ? 'rebalancer_disabled' : unknown ? 'reverse_input_amount_unknown' : missingStuckCeiling ? 'missing_max_stuck_configuration' : above ? stallReason : noRecovery ? stallReason : ambiguous ? 'manual_broadcast_reconciliation_required' : null;
  return {
    version: 1, kind: 'status', id: 'status', ts: now, enabled: config.enabled, dryRun,
    intakeAllowed: intakeReason == null, intakeReason, newFundingAllowed: ambiguous || unknown ? false : newFundingAllowed == null ? config.enabled && !dryRun : !!newFundingAllowed,
    exposureUnknown: unknown, unknownExposure: position.unknownExposure,
    stalled: stallReason != null, stallReason, aboveConfiguredStuckCeiling: above,
    maxStuckTac: config.maxStuckTac == null ? null : formatTac(config.maxStuckTac),
    maxStuckBaseUnits: config.maxStuckTac == null ? null : asBig(config.maxStuckTac).toString(),
    measuredStuckTac: formatTac(measuredStuckTac), measuredStuckBaseUnits: measuredStuckTac.toString(),
    measurementScope: 'eligible_leased_main_candidates_plus_reverse_stock_and_pending', unleasedHouseNotesIncluded: false,
    stall: {
      exposureUnknown: unknown, unknownExposure: position.unknownExposure,
      aboveConfiguredStuckCeiling: above,
      maxStuckTac: config.maxStuckTac == null ? null : formatTac(config.maxStuckTac),
      measuredStuckTac: formatTac(measuredStuckTac), measuredStuckBaseUnits: measuredStuckTac.toString(),
      configuredStuckCeilingTac: config.maxStuckTac == null ? null : formatTac(config.maxStuckTac),
      totalReverseStockIncludingPendingTac: formatTac(position.totalStockTac),
      eligibleStockTac: formatTac(eligibleStockTac), eligibleStockBaseUnits: eligibleStockTac.toString(),
      noCompletedRecoveryWithinStallSecs: noRecovery, stallSecs: config.stallSecs, elapsedSecs: elapsed,
      lastCompletedAt: position.lastCompletedAt, eligibleSince, watchSince: watch, lastSaleAt: lastSale, lastRefundAt: position.lastRefundAt,
      activeReverseSwapTac: formatTac(position.activeReverseSwapTac), activeReverseSwapBaseUnits: position.activeReverseSwapTac.toString(),
    },
    reverseStockTac: formatTac(position.reverseStockTac), reverseStockBaseUnits: position.reverseStockTac.toString(),
    unconfirmedReverseStockBaseUnits: position.unconfirmedReverseStockTac.toString(),
    pendingTac: formatTac(position.pendingTac), pendingBaseUnits: position.pendingTac.toString(),
    activeReverseSwapTac: formatTac(position.activeReverseSwapTac), activeReverseSwapBaseUnits: position.activeReverseSwapTac.toString(),
    activeReverseSwapCount: position.activeReverseSwapCount, watchSince: watch, lastSaleAt: lastSale, lastRefundAt: position.lastRefundAt,
    dailyCommittedTac: formatTac(position.dailyTac), dailyCommittedBaseUnits: position.dailyTac.toString(), utcDay: utcDay(now),
    eligibleNoteCount: eligible.length, haltedOutpoints: position.ambiguousOutpoints,
    exposureItems: [
      ...eligible.map((n) => `main:${outpointId(n)}:${n.amount}`),
      ...position.reverseStockItems, ...position.pendingItems, ...position.activeItems,
    ].sort(),
    buyerDemandGuaranteed: false,
  };
}

export function acquireProcessLock(file, { pid = process.pid } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const token = `${pid}:${Date.now()}:${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 16)}`;
  const acquire = () => {
    const fd = openSync(file, 'wx');
    try { writeSync(fd, JSON.stringify({ version: 1, pid, token })); fsyncSync(fd); } finally { closeSync(fd); }
  };
  try { acquire(); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    throw new Error('the reverse rebalancer lock already exists; confirm no sidecar is running, then remove it manually before restarting');
  }
  let held = true;
  return {
    token,
    release() {
      if (!held) return;
      held = false;
      try {
        const current = JSON.parse(readFileSync(file, 'utf8'));
        if (current.token === token) unlinkSync(file);
      } catch { /* already reclaimed or removed */ }
    },
  };
}

export function makeThrottledAlert({ store, alert, now = () => Math.floor(Date.now() / 1000), alertSecs = 3600 }) {
  return async (key, body) => {
    const id = `a-${createHash('sha256').update(String(key)).digest('hex').slice(0, 40)}`;
    const at = clampSeconds(now()), previous = await store.get(id);
    if (previous && at - previous.lastAt < alertSecs) return false;
    await store.put({ id, kind: 'alert', key: String(key), lastAt: at });
    try { await alert({ ...body, alertKey: String(key) }); }
    catch (e) {
      try { if (previous) await store.put(previous); else await store.del(id); } catch { /* retain the original notification error */ }
      throw e;
    }
    return true;
  };
}

let restrictedViewTurn = Promise.resolve();

export function makeReverseRebalancer({
  config, leases, store, reverseSwaps = makeMemoryStore(), tacit, getJson, reverseInventory, mainAddress, reverseAddress, destination,
  fund = {}, dryRun = false, now = () => Math.floor(Date.now() / 1000), log = () => {}, alert = () => {},
  feeRate = () => tacit.getFeeRate(null, { fresh: true, requireSource: true }), lineage = (notes) => tacit.bridgeUx().lineage(notes),
  realFetch = globalThis.fetch, withWalletView = null, ownPubHex = () => Buffer.from(tacit.wallet.pub).toString('hex'), expectedPubHex = Buffer.from(mainAddress ? tacit.wallet.pub : []).toString('hex'),
  hooks = {}, sleep,
}) {
  const F = { exposeOutpoints, planFund, executeFund, fundToken, viewFetch, ...fund };
  const notify = makeThrottledAlert({ store: dryRun ? makeMemoryStore() : store, alert, now, alertSecs: config.alertSecs });
  const inView = withWalletView || ((exposed, work) => {
    const run = restrictedViewTurn.then(async () => {
      const previous = globalThis.fetch;
      globalThis.fetch = F.viewFetch(realFetch, mainAddress, exposed.utxos);
      try { return await work(); } finally { globalThis.fetch = previous; }
    });
    restrictedViewTurn = run.catch(() => {});
    return run;
  });
  let lastStatus = null, busy = false;

  const checkedList = async (namedStore, name) => {
    const out = await namedStore.list();
    const problems = namedStore.problems?.() || [];
    if (problems.length) throw new Error(`${name} is unreadable; funding and admissions fail closed (${problems.map((p) => `${p.id}: ${p.error}`).join('; ')})`);
    return out;
  };
  const records = async () => (await checkedList(store, 'reverse rebalance journal')).filter((r) => r.kind === 'move');
  const reverseSwapRecords = async () => checkedList(reverseSwaps, 'reverse swap journal');
  const tipHeight = async () => {
    const n = await getJson('/blocks/tip/height');
    if (!Number.isInteger(n)) throw new Error('the Bitcoin tip height could not be read');
    return n;
  };
  const inspect = async (o, kind = 'note') => {
    const [tx, outspend, tip] = await Promise.all([
      getJson(`/tx/${o.txid}`), getJson(`/tx/${o.txid}/outspend/${o.vout}`), tipHeight(),
    ]);
    return chainDecision({ tx, outspend, vout: o.vout, address: mainAddress, tipHeight: tip, minConfs: config.minSourceConfs, kind });
  };
  const lineageFor = async (notes) => {
    const verdicts = await lineage(notes.map((n) => ({ txid: n.txid, vout: n.vout, amount: asBig(n.amount) })));
    return verdicts;
  };
  const alertChain = async (note, chain, kind) => {
    if (chain.alert) await notify(`${kind}:${chain.reason}:${outpointId(note)}`, { level: chain.reason === 'spent' ? 'info' : 'warn', msg: `reverse rebalance ${kind} check: ${chain.reason}`, outpoint: outpointId(note) });
  };
  const assertCurrentLease = (note, coin = null) => {
    const current = leases.notes.find((leased) => outpointId(leased) === outpointId(note));
    if (!current || String(current.amount) !== String(note.amount)) throw Object.assign(new Error(`the current lease does not authorise note ${outpointId(note)} at ${note.amount} base units`), { code: 'lease_note_revoked' });
    if (coin != null && !leases.feeCoins.some((leased) => outpointId(leased) === outpointId(coin))) throw Object.assign(new Error(`the current lease does not authorise fee coin ${outpointId(coin)}`), { code: 'lease_coin_revoked' });
  };

  async function prepareExact({ note, coin = null, existing = null }) {
    if (existing && (
      existing.state !== 'selected' || existing.mode !== 'plain' || existing.change !== '0' || !existing.note || !existing.coin || existing.amount !== existing.note.amount ||
      existing.destination !== destination || existing.reverseAddress !== reverseAddress || existing.houseAddress !== mainAddress || existing.sourceAddress !== mainAddress ||
      outpointId(existing.note) !== outpointId(note) || (coin && outpointId(existing.coin) !== outpointId(coin))
    )) throw Object.assign(new Error('the persisted selected plan does not match the derived addresses or exact whole-note fields'), { code: 'plan_mismatch' });
    assertCurrentLease(note);
    const sourceChain = await inspect(note, 'note');
    if (!sourceChain.ok) throw Object.assign(new Error(`source ${outpointId(note)}: ${sourceChain.reason}`), { code: sourceChain.reason });
    const chosenCoin = coin || existing?.coin;
    if (!chosenCoin) throw new Error('no unreserved lease fee coin is available');
    assertCurrentLease(note, chosenCoin);
    if (outpointId(note) === outpointId(chosenCoin)) throw new Error('the source note and fee coin collide');
    const coinChain = await inspect(chosenCoin, 'coin');
    if (!coinChain.ok) throw Object.assign(new Error(`fee coin ${outpointId(chosenCoin)}: ${coinChain.reason}`), { code: coinChain.reason });
    const exposed = await F.exposeOutpoints({ getJson, address: mainAddress, notes: [{ txid: note.txid, vout: note.vout }], coin: { txid: chosenCoin.txid, vout: chosenCoin.vout } });
    const tip = await tipHeight();
    for (const u of exposed.utxos) {
      if (u.status?.confirmed !== true || !Number.isInteger(u.status?.block_height) || u.status.block_height < 0 || u.status.block_height > tip) {
        throw Object.assign(new Error(`the second explorer read returned invalid confirmations for ${outpointId(u)}`), { code: 'invalid_exposed_confirmations' });
      }
    }
    const exposedNote = exposed.utxos[0];
    if (tip - exposedNote.status.block_height + 1 < config.minSourceConfs) throw Object.assign(new Error('source confirmations fell below the configured minimum'), { code: 'insufficient_confirmations' });
    const verdicts = await lineageFor([note]);
    const verdict = verdicts?.get ? verdicts.get(outpointId(note)) : null;
    const ld = lineageDecision(verdict);
    if (ld.alert) await notify(`lineage:unread:${outpointId(note)}`, { level: 'warn', msg: 'reverse rebalance cannot read note lineage; the note is skipped', outpoint: outpointId(note) });
    if (!ld.ok) throw Object.assign(new Error(`source lineage is not eligible: ${ld.reason}`), { code: ld.reason });

    const expected = existing || { note, amount: note.amount, coin: chosenCoin, destination, houseAddress: mainAddress };
    let plan;
    try {
      plan = await inView(exposed, () => F.planFund({
        tacit, amount: asBig(expected.amount), exposed, destination, mode: 'plain', houseAddress: mainAddress,
        ...(sleep ? { sleep } : {}), log: (m) => log({ level: 'debug', msg: String(m) }),
      }));
    } catch (e) {
      if (/none of the named outputs|none of the named notes holds/.test(errorText(e))) throw Object.assign(new Error(`leased amount does not match a wallet-spendable note at ${outpointId(note)}`), { code: 'amount_mismatch', cause: e });
      throw e;
    }
    const whole = wholeNotePlan(plan, { ...expected, destination, houseAddress: mainAddress });
    if (!whole.ok) throw Object.assign(new Error(`whole-note plan refused: ${whole.reasons.join(',')}`), { code: whole.reasons.includes('amount_mismatch') || whole.reasons.includes('whole_note_no_change_required') ? 'amount_mismatch' : 'plan_mismatch' });
    const rate = await feeRate();
    const allRecords = await records();
    // The reverse service journals before broadcasting, so inventory then journal cannot miss an interleaved sale.
    const reverseNotes = await reverseInventory.notes();
    const swapRecords = await reverseSwapRecords();
    const position = journalPosition(allRecords.filter((r) => r.id !== existing?.id), reverseNotes, now(), swapRecords);
    const admission = admissionDecision({ note: plan.note, config, position, feeRate: rate });
    if (!admission.ok) throw Object.assign(new Error(`admission refused: ${admission.reasons.join(',')}`), { code: 'admission_refused', reasons: admission.reasons });
    return { plan: { ...plan, feeRate: rate, maxFeeRate: config.maxFeeRate }, exposed, feeRate: rate, reverseNotes };
  }

  const recordFrom = (prepared, at) => ({
    id: journalId(prepared.plan.note), kind: 'move', state: 'selected', version: 1,
    note: { ...prepared.plan.note }, amount: prepared.plan.amount, mode: 'plain', change: '0',
    sourceAddress: mainAddress, houseAddress: mainAddress, reverseAddress, destination,
    coin: { ...prepared.plan.coin }, selectedAt: at, feeRate: prepared.feeRate, maxFeeRate: config.maxFeeRate,
  });

  async function broadcastSelected(record, prepared = null) {
    let ready, rate;
    try {
      assertCurrentLease(record.note, record.coin);
      ready = prepared || await prepareExact({ note: record.note, coin: record.coin, existing: record });
      const current = await records();
      if (current.some((r) => r.state === 'halted' && r.broadcastAttempted === true)) throw Object.assign(new Error('an ambiguous broadcast requires manual reconciliation'), { code: 'ambiguous_halt' });
      rate = await feeRate();
      const latestNotes = await reverseInventory.notes();
      const latestSwaps = await reverseSwapRecords();
      if (journalPosition(current, latestNotes, now(), latestSwaps).exposureUnknown) {
        throw Object.assign(new Error('admission refused: reverse_exposure_unknown'), { code: 'admission_refused', reasons: ['reverse_exposure_unknown'] });
      }
      assertCurrentLease(record.note, record.coin);
    } catch (e) {
      if (e.code === 'lease_note_revoked' || e.code === 'lease_coin_revoked') {
        const halted = { ...record, state: 'halted', haltedAt: now(), haltReason: e.code, broadcastAttempted: false, manualReconciliationRequired: true };
        if (!dryRun) await store.put(halted);
        await notify(`lease:${record.id}:${e.code}`, { level: 'alert', msg: 'reverse rebalance lease revoked for a selected plan; the outpoint is halted without another broadcast', outpoint: outpointId(record.note), error: errorText(e) });
      }
      throw e;
    }
    if (!Number.isFinite(Number(rate)) || Number(rate) <= 0 || Number(rate) > config.maxFeeRate) {
      return { sent: false, reason: 'fee_rate_above_cap_or_unavailable', record };
    }
    const broadcasting = { ...record, state: 'broadcasting', broadcastingAt: now(), broadcastAttempted: true, feeRate: rate, maxFeeRate: config.maxFeeRate };
    await store.put(broadcasting);
    let sent;
    try {
      await hooks.beforeExecute?.(broadcasting);
      assertCurrentLease(record.note, record.coin);
      sent = await inView(ready.exposed, () => F.executeFund({
        tacit, plan: { ...ready.plan, feeRate: rate, maxFeeRate: config.maxFeeRate }, token: F.fundToken(ready.plan), ownPubHex: ownPubHex(), expectPubHex: expectedPubHex,
      }));
      if (!/^[0-9a-f]{64}$/.test(String(sent || ''))) throw new Error('the wallet returned no reveal transaction id; broadcast outcome is uncertain');
    } catch (e) {
      const halted = { ...broadcasting, state: 'halted', haltedAt: now(), haltReason: 'broadcast_outcome_uncertain', broadcastError: errorText(e), manualReconciliationRequired: true };
      await store.put(halted);
      await notify(`halt:${record.id}`, { level: 'alert', msg: 'reverse rebalance halted this outpoint: broadcast outcome is uncertain; reconcile it manually', outpoint: outpointId(record.note), error: errorText(e) });
      throw e;
    }
    await hooks.afterExecute?.({ record: broadcasting, txid: sent });
    const moved = { ...broadcasting, state: 'moved', broadcastTxid: sent, movedAt: now() };
    await store.put(moved);
    await hooks.afterMoved?.(moved);
    log({ level: 'info', msg: 'reverse rebalance whole-note move broadcast', outpoint: outpointId(record.note), amount: formatTac(record.amount), txid: sent });
    return { sent: true, txid: sent, record: moved };
  }

  async function candidatesFromChain(allRecords) {
    const out = [];
    for (const leased of leases.notes) {
      if (allRecords.some((r) => outpointId(r.note) === outpointId(leased))) continue;
      let chain;
      try { chain = await inspect(leased, 'note'); }
      catch (e) { chain = { ok: false, reason: 'transaction_unread', alert: true, error: errorText(e) }; }
      await alertChain(leased, chain, 'source');
      out.push({ ...leased, chain, lineage: null });
    }
    const check = out.filter((n) => n.chain.ok);
    if (check.length) {
      let verdicts;
      try { verdicts = await lineageFor(check); }
      catch (e) {
        for (const n of check) await notify(`lineage:unread:${outpointId(n)}`, { level: 'warn', msg: 'reverse rebalance lineage read failed; eligible stock is not moved', outpoint: outpointId(n), error: errorText(e) });
        return out.map((n) => ({ ...n, lineage: n.chain.ok ? { state: 'unread', error: errorText(e) } : n.lineage }));
      }
      for (const n of check) {
        n.lineage = verdicts?.get ? verdicts.get(outpointId(n)) || { state: 'unread' } : { state: 'unread' };
        const ld = lineageDecision(n.lineage);
        if (ld.alert) await notify(`lineage:unread:${outpointId(n)}`, { level: 'warn', msg: 'reverse rebalance cannot read note lineage; the note is skipped', outpoint: outpointId(n) });
      }
    }
    return out;
  }

  async function chooseCoin(candidate, allRecords) {
    const position = journalPosition(allRecords, [], now());
    const coins = [];
    for (const coin of leases.feeCoins) {
      if (position.reservedFeeCoins.has(outpointId(coin)) || outpointId(coin) === outpointId(candidate)) continue;
      let chain;
      try { chain = await inspect(coin, 'coin'); }
      catch (e) { chain = { ok: false, reason: 'transaction_unread', alert: true }; }
      await alertChain(coin, chain, 'fee-coin');
      if (chain.ok) coins.push({ ...coin, chain });
    }
    return selectFeeCoin({ coins, candidate, position });
  }

  async function persistStatus({ allRecords, reverseNotes, swaps = [], candidates, extra = {} }) {
    const previous = await store.get('status');
    const base = { config, dryRun, records: allRecords, reverseNotes, reverseSwaps: swaps, candidates, nowSecs: now() };
    const preliminary = buildStatusRecord({ ...base, watchSince: previous?.watchSince ?? previous?.eligibleSince ?? null, lastSaleAt: previous?.lastSaleAt ?? null });
    const oldItems = new Set(previous?.exposureItems || []), added = preliminary.exposureItems.some((item) => !oldItems.has(item));
    const measured = asBig(preliminary.measuredStuckBaseUnits);
    const watchSince = measured === 0n ? null : !previous || added ? now() : previous.watchSince ?? previous.eligibleSince ?? now();
    const status = {
      ...buildStatusRecord({ ...base, watchSince, lastSaleAt: preliminary.lastSaleAt, newFundingAllowed: config.enabled && !dryRun && !allRecords.some((r) => ACTIVE_STATES.has(r.state)) }),
      eligibleSince: watchSince, watchSince, ...extra,
    };
    if (!dryRun) await store.put(status);
    lastStatus = status;
    return status;
  }

  async function step() {
    if (busy) return { busy: true, status: lastStatus };
    busy = true;
    try {
      let allRecords = await records();
      // Keep this order on every tick: a sale written after the inventory read is still represented by its journal.
      const reverseNotes = await reverseInventory.notes();
      const swaps = await reverseSwapRecords();
      const recovered = recoverAmbiguousBroadcasts(allRecords, now());
      for (const halted of recovered.halted) {
        if (!dryRun) await store.put(halted);
        await notify(`halt:${halted.id}`, { level: 'alert', msg: 'reverse rebalance found a broadcasting journal after restart; this outpoint is halted permanently pending manual reconciliation', outpoint: outpointId(halted.note) });
      }
      allRecords = recovered.records;
      for (const record of allRecords.filter((r) => r.state === 'moved')) {
        let result;
        try {
          const [sourceOutspend, broadcastTx, tip] = await Promise.all([
            getJson(`/tx/${record.note.txid}/outspend/${record.note.vout}`),
            getJson(`/tx/${record.broadcastTxid}`), tipHeight(),
          ]);
          result = reconcileMoved({ record, sourceOutspend, broadcastTx, reverseNotes, reverseSwaps: swaps, tipHeight: tip, minConfs: config.minSourceConfs });
        } catch (e) {
          await notify(`reconcile:${record.id}`, { level: 'warn', msg: 'reverse rebalance cannot reconcile a moved note yet', outpoint: outpointId(record.note), error: errorText(e) });
          continue;
        }
        if (result.done) {
          const done = {
            ...record, state: 'done', completedAt: now(), destinationNote: result.destination,
            destinationEvidence: result.destinationEvidence, reverseSwapIds: result.reverseSwapIds || record.reverseSwapIds || [], haltReason: null,
          };
          if (!dryRun) await store.put(done);
          Object.assign(record, done);
          log({ level: 'info', msg: 'reverse rebalance move reconciled with confirmed destination evidence', outpoint: outpointId(record.note), txid: record.broadcastTxid, evidence: result.destinationEvidence });
        }
      }
      for (const record of allRecords.filter((r) => r.state === 'done' && r.broadcastTxid)) {
        let check;
        try {
          const [sourceOutspend, broadcastTx, tip] = await Promise.all([
            getJson(`/tx/${record.note.txid}/outspend/${record.note.vout}`),
            getJson(`/tx/${record.broadcastTxid}`), tipHeight(),
          ]);
          check = reconcileDone({ record, sourceOutspend, broadcastTx, tipHeight: tip, minConfs: config.minSourceConfs });
        } catch (e) { check = { ok: false, transient: true, reason: 'done_monitor_unreadable', error: errorText(e) }; }
        if (!check.ok && check.transient) {
          await notify(`done-retry:${record.id}:${check.reason}`, { level: 'warn', msg: 'a completed funding record cannot be read just now; it remains done and will be checked again', outpoint: outpointId(record.note), error: check.error || check.reason });
          continue;
        }
        if (!check.ok) {
          const halted = {
            ...record, state: 'halted', previousState: 'done', haltedAt: now(), broadcastAttempted: true, exposurePending: true,
            haltReason: check.reason, manualReconciliationRequired: true,
          };
          if (!dryRun) await store.put(halted);
          Object.assign(record, halted);
          await notify(`reorg:${record.id}:${check.reason}`, { level: 'alert', msg: 'a completed funding record lost or changed its chain evidence; exposure is restored and the outpoint needs manual reconciliation', outpoint: outpointId(record.note), error: check.error || check.reason });
        }
      }
      const candidates = await candidatesFromChain(allRecords);
      const statusOf = (extra = {}) => persistStatus({ allRecords, reverseNotes, swaps, candidates, extra });
      if (!config.enabled) return { status: await statusOf({ reason: 'disabled' }), plan: null };
      if (allRecords.some((r) => r.state === 'halted' && r.broadcastAttempted === true)) {
        return { status: await statusOf({ reason: 'manual_broadcast_reconciliation_required' }), plan: null, sent: false };
      }

      const selected = allRecords.find((r) => r.state === 'selected');
      if (selected) {
        if (dryRun) return { status: await statusOf({ reason: 'dry_run_existing_selected' }), plan: selected };
        const moved = await broadcastSelected(selected);
        allRecords = await records();
        return { ...moved, status: await statusOf() };
      }
      if (allRecords.some((r) => r.state === 'moved' || r.state === 'broadcasting')) {
        return { status: await statusOf({ reason: 'awaiting_reconciliation' }), plan: null };
      }

      const excluded = new Set();
      for (;;) {
        const rate = await feeRate().catch((e) => { log({ level: 'warn', msg: 'reverse rebalance fee rate unavailable', error: errorText(e) }); return null; });
        const selection = selectWholeNote({ candidates, records: allRecords, reverseNotes, reverseSwaps: swaps, nowSecs: now(), feeRate: rate, config, excluded });
        if (!selection.note) return { status: await statusOf({ reason: selection.reason, decisions: selection.decisions.map((d) => ({ ...d, amount: d.amount.toString() })) }), plan: null };
        const coin = await chooseCoin(selection.note, allRecords);
        if (!coin) return { status: await statusOf({ reason: 'no_unreserved_confirmed_fee_coin', candidate: outpointId(selection.note) }), plan: null };
        let prepared;
        try { prepared = await prepareExact({ note: selection.note, coin }); }
        catch (e) {
          if (e.code === 'amount_mismatch') {
            excluded.add(outpointId(selection.note));
            await notify(`amount:${outpointId(selection.note)}`, { level: 'alert', msg: 'leased note amount does not match the wallet note or would create change; the lease is skipped', outpoint: outpointId(selection.note) });
            continue;
          }
          throw e;
        }
        const publicPlan = {
          note: { ...prepared.plan.note }, amount: prepared.plan.amount, change: prepared.plan.change,
          mode: prepared.plan.mode, sourceAddress: mainAddress, destination, reverseAddress,
          coin: { ...prepared.plan.coin }, feeRate: prepared.feeRate, maxFeeRate: config.maxFeeRate,
          wholeNote: true, buyerDemandGuaranteed: false,
        };
        if (dryRun) return { status: await statusOf({ reason: 'dry_run_plan' }), plan: publicPlan, selection };
        const record = recordFrom(prepared, now());
        await store.put(record);
        await hooks.afterSelected?.(record);
        const moved = await broadcastSelected(record, prepared);
        allRecords = await records();
        return { ...moved, plan: publicPlan, status: await statusOf() };
      }
    } finally { busy = false; }
  }

  return {
    step,
    records,
    status: () => lastStatus,
    inspect,
  };
}
