// The relay funds the wallets that actually spend, and charges for the work it actually does.
//
// Four independent things were broken at once on 2026-09-20, and each was individually invisible:
//   1. the replenish cron was suspended, so the flywheel had never run;
//   2. SETTLE_KEY is split from RELAY_KEY, and both the monitor and replenish looked only at RELAY_KEY —
//      so the wallet that earns the fees and burns the settle gas was neither watched nor funded;
//   3. the fee gate accepted any op without `op.feeUsd` for free, which was every op;
//   4. the maintenance lane (Bitcoin header attestation) was absent from the cost model, so every op was
//      priced below its true cost.
//
// (1) is an operator action. The other three are pinned here, because all three failed silently and the
// only symptom was a wallet quietly reaching zero.
//
// Run: node tests/relay-self-funding.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
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
  // A settle wallet and a maintenance-only wallet do not cost the same per run, so they must not be
  // priced with the same figure.
  ok(/roles\.includes\('settle'\)/.test(block), 'runway must distinguish a settle wallet from a maintenance one');
  ok(/OP_GAS\.maintenance/.test(block), 'a maintenance-only wallet must be priced on maintenance gas');
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
  for (const call of ['maxPreApprove(assets, wallet, false)', 'fireSwap(q, wallet)', 'wallet.sendTransaction']) {
    ok(loop.includes(call), `earner loop does not sign with the earner's own wallet: ${call}`);
  }
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
  ok(/to: sinkAddr, value: send/.test(loop), 'native ETH surplus is not forwarded to the sink');
  ok(/toSink/.test(loop), 'the sink legs must only apply when earner and sink differ');
});

test('consolidated keys collapse to the ordinary single-wallet case', () => {
  ok(/const toSink = owner\.toLowerCase\(\) !== sinkAddr\.toLowerCase\(\)/.test(replenish),
    'earner === sink must be detected so nothing is sent to oneself');
});

test('the settle service sweeps only its earner and never the sink as one', () => {
  ok(/replenishOnce\(\{ roles: \['settle'\]/.test(settle), 'the settle service must scope replenish to the settle role');
});

test('replenish in the settle loop runs only in idle time, off by default', () => {
  // Same wallet, same nonce as a settle — concurrency here would be a nonce race, so it is awaited only
  // where the loop would otherwise sleep.
  ok(/if \(!worked\) \{ await maybeReplenish\(\); await sleep/.test(settle), 'replenish must run only when the loop is idle');
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
  ok(/costUsd = gasCostUsd \+ proveCostUsd \+ maintenanceCostUsd/.test(replenish),
    'maintenance must be part of costUsd, not just reported alongside it');
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

test('metering is no longer something the fee floor can switch off', () => {
  // The old coupling: RELAY_FEE_FLOOR=1 skipped metering entirely, but the gate only prices cETH — so it
  // re-opened zero-fee floods for every other asset. That is why the floor could never be turned on.
  ok(!/submitMode === 'prove' \|\| env\.RELAY_FEE_FLOOR !== '1'/.test(worker),
    'metering is still gated on RELAY_FEE_FLOOR');
  ok(/const paying = submitMode !== 'prove' && env\.RELAY_FEE_FLOOR === '1' && hasVerifiableFee\(body\.type, body\.op\)/.test(worker),
    'the paid bucket must require a fee the gate can actually verify, not just the flag');
  ok(/'paid', Number\(env\.PAID_RL_BURST/.test(worker), 'paid submits must use their own bucket');
});

// ── the fee gate, run for real ──────────────────────────────────────────────
// Extract the actual gate + helpers from the worker source and run them against the REAL deployment data
// and the REAL passesFloor, with only the two network reads (gas price, ETH/USD) stubbed. A string match
// cannot tell you whether a fee that is too low is actually rejected.
const rq = await import(join(ROOT, 'worker/src/relay-quote.js'));
const { CONFIDENTIAL_DEPLOYMENTS: DEPLOY } = await import(join(ROOT, 'dapp/confidential-deployments.js'));
const gateSrc = worker.slice(worker.indexOf('const USD_PEGGED_FEE_TICKERS'), worker.indexOf("// Price an op's OWN fee legs"));
function loadGate({ gasWei = 60_000_000n, ethUsd = 2570, btcUsd = 80000, env = {} } = {}) {
  const mk = new Function('passesFloor', 'feeAssetOf', 'totalFee', '_CONFIDENTIAL_DEPLOYMENTS', '_ethGasPrice', '_ethUsdPrice', '_btcUsdPrice', 'ENV',
    gateSrc + '; return { feeAssetRow, hasVerifiableFee, usdPerUnitOf, gate: buildRelayFeeGate({ RELAY_FEE_FLOOR: "1", ...ENV }) };');
  return mk(rq.passesFloor, rq.feeAssetOf, rq.totalFee, DEPLOY, async () => '0x' + gasWei.toString(16), async () => ethUsd,
    async () => { if (btcUsd === null) throw new Error('btc feed down'); return btcUsd; }, env);
}
const ASSET = (t) => DEPLOY.mainnet.assets.filter((a) => a.ticker === t)[0];
const cEth = ASSET('cETH'), cUsd = ASSET('cUSD'), cBtc = ASSET('cBTC');
const transfer = (asset, fee) => ({ asset: asset.assetId, fee: String(fee) });

test('cETH: a fee under the gas-aware floor is rejected, one over it is accepted', async () => {
  const { gate } = loadGate();
  // floor in cETH units at this gas, using the same function the gate uses
  const floorUnits = rq.floorInFeeUnits({ gasPriceWei: 60_000_000n, weiPerFeeUnit: BigInt(cEth.unitScale), effects: 2n, marginBps: 1000n });
  ok(await gate({ type: 'transfer', op: transfer(cEth, floorUnits + 1n) }) === true, 'a fee above the floor must pass');
  ok(await gate({ type: 'transfer', op: transfer(cEth, floorUnits / 2n) }) === false, 'a fee at half the floor must be rejected');
});

test('cUSD: the same floor now applies to a USD-pegged fee (used to pass ungated)', async () => {
  const { gate } = loadGate();
  // dollars -> cUSD units: units = usd / usdPerUnit; usdPerUnit = unitScale / 10^decimals
  const usdPerUnit = Number(BigInt(cUsd.unitScale)) / 10 ** Number(cUsd.decimals);
  const floorWei = rq.floorWei({ gasPriceWei: 60_000_000n, effects: 2n, marginBps: 1000n });
  const floorUsd = (Number(floorWei) / 1e18) * 2570;
  const over = BigInt(Math.ceil((floorUsd * 1.5) / usdPerUnit)), under = BigInt(Math.floor((floorUsd * 0.5) / usdPerUnit));
  ok(await gate({ type: 'transfer', op: transfer(cUsd, over) }) === true, `a cUSD fee of ~$${(floorUsd * 1.5).toFixed(4)} must pass`);
  ok(await gate({ type: 'transfer', op: transfer(cUsd, under) }) === false, `a cUSD fee of ~$${(floorUsd * 0.5).toFixed(4)} must be rejected — it was free before`);
  ok(await gate({ type: 'transfer', op: transfer(cUsd, 0) }) === false, 'a zero cUSD fee must be rejected');
});

test('the floor tracks live gas and ETH price, not a constant', async () => {
  const usdPerUnit = Number(BigInt(cUsd.unitScale)) / 10 ** Number(cUsd.decimals);
  const fee = BigInt(Math.round(0.10 / usdPerUnit)); // $0.10 in cUSD units (floor is ~$0.06 at 0.06 gwei, ~$20 at 20 gwei)
  ok(await loadGate({ gasWei: 60_000_000n }).gate({ type: 'transfer', op: transfer(cUsd, fee) }) === true, '$0.10 covers the floor at 0.06 gwei');
  ok(await loadGate({ gasWei: 20_000_000_000n }).gate({ type: 'transfer', op: transfer(cUsd, fee) }) === false, '$0.10 must NOT cover the floor at 20 gwei');
});

// ── BTC-denominated assets: cBTC is BTC, cTAC is a reference price in sats ────
const cTac = ASSET('cTAC');
const TAC_DEFAULT_SATS = Number(/const TAC_PRICE_SATS_DEFAULT = (\d+);/.exec(worker)[1]); // follow the source, don't hard-code it
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

test('cTAC is priced from the sats reference, and the reference is overridable', async () => {
  const floor = usdFloorAt(60_000_000n);
  // at the default price a fee worth 1.5x the floor in TAC must pass, half must not
  const g = loadGate({ btcUsd: 80000 }).gate;
  const overDefault = unitsForUsd(cTac, floor * 1.5, { sats: TAC_DEFAULT_SATS }), underDefault = unitsForUsd(cTac, floor * 0.5, { sats: TAC_DEFAULT_SATS });
  ok(await g({ type: 'transfer', op: transfer(cTac, overDefault) }) === true, 'cTAC fee above the floor at the default price must pass');
  ok(await g({ type: 'transfer', op: transfer(cTac, underDefault) }) === false, 'cTAC fee below the floor at the default price must be rejected');
  // If TAC is really worth half as much, the SAME token count is worth half the dollars and must now fail.
  const halved = loadGate({ btcUsd: 80000, env: { TAC_PRICE_SATS: String(TAC_DEFAULT_SATS / 2) } }).gate;
  // overDefault was 1.5x the floor at the default, so at half the price it is worth 0.75x the floor and must fail.
  ok(await halved({ type: 'transfer', op: transfer(cTac, overDefault) }) === false, 'halving TAC_PRICE_SATS must halve the value of a given TAC fee');
  ok(await halved({ type: 'transfer', op: transfer(cTac, unitsForUsd(cTac, floor * 1.5, { sats: TAC_DEFAULT_SATS / 2 })) }) === true, 'and a fee sized for the new price must pass');
});

test('the cTAC reference is not overvalued against the trade record', () => {
  // The public record (228 trades) puts the volume-weighted average at ~172 sats and the last fill at 180. A default
  // materially above that overvalues every cTAC fee and under-collects. This pins the conservative side.
  ok(TAC_DEFAULT_SATS <= 200, `TAC_PRICE_SATS default is ${TAC_DEFAULT_SATS}, above what has traded (VWAP ~172) — that overvalues cTAC fees`);
  ok(TAC_DEFAULT_SATS >= 100, `TAC_PRICE_SATS default is ${TAC_DEFAULT_SATS}, implausibly low against the record`);
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

// ── prove-mode: a bounded subsidy, and a budget that junk cannot drain ─────────
const submitSrc = worker.slice(worker.indexOf('const proveBudgetKey'), worker.indexOf('async function handleConfidentialJob'));
function loadSubmit({ cap = '3', submitJob, kvStore = new Map() }) {
  const kv = { get: async (k) => (kvStore.has(k) ? kvStore.get(k) : null), put: async (k, v) => { kvStore.set(k, v); } };
  const mk = new Function('confSettler', 'proveRateLimit', 'jsonResponse', 'hasVerifiableFee', 'ctx',
    submitSrc + '; return handleConfidentialSubmit;');
  const handler = mk(() => ({ submitJob }), async () => ({ ok: true }), (body, status) => ({ body, status }), () => false, {});
  const call = (body) => handler({ json: async () => body, headers: { get: () => '1.2.3.4' } }, { REGISTRY_KV: kv, PROVE_MODE_DAILY_CAP: cap }, {});
  return { call, kvStore };
}

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

test('a deduped submit does not spend the budget', async () => {
  const { call, kvStore } = loadSubmit({ cap: '3', submitJob: async () => ({ jobId: 'j', status: 'pending', deduped: true }) });
  for (let i = 0; i < 10; i++) ok((await call({ type: 'transfer', op: {}, mode: 'prove' })).status === 200, 'a dedupe hit costs us nothing and must always pass');
  ok(kvStore.size === 0, 'a dedupe hit spent budget');
});

test('the budget applies to prove-mode only, never to a relayed settle', async () => {
  const { call } = loadSubmit({ cap: '1', submitJob: async () => ({ jobId: 'j', status: 'pending' }) });
  for (let i = 0; i < 5; i++) ok((await call({ type: 'transfer', op: {}, mode: 'settle' })).status === 200, 'a relayed settle pays its own way and must not be budgeted');
});

test('rate-limit buckets cannot collide', () => {
  // Same IP, two buckets, one KV namespace — the bucket name has to be in the key.
  ok(/cps:rl:\$\{bucket\}:\$\{ip\}/.test(worker), 'bucket name missing from the rate-limit key');
});

// ── behaviour, not just source: which wallets does each service actually see? ──
// The first version of fundedWallets passed every string check and was still wrong in production: the
// monitor cron has no SETTLE_KEY, so the settle wallet silently collapsed into the relay wallet and the
// one paying for settles went unwatched. That is a property of ENV, so test it under env.
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
  // Exactly the production shape that was broken: RELAY_KEY only, plus a public address for the settle wallet.
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
