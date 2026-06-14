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
    /the note is C_0/
  );
});
