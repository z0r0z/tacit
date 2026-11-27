// The provider's volume and typical time (fastbridge-lp/lib/stats.mjs addVolume): each swap once, the Bitcoin side in sats, a median over the last fifty.
//   node tests/fastbridge-lp-stats-volume.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
const S = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { emptyStats, addVolume, statsView } = await import(`${S}/fastbridge-lp/lib/stats.mjs`);

test('volume adds each swap once, and a typical time shows only once there are three', () => {
  const st = emptyStats(1000);
  assert.equal(statsView(st).volumeSats, '0'); assert.equal(statsView(st).volumeEth, '0'); assert.equal(statsView(st).medianSecs, null);
  assert.equal(addVolume(st, { id: 'f:a', sats: '26000', eth: '800000', secs: 600 }), true);
  assert.equal(addVolume(st, { id: 'f:a', sats: '26000', eth: '800000', secs: 600 }), false, 'the same swap is not counted twice');
  addVolume(st, { id: 'r:b', sats: 1_000_000n, eth: '30000000', secs: 1500 });
  assert.equal(statsView(st).volumeSats, '1026000');
  assert.equal(statsView(st).volumeEth, '30800000');
  assert.equal(statsView(st).medianSecs, null, 'two swaps are not a typical time');
  addVolume(st, { id: 'f:c', sats: '50000', secs: 900 });
  assert.equal(statsView(st).medianSecs, 900);
});

test('odd durations are left out of the time and the last fifty are kept; an old state without volume still reads', () => {
  const st = emptyStats(1000);
  addVolume(st, { id: 'x', sats: '1', secs: -5 }); addVolume(st, { id: 'y', sats: '1', secs: NaN }); addVolume(st, { id: 'z', sats: '1', secs: 10 * 86400 });
  assert.equal(st.vol.durs.length, 0); assert.equal(statsView(st).volumeSats, '3');
  for (let i = 0; i < 60; i++) addVolume(st, { id: `n${i}`, sats: '1', secs: 100 + i });
  assert.equal(st.vol.durs.length, 50);
  const old = emptyStats(1000); delete old.vol;
  assert.equal(statsView(old).volumeSats, '0'); assert.equal(statsView(old).volumeEth, '0');
  addVolume(old, { id: 'q', sats: '7', secs: 60 });
  assert.equal(statsView(old).volumeSats, '7');
});

test('an old sats-only volume can backfill ETH without counting BTC twice', () => {
  const st = emptyStats(1000); st.vol = { ids: { a: 1 }, sats: '12', durs: [60] };
  assert.equal(addVolume(st, { id: 'a', sats: '12', eth: '34', secs: 60 }), true);
  assert.equal(statsView(st).volumeSats, '12'); assert.equal(statsView(st).volumeEth, '34');
  assert.equal(addVolume(st, { id: 'a', sats: '12', eth: '34', secs: 60 }), false);
});
