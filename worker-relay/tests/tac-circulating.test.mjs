// lib/tac-circulating.js: TAC's circulating supply for CoinGecko, from the wallets that hold TAC that is not circulating.
//   node worker-relay/tests/tac-circulating.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeCirculating, uncirculatedWallets, parseExcluded, plainValue, OPS_MULTISIG, TAC_AIRDROP } from '../src/lib/tac-circulating.js';
import { TAC_ETCH_SUPPLY } from '../src/lib/tac-supply.js';

const TAC = 10n ** 18n;
const TOKEN = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const DISTRIBUTOR = '0x000000C918e44A3a443937fA7594eA4f7C95D6b9';
const TEAM = '0x1111111111111111111111111111111111111111';
let n = 0;
const ok = (msg) => { n++; console.log(`ok - ${msg}`); };

// The addresses are the repo's own, to the byte (a near-miss of the multisig strands admin control).
{
  const dep = JSON.parse(readFileSync(new URL('../../contracts/deployments/1.json', import.meta.url), 'utf8'));
  assert.equal(OPS_MULTISIG, dep.engineAdmin, 'the ops multisig is deployments/1.json engineAdmin');
  const stats = readFileSync(new URL('../../dapp/weld/stats/read.js', import.meta.url), 'utf8');
  assert.equal(TAC_AIRDROP, /airdrop: '(0x[0-9a-fA-F]{40})'/.exec(stats)[1], 'the airdrop is the stats page\'s');
  const render = readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');
  assert.ok(render.includes(`value: "${DISTRIBUTOR}"`), 'the distributor the points service runs with');
  assert.ok(/key: POINTS_SUPPLY_EXCLUDED\n\s+sync: false/.test(render), 'the extra wallets are dashboard only');
  ok('the multisig, the airdrop and the distributor are the repo\'s addresses, to the byte');
}

// The service reads these from ADDR, not CFG (a read with no token address went out as "Transaction creation failed" on the first deploy).
{
  process.env.RPC_URL ??= 'http://127.0.0.1:8545';     // the config insists on a node; nothing here connects to it
  const { ADDR, CFG } = await import('../src/lib/config.js');
  assert.equal(ADDR.tacToken, TOKEN, 'ADDR holds the TAC token');
  assert.equal(typeof ADDR.pointsSupplyExcluded, 'string', 'ADDR holds the extra wallets setting');
  assert.equal(CFG.tacToken, undefined, 'and CFG does not, so reading it from CFG gives nothing');
  const wiring = /makeCirculating\(\{[\s\S]*?\}\);/.exec(readFileSync(new URL('../src/points-indexer.js', import.meta.url), 'utf8'))[0];
  assert.ok(/token: ADDR\.tacToken/.test(wiring) && /distributor: ADDR\.pointsDistributor/.test(wiring), 'the indexer wires the token and the distributor from ADDR');
  assert.ok(!/CFG\.(tacToken|pointsDistributor|pointsSupplyExcluded)\b/.test(readFileSync(new URL('../src/points-indexer.js', import.meta.url), 'utf8')), 'and reads none of them from CFG');
  ok('the indexer reads the token, the distributor and the extra wallets from ADDR');
}

// A fake chain: balanceOf by wallet.
const chain = (balances, calls = []) => ({
  readContract: async ({ address, functionName, args }) => {
    calls.push([address, functionName, args[0]]);
    const v = balances[String(args[0]).toLowerCase()];
    if (v instanceof Error) throw v;
    return v ?? 0n;
  },
});
const held = { [OPS_MULTISIG.toLowerCase()]: 1_132_079n * TAC + 98n * TAC / 100n, [TAC_AIRDROP.toLowerCase()]: 334_374n * TAC + 9n * TAC / 10n, [DISTRIBUTOR.toLowerCase()]: 28_254n * TAC + 2n * TAC / 10n };
const wallets = uncirculatedWallets({ distributor: DISTRIBUTOR });

{
  const get = makeCirculating({ client: chain(held), token: TOKEN, wallets, nowMs: () => 1_000_000 });
  const r = await get();
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.total_supply, 21_000_000);
  assert.equal(b.max_supply, 21_000_000);
  assert.equal(b.decimals, 18);
  assert.equal(b.symbol, 'TAC');
  const out = 1_132_079.98 + 334_374.9 + 28_254.2;
  assert.ok(Math.abs(b.circulating_supply - (21_000_000 - out)) < 1e-6, `circulating is 21,000,000 less what the wallets hold (${b.circulating_supply})`);
  assert.deepEqual(b.excluded.map((e) => e.address), [OPS_MULTISIG, TAC_AIRDROP, DISTRIBUTOR]);
  assert.equal(b.excluded[0].balance, 1_132_079.98);
  assert.equal(typeof b.circulating_supply, 'number', 'a number, with its decimals');
  assert.equal(b.updated, '1970-01-01T00:16:40.000Z');
  ok('circulating is the fixed total less the wallets, as a JSON number with decimals');
}

// Wallets: each once, extras added, a bad entry named and left out.
{
  assert.equal(uncirculatedWallets({ distributor: '' }).length, 2, 'no distributor set, none listed');
  const w = uncirculatedWallets({ distributor: DISTRIBUTOR.toLowerCase(), extra: [OPS_MULTISIG, TEAM] });
  assert.deepEqual(w.map((x) => x.address), [OPS_MULTISIG, TAC_AIRDROP, DISTRIBUTOR, TEAM], 'a wallet named twice is subtracted once');
  assert.equal(w[3].label, 'project wallet');
  const p = parseExcluded(` ${TEAM.toLowerCase()} , nope ,, ${DISTRIBUTOR} `);
  assert.deepEqual(p.ok, [TEAM, DISTRIBUTOR]);
  assert.deepEqual(p.bad, ['nope']);
  assert.deepEqual(parseExcluded(''), { ok: [], bad: [] });
  ok('wallets are listed once, extras are added and a bad entry is reported');
}

// An answer is kept for the ttl, and a flood of requests is one read.
{
  const calls = [];
  let t = 0;
  const get = makeCirculating({ client: chain(held, calls), token: TOKEN, wallets, nowMs: () => t, ttlMs: 60_000 });
  await Promise.all([get(), get(), get()]);
  assert.equal(calls.length, wallets.length, 'three requests at once read each wallet once');
  t = 59_000; await get();
  assert.equal(calls.length, wallets.length, 'within the ttl nothing is read');
  t = 61_000; await get();
  assert.equal(calls.length, wallets.length * 2, 'after it, one more read');
  ok('requests share a read, and an answer is kept for the ttl');
}

// A read that fails: the last good answer for an hour, then an honest 503.
{
  const bal = { ...held };
  let t = 0;
  const get = makeCirculating({ client: chain(bal), token: TOKEN, wallets, nowMs: () => t, ttlMs: 60_000, staleMs: 3_600_000 });
  const good = await get();
  bal[OPS_MULTISIG.toLowerCase()] = new Error('rpc down');
  t = 120_000;
  const r = await get();
  assert.equal(r.status, 200);
  assert.equal(r.body.stale, true, 'said to be stale');
  assert.equal(r.body.circulating_supply, good.body.circulating_supply, 'the last good figure');
  t = 4_000_000;
  const gone = await get();
  assert.equal(gone.status, 503, 'not served as current after an hour');
  const never = makeCirculating({ client: chain({ [OPS_MULTISIG.toLowerCase()]: new Error('down') }), token: TOKEN, wallets, nowMs: () => 0 });
  assert.equal((await never()).status, 503, 'and with nothing read yet');
  ok('a failed read serves the last good answer for an hour, then 503');
}

// More held than the total can never read as a negative supply.
{
  const get = makeCirculating({ client: chain({ [OPS_MULTISIG.toLowerCase()]: TAC_ETCH_SUPPLY + TAC }), token: TOKEN, wallets, nowMs: () => 0 });
  assert.equal((await get()).body.circulating_supply, 0);
  ok('the circulating supply is never negative');
}

// The two plain-number answers: one figure, nothing else, and valid JSON too.
{
  const r = await makeCirculating({ client: chain(held), token: TOKEN, wallets, nowMs: () => 0 })();
  const circ = plainValue(r, 'circulating'), total = plainValue(r, 'total');
  assert.deepEqual([circ.status, total.status], [200, 200]);
  assert.equal(total.text, '21000000', 'the total is the bare number');
  assert.equal(JSON.parse(circ.text), r.body.circulating_supply, 'the circulating figure is the same number, decimals kept');
  assert.ok(/^\d+(\.\d+)?$/.test(circ.text) && /^\d+$/.test(total.text), 'digits only, no exponent, no quotes, no object');
  const down = plainValue({ status: 503, body: { error: 'supply is not readable right now' } }, 'circulating');
  assert.equal(down.status, 503, 'a failed read is a 503, never a number');
  assert.ok(!/^\d/.test(down.text));
  const src = readFileSync(new URL('../src/points-indexer.js', import.meta.url), 'utf8');
  assert.ok(src.includes("'/supply/total'") && src.includes("'/supply/circulating'") && /plainValue\(await circulating\(\)/.test(src), 'the indexer serves both routes from the same read');
  ok('/supply/total and /supply/circulating answer one bare number each');
}

console.log(`\n${n} tac-circulating checks passed`);
