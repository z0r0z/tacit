
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

export const countAll = (plan) => plan.burns.length + plan.sends.reduce((n, g) => n + g.notes.length, 0) + plan.privates.length + plan.checks.length;

export function opsCompared(mergePlan, allPlan) {
  const alone = mergePlan.left.filter((n) => n.tracking === 'tracked' && !isPrivate(n));
  return {
    all: allPlan.burns.length + 2 * allPlan.sends.length,
    merge: 2 * mergePlan.groups.length + alone.reduce((s, n) => s + (n.form === 'old' ? 2 : 1), 0),
  };
}
