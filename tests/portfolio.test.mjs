// dapp/portfolio.js: the front page's "Your Tacit" rows sorted into the places the Portfolio sheet shows, TAC split into its private and
// public part, a pool's liquidity counted once, and each group's worth.
//   node tests/portfolio.test.mjs
import assert from 'node:assert/strict';
import { portfolio, placeOf } from '../dapp/portfolio.js';

let pass = 0;
const ok = (name, c) => { assert.ok(c, name); pass++; console.log('  ok  ' + name); };
const E18 = 10n ** 18n;
const row = (key, v, more = {}) => ({ key, label: key, v, dec: 18, max: 4, ...more });
const keys = (g) => g.rows.map((r) => r.key);
const by = (gs) => Object.fromEntries(gs.map((g) => [g.id, g]));

// the rows as the page builds them, in its order, for a key that holds some of everything
const items = [
  row('teth', 125000000n, { dec: 8, meta: 'private', core: true, noteVals: [100000000n, 25000000n] }),
  row('dev', 4n * E18 / 10n, { meta: { s: 'private on <i>chains</i>' }, where: 'on Ethereum, Base' }),
  row('devtac', 1500n * E18, { meta: 'private on this device' }),
  row('ctac', 80000000000n, { dec: 8, meta: 'private on the Tacit chain' }),
  row('devtok-usdc', 250000000n, { dec: 6, meta: 'private on this device' }),
  row('tethbtc', 700000n, { dec: 8, meta: 'on Bitcoin · 2 notes · 1 ready to bring back', href: '#private/bitcoin/back' }),
  row('tac', 12000n * E18, { priv: 9000n * E18, core: true, meta: '9,000 private · 3,000 public', noteVals: [9000n * E18] }),
  row('btc', 1500000n, { dec: 8, meta: 'at your Bitcoin address' }),
  row('btc-aaaa', 500n, { dec: 8, meta: 'on Bitcoin', btcAsset: 'aa' }),
  row('sats-tac', 200n, { dec: 8, meta: 'Secret Sats, private on Bitcoin' }),
  row('cbtc', 2000000n, { dec: 8, meta: 'BTC locked · post its bond' }),
  row('cusd', 300n, { dec: 8, meta: '300 borrowed' }),
  row('cusdt', 120n, { dec: 6, meta: 'private' }),
  row('tacbtc', E18 / 100n, { meta: 'public', asset: 'tacbtc' }),
  row('tacd', 200n * E18, { meta: 'public', asset: 'tacd' }),
  row('pts', 4200, { num: true, core: true, meta: '12.5 TAC to claim' }),
  row('lpf-0', 6n * E18 / 10n, { unit: 'ETH', meta: 'private, farming', icons: ['a', 'b'], ring: true, open: 'farm/private-0' }),
  row('lp-0', E18 / 10n, { unit: 'ETH', meta: 'private, LP only', icons: ['a', 'b'], open: 'farm/private-0' }),
  row('lp-1', E18 / 4n, { unit: 'ETH', meta: 'private, LP only', icons: ['a', 'c'], open: 'farm/private-1' }),
  row('pubf', 8n * E18 / 10n, { unit: 'ETH', meta: 'public, farming', ring: true, open: 'farm/public' }),
  row('rtac', 35n * E18, { unit: 'wTAC', meta: 'private, farm rewards' }),
  row('farm', 42n * E18, { unit: 'TAC', meta: 'about 0.005 ETH to claim' }),
  row('loans', 300n, { dec: 8, unit: 'cUSD', meta: '1 loan · 310%' }),
  row('air', 1000n * E18, { unit: 'TAC', meta: 'claim by 30 Nov' }),
];
const PX = { teth: 3400, dev: 3400, devtac: 0.5, ctac: 0.5, 'devtok-usdc': 1, tethbtc: 3400, tac: 0.5, tacpub: 0.5, btc: 97000, cbtc: 97000, cusd: 1, cusdt: 1, tacbtc: 97000, tacd: 1, 'lp-0': 3400, 'lp-1': 3400, pubf: 3400 };
const usd = (r) => (PX[r.key] != null && r.v != null ? Number(r.v) / 10 ** r.dec * PX[r.key] : null);
const amount = (v, dec) => String(Number(v) / 10 ** dec);

const gs = portfolio(items, { usd, amount }), g = by(gs);
ok('the groups come in one order: private, the pay pool, liquidity, public, Bitcoin, rewards, loans', gs.map((x) => x.id).join() === 'private,pay,lp,public,bitcoin,earned,owed');
ok('private tokens: tETH and TAC first, then the Tacit chain, then the rest as the page lists them', keys(g.private).join() === 'teth,tac,ctac,cbtc,cusd,cusdt');
ok('the pay pool: what the key holds privately on this device', keys(g.pay).join() === 'dev,devtac,devtok-usdc');
ok('public tokens: what the wallet holds', keys(g.public).join() === 'tacpub,tacbtc,tacd');
ok('on Bitcoin: BTC first, bridged notes last', keys(g.bitcoin).join() === 'btc,btc-aaaa,sats-tac,tethbtc');
ok('rewards and loans stand apart from what is held', keys(g.earned).join() === 'pts,farm,rtac,air' && keys(g.owed).join() === 'loans');

// TAC is one row on the page and two here
const tp = g.private.rows.find((r) => r.key === 'tac'), tu = g.public.rows.find((r) => r.key === 'tacpub');
ok('TAC is split: its private part with the private tokens, the rest public', tp.v === 9000n * E18 && tu.v === 3000n * E18 && tp.note === '' && tu.note === '');
ok('the notes behind it stay with the private part', tp.noteVals?.length === 1 && tu.noteVals == null);
ok('and both are counted as TAC', usd(tp) === 4500 && tu.kind === 'tac' && tu.usd === 1500);

// a pool's liquidity is one row
const lp0 = g.lp.rows.find((r) => r.key === 'lp-0'), lp1 = g.lp.rows.find((r) => r.key === 'lp-1'), pf = g.lp.rows.find((r) => r.key === 'pubf');
ok('a pool farmed in part is one row worth both parts, saying how much of each', g.lp.rows.length === 3 && lp0.v === 7n * E18 / 10n && lp0.note === '0.6 farming · 0.1 not farmed' && lp0.ring === true && lp0.open === 'farm/private-0');
ok('a pool with nothing farming says so, without the ring', lp1.v === E18 / 4n && lp1.note === 'not farmed' && lp1.ring === false);
ok('the public farm is named as that', pf.note === 'public farm' && pf.place === 'lp');

// what a row says under its name: the group already says where it is held
const note = (id, key) => g[id].rows.find((r) => r.key === key).note;
ok('"private" and "public" are not repeated on each row', note('private', 'teth') === '' && note('private', 'cusdt') === '' && note('public', 'tacbtc') === '' && note('pay', 'devtac') === '');
ok('what a row adds is kept', note('private', 'ctac') === 'on the Tacit chain' && note('private', 'cbtc') === 'BTC locked · post its bond' && note('private', 'cusd') === '300 borrowed' && note('pay', 'dev') === 'on Ethereum, Base');
ok('on Bitcoin the same', note('bitcoin', 'btc') === 'at your Bitcoin address' && note('bitcoin', 'btc-aaaa') === '' && note('bitcoin', 'sats-tac') === 'Secret Sats' && note('bitcoin', 'tethbtc') === '2 notes · 1 ready to bring back');
ok('a row keeps what opens it', g.bitcoin.rows.find((r) => r.key === 'tethbtc').href === '#private/bitcoin/back' && g.public.rows.find((r) => r.key === 'tacbtc').asset === 'tacbtc');

// worth
const sum = (id) => g[id].rows.reduce((a, r) => a + (r.usd ?? 0), 0);
ok('a group is worth its rows', Math.abs(g.private.usd - sum('private')) < 1e-9 && g.private.usd > 0 && Math.abs(g.lp.usd - (0.7 + 0.25 + 0.8) * 3400) < 1e-6);
ok('rewards and loans are not counted as held, so they carry no worth', g.earned.usd === null && g.owed.usd === null);
const all = ['private', 'pay', 'lp', 'public', 'bitcoin'].reduce((a, id) => a + g[id].usd, 0), flat = items.filter((r) => PX[r.key] != null || /^lpf?-/.test(r.key)).reduce((a, r) => a + Number(r.v) / 10 ** r.dec * (PX[r.key] ?? 3400), 0);
ok('and the groups add up to what the rows were worth before they were grouped', Math.abs(all - flat) < 1e-6);

// while it is still being read, and with no key
{
  const reading = by(portfolio([row('teth', null, { dec: 8, meta: 'private', core: true }), row('tac', null, { priv: null, core: true }), row('lpf-0', null, { unit: 'ETH', meta: 'private, farming' }), row('lp-0', E18, { unit: 'ETH', meta: 'private, LP only' })], { usd, amount }));
  ok('a balance not read yet stays unread in both TAC rows', reading.private.rows.find((r) => r.key === 'tac').v === null && reading.public.rows[0].v === null);
  ok('a pool with one part unread is not given a total, and says it is partly farming', reading.lp.rows[0].v === null && reading.lp.rows[0].note === 'partly farming');
  ok('and nothing unread is given a worth', reading.private.usd === null && reading.lp.usd === null);
}
{
  const none = by(portfolio([row('tac', 5n * E18, { priv: 0n, core: true, meta: 'on Ethereum' }), row('pts', 10, { num: true, core: true })], { usd, amount, hasKey: false }));
  ok('with only a wallet connected there is no private side: TAC is its public balance', !none.private && none.public.rows.length === 1 && none.public.rows[0].v === 5n * E18);
  const zero = by(portfolio([row('tac', 0n, { priv: 0n, core: true }), row('teth', 0n, { dec: 8, core: true, meta: 'private' })], { usd, amount }));
  ok('a key that holds no public TAC shows no public row for it', !zero.public && keys(zero.private).join() === 'teth,tac');
}
ok('a row the page adds later lands with the private or the public tokens by what it says of itself', placeOf({ key: 'new', meta: 'public' }) === 'public' && placeOf({ key: 'new', meta: 'private' }) === 'private' && placeOf({ key: 'devtok-dai', meta: 'x' }) === 'pay');
ok('nothing held is no groups', portfolio([], {}).length === 0 && portfolio(null).length === 0);

console.log(`\n${pass} passed, 0 failed`);
