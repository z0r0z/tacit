import test from 'node:test';
import assert from 'node:assert/strict';
import { praxisVerdict } from '../src/lib/praxis-health.js';

const nowMs = Date.parse('2026-11-27T12:00:00Z');
const receipt = (at = '2026-11-27T11:00:00Z', index = 84) => ({ at, index });
const verdict = (head = { index: 84, queue: 464, closed: false }, receipts = [receipt()]) => praxisVerdict(head, { closed: false, receipts }, { nowMs });

test('a moving open ceremony is healthy', () => {
  const v = verdict();
  assert.deepEqual(v.alerts, []);
  assert.match(v.log, /phase2-84; 1 contributions, queue 464, last accepted 60 min ago/);
});

test('a queued ceremony warns at two hours and pages at three', () => {
  assert.equal(verdict(undefined, [receipt('2026-11-27T10:00:00Z')]).alerts[0].level, 'warning');
  const v = verdict(undefined, [receipt('2026-11-27T09:00:00Z')]);
  assert.equal(v.alerts[0].level, 'critical');
  assert.match(v.alerts[0].msg, /not advanced for 180 min with 464 queued/);
  assert.deepEqual(verdict({ index: 84, queue: 0, closed: false }, [receipt('2026-11-27T06:00:00Z')]).alerts, [], 'an idle queue may leave the head still');
});

test('unreadable or inconsistent public state pages', () => {
  assert.equal(praxisVerdict(null, null).alerts[0].level, 'critical');
  assert.equal(verdict({ index: 84, queue: 2, closed: false }, [receipt(undefined, 83)]).alerts[0].level, 'critical');
});

test('a deliberately closed ceremony is reported without paging', () => {
  const v = praxisVerdict({ index: 90, queue: 0, closed: true }, { closed: true, receipts: [] }, { nowMs });
  assert.deepEqual(v.alerts, []);
  assert.equal(v.log, 'Praxis closed at phase2-90');
});
