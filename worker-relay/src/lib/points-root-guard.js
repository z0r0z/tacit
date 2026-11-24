// What a reward root must satisfy before the root setter's key signs it, checked against what this service last published and what the
// distributor holds now. Pure, so it is tested without a chain.
//
//   tree              the tree about to be published: { root, totalWei, claims: { [address]: { cumulativeAmount } } }
//   publishedAmounts  [[address, cumulativeAmount]] of the last tree this service published (empty before the first)
//   publishedTotalWei the total that tree declared, or null before the first
//   publishedRoot     the root that tree has, or null
//   onchain           { root, totalAllocated } as the distributor holds them now
//   known             roots this service has sent (kept across restarts), plus any named in POINTS_ROOT_ACCEPT
//
// → string[] of reasons to hold the publish; empty when it may go.
const ZERO_ROOT = '0x' + '0'.repeat(64);
const lc = (s) => String(s).toLowerCase();

export function rootProblems({ tree, publishedAmounts = [], publishedTotalWei = null, publishedRoot = null, onchain, known = [] }) {
  const why = [];
  const claims = tree.claims || {};
  const at = new Map(Object.entries(claims).map(([a, c]) => [lc(a), BigInt(c.cumulativeAmount)]));
  let sum = 0n;
  for (const v of at.values()) sum += v;
  if (sum !== BigInt(tree.totalWei)) why.push(`the leaves add to ${sum}, the tree declares ${tree.totalWei}`);
  if (publishedTotalWei != null && BigInt(tree.totalWei) < BigInt(publishedTotalWei)) why.push(`the total ${tree.totalWei} is below the published ${publishedTotalWei}`);
  const lower = [];
  for (const [a, amt] of publishedAmounts) {
    if ((at.get(lc(a)) ?? 0n) < BigInt(amt)) lower.push(a);
  }
  if (lower.length) why.push(`${lower.length} account(s) would hold less than they do in the published tree (${lower.slice(0, 3).join(', ')})`);
  if (onchain) {
    const have = lc(onchain.root);
    const expected = new Set([publishedRoot, tree.root, ...known].filter(Boolean).map(lc));
    const fresh = have === ZERO_ROOT && BigInt(onchain.totalAllocated ?? 0) === 0n && publishedRoot == null;
    if (!fresh && !expected.has(have)) why.push(`the distributor's root ${onchain.root} is not one this service sent`);
    if (publishedTotalWei != null && BigInt(onchain.totalAllocated ?? 0) > BigInt(publishedTotalWei) && !expected.has(have)) {
      why.push(`the distributor declares ${onchain.totalAllocated}, over the ${publishedTotalWei} this service published`);
    }
  }
  return why;
}

// The roots a publish has sent (newest last), kept as a short list so a send whose receipt was missed is still recognised.
export const SENT_ROOTS_KEY = 'points-roots-sent';
export const SENT_ROOTS_MAX = 8;
export function parseSent(raw) {
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter((r) => /^0x[0-9a-fA-F]{64}$/.test(String(r))) : []; } catch { return []; }
}
export function withSent(list, root) {
  return [...list.filter((r) => lc(r) !== lc(root)), root].slice(-SENT_ROOTS_MAX);
}
export const parseAccept = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter((s) => /^0x[0-9a-fA-F]{64}$/.test(s));
