// dapp/tasks/inspect.js: where a USDT round trip stands from one Bitcoin transaction of it, with the reads stubbed.
//   node worker-relay/tests/tasks-inspect.test.mjs
import assert from 'node:assert/strict';
import { trace, idsIn, guide, CUSDT_ID, MINT_BACK_SECS, LATE_SECS } from '../../dapp/tasks/inspect.js';

const id = (n) => n.toString(16).padStart(64, '0');
const COMMIT = id(1), REVEAL = id(2), BURN = id(3), PLAIN = id(4), NONE = id(9), NU = '0x' + id(77);
const T0 = 1_793_900_000, H = 974_800;
// a chain: txid → { tx (what look says, or absent), spent (the txid that spends its first output) }
const world = (txs, { minted = false, attested = H + 10 } = {}) => ({
  look: async (t) => (txs[t] ? txs[t].tx : null),
  outspends: async (t) => (txs[t]?.spent ? [{ spent: true, txid: txs[t].spent }, { spent: false }] : [{ spent: false }]),
  minted: async () => minted,
  attested: async () => attested,
});
const other = { confirmed: true, height: H - 40, time: T0 - 9000, kind: 'other' };
const mintTx = { confirmed: true, height: H - 30, time: T0 - 8000, kind: 'crossout_mint' };
const burnTx = (extra = {}) => ({ confirmed: true, height: H, time: T0, kind: 'burn', assetId: CUSDT_ID, nullifier: NU, ...extra });
const now = T0 + MINT_BACK_SECS - 3600;

// a finished trip, named by the burn itself: the pool has minted it
let r = await trace(BURN, world({ [BURN]: { tx: burnTx() } }, { minted: true }), { now });
assert.equal(r.state, 'complete'); assert.equal(r.burn, BURN); assert.equal(r.minted, true); assert.equal(r.eta, null);

// burned, the reflection past it, the pool not yet: the mint is expected 5.5 hours after the burn's block
r = await trace(BURN, world({ [BURN]: { tx: burnTx() } }), { now });
assert.equal(r.state, 'burn-recorded'); assert.equal(r.eta, T0 + MINT_BACK_SECS); assert.equal(guide(r)[0], 'Burned on Bitcoin');

// burned, the reflection not yet at its block
r = await trace(BURN, world({ [BURN]: { tx: burnTx() } }, { attested: H - 3 }), { now });
assert.equal(r.state, 'burn-awaiting'); assert.equal(r.burn, BURN);

// the attested height unread: no claim about the reflection, the burn still shown
r = await trace(BURN, { ...world({ [BURN]: { tx: burnTx() } }), attested: async () => { throw new Error('down'); } }, { now });
assert.equal(r.state, 'burn-recorded');

// a burn that has waited past the usual time and three hours more is late, and says what to do
r = await trace(BURN, world({ [BURN]: { tx: burnTx() } }), { now: T0 + MINT_BACK_SECS + LATE_SECS + 60 });
assert.equal(r.state, 'burn-late'); assert.match(r.text, /Discord/); assert.equal(guide(r)[0], 'Burned, minting late');

// named by the commit of the mint on Bitcoin: followed through the reveal to the burn that spends its note
const trip = { [COMMIT]: { tx: other, spent: REVEAL }, [REVEAL]: { tx: mintTx, spent: BURN }, [BURN]: { tx: burnTx() } };
r = await trace(COMMIT, world(trip, { minted: true }), { now });
assert.equal(r.state, 'complete'); assert.equal(r.burn, BURN);

// the same trip before the burn: the USDT sits on Bitcoin, and the card says to bring it back
r = await trace(COMMIT, world({ [COMMIT]: trip[COMMIT], [REVEAL]: { tx: mintTx } }), { now });
assert.equal(r.state, 'on-bitcoin'); assert.equal(r.burn, undefined); assert.match(r.text, /Bring it back/); assert.equal(guide(r)[0], 'USDT on Bitcoin');
r = await trace(REVEAL, world({ [REVEAL]: { tx: mintTx } }), { now });
assert.equal(r.state, 'on-bitcoin');

// a burn of another asset is not the USDT's
r = await trace(BURN, world({ [BURN]: { tx: burnTx({ assetId: '0x' + id(7) }) } }), { now });
assert.equal(r.state, 'other-asset');

// not on Bitcoin, not yet confirmed, a transaction that is none of the bridge's, an unreadable answer
assert.equal((await trace(NONE, world({}), { now })).state, 'absent');
assert.equal((await trace(BURN, world({ [BURN]: { tx: burnTx({ confirmed: false, height: null, time: null }) } }), { now })).state, 'unconfirmed');
assert.equal((await trace(PLAIN, world({ [PLAIN]: { tx: other } }), { now })).state, 'not-tacit');
assert.equal((await trace(PLAIN, { ...world({}), look: async () => { throw new Error('down'); } }, { now })).state, 'unreachable');
assert.equal((await trace(COMMIT, { ...world(trip), outspends: async () => null }, { now })).state, 'unreachable');

// a pool that could not be read is not a mint: the burn waits, and is not counted complete
r = await trace(BURN, { ...world({ [BURN]: { tx: burnTx() } }), minted: async () => { throw new Error('rpc'); } }, { now });
assert.equal(r.state, 'burn-recorded'); assert.equal(r.minted, null);

// a loop of spends ends at the hop limit
const loop = { [COMMIT]: { tx: other, spent: REVEAL }, [REVEAL]: { tx: other, spent: COMMIT } };
assert.equal((await trace(COMMIT, world(loop), { now })).state, 'not-tacit');

// what a tester pastes: Bitcoin links and ids, Etherscan links told apart by the 0x
const pasted = `claim https://etherscan.io/tx/0x${id(11)}\nburn https://mempool.space/tx/${id(12).toUpperCase()} and ${id(13)} again ${id(13)}`;
const got = idsIn(pasted);
assert.deepEqual(got.btc, [id(12), id(13)]); assert.deepEqual(got.eth, [id(11)]);
assert.deepEqual(idsIn('nothing here'), { btc: [], eth: [] });

console.log('tasks-inspect: ok');
