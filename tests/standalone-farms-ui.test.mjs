// The page's side of the standalone farms: an entry bonds into the controller this page is configured with (never one an API answer names),
// and a pool with no tETH side (SPX/TAC) is valued at twice its TAC side.
import { farmControllerOf, farmManager } from '../dapp/farm-ops.js';
import { poolWorthEth } from '../dapp/trade/farm-read.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };
const throws = (f, re, m) => { try { f(); ok(false, m); } catch (e) { ok(re.test(e.message), `${m} (${e.message})`); } };

const cfg = getConfidentialDeployment('mainnet'), t = { cfg };
const [spxTac, spxEth] = cfg.farm.standalone;
// ---- which controller an entry bonds into ----
ok(farmControllerOf(t, { pid: 0, lpAsset: cfg.farm.pools[0].lpAsset }, cfg.farm.manager) === cfg.farm.manager, 'a launch pool bonds into the manager');
ok(farmControllerOf(t, { standalone: true, lpAsset: spxTac.lpAsset, controller: spxTac.controller }) === spxTac.controller, 'SPX/TAC bonds into its own controller');
ok(farmControllerOf(t, { standalone: true, lpAsset: spxEth.lpAsset.toUpperCase().replace('0X', '0x'), controller: spxEth.controller.toUpperCase().replace('0X', '0x') }) === spxEth.controller, 'case does not matter');
throws(() => farmControllerOf(t, { standalone: true, lpAsset: spxTac.lpAsset, controller: '0x' + 'ee'.repeat(20) }), /other than the configured/, 'an answer naming another controller for a configured pool is refused');
throws(() => farmControllerOf(t, { standalone: true, lpAsset: '0x' + '77'.repeat(32), controller: spxTac.controller }), /other than the configured/, 'a standalone pool this page does not know is refused');
throws(() => farmControllerOf(t, { standalone: true, lpAsset: spxTac.lpAsset, controller: spxEth.controller }), /other than the configured/, 'one farm\'s controller for the other\'s pool is refused');
throws(() => farmManager(t, '0x' + 'ab'.repeat(20)), /other than the configured/, 'a launch pool named under another manager is still refused');

// ---- a pool's worth in ETH ----
const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', SPX = '0x45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48';
const tacEth = 0.0001157;
ok(Math.abs(poolWorthEth({ pair: 'SPX/cETH', reserves: { assetA: CETH, assetB: SPX, reserveA: '829000', reserveB: '5000000000' } }, tacEth) - 0.01658) < 1e-9, 'SPX/tETH: twice its tETH side');
ok(Math.abs(poolWorthEth({ pair: 'SPX/TAC', reserves: { assetA: SPX, assetB: TAC, reserveA: '5100000000', reserveB: '7309305243' } }, tacEth) - 2 * 73.09305243 * tacEth) < 1e-12, 'SPX/TAC: twice its TAC side at TAC\'s price in ETH');
ok(poolWorthEth({ pair: 'SPX/TAC', reserves: { assetA: SPX, assetB: TAC, reserveA: '1', reserveB: '1' } }, 0) === null, 'no TAC price: no worth (and so no APR), not a wrong one');
ok(poolWorthEth({ pair: 'X/Y', reserves: { assetA: SPX, assetB: '0x' + '99'.repeat(32), reserveA: '1', reserveB: '1' } }, tacEth) === null, 'a pool with neither tETH nor TAC has no worth');
ok(poolWorthEth({ pair: 'TAC/cETH', reserves: { assetA: CETH, assetB: TAC, reserveA: '100000000', reserveB: '864000000000' } }, tacEth) > 0, 'a launch pool is valued as before');

console.log(`\n${n} standalone-farms-ui checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
