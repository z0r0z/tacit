#!/usr/bin/env node
// The header feeder (worker-relay/src/header-relay.js findResumeHeight) restores the canonical chain after the
// relay's tip lands on an abandoned branch of ANY depth: it walks the relay's parents back to the last block the
// explorer agrees on, raises a deep fork (past the alert depth) instead of throwing, skips canonical blocks the
// relay already stores so a multi-batch restore makes progress, and only fails when the relay shares no block
// with the explorer at all.
//
// Run: node tests/header-relay-fork.mjs

import assert from 'node:assert';

Object.assign(process.env, {
  WORKER_BASE: 'http://127.0.0.1:1', BOX_TOKEN: 'x', RPC_URL: 'http://127.0.0.1:1',
  RELAY_KEY: '0x0000000000000000000000000000000000000000000000000000000000000001',
});
const { findResumeHeight } = await import('../worker-relay/src/header-relay.js');
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// Relay hashes are internal byte order; the explorer shows them reversed.
const h32 = (tag, i) => (tag + i.toString(16)).padStart(64, '0');
const rev = (h) => h.match(/../g).reverse().join('');
// A chain: canonical blocks 0..N on the explorer; the relay stores canonical 0..fork and a branch fork+1..tip.
function world({ fork, tip, canonicalKnownTo = fork, explorerTip = tip + 20 }) {
  const canon = (i) => h32('c', i), branch = (i) => h32('b', i);
  const relayHash = (i) => (i <= fork ? canon(i) : branch(i));
  const parent = new Map();
  for (let i = 1; i <= tip; i++) parent.set('0x' + relayHash(i), '0x' + relayHash(i - 1));
  for (let i = fork + 1; i <= canonicalKnownTo; i++) parent.set('0x' + canon(i), '0x' + canon(i - 1));
  parent.set('0x' + relayHash(0), '0x' + '00'.repeat(32));
  const known = new Set([...parent.keys()]);
  return {
    tipHeight: tip,
    tipHash: '0x' + relayHash(tip),
    parentOf: async (h) => parent.get(h) || '0x' + '00'.repeat(32),
    explorerHashAt: async (i) => { if (i > explorerTip) throw new Error('beyond explorer tip'); return rev(canon(i)); },
    isKnown: async (explorerHash) => known.has('0x' + rev(explorerHash)),
    maxHeight: explorerTip,
  };
}

// 1. relay on the canonical chain: resume from its tip, no alert
{
  const alerts = [];
  const r = await findResumeHeight({ ...world({ fork: 100, tip: 100 }), alertDepth: 12, onDeepFork: (a) => alerts.push(a) });
  assert.deepStrictEqual([r.height, r.depth, alerts.length], [100, 0, 0]);
  ok('canonical tip: resume from the tip, no alert');
}
// 2. shallow abandoned branch: walk back to the common ancestor, no alert
{
  const alerts = [];
  const r = await findResumeHeight({ ...world({ fork: 95, tip: 100 }), alertDepth: 12, onDeepFork: (a) => alerts.push(a) });
  assert.deepStrictEqual([r.height, r.depth, alerts.length], [95, 5, 0]);
  ok('5-block branch: resume from the common ancestor');
}
// 3. a branch deeper than the alert depth: recovers (no throw) and raises the alert
{
  const alerts = [];
  const r = await findResumeHeight({ ...world({ fork: 60, tip: 100 }), alertDepth: 12, onDeepFork: (a) => alerts.push(a) });
  assert.deepStrictEqual([r.height, r.depth], [60, 40], '40-block fork resumes from its ancestor');
  assert.deepStrictEqual(alerts, [{ depth: 40, height: 60, tipHeight: 100 }], 'deep fork is alerted');
  ok('40-block branch (past the 12-block alert depth): recovers and alerts instead of throwing');
}
// 4. a restore in progress: canonical blocks already submitted past the ancestor are skipped
{
  const r = await findResumeHeight({ ...world({ fork: 60, tip: 100, canonicalKnownTo: 90 }), alertDepth: 12 });
  assert.deepStrictEqual([r.ancestor, r.height], [60, 90], 'continues after the last canonical block the relay stores');
  ok('multi-batch restore continues from the relay\'s last stored canonical block, not the ancestor');
}
// 5. no shared block at all: a clear error
{
  const w = world({ fork: 100, tip: 100 });
  await assert.rejects(findResumeHeight({ ...w, explorerHashAt: async () => 'ff'.repeat(32), alertDepth: 12 }), /shares no block/);
  ok('a relay with no block in common with the explorer fails loudly');
}

console.log(`\n${n}/5 header-relay fork-recovery checks passed`);
