import assert from 'node:assert/strict';
import { simulate } from '../sim/rebalance-model.mjs';

const TAC = 100_000_000n;

{
  const r = simulate({
    initialPool: 5000n * TAC,
    bridges: Array.from({ length: 5 }, () => ({ paid: 1000n * TAC, received: 1000n * TAC, stuck: true })),
    deskFeeBps: 100,
  });
  assert.equal(r.baseline, 0n);
  assert.equal(r.recovered, 4950n * TAC);
  assert.equal(r.rows[0].output, 990n * TAC);
}

{
  const r = simulate({
    initialPool: 2000n * TAC,
    bridges: [
      { paid: 1000n * TAC, received: 1000n * TAC, stuck: true },
      { paid: 1000n * TAC, received: 1000n * TAC, stuck: false },
    ],
    deskFeeBps: 30,
  });
  assert.equal(r.baseline, 1000n * TAC);
  assert.equal(r.recovered, 1997n * TAC);
}

{
  const r = simulate({
    initialPool: 1000n * TAC,
    bridges: [{ paid: 1000n * TAC, received: 1000n * TAC, stuck: true }],
    deskFeeBps: 0,
    deskCapacity: 500n * TAC,
  });
  assert.equal(r.recovered, 0n);
  assert.equal(r.rows[0].reason, 'desk-capacity');
}

{
  assert.throws(() => simulate({
    initialPool: 1n,
    bridges: [{ paid: 0n, received: 1n, stuck: true }],
  }), /positive/);
}

console.log('ok - 4 offline inventory/accounting tests passed');
