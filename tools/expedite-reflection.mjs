// Run tacit-reflection's Render cron right now instead of waiting for its next scheduled tick (see
// ops/RUNBOOK-capacity-and-alerting.md §3b) — for when a specific lock, escrow or cross-out needs to fold
// sooner than the lean hourly cadence would get to it.
//
// This is an OPERATOR tool, not a public self-serve one: it needs a Render API key with access to the
// tacit-reflection service, since folding a batch means proving it (real SP1 compute, paid from Tacit's
// funded Succinct account) and submitting attestBitcoinStateProven (paid from the relay's own gas wallet).
// There is no way to do this without those credentials short of running the whole pipeline yourself against
// your own SP1 network account — the "fully self-hosted" tier in the integration guide's proving section,
// generalized from settle proofs to the reflection guest.
//
// This does NOT build any new proving logic — it just triggers the exact same `reflection-folder.js`
// (worker-relay/src/reflection-folder.js) that the schedule would have run anyway, early. Nothing about
// what it does or how it does it changes; only when.
//
// If the block you're waiting on hasn't reached the header relay's tip yet, run
// tools/advance-header-relay.mjs first — this tool only folds what's already matured.
//
// Usage:
//   RENDER_API_KEY=rnd_... node tools/expedite-reflection.mjs [--cron-id ID] [--wait] [--target HEIGHT]
//
//   --cron-id ID    override the tacit-reflection cron job id (default: crn-d9eb08bbc2fs73fkm8i0, from the
//                   Render dashboard — confirm it if the service is ever recreated).
//   --wait          poll GET /reflection/status until attestedHeight advances (or stops moving) instead of
//                   just firing the trigger and returning. Render's cron-run API has no documented endpoint
//                   for polling a specific run's own status, so this watches the real effect instead — the
//                   one thing that actually matters, and something no Render-side change can silently break.
//   --target HEIGHT stop waiting once attestedHeight reaches this (e.g. your lock's block + 24); otherwise
//                   waits for one successful advance, whatever height it reaches.

const RENDER_API_KEY = process.env.RENDER_API_KEY;
if (!RENDER_API_KEY) throw new Error('set RENDER_API_KEY=rnd_... (a key with access to the tacit-reflection service)');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const CRON_ID = arg('--cron-id', 'crn-d9eb08bbc2fs73fkm8i0'); // tacit-reflection
const WAIT = argv.includes('--wait');
const TARGET = arg('--target', null);

async function render(method, path, body) {
  const r = await fetch(`https://api.render.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(json)}`);
  return json;
}
async function status() { return fetch('https://api.tacit.finance/reflection/status').then((r) => r.json()); }

const before = await status();
console.log('reflection before:', JSON.stringify(before));

console.log(`triggering tacit-reflection (${CRON_ID}) now...`);
const run = await render('POST', `/cron-jobs/${CRON_ID}/runs`, {});
console.log('run', run.id, run.status);

if (WAIT) {
  console.log('waiting for attestedHeight to advance (Render exposes no per-run status endpoint, so this watches the real effect instead)...');
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    const cur = await status();
    console.log(`  ${new Date().toISOString()} attestedHeight=${cur.attestedHeight} lagBlocks=${cur.lagBlocks}`);
    if (cur.attestedHeight > before.attestedHeight) {
      console.log('advanced —', before.attestedHeight, '->', cur.attestedHeight);
      if (TARGET == null || cur.attestedHeight >= Number(TARGET)) { console.log('done'); break; }
      console.log(`still short of --target ${TARGET}; this run folds one batch (REFLECTION_BATCH_SIZE), so trigger again for another`);
      break;
    }
  }
}

console.log('reflection after:', JSON.stringify(await status()));
