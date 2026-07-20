// One-shot: POST the verified reflection head snapshot to the worker's /reflection/seed endpoint.
// The worker recomputes the snapshot digest and refuses unless it matches expectDigest (c54cebed),
// so this can only ever install the correct head state. Run AFTER the worker (5816792) is deployed.
//
//   WORKER_BASE (default https://api.tacit.finance)   BOX_TOKEN (required)
//   node tools/seed-reflection-head.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BASE = process.env.WORKER_BASE || 'https://api.tacit.finance';
const HEAD = '/Users/z/tacit-critical-backup/seed-rebuild/reflected-state-958344-HEAD.json';
const EXPECT = '0xc54cebeda7022277bb405288308e6f81f83f2add96ec2052f9a8ca75bdc96ebb';

let token = process.env.BOX_TOKEN;
if (!token) {
  try { token = execSync(`grep '^export BOX_TOKEN=' ~/.tacit-recovery/vast-preserve/settle-env.sh | cut -d= -f2- | tr -d '"'\\''\\n'`, { shell: '/bin/zsh' }).toString().trim(); } catch {}
}
if (!token) { console.error('BOX_TOKEN not set and not found in settle-env.sh'); process.exit(1); }

const state = JSON.parse(readFileSync(HEAD, 'utf8'))['reflection:scan:mainnet'];
console.log(`seeding ${BASE}/reflection/seed?network=mainnet — attestedHeight ${state.attestedHeight}, expect ${EXPECT.slice(0, 12)}…`);

const r = await fetch(`${BASE}/reflection/seed?network=mainnet`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ state, expectDigest: EXPECT }),
});
const body = await r.text();
console.log(`HTTP ${r.status}: ${body}`);
if (r.status === 404) console.log('→ 404 means the worker does NOT yet have the /reflection/seed route — deploy commit 5816792 first.');
if (r.ok) console.log('✅ worker reflection cursor is now at head (958344 / c54cebed). Bump the reflection cron RAM and it resumes forward folding.');
process.exit(r.ok ? 0 : 2);
