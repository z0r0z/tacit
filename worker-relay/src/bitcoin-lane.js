// The Bitcoin lane in one always-on process: the eth-state producer (Mode-B fuel), the reflection folder (Bitcoin state attested on
// Ethereum) and the header feeder (BitcoinLightRelay.advanceTip), run in turn by lib/lane-schedule.js. One process where there were a
// worker and two crons: no cold start every few minutes, the reflection runs the moment its fuel is there instead of at the next
// five-minute mark, and the three never prove or send at once (each proof is a child of over a gigabyte; headers and attests sign with
// the one relay key), so a 2 GB instance holds the lane's peak.
//
// Each stage is the unchanged cycle of its own file (eth-state-sidecar.js, reflection-folder.js, header-relay.js), which still run on
// their own as before. A stage can be left out (LANE_ETH_STATE / LANE_REFLECTION / LANE_HEADERS = 0) while its old service runs. The
// proving stages take turns; the header feeder runs on its own loop (it proves nothing), so a long proof never holds headers back, and
// a liveness beat every two minutes keeps /prover-health true while a proof is in hand.
//
//   ETH_STATE_POLL_SECS (60)  how often the eth-state producer looks     REFLECTION_POLL_SECS (30)  the folder, when caught up
//   HEADER_EVERY_SECS (180)   the header feeder, as its cron ran          a stage that worked goes again at once

import { CFG } from './lib/config.js';
import { makeLaneSchedule } from './lib/lane-schedule.js';
import { heartbeat, heartbeatIdle } from './lib/worker-client.js';
import { safeErr } from './lib/safe-err.js';
import { ethStateCycle, ethStateReset } from './eth-state-sidecar.js';
import { reflectionCycle } from './reflection-folder.js';
import { headerCycle, snapshotPointerStep, tacitHeaderStep } from './header-relay.js';

const log = (...a) => console.log(`[lane ${new Date().toISOString()}]`, ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const on = (k) => (process.env[k] ?? '1') !== '0';

async function main() {
  if (CFG.runMode === 'cron') throw new Error('bitcoin-lane.js is an always-on worker; RUN_MODE=cron is for the single-stage files');
  if (CFG.sp1Prover === 'network' && !CFG.networkPrivateKey) throw new Error('SP1_PROVER=network but NETWORK_PRIVATE_KEY unset — cannot prove');
  // Two loops. The proving stages (eth-state, then the reflection that burns its fuel) take turns, so one proof child runs at a time;
  // the header feeder, which proves nothing, keeps its own pace, so a long proof never holds headers back. Both sign with the relay
  // key, as the crons did, with the same nonce retry.
  const proving = [], feeding = [];
  if (on('LANE_ETH_STATE')) { await ethStateReset(); proving.push({ name: 'eth-state', kind: 'eth-state', everySecs: CFG.ethStatePollSecs, run: ethStateCycle, idleNote: 'idle — no candidate to produce yet', busyNote: 'producing a candidate' }); }
  if (on('LANE_REFLECTION')) proving.push({ name: 'reflection', kind: 'reflection', everySecs: CFG.reflectionPollSecs, run: reflectionCycle, idleNote: 'caught up', busyNote: 'proving a batch' });
  if (on('LANE_HEADERS')) feeding.push({ name: 'header', everySecs: Number(process.env.HEADER_EVERY_SECS || 180), run: headerCycle });
  // snapshot.tacit.wei and the tacit chain's next header, from the same wallet (header-relay.js): a read each half hour, a send about
  // once a day for the record and every TACIT_HEADERS_EVERY_SECS for a header
  if (CFG.snapshotPointer || CFG.tacitHeaders) feeding.push({ name: 'snapshot record', everySecs: 1800, run: async () => { await snapshotPointerStep(); await tacitHeaderStep(); return false; } });
  const stages = [...proving, ...feeding];
  if (!stages.length) throw new Error('every stage is off (LANE_ETH_STATE, LANE_REFLECTION, LANE_HEADERS)');
  log(`starting — stages ${stages.map((s) => `${s.name} every ${s.everySecs}s`).join(', ')}; worker=${CFG.workerBase} network=${CFG.network}`);
  const idleSecs = Number(process.env.LANE_IDLE_SECS || Math.min(CFG.ethStatePollSecs, CFG.reflectionPollSecs));
  const lanes = [];
  if (proving.length) lanes.push(makeLaneSchedule(proving.map((s) => ({ ...s, idle: () => heartbeatIdle(s.kind, s.idleNote) })), { idleSecs, log }));
  if (feeding.length) lanes.push(makeLaneSchedule(feeding, { idleSecs: Math.min(idleSecs, 60), log }));
  // Liveness: every two minutes each proving stage beats, whatever is in hand — the one running says so, the others their idle note — so
  // /prover-health reads a lane busy with a long proof as up, not down. A stage's own beats (a proof's steps, an attest) ride beside these.
  const tick = setInterval(() => {
    const busy = lanes[0]?.running?.();
    for (const s of proving) (s.name === busy ? heartbeat(s.kind, `${s.kind}: ${s.busyNote}`) : heartbeatIdle(s.kind, s.idleNote)).catch(() => {});
  }, 120_000);
  tick.unref?.();
  // A deploy or restart sends SIGTERM: each stage in hand finishes (a proof paid for is not abandoned), then the loops end.
  let stopping = false;
  process.on('SIGTERM', () => { if (!stopping) log('SIGTERM — finishing the stages in hand'); stopping = true; });
  const loop = async (lane) => {
    for (;;) {
      if (stopping) return;
      let r;
      try { r = await lane.round(); }
      catch (e) { log('round error (continuing):', safeErr(e)); r = { worked: false, sleepSecs: idleSecs }; }
      if (r.sleepSecs > 0) await sleep(r.sleepSecs);
    }
  };
  await Promise.all(lanes.map(loop));
  log('stopped cleanly');
  process.exit(0);
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
