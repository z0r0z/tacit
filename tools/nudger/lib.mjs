// Shared parts of the daily review: which files and commits are worth a reviewer's time, and the numbered view of a diff a reviewer reads.

// Code that moves value or carries the protocol. Tests, docs, data directories and vendored or minified files are not reviewed.
export const IN_SCOPE = /^(dapp|worker\/src|server|helpdesk)\/.+\.(js|mjs)$/;
export const OUT_OF_SCOPE = /(^|\/)(vendor|node_modules|evm-pool|btc-pool|airdrop)\/|\.min\.js$/;
export const inScope = (file) => IN_SCOPE.test(file) && !OUT_OF_SCOPE.test(file);

const STAMP = /\?cb=[0-9a-f]{8}/g;
const norm = (l) => l.replace(STAMP, '?cb=');

// A unified diff as lines a reviewer can point at: ' ' and '+' lines carry their new-file number, '-' lines carry none. `changed` counts the lines that
// really differ: a line that only moved, or whose only change is a page's cache-bust stamp, is not a change worth reviewing.
export function numberedDiff(diffText) {
  const out = [], added = [], removed = [];
  let n = 0;
  for (const l of diffText.split('\n')) {
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (h) { n = Number(h[1]); out.push(`@@ line ${n} @@${h[2]}`); continue; }
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|\\ No newline)/.test(l)) continue;
    if (l.startsWith('+')) { out.push(`${String(n).padStart(5)} +${l.slice(1)}`); added.push(norm(l.slice(1))); n++; }
    else if (l.startsWith('-')) { out.push(`      -${l.slice(1)}`); removed.push(norm(l.slice(1))); }
    else if (l.startsWith(' ')) { out.push(`${String(n).padStart(5)}  ${l.slice(1)}`); n++; }
  }
  const gone = new Set(removed), came = new Set(added);
  const changed = added.filter((x) => !gone.has(x)).length + removed.filter((x) => !came.has(x)).length;
  return { text: out.join('\n'), changed, lines: out.length };
}

// "24h", "90m" or "7d" -> milliseconds; anything else is an error.
export function parseSpan(s) {
  const m = String(s).match(/^(\d+)(m|h|d)$/);
  if (!m) throw new Error(`bad span "${s}": use 90m, 24h or 7d`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
}

export const SEVERITY_RANK = { high: 3, med: 2, low: 1 };

// The verifier's findings -> the digest: refuted ones are dropped, verified ones come first, then those that hinge on a fact outside the code, each by
// severity; at most `maxReal` of the first kind, `maxOutside` of the second and `perCommit` from any one commit. Ids run n<YYMMDD>-<k> in that order.
export function buildDigest(findings, commits, { day, maxReal = 3, maxOutside = 2, perCommit = 2 } = {}) {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const rank = (f) => SEVERITY_RANK[f.severity] || 1;
  const live = findings.filter((f) => f.verdict === 'REAL' || f.verdict === 'UNCERTAIN');
  const pick = (verdict, max, taken) => live.filter((f) => f.verdict === verdict).sort((a, b) => rank(b) - rank(a)).filter((f) => {
    const c = taken.get(f.commit) || 0;
    if (c >= perCommit) return false;
    taken.set(f.commit, c + 1);
    return true;
  }).slice(0, max);
  const taken = new Map();
  const chosen = [...pick('REAL', maxReal, taken), ...pick('UNCERTAIN', maxOutside, taken)];
  const stamp = `n${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}-`;
  return {
    day,
    reviewed: commits.length,
    findings: chosen.map((f, i) => ({
      id: `${stamp}${i + 1}`,
      file: f.file, line: f.line, commit: f.commit,
      subject: bySha.get(f.commit)?.subject || '',
      claim: f.claim, evidence: f.evidence, severity: f.severity,
      status: f.verdict === 'REAL' ? 'real' : 'outside',
    })),
  };
}
