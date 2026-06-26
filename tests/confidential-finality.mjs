#!/usr/bin/env node
// Unit test for the cross-chain finality indicator (dapp/confidential-finality.js): a confidential
// action is FAST-FINAL the moment its Ethereum settle lands, but only HARD-FINAL once Bitcoin-anchored.
// Asserts the classification at every boundary — unsettled, fast-final mid-window, window elapsed (still
// provisional, never auto-promoted by time alone), and authoritatively anchored — plus ETA formatting and
// badge tone, and the session store's pending detection.
//
// Run: node tests/confidential-finality.mjs

import {
  classifyFinality, formatEta, finalityBadgeHtml, FINALITY,
  trackProvisional, markAnchored, clearProvisional, listProvisional, hasPendingProvisional,
} from '../dapp/confidential-finality.js';

let n = 0, fails = 0;
function ok(cond, msg) { n++; if (!cond) { fails++; console.error('  FAIL ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const MIN = 60 * 1000;
const t0 = 1_000_000_000_000; // fixed epoch — no Date.now() so the test is deterministic

// ── unsettled ────────────────────────────────────────────────────────────────
{
  const s = classifyFinality({ settledAtMs: 0, nowMs: t0 });
  eq(s.stage, 'unsettled', 'no settle → unsettled');
  eq(s.tone, 'pending', 'unsettled is pending');
}

// ── fast-final, just settled (full window ahead) ─────────────────────────────
{
  const s = classifyFinality({ settledAtMs: t0, nowMs: t0 });
  eq(s.stage, 'fast-final', 'just settled → fast-final');
  eq(s.tone, 'pending', 'fast-final is pending');
  eq(s.anchored, false, 'not anchored yet');
  ok(s.etaMs === FINALITY.anchorWindowMs, 'eta == full window at t=settle');
  ok(/Settling to Bitcoin/.test(s.detail) && /reorg/.test(s.detail), 'detail names the reorg window');
}

// ── fast-final, mid-window (countdown shrinks) ───────────────────────────────
{
  const s = classifyFinality({ settledAtMs: t0, nowMs: t0 + 30 * MIN });
  eq(s.stage, 'fast-final', 'mid-window → still fast-final');
  ok(s.etaMs === FINALITY.anchorWindowMs - 30 * MIN, 'eta counts down');
  ok(s.etaMs < FINALITY.anchorWindowMs, 'eta shrank from full');
}

// ── window elapsed but NOT anchored: stays provisional, never auto-promoted ──
{
  const s = classifyFinality({ settledAtMs: t0, nowMs: t0 + 1000 * MIN });
  eq(s.stage, 'fast-final', 'elapsed-without-anchor stays fast-final (time alone never promotes)');
  eq(s.tone, 'pending', 'elapsed-without-anchor stays pending');
  eq(s.etaMs, 0, 'eta clamps to 0');
  eq(s.etaText, 'awaiting anchor', 'elapsed shows awaiting-anchor');
  ok(/Awaiting Bitcoin anchor/.test(s.detail), 'detail switches to awaiting-anchor');
}

// ── authoritatively anchored → hard-final, regardless of clock ───────────────
{
  const s = classifyFinality({ settledAtMs: t0, nowMs: t0 + 1 * MIN, anchored: true });
  eq(s.stage, 'hard-final', 'anchored=true → hard-final even early');
  eq(s.tone, 'final', 'hard-final is final');
  ok(/irreversible/.test(s.detail), 'detail says irreversible');
}

// ── custom anchor window override ────────────────────────────────────────────
{
  const s = classifyFinality({ settledAtMs: t0, nowMs: t0 + 10 * MIN, anchorWindowMs: 5 * MIN });
  eq(s.etaMs, 0, 'override: 10min past a 5min window → eta 0');
  eq(s.stage, 'fast-final', 'override: still provisional without an anchor');
}

// ── formatEta ────────────────────────────────────────────────────────────────
eq(formatEta(0), 'any moment', 'eta 0');
eq(formatEta(30 * 1000), '~1 min', 'sub-minute rounds up to ~1 min');
eq(formatEta(42 * MIN), '~42 min', 'minutes');
ok(/hr$/.test(formatEta(120 * MIN)), 'long windows render hours');

// ── badge HTML tone ──────────────────────────────────────────────────────────
{
  const pend = finalityBadgeHtml(classifyFinality({ settledAtMs: t0, nowMs: t0 }));
  ok(pend.includes('--amber'), 'pending badge uses amber');
  ok(pend.includes('Fast-final'), 'pending badge labelled');
  const fin = finalityBadgeHtml(classifyFinality({ settledAtMs: t0, nowMs: t0, anchored: true }));
  ok(fin.includes('--green-positive'), 'final badge uses green');
  ok(fin.includes('Bitcoin-final'), 'final badge labelled');
  // XSS guard: a hostile label/detail must not break out of the attribute/element.
  const safe = finalityBadgeHtml({ tone: 'pending', label: '<img src=x>', detail: '"oops"', etaText: '' });
  ok(!safe.includes('<img'), 'badge escapes hostile label');
}

// ── session store ─────────────────────────────────────────────────────────────
{
  trackProvisional({ id: 'a1', label: 'crossOut #1', settledAtMs: t0 });
  trackProvisional({ id: 'a2', label: 'crossOut #2', settledAtMs: t0, anchored: false });
  eq(listProvisional().length, 2, 'store holds two');
  ok(hasPendingProvisional(t0), 'has a pending action');
  markAnchored('a1'); markAnchored('a2');
  ok(!hasPendingProvisional(t0), 'none pending once all anchored');
  clearProvisional('a1'); clearProvisional('a2');
  eq(listProvisional().length, 0, 'store cleared');
}

if (fails) { console.error(`\nconfidential-finality: ${fails}/${n} checks FAILED`); process.exit(1); }
console.log(`confidential-finality: ${n}/${n} checks passed`);
