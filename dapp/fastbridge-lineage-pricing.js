// Pricing TAC by what the bridge's proof can follow. The classes are the risk a provider takes home:
// clean (tracked or traced inside the burn proof's bound), long (over that bound), and pool-exit
// (a history the proof cannot follow; every unprovable kind is priced in this most conservative class).
// The configured fees are additions to the provider's ordinary fee, so they read directly as the
// haircut the operator is willing to be paid for.

export const LINEAGE_CLASSES = ['clean', 'long', 'pool-exit'];
const CONFIG_KEYS = { clean: 'clean', long: 'long', 'pool-exit': 'poolExit', poolExit: 'poolExit' };
const RANK = { clean: 0, long: 1, 'pool-exit': 2 };

export const classKey = (cls) => CONFIG_KEYS[cls] || null;
export const className = (cls) => (cls === 'poolExit' ? 'pool-exit' : LINEAGE_CLASSES.includes(cls) ? cls : null);

export function verdictClass(v) {
  if (!v || v.state === 'unread') return 'unread';
  if (v.state === 'long') return 'long';
  if (v.state === 'unprovable') return 'pool-exit';
  return 'clean';
}

export function classifyVerdicts(inputs, verdicts) {
  let cls = 'clean';
  const notes = [], unread = [];
  for (const n of inputs || []) {
    const id = `${n.txid}:${n.vout}`, got = verdicts && verdicts.get(id), c = verdictClass(got);
    if (c === 'unread') { unread.push(id); continue; }
    if (RANK[c] > RANK[cls]) cls = c;
    notes.push({ txid: n.txid, vout: n.vout, class: c, verdict: got });
  }
  return unread.length ? { class: 'unread', unread, notes } : { class: cls, notes };
}

export function normalizeLineageInputs(inputs, { max = 64 } = {}) {
  if (inputs == null) return null;
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > max) throw Object.assign(new Error(`inputs must be 1 to ${max} note outpoints`), { status: 400 });
  const seen = new Set(), out = [];
  for (const n of inputs) {
    const txid = String(n && n.txid || '').toLowerCase(), vout = Number(n && n.vout);
    if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(vout) || vout < 0 || vout > 0xffff) throw Object.assign(new Error('inputs must name note outpoints as txid:vout'), { status: 400 });
    const id = `${txid}:${vout}`;
    if (seen.has(id)) throw Object.assign(new Error('inputs must not repeat an outpoint'), { status: 400 });
    seen.add(id); out.push({ txid, vout });
  }
  return out.sort((a, b) => `${a.txid}:${a.vout}` < `${b.txid}:${b.vout}` ? -1 : 1);
}

export function sameLineageInputs(a, b) {
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  const aa = normalizeLineageInputs(a), bb = normalizeLineageInputs(b);
  return aa.every((n, i) => n.txid === bb[i].txid && n.vout === bb[i].vout);
}

export function makeLineageClassScreen(vet, { refusePoolExit = false } = {}) {
  return async (inputs) => {
    let verdicts;
    try { verdicts = await vet(inputs); } catch { return { why: 'the history of the notes could not be read just now', retry: true }; }
    const c = classifyVerdicts(inputs, verdicts);
    if (c.class === 'unread') return { why: 'the history of a note could not be read just now', retry: true };
    if (refusePoolExit && c.class === 'pool-exit') return { why: 'a note this lock spends has a history the bridge\'s proof does not follow, which this provider does not take' };
    return { class: c.class, notes: c.notes };
  };
}

const amount = (v, name) => {
  try { const b = BigInt(v ?? 0); if (b >= 0n) return b; } catch { }
  throw new Error(`${name} must be a whole number of base units`);
};
const bps = (v, name) => {
  const n = Number(v ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > 9000) throw new Error(`${name} must be 0 to 9000 basis points`);
  return n;
};

// quote.lineageFees: additions to quote.feeBps/flatFee by class. `defaultClass` is the class a request
// that names none is priced as; pool-exit is the safe default because an old client can lock either kind.
export function normalizeLineageFees(x) {
  if (!x) return null;
  const one = (o, key) => ({ feeBps: bps(o && o.feeBps, `lineageFees.${key}.feeBps`), flatFee: amount(o && o.flatFee, `lineageFees.${key}.flatFee`) });
  const cap = (v, key) => (v == null ? null : amount(v, `lineageFees.caps.${key}`));
  const out = {
    defaultClass: classKey(x.defaultClass || 'pool-exit') ? (x.defaultClass || 'pool-exit') : null,
    clean: one(x.clean, 'clean'), long: one(x.long, 'long'), poolExit: one(x.poolExit, 'poolExit'),
    ...(x.caps ? { caps: { long: cap(x.caps.long, 'long'), poolExit: cap(x.caps.poolExit, 'poolExit'), total: cap(x.caps.total, 'total') } } : {}),
  };
  if (!out.defaultClass) throw new Error('lineageFees.defaultClass must be clean, long or pool-exit');
  return out;
}

export function lineageClassOf(x, fees) {
  if (x == null || x === '') return fees.defaultClass;
  const key = classKey(x);
  if (!key) throw Object.assign(new Error('lineage must be clean, long or pool-exit'), { status: 400 });
  return key === 'poolExit' ? 'pool-exit' : key;
}

export function lineageTerms(base, fees, cls) {
  const key = classKey(cls), add = fees && key ? fees[key] : null;
  return {
    feeBps: BigInt(base.feeBps ?? 0) + BigInt(add ? add.feeBps : 0),
    flatFee: BigInt(base.flatFee ?? 0) + (add ? add.flatFee : 0n),
    class: key === 'poolExit' ? 'pool-exit' : key || cls,
  };
}

export function lineageInfo(fees) {
  if (!fees) return null;
  const one = (x) => ({ feeBps: x.feeBps, flatFee: String(x.flatFee) });
  return {
    addedToBaseFee: true,
    exactInputs: true,
    defaultClass: fees.defaultClass === 'poolExit' ? 'pool-exit' : fees.defaultClass,
    classes: { clean: one(fees.clean), long: one(fees.long), 'pool-exit': one(fees.poolExit) },
    ...(fees.caps ? { caps: { ...(fees.caps.long != null ? { long: String(fees.caps.long) } : {}), ...(fees.caps.poolExit != null ? { poolExit: String(fees.caps.poolExit) } : {}), ...(fees.caps.total != null ? { total: String(fees.caps.total) } : {}) } } : {}),
  };
}

// Caps are in base units of face value and cover the stuck classes only: long and pool-exit. A missing cap is unbounded;
// zero means the class is not taken. `exposure` is { long, poolExit } in BigInt base units, counting reserved, in-flight
// and completed-but-unrecovered face value.
export function lineageCapAllows(fees, exposure, cls, addition) {
  const key = classKey(cls);
  if (!fees || !fees.caps || key === 'clean') return true;
  const k = key === 'poolExit' ? 'poolExit' : key, a = BigInt(addition);
  const long = BigInt(exposure && exposure.long || 0n), poolExit = BigInt(exposure && exposure.poolExit || 0n), here = k === 'long' ? long : poolExit;
  const cap = fees.caps[k];
  if (cap != null && here + a > cap) return false;
  const total = fees.caps.total;
  return total == null || long + poolExit + a <= total;
}

// The most a class-aware quote can add under a public lineagePricing schedule, in the shape /info serves.
// The rate part and the flat part are each maximized on their own, so this can overstate a class whose additions
// are mixed; that is the safe single fee schedule an old, class-blind reader can use.
export function worstLineagePricing(info) {
  const cs = info && info.classes ? ['clean', 'long', 'pool-exit'].map((k) => info.classes[k]).filter(Boolean) : [];
  if (!cs.length) return null;
  return {
    feeBps: Math.max(0, ...cs.map((x) => Number(x.feeBps) || 0)),
    flatFee: cs.reduce((a, x) => { try { const b = BigInt(x.flatFee ?? 0); return b > a ? b : a; } catch { return a; } }, 0n),
  };
}
