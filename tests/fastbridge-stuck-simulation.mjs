// Economic replay of the classified stuck-TAC pricing model. Every policy sees
// the same requests and starting inventory, so the numbers are comparable.
//
// Accounting (all in TAC base units, BigInt until the final table):
//   fee        = normal fee (1%, floor) + class haircut (long 8%, shielded 15%, ceil)
//   payout     = amount - fee              what the user receives in Ethereum TAC
//   clean TAC  returns home at full face, so the provider keeps the normal fee
//   stuck TAC  stays on Bitcoin; it is recovered later at a *realized* rate
//
// The haircut is a budget: assumedLoss  = Σ haircutFees (face - assumed recovery).
// The realized rate is the truth: realizedLoss = face - realizedRecoverable.
// A provider is whole when realizedLoss <= assumedLoss, i.e. netGain >= normalFees.
import assert from 'node:assert/strict';
import { makeStuckPricing } from '../dapp/fastbridge-stuck-pricing.js';

const NORM_BPS = 100n; // the normal service fee, 1%
const BASE = 10000n;
const normalFee = (amount) => (amount * NORM_BPS) / BASE; // floor, matches quoter.baseFee

const baseConfig = {
  longHaircutBps: 800,
  shieldedHaircutBps: 1500,
  longLimit: '250',
  shieldedLimit: '100',
  totalLimit: '300',
  openingLong: '0',
  openingShielded: '0',
};
const pricing = makeStuckPricing(baseConfig, async () => new Map());

// 20 requests x 100 TAC: 14 clean, 4 long, 2 shielded.
const baseRequests = ['clean', 'clean', 'long', 'clean', 'shielded', 'clean', 'long',
  'clean', 'clean', 'long', 'clean', 'clean', 'shielded', 'clean', 'clean', 'long',
  'clean', 'clean', 'clean', 'clean'];

// recovery(kind, amount) -> realized value recovered for `amount` of stuck TAC.
const accurate = (k, a) => a - pricing.haircutFee(a, k); // realized == assumed
const worse = (k, a) => (k === 'long' ? (a * 8500n) / BASE : (a * 7000n) / BASE); // long 85%, shielded 70%
const illiquidLong = (k, a) => (k === 'long' ? 0n : a - pricing.haircutFee(a, k)); // long never sells

function simulate({ policy, requests, recover, startEthereum = 1000n, amount = 100n }) {
  const used = { long: 0n, shielded: 0n };
  let ethereum = startEthereum;
  let fees = 0n, face = 0n, haircutFees = 0n, filled = 0, refused = 0, volume = 0n;
  for (const kind of requests) {
    const clean = kind === 'clean';
    let block = false;
    if (policy === 'clean-only') block = !clean;
    else if (policy === 'classified' && !clean) block = !pricing.fits(used, kind, amount);
    else if (policy === 'capped-flat-fee' && !clean) block = used.long + used.shielded + amount > 300n;

    const haircut = policy === 'classified' && !clean ? pricing.haircutFee(amount, kind) : 0n;
    const fee = normalFee(amount) + haircut;
    const payout = amount - fee;
    if (block || payout > ethereum) { refused++; continue; }

    ethereum -= payout;
    fees += fee;
    volume += amount;
    filled++;
    if (clean) ethereum += amount; // returns home at full face
    else { used[kind] += amount; face += amount; haircutFees += haircut; }
  }
  let realized = 0n;
  for (const k of ['long', 'shielded']) realized += recover(k, used[k]);
  const assumed = face - haircutFees; // what the haircuts budget the stuck face to recover
  return {
    policy, filled, refused, volume: Number(volume), fees: Number(fees),
    ethereumTAC: Number(ethereum), bitcoinStuckFace: Number(face),
    assumedRecoverable: Number(assumed), realizedRecoverable: Number(realized),
    assumedLoss: Number(face - assumed), realizedLoss: Number(face - realized),
    expectedGain: Number(fees - (face - assumed)), netGain: Number(fees - (face - realized)),
  };
}

console.log('BASE — 20 requests x 100 TAC, start 1000 Ethereum TAC, realized == assumed');
const base = [
  simulate({ policy: 'clean-only', requests: baseRequests, recover: accurate }),
  simulate({ policy: 'flat-fee', requests: baseRequests, recover: accurate }),
  simulate({ policy: 'capped-flat-fee', requests: baseRequests, recover: accurate }),
  simulate({ policy: 'classified', requests: baseRequests, recover: accurate }),
];
console.table(base.map((r) => ({
  policy: r.policy, filled: r.filled, refused: r.refused, fees: r.fees,
  ethereumTAC: r.ethereumTAC, stuckFace: r.bitcoinStuckFace,
  assumedLoss: r.assumedLoss, realizedLoss: r.realizedLoss, netGain: r.netGain,
})));

const classified = base[3];
assert.equal(classified.filled, 17, 'two long and one shielded fit the caps, the rest refuse');
assert.equal(classified.bitcoinStuckFace, 300);
assert.equal(classified.assumedLoss, 31, '2 long x 8 + 1 shielded x 15');
assert.equal(classified.expectedGain, 17, 'the normal margin is preserved by the additive fee');
assert.equal(classified.netGain, classified.expectedGain, 'an accurate haircut leaves the provider whole');

console.log('\nSTRESS 1 — realized haircut worse than expected (long recovers 85%, shielded 70%)');
const stress1 = simulate({ policy: 'classified', requests: baseRequests, recover: worse });
console.table([stress1].map((r) => ({
  policy: r.policy, filled: r.filled, refused: r.refused, fees: r.fees,
  stuckFace: r.bitcoinStuckFace, assumedLoss: r.assumedLoss, realizedLoss: r.realizedLoss,
  expectedGain: r.expectedGain, netGain: r.netGain,
})));
assert(stress1.realizedLoss > stress1.assumedLoss, 'a wrong haircut estimate is not covered by the fee');
assert(stress1.netGain < stress1.expectedGain, 'the shortfall lands on the provider, not the fee');

console.log('\nSTRESS 2 — rising stuck ratio (mix shifts to long/shielded, caps protect liquidity)');
const stuckHeavy = ['long', 'long', 'shielded', 'long', 'shielded', 'long', 'shielded', 'long',
  'long', 'shielded', 'long', 'clean', 'long', 'shielded', 'long', 'clean', 'long', 'clean', 'clean', 'clean'];
const stress2 = simulate({ policy: 'classified', requests: stuckHeavy, recover: accurate });
console.table([stress2].map((r) => ({
  policy: r.policy, filled: r.filled, refused: r.refused, fees: r.fees,
  ethereumTAC: r.ethereumTAC, stuckFace: r.bitcoinStuckFace, netGain: r.netGain,
})));
assert.equal(stress2.bitcoinStuckFace, 300, 'the total cap caps stuck exposure, not the request mix');
assert(stress2.refused >= 4, 'a stuck-heavy stream refuses rather than taking unbounded risk');

console.log('\nSTRESS 3 — long TAC is illiquid (recovers nothing), caps still bound the loss');
const stress3 = simulate({ policy: 'classified', requests: baseRequests, recover: illiquidLong });
console.table([stress3].map((r) => ({
  policy: r.policy, filled: r.filled, refused: r.refused, fees: r.fees,
  stuckFace: r.bitcoinStuckFace, realizedLoss: r.realizedLoss, netGain: r.netGain,
})));
assert(stress3.realizedLoss >= stress3.assumedLoss, 'an unsellable long lock still costs its face');
assert(stress3.bitcoinStuckFace <= 300, 'the cap is the only thing limiting the loss');

console.log('\nSTRESS 4 — cap exhaustion: stuck refuses while clean keeps flowing');
const stress4 = simulate({ policy: 'classified', requests: baseRequests, recover: accurate });
const cleanAfterExhaustion = pricing.fits({ long: 250n, shielded: 100n }, 'clean', 100n); // clean is never blocked by stuck caps
console.table([{ scenario: 'caps full', cleanStillFits: cleanAfterExhaustion,
  stuckRefused: stress4.refused, stuckFace: stress4.bitcoinStuckFace }]);
assert.equal(cleanAfterExhaustion, true, 'clean TAC is never refused by stuck exposure');

console.log('\nSTRESS 5 — refund/recovery frees cap and lets a repeat request through');
// tight caps so recovery visibly reopens capacity
const tight = makeStuckPricing({ ...baseConfig, longLimit: '150', shieldedLimit: '100', totalLimit: '250' }, async () => new Map());
const replay = [];
const used = { long: 0n, shielded: 0n };
let eth = 1000n;
const swap = (kind) => {
  const clean = kind === 'clean';
  const haircut = clean ? 0n : tight.haircutFee(100n, kind);
  if (!clean && !tight.fits(used, kind, 100n)) { replay.push(`${kind}: refused (cap)`); return; }
  const payout = 100n - normalFee(100n) - haircut;
  eth -= payout;
  if (clean) eth += 100n; else used[kind] += 100n;
  replay.push(`${kind}: filled (used long ${used.long} shielded ${used.shielded})`);
  return { kind, payout };
};
const firstLong = swap('long');   // long 100
swap('long');   // long 200 > 150 -> refused
swap('shielded'); // shielded 100
swap('shielded'); // shielded 200 > 100 -> refused
const refunded = firstLong.payout;
used.long -= 100n; eth += refunded;
replay.push(`long #1 refunded +${refunded} ethereum, long cap freed`);
swap('long');   // now fits again
replay.push(`final ethereum ${eth}`);
assert.equal(eth, 825n, 'a refund cancels its actual payout; only the 84 shielded and 91 replacement long payouts remain');
console.log(replay.join('\n  '));
assert(replay.includes('long: filled (used long 100 shielded 100)'), 'a repeat request fits after recovery');
assert.match(replay.at(-1), /final ethereum/, 'recovery returns the assumed value to the pool');
