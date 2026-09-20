// GET /reflection/status: a small public summary so an integrator need not download the full snapshot.
// Offline: node tests/reflection-status.test.mjs
const record = JSON.stringify({ attestedHeight: 967810, tipHeight: 967836, snapshot: { foldedCrossoutCount: '2', consumedCount: 1, liveTriples: [[1], [2], [3]], noteLeaves: new Array(50).fill('0x0'), pendingDepositRecords: [] } });
let reads = 0;
const env = { REGISTRY_KV: { get: async (k) => { reads++; return k === 'reflection:scan:mainnet' ? record : null; }, put: async () => {}, delete: async () => {} } };
const worker = await import('../worker/src/index.js');
const get = (q = '') => worker.default.fetch(new Request('https://api.test/reflection/status' + q), env, { waitUntil() {} });
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? ' - ' + d : '')); fail++; } };

const r = await get('?network=mainnet');
const b = await r.json();
ok('answers without credentials', r.status === 200);
ok('reports attested and relay tip heights', b.attestedHeight === 967810 && b.tipHeight === 967836);
ok('reports the lag in blocks', b.lagBlocks === 26);
ok('reports the confirmation depth the pool requires', b.confirmations === 24);
ok('reports the folded cross-out and consumed counts', b.foldedCrossoutCount === 2 && b.consumedCount === 1);
ok('reports live note count without shipping the notes', b.liveNotes === 3 && !('snapshot' in b) && JSON.stringify(b).length < 600);
const before = reads;
await get('?network=mainnet'); await get('?network=mainnet');
ok('repeat calls inside the window reuse the parsed summary', reads === before);
const s = await get('?network=signet');
ok('an unseeded network is a clean 404', s.status === 404);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
