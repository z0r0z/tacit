// The burn-deposit tracer's backward walk over the cxfer graph: collects every lineage cxfer from a note
// back to C_0, dedup'd, and fails on a dead-end. Pure logic (mock graph) — the worker supplies the real
// getCxferByOutput from its reflection indexer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBurnDepositTracer } from '../dapp/burn-deposit-tracer.js';

const opk = (t, v) => `${t}:${v}`;
const tracer = makeBurnDepositTracer({ outpointKey: opk });
const C0 = opk('c0', 0);
const graphOf = (map) => (op) => map[op] || null;
const cxf = (txid, inputs) => ({ txid, inputs, outputs: [], rangeProof: '', kernelSig: '', blockTxids: [], index: 0 });

test('linear depth-2 lineage traces to C_0', () => {
  const g = graphOf({
    'B:0': cxf('B', [{ prevTxid: 'A', prevVout: 0 }]),
    'A:0': cxf('A', [{ prevTxid: 'c0', prevVout: 0 }]),
  });
  const cxfers = tracer.trace({ getCxferByOutput: g, noteOutpoint: 'B:0', c0Outpoint: C0 });
  assert.deepEqual(cxfers.map((c) => c.txid), ['B', 'A']);
});

test('branchy merge collects all lineage cxfers', () => {
  const g = graphOf({
    'M:0': cxf('M', [{ prevTxid: 'P', prevVout: 0 }, { prevTxid: 'Q', prevVout: 0 }]),
    'P:0': cxf('P', [{ prevTxid: 'c0', prevVout: 0 }]),
    'Q:0': cxf('Q', [{ prevTxid: 'c0', prevVout: 0 }]),
  });
  const cxfers = tracer.trace({ getCxferByOutput: g, noteOutpoint: 'M:0', c0Outpoint: C0 });
  assert.deepEqual(cxfers.map((c) => c.txid).sort(), ['M', 'P', 'Q']);
});

test('diamond lineage dedups the shared cxfer', () => {
  const g = graphOf({
    'M:0': cxf('M', [{ prevTxid: 'P', prevVout: 0 }, { prevTxid: 'Q', prevVout: 0 }]),
    'P:0': cxf('P', [{ prevTxid: 'X', prevVout: 0 }]),
    'Q:0': cxf('Q', [{ prevTxid: 'X', prevVout: 1 }]),
    'X:0': cxf('X', [{ prevTxid: 'c0', prevVout: 0 }]),
    'X:1': cxf('X', [{ prevTxid: 'c0', prevVout: 0 }]),
  });
  const cxfers = tracer.trace({ getCxferByOutput: g, noteOutpoint: 'M:0', c0Outpoint: C0 });
  assert.deepEqual(cxfers.map((c) => c.txid).sort(), ['M', 'P', 'Q', 'X']); // X once
});

test('dangling lineage (unknown producer) throws', () => {
  assert.throws(
    () => tracer.trace({ getCxferByOutput: graphOf({}), noteOutpoint: 'Z:0', c0Outpoint: C0 }),
    /not produced by a known cxfer/
  );
});

test('note == C_0 throws', () => {
  assert.throws(
    () => tracer.trace({ getCxferByOutput: graphOf({}), noteOutpoint: C0, c0Outpoint: C0 }),
    /supply leaf itself/
  );
});

// ---- mintable: the walk stops at an authorized cmint output too (leaf set = C_0 ∪ cmints) ----
test('lineage rooting at a cmint leaf traces to that leaf', () => {
  const CM = opk('cm', 0); // an issuer-authorized cmint output
  const g = graphOf({
    'B:0': cxf('B', [{ prevTxid: 'A', prevVout: 0 }]),
    'A:0': cxf('A', [{ prevTxid: 'cm', prevVout: 0 }]), // A spends the cmint, not C_0
  });
  const cxfers = tracer.trace({ getCxferByOutput: g, noteOutpoint: 'B:0', leafOutpoints: [C0, CM] });
  assert.deepEqual(cxfers.map((c) => c.txid), ['B', 'A'], 'stops at the cmint leaf (CM not a known cxfer)');
});

test('mixed lineage from BOTH C_0 and a cmint leaf', () => {
  const CM = opk('cm', 0);
  const g = graphOf({
    'M:0': cxf('M', [{ prevTxid: 'P', prevVout: 0 }, { prevTxid: 'Q', prevVout: 0 }]),
    'P:0': cxf('P', [{ prevTxid: 'c0', prevVout: 0 }]), // P from C_0
    'Q:0': cxf('Q', [{ prevTxid: 'cm', prevVout: 0 }]), // Q from the cmint
  });
  const cxfers = tracer.trace({ getCxferByOutput: g, noteOutpoint: 'M:0', leafOutpoints: [C0, CM] });
  assert.deepEqual(cxfers.map((c) => c.txid).sort(), ['M', 'P', 'Q']);
});

test('without the cmint in the leaf set, a cmint-rooted lineage dead-ends', () => {
  const g = graphOf({
    'A:0': cxf('A', [{ prevTxid: 'cm', prevVout: 0 }]),
  });
  // only C_0 is a leaf → the cmint outpoint is an unknown producer → throws (can't bridge scan-free)
  assert.throws(
    () => tracer.trace({ getCxferByOutput: g, noteOutpoint: 'A:0', c0Outpoint: C0 }),
    /not a supply leaf/
  );
});

test('note == a cmint leaf throws (bridge it via a cxfer first)', () => {
  const CM = opk('cm', 0);
  assert.throws(
    () => tracer.trace({ getCxferByOutput: graphOf({}), noteOutpoint: CM, leafOutpoints: [C0, CM] }),
    /supply leaf itself/
  );
});
