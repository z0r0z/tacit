// worker-relay/src/lib/farm-bond-precheck.js: a farm entry bonded into a farm that does not hold the pool's shares is turned back before it is proved.
//   node --test tests/farm-bond-precheck.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bondBlocker, lpShareOf } from '../worker-relay/src/lib/farm-bond-precheck.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';

const dep = getConfidentialDeployment('mainnet');
const erc20Id = (token) => { const b = Buffer.alloc(46); b.write('tacit-evm-token-v1'); b.writeBigUInt64BE(1n, 18); Buffer.from(token.replace(/^0x/, ''), 'hex').copy(b, 26); return '0x' + createHash('sha256').update(b).digest('hex'); };
const SPX = erc20Id('0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c');
const idOf = { 'SPX/TAC': dep.assets.find((a) => a.ticker === 'cTAC').assetId, 'SPX/cETH': dep.assets.find((a) => a.ticker === 'cETH').assetId };
const [F_TAC, F_ETH] = dep.farm.standalone;
const MANAGER = dep.farm.manager;

// a chain that answers what the farms would: a stand-alone controller its STAKE_ASSET, the manager its pool list (and no STAKE_ASSET)
const chain = ({ stake = {}, listed = [], down = false } = {}) => ({
  readContract: async ({ address, functionName, args }) => {
    if (down) throw new Error('node did not answer');
    const a = address.toLowerCase();
    if (functionName === 'STAKE_ASSET') { if (stake[a]) return stake[a]; throw new Error('execution reverted'); }
    if (functionName === 'pidOf') { if (a !== MANAGER.toLowerCase()) throw new Error('execution reverted'); return [0n, listed.includes(String(args[0]).toLowerCase())]; }
    throw new Error('unexpected read');
  },
});
const stakes = { [F_TAC.controller.toLowerCase()]: F_TAC.lpAsset, [F_ETH.controller.toLowerCase()]: F_ETH.lpAsset };
const op = (f, over = {}) => ({ controller: f.controller, assetA: SPX, assetB: idOf[f.pair], feeBps: 30, ...over });

test('the share asset derived here is the one each SPX farm is configured for (the page, the guest and this check agree)', () => {
  for (const f of [F_TAC, F_ETH]) assert.equal(lpShareOf(SPX, idOf[f.pair], f.feeBps).toLowerCase(), f.lpAsset.toLowerCase(), f.pair);
  assert.equal(lpShareOf(idOf['SPX/TAC'], SPX, 30), lpShareOf(SPX, idOf['SPX/TAC'], 30), 'the order the notes come in does not matter');
});

test('an SPX entry into its own farm goes through; into the other SPX farm or the launch manager it is turned back', async () => {
  const c = chain({ stake: stakes, listed: dep.farm.pools.map((p) => p.lpAsset.toLowerCase()) });
  for (const f of [F_TAC, F_ETH]) assert.equal(await bondBlocker({ type: 'lpbond', op: op(f) }, { client: c }), null, `${f.pair} into its own farm`);
  assert.match(await bondBlocker({ type: 'lpbond', op: op(F_TAC, { controller: F_ETH.controller }) }, { client: c }), /does not hold the shares/, 'SPX/TAC shares into the SPX/tETH farm');
  assert.match(await bondBlocker({ type: 'lpbond', op: op(F_TAC, { controller: MANAGER }) }, { client: c }), /does not hold the shares/, 'SPX shares into the launch manager (the live failure)');
});

test('a launch pool into the manager goes through', async () => {
  const p = dep.farm.pools[0], [a, b] = p.pair.split('/').map((t) => dep.assets.find((x) => x.ticker === (t === 'TAC' ? 'cTAC' : t === 'tETH' ? 'cETH' : t)));
  assert.ok(a && b, 'the launch pair is two known assets');
  const c = chain({ stake: stakes, listed: dep.farm.pools.map((x) => x.lpAsset.toLowerCase()) });
  const lp = lpShareOf(a.assetId, b.assetId, p.feeBps ?? 30).toLowerCase();
  if (lp !== p.lpAsset.toLowerCase()) return;          // a pair whose assets are not these two tickers: the SPX checks above carry the derivation
  assert.equal(await bondBlocker({ type: 'lpbond', op: { controller: MANAGER, assetA: a.assetId, assetB: b.assetId, feeBps: p.feeBps ?? 30 } }, { client: c }), null);
});

test('anything it cannot read lets the job through, and only an lpbond is looked at', async () => {
  assert.equal(await bondBlocker({ type: 'lpbond', op: op(F_TAC) }, { client: chain({ down: true }) }), null, 'a node that does not answer');
  assert.equal(await bondBlocker({ type: 'lpbond', op: op(F_TAC, { controller: '0x' + '12'.repeat(20) }) }, { client: chain({ stake: stakes }) }), null, 'a controller that is neither kind of farm cannot be asked, so the pool decides');
  for (const bad of [{ controller: 'nope' }, { assetA: 'zz' }, { feeBps: 'x' }, { protocolFeeBps: 5 }]) assert.equal(await bondBlocker({ type: 'lpbond', op: op(F_TAC, bad) }, { client: chain({ stake: stakes }) }), null, JSON.stringify(bad));
  assert.equal(await bondBlocker({ type: 'wrap', op: op(F_TAC, { controller: MANAGER }) }, { client: chain({ stake: stakes }) }), null, 'not an lpbond');
  assert.equal(await bondBlocker({ type: 'lpbond' }, { client: chain() }), null, 'no op');
});
