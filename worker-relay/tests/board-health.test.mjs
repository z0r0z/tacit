// The monitor's prover-board and RunPod verdicts (src/lib/board-health.js): a refused proof warns only while recent, not on the board's lifetime
// count, and an empty RunPod account is logged, not warned, since the board check already pages when no worker polls.
// Run: node --test tests/board-health.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { boardVerdict, runpodVerdict, vastVerdict } from '../src/lib/board-health.js';

const cfg = { quietSecs: 600, badWindowSecs: 600, waitWarnSecs: 60 };
const box = (o = {}) => ({ name: 'tacit-a5000', proved: 7761, failed: 0, bad: 90, lastBadSeconds: 86_400, lastSeenSeconds: 0, ...o });
const board = (workers, o = {}) => ({ queued: 0, claimed: 0, recent: { n: 0 }, workers, ...o });

test('a lifetime count of refused proofs with none recent is logged, not warned', () => {
  const v = boardVerdict(board([box()]), cfg);
  assert.deepEqual(v.alerts, []);
  assert.match(v.log, /tacit-a5000 seen 0s ago, proved 7761, refused 90 \(last 1440 min ago\)/);
});

test('a refusal within the window warns, with when it was', () => {
  const v = boardVerdict(board([box({ bad: 91, lastBadSeconds: 120 })]), cfg);
  assert.equal(v.alerts.length, 1);
  assert.equal(v.alerts[0].level, 'warning');
  assert.match(v.alerts[0].msg, /tacit-a5000 had a proof refused 2 min ago \(91 in all\)/);
  assert.equal(boardVerdict(board([box({ lastBadSeconds: 601 })]), cfg).alerts.length, 0, 'past the window');
});

test('a board that predates lastBadSeconds does not warn on its count', () => {
  const v = boardVerdict(board([box({ lastBadSeconds: undefined })]), cfg);
  assert.deepEqual(v.alerts, []);
  assert.match(v.log, /refused 90;/);
});

test('no live house worker pages; community machines and a never-seen worker do not count', () => {
  const v = boardVerdict(board([box({ lastSeenSeconds: 900 }), { name: 'c-0x' + '1'.repeat(40), community: true, lastSeenSeconds: 0 }, { name: 'spare', lastSeenSeconds: null }]), cfg);
  assert.equal(v.alerts.length, 1);
  assert.equal(v.alerts[0].level, 'critical');
  assert.match(v.alerts[0].msg, /tacit-a5000 15 min ago, spare never/);
  assert.equal(boardVerdict(null, cfg).alerts[0].level, 'warning', 'unreadable');
});

test('the failure share and the GPU wait still warn', () => {
  assert.match(boardVerdict(board([box({ proved: 4, failed: 3 })]), cfg).alerts[0].msg, /failed 3 of 7 jobs/);
  const r = { n: 12, waitP50: 5, waitP90: 90, proveP50: 30, proveP90: 40 };
  assert.match(boardVerdict(board([box()], { recent: r }), cfg).alerts[0].msg, /waited 90 s/);
});

test('runpod: no pod running is a log line, low rent on a running pod warns or pages', () => {
  const lim = { hoursWarn: 48, hoursCritical: 12 };
  const none = runpodVerdict({ clientBalance: 3.81, pods: [{ name: 'old', desiredStatus: 'EXITED', costPerHr: 0.3 }] }, lim);
  assert.deepEqual(none.alerts, []);
  assert.match(none.log, /no pod running \(balance \$3\.81\)/);
  assert.equal(runpodVerdict(null, lim).alerts.length, 0);
  const pod = (bal) => runpodVerdict({ clientBalance: bal, pods: [{ name: 'gpu', desiredStatus: 'RUNNING', costPerHr: 1 }] }, lim);
  assert.equal(pod(5).alerts[0].level, 'critical');
  assert.equal(pod(20).alerts[0].level, 'warning');
  assert.deepEqual(pod(100).alerts, []);
});

test('vast: hours of rent left warn or page, zero credit pages naming every instance, a queued start warns', () => {
  const lim = { hoursWarn: 48, hoursCritical: 12 };
  const box = (o = {}) => ({ id: 58679966, label: 'tacit-prover', actual_status: 'running', intended_status: 'running', dph_total: 0.25, ...o });
  const node = (o = {}) => ({ id: 59942676, label: 'tacit-helpdesk-node-2', actual_status: 'running', intended_status: 'running', dph_total: 0.0622, ...o });
  // $0.3122/h: $50 lasts 160 h, $10 about 32 h, $2 about 6 h
  const fine = vastVerdict({ credit: 50 }, [box(), node()], lim);
  assert.deepEqual(fine.alerts, []);
  assert.match(fine.log, /vast credit \$50\.00 lasts about 160 h for tacit-prover, tacit-helpdesk-node-2 at \$0\.31\/h/);
  const soon = vastVerdict({ credit: 10 }, [box(), node()], lim);
  assert.equal(soon.alerts.length, 1);
  assert.equal(soon.alerts[0].level, 'warning');
  assert.match(soon.alerts[0].msg, /lasts about 32 h .* top it up at console\.vast\.ai soon/);
  assert.equal(vastVerdict({ credit: 2 }, [box(), node()], lim).alerts[0].level, 'critical');
  const zero = vastVerdict({ credit: 0 }, [box({ actual_status: 'exited', intended_status: 'stopped' }), node({ actual_status: 'exited', intended_status: 'stopped' })], lim);
  assert.equal(zero.alerts.length, 1);
  assert.equal(zero.alerts[0].level, 'critical');
  assert.match(zero.alerts[0].msg, /vast credit is \$0\.00: vast stops every instance \(tacit-prover, tacit-helpdesk-node-2\)/);
  // after a top-up the start was queued: the GPU had been rented to someone else
  const queued = vastVerdict({ credit: 4.9 }, [box({ actual_status: 'exited' }), node()], lim);
  assert.deepEqual(queued.alerts.map((a) => a.level), ['warning', 'warning']);
  assert.match(queued.alerts[0].msg, /lasts about 16 h for tacit-prover, tacit-helpdesk-node-2/, 'the queued box counts: the node alone would show 79 h');
  assert.match(queued.alerts[1].msg, /tacit-prover \(58679966\) was asked to run but is exited/);
  const parked = vastVerdict({ credit: 5 }, [box({ actual_status: 'exited', intended_status: 'stopped' })], lim);
  assert.deepEqual(parked.alerts, [], 'stopped on purpose is only logged');
  assert.match(parked.log, /no instance running/);
  assert.equal(vastVerdict(null, [], lim).log, 'vast: credit unreadable');
  assert.equal(vastVerdict({ credit: 3 }, null, lim).alerts.length, 0);
});
