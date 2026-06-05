// Shadow-bake comparator: replays the read endpoints against two API origins
// and reports structural differences, ignoring fields that legitimately
// differ between deployments (scan cursor, chain tip, timestamps, cache
// stamps). Asset ids are discovered from origin A's /assets, then per-asset
// endpoints are diffed for the most active ones.
//
//   node scripts/api-shadow-diff.mjs \
//     --a https://tacit-pin.rosscampbell9.workers.dev \
//     --b https://tacit-api-xxxx.onrender.com \
//     [--networks mainnet,signet] [--assets 8] [--verbose]

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const A = flag('a');
const B = flag('b');
const NETWORKS = (flag('networks', 'mainnet,signet')).split(',');
const PER_ASSET = Number(flag('assets', '8'));
const VERBOSE = args.includes('--verbose');
if (!A || !B) { console.error('required: --a <origin> --b <origin>'); process.exit(1); }

// Fields whose divergence is expected, not a defect: scan progress, chain
// tip, server clocks, cache stamps, and rolling trade counters that lag by
// whatever wrote since the snapshot.
const VOLATILE = new Set([
  'last_scanned', 'tip', 'tip_unavailable', 'ts', 'now', 'cached_at',
  'updated_at', 'fetched_at', 'age_ms',
]);

function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node).sort()) {
      if (VOLATILE.has(k)) continue;
      out[k] = normalize(node[k]);
    }
    return out;
  }
  return node;
}

function* diffPaths(a, b, path = '') {
  if (a === b) return;
  const ta = Array.isArray(a) ? 'array' : typeof a;
  const tb = Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb || a === null || b === null || ta === 'string' || ta === 'number' || ta === 'boolean') {
    yield { path: path || '(root)', a, b };
    return;
  }
  if (ta === 'array') {
    if (a.length !== b.length) yield { path: `${path}.length`, a: a.length, b: b.length };
    for (let i = 0; i < Math.min(a.length, b.length); i++) yield* diffPaths(a[i], b[i], `${path}[${i}]`);
    return;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    yield* diffPaths(a[k], b[k], path ? `${path}.${k}` : k);
  }
}

async function get(origin, pathname, body) {
  const started = Date.now();
  try {
    const resp = await fetch(`${origin}${pathname}`, {
      method: body ? 'POST' : 'GET',
      headers: { Origin: 'https://tacit.finance', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: resp.status, json, bytes: text.length, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, json: null, bytes: 0, ms: Date.now() - started, error: e?.message };
  }
}

let clean = 0, dirty = 0, failed = 0;
async function compare(pathname, body) {
  const [ra, rb] = await Promise.all([get(A, pathname, body), get(B, pathname, body)]);
  if (ra.status !== rb.status) {
    failed++;
    console.log(`✗ ${pathname} — status ${ra.status} vs ${rb.status}${rb.error ? ` (${rb.error})` : ''}`);
    return null;
  }
  if (ra.json === null) {
    console.log(`- ${pathname} — non-JSON on both (${ra.status})`);
    return ra;
  }
  const diffs = [...diffPaths(normalize(ra.json), normalize(rb.json))];
  if (diffs.length === 0) {
    clean++;
    console.log(`✓ ${pathname} (${ra.bytes}b, ${ra.ms}ms vs ${rb.ms}ms)`);
  } else {
    dirty++;
    console.log(`≠ ${pathname} — ${diffs.length} differing paths`);
    for (const d of diffs.slice(0, VERBOSE ? 50 : 5)) {
      console.log(`    ${d.path}: ${JSON.stringify(d.a)?.slice(0, 80)} vs ${JSON.stringify(d.b)?.slice(0, 80)}`);
    }
    if (diffs.length > 5 && !VERBOSE) console.log(`    … ${diffs.length - 5} more (--verbose for all)`);
  }
  return ra;
}

const BOOK_SECTIONS = ['stats', 'bids', 'listings', 'intents', 'preauth_sales', 'range_listings'];

console.log(`A: ${A}\nB: ${B}\n`);
await compare('/health');
for (const network of NETWORKS) {
  console.log(`\n— ${network} —`);
  const assets = await compare(`/assets?network=${network}`);
  await compare(`/market?network=${network}`);
  await compare(`/petch-assets?network=${network}`);
  await compare(`/amm/pools?network=${network}`);
  await compare(`/farms?network=${network}`);
  await compare(`/pools?network=${network}`);
  await compare(`/drops?network=${network}`);
  await compare(`/recent-cxfer-txids?network=${network}`);
  const ids = (assets?.json?.assets || [])
    .map((a) => a.asset_id || a.id)
    .filter(Boolean)
    .slice(0, PER_ASSET);
  for (const id of ids) {
    await compare(`/asset-book?network=${network}`, { asset_id: id, include: BOOK_SECTIONS });
  }
}
console.log(`\n${clean} clean, ${dirty} differing, ${failed} status-mismatched`);
process.exit(failed > 0 ? 2 : dirty > 0 ? 1 : 0);
