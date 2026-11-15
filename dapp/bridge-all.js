
export const MAX_MERGE_INPUTS = 10;

const rawOf = (n) => BigInt(n?.amount ?? 0);
const idOf = (n) => `${n.txid}:${n.vout}`;
const bigger = (a, b) => (rawOf(a) > rawOf(b) ? -1 : rawOf(a) < rawOf(b) ? 1 : idOf(a) < idOf(b) ? -1 : 1);

export function packNotes(notes, capRaw, maxInputs = MAX_MERGE_INPUTS) {
  const cap = BigInt(capRaw), packs = [];
  for (const n of [...notes].sort(bigger)) {
    const pack = packs.find((p) => p.notes.length < maxInputs && p.total + rawOf(n) <= cap);
    if (pack) { pack.notes.push(n); pack.total += rawOf(n); } else packs.push({ notes: [n], total: rawOf(n) });
  }
  return packs.sort((a, b) => (a.total > b.total ? -1 : a.total < b.total ? 1 : 0));
}

function sort(notes) {
  const out = { tracked: [], untracked: [], skipped: [] };
  for (const n of notes) {
    if (!n.eligible) out.skipped.push({ note: n, why: 'unavailable' });
    else if (rawOf(n) <= 0n) out.skipped.push({ note: n, why: 'empty' });
    else if (n.tracking === 'tracked') out.tracked.push(n);
    else if (n.tracking === 'untracked') out.untracked.push(n);
    else out.skipped.push({ note: n, why: n.tracking === 'new' ? 'recent' : n.tracking === 'bound' ? 'bound' : 'unknown' });
  }
  return out;
}
const isPrivate = (n) => !!n.stealthTweakedSk || n.form === 'private';

export function planMerge(notes, { capRaw, maxInputs = MAX_MERGE_INPUTS }) {
  const s = sort(notes), mergeable = s.tracked.filter((n) => !isPrivate(n));
  const packs = packNotes(mergeable, capRaw, maxInputs);
  return {
    groups: packs.filter((p) => p.notes.length > 1),
    left: [...packs.filter((p) => p.notes.length === 1).flatMap((p) => p.notes), ...s.tracked.filter(isPrivate), ...s.untracked],
    skipped: s.skipped,
  };
}

export function planAll(notes, { capRaw, maxInputs = MAX_MERGE_INPUTS }) {
  const s = sort(notes), plain = s.tracked.filter((n) => !isPrivate(n));
  return {
    burns: plain.filter((n) => n.form !== 'old').sort(bigger),
    sends: packNotes(plain.filter((n) => n.form === 'old'), capRaw, maxInputs),
    privates: s.tracked.filter(isPrivate).sort(bigger),
    checks: s.untracked.sort(bigger),
    skipped: s.skipped,
  };
}

// The notes a holder ticks, merged in one transfer to their own address: one note when they come to the cap or less, else the cap and
// the rest. They must all be of one kind, so the merged note is too: notes Bitcoin's proof tracks, or notes it does not (those bridge by
// a move and a burn, whose proof walks the merged note's whole history back to the etch, so the page checks each note's history first).
export function planPick(notes, ids, { capRaw, maxInputs = MAX_MERGE_INPUTS }) {
  const cap = BigInt(capRaw), want = new Set(ids), picked = notes.filter((n) => want.has(idOf(n)));
  const out = (why, extra = {}) => ({ ok: !why, why, notes: picked, kind: null, total: 0n, send: 0n, keep: 0n, max: maxInputs, ...extra });
  if (picked.length < 2) return out('few');
  if (picked.length > maxInputs) return out('inputs');
  const bad = picked.find((n) => !n.eligible || rawOf(n) <= 0n || isPrivate(n) || (n.tracking !== 'tracked' && n.tracking !== 'untracked'));
  if (bad) return out('unmergeable', { bad });
  if (new Set(picked.map((n) => n.tracking)).size > 1) return out('mixed');
  const total = picked.reduce((s, n) => s + rawOf(n), 0n), kind = picked[0].tracking;
  if (total > 2n * cap) return out('over', { kind, total });
  const send = total > cap ? cap : total;
  return out(null, { notes: [...picked].sort(bigger), kind, total, send, keep: total - send });
}

export const countAll = (plan) => plan.burns.length + plan.sends.reduce((n, g) => n + g.notes.length, 0) + plan.privates.length + plan.checks.length;

export function opsCompared(mergePlan, allPlan) {
  const alone = mergePlan.left.filter((n) => n.tracking === 'tracked' && !isPrivate(n));
  return {
    all: allPlan.burns.length + 2 * allPlan.sends.length,
    merge: 2 * mergePlan.groups.length + alone.reduce((s, n) => s + (n.form === 'old' ? 2 : 1), 0),
  };
}
