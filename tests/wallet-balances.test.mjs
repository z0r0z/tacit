import assert from 'node:assert/strict';
import { balanceRows } from '../dapp/wallet-balances.js';

const tokens = { icon: (id) => ({ tac: 'tk-tac', teth: 'tk-teth' })[id] || null, dp: (id) => ({ tac: 2, teth: 6 })[id], act: (id) => (id === 'tac' ? { label: 'Bridge', link: 'bridge' } : null) };
const row = (key, v, more = {}) => ({ key, label: key.toUpperCase(), v, dec: 8, max: 4, ...more });
const keys = (rs) => rs.map((r) => r.key);

// the panel's rows as the page builds them, with a key that holds some of each
const items = [
  row('teth', 50000000n, { core: true, meta: 'private' }),
  row('dev', 0n, { show: false }),
  row('devtac', 3n * 10n ** 18n, { show: true }),
  row('tac', 7n * 10n ** 18n, { core: true }),
  row('btc', null, { lazy: true, meta: 'and 12.00 TAC on Bitcoin' }),
  row('sats-tac', 400n, { show: true, meta: 'Secret Sats, private on Bitcoin' }),
  row('tethbtc', 100n, { show: true, meta: 'on Bitcoin · 1 note' }),
  row('cusd', 0n, { show: false }),
  row('pts', 12, { core: true, num: true }),
  row('farm', 5n, { show: true }),
  row('loans', 9n, { show: true }),
  row('air', 1n, { show: true }),
];

// before the Bitcoin address is read: BTC is a row waiting on its read, the bridged rows stand in, Ethereum rows are the panel's
{
  const r = balanceRows(items, null, tokens);
  assert.deepEqual(keys(r.bitcoin), ['btc', 'sats-tac', 'tethbtc']);
  assert.equal(r.bitcoin[0].v, null, 'BTC is still being read');
  assert.equal(r.bitcoin[0].err, false);
  assert.deepEqual(keys(r.ethereum), ['teth', 'devtac', 'tac'], 'zero rows and rows that are not balances (points, rewards, loans, airdrop) are left out');
}

// a failed read says so, for the row to say it could not be read
assert.equal(balanceRows(items, { ready: false, err: new Error('x') }, tokens).bitcoin[0].err, true);

// once read: every asset on the address is a row of its own (TAC no longer a clause of BTC's line), the stand-ins are gone, Secret Sats stay
{
  const btc = { ready: true, sats: 150000n, silent: 50000n, pending: 7000n, held: [
    { id: 'tac', ticker: 'TAC', decimals: 8, balance: 1200n * 10n ** 8n, known: true },
    { id: 'teth', ticker: 'tETH', decimals: 8, balance: 100n, known: true },
    { id: 'ab'.repeat(32), ticker: 'XYZ', decimals: 2, balance: 5n, known: true },
    { id: 'cd'.repeat(32), ticker: '???', decimals: 0, balance: 9n, known: false },
    { id: 'ef'.repeat(32), ticker: 'GONE', decimals: 8, balance: 0n, known: true },
  ] };
  const r = balanceRows(items, btc, tokens);
  assert.deepEqual(keys(r.bitcoin), ['btc', 'held-tac', 'held-teth', `held-${'ab'.repeat(32)}`, 'sats-tac']);
  const [own, tac, teth, xyz] = r.bitcoin;
  assert.equal(own.v, 200000n, 'confirmed and silent sats');
  assert.equal(own.pending, 7000n);
  assert.deepEqual([tac.label, tac.v, tac.dec, tac.max, tac.icon, tac.meta], ['TAC', 1200n * 10n ** 8n, 8, 2, 'tk-tac', 'on Bitcoin']);
  assert.equal(teth.icon, 'tk-teth');
  assert.deepEqual([xyz.icon, xyz.mark, xyz.markId, xyz.max], [undefined, 'XYZ', 'ab'.repeat(32), 4], 'an asset with no mark of its own is a lettered one');
  // each row on Bitcoin goes to the Bitcoin sheet (an asset's to its send form), and TAC alone offers the bridge
  assert.deepEqual([own.open, own.btcAsset], ['btc', undefined]);
  assert.deepEqual([tac.open, tac.btcAsset, tac.act], ['btc', 'tac', { label: 'Bridge', link: 'bridge' }]);
  assert.deepEqual([teth.btcAsset, teth.act, xyz.btcAsset, xyz.act], ['teth', undefined, 'ab'.repeat(32), undefined]);
  assert.deepEqual(keys(r.ethereum), ['teth', 'devtac', 'tac']);
}

// no sats and nothing else on the address: BTC at zero still has its row, to say where sats go
{
  const r = balanceRows([], { ready: true, sats: 0n, silent: 0n, pending: 0n, held: [] }, tokens);
  assert.deepEqual(keys(r.bitcoin), ['btc']);
  assert.equal(r.bitcoin[0].v, 0n);
  assert.equal(r.bitcoin[0].pending, null);
  assert.deepEqual(r.ethereum, []);
}
console.log('wallet balances checks passed');
