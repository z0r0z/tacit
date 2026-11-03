// The open board from the relay's side (src/lib/open-board.js): which relayed jobs it puts on the board while the
// settle wallet cannot pay, which open job it sends first once it can, and the fee legs it reads from a proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, parseAbi } from 'viem';
import { OPEN_TYPES, POSTED_TYPES, openable, pvFees, ethFeeWei, pickOpen, STALE_PROOF_SELECTORS } from '../src/lib/open-board.js';
import { OPEN_TYPES as WORKER_OPEN_TYPES, POSTED_TYPES as WORKER_POSTED_TYPES } from '../../worker/src/confidential-settle.js';
import { pvFees as workerPvFees } from '../../worker/src/confidential-open.js';

const ETH_ID = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const SCALE = 10_000_000_000n;
const REAL = readFileSync(new URL('../../tests/fixtures/settle-split-0xf033a9be.hex', import.meta.url), 'utf8').trim();
const PV = decodeFunctionData({ abi: parseAbi(['function settle(bytes,bytes,bytes[])']), data: REAL }).args[0];

test('the relay and the API agree on which op types go on the board', () => {
  assert.deepEqual([...OPEN_TYPES].sort(), [...WORKER_OPEN_TYPES].sort());
  assert.deepEqual([...POSTED_TYPES].sort(), [...WORKER_POSTED_TYPES].sort());
});

test('fee legs read from a real settle, the same as the API reads them', () => {
  assert.deepEqual(pvFees(PV), [{ assetId: ETH_ID, value: 41000n }]);
  assert.deepEqual(workerPvFees(PV).map((f) => ({ ...f, value: BigInt(f.value) })), pvFees(PV));
  assert.equal(ethFeeWei(PV, { ethAssetId: ETH_ID, ethUnitScale: SCALE }), 41000n * SCALE);
  assert.equal(ethFeeWei(PV, { ethAssetId: '0x' + '00'.repeat(32), ethUnitScale: SCALE }), 0n, 'another asset is not priced');
  assert.equal(ethFeeWei('0x1234', { ethAssetId: ETH_ID, ethUnitScale: SCALE }), 0n, 'unreadable bytes pay nothing');
});

test('a relayed job goes on the board only when any account could send it', () => {
  assert.ok(openable({ type: 'transfer', mode: 'settle' }));
  assert.ok(openable({ type: 'unwrap' }));
  assert.ok(!openable({ type: 'unwrap', exit: { calls: [] } }), 'an exit the relay activates stays the relay\'s');
  assert.ok(!openable({ type: 'transfer', mode: 'prove' }));
  assert.ok(!openable({ type: 'wraptransfer' }), 'router-embedded');
  assert.ok(!openable({ type: 'bridgemint' }), 'pinned to a moving root');
  assert.ok(STALE_PROOF_SELECTORS.includes('0x8a98f245'));
});

test('the relay sends its own open jobs first, oldest first, then a posted proof whose tETH fee covers the settle', () => {
  const now = 10_000_000;
  const job = (o) => ({ status: 'open', type: 'transfer', publicValues: PV, proof: '0x01', openSince: 0, expiresAt: 0, posted: false, ...o });
  const opts = { settleCostWei: 300_000_000_000_000n, ethAssetId: ETH_ID, ethUnitScale: SCALE, nowMs: now };
  // 41000 units × 1e10 = 0.00041 ETH; covers 0.0003 ETH × 1.2 = 0.00036 ETH
  const posted = job({ jobId: 'p', posted: true, openSince: 1 });
  const ownOld = job({ jobId: 'a', openSince: 5 }), ownNew = job({ jobId: 'b', openSince: 9 });
  assert.equal(pickOpen([posted, ownNew, ownOld], opts).jobId, 'a');
  assert.equal(pickOpen([posted], opts).jobId, 'p');
  assert.equal(pickOpen([posted], { ...opts, settleCostWei: 400_000_000_000_000n }), null, 'a fee short of the settle with its margin is left for others');
  assert.equal(pickOpen([posted], { ...opts, settleCostWei: null }), null, 'no gas price, no posted proof');
  assert.equal(pickOpen([job({ jobId: 'x', status: 'sending' })], opts), null, 'one another relay is sending');
  assert.equal(pickOpen([job({ jobId: 'y', expiresAt: now + 60_000 })], opts), null, 'one that expires before it could land');
  assert.equal(pickOpen([job({ jobId: 'z', type: 'wraptransfer' })], opts), null);
  assert.equal(pickOpen([], opts), null);
});
