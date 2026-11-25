// Price the full swap at the highest risk of its inputs: confidential amounts
// and change cannot safely be used to apportion the incoming lock by class.
const classes = ['clean', 'long', 'shielded'];
const BASE = 10000n;
// A long trace is one deep enough that the original fast lock and its take
// can no longer hide inside a regular burn; 253 leaves that room.
const LONG_HOPS = 253;
// A note's class is re-read at most this often; classify caches its answer so
// a burst of quotes over the same inputs pays for one trace.
const CLASS_TTL_MS = 5 * 60 * 1000;
const CLASS_CACHE_MAX = 64;
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });

export function canonicalNoteInputs(notes) {
  if (!Array.isArray(notes) || notes.length < 1 || notes.length > 6) throw invalid('one to six TAC inputs are required');
  const ids = new Set();
  return notes.map((n) => {
    if (!n || typeof n.txid !== 'string' || !/^[0-9a-f]{64}$/.test(n.txid) ||
        !Number.isInteger(n.vout) || n.vout < 0 || n.vout > 0xffff) throw invalid('invalid TAC input');
    const id = `${n.txid}:${n.vout}`;
    if (ids.has(id)) throw invalid('duplicate TAC input');
    ids.add(id);
    return { txid: n.txid, vout: n.vout };
  });
}

export function sameNoteInputs(want, got) {
  try {
    const a = canonicalNoteInputs(want), b = canonicalNoteInputs(got);
    return a.length === b.length && a.every((n, i) => n.txid === b[i].txid && n.vout === b[i].vout);
  } catch { return false; }
}

export function noteRiskClass(v) {
  if (!v || v.state === 'unread') return 'unread';
  if (v.state === 'tracked') return 'clean';
  // Leave room for the fast lock and its take before a regular burn.
  if (v.state === 'traced' && Number.isInteger(v.hops) && v.hops >= 0) return v.hops > LONG_HOPS ? 'long' : 'clean';
  if (v.state === 'long') return 'long';
  if (v.state === 'unprovable' && v.through === 'shielded') return 'shielded';
  return null;
}

export function makeStuckPricing(config, lineage) {
  const bps = (n) => {
    if (!Number.isSafeInteger(n) || n < 1 || n >= Number(BASE)) throw new Error('stuck pricing requires positive haircut bps below 10000');
    return BigInt(n);
  };
  const units = (name) => {
    const value = config[name];
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,29})$/.test(value)) throw new Error(`stuckPricing.${name} must be a decimal string in TAC base units`);
    return BigInt(value);
  };
  // The haircut is the estimated loss on the stuck TAC, in bps of the locked
  // amount, charged on top of the normal fee. It is an estimate the operator
  // sets, not a measured market price; the normal fee keeps its own margin.
  const haircuts = { clean: 0n, long: bps(config.longHaircutBps), shielded: bps(config.shieldedHaircutBps) };
  if (haircuts.shielded < haircuts.long) throw new Error('the shielded haircut must be at least the long-history haircut');
  const limits = { long: units('longLimit'), shielded: units('shieldedLimit'), total: units('totalLimit') };
  const opening = { long: units('openingLong'), shielded: units('openingShielded') };
  const recovered = config.recoveredSwaps ?? [];
  if (!Array.isArray(recovered) || recovered.some((id) => typeof id !== 'string' || !/^[0-9a-f]{72}$/.test(id))) {
    throw new Error('stuckPricing.recoveredSwaps must contain swap IDs');
  }
  const recoveredIds = new Set(recovered);
  if (typeof lineage !== 'function') throw new Error('stuck pricing needs a lineage reader');
  let readingLegacy = false;

  // The quote flow re-traces a note for every amount it quotes, so its checks
  // (background) share a short cache keyed by the note inputs, order-insensitive.
  // Only a confirmed class is cached: an unreadable or unsupported history keeps
  // failing on every call. The legacy offer check reads fresh — it runs once per
  // swap and must judge the note as it is now. The cache is bound and drops its
  // oldest entry.
  const classCache = new Map();
  const classKey = (inputs) => inputs.map((n) => `${n.txid}:${n.vout}`).sort().join(',');
  async function classify(notes, { background = false, onProgress, signal } = {}) {
    const inputs = canonicalNoteInputs(notes);
    let key, hit;
    if (background) {
      key = classKey(inputs);
      hit = classCache.get(key);
      if (hit && Date.now() - hit.at < CLASS_TTL_MS) return hit.class;
      if (hit) classCache.delete(key);
    }
    // The quote service bounds its background checks separately. Leave a lane
    // for old clients that reach lineage verification at the offer step.
    if (!background && readingLegacy) throw invalid('TAC history is being checked, try again shortly', 503);
    if (!background) readingLegacy = true;
    try {
      let found;
      try { found = await lineage(inputs, { onProgress, signal }); } catch { throw invalid('TAC history is temporarily unreadable', 503); }
      let rank = 0;
      for (const { txid, vout } of inputs) {
        const v = found?.get(`${txid}:${vout}`);
        const kind = noteRiskClass(v);
        if (kind === 'unread') throw invalid('TAC history is temporarily unreadable', 503);
        if (!kind) throw invalid('this TAC history is outside the provider’s supported classes', 422);
        rank = Math.max(rank, classes.indexOf(kind));
      }
      const cls = classes[rank];
      if (background) {
        if (classCache.size >= CLASS_CACHE_MAX) classCache.delete(classCache.keys().next().value);
        classCache.set(key, { class: cls, at: Date.now() });
      }
      return cls;
    } finally { if (!background) readingLegacy = false; }
  }

  function fits(used, kind, amount) {
    if (kind === 'clean') return true;
    const exposure = (k) => used[k] + opening[k];
    return exposure(kind) + amount <= limits[kind] &&
      exposure('long') + exposure('shielded') + amount <= limits.total;
  }
  // An opening exposure already past a cap is a valid "drain to target" state
  // (a migration in flight), not a hard error. Each new risky swap must still
  // fit its own class and the combined cap; an unrelated class is not paused.
  const tac = (v) => {
    const s = v.toString().padStart(9, '0');
    const frac = s.slice(-8).replace(/0+$/, '');
    return `${s.slice(0, -8)}${frac ? `.${frac}` : ''}`;
  };
  const blocked = (opening.long > limits.long || opening.shielded > limits.shielded || opening.long + opening.shielded > limits.total)
    ? `stuck TAC opening exposure exceeds an acceptance cap (opening long ${tac(opening.long)}, shielded ${tac(opening.shielded)}; caps long ${tac(limits.long)}, shielded ${tac(limits.shielded)}, total ${tac(limits.total)}); independent class and total limits still apply; reconcile the opening amounts after verified recovery`
    : null;
  return { classify, fits, recovered: (rec) => rec.phase === 'done' && recoveredIds.has(rec.id), haircutFee: (amount, kind) => (amount * haircuts[kind] + BASE - 1n) / BASE, blocked };
}
