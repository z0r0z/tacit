// The environment tacit-block-node is started with: its own TACIT_NODE_* settings and what a process needs to run (PATH, HOME, locale, time
// zone, RUST_*), and nothing else of the leader's, so the leader's keys and tokens stay with the leader.
const KEEP = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'PORT']);
export function nodeEnv(env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (KEEP.has(k) || k.startsWith('TACIT_NODE_') || k.startsWith('RUST_'))) out[k] = v;
  return { ...out, ...extra };
}
