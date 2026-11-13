// tools/cdp-positions.mjs reads positions out of a settle's publicValues. Two real mainnet settles (tests/fixtures/cdp-settles-mainnet.json, the
// publicValues of their transactions): one that opened a position, and the liquidation of 11-12 (0xf7e7f6f7…). The decoder once read every field one
// word early (publicValues is abi.encode(struct), whose first word is the 0x20 offset) and so found no position in any settle; this keeps it reading them.
//   node tests/cdp-positions.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeSettlePositions } from '../tools/cdp-positions.mjs';

const fx = JSON.parse(readFileSync(new URL('./fixtures/cdp-settles-mainnet.json', import.meta.url), 'utf8'));

// the settle that opened a position: one mint, whose leaf is the CdpPositionInserted topic of that transaction
const open = decodeSettlePositions(fx.open.pv, null);
assert.equal(open.mints.length, 1, 'one position opened');
assert.equal(open.mints[0].positionLeaf, fx.open.leaf, 'its leaf is the one the pool logged');
assert.ok(open.mints[0].debtValue > 0n && open.mints[0].legs.length >= 1 && open.mints[0].legs.every((l) => l.value > 0n), `a debt and a basket (${open.mints[0].debtValue} against ${open.mints[0].legs.map((l) => l.value)})`);
assert.match(open.mints[0].owner, /^0x[0-9a-f]{64}$/); assert.match(open.mints[0].controller, /^0x[0-9a-f]{40}$/);
assert.equal(open.retired.size, 0, 'and retires nothing');

// the liquidation: no position opened, and the one it retired is the nullifier the engine logged in CdpLiquidated (topic 1 of that event)
const liq = decodeSettlePositions(fx.liquidation.pv, null);
assert.equal(liq.mints.length, 0);
assert.deepEqual([...liq.retired], [fx.liquidation.retired], 'the liquidated position is read as retired');

// the same bytes without the leading 0x20 word (a caller that already stripped it) read the same
assert.deepEqual(decodeSettlePositions(fx.open.pv.slice(64), null).mints.map((m) => m.positionLeaf), [fx.open.leaf]);
// garbage and empties are read as nothing, not as a throw
assert.deepEqual(decodeSettlePositions('', null), { mints: [], retired: new Set() });
assert.deepEqual(decodeSettlePositions('00'.repeat(64), null).mints, []);

console.log('cdp-positions: all checks passed');
