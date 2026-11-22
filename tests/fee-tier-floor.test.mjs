// getFeeRate's floor follows what the recent blocks actually take, and feeFor's per-transaction floor drops from 500 to 150 sats only when the rate is under 1 sat/vB.
// 2026-11-16: every block took transactions at 0.12 sat/vB, mempool.space's recommended fees said 1, and a withdraw was quoted 1,480 sats for a carrier the relay paid 379 for.
// Each scenario runs in its own process (getFeeRate caches per module load).      node tests/fee-tier-floor.test.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCENARIO = process.env.FEE_SCENARIO;
if (!SCENARIO) {
  let bad = 0;
  for (const s of ['backlog', 'one-block-above-one', 'blocks-unreadable', 'spike', 'sources-disagree', 'recommended-down']) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, FEE_SCENARIO: s }, encoding: 'utf8', timeout: 120000 });
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) { bad++; process.stdout.write(`  FAIL  scenario ${s} exited ${r.status}\n${r.stderr || ''}`); }
  }
  console.log(bad ? `\n${bad} scenario(s) failed` : '\nall scenarios passed');
  process.exit(bad ? 1 : 0);
}

import { JSDOM } from './_jsdom.mjs';
const dom = new JSDOM('<!doctype html><html></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

// sources-disagree: the recommended fees say 3 (standard) and 4 (priority), Core's estimates 7 and 9, and the recommended ones answer later: the rate is the same whichever answers first.
// recommended-down: no recommended fee can be read, so Core's estimates stand in.
const RECOMMENDED = SCENARIO === 'spike' ? { fastestFee: 20, halfHourFee: 14, hourFee: 12, economyFee: 6, minimumFee: 1 } : SCENARIO === 'sources-disagree' ? { fastestFee: 4, halfHourFee: 3.5, hourFee: 3, economyFee: 2, minimumFee: 1 } : { fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 };
const ESTIMATES = SCENARIO === 'spike' ? { '1': 19, '3': 15, '6': 11, '12': 8, '25': 5 } : (SCENARIO === 'sources-disagree' || SCENARIO === 'recommended-down') ? { '1': 9, '2': 8, '3': 8, '6': 7, '12': 6, '25': 5 } : { '1': 0.35, '2': 0.35, '3': 0.137, '6': 0.124, '12': 0.124, '25': 0.12 };
const lows = { backlog: [0.12, 0.12, 0.12, 0.12, 0.12, 0.12], 'one-block-above-one': [0.12, 0.12, 1.02, 0.12, 0.12, 0.12], spike: [3, 4, 3, 5, 4, 3] }[SCENARIO];
const BLOCKS = lows ? lows.map((n, i) => ({ height: 976119 - i, extras: { feeRange: [n, 2, 5, 9, 30, 80, 300], medianFee: Math.max(n, 0.12) } })) : null;
globalThis.fetch = async (url) => {
  if (typeof url !== 'string') url = String(url);
  if (url.endsWith('/v1/fees/recommended')) {
    if (SCENARIO === 'recommended-down') return { ok: false, status: 503, json: async () => ({}), text: async () => 'down' };
    if (SCENARIO === 'sources-disagree') await new Promise((r) => setTimeout(r, 150));
    return { ok: true, json: async () => RECOMMENDED };
  }
  if (url.endsWith('/fee-estimates')) return { ok: true, json: async () => ESTIMATES };
  if (url.endsWith('/v1/blocks')) return BLOCKS ? { ok: true, json: async () => BLOCKS } : { ok: false, status: 404, json: async () => ({}), text: async () => 'nope' };
  if (url.endsWith('/blocks/tip/height')) return { ok: true, text: async () => '976119' };
  return { ok: false, status: 404, text: async () => 'mock denied', json: async () => ({}) };
};

const dapp = await import('../dapp/tacit.js');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { console.log(`  PASS  ${SCENARIO}: ${name}`); pass++; } else { console.log(`  FAIL  ${SCENARIO}: ${name}${detail ? ' — ' + detail : ''}`); fail++; } };

const std = await dapp.getFeeRate('standard'), eco = await dapp.getFeeRate('economy'), pri = await dapp.getFeeRate('priority');
if (SCENARIO === 'backlog') {
  ok(`standard follows the blocks, not the 1 sat/vB floor: ${std} (twice their lowest, 0.24)`, std === 0.24, String(std));
  ok(`economy rests on the same floor: ${eco}`, eco === 0.24, String(eco));
  ok(`priority uses the one-block estimate: ${pri}`, pri === 0.35, String(pri));
  ok('feeFor on a 152 vB commit at that rate is the 150-sat floor, not 500', dapp.feeFor(152, std) === 150, String(dapp.feeFor(152, std)));
  ok('feeFor on a 954 vB reveal is its size times the rate', dapp.feeFor(954, std) === 229, String(dapp.feeFor(954, std)));
  const carrier = dapp.feeFor(152, std * 1.2) + dapp.feeFor(969 - 152, std * 1.2);
  ok(`the withdraw quote (the carrier at 1.2 times) is about what the relay paid, ${carrier} sats (it was 1,480)`, carrier > 300 && carrier < 450, String(carrier));
  ok('a safety multiple keeps the floor and multiplies from it', (await dapp.getFeeRate('standard', { safetyMult: 2 })) === 0.48);
  ok('at 1 sat/vB and above the 500-sat floor is as it was', dapp.feeFor(152, 1.2) === 500 && dapp.feeFor(526, 1.4) === 737);
  const ff = await import('../dapp/fee-floor.js');
  ok('the pages that do not load tacit.js (fee-floor.js) read the same priority rate from the same data', ff.priorityRate({ recommended: RECOMMENDED, estimates: ESTIMATES, floor: ff.floorFromBlocks(BLOCKS) }) === pri);
} else if (SCENARIO === 'one-block-above-one') {
  ok(`one recent block with nothing under 1 sat/vB keeps the floor at 1: standard ${std}`, std === 1, String(std));
  ok(`and so for priority (${pri}) and economy (${eco})`, pri === 1 && eco === 1, `${pri} ${eco}`);
  const ff = await import('../dapp/fee-floor.js');
  ok('fee-floor.js agrees: its floor is 1 and its priority rate 1', ff.floorFromBlocks(BLOCKS) === 1 && ff.priorityRate({ recommended: RECOMMENDED, estimates: ESTIMATES, floor: ff.floorFromBlocks(BLOCKS) }) === 1);
  ok('feeFor keeps its 500-sat floor at that rate', dapp.feeFor(152, std) === 500);
} else if (SCENARIO === 'blocks-unreadable') {
  ok(`with the blocks unreadable the floor is 1 as it always was: standard ${std}`, std === 1, String(std));
  ok(`economy ${eco} and priority ${pri} too`, eco === 1 && pri === 1, `${eco} ${pri}`);
} else if (SCENARIO === 'sources-disagree') {
  ok(`standard is the recommended hourFee, not Core's slower-tier 7: ${std}`, std === 3, String(std));
  ok(`priority is the recommended fastestFee, not Core's next-block 9: ${pri}`, pri === 4, String(pri));
  ok(`economy is the recommended economyFee: ${eco}`, eco === 2, String(eco));
} else if (SCENARIO === 'recommended-down') {
  ok(`with no recommended fee, standard is Core's 6-block estimate with the 5% margin: ${std}`, std === 7.35, String(std));
  ok(`priority is Core's next-block estimate with the 10% margin: ${pri}`, pri === 9.9, String(pri));
} else if (SCENARIO === 'spike') {
  ok(`a fee spike is untouched: standard ${std} (hourFee 12 with the 5% margin)`, std === 12.6, String(std));
  ok(`priority ${pri} (fastestFee 20 with the 10% margin) and economy ${eco}`, pri === 22 && eco === 6, `${pri} ${eco}`);
  ok('feeFor is size times rate', dapp.feeFor(954, std) === Math.ceil(954 * 12.6));
}

console.log(`${pass} passed, ${fail} failed`);
// Exit on the verdict: imported browser modules can leave the event loop alive.
process.exit(fail > 0 ? 1 : 0);
