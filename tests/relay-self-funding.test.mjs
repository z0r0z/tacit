// The relay funds the wallets that actually spend, and charges for the work it actually does.
//
// This pins properties that fail silently when broken, with no symptom beyond a wallet quietly reaching
// zero:
//   1. the replenish cron actually runs;
//   2. SETTLE_KEY is split from RELAY_KEY, so the monitor and replenish must watch and fund both — the
//      wallet that earns the fees and burns the settle gas must never go unwatched or unfunded;
//   3. the fee gate must refuse an op with no `op.feeUsd`, not pass it for free;
//   4. the maintenance lane (Bitcoin header attestation) must be priced into the cost model, or every op
//      is priced below its true cost.
//
// Run: node tests/relay-self-funding.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
// Real-shaped ops for the types the door checks (worker/src/op-admit.js): the fixtures the prover's harnesses were built against.
const SHAPED_OP = Object.fromEntries([['cbtcmint', 'cbtc_mint_op'], ['cdpmint', 'cdp_mint_op'], ['cdptopup', 'cdp_topup_op'], ['farmunbond', 'farm_unbond_op']].map(([t, f]) => [t, JSON.parse(read(`contracts/sp1/confidential/fixtures/${f}.json`))]));
const chain = read('worker-relay/src/lib/chain.js');
const config = read('worker-relay/src/lib/config.js');
const monitor = read('worker-relay/src/balance-monitor.js');
const replenish = read('worker-relay/src/replenish.js');
const settle = read('worker-relay/src/settle-relay.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const pending = [];
const test = (label, fn) => {
  let r;
  try { r = fn(); } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; return; }
  if (r && typeof r.then === 'function') {
    // Async test: register it so the summary waits for it, and print in order of completion.
    pending.push(r.then(() => { console.log(`  PASS  ${label}`); pass++; }).catch((e) => { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }));
  } else { console.log(`  PASS  ${label}`); pass++; }
};

console.log('relay self-funding:\n');

test('fundedWallets names both spending roles and dedupes them', () => {
  ok(/export const fundedWallets/.test(chain), 'fundedWallets not exported');
  ok(/\['relay', relayWallet\]/.test(chain) && /\['settle', settleWallet\]/.test(chain),
    'fundedWallets must cover both the relay and settle roles');
  // SETTLE_KEY defaults to RELAY_KEY. A single-key deployment must collapse to ONE entry carrying both
  // roles, or the monitor double-reports and replenish sweeps the same wallet twice.
  ok(/seen\.get\(addr\)/.test(chain) && /prior\.roles\.push\(role\)/.test(chain),
    'a shared key must collapse to one entry with both roles, not two entries');
});

test('the monitor checks every funded wallet, not just RELAY_KEY', () => {
  const block = monitor.slice(monitor.indexOf('async function checkEth'), monitor.indexOf('async function checkSnapshotCapacity'));
  ok(/for \(const \{ address, roles \} of watchedWallets\)/.test(block), 'checkEth does not iterate watchedWallets');
  ok(!/relayWallet\.account\.address/.test(block), 'checkEth still pins the relay wallet');
  // Each wallet's burn depends on the roles it carries (maintenance vs settles), so the roles must feed the
  // runway. The arithmetic itself is tested with real numbers in capacity-monitoring.test.mjs.
  ok(/burnGasPerDay\(\{ roles,/.test(block) || /const burn = \{ roles,/.test(block), 'runway must be computed from the wallet\'s roles');
  ok(/gas: OP_GAS/.test(block), 'runway must use the measured gas table');
});

const loopOf = () => replenish.slice(replenish.indexOf('for (const { address: owner, wallet, roles: held } of earners)'), replenish.indexOf("log('replenish done')"));

test('replenish sweeps every earner, and the sink is the relay wallet', () => {
  ok(/for \(const \{ address: owner, wallet, roles: held \} of earners\)/.test(replenish), 'the sweep does not iterate earners');
  ok(/const sink = relayWallet;/.test(replenish), 'the sink must be the relay wallet');
  // Swaps and transfers inside the earner loop must be signed by the EARNER's own handle. A stray
  // `relayWallet.` there would send one wallet's swap from another's key.
  const loop = loopOf();
  ok(loop.length > 0, 'earner loop not found');
  ok(!/relayWallet\./.test(loop), 'the earner loop references relayWallet directly');
  for (const call of ['maxPreApprove(assets, wallet, false)', 'fireSwap(q, wallet)']) {
    ok(loop.includes(call), `earner loop does not sign with the earner's own wallet: ${call}`);
  }
  // The treasury pass moves the settle wallet's ETH (lib/treasury-plan.js) and signs with that wallet's own handle too.
  const treasury = replenish.slice(replenish.indexOf('async function runTreasury'), replenish.indexOf('// One replenish pass'));
  ok(treasury.length > 0, 'treasury pass not found');
  ok(/const owner = earner\.address, mover = earner\.publicWallet \|\| earner\.wallet/.test(treasury), 'the treasury moves do not use the earner\'s public-endpoint handle');
  ok(/mover\.sendTransaction\(\{ to: sinkAddr, value: plan\.toRelayWei \}\)/.test(treasury), 'the relay wallet is not fed from the settle wallet by its own handle');
  ok(/fireSwap\(q, mover\)/.test(treasury), 'the PROVE purchase is not signed by the settle wallet');
  ok(!/relayWallet\./.test(treasury), 'the treasury pass references relayWallet directly');
});

test('gas is bought before PROVE', () => {
  // A wallet that cannot pay for a transaction cannot buy PROVE either, so the exact-out gas legs have to
  // clear first. If these ever swap order a drained wallet can never recover on its own.
  const loop = loopOf();
  const gasLeg = loop.indexOf('gas top-up:');
  const proveLeg = loop.indexOf('-> ~${q.amountOut} PROVE', gasLeg);
  ok(gasLeg > -1 && proveLeg > gasLeg, 'the ETH gas top-up must precede the PROVE conversion');
});

// ── the earner -> sink flow ─────────────────────────────────────────────────
test('PROVE is delivered to the SINK, because only the sink can use it', () => {
  // A vApp deposit credits whoever sends it, and the account behind the network prover key is the relay
  // wallet. PROVE landing on the settle wallet could not fund proving.
  const loop = loopOf();
  const proveQuotes = loop.match(/quote\((?:ETH|asset), PROVE, [^)]*\)/g) || [];
  ok(proveQuotes.length >= 2, `expected both the ETH and ERC20 PROVE quotes, found ${proveQuotes.length}`);
  for (const q of proveQuotes) ok(/sinkAddr\)$/.test(q), `a PROVE swap does not deliver to the sink: ${q}`);
});

test('only the sink deposits to the vApp, once, after every earner has delivered', () => {
  ok(/depositProveToVApp\(sink\)/.test(replenish), 'the deposit must be made by the sink');
  ok(!/depositProveToVApp\(wallet\)/.test(replenish), 'an earner must never deposit — that credits the wrong account');
  const loopStart = replenish.indexOf('for (const { address: owner, wallet, roles: held } of earners)');
  const depositAt = replenish.indexOf('depositProveToVApp(sink)', loopStart);
  const lastEarnerLine = replenish.lastIndexOf('sweep for ${asset} failed');
  ok(depositAt > lastEarnerLine, 'the deposit must come after the earner loop, not inside it');
});

test('the sink gets its own gas, since it earns nothing', () => {
  const loop = loopOf();
  ok(/gasLegs\.push\(\[sinkAddr, 'sink'\]\)/.test(loop), 'no exact-out gas leg for the sink');
  // Native ETH reaches the sink through the treasury pass, by runway (lib/treasury-plan.js), not by a fixed float.
  ok(/await runTreasury\(settleEarner, sink, \{ credit, convertToProve \}\)/.test(replenish), 'the treasury pass is not run for the settle earner');
  ok(/planTreasury\(\{/.test(replenish) && /relay: toSink \? \{ wei: relayWei, burnPerDayWei: relayBurn, floorWei: relayFloor(, hardMinWei: [^}]+)? \}/.test(replenish), 'the relay wallet is not a taker in the plan');
  ok(/toSink/.test(loop), 'the sink legs must only apply when earner and sink differ');
});

test('consolidated keys collapse to the ordinary single-wallet case', () => {
  ok(/const toSink = owner\.toLowerCase\(\) !== sinkAddr\.toLowerCase\(\)/.test(replenish),
    'earner === sink must be detected so nothing is sent to oneself');
});

test('the settle service sweeps only its earner and never the sink as one', () => {
  ok(/replenishOnce\(\{ roles: \['settle'\]/.test(settle), 'the settle service must scope replenish to the settle role');
});

test('replenish in the settle loop never overlaps a settle, and is off by default', () => {
  // Same wallet, same nonce as a settle, so it must never run CONCURRENTLY with one — but it is awaited between
  // jobs, not only once the queue empties: a steady stream of jobs is when the prover credit drains fastest, and
  // an idle-only top-up never gets its turn then (on 2026-10-10 the PROVE sat in the sink through an outage for
  // exactly that reason). Awaited in the loop body, so "between jobs" is still never "during one".
  ok(/\n\s*await maybeReplenish\(\);\n(\s*await maybeDepositArrived\(\);\n)?\s*if \(!worked\) await (sleep|idleWait)/.test(settle), 'replenish must be awaited between jobs, before the idle wait');
  // PROVE that arrives between passes is deposited from the same place, awaited, so it never overlaps a settle either.
  ok(/\n\s*await maybeDepositArrived\(\);\n\s*if \(!worked\) await (sleep|idleWait)/.test(settle), 'the arrived-PROVE deposit must be awaited between jobs, before the idle wait');
  ok(!/(?<!await )maybeReplenish\(\);/.test(settle), 'every call must be awaited, so none is left running beside a job');
  ok(/replenishDue\(/.test(settle), 'the schedule decides whether it is due, so calling it every pass stays cheap');
  ok(/opt\('REPLENISH_IN_SETTLE', '0'\) === '1'/.test(config), 'REPLENISH_IN_SETTLE must default off');
  ok(/replenish failed \(settling continues\)/.test(settle), 'a replenish failure must not take the loop down');
});

test('the PROVE leg is on by default and switchable', () => {
  ok(/opt\('REPLENISH_DEPOSIT_PROVE', '1'\) !== '0'/.test(config), 'REPLENISH_DEPOSIT_PROVE must default on');
});

test('the cost model carries the maintenance lane', () => {
  ok(/maintenance: 264_000n/.test(config), 'measured maintenance gas missing');
  ok(/MAINTENANCE_RUNS_PER_DAY/.test(config), 'maintenance cadence not configurable');
  ok(/maintenanceCostUsd/.test(replenish), 'quoteRelayFee does not price maintenance');
  // costUsd is the QUOTED price and carries maintenance; the gate decides on marginalCostUsd (gas + PROVE).
  ok(/costUsd = marginalCostUsd \+ maintenanceCostUsd/.test(replenish), 'maintenance must be part of the quoted costUsd');
  ok(/marginalCostUsd = gasCostUsd \+ proveCostUsd/.test(replenish), 'the marginal cost must be gas + PROVE');
});

test('maintenance overhead is amortised, and cannot divide by zero', () => {
  ok(/Math\.max\(1, CFG\.expectedOpsPerDay\)/.test(replenish), 'EXPECTED_OPS_PER_DAY=0 would divide by zero');
});

test('an unpriced op is visible, and refusable', () => {
  ok(/unpricedJobs\+\+/.test(settle), 'unpaid jobs are not counted');
  ok(/UNPAID:/.test(settle), 'unpaid jobs are not logged');
  ok(/CFG\.requirePricedFee/.test(settle), 'no way to refuse unpriced ops');
  ok(/RELAY_REQUIRE_PRICED_FEE/.test(config), 'the switch is not env-configurable');
});

test('refusing unpriced ops stays OFF by default', () => {
  // Nothing populates op.feeUsd yet, so a default-on switch would refuse every job in production.
  ok(/opt\('RELAY_REQUIRE_PRICED_FEE', '0'\) === '1'/.test(config),
    'RELAY_REQUIRE_PRICED_FEE must default to off until the producer is wired');
});

test('the fee model still moves with live gas and live PROVE', () => {
  // The whole point is being dynamic. A quote that stops reading live inputs silently reverts to the
  // static fallbacks and misprices everything.
  ok(/liveGasGwei/.test(replenish), 'fee quote no longer takes live gas');
  ok(/export async function provePriceUsd/.test(replenish), 'live PROVE pricing removed');
  ok(/ethUsdPrice/.test(chain), 'live ETH price feed removed');
});

// ── the fee is derived, not declared ────────────────────────────────────────
const settler = read('worker/src/confidential-settle.js');
const worker = read('worker/src/index.js');

test('a client-supplied feeUsd is stripped BEFORE the job id is derived', () => {
  ok(/'feeUsd' in op\) delete op\.feeUsd/.test(settler), 'submitJob must drop a caller-supplied op.feeUsd');
  // Position is the security property, not just the deletion: jobIdOf hashes the op, so stripping after
  // the id was taken would let a caller vary a field the guest never reads to mint a fresh id for the
  // same op and slip past dedup.
  const strip = settler.indexOf('delete op.feeUsd');
  const idAt = settler.indexOf('const id = jobIdOf(');
  ok(strip > -1 && idAt > -1 && strip < idAt, 'op.feeUsd must be stripped before jobIdOf hashes the op');
});

test('the relay reads only the worker-derived fee', () => {
  // The bypass: op is client JSON. Reading op.feeUsd would let an integrator declare its own fee.
  ok(/const feeUsd = Number\(job\.feeUsd \?\? NaN\)/.test(settle), 'feeGate must read job.feeUsd only');
  ok(!/job\.op\?\.feeUsd/.test(settle), 'feeGate still reads the client-controlled op.feeUsd');
});

test('the pricer derives from the op witness, not from any declared field', () => {
  ok(/function buildFeePricer/.test(worker), 'buildFeePricer missing');
  ok(/totalFee\(type, op\)/.test(worker), 'pricer must read the op\'s own fee legs');
  ok(/feeUsd: null/.test(worker), 'an unpriceable asset must yield null, not a guess');
});

test('the derived fee actually reaches the relay', () => {
  // Storing feeUsd on the job is only half of it: nextJob/nextBatch project a SUBSET of the job, and both
  // originally dropped it — which would have left the gate seeing undefined and calling every job unpaid,
  // with all the wiring in place and inert.
  const projections = settler.match(/jobId: id, type: j\.type, op: j\.op[^\n]*/g) || [];
  ok(projections.length >= 2, `expected nextJob and nextBatch projections, found ${projections.length}`);
  for (const p of projections) ok(/feeUsd: j\.feeUsd/.test(p), `a job projection drops feeUsd: ${p.slice(0, 60)}…`);
});

test('pricing failure never fails a submit', () => {
  ok(/catch \{ priced = null; \}/.test(settler), 'a blinking oracle must not reject a user op');
});

test('the fee floor cannot switch off metering', () => {
  // RELAY_FEE_FLOOR=1 must not skip metering entirely: the gate only prices cETH, so skipping metering
  // would reopen zero-fee floods for every other asset.
  ok(!/submitMode === 'prove' \|\| env\.RELAY_FEE_FLOOR !== '1'/.test(worker),
    'metering is still gated on RELAY_FEE_FLOOR');
  ok(/const paying = submitMode !== 'prove' && env\.RELAY_FEE_FLOOR === '1' && hasVerifiableFee\(body\.type, body\.op, env\)/.test(worker),
    'the paid bucket must require a fee the gate can actually verify, not just the flag');
  ok(/'paid', Number\(env\.PAID_RL_BURST/.test(worker), 'paid submits must use their own bucket');
});

// ── the fee gate, run for real ──────────────────────────────────────────────
// Extract the actual gate + helpers from the worker source and run them against the REAL deployment data
// and the REAL passesFloor, with only the two network reads (gas price, ETH/USD) stubbed. A string match
// cannot tell you whether a fee that is too low is actually rejected.
const rq = await import(join(ROOT, 'worker/src/relay-quote.js'));
const opAdmit = await import(join(ROOT, 'worker/src/op-admit.js'));
const { CONFIDENTIAL_DEPLOYMENTS: DEPLOY } = await import(join(ROOT, 'dapp/confidential-deployments.js'));
const gateSrc = worker.slice(worker.indexOf('const USD_PEGGED_FEE_TICKERS'), worker.indexOf('function buildFeePricer('));
// `amm` stubs the AMM fallback read (_ammUsdPerUnit): (assetId, env) => dollars per in-pool unit, or null.
function loadGate({ gasWei = 60_000_000n, ethUsd = 2570, btcUsd = 80000, env = {}, amm = async () => null } = {}) {
  const mk = new Function('passesFloor', 'feeAssetOf', 'totalFee', '_CONFIDENTIAL_DEPLOYMENTS', '_ethGasPrice', '_ethUsdPrice', '_btcUsdPrice', 'ENV', '_ammUsdPerUnit',
    gateSrc + '; return { feeAssetRow, ammFeeAsset, hasVerifiableFee, usdPerUnitOf, gate: buildRelayFeeGate({ RELAY_FEE_FLOOR: "1", ...ENV }) };');
  return mk(rq.passesFloor, rq.feeAssetOf, rq.totalFee, DEPLOY, async () => '0x' + gasWei.toString(16), async () => ethUsd,
    async () => { if (btcUsd === null) throw new Error('btc feed down'); return btcUsd; }, env, amm);
}
const ASSET = (t) => DEPLOY.mainnet.assets.filter((a) => a.ticker === t)[0];
const cEth = ASSET('cETH'), cUsd = ASSET('cUSD'), cBtc = ASSET('cBTC');
const transfer = (asset, fee) => ({ asset: asset.assetId, fee: String(fee) });

// An add-and-bond into a farm carries no fee: the relay sponsors it (the day's free budgets bound it, as they bound a zero-fee transfer). With a first asset the gate can
// price (tETH), the gate found no fee leg and refused it as "fee below the current floor", so every tETH pair join relayed from the farm page was turned back at submit.
test('gate: a farm entry (lpbond) that carries no fee is not refused for it, and one that pays under the floor still is', async () => {
  const { gate } = loadGate();
  const bond = (fee) => ({ assetA: cEth.assetId, assetB: '0x' + '45'.repeat(32), feeBps: 30, fee: String(fee), controller: '0x' + '91'.repeat(20) });
  ok(await gate({ type: 'lpbond', op: bond(0) }) === true, 'a zero-fee add-and-bond rides the free budgets, as a zero-fee transfer does');
  ok(await gate({ type: 'lpbond', op: bond(1) }) === false, 'a fee that is under the floor is still refused');
  ok(await gate({ type: 'lpbond', op: bond(100_000_000) }) === true, 'a fee over the floor is accepted');
});
test('free budgets: an add-and-bond is metered on the farm allowance, not the shared one', () => {
  ok(/lpbond: 'farm'/.test(worker.slice(worker.indexOf('const FREE_CLASS ='), worker.indexOf('const FREE_CLASSES ='))), 'lpbond must be in the farm class with the other farm ops');
});
test('cETH: a fee under the gas-aware floor is rejected, one over it is accepted', async () => {
  const { gate } = loadGate();
  // floor in cETH units at this gas, using the same function the gate uses
  const floorUnits = rq.floorInFeeUnits({ gasPriceWei: 60_000_000n, weiPerFeeUnit: BigInt(cEth.unitScale), effects: 2n, marginBps: 1000n });
  ok(await gate({ type: 'transfer', op: transfer(cEth, floorUnits + 1n) }) === true, 'a fee above the floor must pass');
  ok(await gate({ type: 'transfer', op: transfer(cEth, floorUnits / 2n) }) === false, 'a fee at half the floor must be rejected');
});

test('cUSD: the same floor applies to a USD-pegged fee', async () => {
  const { gate } = loadGate();
  // dollars -> cUSD units: units = usd / usdPerUnit; usdPerUnit = unitScale / 10^decimals
  const usdPerUnit = Number(BigInt(cUsd.unitScale)) / 10 ** Number(cUsd.decimals);
  const floorWei = rq.floorWei({ gasPriceWei: 60_000_000n, effects: 2n, marginBps: 1000n });
  const floorUsd = (Number(floorWei) / 1e18) * 2570;
  const over = BigInt(Math.ceil((floorUsd * 1.5) / usdPerUnit)), under = BigInt(Math.floor((floorUsd * 0.5) / usdPerUnit));
  ok(await gate({ type: 'transfer', op: transfer(cUsd, over) }) === true, `a cUSD fee of ~$${(floorUsd * 1.5).toFixed(4)} must pass`);
  ok(await gate({ type: 'transfer', op: transfer(cUsd, under) }) === false, `a cUSD fee of ~$${(floorUsd * 0.5).toFixed(4)} must be rejected — it was free before`);
  // A fee of ZERO is not an underpayment the floor turns back: since a82075710 (2026-11-05) a transfer carrying no fee
  // rides the day's free settles like the other fee-less ops, and the free budgets at submit bound it instead
  // (FREE_RELAY_DAILY_CAP / FREE_RELAY_CAP_OTHER — pinned by the free-budget checks further down this file). What the
  // floor still owes us is the case above: a fee that is present but under the floor is refused, in any asset.
  ok(await gate({ type: 'transfer', op: transfer(cUsd, 0) }) === true, 'a transfer with no fee at all is the subsidised path, bounded by the free budgets rather than the floor');
});

test('the floor tracks live gas and ETH price, not a constant', async () => {
  const usdPerUnit = Number(BigInt(cUsd.unitScale)) / 10 ** Number(cUsd.decimals);
  const fee = BigInt(Math.round(0.10 / usdPerUnit)); // $0.10 in cUSD units (floor is ~$0.06 at 0.06 gwei, ~$20 at 20 gwei)
  ok(await loadGate({ gasWei: 60_000_000n }).gate({ type: 'transfer', op: transfer(cUsd, fee) }) === true, '$0.10 covers the floor at 0.06 gwei');
  ok(await loadGate({ gasWei: 20_000_000_000n }).gate({ type: 'transfer', op: transfer(cUsd, fee) }) === false, '$0.10 must NOT cover the floor at 20 gwei');
});

// ── BTC-denominated assets: cBTC is BTC, cTAC is a reference price in sats ────
const cTac = ASSET('cTAC');
// An arbitrary value for the tests. It is not a price anyone should read anything into: the real reference lives
// in private deployment config (TAC_PRICE_SATS), never in source.
const TEST_TAC_SATS = 200;
const TAC_ENV = { TAC_PRICE_SATS: String(TEST_TAC_SATS) };
const usdFloorAt = (gasWei, ethUsd = 2570) => (Number(rq.floorWei({ gasPriceWei: gasWei, effects: 2n, marginBps: 1000n })) / 1e18) * ethUsd;
const unitsForUsd = (asset, usd, { btcUsd = 80000, sats = 1e8 } = {}) => {
  const perUnit = Number(BigInt(asset.unitScale)) / 10 ** Number(asset.decimals); // whole tokens per unit
  return BigInt(Math.ceil(usd / (perUnit * (sats / 1e8) * btcUsd)));
};

test('cBTC is priced at 1:1 with BTC and held to the same floor', async () => {
  const { gate } = loadGate({ btcUsd: 80000 });
  const floor = usdFloorAt(60_000_000n);
  ok(await gate({ type: 'transfer', op: transfer(cBtc, unitsForUsd(cBtc, floor * 1.5)) }) === true, 'a cBTC fee worth 1.5x the floor must pass');
  ok(await gate({ type: 'transfer', op: transfer(cBtc, unitsForUsd(cBtc, floor * 0.5)) }) === false, 'a cBTC fee worth half the floor must be rejected — it was free before');
});

test('cTAC is priced from the configured reference, and changing it changes the value', async () => {
  const floor = usdFloorAt(60_000_000n);
  // a fee worth 1.5x the floor in TAC must pass, half must not
  const g = loadGate({ btcUsd: 80000, env: TAC_ENV }).gate;
  const overDefault = unitsForUsd(cTac, floor * 1.5, { sats: TEST_TAC_SATS }), underDefault = unitsForUsd(cTac, floor * 0.5, { sats: TEST_TAC_SATS });
  ok(await g({ type: 'transfer', op: transfer(cTac, overDefault) }) === true, 'cTAC fee above the floor at the configured price must pass');
  ok(await g({ type: 'transfer', op: transfer(cTac, underDefault) }) === false, 'cTAC fee below the floor at the configured price must be rejected');
  // If TAC is really worth half as much, the SAME token count is worth half the dollars and must now fail.
  const halved = loadGate({ btcUsd: 80000, env: { TAC_PRICE_SATS: String(TEST_TAC_SATS / 2) } }).gate;
  // overDefault was 1.5x the floor at the configured price, so at half the price it is worth 0.75x the floor and must fail.
  ok(await halved({ type: 'transfer', op: transfer(cTac, overDefault) }) === false, 'halving TAC_PRICE_SATS must halve the value of a given TAC fee');
  ok(await halved({ type: 'transfer', op: transfer(cTac, unitsForUsd(cTac, floor * 1.5, { sats: TEST_TAC_SATS / 2 })) }) === true, 'and a fee sized for the new price must pass');
});

test('with no cTAC reference configured, cTAC is unpriced — never guessed', async () => {
  // The reference is operator-supplied private config with no default in source. Absent, the honest answer is
  // "we cannot price this": the gate passes it through and it does not earn the paid bucket.
  const { gate, hasVerifiableFee } = loadGate({ btcUsd: 80000 });
  ok(await gate({ type: 'transfer', op: transfer(cTac, 1) }) === true, 'an unpriced cTAC fee must pass through, not be refused');
  ok(hasVerifiableFee('transfer', transfer(cTac, 1_000_000)) === false, 'an unpriced cTAC fee must not earn the paid bucket');
});

test('a configured cTAC reference makes cTAC verifiable (env must reach hasVerifiableFee)', () => {
  // hasVerifiableFee must receive env, or a configured cTAC still looks unverifiable and its submits are
  // metered on the strict bucket.
  const { hasVerifiableFee } = loadGate({ btcUsd: 80000 });
  ok(hasVerifiableFee('transfer', transfer(cTac, 1_000_000), TAC_ENV) === true, 'a configured cTAC fee must be verifiable');
  ok(/hasVerifiableFee\(body\.type, body\.op, env\)/.test(worker), 'the submit handler must pass env to hasVerifiableFee');
});

test('the BTC price moves the requirement, not a constant', async () => {
  const floor = usdFloorAt(60_000_000n);
  const units = unitsForUsd(cBtc, floor * 1.5, { btcUsd: 80000 });
  ok(await loadGate({ btcUsd: 80000 }).gate({ type: 'transfer', op: transfer(cBtc, units) }) === true, 'passes at $80k BTC');
  ok(await loadGate({ btcUsd: 20000 }).gate({ type: 'transfer', op: transfer(cBtc, units) }) === false, 'the same sats are worth a quarter as much at $20k BTC and must now fail');
});

test('a BTC/USD outage fails OPEN for BTC-denominated fees', async () => {
  const { gate, hasVerifiableFee } = loadGate({ btcUsd: null });
  ok(await gate({ type: 'transfer', op: transfer(cBtc, 1) }) === true, 'no BTC price must fail open, not reject every cBTC op');
  ok(hasVerifiableFee('transfer', transfer(cBtc, 100)) === true, 'the asset is still verifiable in principle; only the price is unavailable');
});

test('the oracle reader rejects a stale answer instead of trusting it', () => {
  // A stale feed looks healthy while silently misvaluing every fee. Run the real reader against canned
  // Chainlink answers: fresh is accepted, old is treated as no answer.
  const src = worker.slice(worker.indexOf('const CHAINLINK_ETH_USD'), worker.indexOf('const _ethUsdPrice'));
  const mkAnswer = (usd, ageS) => {
    const w = (n) => BigInt(n).toString(16).padStart(64, '0');
    return '0x' + w(1) + w(Math.round(usd * 1e8)) + w(0) + w(Math.floor(Date.now() / 1000) - ageS) + w(1);
  };
  const run = async (result) => {
    const fetchStub = async () => ({ ok: true, json: async () => ({ result }) });
    const f = new Function('fetch', '_TETH_ETH_RPCS', 'AbortSignal', src + '; return _chainlinkUsd;')(fetchStub, { mainnet: ['http://x'] }, AbortSignal);
    return f('0xfeed' + Math.random());
  };
  return Promise.all([run(mkAnswer(80000, 60)), run(mkAnswer(80000, 4 * 3600)), run(mkAnswer(-5, 60))]).then(([fresh, stale, neg]) => {
    ok(fresh === 80000, `a fresh answer must be accepted, got ${fresh}`);
    ok(stale === null, `an answer older than 3h must be rejected, got ${stale}`);
    ok(neg === null, 'a non-positive answer must be rejected');
  });
});

test('an asset we cannot value is neither gated nor claimed verifiable', async () => {
  const { gate, hasVerifiableFee } = loadGate();
  const stranger = { assetId: '0x' + 'ab'.repeat(32) };
  ok(await gate({ type: 'transfer', op: transfer(stranger, 1) }) === true, 'an unregistered asset has no price, so the gate must pass it through, not guess');
  ok(hasVerifiableFee('transfer', transfer(stranger, 1_000_000)) === false, 'an unpriceable fee must not earn the paid bucket');
});

test('only a VERIFIABLE fee earns the generous bucket', async () => {
  const { hasVerifiableFee } = loadGate();
  ok(hasVerifiableFee('transfer', transfer(cEth, 5000)) === true, 'a cETH fee > 0 is verifiable');
  ok(hasVerifiableFee('transfer', transfer(cUsd, 5000)) === true, 'a cUSD fee > 0 is verifiable');
  ok(hasVerifiableFee('transfer', transfer(cEth, 0)) === false, 'a zero fee must NOT earn the paid bucket');
  ok(hasVerifiableFee('transfer', null) === false && hasVerifiableFee('transfer', 'junk') === false, 'a malformed op must not qualify or throw');
});

test('a gate that cannot read gas or ETH price fails OPEN, not closed', async () => {
  // A relay that rejects every op the moment an RPC blips is worse than one that eats a cheap settle.
  const mk = new Function('passesFloor', 'feeAssetOf', 'totalFee', '_CONFIDENTIAL_DEPLOYMENTS', '_ethGasPrice', '_ethUsdPrice', '_btcUsdPrice',
    gateSrc + '; return buildRelayFeeGate({ RELAY_FEE_FLOOR: "1" });');
  const noGas = mk(rq.passesFloor, rq.feeAssetOf, rq.totalFee, DEPLOY, async () => null, async () => 2570, async () => 80000);
  const noEth = mk(rq.passesFloor, rq.feeAssetOf, rq.totalFee, DEPLOY, async () => '0x3938700', async () => { throw new Error('rpc down'); }, async () => 80000);
  ok(await noGas({ type: 'transfer', op: transfer(cEth, 1) }) === true, 'no gas price must fail open');
  ok(await noEth({ type: 'transfer', op: transfer(cUsd, 1) }) === true, 'no ETH price must fail open for a USD fee');
});

test('a priced job names the public token its fee pays out in, and the job keeps it for the relay\'s books', () => {
  ok(/out\.feeToken = feeTokenOf\(p\);/.test(worker), 'the pricer does not name the fee token');
  ok(/cETH: '0x0000000000000000000000000000000000000000'/.test(worker) && /cUSD: '0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564'/.test(worker) && /cBTC: '0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696'/.test(worker) && /cTAC: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279'/.test(worker), 'the ticker -> token table is incomplete');
  const settleSrc = readFileSync(join(__dirname, '../worker/src/confidential-settle.js'), 'utf8');
  ok(/feeToken: priced\?\.feeToken \?\? null,/.test(settleSrc), 'submitJob does not keep the fee token');
  ok(/\.\.\.\(paid === true \? \{ paid: true \} : \{\}\)/.test(settleSrc), 'submitJob does not keep the paid mark');
  ok(/paid: paidProve \|\| undefined/.test(worker), 'the submit route does not pass the paid mark');
});

// ── prove-mode: a bounded subsidy, and a budget that junk cannot drain ─────────
// These slices are evaluated as a function body, so an `export` anywhere inside one is a syntax error, and every check in
// the section then fails at once on "Unexpected token 'export'" whatever it was really testing — which is how a single
// `export function queueSender` added inside this span quietly took 31 checks down. Once the keyword is dropped a top-level
// export is an ordinary declaration, so drop it here rather than hold index.js to where its exports may sit.
const unexport = (s) => s.replace(/^([ \t]*)export[ \t]+(?=(?:async[ \t]+)?(?:function|const|let|var|class)\b)/gm, '$1');
const CSETTLE = await import(join(ROOT, 'worker/src/confidential-settle.js'));
const COPEN = await import(join(ROOT, 'worker/src/confidential-open.js'));
const SHA3 = await import(join(ROOT, 'node_modules/@noble/hashes/sha3.js'));
const NOBLE = await import(join(ROOT, 'node_modules/@noble/hashes/utils.js'));
const IPB = await import(join(ROOT, 'worker/src/ip-bucket.js'));      // every per-client key is a keyed hash of the address (worker/src/ip-bucket.js)
const submitSrc = unexport(worker.slice(worker.indexOf('const budgetKey'), worker.indexOf('async function handleConfidentialJob')));
function loadSubmit({ cap = '3', freeCap = '3', env = {}, submitJob, jobStatus = async () => null, boardWorkers = [], kvStore = new Map(), feeOf = () => 0n, tipPaid = async () => false, health = async () => ({ status: 'ok', age_seconds: 5, note: 'settle: idle — queue empty' }), expiryOf = (type, op) => (type === 'unwrap' ? Number(op?.opDeadline || 0) : 0) }) {
  const kv = { get: async (k) => (kvStore.has(k) ? kvStore.get(k) : null), put: async (k, v) => { kvStore.set(k, v); } };
  // confPool: no pool named, so a bridge mint's admission (checked against the mainnet pool's burn root only) passes as it does off mainnet.
  const mk = new Function('confSettler', 'buildProverBoard', 'FEELESS_TYPES', 'proveRateLimit', 'jsonResponse', 'hasVerifiableFee', 'totalFee', 'ctx', 'withKvKeyLock', 'wrapTipPaid', 'readProverKindHealth', 'opExpiry', 'checkPostedShape', 'confPool', '_CONFIDENTIAL_DEPLOYMENTS', 'SHAPED_TYPES', 'admitOpShape',
    'keccak_256', 'bytesToHex', 'hexToBytes', 'FREE_POSTED_TYPES', 'pvFees', 'ipBucket',
    submitSrc + '; return handleConfidentialSubmit;');
  const handler = mk(() => ({ submitJob, jobIdOf: (type, op, mode) => `${mode}:${type}:${JSON.stringify(op)}`, jobStatus }), () => ({ summary: async () => ({ workers: boardWorkers }) }), rq.FEELESS_TYPES, async () => ({ ok: true }), (body, status, headers) => ({ body, status, headers }), () => false, (type, op) => feeOf(type, op), {},
    (_key, fn) => fn(), tipPaid, health, expiryOf, () => null, () => null, {}, opAdmit.SHAPED_TYPES, opAdmit.admitOpShape,
    SHA3.keccak_256, NOBLE.bytesToHex, NOBLE.hexToBytes, CSETTLE.FREE_POSTED_TYPES, COPEN.pvFees, IPB.ipBucket);
  const call = (body) => handler({ json: async () => body, headers: { get: () => '1.2.3.4' } }, { REGISTRY_KV: kv, PROVE_MODE_DAILY_CAP: cap, FREE_RELAY_DAILY_CAP: freeCap, ...env }, {});
  return { call, kvStore };
}

test('while a prover-board worker is proving, a free prove-only job passes the credit reserve and the credit budgets, on the board\'s own cap', async () => {
  let n = 0;
  const low = async () => ({ status: 'ok', age_seconds: 5, note: 'settle: idle', prover_credit: '12' });
  const { call, kvStore } = loadSubmit({ cap: '1', submitJob: async () => ({ jobId: 'j' + ++n, status: 'pending' }), health: low, boardWorkers: [{ name: 'tacit-a5000', lastSeenSeconds: 3 }], env: { PROVE_MODE_BOARD_DAILY_CAP: '2' } });
  const a = await call({ type: 'transfer', op: { a: 1 }, mode: 'prove' });
  ok(a.status === 200, `a send under the reserve is proved on the board, got ${a.status} ${a.body.code}`);
  const b = await call({ type: 'wrap', op: { a: 2 }, mode: 'prove' });
  ok(b.status === 200, `so is a wrap, past the global prove cap of 1, got ${b.status} ${b.body.code}`);
  const c = await call({ type: 'transfer', op: { a: 3 }, mode: 'prove' });
  ok(c.status === 429 && c.body.code === 'prove_budget', `the board's own day cap still bounds it, got ${c.status} ${c.body.code}`);
  ok([...kvStore.keys()].some((k) => k.includes('prove:board')) && ![...kvStore.keys()].some((k) => /:prove$|:prove:1\.2\.3\.4$/.test(k)), 'the board jobs are counted on the board\'s budget, not the credit budgets');
  // the same worker gone quiet: the reserve applies again
  const quiet = loadSubmit({ cap: '3', submitJob: async () => ({ jobId: 'q', status: 'pending' }), health: low, boardWorkers: [{ name: 'tacit-a5000', lastSeenSeconds: 400 }] });
  const d = await quiet.call({ type: 'transfer', op: { a: 4 }, mode: 'prove' });
  ok(d.status === 503 && d.body.code === 'prove_reserved', `with no worker seen lately the reserve holds, got ${d.status} ${d.body.code}`);
});

test('a proof asked for ahead of its press is made only on the board, never on the credit', async () => {
  let n = 0;
  const on = loadSubmit({ submitJob: async () => ({ jobId: 'a' + ++n, status: 'pending' }), boardWorkers: [{ name: 'tacit-a5000', lastSeenSeconds: 3 }] });
  const a = await on.call({ type: 'sendunwrap', op: { a: 1 }, mode: 'prove', ahead: true });
  ok(a.status === 200 && a.body.jobId === 'a1', `with a worker proving, a withdrawal is proved ahead, got ${a.status} ${a.body.code}`);
  const off = loadSubmit({ submitJob: async () => ({ jobId: 'b' + ++n, status: 'pending' }), boardWorkers: [{ name: 'tacit-a5000', lastSeenSeconds: 400 }] });
  const b = await off.call({ type: 'sendunwrap', op: { a: 2 }, mode: 'prove', ahead: true });
  ok(b.status === 429 && b.body.code === 'not_now', `with none, the API declines it even with credit to spare, got ${b.status} ${b.body.code}`);
  const c = await off.call({ type: 'sendunwrap', op: { a: 3 }, mode: 'prove' });
  ok(c.status === 200, `a proof asked for at the press still goes to the network, got ${c.status} ${c.body.code}`);
});

test('a sealed op with no fee by design is metered on the free budgets by its type; a sealed op that binds a fee is not', async () => {
  const sealed = { worker: 'tacit-a5000', epk: '0x02' + 'ab'.repeat(32), iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJD'.repeat(10) };
  let n = 0;
  const { call, kvStore } = loadSubmit({ freeCap: '9', env: { FREE_RELAY_CAP_SEND: '1' }, submitJob: async ({ mode }) => ({ jobId: `${mode}${++n}`, status: 'pending' }), boardWorkers: [{ name: 'tacit-a5000', lastSeenSeconds: 2 }] });
  const a = await call({ type: 'stealthlock', mode: 'sealed', sealed, memos: [] });
  ok(a.status === 200 && a.body.jobId === 'sealed1', `a sealed lock within the send allowance is queued, got ${a.status} ${a.body.code}`);
  ok([...kvStore.keys()].some((k) => k.includes('free:send')), 'and counted on the send class');
  const b = await call({ type: 'stealthlock', mode: 'sealed', sealed: { ...sealed, ct: 'REVG'.repeat(10) }, memos: [] });
  ok(b.status === 429 && b.body.code === 'free_budget' && b.body.class === 'send', `the second lock meets the send allowance, got ${b.status} ${b.body.code}`);
  const c = await call({ type: 'transfer', mode: 'sealed', sealed: { ...sealed, ct: 'SEVE'.repeat(10) }, memos: [] });
  ok(c.status === 200, `a sealed transfer binds its fee in the proof and is not metered here, got ${c.status} ${c.body.code}`);
  const away = loadSubmit({ submitJob: async () => ({ jobId: 'x', status: 'pending' }), boardWorkers: [{ name: 'tacit-a5000', lastSeenSeconds: 300 }] });
  const d = await away.call({ type: 'transfer', mode: 'sealed', sealed, memos: [] });
  ok(d.status === 503 && d.body.code === 'sealed_unavailable', `a worker not seen in a minute refuses the sealed job, got ${d.status} ${d.body.code}`);
});

test('the relay and the API keep one list of the ops that carry no relay fee by design', () => {
  const rqList = JSON.stringify(rq.FEELESS_TYPES);
  const m = /export const SEALED_FEELESS = (\[[^\]]*\]);/.exec(settle);
  ok(m, 'settle-relay.js names SEALED_FEELESS');
  ok(JSON.stringify(eval(m[1])) === rqList, `SEALED_FEELESS ${m[1]} differs from relay-quote.js FEELESS_TYPES ${rqList}`);
  ok(/stealthlock: 'send', stealthlockbatch: 'send'/.test(worker), 'a private send\'s lock has its own free class');
});

test('an op the queue already holds is answered with its job before any gate', async () => {
  const jobs = { 'settle:transfer:{"a":1}': { jobId: 'had1', status: 'settled', txHash: '0xtx' }, 'prove:transfer:{"a":2}': { jobId: 'had2', status: 'proving' }, 'settle:transfer:{"a":3}': { jobId: 'old', status: 'failed' } };
  let submitted = 0;
  const paused = async () => ({ status: 'ok', age_seconds: 5, note: 'settle: paused — relay paused by operator', prover_credit: '1' });
  const { call } = loadSubmit({ cap: '0', freeCap: '0', submitJob: async () => ({ jobId: 'new' + ++submitted, status: 'pending' }), jobStatus: async (id) => jobs[id] || null, health: paused });
  const a = await call({ type: 'transfer', op: { a: 1, feeUsd: 9 }, memos: [] });
  ok(a.status === 200 && a.body.jobId === 'had1' && a.body.status === 'settled' && a.body.deduped === true, `a settled job is found again, without its feeUsd, got ${a.status} ${JSON.stringify(a.body)}`);
  const b = await call({ type: 'transfer', op: { a: 2 }, mode: 'prove' });
  ok(b.status === 200 && b.body.jobId === 'had2' && b.body.status === 'proving', `a proving prove-only job is found again past a paused relay and an empty budget, got ${b.status} ${b.body.code}`);
  const c = await call({ type: 'transfer', op: { a: 3 }, mode: 'prove' });
  ok(c.status !== 200 || c.body.jobId !== 'old', 'a failed job is not in the way of a new try');
  ok(submitted === 0, 'nothing was queued for a job already held');
});

test('prove-mode is bounded by a global daily budget', async () => {
  let n = 0;
  const { call } = loadSubmit({ cap: '3', submitJob: async () => ({ jobId: 'j' + ++n, status: 'pending' }) });
  for (let i = 0; i < 3; i++) ok((await call({ type: 'transfer', op: {}, mode: 'prove' })).status === 200, `job ${i + 1} within the cap must be accepted`);
  const over = await call({ type: 'transfer', op: {}, mode: 'prove' });
  ok(over.status === 429 && over.body.code === 'prove_budget', `the job over the cap must be refused, got ${over.status}`);
  ok(/prove locally/.test(over.body.error), 'the refusal must point at the free alternative');
});

test('junk submissions cannot drain the prove budget', async () => {
  // Spending on REQUEST instead of on ACCEPTANCE would let anyone exhaust everyone's allowance with
  // requests that fail validation. Only an accepted, new job may spend.
  const { call, kvStore } = loadSubmit({ cap: '3', submitJob: async () => { throw new Error('unknown type'); } });
  for (let i = 0; i < 20; i++) await call({ type: '__junk__', op: {}, mode: 'prove' });
  ok([...kvStore.values()].every((v) => Number(v) === 0) || kvStore.size === 0, `failed submits spent the budget: ${[...kvStore.entries()]}`);
  const real = await loadSubmit({ cap: '3', submitJob: async () => ({ jobId: 'j', status: 'pending' }), kvStore }).call({ type: 'transfer', op: {}, mode: 'prove' });
  ok(real.status === 200, 'a real job must still be accepted after a flood of junk');
});

test('the exits keep their free proofs down to a lower floor than a wrap or a send', async () => {
  const health = (credit) => async () => ({ status: 'ok', age_seconds: 5, note: 'settle: idle — queue empty', prover_credit: credit });
  const job = (credit, env) => loadSubmit({ cap: '50', env, submitJob: async () => ({ jobId: 'e', status: 'pending' }), health: health(credit) });
  const at25 = job('25');
  ok((await at25.call({ type: 'unwrap', op: {}, mode: 'prove' })).status === 200, 'at 25 PROVE a free unwrap is proved (floor 20)');
  ok((await at25.call({ type: 'sendunwrap', op: {}, mode: 'prove' })).status === 200, 'and so is a send-and-unwrap');
  const wrap = await at25.call({ type: 'wrap', op: {}, mode: 'prove' });
  ok(wrap.status === 503 && wrap.body.code === 'prove_reserved', `a wrap still stops at the full reserve, got ${wrap.status} ${wrap.body.code}`);
  const send = await at25.call({ type: 'transfer', op: {}, mode: 'prove' });
  ok(send.status === 503 && send.body.code === 'prove_reserved', `and so does a send, got ${send.status} ${send.body.code}`);
  const at15 = await job('15').call({ type: 'unwrap', op: {}, mode: 'prove' });
  ok(at15.status === 503 && at15.body.code === 'prove_reserved' && at15.body.hint === 'relay', `under the exit floor an unwrap is held and pointed at the relay, got ${at15.status} ${at15.body.code}`);
  ok((await job('15', { PROVE_MODE_EXIT_MIN_CREDIT: '10' }).call({ type: 'unwrap', op: {}, mode: 'prove' })).status === 200, 'PROVE_MODE_EXIT_MIN_CREDIT sets the exit floor');
  ok((await job('25', { PROVE_MODE_EXIT_MIN_CREDIT: '30' }).call({ type: 'unwrap', op: {}, mode: 'prove' })).body.code === 'prove_reserved', 'a floor above the credit holds it');
  ok((await job('25', { PROVE_MODE_EXIT_MIN_CREDIT: '' }).call({ type: 'unwrap', op: {}, mode: 'prove' })).status === 200, 'an empty setting is read as unset, not as zero');
  ok((await job('25', { PROVE_MODE_EXIT_MIN_CREDIT: 'junk' }).call({ type: 'unwrap', op: {}, mode: 'prove' })).body.code === 'prove_reserved', 'a setting that is not a number leaves the exits on the full reserve');
  ok((await job('25', { PROVE_MODE_EXIT_MIN_CREDIT: '60' }).call({ type: 'unwrap', op: {}, mode: 'prove' })).body.code === 'prove_reserved', 'the exit floor is never above the full reserve');
  ok((await job('1', { PROVE_MODE_MIN_CREDIT: '0' }).call({ type: 'unwrap', op: {}, mode: 'prove' })).status === 200, 'PROVE_MODE_MIN_CREDIT=0 still turns the whole reserve off');
  const capped = loadSubmit({ cap: '1', submitJob: async () => ({ jobId: 'c', status: 'pending' }), health: health('25') });
  await capped.call({ type: 'unwrap', op: {}, mode: 'prove' });
  const over = await capped.call({ type: 'unwrap', op: {}, mode: 'prove' });
  ok(over.status === 429 && over.body.code === 'prove_budget', `an exit is still bounded by the daily budget, got ${over.status} ${over.body.code}`);
});

test('a free prove-only job is turned away while the credit is kept for the bridge; a tipped wrap is paid work and passes', async () => {
  let n = 0;
  const health = (credit) => async () => ({ status: 'ok', age_seconds: 5, note: 'settle: idle — queue empty', prover_credit: credit });
  const low = loadSubmit({ cap: '50', submitJob: async () => ({ jobId: 'j' + ++n, status: 'pending' }), health: health('21.86') });
  const r = await low.call({ type: 'transfer', op: {}, mode: 'prove' });
  ok(r.status === 503 && r.body.code === 'prove_reserved' && r.headers['Retry-After'] === '600', `under 40 PROVE a free proof is refused, got ${r.status} ${r.body.code}`);
  ok(r.body.hint === 'relay', 'a send is pointed at a relayed settle');
  ok((await low.call({ type: 'wrap', op: {}, mode: 'prove' })).body.hint === 'tip', 'a wrap is pointed at tipping its deposit');
  ok(/through the relay instead/.test(r.body.error) && !/\d+ PROVE|balance|gas/.test(r.body.error), 'the refusal says what to do and nothing about balances');
  ok(low.kvStore.size === 0, 'a refusal spent budget');
  const settle = await low.call({ type: 'unwrap', op: {}, mode: 'settle' });
  ok(settle.status === 200, `a relayed settle is not held by the reserve, got ${settle.status} ${settle.body.code}`);
  const paid = await loadSubmit({ cap: '50', submitJob: async () => ({ jobId: 'w', status: 'pending' }), health: health('5'), tipPaid: async () => true }).call({ type: 'wrap', op: {}, mode: 'prove', depositTx: '0x' + 'ab'.repeat(32) });
  ok(paid.status === 200, `a wrap whose deposit tipped is proved whatever the credit, got ${paid.status} ${paid.body.code}`);
  const fine = loadSubmit({ cap: '50', submitJob: async () => ({ jobId: 'k', status: 'pending' }), health: health('45') });
  ok((await fine.call({ type: 'unwrap', op: {}, mode: 'prove' })).status === 200, 'at 45 PROVE a free proof is taken');
  const custom = loadSubmit({ cap: '50', env: { PROVE_MODE_MIN_CREDIT: '50' }, submitJob: async () => ({ jobId: 'k', status: 'pending' }), health: health('45') });
  ok((await custom.call({ type: 'transfer', op: {}, mode: 'prove' })).body.code === 'prove_reserved', 'PROVE_MODE_MIN_CREDIT sets the reserve');
  const off = loadSubmit({ cap: '50', env: { PROVE_MODE_MIN_CREDIT: '0' }, submitJob: async () => ({ jobId: 'k', status: 'pending' }), health: health('1') });
  ok((await off.call({ type: 'unwrap', op: {}, mode: 'prove' })).status === 200, 'PROVE_MODE_MIN_CREDIT=0 turns the reserve off');
  const unread = loadSubmit({ cap: '50', submitJob: async () => ({ jobId: 'k', status: 'pending' }), health: async () => ({ status: 'ok', age_seconds: 5, note: 'settle: idle — queue empty' }) });
  ok((await unread.call({ type: 'unwrap', op: {}, mode: 'prove' })).status === 200, 'an unread credit holds nothing back');
});

test('one client gets its own share of the day\'s free proofs; a tipped wrap spends none of it', async () => {
  let n = 0;
  const { call, kvStore } = loadSubmit({ cap: '50', env: { PROVE_MODE_CLIENT_DAILY_CAP: '2' }, submitJob: async () => ({ jobId: 'j' + ++n, status: 'pending' }) });
  ok((await call({ type: 'unwrap', op: {}, mode: 'prove' })).status === 200 && (await call({ type: 'unwrap', op: {}, mode: 'prove' })).status === 200, 'two within the client cap');
  const third = await call({ type: 'unwrap', op: {}, mode: 'prove' });
  ok(third.status === 429 && third.body.code === 'prove_budget' && third.body.class === 'client' && third.body.hint === 'relay' && /2\/2/.test(third.body.error), `the third from one client is refused, got ${third.status} ${JSON.stringify(third.body)}`);
  const own = IPB.ipBucket({}, '1.2.3.4');      // (no IP_HASH_SALT here: the process's own salt, the one the handler used)
  ok([...kvStore.keys()].some((k) => k.startsWith(`cps:budget:prove:${own}:`)) && ![...kvStore.keys()].some((k) => k.includes('1.2.3.4')), 'the client counter is keyed by a keyed hash of its address, and no key holds the address');
  ok(Number(kvStore.get([...kvStore.keys()].find((k) => /^cps:budget:prove:\d{4}/.test(k)))) === 2, 'the global counter counts the two accepted');
  const paid = loadSubmit({ cap: '50', env: { PROVE_MODE_CLIENT_DAILY_CAP: '1' }, submitJob: async () => ({ jobId: 'w', status: 'pending' }), tipPaid: async () => true });
  for (let i = 0; i < 3; i++) ok((await paid.call({ type: 'wrap', op: {}, mode: 'prove', depositTx: '0x' + 'ab'.repeat(32) })).status === 200, 'a tipped wrap is never counted');
  ok(paid.kvStore.size === 0, 'a tipped wrap spent budget');
});

test('a deduped submit does not spend the budget', async () => {
  const { call, kvStore } = loadSubmit({ cap: '3', submitJob: async () => ({ jobId: 'j', status: 'pending', deduped: true }) });
  for (let i = 0; i < 10; i++) ok((await call({ type: 'transfer', op: {}, mode: 'prove' })).status === 200, 'a dedupe hit costs us nothing and must always pass');
  ok(kvStore.size === 0, 'a dedupe hit spent budget');
});

test('the prove budget never touches a fee-paying relayed settle', async () => {
  const { call } = loadSubmit({ cap: '1', feeOf: () => 5000n, submitJob: async () => ({ jobId: 'j', status: 'pending' }) });
  for (let i = 0; i < 5; i++) ok((await call({ type: 'transfer', op: {}, mode: 'settle' })).status === 200, 'a relayed settle that pays its way must not be budgeted');
});

// ── fee-less ops: relayed free by design, so they must be accepted — and bounded ──
test('a fee-less relayed op is accepted, and spends the free budget only when accepted', async () => {
  let n = 0;
  const { call, kvStore } = loadSubmit({ freeCap: '3', feeOf: () => 0n, submitJob: async () => ({ jobId: 'j' + ++n, status: 'pending' }) });
  for (let i = 0; i < 3; i++) ok((await call({ type: 'cbtcmint', op: SHAPED_OP.cbtcmint, mode: 'settle' })).status === 200, `fee-less job ${i + 1} within the cap must be accepted`);
  const over = await call({ type: 'cbtcmint', op: SHAPED_OP.cbtcmint, mode: 'settle' });
  ok(over.status === 429 && over.body.code === 'free_budget', `the job over the free cap must be refused, got ${over.status}`);
  ok(/attach a fee/.test(over.body.error), 'the refusal must say what to do instead');
  ok(kvStore.size === 2 && [...kvStore.keys()].every((k) => k.startsWith('cps:budget:free')), 'the free budget (its total and its class) and the prove budget must be separate counters');
});

test('a relayed op that carries a fee never touches the free budget', async () => {
  const { call, kvStore } = loadSubmit({ freeCap: '1', feeOf: () => 5000n, submitJob: async () => ({ jobId: 'j', status: 'pending' }) });
  for (let i = 0; i < 10; i++) ok((await call({ type: 'transfer', op: {}, mode: 'settle' })).status === 200, 'a fee-paying op must not be budgeted');
  ok(kvStore.size === 0, 'a fee-paying op spent the free budget');
});

test('junk and dedupe hits cannot drain the free budget', async () => {
  const junk = loadSubmit({ freeCap: '3', feeOf: () => 0n, submitJob: async () => { throw new Error('unknown type'); } });
  for (let i = 0; i < 20; i++) await junk.call({ type: '__junk__', op: {}, mode: 'settle' });
  ok(junk.kvStore.size === 0, 'failed submits spent the free budget');
  const dup = loadSubmit({ freeCap: '3', feeOf: () => 0n, submitJob: async () => ({ jobId: 'j', status: 'pending', deduped: true }) });
  for (let i = 0; i < 10; i++) ok((await dup.call({ type: 'cbtcmint', op: SHAPED_OP.cbtcmint, mode: 'settle' })).status === 200, 'a dedupe hit must always pass');
  ok(dup.kvStore.size === 0, 'a dedupe hit spent the free budget');
});

test('a wrap whose deposit paid its tip stays off the free budget; one that did not still spends it', async () => {
  let n = 0;
  const tipPaid = async (_env, body) => body.type === 'wrap' && !!body.depositTx;
  const { call, kvStore } = loadSubmit({ freeCap: '1', feeOf: () => 0n, tipPaid, submitJob: async () => ({ jobId: 'j' + ++n, status: 'pending' }) });
  for (let i = 0; i < 5; i++) ok((await call({ type: 'wrap', op: {}, mode: 'settle', depositTx: '0x' + 'ab'.repeat(32) })).status === 200, `paid wrap ${i + 1} must be accepted past the free cap`);
  ok(kvStore.size === 0, 'a paid wrap spent the free budget');
  ok((await call({ type: 'wrap', op: {}, mode: 'settle' })).status === 200, 'an unpaid wrap within the cap is accepted');
  const over = await call({ type: 'wrap', op: {}, mode: 'settle' });
  ok(over.status === 429 && over.body.code === 'free_budget', `an unpaid wrap over the free cap is refused, got ${over.status}`);
});

// ── a relay that is holding settles or quiet does not queue what would expire in line ──
const HELD = async () => ({ status: 'ok', age_seconds: 20, note: 'settle: proving only jobs a page settles itself; the rest are held for now' });
const DL = { opDeadline: Math.floor(Date.now() / 1000) + 3600 };
test('an unwrap is turned away, in words the pages read as a refusal, while the relay holds settles', async () => {
  let queued = 0;
  const { call, kvStore } = loadSubmit({ health: HELD, submitJob: async () => { queued++; return { jobId: 'j', status: 'pending' }; } });
  const r = await call({ type: 'unwrap', op: DL, mode: 'settle' });
  ok(r.status === 429 && r.body.code === 'relay_held' && queued === 0, `refused and not queued, got ${r.status}`);
  ok(/can.t take this one/i.test(r.body.error), 'the words are the ones the pages treat as "the relay cannot take this one"');
  ok(!/gas|ETH|wallet|funds/i.test(r.body.error), `no word about the relay's wallet: ${r.body.error}`);
  ok(/your own account/.test(r.body.error), 'it says what to do instead');
  ok(kvStore.size === 0, 'a refusal spends no budget');
});
test('an unwrap is turned away when the relay has gone quiet for over ten minutes', async () => {
  const { call } = loadSubmit({ health: async () => ({ status: 'down', age_seconds: 900, note: '' }), submitJob: async () => ({ jobId: 'j', status: 'pending' }) });
  const r = await call({ type: 'unwrap', op: DL, mode: 'settle' });
  ok(r.status === 503 && r.body.code === 'relay_paused', `a relay quiet for 15 minutes does not take an unwrap that expires in an hour, got ${r.status} ${r.body.code}`);
});
test('a prove-mode unwrap is never turned away while settles are held: the relay proves it and the holder settles it', async () => {
  const { call } = loadSubmit({ health: HELD, submitJob: async () => ({ jobId: 'j', status: 'pending' }) });
  const r = await call({ type: 'unwrap', op: DL, mode: 'prove' });
  ok(r.status === 200 && r.body.relay === 'held', `prove mode goes through while settles are held, and the answer says held (${r.status} ${r.body.relay})`);
});
test('the notes the relay beats while short, open board on or off, are the ones the API reads as holding settles', async () => {
  const { NOTE_HELD, NOTE_HELD_BOARD, NOTE_PAUSED } = await import(join(ROOT, 'worker-relay/src/lib/prove-pause.js'));
  const hold = new RegExp(worker.match(/const RELAY_HOLD_NOTE = \/(.+)\/i;/)[1], 'i');
  const board = new RegExp(worker.match(/const RELAY_BOARD_NOTE = \/(.+)\/i;/)[1], 'i');
  for (const nt of [NOTE_HELD, NOTE_HELD_BOARD]) ok(hold.test(nt), `the API reads "${nt}" as holding settles`);
  ok(board.test(NOTE_HELD_BOARD) && !board.test(NOTE_HELD), 'only the board note reads as the board on');
  for (const nt of [NOTE_HELD, NOTE_HELD_BOARD, NOTE_PAUSED]) ok(!/gas|ETH|wallet|funds|balance|credit/i.test(nt), `the public note says nothing of the relay's wallet or credit: ${nt}`);
  ok(/standingNote\(\{ paused, short, board \}\)/.test(settle) && /const board = short && boardOn\(\);/.test(settle), 'the settle loop beats the note its own board decision chooses');
});
test('what does not expire waits in line while the relay holds settles', async () => {
  const { call } = loadSubmit({ health: HELD, submitJob: async () => ({ jobId: 'j', status: 'pending' }) });
  ok((await call({ type: 'wrap', op: { deadline: DL.opDeadline }, mode: 'settle' })).status === 200, 'a wrap is queued');
  ok((await call({ type: 'unwrap', op: {}, mode: 'settle' })).status === 200, 'an unwrap with no deadline is queued');
});
test('a healthy relay or an unreadable heartbeat queues the unwrap', async () => {
  for (const [name, health, relay] of [['healthy', undefined, 'ok'], ['unreadable', async () => { throw new Error('kv down'); }, undefined]]) {
    const { call } = loadSubmit({ ...(health ? { health } : {}), submitJob: async () => ({ jobId: 'j', status: 'pending' }) });
    const r = await call({ type: 'unwrap', op: DL, mode: 'settle' });
    ok(r.status === 200 && r.body.relay === relay, `${name}: queued, relay ${r.body.relay}`);
  }
});
test('a settle wallet under its gas floor holds expiring settles like the held note does', async () => {
  const { call } = loadSubmit({ health: async () => ({ status: 'low_gas', age_seconds: 30, note: 'settle: idle — queue empty' }), submitJob: async () => ({ jobId: 'j', status: 'pending' }) });
  const r = await call({ type: 'unwrap', op: DL, mode: 'settle' });
  ok(r.status === 429 && r.body.code === 'relay_held', `low gas: relay_held, got ${r.status} ${r.body.code}`);
  const p = await call({ type: 'unwrap', op: DL, mode: 'prove' });
  ok(p.status === 200 && p.body.relay === 'held', 'and it still proves');
});

// ── a relay that is not proving turns away what nobody would prove ──
const PAUSED = async () => ({ status: 'ok', age_seconds: 20, note: 'settle: settle: not proving for now; jobs keep their place' });
const NO_RECORD = async () => ({ status: 'unknown', healthy: false, reasons: ['no heartbeat recorded yet'] });
const DOWN = async () => ({ status: 'down', age_seconds: 900, note: 'settle: proving 0xabc unwrap' });
const PROC_DOWN = async () => ({ status: 'process_down', age_seconds: 30, note: '' });
test('a prove-only job is refused while the relay is paused or down, saying what to do instead', async () => {
  for (const [name, health] of [['paused', PAUSED], ['down', DOWN], ['process down', PROC_DOWN], ['no heartbeat ever', NO_RECORD]]) {
    let queued = 0;
    const { call, kvStore } = loadSubmit({ health, submitJob: async () => { queued++; return { jobId: 'j', status: 'pending' }; } });
    const r = await call({ type: 'transfer', op: {}, mode: 'prove' });
    ok(r.status === 503 && r.body.code === 'relay_paused' && r.body.ok === false && r.body.retryAfter === 300 && r.headers['Retry-After'] === '300', `${name}: 503 relay_paused with Retry-After, got ${r.status} ${r.body.code}`);
    ok(queued === 0 && kvStore.size === 0, `${name}: not queued, and no budget spent`);
    ok(/isn.t proving right now/.test(r.body.error) && /your own prover account/.test(r.body.error), `${name}: the words say what to do`);
    ok(!/gas|ETH|wallet|funds|balance|credit/i.test(r.body.error) && !/PROVE/.test(r.body.error), `${name}: nothing about the relay's wallet or credit: ${r.body.error}`);
  }
});
test('an expiring relayed settle is refused while the relay is paused; one that does not expire waits, told the state', async () => {
  const { call } = loadSubmit({ health: PAUSED, submitJob: async () => ({ jobId: 'j', status: 'pending' }) });
  const r = await call({ type: 'unwrap', op: DL, mode: 'settle' });
  ok(r.status === 503 && r.body.code === 'relay_paused', `an unwrap with an hour to run is refused, got ${r.status} ${r.body.code}`);
  const w = await call({ type: 'wrap', op: {}, mode: 'settle' });
  ok(w.status === 200 && w.body.relay === 'paused', `a wrap is queued and the answer says paused (${w.status} ${w.body.relay})`);
  const d = await loadSubmit({ health: DOWN, submitJob: async () => ({ jobId: 'j', status: 'pending' }) }).call({ type: 'transfer', op: {}, mode: 'settle' });
  ok(d.status === 200 && d.body.relay === 'down', 'a relayed transfer waits in line while the relay is down, and the answer says so');
});
test('a proof made elsewhere goes on the board whatever the relay is doing', async () => {
  const { call } = loadSubmit({ health: PAUSED, submitJob: async () => ({ jobId: 'j', status: 'open' }) });
  const r = await call({ type: 'unwrap', mode: 'preproven', publicValues: '0x01', proof: '0x02', memos: [] });
  ok(r.status === 200 && r.body.status === 'open', `preproven accepted while paused, got ${r.status}`);
});
test('every accepted answer says where the relay stands', async () => {
  for (const [health, want] of [[undefined, 'ok'], [async () => ({ status: 'ok', age_seconds: 3, note: 'settle: proving 0xabc swap' }), 'busy'], [HELD, 'held']]) {
    const { call } = loadSubmit({ ...(health ? { health } : {}), submitJob: async () => ({ jobId: 'j', status: 'pending' }) });
    const r = await call({ type: 'transfer', op: {}, mode: 'settle' });
    ok(r.status === 200 && r.body.relay === want, `relay ${want}, got ${r.body.relay}`);
  }
});

// ── sponsored settles are bounded by class: a budget the relay sets, not whatever arrives first ──
const sponsored = (extra) => { let n = 0; return loadSubmit({ freeCap: '100', feeOf: () => 0n, submitJob: async () => ({ jobId: 'j' + ++n, status: 'pending' }), ...extra }); };
test('each class has its own daily allowance, and one used up does not touch the others', async () => {
  const { call } = sponsored({ env: { FREE_RELAY_CAP_FARM: '2', FREE_RELAY_CAP_ONBOARD: '3', FREE_RELAY_CAP_WRAP: '1', FREE_RELAY_CAP_OTHER: '1' } });
  for (let i = 0; i < 2; i++) ok((await call({ type: 'farmharvest', op: {}, mode: 'settle' })).status === 200, `farm ${i + 1} of 2 is accepted`);
  const farm = await call({ type: 'farmunbond', op: SHAPED_OP.farmunbond, mode: 'settle' });   // a real unbond: an empty one is now turned back at the door (op-admit.js)
  ok(farm.status === 429 && farm.body.code === 'free_budget' && farm.body.class === 'farm', `the third farm op (an unbond shares the farm class) is refused, got ${farm.status}`);
  ok(/free relayed settles for today are used up \(2\/2\)/.test(farm.body.error) && /prove-mode and settle it yourself/.test(farm.body.error), 'in the words every page already answers by offering to send it from the holder\'s own account');
  for (const t of ['cbtcmint', 'cbtcmint', 'cbtcmint']) ok((await call({ type: t, op: SHAPED_OP[t], mode: 'settle' })).status === 200, `${t} still has onboarding room after farm is full`);
  ok((await call({ type: 'cbtcmint', op: SHAPED_OP.cbtcmint, mode: 'settle' })).status === 429, 'onboarding (a cBTC mint) is refused after its own three');
  ok((await call({ type: 'bridgemint', op: {}, mode: 'settle' })).status === 200, 'a bridge mint is a class of its own, with no allowance set: untouched by onboarding being full');
  ok((await call({ type: 'wrap', op: {}, mode: 'settle' })).status === 200 && (await call({ type: 'wrap', op: {}, mode: 'settle' })).status === 429, 'an untipped wrap has one, then is refused');
  ok((await call({ type: 'stealthclaim', op: {}, mode: 'settle' })).status === 200 && (await call({ type: 'stealthrefund', op: {}, mode: 'settle' })).status === 429, 'everything else shares "other"');
  ok((await call({ type: 'cdpmint', op: SHAPED_OP.cdpmint, mode: 'settle' })).status === 200 && (await call({ type: 'cdpclose', op: {}, mode: 'settle' })).status === 200, 'a cUSD loan or repayment is a class of its own, not "other"');
});
test('a class with no allowance set is bounded only by the total, and 0 means none', async () => {
  const none = sponsored({});
  for (let i = 0; i < 20; i++) ok((await none.call({ type: 'farmharvest', op: {}, mode: 'settle' })).status === 200, 'no class limit set: accepted');
  const zero = sponsored({ env: { FREE_RELAY_CAP_FARM: '0' } });
  const r = await zero.call({ type: 'farmharvest', op: {}, mode: 'settle' });
  ok(r.status === 429 && r.body.class === 'farm', 'an allowance of 0 refuses every one');
  const junk = sponsored({ env: { FREE_RELAY_CAP_FARM: 'many' } });
  ok((await junk.call({ type: 'farmharvest', op: {}, mode: 'settle' })).status === 200, 'a value that is not a number is read as no limit, never as a lockout');
});
test('the total still binds, whatever the class allowances add up to', async () => {
  const { call } = sponsored({ freeCap: '3', env: { FREE_RELAY_CAP_FARM: '10', FREE_RELAY_CAP_ONBOARD: '10' } });
  for (const t of ['farmharvest', 'farmharvest', 'bridgemint']) await call({ type: t, op: {}, mode: 'settle' });
  const r = await call({ type: 'bridgemint', op: {}, mode: 'settle' });
  ok(r.status === 429 && r.body.code === 'free_budget' && r.body.class === undefined, 'the fourth is refused by the total, not by its class');
});
test('what is not sponsored never touches a class allowance', async () => {
  const env = { FREE_RELAY_CAP_WRAP: '1', FREE_RELAY_CAP_FARM: '1' };
  const tipped = sponsored({ env, tipPaid: async () => true });
  for (let i = 0; i < 5; i++) ok((await tipped.call({ type: 'wrap', op: {}, mode: 'settle', depositTx: '0x' + 'ab'.repeat(32) })).status === 200, 'a wrap whose deposit paid its tip is accepted past the allowance');
  ok(tipped.kvStore.size === 0, 'and spends none of it');
  const prove = sponsored({ env, cap: '50' });
  for (let i = 0; i < 4; i++) ok((await prove.call({ type: 'farmharvest', op: {}, mode: 'prove' })).status === 200, 'prove mode (the sender settles) is not sponsored settling');
  const paying = sponsored({ env, feeOf: () => 5000n });
  for (let i = 0; i < 4; i++) ok((await paying.call({ type: 'farmharvest', op: {}, mode: 'settle' })).status === 200, 'an op that carries a fee is not counted');
  ok(paying.kvStore.size === 0, 'and spends nothing');
});
test('only an accepted, new job spends its class allowance', async () => {
  const dup = sponsored({ env: { FREE_RELAY_CAP_FARM: '1' }, submitJob: async () => ({ jobId: 'j', status: 'pending', deduped: true }) });
  for (let i = 0; i < 5; i++) ok((await dup.call({ type: 'farmharvest', op: {}, mode: 'settle' })).status === 200, 'a duplicate costs nothing');
  const junk = sponsored({ env: { FREE_RELAY_CAP_FARM: '1' }, submitJob: async () => { throw new Error('unknown type'); } });
  for (let i = 0; i < 5; i++) await junk.call({ type: 'farmharvest', op: {}, mode: 'settle' });
  ok([...junk.kvStore.keys()].every((k) => Number(junk.kvStore.get(k)) === 0) || junk.kvStore.size === 0, 'a submit that fails validation spends nothing');
  const real = sponsored({ env: { FREE_RELAY_CAP_FARM: '1' }, kvStore: junk.kvStore });
  ok((await real.call({ type: 'farmharvest', op: {}, mode: 'settle' })).status === 200, 'so a flood of junk cannot use up the allowance');
});

// wrapTipPaid reads the deposit's receipt: a WrappedWithTip from a known forwarder, for this op's own deposit, tipping
// our recipient at least half of what settling costs now.
const tipSrc = worker.slice(worker.indexOf('async function wrapSettleCost'), worker.indexOf('// A GLOBAL daily ceiling on prove-mode jobs'));
async function loadTipPaid({ receipt, gasHex = '0x3b9aca00', ethUsd = 2500, proveUsd = 0.2 }) {
  const { keccak_256 } = await import(join(ROOT, 'node_modules/@noble/hashes/sha3.js'));
  const u = await import(join(ROOT, 'node_modules/@noble/hashes/utils.js'));
  const DEP = { mainnet: { assets: [{ ticker: 'cETH', assetId: '0x' + '3c'.repeat(32), unitScale: '10000000000', native: true }, { ticker: 'cUSD', assetId: '0x' + '8f'.repeat(32), unitScale: '10000000000' }] } };
  const f = new Function('keccak_256', 'bytesToHex', 'hexToBytes', '_CONFIDENTIAL_DEPLOYMENTS', '_ethRpc', '_ethGasPrice', '_ethUsdPrice', '_provePriceUsd',
    tipSrc + '; return { wrapTipPaid, wrapSettleCost };')(keccak_256, u.bytesToHex, u.hexToBytes, DEP, async (_n, m) => (m === 'eth_getTransactionReceipt' ? receipt : null),
    async () => gasHex, async () => ethUsd, async () => proveUsd);
  return { ...f, keccak_256, u };
}
test('a wrap counts as paid only for its own deposit, through our forwarder, to our recipient, at a real tip', async () => {
  // A deposit of 1 ETH, for which the 3% cap on the recommended tip is well above what settling costs.
  const W = (b) => '0x' + b.repeat(32), op = { asset: W('3c'), value: '100000000', cx: W('01'), cy: W('02'), owner: W('03') };
  const { wrapTipPaid, wrapSettleCost, keccak_256, u } = await loadTipPaid({ receipt: null });
  const commit = '0x' + u.bytesToHex(keccak_256(u.hexToBytes('01'.repeat(32) + '02'.repeat(32) + '03'.repeat(32))));
  const sig = '0x' + u.bytesToHex(keccak_256(new TextEncoder().encode('WrappedWithTip(bytes32,uint256,uint256,address)')));
  const FWD = '0x000000D218B03db5837943b0b05DeA2965AE956e', TO = '0x' + '006cd14f36f65ecbb29b2519ccbe63a0dc8549f2'.padStart(64, '0');
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const cost = (await wrapSettleCost({}, '0x3b9aca00', 2500)).tipWei;
  const rcpt = ({ address = FWD, topics = [sig, commit, TO], amount = 10n ** 18n, tip = cost, status = '0x1' } = {}) => ({ status, logs: [{ address, topics, data: '0x' + word(amount) + word(tip) }] });
  const paid = async (receipt, body = { type: 'wrap', op, depositTx: W('aa') }, env = {}) => (await loadTipPaid({ receipt })).wrapTipPaid(env, body);
  ok(await paid(rcpt()) === true, 'a full tip for this deposit counts as paid');
  ok(await paid(rcpt({ tip: (cost + 1n) / 2n })) === true, 'half the cost still counts (gas moves between the quote and the settle)');
  ok(await paid(rcpt({ tip: cost / 3n })) === false, 'a tip under half the cost is still free work');
  ok(await paid(rcpt({ topics: [sig, W('99'), TO] })) === false, "another deposit's tip does not pay for this one");
  ok(await paid(rcpt({ topics: [sig, commit, '0x' + '11'.repeat(32)] })) === false, 'a tip to someone else does not pay us');
  // The splitter that forwards tips on, named by RELAY_TIP_SPLITTER_ADDR: a tip to it counts, and so does a tip to the ops multisig (a page that
  // pinned it keeps paying it), while a splitter that is not configured is just someone else.
  const SPL = '0xf5eBBE5Db610F64D29A0dC5e9534074Af12834F9', SPLW = '0x' + SPL.slice(2).toLowerCase().padStart(64, '0'), withSpl = { RELAY_TIP_SPLITTER_ADDR: SPL };
  ok(await paid(rcpt({ topics: [sig, commit, SPLW] }), undefined, withSpl) === true, 'a full tip to the splitter counts as paid when the relay names it');
  ok(await paid(rcpt({ topics: [sig, commit, TO] }), undefined, withSpl) === true, 'a tip to the ops multisig still counts with a splitter named (a pinned page keeps paying it)');
  ok(await paid(rcpt({ topics: [sig, commit, SPLW] })) === false, 'a tip to a splitter the relay does not name is a tip to someone else');
  ok(await paid(rcpt({ topics: [sig, commit, SPLW], tip: cost / 3n }), undefined, withSpl) === false, 'and a tip to the splitter under half the cost is still free work');
  ok(await paid(rcpt({ topics: [sig, commit, '0x' + '11'.repeat(32)] }), undefined, withSpl) === false, 'a third address does not count with the splitter named');
  ok(await paid(rcpt({ topics: [sig, commit, TO] }), undefined, { RELAY_TIP_SPLITTER_ADDR: 'junk' }) === true && await paid(rcpt({ topics: [sig, commit, SPLW] }), undefined, { RELAY_TIP_SPLITTER_ADDR: 'junk' }) === false, 'a splitter setting that is not an address is ignored');
  ok(await paid(rcpt({ address: '0x' + '22'.repeat(20) })) === false, 'the same event from any other contract is ignored');
  ok(await paid(rcpt({ amount: 10n ** 15n })) === false, 'a tip on a different amount is a different deposit');
  // A small deposit: the quote recommends a tip capped at 3% of it, and that recommended tip must count as paid.
  const small = { ...op, value: '1000000' }, smallWei = 10n ** 16n, capped = (smallWei * 300n) / 10000n;
  ok(capped < cost, 'the cap binds for a 0.01 ETH deposit at this gas');
  const paidSmall = (tip) => paid(rcpt({ amount: smallWei, tip }), { type: 'wrap', op: small, depositTx: W('aa') });
  ok(await paidSmall(capped) === true, 'the capped tip the quote recommends counts as paid');
  ok(await paidSmall((capped + 1n) / 2n) === true, 'half of it still counts');
  ok(await paidSmall(capped / 3n) === false, 'a tip under half the capped recommendation is still free work');
  ok(await paidSmall(0n) === false, 'no tip is free work');
  ok(await paid(rcpt({ status: '0x0' })) === false, 'a reverted deposit paid nothing');
  ok(await paid(rcpt(), { type: 'wrap', op }) === false, 'without depositTx a wrap is free work, as before');
  ok(await paid(rcpt(), { type: 'transfer', op, depositTx: W('aa') }) === false, 'only a wrap can be paid this way');
  ok(await paid(rcpt(), { type: 'wrap', op: { ...op, asset: W('8f') }, depositTx: W('aa') }) === false, 'the ETH forwarder pays only for the native asset');
  ok(await paid(null) === false, 'no receipt, no exemption');
});

test('Tacit\'s own front page pays the splitter when the quote names one, and the ops address otherwise', async () => {
  const page = readFileSync(join(ROOT, 'dapp/index.html'), 'utf8');
  ok(page.includes('j.tipSplitter || j.recommendedTipRecipient'), 'the Shield card takes the tip address from tipSplitter first');
  ok(page.includes('[ADDR.tipOps, ADDR.tipSplitter].find('), 'and pays only one of Tacit\'s two tip addresses, whatever the quote names');
  // The ceiling, not the name that holds it: this read `tip * 10000n` until the variable became `full`, and the check then
  // failed while the guard itself was untouched. What matters is that the tip is measured against 5% of the deposit.
  ok(/\*\s*10000n\s*>\s*wei\s*\*\s*500n/.test(page), 'and refuses a tip over a twentieth of the deposit');
});

test('prove-mode is not counted against the free-relay budget', async () => {
  const { call } = loadSubmit({ freeCap: '1', cap: '50', feeOf: () => 0n, submitJob: async () => ({ jobId: 'j' + Math.random(), status: 'pending' }) });
  for (let i = 0; i < 5; i++) ok((await call({ type: 'cbtcmint', op: SHAPED_OP.cbtcmint, mode: 'prove' })).status === 200, 'prove-mode has its own budget');
});

// ── the pricer: no fee is UNPRICED, never $0 ─────────────────────────────────
const pricerSrc = worker.slice(worker.indexOf('const USD_PEGGED_FEE_TICKERS'), worker.indexOf('\n}\n', worker.indexOf('function buildFeePricer')) + 3);
function loadPricer({ env = {}, amm = async () => null } = {}) {
  const mk = new Function('passesFloor', 'feeAssetOf', 'totalFee', '_CONFIDENTIAL_DEPLOYMENTS', '_ethGasPrice', '_ethUsdPrice', '_btcUsdPrice', 'ENV', '_ammUsdPerUnit',
    pricerSrc + '; return buildFeePricer(ENV);');
  return mk(rq.passesFloor, rq.feeAssetOf, rq.totalFee, DEPLOY, async () => '0x3938700', async () => 2570, async () => 80000, env, amm);
}
test('the farm reward (wTAC) is valued as TAC is, at its own scale, and unpriced without a TAC reference', async () => {
  const farm = DEPLOY.mainnet.farm, tac = ASSET('cTAC');
  const units = '200000000';                                                   // 2 TAC at 1e-8 TAC a unit
  const pr = loadPricer({ env: TAC_ENV });
  const w = await pr({ type: 'unwrap', op: { asset: farm.rewardAsset, fee: units } });
  const t = await pr({ type: 'unwrap', op: { asset: tac.assetId, fee: units } });
  ok(typeof w.feeUsd === 'number' && w.feeUsd > 0, 'a wTAC fee is priced');
  ok(Math.abs(w.feeUsd - t.feeUsd) < 1e-12, 'and is worth what the same TAC fee is');
  ok((await loadPricer({ env: {} })({ type: 'unwrap', op: { asset: farm.rewardAsset, fee: units } })).feeUsd === null, 'with no TAC reference it stays unpriced, never guessed');
  const other = await pr({ type: 'unwrap', op: { asset: '0x' + '77'.repeat(32), fee: units } });
  ok(other.feeUsd === null, 'an asset that is neither is still unpriced');
});
test('an op with no fee is priced as unpriced (null), not as $0', async () => {
  // $0 made the relay compare zero against cost and refuse every fee-less-by-design op (wrap, cbtcmint, …).
  const pr = loadPricer();
  const none = await pr({ type: 'cbtcmint', op: { asset: cEth.assetId } });
  ok(none.feeUsd === null, `no fee must be unpriced (null), got ${none.feeUsd}`);
  const paid = await pr({ type: 'transfer', op: transfer(cEth, 10000) });
  ok(typeof paid.feeUsd === 'number' && paid.feeUsd > 0, 'a real fee must still be priced');
});

// ── AMM fallback: an asset with no direct feed is valued through a public pool ─────
test('with no cTAC reference, cTAC is valued from the AMM and held to the same floor', async () => {
  const floor = usdFloorAt(60_000_000n);
  const TAC_USD_PER_UNIT = 1e-8; // an arbitrary AMM reading for the test, dollars per in-pool unit
  const seen = [];
  const amm = async (id, env) => { seen.push({ id, env }); return TAC_USD_PER_UNIT; };
  const { gate } = loadGate({ amm });
  const units = (usd) => BigInt(Math.ceil(usd / TAC_USD_PER_UNIT));
  ok(await gate({ type: 'transfer', op: transfer(cTac, units(floor * 1.5)) }) === true, 'a cTAC fee worth 1.5x the floor at the AMM price must pass');
  ok(await gate({ type: 'transfer', op: transfer(cTac, units(floor * 0.5)) }) === false, 'a cTAC fee worth half the floor at the AMM price must be rejected');
  ok(seen.length > 0 && seen[0].id === cTac.assetId.toLowerCase(), 'the AMM read is keyed by the fee asset id');
  // A configured reference still wins: the AMM is only the fallback.
  const direct = [];
  const { gate: g2 } = loadGate({ env: TAC_ENV, amm: async (id) => { direct.push(id); return 1; } });
  await g2({ type: 'transfer', op: transfer(cTac, 1) });
  ok(direct.length === 0, 'the AMM must not be consulted when a direct reference exists');
});

test('an AMM fallback that finds no qualifying pool leaves the fee unpriced, as before', async () => {
  const { gate, hasVerifiableFee } = loadGate({ amm: async () => null });
  ok(await gate({ type: 'transfer', op: transfer(cTac, 1) }) === true, 'no pool must fail open, not refuse');
  const { gate: g2 } = loadGate({ amm: async () => { throw new Error('rpc down'); } });
  ok(await g2({ type: 'transfer', op: transfer(cTac, 1) }) === true, 'a failing AMM read must fail open, not throw');
  ok(hasVerifiableFee('transfer', transfer(cTac, 1_000_000)) === false, 'an AMM-only asset stays on the strict bucket');
});

test('RELAY_AMM_PRICING=0 switches the fallback off', async () => {
  const seen = [];
  const { gate, ammFeeAsset } = loadGate({ env: { RELAY_AMM_PRICING: '0' }, amm: async (id) => { seen.push(id); return 1e-8; } });
  ok(await gate({ type: 'transfer', op: transfer(cTac, 1) }) === true, 'switched off, an unpriced fee passes through');
  ok(seen.length === 0, 'and the AMM is never read');
  ok(ammFeeAsset('transfer', transfer(cTac, 1), { RELAY_AMM_PRICING: '0' }) === null, 'ammFeeAsset honours the switch');
  ok(ammFeeAsset('swap', { intents: [] }, {}) === null, 'no single fee asset, no fallback');
});

test('a fee-paying bridgemint is priced like any other fee leg (AMM fallback included)', async () => {
  const floor = usdFloorAt(60_000_000n);
  const px = 1e-8;
  const { gate } = loadGate({ amm: async () => px });
  const mint = (fee) => ({ asset: cTac.assetId, fee: String(fee) });
  ok(await gate({ type: 'bridgemint', op: mint(BigInt(Math.ceil((floor * 1.5) / px))) }) === true, 'a bridgemint fee above the floor must pass');
  ok(await gate({ type: 'bridgemint', op: mint(BigInt(Math.floor((floor * 0.5) / px))) }) === false, 'a bridgemint fee below the floor must be rejected');
  ok(await gate({ type: 'bridgemint', op: mint(0) }) === true, 'a zero-fee bridgemint is still accepted (free budget)');
  const pr = loadPricer({ amm: async () => px });
  const priced = await pr({ type: 'bridgemint', op: mint(1_000_000) });
  ok(priced.feeUnits === '1000000' && Math.abs(priced.feeUsd - 1_000_000 * px) < 1e-12, `a bridgemint fee must be priced, got ${JSON.stringify(priced)}`);
  const unpriced = await pr({ type: 'bridgemint', op: mint(0) });
  ok(unpriced.feeUsd === null, 'a zero-fee bridgemint is unpriced, not $0');
  const direct = await loadPricer({ amm: async () => px })({ type: 'bridgemint', op: { asset: cEth.assetId, fee: '10000' } });
  ok(typeof direct.feeUsd === 'number' && direct.feeUsd > 0, 'a cETH bridgemint fee is priced directly');
});

test('the AMM pool id the worker reads is the pool id the contract and farm use', async () => {
  const src = worker.slice(worker.indexOf('function _ammPoolId('), worker.indexOf('async function _ammUsdPerUnit('));
  const { keccak_256 } = await import(join(ROOT, 'node_modules/@noble/hashes/sha3.js'));
  const u = await import(join(ROOT, 'node_modules/@noble/hashes/utils.js'));
  const poolId = new Function('keccak_256', 'bytesToHex', 'hexToBytes', 'concatBytes', src + '; return _ammPoolId;')(keccak_256, u.bytesToHex, u.hexToBytes, u.concatBytes);
  const farmTacEth = DEPLOY.mainnet.farm.pools.find((p) => p.pair === 'TAC/cETH');
  ok('0x' + poolId(cTac.assetId, cEth.assetId, 30) === farmTacEth.poolId, 'TAC/cETH @30 must match the farm\'s pool id');
  ok(poolId(cEth.assetId, cTac.assetId, 30) === poolId(cTac.assetId, cEth.assetId, 30), 'order-independent');
  ok(poolId(cTac.assetId, cEth.assetId, 100) !== poolId(cTac.assetId, cEth.assetId, 30), 'fee tier is part of the id');
});

// ── the relay's gate, run for real under real env ───────────────────────────
import { spawn as spawnAsync } from 'node:child_process';
async function gateVerdicts(extraEnv, cases) {
  const script = `
    const s = await import('${join(ROOT, 'worker-relay/src/settle-relay.js')}');
    const out = [];
    for (const c of ${JSON.stringify(cases)}) out.push(await s.feeGate(c.job, c.gwei, 0.25, 2570));
    console.log(JSON.stringify(out.map(o => ({ ok: o.ok, reason: o.reason, publicReason: o.publicReason, carried: o.carried }))));`;
  return new Promise((resolve, reject) => {
    const child = spawnAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: join(ROOT, 'worker-relay'),
      env: { PATH: process.env.PATH, WORKER_BASE: 'http://x', BOX_TOKEN: 't', RPC_URL: 'http://127.0.0.1:1', RELAY_KEY: '0x' + '11'.repeat(32), ...extraEnv },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(err.split('\n').slice(-3).join(' '))));
  });
}
// dapp's standard cETH fee ~ $0.257; at 0.1 gwei marginal cost is ~$0.23 and the full cost (with maintenance) ~$0.38
const job = (feeUsd) => ({ type: 'transfer', mode: 'settle', feeUsd, op: {} });
test('gate: an unpriced (fee-less) op is accepted as a subsidy, not refused', async () => {
  const [v] = await gateVerdicts({}, [{ job: { type: 'cbtcmint', mode: 'settle', feeUsd: null, op: {} }, gwei: 0.06 }]);
  ok(v.ok === true && /not priced|subsid/i.test(v.reason), `an unpriced op must be accepted: ${v.reason}`);
});
test('gate: the dapp standard fee is accepted at 0.1 gwei (marginal cost), a fee far under the cost is refused', async () => {
  const [ok01, low01] = await gateVerdicts({}, [{ job: job(0.257), gwei: 0.1 }, { job: job(0.10), gwei: 0.1 }]);
  ok(ok01.ok === true, `0.257 at 0.1 gwei must pass on marginal cost: ${ok01.reason}`);
  ok(low01.ok === false && /marginal cost/.test(low01.reason), `a fee far below marginal cost must be refused: ${low01.reason}`);
});
test('gate: a fee a little under the cost is relayed, the relay carrying the rest; a fee far under it is still refused', async () => {
  const [near, far, exact] = await gateVerdicts({}, [{ job: job(0.257), gwei: 0.15 }, { job: job(0.257), gwei: 0.3 }, { job: job(0.257), gwei: 0.05 }]);
  ok(near.ok === true && /carries the rest/.test(near.reason), `0.257 at 0.15 gwei is a little under its cost and must be relayed: ${near.reason}`);
  ok(far.ok === false && /marginal cost/.test(far.reason), `0.257 at 0.3 gwei is far under its cost and must be refused: ${far.reason}`);
  ok(exact.ok === true && !/carries the rest/.test(exact.reason), `a fee that covers its cost is taken without a subsidy: ${exact.reason}`);
  ok(near.carried > 0 && far.carried === undefined && exact.carried === undefined, `only a job taken under its cost reports what the relay carries: ${near.carried} / ${far.carried} / ${exact.carried}`);
});
test('submit: a settle some endpoint accepted is waited for once more before the job is called failed, and the failure never borrows another endpoint\'s refusal', () => {
  const fn = settle.slice(settle.indexOf('async function sendCall('), settle.indexOf('async function activateRelayedExit('));   // (submitCall wraps sendCall in the wallet's turn)
  const verdict = fn.slice(fn.indexOf('const late = await ownReceipt()'));
  ok(/if \(seen\.length && LATE_WAIT_MS > 0\)/.test(verdict) && /awaitInclusion\(\{\s*hashes: seen, nonce, waitMs: LATE_WAIT_MS/.test(verdict),
    'after the rounds, an accepted settle must get one more bounded wait');
  ok(verdict.indexOf('awaitInclusion') < verdict.indexOf('const e = '), 'the extra wait comes before the failure is built');
  ok(/const e = \(seen\.length \? null : lastErr\) \|\| new Error\(/.test(verdict), 'with a broadcast accepted, the error is "accepted but never included", not another endpoint\'s last error');
  ok(/const LATE_WAIT_MS = Math\.max\(0, parseInt\(process\.env\.SETTLE_LATE_WAIT_MS \|\| '120000', 10\)\)/.test(settle), 'the extra wait is bounded and switchable');
});
test('replenish: the splitter distribute and the reserve sweep carry their own fee (a tip the settle path waits on, a cap of three base fees), repriced on each retry', () => {
  ok(/async function sendFees\(\)[\s\S]*maxFeePerGas: base \* 3n \+ CFG\.settleTipFloorWei, maxPriorityFeePerGas: CFG\.settleTipFloorWei/.test(replenish), 'the helper must price a cap of three base fees plus the tip floor');
  ok(/withNonceRetry\('splitter distribute', async \(\) => wallet\.writeContract\(\{[^}]*functionName: 'distribute'[^}]*\.\.\.\(await sendFees\(\)\) \}\)\)/.test(replenish), 'the splitter distribute must carry sendFees(), read inside the retry');
  ok(/withNonceRetry\(`\$\{name\} reserve`, async \(\) => wallet\.writeContract\(\{[^}]*\.\.\.\(await sendFees\(\)\) \}\)\)/.test(replenish), 'the reserve sweep must carry sendFees(), read inside the retry');
  ok(!/withNonceRetry\('drain eth', async/.test(replenish), 'a send of an exact balance keeps the node\'s own fee, so a higher cap cannot trip an insufficient-funds check');
});
test('gate: a job taken under its cost is logged with what the relay carries, and the log keeps a running total', () => {
  ok(/CARRIED: job \$\{job\.jobId \?\? '\?'\} type=\$\{job\.type\}[^`]*the relay carries \$\$\{\(need - feeUsd\)\.toFixed\(4\)\} \(\$\{carriedJobs\} so far this process, \$\$\{carriedUsd\.toFixed\(4\)\}\)/.test(settle),
    'the under-cost log line must name the job, its type, the amount carried and the process totals');
});
test('gate: RELAY_GATE_SUBSIDY_BPS=0 holds every fee to the full marginal cost', async () => {
  const [d] = await gateVerdicts({ RELAY_GATE_SUBSIDY_BPS: '0' }, [{ job: job(0.257), gwei: 0.15 }]);
  ok(d.ok === false && /marginal cost/.test(d.reason), `with no subsidy the same fee must be refused: ${d.reason}`);
});
test('gate: RELAY_GATE_INCLUDE_MAINTENANCE=1 holds ops to the full cost', async () => {
  const [d] = await gateVerdicts({ RELAY_GATE_INCLUDE_MAINTENANCE: '1' }, [{ job: job(0.257), gwei: 0.1 }]);
  ok(d.ok === false && /cost/.test(d.reason) && !/marginal/.test(d.reason), `with maintenance included the same fee must be refused: ${d.reason}`);
});

// ── the published quote must match what the gate enforces — without leaking the private cTAC reference ──
const quoteSrc = worker.slice(worker.indexOf('const USD_PEGGED_FEE_TICKERS'), worker.indexOf('function confSettler'));
function loadQuote({ gasWei = 60_000_000n, ethUsd = 2570, btcUsd = 80000, env = {} } = {}) {
  const mk = new Function('passesFloor', 'feeAssetOf', 'totalFee', 'floorInFeeUnits', '_CONFIDENTIAL_DEPLOYMENTS', '_ethGasPrice', '_ethUsdPrice', '_btcUsdPrice', 'jsonResponse', 'ENV',
    quoteSrc + '; return (asset, effects) => handleConfidentialQuote({}, ENV, new URL("https://x/confidential/quote?asset=" + asset + "&effects=" + (effects || 2)), {});');
  return mk(rq.passesFloor, rq.feeAssetOf, rq.totalFee, rq.floorInFeeUnits, DEPLOY, async () => '0x' + gasWei.toString(16), async () => ethUsd, async () => btcUsd, (body) => body, env);
}
test('quote: cUSD and cBTC publish a live gas-aware floor (the gate enforces one, so integrators must be able to see it)', async () => {
  const q = loadQuote();
  for (const t of ['cETH', 'cUSD', 'cBTC']) {
    const r = await q(t);
    ok(r.gasAwareFloorUnits && BigInt(r.gasAwareFloorUnits) > 0n, `${t} must publish a gas-aware floor, got ${r.gasAwareFloorUnits}`);
  }
});

test('quote: the published floor is the gate\'s floor, raised only by the relay\'s own minimum', async () => {
  // A quote that says 100 while the gate wants 120 sends every integrator who follows it to a refusal. With no
  // minimum the two are the same number; the published floor also carries MIN_FLOOR_USD, which the settle
  // relay enforces, so by default it can only sit above the gate's, never below.
  const q0 = await loadQuote({ env: { MIN_FLOOR_USD: '0' } })('cBTC');
  const floor0 = BigInt(q0.gasAwareFloorUnits);
  const { gate } = loadGate({ btcUsd: 80000 });
  ok(await gate({ type: 'transfer', op: transfer(cBtc, floor0 + 1n) }) === true, 'a fee just above the published floor must pass the gate');
  ok(await gate({ type: 'transfer', op: transfer(cBtc, floor0 / 2n) }) === false, 'a fee at half the published floor must be refused by the gate');
  const q = await loadQuote()('cBTC');
  ok(BigInt(q.gasAwareFloorUnits) >= floor0, 'the default published floor must never sit below what the gate enforces');
});

test('quote: cTAC publishes a static floor of 4 TAC, and the gate accepts a fee of exactly that at the settle gas of an ordinary day', async () => {
  // An integrator that cannot retry pays the published number and nothing else, so it has to clear the gate: the
  // published figure is held to the gate here, at the configured reference and a gas price well above today's.
  const r = await loadQuote({ env: TAC_ENV })('cTAC');
  ok(r.staticFloorUnits === '400000000', `the published cTAC floor is 4 TAC (400000000 units), got ${r.staticFloorUnits}`);
  for (const gasWei of [60_000_000n, 150_000_000n]) {
    const { gate } = loadGate({ gasWei, btcUsd: 80000, env: TAC_ENV });
    ok(await gate({ type: 'transfer', op: transfer(cTac, BigInt(r.staticFloorUnits)) }) === true, `the published floor must pass the gate at ${Number(gasWei) / 1e9} gwei`);
  }
});

test('quote: cTAC NEVER publishes a live floor, even when the reference is configured (it would reveal the private price)', async () => {
  const r = await loadQuote({ env: TAC_ENV })('cTAC');
  ok(r.gasAwareFloorUnits === null, `a cTAC floor in cTAC units would let anyone recover the reference price; got ${r.gasAwareFloorUnits}`);
  // The property that matters: the response must not DEPEND on the reference at all. Two very different configured
  // prices must produce byte-identical output, so nothing in it can be used to back the price out.
  const other = await loadQuote({ env: { TAC_PRICE_SATS: String(TEST_TAC_SATS * 7) } })('cTAC');
  ok(JSON.stringify(r) === JSON.stringify(other), `the cTAC quote changed with the configured reference:\n ${JSON.stringify(r)}\n ${JSON.stringify(other)}`);
  const unset = await loadQuote({ env: {} })('cTAC');
  ok(JSON.stringify(r) === JSON.stringify(unset), 'the cTAC quote must be the same whether or not a reference is configured');
});

test('quote: a BTC/USD outage leaves the floor unpublished rather than wrong', async () => {
  const r = await loadQuote({ btcUsd: null })('cBTC').catch(() => ({ gasAwareFloorUnits: null }));
  ok(r.gasAwareFloorUnits === null, 'with no BTC price the floor must be null, not a guess');
});

test('gate: the PUBLIC rejection text does not carry the dollar value of the submitter\'s own fee', async () => {
  // For cTAC that value is units x the private reference price. `reason` is logged AND acked to the job, so it
  // must not be the thing a submitter can read a price off.
  const [v] = await gateVerdicts({}, [{ job: job(0.1234567), gwei: 0.5 }]);
  ok(v.ok === false, 'this fee must be refused at 0.5 gwei');
  ok(v.publicReason && !/0\.123/.test(v.publicReason), `the public reason leaks the fee value: ${v.publicReason}`);
  ok(/0\.123/.test(v.reason), 'the private (logged) reason should keep the detail for debugging');
  ok(/marginal cost of \$/.test(v.publicReason), 'the public reason should still say what the threshold is');
});

test('the relay ACKS the public reason (the job\'s submitter reads the ack), and only LOGS the private one', () => {
  // The gate producing a safe message is worthless if the ack sends the detailed one. cycle() is not exported, so
  // pin the call sites: the ack carries publicReason, the log keeps the full reason for debugging.
  ok(/confidentialAck\(\{ jobId, error: `feeGate: \$\{gate\.publicReason \|\| gate\.reason\}` \}\)/.test(settle),
    'the ack must send gate.publicReason, not the detailed reason');
  ok(/rejected by feeGate: \$\{gate\.reason\}/.test(settle), 'the log must keep the full reason');
});

// ── batching cannot skip the fee gate ───────────────────────────────────────
async function admit(jobs, gateFn) {
  const script = `
    const s = await import('${join(ROOT, 'worker-relay/src/settle-relay.js')}');
    const jobs = ${JSON.stringify(jobs)};
    const r = await s.admitJobs(jobs, async (j) => (j.feeUsd === 0.01 ? { ok: false, reason: 'low', publicReason: 'low (public)' } : { ok: true, reason: 'fine' }));
    console.log(JSON.stringify({ admitted: r.admitted.map(j => j.jobId), refused: r.refused.map(x => ({ id: x.job.jobId, pub: x.verdict.publicReason })) }));`;
  return new Promise((resolve, reject) => {
    const child = spawnAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: join(ROOT, 'worker-relay'),
      env: { PATH: process.env.PATH, WORKER_BASE: 'http://x', BOX_TOKEN: 't', RPC_URL: 'http://127.0.0.1:1', RELAY_KEY: '0x' + '11'.repeat(32) },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(err.split('\n').slice(-3).join(' '))));
  });
}
test('batch: an underpaying member is refused individually and the rest still go', async () => {
  const r = await admit([{ jobId: 'a', feeUsd: 0.5 }, { jobId: 'b', feeUsd: 0.01 }, { jobId: 'c', feeUsd: 0.5 }]);
  ok(JSON.stringify(r.admitted) === '["a","c"]', `the two paying members must be admitted, got ${r.admitted}`);
  ok(r.refused.length === 1 && r.refused[0].id === 'b', 'the underpaying member must be refused');
  ok(r.refused[0].pub === 'low (public)', 'the refusal must carry the PUBLIC reason for the ack');
});
test('batch: the relay gates every member before proving, and acks refusals with the public reason', () => {
  const fn = settle.slice(settle.indexOf('async function batchCycle'), settle.indexOf("log(`batching ${jobs.length} transfers"));
  ok(/admitJobs\(jobs, \(j\) => feeGate\(j, gasGwei, provePx, ethPx\)\)/.test(fn), 'batchCycle must run every member through feeGate');
  ok(/error: `feeGate: \$\{verdict\.publicReason \|\| verdict\.reason\}`/.test(fn), 'refused members must be acked with the public reason');
  const gate = fn.indexOf('admitJobs('), build = settle.indexOf("type: 'batchtransfer'");
  ok(gate > -1 && build > -1 && gate < build, 'the gate must run before the batch is proved');
});

test('rate-limit buckets cannot collide', () => {
  // Same IP, two buckets, one KV namespace — the bucket name has to be in the key (the client part is the keyed hash of the address).
  ok(/cps:rl:\$\{bucket\}:\$\{(ip|ipBucket\(env, ip\))\}/.test(worker), 'bucket name missing from the rate-limit key');
});

// ── behaviour, not just source: which wallets does each service actually see? ──
// Which wallets a service watches and funds is a property of ENV, not just of the source text: with no
// SETTLE_KEY, the settle wallet must not silently collapse into the relay wallet and go unwatched. Test
// it under real env, not by matching strings against fundedWallets.
import { spawnSync } from 'node:child_process';
const RELAY_PK = '0x' + '11'.repeat(32);
const SETTLE_PK = '0x' + '22'.repeat(32);
const SETTLE_ADDR = '0xb2daf4571cf2afffa34482b34a6ece01137e59dd';
function wallets(extraEnv) {
  const script = `
    const c = await import('${join(ROOT, 'worker-relay/src/lib/chain.js')}');
    console.log(JSON.stringify({
      funded: c.fundedWallets.map(w => ({ a: w.address.toLowerCase(), r: w.roles })),
      watched: c.watchedWallets.map(w => ({ a: w.address.toLowerCase(), r: w.roles })),
    }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: join(ROOT, 'worker-relay'),
    env: { PATH: process.env.PATH, WORKER_BASE: 'http://x', BOX_TOKEN: 't', RPC_URL: 'http://127.0.0.1:1', RELAY_KEY: RELAY_PK, ...extraEnv },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`chain.js failed to load: ${(r.stderr || '').split('\n').slice(-3).join(' ')}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('single key: one wallet carrying both roles, nothing to fund twice', () => {
  const w = wallets({});
  ok(w.funded.length === 1, `expected 1 funded wallet, got ${w.funded.length}`);
  ok(w.funded[0].r.includes('relay') && w.funded[0].r.includes('settle'), 'the one wallet must carry both roles');
  ok(w.watched.length === 1, 'watching a single-key deployment must also be one wallet');
});

test('split keys: two wallets, each with its own role', () => {
  const w = wallets({ SETTLE_KEY: SETTLE_PK });
  ok(w.funded.length === 2, `expected 2 funded wallets, got ${w.funded.length}`);
  ok(w.funded.some((x) => x.r.join() === 'relay') && w.funded.some((x) => x.r.join() === 'settle'), 'roles must not overlap');
});

test('the MONITOR case: no SETTLE_KEY, SETTLE_ADDRESS names the settle wallet', () => {
  // RELAY_KEY only, plus a public address for the settle wallet.
  const w = wallets({ SETTLE_ADDRESS: SETTLE_ADDR });
  ok(w.watched.length === 2, `the monitor must watch TWO wallets, saw ${w.watched.length}`);
  const settle = w.watched.find((x) => x.r.includes('settle'));
  ok(settle && settle.a === SETTLE_ADDR, 'the settle role must sit on SETTLE_ADDRESS');
  const relay = w.watched.find((x) => x.r.includes('relay'));
  ok(relay && !relay.r.includes('settle'), 'the relay wallet must NOT still claim the settle role');
  // Signing is a different question: without the key, funding must not pretend to cover the settle wallet.
  ok(w.funded.length === 1, 'fundedWallets is what we can SIGN for — it must stay at one wallet here');
});

test('SETTLE_ADDRESS agreeing with SETTLE_KEY changes nothing', () => {
  const probe = wallets({ SETTLE_KEY: SETTLE_PK });
  const settleAddr = probe.funded.find((x) => x.r.includes('settle')).a;
  const w = wallets({ SETTLE_KEY: SETTLE_PK, SETTLE_ADDRESS: settleAddr });
  ok(w.watched.length === 2, 'consistent key + address must still be two wallets');
});

test('PROVE proxy check cannot page', () => {
  const block = monitor.slice(monitor.indexOf('async function checkProve'), monitor.indexOf('async function checkEth'));
  ok(!/alert\('critical'/.test(block), 'the undeposited-PROVE check is a proxy that reads ~0 by design — it must not be critical');
});

// ── batching stays inside what the guest actually supports ──────────────────
test('the batch claim types match the op the relay actually builds', () => {
  // The coupling spans an HTTP boundary: a default argument in the worker, a hardcoded guest op type in
  // the relay. Nothing links them, so widening one silently breaks the other.
  ok(/const BATCHABLE_TYPES = \['transfer'\]/.test(settler), 'batchable types are not named');
  ok(/types = BATCHABLE_TYPES/.test(settler), 'nextBatch does not use the named list');
  ok(/type: 'batchtransfer'/.test(settle), 'the relay no longer proves batchtransfer — re-check this pairing');
});

test('the relay refuses a batch containing a non-transfer', () => {
  ok(/jobs\.filter\(\(j\) => j\.type !== 'transfer'\)/.test(settle), 'no guard on batch member types');
  // Claimed jobs must reach a terminal state; releasing beats failing a user's op over our own misclaim.
  ok(/released: non-transfer job claimed into a transfer batch/.test(settle),
    'a mismatched batch must release its members, not silently fold them');
  const guard = settle.indexOf("jobs.filter((j) => j.type !== 'transfer')");
  const build = settle.indexOf("type: 'batchtransfer'");
  ok(guard > -1 && build > -1 && guard < build, 'the guard must run before the batch op is built');
});

await Promise.all(pending);
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
