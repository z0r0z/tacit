// The real points service (src/points-indexer.js) on a temporary database with proof mining configured, and what its /mine endpoint and the
// /rewards funding report say; and with it left unconfigured. Not part of the automatic tests (it starts the service); run it after changing
// how the campaign is wired:
//   node worker-relay/tests/points-mine-http.mjs [on|off|badfeed|two]
// Every chain RPC points at a dead local port, so nothing reaches the network, and the main loop never gets as far as the campaign's cycle
// (tests/points-mine.test.mjs runs that against the API's own proof pool): what is checked is that it starts, and what it shows.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openStore } from '../src/lib/points-store.js';

const mode = process.argv[2] || 'on', PORT = 18900 + Math.floor(Math.random() * 300);
const today = Math.floor(Date.now() / 86400e3), DAY = 86400, TAC = 10n ** 18n, A = '0x' + 'a'.repeat(40);
const dir = mkdtempSync(join(tmpdir(), 'points-mine-'));
const db = join(dir, 'p.db');
openStore(db);
const env = {
  ...process.env, PORT: String(PORT), POINTS_DB_PATH: db, RPC_URL: 'http://127.0.0.1:9', RPC_URLS_FALLBACK: 'http://127.0.0.1:9', POINTS_START_BLOCK: '99999999', POINTS_POLL_SECS: '3600',
  POINTS_PROGRAM_START_SEC: String((today - 24) * DAY),
  ...(mode === 'on' ? {
    POINTS_MINE_FEED: 'https://api.tacit.finance/prover/pool/credits', POINTS_MINE_SCHEDULE: `${today}:daily=10,cap=0.05;${today + 50}:off;nonsense`,
    POINTS_MINE_POCKET_WEI: String(1000n * TAC), POINTS_MINE_END_SEC: String((today + 53) * DAY),
  } : mode === 'two' ? {
    POINTS_MINE_FEED: 'https://api.tacit.finance/prover/pool/credits, https://api.tacit.finance/prover/board/credits', POINTS_MINE_SCHEDULE: `${today}:daily=10,cap=0.05`,
    POINTS_MINE_POCKET_WEI: String(1000n * TAC), POINTS_MINE_END_SEC: String((today + 53) * DAY),
  } : mode === 'badfeed2' ? {
    POINTS_MINE_FEED: 'https://api.tacit.finance/prover/pool/credits,http://api.tacit.finance/prover/board/credits', POINTS_MINE_SCHEDULE: `${today}:daily=10,cap=0.05`,
    POINTS_MINE_POCKET_WEI: String(1000n * TAC), POINTS_MINE_END_SEC: String((today + 53) * DAY),
  } : mode === 'badfeed' ? {
    POINTS_MINE_FEED: 'http://api.tacit.finance/prover/pool/credits?day=1', POINTS_MINE_SCHEDULE: `${today}:daily=10,cap=0.05`,
    POINTS_MINE_POCKET_WEI: String(1000n * TAC), POINTS_MINE_END_SEC: String((today + 53) * DAY),
  } : {}),
};
const child = spawn('node', ['src/points-indexer.js'], { cwd: new URL('..', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (x) => { out += x; }); child.stderr.on('data', (x) => { out += x; });
const get = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let up = false;
  for (let i = 0; i < 80 && !up && child.exitCode === null; i++) { await sleep(500); up = /http listening/.test(out); }
  assert.ok(up, `the service did not start:\n${out.slice(-1200)}`);
  const v = await get(`/mine?address=${A}`);
  if (mode === 'on') {
    assert.equal(v.enabled, true, JSON.stringify(v));
    assert.deepEqual(v.pocket, { totalWei: String(1000n * TAC), creditedWei: '0', remainingWei: String(1000n * TAC) });
    assert.deepEqual(v.terms, { fromDay: today, dailyWei: String(10n * TAC), capWeiPerPoint: String(5n * TAC / 100n) });
    assert.deepEqual(v.next, { fromDay: today + 50, off: true }, 'it says when it ends');
    assert.equal(v.endSec, (today + 53) * DAY);
    assert.equal(v.feed, 'https://api.tacit.finance/prover/pool/credits');
    assert.deepEqual(v.account, { address: A, creditedWei: '0' });
    assert.equal(v.lastPaidDay, null);
    assert.match(out, /proof mining on: tally from https:\/\/api\.tacit\.finance\/prover\/pool\/credits, pocket 1000 TAC/, 'it says it started');
    assert.match(out, /ignoring POINTS_MINE_SCHEDULE entry "nonsense"/);
    assert.equal((await get('/mine/day/1')).error, 'no record for that day');
    console.log('ok - /mine with the campaign on:', JSON.stringify({ pocket: v.pocket, terms: v.terms }));
    const rw = await get('/rewards');
    const pk = (rw.pockets || []).find((p) => p.name === 'mine');
    assert.ok(pk && pk.remainingWei === String(1000n * TAC), `the funding report lists the pocket: ${JSON.stringify(rw.pockets)}`);
    console.log('ok - /rewards lists the mining pocket:', JSON.stringify(pk));
  } else if (mode === 'two') {
    assert.equal(v.enabled, true, JSON.stringify(v));
    assert.deepEqual(v.feed, ['https://api.tacit.finance/prover/pool/credits', 'https://api.tacit.finance/prover/board/credits']);
    assert.match(out, /proof mining on: tally from https:\/\/api\.tacit\.finance\/prover\/pool\/credits \+ https:\/\/api\.tacit\.finance\/prover\/board\/credits, pocket 1000 TAC/);
    console.log('ok - two feeds, the pool\'s and the board\'s, read as one campaign');
  } else if (mode === 'badfeed2') {
    assert.deepEqual(v, { enabled: false });
    assert.match(out, /ignoring POINTS_MINE_FEED="http:\/\/api\.tacit\.finance\/prover\/board\/credits"/);
    console.log('ok - one feed in the list that is not https keeps mining off');
  } else if (mode === 'badfeed') {
    assert.deepEqual(v, { enabled: false });
    assert.match(out, /ignoring POINTS_MINE_FEED="http:\/\/api\.tacit\.finance\/prover\/pool\/credits\?day=1"/);
    console.log('ok - a feed that is not https (or has a query) is refused and mining stays off');
  } else {
    assert.deepEqual(v, { enabled: false });
    assert.ok(!(await get('/rewards')).pockets?.some((p) => p.name === 'mine'));
    assert.doesNotMatch(out, /proof mining/);
    console.log('ok - /mine with the campaign off');
  }
} finally {
  child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
