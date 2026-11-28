// Pricing and policy rule for stuck TAC (long-history >255 hops and pool-exit / unprovable notes).
// Zero external dependencies; plain ESM compatible with Node 18+/22+ and browser dapp modules.

export const NOTE_CLASSES = Object.freeze(['clean', 'long', 'pool_exit']);
export const CLASS_RANK = Object.freeze({ clean: 0, long: 1, pool_exit: 2 });
export const CLASS_CODE = Object.freeze({ clean: '00', long: '01', pool_exit: '02' });
export const CODE_TO_CLASS = Object.freeze({ '00': 'clean', '01': 'long', '02': 'pool_exit' });
export const BPS_DENOM = 10000n;
export const MAX_FEE_BPS = 5000;

export function isNoteClass(v) {
  return v === 'clean' || v === 'long' || v === 'pool_exit';
}

export function normalizeNoteClass(v) {
  if (v == null || v === '') return 'clean';
  if (!isNoteClass(v)) {
    throw Object.assign(new Error(`unknown noteClass: ${String(v)}`), { status: 400, code: 'invalid_note_class' });
  }
  return v;
}

export function classRank(cls) {
  return CLASS_RANK[normalizeNoteClass(cls)];
}

export function classifyVerdict(verdict) {
  if (!verdict || verdict.state === 'unread') return null;
  if (verdict.state === 'tracked' || verdict.state === 'traced') return 'clean';
  if (verdict.state === 'long') return 'long';
  if (verdict.state === 'unprovable') return 'pool_exit';
  return null;
}

export function classifyInputs(inputs, verdicts) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { ok: false, retry: false, reason: 'lock has no TAC inputs' };
  }
  let worst = 'clean';
  const unread = [];
  const counts = { clean: 0, long: 0, pool_exit: 0 };
  for (const n of inputs) {
    const id = `${n.txid}:${n.vout}`;
    const v = verdicts instanceof Map ? verdicts.get(id) : verdicts?.[id];
    const cls = classifyVerdict(v);
    if (!cls) { unread.push(id); continue; }
    counts[cls]++;
    if (CLASS_RANK[cls] > CLASS_RANK[worst]) worst = cls;
  }
  if (unread.length > 0) {
    return { ok: false, retry: true, unread, reason: 'the history of a note could not be read just now' };
  }
  return { ok: true, noteClass: worst, counts };
}

function toBigIntFloor(v, label) {
  if (v == null) return null;
  try {
    const b = BigInt(v);
    if (b < 0n) throw new Error(`${label} must be >= 0`);
    return b;
  } catch {
    throw new Error(`invalid ${label}: ${String(v)}`);
  }
}

function toNonNegInt(v, label, max = MAX_FEE_BPS) {
  if (v == null) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new Error(`invalid ${label}: ${String(v)} (expected integer 0..${max})`);
  }
  return n;
}

export function normalizeStuckPolicy(raw) {
  if (!raw || raw.enabled !== true) {
    return Object.freeze({
      enabled: false,
      maxStuckShare: 0,
      maxStuckUnits: 0n,
      classes: Object.freeze({
        clean: Object.freeze({ enabled: true, extraBps: 0, extraFlatFee: 0n, maxAmount: null, utilizationSlopeBps: 0 }),
        long: Object.freeze({ enabled: false, extraBps: 0, extraFlatFee: 0n, maxAmount: null, utilizationSlopeBps: 0 }),
        pool_exit: Object.freeze({ enabled: false, extraBps: 0, extraFlatFee: 0n, maxAmount: null, utilizationSlopeBps: 0 }),
      }),
    });
  }
  const maxStuckShare = raw.maxStuckShare == null ? null : Number(raw.maxStuckShare);
  if (maxStuckShare !== null && (!Number.isFinite(maxStuckShare) || maxStuckShare <= 0 || maxStuckShare > 0.5)) {
    throw new Error(`invalid maxStuckShare: ${String(raw.maxStuckShare)} (expected 0 < share <= 0.5)`);
  }
  const maxStuckUnits = toBigIntFloor(raw.maxStuckUnits, 'maxStuckUnits');
  if (maxStuckUnits !== null && maxStuckUnits <= 0n) {
    throw new Error('maxStuckUnits must be > 0 when specified');
  }
  if (maxStuckShare === null && maxStuckUnits === null) {
    throw new Error('stuckPolicy requires at least one hard cap: maxStuckShare or maxStuckUnits');
  }
  const parseClass = (name, cfg) => {
    if (!cfg || cfg.enabled !== true) {
      return Object.freeze({ enabled: false, extraBps: 0, extraFlatFee: 0n, maxAmount: null, utilizationSlopeBps: 0 });
    }
    const minFloor = toNonNegInt(cfg.minHaircutBps ?? 1, `${name}.minHaircutBps`);
    const extraBps = toNonNegInt(cfg.extraBps, `${name}.extraBps`);
    if (extraBps < minFloor) {
      throw new Error(`${name}.extraBps (${extraBps}) is below configured floor minHaircutBps (${minFloor})`);
    }
    const utilizationSlopeBps = toNonNegInt(cfg.utilizationSlopeBps ?? 0, `${name}.utilizationSlopeBps`);
    const extraFlatFee = toBigIntFloor(cfg.extraFlatFee ?? 0n, `${name}.extraFlatFee`) ?? 0n;
    const maxAmount = toBigIntFloor(cfg.maxAmount, `${name}.maxAmount`);
    return Object.freeze({ enabled: true, extraBps, minHaircutBps: minFloor, extraFlatFee, maxAmount, utilizationSlopeBps });
  };
  return Object.freeze({
    enabled: true,
    maxStuckShare,
    maxStuckUnits,
    classes: Object.freeze({
      clean: Object.freeze({ enabled: true, extraBps: 0, extraFlatFee: 0n, maxAmount: null, utilizationSlopeBps: 0 }),
      long: parseClass('long', raw.classes?.long),
      pool_exit: parseClass('pool_exit', raw.classes?.pool_exit),
    }),
  });
}

export function effectiveStuckCap(policy, totalInventoryUnits) {
  if (!policy.enabled) return 0n;
  const caps = [];
  if (policy.maxStuckUnits !== null) caps.push(policy.maxStuckUnits);
  if (policy.maxStuckShare !== null) {
    const total = BigInt(totalInventoryUnits ?? 0n);
    const shareBps = BigInt(Math.floor(policy.maxStuckShare * 10000));
    caps.push((total * shareBps) / BPS_DENOM);
  }
  if (caps.length === 0) return 0n;
  return caps.reduce((a, b) => (a < b ? a : b));
}

export function evaluateClassPricing({
  policy, noteClass = 'clean', amount, baseFeeBps = 0, baseFlatFee = 0n, baseMaxAmount = null,
  inventory = { totalUnits: 0n, stuckUnits: 0n, pendingStuckUnits: 0n },
}) {
  const cls = normalizeNoteClass(noteClass);
  const amt = BigInt(amount);
  const baseBps = BigInt(baseFeeBps);
  const baseFlat = BigInt(baseFlatFee);
  if (cls === 'clean') {
    return { ok: true, noteClass: 'clean', feeBps: Number(baseBps), extraBps: 0, dynamicBps: 0, flatFee: baseFlat, capRemaining: null };
  }
  if (!policy.enabled) {
    return { ok: false, status: 400, code: 'stuck_disabled', reason: `provider does not accept ${cls} TAC` };
  }
  const rule = policy.classes[cls];
  if (!rule || !rule.enabled) {
    return { ok: false, status: 400, code: 'class_disabled', reason: `provider does not accept ${cls} TAC` };
  }
  const capMax = rule.maxAmount !== null && baseMaxAmount !== null
    ? (rule.maxAmount < BigInt(baseMaxAmount) ? rule.maxAmount : BigInt(baseMaxAmount))
    : (rule.maxAmount ?? (baseMaxAmount !== null ? BigInt(baseMaxAmount) : null));
  if (capMax !== null && amt > capMax) {
    return { ok: false, status: 400, code: 'class_max_amount', reason: `amount exceeds ${cls} class limit of ${capMax}` };
  }
  const hardCap = effectiveStuckCap(policy, inventory.totalUnits);
  const currentStuck = BigInt(inventory.stuckUnits ?? 0n) + BigInt(inventory.pendingStuckUnits ?? 0n);
  const afterStuck = currentStuck + amt;
  if (hardCap <= 0n || afterStuck > hardCap) {
    const rem = hardCap > currentStuck ? hardCap - currentStuck : 0n;
    return { ok: false, status: 409, code: 'stuck_cap_reached', reason: `stuck TAC inventory cap reached (remaining: ${rem})`, capRemaining: rem };
  }
  const dynamicBps = rule.utilizationSlopeBps > 0 && hardCap > 0n
    ? Number((BigInt(rule.utilizationSlopeBps) * afterStuck + hardCap - 1n) / hardCap)
    : 0;
  const totalFeeBps = Number(baseBps) + rule.extraBps + dynamicBps;
  if (totalFeeBps > MAX_FEE_BPS) {
    return { ok: false, status: 400, code: 'fee_exceeds_ceiling', reason: `computed fee (${totalFeeBps} bps) exceeds safety ceiling` };
  }
  return { ok: true, noteClass: cls, feeBps: totalFeeBps, extraBps: rule.extraBps, dynamicBps, flatFee: baseFlat + rule.extraFlatFee, capRemaining: hardCap - afterStuck };
}

export function priceWithClass({
  policy, noteClass = 'clean', amount, minAmount, maxAmount, baseFeeBps = 0, baseFlatFee = 0n,
  rate = { num: 1n, den: 1n }, inventory,
}) {
  const a = BigInt(amount), min = BigInt(minAmount), max = BigInt(maxAmount);
  if (a < min || a > max) throw Object.assign(new Error(`the amount must be between ${min} and ${max}`), { status: 400 });
  const evalRes = evaluateClassPricing({ policy, noteClass, amount: a, baseFeeBps, baseFlatFee, baseMaxAmount: max, inventory });
  if (!evalRes.ok) throw Object.assign(new Error(evalRes.reason), { status: evalRes.status, code: evalRes.code });
  const num = BigInt(rate?.num ?? 1n), den = BigInt(rate?.den ?? 1n);
  const fee = (a * BigInt(evalRes.feeBps)) / BPS_DENOM + evalRes.flatFee;
  const out = ((a - fee) * num) / den;
  if (a <= fee || out <= 0n) throw Object.assign(new Error('the amount does not cover the fee'), { status: 400 });
  return { btcValue: a, evmAmount: out, fee, noteClass: evalRes.noteClass, feeBps: evalRes.feeBps, extraBps: evalRes.extraBps, dynamicBps: evalRes.dynamicBps, capRemaining: evalRes.capRemaining };
}

export function advertiseStuckPolicy({ policy, baseFeeBps, baseFlatFee = 0n, baseMaxAmount, inventory }) {
  if (!policy || !policy.enabled) return undefined;
  const hardCap = effectiveStuckCap(policy, inventory?.totalUnits ?? 0n);
  const used = BigInt(inventory?.stuckUnits ?? 0n) + BigInt(inventory?.pendingStuckUnits ?? 0n);
  const remaining = hardCap > used ? hardCap - used : 0n;
  const classes = {};
  for (const cls of ['long', 'pool_exit']) {
    const rule = policy.classes[cls];
    if (!rule?.enabled) continue;
    const maxAmt = rule.maxAmount !== null && baseMaxAmount != null
      ? (rule.maxAmount < BigInt(baseMaxAmount) ? rule.maxAmount : BigInt(baseMaxAmount))
      : (rule.maxAmount ?? (baseMaxAmount != null ? BigInt(baseMaxAmount) : null));
    const effMax = maxAmt !== null && remaining < maxAmt ? remaining : maxAmt;
    classes[cls] = {
      feeBps: Number(baseFeeBps) + rule.extraBps,
      extraBps: rule.extraBps,
      utilizationSlopeBps: rule.utilizationSlopeBps,
      flatFee: String(BigInt(baseFlatFee) + rule.extraFlatFee),
      maxAmount: effMax !== null ? String(effMax) : null,
      available: remaining > 0n,
    };
  }
  if (Object.keys(classes).length === 0) return undefined;
  return { v: 1, capRemaining: String(remaining), classes };
}

export function makeClassPolicyScreen({ vet, policy, getInventory }) {
  return async (inputs, quote = null) => {
    const verdicts = await vet(inputs);
    const res = classifyInputs(inputs, verdicts);
    if (!res.ok) return { why: res.reason, retry: res.retry === true };
    const actualClass = res.noteClass;
    const quotedClass = normalizeNoteClass(quote?.noteClass ?? 'clean');
    if (CLASS_RANK[actualClass] > CLASS_RANK[quotedClass]) {
      return { why: `lock spends ${actualClass} TAC but quote only priced ${quotedClass} TAC`, retry: false };
    }
    if (actualClass === 'clean') return null;
    if (!policy?.enabled || !policy.classes[actualClass]?.enabled) {
      return { why: `this provider does not take ${actualClass} TAC`, retry: false };
    }
    if (typeof getInventory === 'function' && quote?.btcValue != null) {
      const inv = await getInventory();
      const hardCap = effectiveStuckCap(policy, inv.totalUnits);
      const used = BigInt(inv.stuckUnits ?? 0n) + BigInt(inv.pendingStuckUnits ?? 0n);
      if (used + BigInt(quote.btcValue) > hardCap) {
        return { why: 'stuck TAC inventory cap would be exceeded by this lock', retry: false };
      }
    }
    return null;
  };
}

export const SEALED_QUOTE_V2 = /^02[0-9a-f]{122}$/;
const WIDTHS = [8, 8, 8, 16, 32];

export function encodeSealedQuoteV2({ quote, macOf, randomHex }) {
  const cls = normalizeNoteClass(quote.noteClass ?? 'clean');
  const parts = [quote.created, quote.validUntil, quote.takeSats, quote.btcValue, quote.evmAmount]
    .map((v, i) => BigInt(v).toString(16).padStart(WIDTHS[i], '0'));
  if (parts.some((h, i) => h.length !== WIDTHS[i])) return null;
  const body = '02' + CLASS_CODE[cls] + parts.join('') + randomHex(8);
  return body + macOf(body);
}

export function decodeSealedQuoteV2({ id, macOf, params }) {
  if (!SEALED_QUOTE_V2.test(String(id))) return null;
  const body = id.slice(0, 92);
  const mac = macOf(body);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= mac.charCodeAt(i) ^ id.charCodeAt(92 + i);
  if (diff !== 0) return null;
  const cls = CODE_TO_CLASS[body.slice(2, 4)];
  if (!cls) return null;
  let at = 4;
  const [created, validUntil, takeSats, btcValue, evmAmount] = WIDTHS.map((w) => {
    const v = BigInt('0x' + body.slice(at, at + w)); at += w; return v;
  });
  const q = {
    id, noteClass: cls, btcAsset: params.btcAsset, btcValue: String(btcValue), evmAsset: params.evmAsset,
    evmAmount: String(evmAmount), claimPub: params.claimPub, csvBlocks: params.csvBlocks,
    evmWindowSecs: params.evmWindowSecs, minConfs: params.minConfsFor(btcValue),
    takeSats: Number(takeSats), created: Number(created), validUntil: Number(validUntil),
  };
  if (params.takeInLock === true && q.takeSats > 0) q.takeInLock = true;
  q.legVouts = 1;
  return q;
}
