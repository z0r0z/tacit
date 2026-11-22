// The real points service (src/points-indexer.js) on a temporary database with the liquidity campaign configured, and what its /lp endpoint says; and with it left
// unconfigured. Not part of the automatic tests (it starts the service); run it after changing how the campaign is wired:
//   node worker-relay/tests/points-lp-http.mjs [on|off]
// Every chain RPC points at a dead local port, so nothing reaches the network: the scan and the samples fail and are logged, and the view is what it says before any.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openStore } from '../src/lib/points-store.js';

const mode = process.argv[2] || 'on', PORT = 18600 + Math.floor(Math.random() * 300);
const today = Math.floor(Date.now() / 86400e3), DAY = 86400, TAC = 10n ** 18n;
const POOL = '0x' + 'ab'.repeat(20), POOL3 = '0x' + 'cd'.repeat(20), A = '0x' + 'a'.repeat(40);
const dir = mkdtempSync(join(tmpdir(), 'points-lp-'));
const db = join(dir, 'p.db');
openStore(db);
const env = {
  ...process.env, PORT: String(PORT), POINTS_DB_PATH: db, RPC_URL: 'http://127.0.0.1:9', RPC_URLS_FALLBACK: 'http://127.0.0.1:9', POINTS_START_BLOCK: '99999999', POINTS_POLL_SECS: '3600',
  POINTS_PROGRAM_START_SEC: String((today - 24) * DAY),
  ...(mode === 'on' ? {
    POINTS_LP_SCHEDULE: `${today}:daily=25,create=150,cap=0.05;${today + 30}:off`, POINTS_LP_POOLS: `${POOL}=1`, POINTS_LP_POCKET_WEI: String(1500n * TAC),
    POINTS_LP_END_SEC: String((today + 35) * DAY), POINTS_LP_FROM_BLOCK: '1000',
    // One virtual farm beside it, and a second entry that is malformed (the service says so and goes on).
    POINTS_LP_FARMS: JSON.stringify([
      { name: 'taceth', schedule: `${today}:daily=40,create=0,cap=0.03`, pools: `${POOL3}=1/spot`, pocketWei: String(3000n * TAC), endSec: (today + 60) * DAY, fromBlock: 1000 },
      { name: 'Bad Name', schedule: `${today}:daily=1,create=0,cap=1`, pools: POOL3, pocketWei: '1', endSec: 1 },
    ]),
  } : {}),
};
const child = spawn('node', ['src/points-indexer.js'], { cwd: new URL('..', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
const get = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let up = false;
  for (let i = 0; i < 80 && !up && child.exitCode === null; i++) { await sleep(500); up = /http listening/.test(out); }
  assert.ok(up, `the service did not start:\n${out.slice(-1200)}`);
  const v = await get(`/lp?address=${A}`);
  if (mode === 'on') {
    assert.equal(v.enabled, true, JSON.stringify(v));
    assert.equal(v.pocket.totalWei, String(1500n * TAC)); assert.equal(v.pocket.creditedWei, '0'); assert.equal(v.pocket.remainingWei, String(1500n * TAC));
    assert.equal(v.terms.dailyWei, String(25n * TAC)); assert.equal(v.terms.createWei, String(150n * TAC)); assert.equal(v.terms.capWeiPerUsdDay, String(TAC / 20n));
    assert.equal(v.next.fromDay, today + 30); assert.equal(v.endSec, (today + 35) * DAY);
    assert.deepEqual(v.pools.map((p) => [p.pool, p.opened, p.openPaid, p.weightBps, p.mineUsdWei]), [[POOL, false, false, '10000', '0']]);
    assert.equal(v.mine.address, A); assert.equal(v.mine.creditedWei, '0');
    assert.match(out, /liquidity campaign on: 1 pool\(s\), pocket 1500/, 'it says it started');
    const bad = await get('/lp?address=nope'); assert.equal(bad.enabled, true); assert.equal(bad.mine, undefined, 'a bad address asks for no account');
    console.log('ok - /lp with the campaign on:', JSON.stringify({ pocket: v.pocket, terms: v.terms, pools: v.pools.length }));
    // The farm beside it: its own view, listed, with no day paid yet; the first campaign's answers are unchanged.
    const f = await get(`/lp?farm=taceth&address=${A}`);
    assert.equal(f.enabled, true, JSON.stringify(f)); assert.equal(f.name, 'taceth');
    assert.equal(f.pocket.totalWei, String(3000n * TAC)); assert.equal(f.terms.dailyWei, String(40n * TAC)); assert.equal(f.terms.capWeiPerUsdDay, String(TAC * 3n / 100n));
    assert.deepEqual(f.pools.map((p) => [p.pool, p.spot, p.weightBps]), [[POOL3, true, '10000']]);
    assert.equal(f.mine.streak, 0); assert.equal(f.lastPaidDay, null);
    assert.equal(v.name, undefined, 'the first campaign has no name');
    assert.deepEqual((await get('/lp?farm=nope')), { enabled: false }, 'a farm that is not there is off');
    const list = await get('/lp/farms'); assert.deepEqual(list.farms.map((x) => x.name), ['taceth']);
    assert.match(out, /virtual farm "taceth" on: 1 pool\(s\), pocket 3000/); assert.match(out, /not a farm name/, 'the malformed farm is said and skipped');
    for (const path of [`/lp/day/${today - 1}`, `/lp/day/${today - 1}?farm=taceth`, '/lp/day/1?farm=nope']) {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`); assert.equal(r.status, 404, `${path}: no record for a day that was not paid`);
    }
    // The distributor's funding is not read here (no distributor), but the campaigns' pockets are listed beside it.
    const rw = await get('/rewards');
    assert.deepEqual(rw.pockets.map((p) => [p.name, p.remainingWei]), [[null, String(1500n * TAC)], ['taceth', String(3000n * TAC)]]);
    console.log('ok - the farm, /lp/farms, /lp/day and the pockets on /rewards');
  } else {
    assert.deepEqual(v, { enabled: false });
    assert.doesNotMatch(out, /liquidity campaign on/);
    assert.deepEqual(await get('/lp/farms'), { farms: [] }); assert.deepEqual((await get('/rewards')).pockets, []);
    console.log('ok - /lp with the campaign off:', JSON.stringify(v));
  }
  const lb = await get('/leaderboard?day=today&limit=1');
  assert.ok(lb.program, 'the rest of the service is unaffected');
  // The read routes share one answer for a few seconds; health is never kept.
  const first = await fetch(`http://127.0.0.1:${PORT}/leaderboard?limit=7`), second = await fetch(`http://127.0.0.1:${PORT}/leaderboard?limit=7`);
  assert.equal(first.headers.get('x-points-cache'), 'miss'); assert.equal(second.headers.get('x-points-cache'), 'hit');
  assert.equal(await first.text(), await second.text());
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/health`)).headers.get('x-points-cache'), null);
  console.log('ok - read routes share one answer for a few seconds, health is not kept');
} finally {
  child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
