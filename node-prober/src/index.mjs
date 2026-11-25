// Entry: PROBER_KEY (hex private key, the signer the pages pin), STATE_PATH (a disk), PORT, POINTS_ENABLED (0 by default).
import process from 'node:process';
import { makeService } from './service.mjs';
import { httpsFetch, asnOf } from './net.mjs';

const key = process.env.PROBER_KEY;
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key || '')) { console.error('PROBER_KEY is not a 32-byte hex key (node tools/nodes-keygen.mjs makes one)'); process.exit(1); }
const svc = makeService({
  key,
  fetch: httpsFetch,
  statePath: process.env.STATE_PATH || null,
  asnOf,
  pointsEnabled: process.env.POINTS_ENABLED === '1',
  intervalSecs: Number(process.env.PROBE_INTERVAL_SECS) || 20 * 60,
  vantage: process.env.PROBER_VANTAGE || 'prober-1',
});
const port = Number(process.env.PORT) || 10000;
svc.server().listen(port, () => console.log(`node-prober: listening on ${port}; signer ${svc.signer}; points ${process.env.POINTS_ENABLED === '1' ? 'on' : 'off'}`));
let busy = false;
setInterval(async () => { if (busy) return; busy = true; try { await svc.tick(); } catch (e) { console.error('tick', e?.message); } finally { busy = false; } }, 30_000);
