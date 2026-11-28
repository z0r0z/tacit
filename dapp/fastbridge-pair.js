// Bitcoin for ETH and ETH for Bitcoin, the user's side, both directions behind one object: the swap tile's lane calls this and nothing else.
//
//   b2e   the user pays plain sats and takes private pool ETH. The user is the BITCOIN locker (dapp/fastbridge-bl.js): it holds t, locks sats first (one ordinary
//         transaction, dapp/adaptor-btc-tx.js lockSats), the provider locks pool ETH, the user claims it, the provider takes the sats.
//   e2b   the user pays private pool ETH and takes plain sats. The user is the ETHEREUM locker (dapp/fastbridge-el.js through dapp/fastbridge-reverse-client.js):
//         the provider locks sats first, the user locks pool ETH once that lock is confirmed, the provider claims it, the user takes the sats.
//
// Both sides are in 8-place units: satoshis, and pool ETH units (1 unit = 1e-8 ETH = 1e10 wei), so the price (ETH per BTC) is also the number of units a satoshi buys.
//
// What this adds to the TAC bridge's clients is the PRICE: the two sides are different assets, so a quote is judged against the market (dapp/fastbridge-rate.js)
// and not against the amount sent. A quote worse than `maxWorseBps` under the market is `blocked` (and one is blocked when the market cannot be read at all: a page that
// cannot tell cannot say a price is fair). Providers are found by their ads (an ad whose btcAsset is X.SATS_ASSET and evmAsset the pool's ETH).
//
//   const pair = makePairClient({ btc, evm, seed, stores, discover, counterFor, reverseCallFor, feed, policy, now, tend })
//   await pair.providers()  await pair.reference()  await pair.balances()  await pair.quote({ dir, amount })  await pair.start(q, { coming })  await pair.prepare(amount)
//   await pair.pump()  await pair.records()  await pair.recover()
//
//   btc, evm          the user's Bitcoin chain (dapp/fastbridge-btc.js; for e2b it also reads the provider's lock) and pool side (dapp/fastbridge-evm.js, asset ETH)
//   stores            { fwd, index, swaps(id), quotes(id) }: fwd holds the b2e swaps; index the providers an e2b swap was asked of ({ id, name, ref }); swaps(id) and quotes(id)
//                     are those providers' stores (each { get, put, list })
//   discover()        -> [{ id, name, ref, terms, reverse? }] as dapp/fast/discover.js gives them
//   counterFor(ref)   -> the b2e counter (dapp/fastbridge-http.js makeCounter over a transport)   reverseCallFor(ref) -> a (method, path, body) transport for e2b
//   feed              dapp/fastbridge-rate.js makeRateFeed: { refresh(), current() }
//   tend(work, passive)   runs `work` (a pass that steps the swaps) when this page is the one that tends the key's swaps (one tab at a time), else `passive` (the records only). Default: always work
//   exclusive(work)   runs a start with no other start of the key's under way, in any tab (fast/pair-wire.js: a Web Lock per key), so two never lock the same coin. Default: as it is
//   strikes           { get(), put(map) }: the providers that failed lately ({ [id]: { n, at } }), kept across visits (a page's localStorage); default: this client's own
//   memo              { get(), put({ ethPerBtc, at }) }: the last good market reading, kept across visits (a page's localStorage); default: this client's own
//   e2bFrom(p)        whether ETH for Bitcoin may be asked of provider `p`; default: the site's own providers (OWN_PROVIDERS), the ones /fast/lp.json names (served over
//                     HTTP, or marked `pinned`), and no other. In e2b the provider is the side that claims, and the user's sats come from reading its claim off the pool:
//                     the pool keeps no record of a claim's kernel apart from the calldata that carried it, so a claim sent in a form no node will trace is not read.
//                     Until a claim is read from a record of the pool's own, this direction is asked only of providers the site names.
//   holdings()        the wallet's holdings scan (tacit.js scanHoldings, a Map): the coins it finds a note on are never put into a lock; when it cannot answer, no lock is built

import { makeBitcoinLocker } from './fastbridge-bl.js';
import { makeFastBridgeClient } from './fastbridge-client.js';
import { makeReverseClient, makeReverseCounter, coversWith } from './fastbridge-reverse-client.js';
import { recordFromLockMemo } from './fastbridge-el.js';
import { OWN_PROVIDERS } from './fastbridge-board.js';
import { planSplit, RATE_ONE, feeOf, SPLIT_POLICY } from './fast/split-plan.js';
import * as X from './adaptor-xswap.js';
import { bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';

export const SATS_ASSET = X.SATS_ASSET;
export const ETH_ASSET = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';

export const PAIR_POLICY = {
  csvBlocks: 144, minCsv: 72, maxCsv: 288, minClaimSecs: 3600, offerWaitSecs: 2 * 3600, maxEvmWindowSecs: 6 * 3600, quoteMarginSecs: 120,
  askMs: 12000, warnWorseBps: 250, maxWorseBps: 300, referenceFreshSecs: 120,
  // the market reading a quote is judged against: from at least this many sources that agree, and no further than maxMarketJumpBps from the last good reading of
  // the past marketMemoSecs (ETH / BTC does not move that far in a day; a reading that does is taken for a wrong one until it holds for that long)
  minMarketSources: 2, maxMarketJumpBps: 1500, marketMemoSecs: 86400,
  // the providers asked for one quote: every one the page knows (the site's own, one /fast/lp.json names, one this key finished a swap with), and of the rest the best
  // `maxOtherAsk` by their advertised terms, up to `maxAsk` in all; those that failed or timed out lately (strikes, kept for strikeSecs) after the others, and those with
  // maxStrikes left out while any other can be asked
  maxAsk: 8, maxOtherAsk: 4, strikeSecs: 1800, maxStrikes: 3,
  // a Bitcoin fee above this share of the amount (in basis points) is said, and a start needs it accepted (q.feeAccepted)
  maxFeeShareBps: 200,
  // a lock of the user's sats that a block goes by without is bumped from its change (fastbridge-bl.js bumpLock), by at most this share of the amount (0.5%)
  lockBumpMaxBps: 50,
  // a swap that more than one provider fills (fast/split-plan.js): at most splitLegs providers, each leg at least splitMinLegSats; `split: false` turns it off
  splitLegs: SPLIT_POLICY.maxLegs, splitMinLegSats: SPLIT_POLICY.minLegSats, splitMinGainBps: SPLIT_POLICY.minGainBps,
};
// How long a swap's step may go without moving before the page reads it afresh (seconds; a wait for a Bitcoin block is not on it: it takes what it takes, and the
// page says when a block is slow). Each is a few times what the step takes when it goes well.
export const WATCH = {
  b2e: { built: 300, offering: 600, offered: 900, claiming: 600 },
  e2b: { accepted: 600, locking: 120, locked: 300, offered: 1200, taking: 2400, refunding: 900 },
};
// The confirmations the user wants on a provider's lock of sats before it locks pool ETH against it: more for a larger amount
export const confsForSats = (value) => { const v = BigInt(value); return v >= 100_000_000n ? 6 : v >= 10_000_000n ? 3 : v >= 1_000_000n ? 2 : 1; };

const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const isHex = (h, n) => new RegExp(`^[0-9a-f]{${n}}$`).test(strip(h));
const big = (v, what) => { try { const b = BigInt(v); if (b < 0n) throw 0; return b; } catch { throw new Error(`the provider's ${what} is not a number`); } };
const FWD_DONE = new Set(['done', 'counter-took']);
const FWD_END = new Set(['done', 'refunded', 'counter-took', 'aborted']);
const REV_END = new Set(['done', 'refunded', 'aborted', 'lost']);

// ETH per BTC a quote gives, and how it compares with the market in basis points (negative = worse for the user): a user who pays BTC wants more ETH for it, a user
// who pays ETH wants it to cost less
export const rateOf = (evmAmount, btcValue) => Number(evmAmount) / Number(btcValue);
export const vsMarketBps = (dir, rate, market) => Math.round((dir === 'b2e' ? rate / market - 1 : market / rate - 1) * 10000);

// ── the words ──

const TAKE_VSIZE = 110;                                          // a key-path take of one Taproot lock to one P2WPKH output (99 vB measured, with room)

// short enough to sit side by side on one line each, four to a row (two on a phone); 'they' is the provider
const STEP_TITLES = {
  b2e: ['You send BTC', 'They send ETH', 'You get ETH', 'They get BTC'],
  e2b: ['They send BTC', 'You send ETH', 'They confirm', 'You get BTC'],
};
const KEYS = ['lock', 'match', 'claim', 'take'];
const stepsOf = (dir, at, state) => STEP_TITLES[dir].map((title, i) => ({
  key: KEYS[i], title, state: state === 'done' ? 'done' : state === 'returned' ? (i === 0 && dir === 'b2e' ? 'done' : 'todo') : i < at ? 'done' : i === at && state === 'working' ? 'active' : 'todo',
}));
const FWD_SAYS = {
  built: [0, 'Sending your BTC', 'Your payment is going out.', 1050],
  broadcast: [0, 'Waiting for Bitcoin', 'Waiting for a Bitcoin block: about 10 min, sometimes more.', 1020],
  offered: [1, 'Provider is sending ETH', 'The ETH goes to the pool for you. Then you receive it.', 420],
  claiming: [2, 'Receiving your ETH', 'Settling in the pool.', 210],
  claimed: [3, 'Finishing', 'Your ETH is in. The provider collects the BTC next.', 0],
  done: [4, 'Done', 'The ETH is in your private balance.', 0],
  'counter-took': [4, 'Done', 'The ETH is in your private balance.', 0],
  'refund-wait': [0, 'Returning your BTC', 'Your BTC returns to your Bitcoin address when the wait ends.', null],
  refunded: [4, 'Returned', 'Your BTC is back at your Bitcoin address.', 0],
  // (the lock is not sent once its quote has run out: dapp/fastbridge-bl.js 'built')
  aborted: [0, 'Stopped', 'The quote ran out before your BTC was sent, so it never left your Bitcoin address. Ask for a new quote.', null],
};
const REV_SAYS = {
  accepted: [0, 'Waiting for the provider’s BTC', 'It needs its confirmations before you send your ETH.', 1650],
  locking: [1, 'Sending your ETH', 'Your private ETH is going to the pool for the provider.', 1050],
  locked: [1, 'Telling the provider', 'Your ETH is sent. The provider is being told.', 870],
  offered: [2, 'Waiting for the provider', 'It confirms your ETH, then your BTC is yours.', 840],
  taking: [3, 'Your BTC is on its way', 'Sent to your Bitcoin address. Yours to spend once Bitcoin confirms it (about 10 min).', 600],
  done: [4, 'Done', 'The BTC is at your Bitcoin address.', 0],
  refunding: [2, 'Returning your ETH', 'The provider did not confirm in time. Your ETH is returning to your private balance.', null],
  refunded: [4, 'Returned', 'Your ETH is back in your private balance.', 0],
  aborted: [0, 'Stopped', 'Stopped before anything was lost.', null],
  lost: [0, 'Needs a look', 'The provider’s confirmation does not give you the BTC. Keep this page open.', null],
};

// A swap that has waited ten minutes or more on Ethereum nodes that do not agree (dapp/fastbridge-el.js and -bl.js `nodesSince`), said after the detail
const NODES_WAIT = 'The Ethereum nodes this page reads disagree about this swap, so it is read again until two match. A refund still goes out on time.';
const nodesWait = (rec, nowSecs) => rec.nodesSince != null && !['done', 'refunded', 'aborted', 'lost', 'counter-took'].includes(rec.phase) && nowSecs - rec.nodesSince >= 600;
const andNodes = (detail, rec, nowSecs) => (nodesWait(rec, nowSecs) ? [detail, NODES_WAIT].filter(Boolean).join(' ') : detail);
const CLAIM_AGAIN = 'The last try failed, so it is being sent again while there is time. If time runs out, your BTC returns to your Bitcoin address.';
// A reason kept on a record, as a sentence of its own after the detail
const sentenceOf = (why) => { const w = String(why || '').trim().replace(/[.\s]*$/, ''); return !w ? '' : /^found from the key$/i.test(w) ? 'It was found again from your key.' : w.charAt(0).toUpperCase() + w.slice(1) + '.'; };
const withWhy = (detail, why) => [detail, sentenceOf(why)].filter(Boolean).join(' ');
// A swap found again from the key is listed as being checked until its first step has read the chains: never as returning or waiting on a guess
const checking = (dir, rec, providerName = null) => ({
  id: rec.id, dir, state: 'working', title: 'Checking', detail: 'Found again from your key. Reading what became of it.',
  pay: dir === 'b2e' ? BigInt(rec.amount || 0) : rec.offer ? BigInt(rec.offer.evm.amount) : 0n, get: dir === 'b2e' ? BigInt(rec.evmAmount || 0) : rec.offer ? BigInt(rec.offer.btc.value) : 0n,
  steps: stepsOf(dir, -1, 'checking'), etaSecs: 0, at: rec.created, refundAt: null, lockTxid: dir === 'b2e' ? (rec.lock ? rec.lock.txid : null) : rec.lockTxid || null,
  error: null, provider: providerName, backBy: null, checking: true,
});

// A Bitcoin block that is slow: said once the newest block is `SLOW_BLOCK_SECS` old (`tip`: { height, at } as the explorers give the newest block), with what it
// means for the swap. Blocks come at random: about every ten minutes on average, and now and then an hour or more goes by without one; fees cannot hurry that.
export const SLOW_BLOCK_SECS = 900;
export function slowBlockLine(tip, nowSecs, safe) {
  if (!tip || !(Number(tip.at) > 0) || nowSecs - Number(tip.at) < SLOW_BLOCK_SECS) return '';
  return `No Bitcoin block for ${Math.floor((nowSecs - Number(tip.at)) / 60)} min. Blocks come every 10 min on average; gaps of an hour happen. ${safe}`;
}
// Bitcoin busy: a backlog (after a long gap between blocks, say) makes a payment at a low fee wait several blocks, whatever its own rate. Said while the next block asks
// `BUSY_FEE` sat/vB or more (`tip.fee`, as the explorers give it): words only. The page raises the fee of its own payments by itself, within a small limit.
export const BUSY_FEE = 5;
export function busyLine(tip) {
  const f = tip && Number(tip.fee);
  if (!(f >= BUSY_FEE)) return '';
  return `Bitcoin is busy: the next block takes about ${Math.round(f)} sat/vB or more, and a payment below that waits for a few blocks. This page raises the fee of its own payments by itself, within a small limit.`;
}
// A block that came after a payment went out, without it: a backlog after a slow block takes the higher fees first. `sentAt` is when it went out (seconds); a
// block's time can run a minute or two off the clock, so a block within two minutes of the send is not counted. `who` is whose fee is raised, by whom.
export function missedLine(tip, sentAt, who) {
  if (!tip || !(Number(tip.at) > 0) || !(Number(sentAt) > 0) || Number(tip.at) < Number(sentAt) + 120) return '';
  return `A block came without ${who === 'provider' ? 'the provider’s BTC' : 'your BTC payment'}: Bitcoin is busy and that block took higher fees first. ${who === 'provider' ? 'The provider raises its fee by itself' : 'This page raises its fee by itself'}, so it should be in one of the next blocks.`;
}
// While a wait for a block runs long (the newest block is slow, or a block came without the payment) no countdown is given: the card says why instead
const longWait = (tip, sentAt, nowSecs) => !!(slowBlockLine(tip, nowSecs, '') || missedLine(tip, sentAt, ''));
const SAFE_FWD = 'Your swap is safe: if it does not finish, your BTC returns to your address.';
const SAFE_REV = 'Your swap is safe: nothing of yours moves until the provider’s BTC is confirmed.';
const SAFE_TAKE = 'The BTC is yours: it only has to confirm, with hours to spare.';
// The time a wait for Bitcoin confirmations has left: about ten minutes for each one still to come, from now, however long the last one took (a block does not
// come sooner for being late), and then the steps after it
const confsLeft = (need, confs) => Math.max(1, Number(need) - Math.max(0, Number(confs) || 0)) * 600;
const join = (...xs) => xs.filter(Boolean).join(' ');

export function describeFwd(rec, now = () => Math.floor(Date.now() / 1000), tip = null) {
  if (rec.checking) return checking('b2e', rec, rec.providerName || null);
  // (a lock found again from the key says nothing of the provider sending ETH until an offer was seen: fastbridge-bl.js 'offered')
  if (rec.claimFromKey && rec.phase === 'offered' && !rec.offerSeen) return { ...checking('b2e', rec, rec.providerName || null), title: 'Checking your swap…', detail: 'Found again from your key. The provider has not shown an offer for it yet. If none comes, your BTC returns to your Bitcoin address.', checking: false };
  const [at, title, detail0, eta] = FWD_SAYS[rec.phase] || [0, rec.phase, '', null];
  const detail = rec.phase === 'broadcast' ? join(detail0, missedLine(tip, rec.broadcastAt, 'you') || busyLine(tip), slowBlockLine(tip, now(), SAFE_FWD)) : detail0;
  const late = rec.phase === 'broadcast' && longWait(tip, rec.broadcastAt, now());
  const state = FWD_DONE.has(rec.phase) ? 'done' : rec.phase === 'refunded' ? 'returned' : rec.phase === 'aborted' ? 'stopped' : 'working';
  const lockAt = rec.lockAt || rec.confirmedAt || null;
  // a claim the relay could not prove (it proves a claim only with a private input) is sent again while there is time, and the page says so
  const text = rec.phase === 'refund-wait' ? withWhy(detail, rec.why) : rec.phase === 'claiming' && rec.claimFailures ? `${detail} ${CLAIM_AGAIN}` : detail;
  return {
    id: rec.id, dir: 'b2e', state, title, detail: andNodes(text, rec, now()),
    // (what is left, to the ETH in the private balance: the wait for the lock's block counts down from its send, and never says less than a minute plus what follows)
    pay: BigInt(rec.amount), get: BigInt(rec.evmAmount || 0), steps: stepsOf('b2e', at, state), etaSecs: state !== 'working' || eta == null || late ? 0 : rec.phase === 'broadcast' && rec.broadcastAt ? 420 + Math.max(60, 600 - Math.max(0, now() - Number(rec.broadcastAt))) : eta, at: rec.created,
    refundAt: state === 'working' && lockAt ? lockAt + rec.csvBlocks * 600 : null, lockTxid: rec.lock ? rec.lock.txid : null, error: rec.lastError || null, provider: rec.providerName || null,
    batch: rec.batch ? { id: rec.batch.id, n: rec.batch.n, k: rec.batch.k } : null,
    // the ETH has to be claimed by the pool deadline of the provider's lock; missed, nothing is lost, and the BTC returns at refundAt
    backBy: state === 'working' && rec.evmOffer && Number(rec.evmOffer.deadline) > 0 ? Number(rec.evmOffer.deadline) : null,
  };
}
// What is left of an ETH-for-Bitcoin swap, in seconds: each phase's own part counts down from when it began (and never under a minute while it lasts),
// then the parts after it. To the BTC confirmed at the user's address.
const REV_AFTER = { accepted: 1050, locking: 840, locked: 840, offered: 600, taking: 0 };
const revLeft = (rec, eta, nowSecs) => {
  if (eta == null) return null;
  const after = REV_AFTER[rec.phase] ?? 0, own = eta - after, since = rec.phaseAt != null ? Math.max(0, nowSecs - Number(rec.phaseAt)) : 0;
  return after + Math.max(60, own - since);
};
const waitWords = (need) => (need > 1 ? `${need} Bitcoin confirmations` : 'one Bitcoin confirmation');
// What the ETH lock is waiting on, in words: never the bare 'sending' while nothing has gone out (a lock job is only sent once its note is ready and the pool read)
function lockingWords(rec, detail) {
  if (rec.lock && rec.lock.jobId) return detail;
  if (/exact size/i.test(String(rec.why || ''))) return 'Cutting a note of the exact size for your ETH. Nothing has been sent yet.';
  if (rec.lastError || Number(rec.buildFailures || 0) > 0) return 'Reading the pool did not go through, so it is being tried again. Nothing has been sent yet. Your ETH is in your private balance.';
  return 'Getting your private ETH ready to send. Nothing has been sent yet.';
}
export function describeRev(rec, now = () => Math.floor(Date.now() / 1000), tip = null) {
  if (rec.checking) return checking('e2b', rec, rec.providerName || null);
  let [at, title, detail, eta] = REV_SAYS[rec.phase] || [0, rec.phase, '', null];
  // (waiting for the provider's lock to confirm: said as the asked swap says it, its confirmations so far, a slow block, and the ETH lock made ready meanwhile)
  if (rec.phase === 'accepted' && rec.offer) {
    const need = confsForSats(rec.offer.btc.value), confs = Number(rec.lockConfs) || 0;
    title = 'Provider sent BTC';
    detail = join(`Waiting for ${waitWords(need)}${confs > 0 ? ` (${confs} so far)` : ''}. A block takes about 10 min, sometimes more. Your ETH goes in after that${rec.pre ? ' and is made ready meanwhile' : ''}.`, (!confs && missedLine(tip, rec.phaseAt, 'provider')) || busyLine(tip), slowBlockLine(tip, now(), SAFE_REV));
  } else if (rec.phase === 'locking') detail = lockingWords(rec, detail);
  else if (rec.phase === 'taking') detail = join(detail, slowBlockLine(tip, now(), SAFE_TAKE));
  // (a swap found again from the key whose provider has not yet taken its pool offer is said as being told, not as waiting for a claim: tellRecovered)
  else if (rec.phase === 'offered' && rec.recovered && !rec.toldBy) {
    [at, title] = [1, 'Telling the provider'];
    detail = 'Your ETH is sent. The swap was found again from your key and the provider is being told, every few minutes. If it does not confirm by the deadline, your ETH returns to your private balance.';
  }
  const state = rec.phase === 'done' ? 'done' : rec.phase === 'refunded' ? 'returned' : rec.phase === 'aborted' || rec.phase === 'lost' ? 'stopped' : 'working';
  // what reached the user's address: the lock less the fee of the take that spent it, when this page made the take
  // (a take made by another page or the watcher is read from that transaction: takenGot)
  const got = rec.takenGot != null && BigInt(rec.takenGot) > 0n ? BigInt(rec.takenGot)
    : rec.take && rec.lockValue != null && rec.take.fee != null && !rec.takenBy && BigInt(rec.lockValue) > BigInt(rec.take.fee) ? BigInt(rec.lockValue) - BigInt(rec.take.fee) : null;
  return {
    id: rec.id, dir: 'e2b', state, title, detail: andNodes(rec.phase === 'aborted' ? withWhy(detail, rec.why) : detail, rec, now()),
    pay: rec.offer ? BigInt(rec.offer.evm.amount) : 0n, get: rec.offer ? BigInt(rec.offer.btc.value) : 0n, got, steps: stepsOf('e2b', at, state),
    etaSecs: state !== 'working' ? 0 : rec.phase === 'accepted' && rec.offer ? (!Number(rec.lockConfs) && longWait(tip, rec.phaseAt, now()) ? 0 : confsLeft(confsForSats(rec.offer.btc.value), rec.lockConfs) + REV_AFTER.accepted) : revLeft(rec, eta, now()), at: rec.created,
    // (the take of the BTC was signed ahead and published where a watcher reads it: said only when that publish was answered, dapp/fastbridge-el.js protect)
    watched: state === 'working' && !!(rec.presig && rec.presig.published),
    // (once the provider has claimed, the ETH is not coming back: the BTC is taken instead, so no return time is given)
    refundAt: state === 'working' && rec.deadline && rec.phase !== 'taking' ? rec.deadline : null, lockTxid: rec.lockTxid || null, error: rec.lastError || null, provider: rec.providerName || null,
    // the page has to be back by the pool deadline: a claim by the provider then gives the BTC, which must be taken before the provider's own refund opens (at least
    // claimSlackSecs after the deadline, checked when the ETH is locked); with no claim, the ETH comes back after it
    backBy: state === 'working' && rec.deadline ? rec.deadline : null,
    // the hard limit: the provider's BTC returns to it once its timelock has run, and from then a claim it made on Ethereum leaves it both. Counted from the lock's
    // block with blocks as fast as the lock check assumes (5 min), so the real time is later; with the block unknown, the deadline plus the slack the lock check demanded.
    takeBy: state === 'working' && rec.deadline ? takeBy(rec, now(), tip) : null,
  };
}
const FAST_BLOCK_SECS = 300, CLAIM_SLACK_SECS = 7200;
function takeBy(rec, nowSecs, tip) {
  const h = Number(rec.lockHeight), csv = Number(rec.csvBlocks), tipH = tip && Number(tip.height);
  if (h > 0 && csv > 0 && tipH > 0) return nowSecs + Math.max(0, h + csv - 1 - tipH) * FAST_BLOCK_SECS;
  return Number(rec.deadline) + CLAIM_SLACK_SECS;
}


// ── a swap that several providers fill: its legs as one card ──
// Each leg is a swap of its own (describeFwd); the card says them together, with the legs inside it. It is working while any leg is, done when the legs have ended and any
// of them is done (what came back to the private balance is the sum of the done legs'; a leg that was returned says so by itself, with the BTC that came back), returned or
// stopped when none went through. One time left (the longest of the legs'), one page-back time (the earliest of the legs'), one refund time (the latest).
const LEG_NOTE = 'Each part is its own swap with its own provider. One that fails returns its BTC to you; the others finish.';
export function describeBatch(id, legs, now = () => Math.floor(Date.now() / 1000)) {
  const n = legs.length, working = legs.filter((l) => l.state === 'working'), done = legs.filter((l) => l.state === 'done'), ended = legs.filter((l) => l.state !== 'working');
  const state = working.length ? 'working' : done.length ? 'done' : legs.every((l) => l.state === 'stopped') ? 'stopped' : 'returned';
  const sum = (xs, f) => xs.reduce((t, l) => t + BigInt(f(l) || 0), 0n);
  const going = (l) => l.state === 'returned' || l.state === 'stopped' || (l.state === 'working' && l.title === 'Returning your BTC');
  const back = legs.filter(going);
  const word = (k) => (k === 1 ? 'one part' : `${k} parts`);
  let title, detail;
  if (state === 'working') {
    title = `Swapping across ${n} providers`;
    detail = `${n} parts from one Bitcoin payment. ${back.length ? `${word(back.length)} ${back.length === 1 ? 'is' : 'are'} returning: that BTC comes back to your Bitcoin address. ` : ''}${LEG_NOTE}`;
  } else if (state === 'done') {
    const lost = n - done.length;
    title = lost ? `Done: ${done.length} of ${n} parts` : 'Done';
    detail = lost ? `The ETH of ${word(done.length)} is in your private balance. ${word(lost).replace(/^./, (c) => c.toUpperCase())} did not go through; that BTC is back at your Bitcoin address.` : `The ETH from all ${n} providers is in your private balance.`;
  } else {
    title = state === 'stopped' ? 'Stopped' : 'Returned';
    detail = state === 'stopped' ? `The quote ran out before your BTC was sent, so it never left your Bitcoin address.` : 'No part went through. Your BTC is back at your Bitcoin address.';
  }
  // the steps are the ones every part still going has reached; a part that ended is not waited for
  const live = legs.filter((l) => !going(l));
  const titles = (legs[0].steps || []).map((s) => [s.key, s.title]);
  const steps = titles.map(([key, t]) => ({ key, title: t, state: state === 'done' ? 'done' : state === 'working' ? (live.length && live.every((l) => (l.steps.find((s) => s.key === key) || {}).state === 'done') ? 'done' : 'todo') : key === 'lock' && state === 'returned' ? 'done' : 'todo' }));
  if (state === 'working') { const a = steps.findIndex((s) => s.state !== 'done'); if (a >= 0) steps[a].state = 'active'; }
  const maxOf = (xs) => xs.reduce((m, x) => (x != null && x > m ? x : m), 0), minOf = (xs) => xs.filter((x) => x != null && x > 0).sort((a, b) => a - b)[0] ?? null;
  const stuck = working.find((l) => l.stuck);
  return {
    id: `batch:${id}`, dir: 'b2e', state, title, detail,
    pay: sum(legs, (l) => l.pay), get: sum(legs.filter((l) => l.state !== 'returned' && l.state !== 'stopped'), (l) => l.get),
    ...(state === 'done' ? { got: sum(done, (l) => (l.got != null && l.got > 0n ? l.got : l.get)) } : {}),
    steps, etaSecs: state === 'working' ? maxOf(working.map((l) => l.etaSecs)) : 0, at: Math.min(...legs.map((l) => l.at || 0)),
    refundAt: state === 'working' ? maxOf(working.map((l) => l.refundAt)) || null : null, lockTxid: legs[0].lockTxid, error: (legs.find((l) => l.error) || {}).error || null,
    provider: `${n} providers`, backBy: state === 'working' ? minOf(working.map((l) => l.backBy)) : null,
    ...(stuck ? { stuck: true, slow: stuck.slow } : {}),
    batch: { id, n, legs: legs.map((l) => ({ id: l.id, provider: l.provider, state: l.state, title: l.title, detail: l.detail, pay: l.pay, get: l.get, got: l.got ?? null, refundAt: l.refundAt, steps: l.steps, etaSecs: l.etaSecs, k: l.batch ? l.batch.k : 0 })) },
  };
}
// the descriptors of a batch's legs, set as one card each (a batch of which only one leg is known is that leg's own card)
function groupBatches(list) {
  const groups = new Map(), rest = [];
  for (const d of list) { if (d.batch) { if (!groups.has(d.batch.id)) groups.set(d.batch.id, []); groups.get(d.batch.id).push(d); } else rest.push(d); }
  for (const [id, legs] of groups) rest.push(legs.length === 1 ? legs[0] : describeBatch(id, legs.sort((a, b) => a.batch.k - b.batch.k)));
  return rest;
}

// the e2b swaps found again from the key are kept as one provider's: they have none to ask, and need none (a recovered swap is past the point where the provider is told anything)
const RECOVERED = { id: 'recovered', name: 'Found from your key', ref: { kind: 'recovered' } };
const noCall = async () => { throw new Error('this swap was found again from the key: it has no provider to ask'); };
const noCounter = () => { const no = async () => { throw new Error('this swap was found again from the key: it has no provider to ask, and needs none to return'); }; return { sendOffer: no, getEvmOffer: no, extend: no, reserve: no, quote: no, info: no }; };
// What the page says of a provider's refusal: this side's own words, never the provider's. An error the provider's answer carries (one with its HTTP status) is said
// as one of a few fixed sentences picked by what it is about, or as `fallback`; the page's own checks of a quote and its transports are worded here and kept.
const REMOTE_WORDS = [
  [/no price/i, 'the provider has no price right now'],
  [/busy|rate.?limit|too many/i, 'the provider is busy'],
  [/expired|too late/i, 'the quote expired: ask again'],
  [/amount|available|hold|limit|liquidity|funds/i, 'the provider cannot take that amount'],
];
const said = (e, fallback) => {
  if (!e || typeof e.message !== 'string' || !e.message) return fallback;
  if (e.status == null && !e.remote) return e.message;
  const hit = REMOTE_WORDS.find(([re]) => re.test(e.message));
  return hit ? hit[1] : fallback;
};
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('the provider did not answer in time')), ms))]);

// `ethAsset` is the pool's asset for ETH (a test's pool has a stand-in)
// The outpoints a holdings scan (tacit.js scanHoldings) names as carrying a note, or as not told apart: never spent as plain sats
export function noteOutpoints(holdings) {
  const out = new Set();
  if (!(holdings instanceof Map)) return out;
  for (const h of holdings.values()) {
    for (const k of ['utxos', 'ghosts', 'inflated', 'pending', 'unverified']) for (const x of (h && h[k]) || []) {
      const t = (x && x.utxo && x.utxo.txid) || (x && x.txid), v = x && x.utxo && x.utxo.vout != null ? x.utxo.vout : x && x.vout;
      if (t != null && v != null) out.add(`${t}:${v}`);
    }
  }
  for (const k of holdings.unclassified || []) out.add(k);
  return out;
}
// The providers ETH for Bitcoin is asked of by default (see e2bFrom above)
export const namedProvider = (p) => !!p && (p.http === true || p.pinned === true || !!OWN_PROVIDERS[strip((p.ref && p.ref.claimPub) || p.id || '')]);

export function makePairClient({ btc, evm, seed, stores, discover, counterFor, reverseCallFor, feed, policy: policyIn = {}, now = () => Math.floor(Date.now() / 1000), tend = (work) => work(), exclusive = (work) => work(), ethAsset = ETH_ASSET, memo = null, strikes: strikeStore = null, e2bFrom = namedProvider, holdings = null, takePresig = null }) {
  const policy = { ...PAIR_POLICY, ...policyIn };
  const ETH = strip(ethAsset);
  const isPairProvider = (p) => !!p && !!p.assets && strip(p.assets.btcAsset || '') === SATS_ASSET && strip(p.assets.evmAsset || '') === ETH;
  const claimPubHex = () => bytesToHex(btc.wallet.pub);

  // ── what is going on in the market ──
  async function reference() {
    let c = feed.current();
    if (!c || now() - c.at > policy.referenceFreshSecs) { try { await feed.refresh(); } catch { /* read again next time */ } c = feed.current(); }
    return c ? { ethPerBtc: c.ethPerBtc, at: c.at, n: c.n, source: `${c.n} source${c.n === 1 ? '' : 's'}` } : null;
  }
  // Why a market reading cannot be used to judge a quote, or null: too few sources behind it, or too far from the last good one
  let lastGood = null;
  const memoGet = () => { try { const m = memo ? memo.get() : lastGood; return m && Number(m.ethPerBtc) > 0 && Number.isFinite(Number(m.at)) ? { ethPerBtc: Number(m.ethPerBtc), at: Number(m.at) } : null; } catch { return lastGood; } };
  const memoPut = (m) => { lastGood = m; try { if (memo) memo.put(m); } catch { /* kept in this client */ } };
  function unusable(market) {
    if (!market) return 'the market price could not be read, so this quote cannot be checked';
    if (!(Number(market.n) >= policy.minMarketSources)) return 'the market price could not be confirmed by more than one source, so this quote cannot be checked';
    const last = memoGet();
    if (last && now() - last.at <= policy.marketMemoSecs && Math.abs(market.ethPerBtc / last.ethPerBtc - 1) * 10000 > policy.maxMarketJumpBps) return 'the market price read now is far from the last one, so this quote cannot be checked';
    memoPut({ ethPerBtc: market.ethPerBtc, at: now() });
    return null;
  }
  // ── providers that failed lately ──
  let struck = {};
  const strikesNow = () => { try { const m = strikeStore ? strikeStore.get() : struck; return m && typeof m === 'object' ? m : {}; } catch { return struck; } };
  const strikesPut = (m) => { struck = m; try { if (strikeStore) strikeStore.put(m); } catch { /* kept in this client */ } };
  const strikesOf = (id) => { const k = strikesNow()[id]; return k && now() - Number(k.at) < policy.strikeSecs ? Number(k.n) || 0 : 0; };
  const strike = (id) => { const m = { ...strikesNow() }; for (const [k, v] of Object.entries(m)) if (!(now() - Number(v.at) < policy.strikeSecs)) delete m[k]; m[id] = { n: strikesOf(id) + 1, at: now() }; strikesPut(m); };
  const cleared = (id) => { const m = strikesNow(); if (m[id]) { const c = { ...m }; delete c[id]; strikesPut(c); } };

  async function providers() {
    const all = (await discover()).filter(isPairProvider);
    return all.map((p) => {
      const rev = p.reverse && e2bFrom(p) ? p.reverse : null;        // (ETH for Bitcoin only of a provider the site names: e2bFrom above)
      return {
        id: p.id, name: p.name || 'Provider', ref: p.ref, dirs: ['b2e', ...(rev ? ['e2b'] : [])],
        // the site's own key (its ads are signed by it), or one /fast/lp.json names (reached over HTTP, or marked pinned)
        own: !!OWN_PROVIDERS[strip((p.ref && p.ref.claimPub) || p.id)], pinned: p.http === true || p.pinned === true || (!!p.ref && p.ref.kind === 'http'),
        fees: { b2e: { feeBps: Number(p.terms.feeBps) || 0, flatFee: BigInt(p.terms.flatFee ?? 0) }, e2b: rev ? { feeBps: Number(rev.feeBps) || 0, flatFee: BigInt(rev.flatFee ?? 0) } : null },
        minSats: BigInt(p.terms.minAmount), maxSats: BigInt(p.terms.maxAmount), b2e: { min: BigInt(p.terms.minAmount), max: BigInt(p.terms.maxAmount), available: p.terms.available == null ? null : BigInt(p.terms.available) },
        e2b: rev ? { min: BigInt(rev.minAmount), max: BigInt(rev.maxAmount), available: rev.available == null ? null : BigInt(rev.available) } : null,
      };
    });
  }
  // `sats` and `eth` are what can be put into a swap (confirmed coins; notes less the relay fee to cut one); `ethHeld` is what the key holds, `pendingSats` what has reached
  // the address and is waiting for a block
  async function balances() {
    const [coins, eth, ethHeld] = await Promise.all([
      (btc.satsCoins ? btc.satsCoins() : btc.satsUtxos().then((cs) => ({ coins: cs, pending: 0 }))).catch(() => null),
      evm.available ? Promise.resolve(evm.available()).then((v) => BigInt(v), () => null) : null,
      evm.heldFree ? Promise.resolve(evm.heldFree()).then((v) => BigInt(v), () => null) : null,
    ]);
    return { sats: coins ? coins.coins.reduce((s, c) => s + BigInt(c.value), 0n) : null, eth, ethHeld, pendingSats: coins ? BigInt(coins.pending || 0) : 0n };
  }

  // ── b2e: the user locks sats ──
  // The least ETH a swap found again from the key may be finished at, for its sats: the market price less what a provider's quote may have been under it (the quote
  // itself is not on Bitcoin). null when the market cannot be read well enough to judge by.
  async function recoverFloor(rec) {
    const market = await reference().catch(() => null);
    if (!market || unusable(market)) return null;
    const sats = Number(rec.amount), bps = policy.recoverMaxDiscountBps ?? 500;
    return BigInt(Math.floor(sats * market.ethPerBtc * (10000 - bps) / 10000));
  }
  const fwdBl = new Map();
  const blFor = (ref) => {
    const k = ref ? JSON.stringify([ref.kind, ref.claimPub || '', ref.gateway || ref.base || '']) : 'none';
    if (!fwdBl.has(k)) fwdBl.set(k, makeBitcoinLocker({ seed, now, store: stores.fwd, btc, evm, policy, counter: ref ? counterFor(ref) : noCounter(), recoverFloor }));
    return fwdBl.get(k);
  };
  const TERMINAL_COINS = new Set(['done', 'refunded', 'counter-took', 'aborted']);
  const heldCoins = async () => {
    const held = new Set();
    for (const r of await stores.fwd.list()) if (!TERMINAL_COINS.has(r.phase)) for (const i of r.feeInputs || []) held.add(`${i.txid}:${i.vout}`);
    return held;
  };
  // The coins a lock may not take: those of a swap under way, and those the wallet's holdings scan finds a note on or could not tell (tacit.js scanHoldings, as its own
  // sats send leaves them out). With a holdings reader that cannot answer, no lock is built (`strict`); a quote's fee estimate goes on without it.
  const avoidCoins = async (strict) => {
    const out = await heldCoins();
    if (!holdings) return out;
    let h = null;
    try { h = await holdings(); } catch { h = null; }
    if (!(h instanceof Map)) { if (strict) throw new Error('the coins at your Bitcoin address could not be checked for notes just now, so none was locked: try again in a moment'); return out; }
    for (const k of noteOutpoints(h)) out.add(k);
    return out;
  };

  async function quoteFwd(p, sats) {
    // (asked with the quote's own wait: a provider reached through a board is not asked for longer than that)
    const counter = counterFor(p.ref, { timeoutMs: policy.askMs });
    const r = await withTimeout(counter.quote(sats), policy.askMs);
    if (!r || typeof r.id !== 'string' || !isHex(r.claimPub || '', 66) || !isHex(r.btcAsset || '', 64) || !isHex(r.evmAsset || '', 64)) throw new Error('the provider\'s quote is not readable');
    if (strip(r.btcAsset) !== SATS_ASSET || strip(r.evmAsset) !== ETH) throw new Error('the provider\'s quote is not for Bitcoin and ETH');
    if (p.ref && p.ref.claimPub && strip(p.ref.claimPub) !== strip(r.claimPub)) throw new Error('the provider\'s key is not the one it advertised');
    const btcValue = big(r.btcValue, 'amount'), evmAmount = big(r.evmAmount, 'payout');
    if (btcValue !== sats) throw new Error('the quote is for a different amount');
    if (evmAmount <= 0n) throw new Error('the quote\'s payout is out of range');
    const csvBlocks = Number(r.csvBlocks);
    if (!Number.isInteger(csvBlocks) || csvBlocks < policy.minCsv || csvBlocks > policy.maxCsv) throw new Error('the quote\'s timelock is out of range');
    if (!(Number(r.validUntil) > now() + policy.quoteMarginSecs)) throw new Error('the quote expires too soon to use');
    if (Number(r.takeSats ?? 0) !== 0) throw new Error('the quote asks for a payment that a lock of bitcoin does not make');
    return { p, r: { ...r, claimPub: strip(r.claimPub), btcAsset: SATS_ASSET, evmAsset: ETH, btcValue, evmAmount, csvBlocks }, pay: btcValue, get: evmAmount };
  }
  // what the lock would cost on Bitcoin (nothing is stored or sent) and whether the address can pay it
  async function lockCost(q) {
    const bl = blFor(q.p.ref);
    policy.csvBlocks = q.r.csvBlocks;
    try {
      const { pair } = await bl.build({ asset: hexToBytes(SATS_ASSET), amount: q.r.btcValue, counterClaimPub: hexToBytes(q.r.claimPub), evmAsset: q.r.evmAsset, evmAmount: q.r.evmAmount, quoteId: q.r.id, avoid: await avoidCoins(false) });
      return { fee: pair.revealFee, short: null };
    } catch (e) {
      const m = /not enough sats for the lock \(need (\d+), have (\d+)\)/.exec(String((e && e.message) || e));
      if (m) return { fee: null, short: { need: BigInt(m[1]), have: BigInt(m[2]) } };
      throw e;
    }
  }
  async function startFwd(q, paid = null) {
    const r = q.ref.r, bl = blFor(q.ref.p.ref);
    const avoid = await avoidCoins(true);                // (before the provider is asked to hold anything)
    const held = await counterFor(q.ref.p.ref).reserve({ quoteId: r.id });
    // (a provider that cannot hold its own quote is asked after the others for a while, and the page asks for a new quote: the next best, whose numbers are shown again)
    if (!held || held.ok === false) { strike(q.ref.p.id); throw Object.assign(new Error('the provider cannot hold that amount just now: a new quote is being asked for'), { requote: true }); }
    cleared(q.ref.p.id);
    policy.csvBlocks = r.csvBlocks;
    const rec = await bl.start({ asset: hexToBytes(SATS_ASSET), amount: r.btcValue, counterClaimPub: hexToBytes(r.claimPub), evmAsset: r.evmAsset, evmAmount: r.evmAmount, quoteId: r.id, avoid, validUntil: Number(r.validUntil) || null, ...(paid ? { first: paid } : {}) });
    rec.provider = q.ref.p.ref; rec.providerName = q.ref.p.name;
    await stores.fwd.put(rec);
    await bl.step(rec).catch(() => {});                 // the lock is stored: a send that fails is tried again by the next pass
    return { id: rec.id };
  }


  // The split's start: each provider is asked to hold its quote first (one that cannot is struck, and the page asks for a new quote without it: nothing was sent, so a split
  // is never left short of a leg it could not hold), then the one transaction with a lock for each is built, kept as a record for each leg, and sent. From the send, each leg
  // is its own swap: it finishes, or its own timelock returns its own BTC.
  async function startSplit(q, paid = null) {
    const legs = q.split.legs.map((l) => l.ref);
    const avoid = await avoidCoins(true);
    const held = await Promise.all(legs.map(async ({ p, r }) => { try { return await counterFor(p.ref).reserve({ quoteId: r.id }); } catch { return null; } }));
    const bad = legs.filter((_, i) => !held[i] || held[i].ok === false);
    if (bad.length) { for (const b of bad) strike(b.p.id); throw Object.assign(new Error('a provider of the split cannot hold its share just now: a new quote is being asked for'), { requote: true }); }
    for (const { p } of legs) cleared(p.id);
    policy.csvBlocks = legs[0].r.csvBlocks;
    const recs = await blFor(legs[0].p.ref).startBatch({ legs: batchArgs(legs), avoid, validUntil: Math.min(...legs.map((l) => Number(l.r.validUntil))), ...(paid ? { first: paid } : {}) });
    // (the first put, in startBatch, already names each leg's provider: batchArgs)
    for (const rec of recs) await blFor(rec.provider || null).step(rec).catch(() => {});      // each lock output is stored: a send that fails is tried again by the next pass
    return { id: recs[0].batch.id, ids: recs.map((r) => r.id) };
  }

  // ── e2b: the provider locks sats first ──
  // (a quote is asked with the quote's own wait, as b2e's is: a provider reached through a board is not polled for longer than that; the rest of a swap keeps the transport's own)
  const reverseCall = (ref) => {
    const slow = reverseCallFor(ref), quick = reverseCallFor(ref, { timeoutMs: policy.askMs });
    return (method, path, body) => (path === '/reverse/quote' ? quick : slow)(method, path, body);
  };
  const revClients = new Map();
  const revFor = (p) => {
    if (!revClients.has(p.id)) {
      revClients.set(p.id, makeReverseClient({
        lp: makeReverseCounter(p.ref && p.ref.kind === 'recovered' ? noCall : reverseCall(p.ref)), btc, evm, seed, now, store: stores.swaps(p.id), quoteStore: stores.quotes(p.id),
        pins: { btcAsset: SATS_ASSET, evmAsset: ETH }, confsOf: confsForSats, policy: { early: policy.early },
        // the two sides are different units: the price is judged against the market (below), so here only that the payout is something and the fee is not the amount
        valueCheck: () => ({ fee: 0n, highFee: false }),
        admit: (o) => lockInUse(p.id, o), ...(takePresig ? { takePresig } : {}),
      }));
    }
    return revClients.get(p.id);
  };
  // The e2b swaps are kept a store per provider, so what one Bitcoin lock already answers is looked up across all of them: a lock (or a swap id) that a swap of
  // any provider answers is not answered again, so one lock of sats never has two locks of ETH against it.
  async function lockInUse(pid, { id, offer }) {
    const txid = strip((offer && offer.btc && offer.btc.txid) || ''), vout = offer && offer.btc ? Number(offer.btc.vout) : -1;
    const ids = new Set([pid, RECOVERED.id, ...(await revProviders()).map((p) => p.id)]);
    for (const q of ids) {
      for (const r of await stores.swaps(q).list()) {
        if (r.id === id && q !== pid) return 'this swap is already answered for another provider';
        if (r.id !== id && strip(r.lockTxid || '') === txid && Number(r.lockVout) === vout) return 'this Bitcoin lock is already answered by another swap';
      }
    }
    return null;
  }
  async function quoteRev(p, units) {
    const q = await withTimeout(revFor(p).quote(units), policy.askMs);
    return { p, r: q, pay: q.evmAmount, get: q.btcValue };
  }

  // ── the quote the lane shows ──
  // Whether a provider can be asked for a quote of `want` in `dir`: it offers that direction and the amount is inside its terms
  const eligible = (dir, p, want) => { const s = dir === 'b2e' ? p.b2e : p.e2b; return !!s && want >= s.min && want <= s.max; };
  // The keys this one finished a swap with: a b2e record names its provider's key, an e2b swap is kept under the provider it was asked of
  async function finishedWith() {
    const out = new Set();
    for (const r of await stores.fwd.list().catch(() => [])) if (FWD_DONE.has(r.phase) && r.provider && r.provider.claimPub) out.add(strip(r.provider.claimPub));
    for (const p of await revProviders().catch(() => [])) {
      if (p.id === RECOVERED.id) continue;
      if ((await stores.swaps(p.id).list().catch(() => [])).some((r) => r.phase === 'done')) { out.add(strip(p.id)); if (p.ref && p.ref.claimPub) out.add(strip(p.ref.claimPub)); }
    }
    return out;
  }
  // A provider the page knows is always asked; an ad anyone can post is one of a few more, so a run of ads that never answer cannot crowd the known ones out
  async function toAsk(dir, list, want) {
    const done = await finishedWith();
    const known = (p) => p.own || p.pinned || done.has(strip(p.id)) || (!!p.ref && !!p.ref.claimPub && done.has(strip(p.ref.claimPub)));
    const feeAt = (p) => { const f = p.fees && p.fees[dir]; return f ? (want * BigInt(f.feeBps)) / 10000n + f.flatFee : 0n; };
    // the best by what they advertise, those that failed lately after the rest
    const order = (ps) => ps.map((p) => ({ p, k: strikesOf(p.id), fee: feeAt(p) })).sort((a, b) => a.k - b.k || (a.fee < b.fee ? -1 : a.fee > b.fee ? 1 : 0)).map((x) => x.p);
    // (one struck three times or more is left out while another of its kind can be asked, and an ad while any provider can be)
    const usable = (ps) => { const ok = ps.filter((p) => strikesOf(p.id) < policy.maxStrikes); return ok.length ? ok : ps; };
    const mine = order(usable(list.filter(known))).slice(0, policy.maxAsk), others = list.filter((p) => !known(p));
    const ok = others.filter((p) => strikesOf(p.id) < policy.maxStrikes), rest = ok.length ? ok : mine.length ? [] : others;
    return [...mine, ...order(rest).slice(0, Math.max(0, Math.min(policy.maxOtherAsk, policy.maxAsk - mine.length)))];
  }
  async function quoteOne({ dir, amount }) {
    if (dir !== 'b2e' && dir !== 'e2b') throw new Error('the direction is not one this page makes');
    const want = BigInt(amount);
    if (want <= 0n) throw new Error('enter an amount');
    // the price and the providers are read together (and the Bitcoin fee estimate is started now, for the lock's cost below: it is kept for a minute, so typing more does not read it again)
    try { btc.feeRate && btc.feeRate().catch(() => {}); } catch { /* read below */ }
    const [market, all] = await Promise.all([reference(), providers()]);
    const can = all.filter((p) => eligible(dir, p, want));
    if (!all.length) throw new Error('no provider is offering Bitcoin for ETH right now');
    if (dir === 'e2b' && !all.some((p) => p.e2b)) throw new Error('no provider is offering ETH for Bitcoin right now');
    if (!can.length) throw new Error('no provider takes that amount');
    const asked = await toAsk(dir, can, want);
    const got = await Promise.all(asked.map(async (p) => {
      try { return await (dir === 'b2e' ? quoteFwd(p, want) : quoteRev(p, want)); } catch (error) { strike(p.id); return { p, error }; }
    }));
    // (the best quote of a provider that has not failed lately wins: one that could not hold its last quote is taken only when no other quotes)
    const good = got.filter((g) => !g.error).sort((a, b) => (strikesOf(a.p.id) > 0) - (strikesOf(b.p.id) > 0) || (a.get > b.get ? -1 : a.get < b.get ? 1 : 0));
    if (!good.length) throw new Error(said(got[0] && got[0].error, 'no provider could quote that amount just now'));
    const best = good[0], rate = rateOf(dir === 'b2e' ? best.get : best.pay, dir === 'b2e' ? best.pay : best.get);
    const warnings = [];
    let blocked = unusable(market), versus = null;
    if (!blocked) {
      versus = vsMarketBps(dir, rate, market.ethPerBtc);
      if (versus < -policy.maxWorseBps) blocked = `the provider quotes ${(-versus / 100).toFixed(1)}% under the market`;
      else if (versus < -policy.warnWorseBps) warnings.push(`this is ${(-versus / 100).toFixed(1)}% worse than the market price`);
    }
    // `short` is a Bitcoin address that cannot pay the amount and the fee of the lock: not a price that is wrong, so it is not `blocked` (the page offers to add sats), and `start` still refuses it
    let networkFeeSats = null, short = null;
    if (dir === 'b2e') {
      const c = await lockCost(best).catch(() => null);
      if (c && c.short) { short = c.short; networkFeeSats = Number(c.short.need - best.pay); }
      else if (c) networkFeeSats = c.fee;
    }
    // e2b: the user takes the sats from the provider's lock with a transaction that pays its own fee out of the lock (a rate above the estimate, as fastbridge-el.js sets it), so what
    // arrives is the lock less that fee
    let takeFeeSats = null;
    if (dir === 'e2b') {
      try {
        const feeFor = btc.prims && btc.prims.feeFor;
        if (typeof feeFor === 'function') takeFeeSats = Number(feeFor(TAKE_VSIZE, Math.ceil((await btc.feeRate()) * (policy.takeFeeFactor ?? 1.2))));
      } catch { takeFeeSats = null; }
    }
    // a Bitcoin fee that is a large share of what is swapped: the lock's (b2e, of the sats paid) or the take's (e2b, of the sats received)
    const feeSats = dir === 'b2e' ? networkFeeSats : takeFeeSats, feeOn = dir === 'b2e' ? best.pay : best.get;
    const highFee = feeSats != null && feeOn > 0n && BigInt(Math.ceil(Number(feeSats))) * 10000n > feeOn * BigInt(policy.maxFeeShareBps) ? { sats: Number(feeSats), bps: Number((BigInt(Math.ceil(Number(feeSats))) * 10000n) / feeOn) } : null;
    return {
      dir, provider: { id: best.p.id, name: best.p.name }, pay: best.pay, get: best.get, takeFeeSats, highFee, rate, market: market && versus != null ? market.ethPerBtc : null, vsMarketBps: versus,
      feeBps: versus == null ? 0 : Math.max(0, -versus), etaSecs: dir === 'b2e' ? FWD_SAYS.built[3] + 60 : REV_SAYS.accepted[3] + 120, networkFeeSats, expiresAt: Number(best.r.validUntil), warnings, blocked, short, ref: best,
    };
  }


  // ── Bitcoin for ETH across several providers ──
  // The amount is above what the best provider takes, or a share to a second provider is cheaper: one Bitcoin transaction pays a lock to each provider (fastbridge-bl.js
  // startBatch), and each lock is a swap of its own with its own provider, its own quote, hold, extension, offer and claim. The page shows the plan (what each provider is
  // given, what comes back in all) before the press, and the swaps as one card.
  const plannerOf = (p, rate) => ({ id: p.id, min: p.b2e.min, max: p.b2e.max, available: p.b2e.available, feeBps: p.fees.b2e.feeBps, flatFee: p.fees.b2e.flatFee, rate });
  const rateOfQuote = (p, r) => { const net = r.btcValue - feeOf({ feeBps: p.fees.b2e.feeBps, flatFee: p.fees.b2e.flatFee }, r.btcValue); return net > 0n ? (r.evmAmount * RATE_ONE) / net : RATE_ONE; };
  const splitPolicy = () => ({ maxLegs: policy.splitLegs, minLegSats: BigInt(policy.splitMinLegSats), minGainBps: policy.splitMinGainBps });
  // The plan over these providers; the ones that failed lately are left out while the rest can fill the amount, and taken only when they cannot
  const planFor = async (want, cand, rateOf2) => {
    const feeRate = await btc.feeRate().catch(() => 1), plan = (ps) => (ps.length >= 2 ? planSplit({ amount: want, providers: ps.map((p) => plannerOf(p, rateOf2(p))), feeRate, policy: splitPolicy() }).best : null);
    const clean = cand.filter((p) => strikesOf(p.id) === 0);
    return (clean.length < cand.length ? plan(clean) : null) || plan(cand);
  };
  const splitCands = (all, out = new Set()) => all.filter((p) => p.b2e && !out.has(p.id) && strikesOf(p.id) < policy.maxStrikes);
  // What the plan from the ads alone says: null when one provider is the answer (or none can take it), else the plan with two or more legs
  async function adPlan(want, all) {
    const cand = splitCands(all);
    if (cand.length < 2) return null;
    const best = await planFor(want, cand, () => RATE_ONE);
    return best && best.split ? best : null;
  }
  // The legs of a plan quoted, each at its own amount, and the plan settled on what the quotes give (their rates replace the ads' assumption of one rate): a provider that
  // cannot quote, or does not answer a share of a transaction (its quote does not say `legVouts`), is left out and the plan made again without it
  async function quoteSplit(want, all, first, why = []) {
    const out = new Set(), rates = new Map();
    let plan = first, got = new Map();
    for (let round = 0; round < 4 && plan; round++) {
      const results = await Promise.all(plan.legs.map(async (leg) => {
        const p = all.find((x) => x.id === leg.id), kept = got.get(leg.id);
        if (kept && kept.r.btcValue === leg.amount) return { leg, p, q: kept };
        try {
          const q = await quoteFwd(p, leg.amount);
          if (q.r.legVouts !== 1) throw new Error('the provider does not take a share of a transaction');
          return { leg, p, q };
        } catch (error) { strike(p.id); why.push(`${p.name}: ${said(error, 'did not answer')}`); return { leg, p, error }; }
      }));
      for (const r of results) { if (r.q) { got.set(r.p.id, r.q); rates.set(r.p.id, rateOfQuote(r.p, r.q.r)); } else out.add(r.p.id); }
      // the rate of a provider not quoted yet is taken as the mean of the ones that have: the plan is then made on the differences in their fees and what they hold
      const known = [...rates.values()], mean = known.length ? known.reduce((t, x) => t + x, 0n) / BigInt(known.length) : RATE_ONE;
      const cand = splitCands(all, out);
      if (cand.length < 2) return null;
      const next = await planFor(want, cand, (p) => rates.get(p.id) ?? mean);
      if (!next || !next.split) return null;
      const same = next.legs.length === plan.legs.length && next.legs.every((l, i) => l.id === plan.legs[i].id && l.amount === plan.legs[i].amount);
      const done = results.every((r) => r.q);
      plan = next;
      if (done && same) return { plan, legs: plan.legs.map((l) => ({ ...got.get(l.id), leg: l })) };
    }
    // the rounds ran out with the plan still moving: quote what is missing once more, and take the last plan as it stands
    if (!plan) return null;
    const legs = [];
    for (const leg of plan.legs) {
      const p = all.find((x) => x.id === leg.id);
      let q = got.get(leg.id);
      if (!q || q.r.btcValue !== leg.amount) {
        try { q = await quoteFwd(p, leg.amount); if (q.r.legVouts !== 1) throw new Error('no'); } catch { strike(p.id); return null; }
      }
      legs.push({ ...q, leg });
    }
    return { plan, legs };
  }
  // what the one transaction would cost on Bitcoin for these legs (nothing is stored or sent), and whether the address can pay it
  const batchArgs = (legs) => legs.map((l) => ({ counterClaimPub: hexToBytes(l.r.claimPub), amount: l.r.btcValue, evmAsset: l.r.evmAsset, evmAmount: l.r.evmAmount, quoteId: l.r.id, csvBlocks: l.r.csvBlocks, validUntil: Number(l.r.validUntil) || null, provider: l.p.ref, providerName: l.p.name }));
  async function batchCost(legs) {
    try {
      const { pair } = await blFor(legs[0].p.ref).buildBatch({ legs: batchArgs(legs), avoid: await avoidCoins(false) });
      return { fee: pair.revealFee, short: null };
    } catch (e) {
      const m = /not enough sats for the lock \(need (\d+), have (\d+)\)/.exec(String((e && e.message) || e));
      if (m) return { fee: null, short: { need: BigInt(m[1]), have: BigInt(m[2]) } };
      throw e;
    }
  }
  // The quote of a split, shaped as a single one is (the lane shows it the same way) with the plan beside it: `split.legs`, and `split.single`, what one provider would give
  // when one can take the whole (a split is chosen over it only when it gives more by splitMinGainBps; the lane shows both)
  async function splitQuote(want, market, made, single) {
    const legs = made.legs.map((l) => ({ p: l.p, r: l.q ? l.q.r : l.r, pay: l.pay, get: l.get }));
    const pay = legs.reduce((t, l) => t + l.pay, 0n), get = legs.reduce((t, l) => t + l.get, 0n);
    if (pay !== want) throw new Error('the legs of the split do not add up to the amount');
    const rate = rateOf(get, pay), warnings = [];
    let blocked = unusable(market), versus = null;
    if (!blocked) {
      versus = vsMarketBps('b2e', rate, market.ethPerBtc);
      // each leg is judged on its own as a lone quote is: a share at a bad price is not hidden by the others
      const worst = Math.min(...legs.map((l) => vsMarketBps('b2e', rateOf(l.get, l.pay), market.ethPerBtc)));
      if (worst < -policy.maxWorseBps) blocked = `a provider of the split quotes ${(-worst / 100).toFixed(1)}% under the market`;
      else if (versus < -policy.warnWorseBps) warnings.push(`this is ${(-versus / 100).toFixed(1)}% worse than the market price`);
    }
    let networkFeeSats = null, short = null;
    const c = await batchCost(legs).catch(() => null);
    if (c && c.short) { short = c.short; networkFeeSats = Number(c.short.need - pay); } else if (c) networkFeeSats = c.fee;
    const highFee = networkFeeSats != null && pay > 0n && BigInt(Math.ceil(Number(networkFeeSats))) * 10000n > pay * BigInt(policy.maxFeeShareBps) ? { sats: Number(networkFeeSats), bps: Number((BigInt(Math.ceil(Number(networkFeeSats))) * 10000n) / pay) } : null;
    // the confirmations the providers ask are by the total the transaction locks (fastbridge-el.js confValue)
    const etaSecs = FWD_SAYS.built[3] + 60 + (confsForSats(pay) - 1) * 600;
    const expiresAt = Math.min(...legs.map((l) => Number(l.r.validUntil)));
    return {
      dir: 'b2e', provider: { id: 'split', name: `${legs.length} providers` }, pay, get, takeFeeSats: null, highFee, rate, market: versus != null ? market.ethPerBtc : null, vsMarketBps: versus,
      feeBps: versus == null ? 0 : Math.max(0, -versus), etaSecs, networkFeeSats, expiresAt, warnings, blocked, short,
      split: {
        legs: legs.map((l) => ({ provider: { id: l.p.id, name: l.p.name }, pay: l.pay, get: l.get, ref: { p: l.p, r: l.r } })),
        single: single ? { provider: single.provider, pay: single.pay, get: single.get, networkFeeSats: single.networkFeeSats } : null,
      },
      ref: { p: legs[0].p, r: legs[0].r },
    };
  }
  async function quote({ dir, amount }) {
    if (dir !== 'b2e' || policy.split === false) return quoteOne({ dir, amount });
    const want = BigInt(amount);
    let all = [];
    try { all = want > 0n ? await providers() : []; } catch { all = []; }
    const first = await adPlan(want, all).catch(() => null);
    if (!first) return quoteOne({ dir, amount });
    const market = await reference();
    const why = [];
    const [one, made] = await Promise.all([quoteOne({ dir, amount }).catch((error) => ({ error })), quoteSplit(want, all, first, why).catch(() => null)]);
    const lone = one && !one.error ? one : null;
    // (a split that could not be quoted says which provider failed it, and not only that the first could not take the whole amount)
    if (!made) { if (lone) return lone; throw why.length ? new Error(`this amount needs more than one provider, and ${why.join('; ')}`) : one.error; }
    const sq = await splitQuote(want, market, made, lone);
    if (!lone) return sq;
    // a split is shown over a lone quote only when it gives more by what is worth the added locks (net of the added output's fee), or when the lone quote is blocked
    const extra = BigInt(Math.max(0, Math.ceil(Number(sq.networkFeeSats ?? 0)) - Math.ceil(Number(lone.networkFeeSats ?? 0))));
    const gain = sq.get - lone.get - (extra * lone.get) / (lone.pay || 1n);
    return !sq.blocked && (lone.blocked || gain * 10000n >= lone.get * BigInt(policy.splitMinGainBps)) ? sq : lone;
  }

  // one start of the key's at a time: the coins and notes a swap holds are read inside, so a second start picks others or stops
  // `coming` (e2b): pool units of a deposit of the user's that is mined and is being settled into a note, which the lock is made from once it lands
  // `coins` (b2e): coins just paid to the address and not yet in a block (arriving, below), which the lock spends first: lock and payment then confirm
  // together, rather than the lock waiting a block for the payment
  const start = (q, { coming = null, coins = null } = {}) => exclusive(() => startOnce(q, coming, coins));
  async function startOnce(q, coming = null, coins = null) {
    const paid = q.dir === 'b2e' && Array.isArray(coins) && coins.length ? coins : null;
    if (q.blocked) throw new Error(q.blocked);
    if (q.highFee && !q.feeAccepted) throw new Error(`the Bitcoin fee is about ${q.highFee.sats} sats, ${(q.highFee.bps / 100).toFixed(1)}% of the amount: accept it to go on`);
    if (q.short && !paid) throw new Error(`your Bitcoin address holds ${q.short.have} sats and this needs ${q.short.need}, the amount and the network fee`);
    if (!(q.expiresAt > now() + policy.quoteMarginSecs)) throw new Error('the quote expired: ask again');
    if (q.dir === 'b2e') {
      const b = await balances();
      const more = paid ? paid.reduce((s, c) => s + BigInt(c.value), 0n) : 0n;
      if (b.sats != null && b.sats + more < q.pay) throw new Error('your Bitcoin address does not hold that many sats');
      return q.split ? startSplit(q, paid) : startFwd(q, paid);
    }
    // a note of exactly the amount is locked as it is: what `available` keeps back for a cut is not needed then (evm.covers); a mined deposit counts (coversWith)
    if (!(await coversWith(evm, q.pay, coming))) throw new Error('your private ETH does not cover that amount');
    let a;
    try { a = await revFor(q.ref.p).start({ quote: q.ref.r, coming }); } catch (e) {
      // (the reverse client words a refusal with the provider's reason after it: the page says its own sentence)
      strike(q.ref.p.id);
      throw Object.assign(new Error(/^the provider cannot lock that amount/.test(String(e && e.message)) ? 'the provider cannot lock that amount just now: a new quote is being asked for' : said(e, 'the provider did not answer just now')), { requote: true });
    }
    cleared(q.ref.p.id);
    const index = stores.index;
    if (!(await index.get(q.ref.p.id))) await index.put({ id: q.ref.p.id, name: q.ref.p.name, ref: q.ref.p.ref });
    // the note the lock spends is cut to the amount now, while the provider's lock waits for its block, not after it (a deposit still landing: once it has, prepare)
    if (coming == null) prepare(q.pay).catch(() => {});
    return { id: a.swapId };
  }
  // A note of exactly `amount` made ahead of a lock of it (fastbridge-evm.js prepare: nothing is done when one is there; else the notes are cut to it, a
  // transfer to this key that costs the relay's fee), so the lock is built the moment the provider's lock is confirmed
  const prepare = async (amount) => { if (evm.prepare) await evm.prepare({ rec: { offer: { evm: { amount: String(BigInt(amount)) } } } }); };

  // ── the swaps ──
  const newest = (a, b) => (b.at || 0) - (a.at || 0);
  // a swap the user asked a provider to lock for, before it has locked: kept in the quote store only
  async function asked(p) {
    const out = [];
    const swaps = stores.swaps(p.id);
    for (const q of await stores.quotes(p.id).list()) {
      if (!q.swapId || (q.settled && !q.gaveUp) || (await swaps.get(q.swapId))) continue;
      if (q.gaveUp && now() - (q.startedAt || 0) > 7 * 86400) continue;
      // (the provider tells its lock once a block has it: until then the swap waits on that block, counted down from the ask, or from when the lock was seen.
      // A provider that gives its lock's txid has it shown, with the confirmations the explorers read: fastbridge-reverse-client.js watchLock)
      const need = confsForSats(q.btcValue ?? 0), confs = Number(q.lockConfs) || 0, seen = !q.gaveUp && !!q.lockTxid;
      const waitFor = waitWords(need);
      out.push({
        id: q.swapId, dir: 'e2b', state: q.gaveUp ? 'stopped' : 'working', title: q.gaveUp ? 'Stopped' : seen ? 'The provider locked BTC for you' : 'The provider is locking BTC for you',
        detail: q.gaveUp ? `${String(q.gaveUp).replace(/\.$/, '')}. Nothing of yours was locked.`
          : seen ? join(`Waiting for ${waitFor}${confs > 0 ? ` (${confs} so far)` : ''}. A block comes about every ten minutes, some sooner, some later. Your ETH is locked after that.`, !confs ? missedLine(tipSeen, q.startedAt, 'provider') : '', slowBlockLine(tipSeen, now(), SAFE_REV))
            : `Its lock goes out first and waits for ${waitFor}, about ten minutes. Your ETH is locked only after that.`,
        pay: BigInt(q.evmAmount ?? 0), get: BigInt(q.btcValue ?? 0), steps: stepsOf('e2b', 0, q.gaveUp ? 'returned' : 'working'),
        etaSecs: q.gaveUp ? 0 : seen && !confs && longWait(tipSeen, q.startedAt, now()) ? 0 : seen ? confsLeft(need, confs) + REV_AFTER.accepted : revLeft({ phase: 'accepted', phaseAt: q.startedAt }, REV_SAYS.accepted[3] + 60, now()),
        at: q.startedAt || 0, refundAt: null, lockTxid: seen ? strip(q.lockTxid) : null, error: null, provider: p.name,
      });
    }
    return out;
  }
  const revProviders = async () => (await stores.index.list()).filter((p) => p && typeof p.id === 'string' && p.ref);
  // The newest Bitcoin block (its height and time), read at most every 30 s while a swap waits on Bitcoin: words only (a slow block is said), nothing is decided on it
  let tipSeen = null, tipAt = -Infinity, tipRead = null;
  async function readTip() {
    if (now() - tipAt < 30 || !btc.tip || !btc.blockTime) return;
    tipAt = now();
    tipRead ||= (async () => { try { const h = await btc.tip(); tipSeen = { height: h, at: await btc.blockTime(h), fee: btc.feeRate ? await Promise.resolve().then(() => btc.feeRate(0)).catch(() => null) : null }; } catch { /* read again in 30 s */ } })().finally(() => { tipRead = null; });
    await tipRead;
  }
  const WAITS = new Set(['broadcast', 'accepted', 'taking']);
  // a swap's step said stuck: its words, and the lane's 'Check again'
  const withSlow = (d, slow) => (slow ? { ...d, stuck: true, slow } : d);
  // ── the watchdog: a swap that has not moved for longer than its step should take ──
  // What each swap last did is kept in this page (its phase and what it waits on). One that has not moved for longer than its step's own time (WATCH below, and
  // never a wait for a Bitcoin block, which takes what it takes and is said as such) is looked at afresh once a minute: every read this page keeps that could
  // stand in its way is let go (fastbridge-evm.js forget) and the swap is stepped at once (fastbridge-el.js poke). Past five minutes more it says so, with what
  // happens to the funds and when, and the lane offers 'Check again' (checkAgain), which does the same at once.
  const moved = new Map(), forcedAt = new Map();
  const confirmedFor = (rec) => rec.offer && Number(rec.lockConfs || 0) >= confsForSats(rec.offer.btc.value);
  const watchOf = (dir, rec) => {
    if (dir === 'b2e') return rec.phase === 'broadcast' ? (rec.confirmedAt ? WATCH.b2e.offering : null) : WATCH.b2e[rec.phase] ?? null;
    if (rec.phase === 'accepted') return confirmedFor(rec) ? WATCH.e2b.accepted : null;
    return WATCH.e2b[rec.phase] ?? null;
  };
  const stepKey = (rec) => JSON.stringify([rec.phase, Number(rec.lockConfs || 0), !!rec.confirmedAt, !!(rec.lock && rec.lock.jobId), !!rec.evmOffer, !!(rec.claim && rec.claim.jobId), rec.take ? rec.take.txid : null, !!rec.refund]);
  const stillFor = (id, key) => { const m = moved.get(id); if (!m || m.key !== key) { moved.set(id, { key, at: now() }); return 0; } return now() - m.at; };
  // what happens to the funds of a swap that takes longer than it should, and when: the page does it by itself
  function safeWords(dir, rec) {
    if (dir === 'b2e') {
      const back = rec.lockAt || rec.confirmedAt ? `, about ${untilWords((rec.lockAt || rec.confirmedAt) + rec.csvBlocks * 600)}` : ', about a day after it confirmed';
      return `Your funds are safe. If the swap does not finish, your BTC returns to your Bitcoin address${back}.`;
    }
    if (rec.phase === 'accepted') return 'Your funds are safe: nothing of yours has moved yet.';
    if (rec.phase === 'taking') return 'The BTC is yours. This page keeps sending it and raises the fee if it waits.';
    if (rec.phase === 'refunding') return 'Your funds are safe. The refund does not depend on the provider, and this page keeps sending it.';
    return rec.deadline ? `Your funds are safe. If the provider has not confirmed ${untilWords(rec.deadline)}, your ETH returns to your private balance.` : 'Your funds are safe: nothing is spent until this step goes through.';
  }
  const untilWords = (at) => { const s = Number(at) - now(); if (!(s > 0)) return 'now'; const h = Math.floor(s / 3600), m = Math.ceil((s % 3600) / 60); return h ? `in about ${h} h${m && m < 60 ? ` ${m} min` : ''}` : `in about ${Math.max(1, m)} min`; };
  // One look at a swap: whether it is stuck, and (stepping) a fresh read for it once a minute while it is
  async function watch(dir, rec, step, kick) {
    const budget = watchOf(dir, rec);
    const still = stillFor(rec.id, stepKey(rec));
    if (budget == null || still <= budget) return null;
    if (step && now() - (forcedAt.get(rec.id) || 0) >= 60) {
      forcedAt.set(rec.id, now());
      try { if (evm.forget) evm.forget(); await kick(); } catch { /* the next pass */ }
    }
    return still > budget + (rec.phase === 'locking' ? 60 : (policy.slowSayAfterSecs ?? 300)) ? `Taking longer than usual. ${safeWords(dir, rec)}` : null;
  }
  // 'Check again': every swap under way (or only `id`) is read afresh now, and the records come back
  async function checkAgain(id = null) {
    if (evm.forget) evm.forget();
    tipAt = -Infinity;
    const inBatch = id && String(id).startsWith('batch:') ? String(id).slice(6) : null;
    for (const rec of await stores.fwd.list()) if (!FWD_END.has(rec.phase) && (!id || rec.id === id || (inBatch && rec.batch && rec.batch.id === inBatch))) { forcedAt.set(rec.id, now()); await blFor(rec.provider || null).step(rec).catch(() => {}); }
    for (const p of await revProviders()) {
      for (const q of await stores.quotes(p.id).list().catch(() => [])) if (q.swapId && !q.settled && (!id || q.swapId === id)) await stores.quotes(p.id).put({ ...q, watchAt: null, earlyAt: null });
      for (const r of await stores.swaps(p.id).list().catch(() => [])) if (!REV_END.has(r.phase) && (!id || r.id === id)) { forcedAt.set(r.id, now()); await revFor(p).el.poke(r).catch(() => {}); }
    }
    return view(true);
  }

  // A swap found again from the key whose ETH lock is in the pool and that no provider has claimed: its record was rebuilt from the lock's memo, which names no
  // provider, so the provider may never have been told of the lock (the page that made it closed between the lock landing and its telling). Its pool offer is
  // posted to every provider that sells this way: the one whose Bitcoin lock it answers keeps it (it checks the offer against its own lock and the pool) and
  // claims; the others do not know the swap and answer so. Until the provider claims, it is posted again every few minutes while time to claim is left.
  async function tellRecovered() {
    const store = stores.swaps(RECOVERED.id);
    const recs = (await store.list().catch(() => [])).filter((r) => r.phase === 'offered' && r.evmOffer && !r.toldBy && Number(r.deadline) - now() > (policy.minClaimSecs ?? 3600) && now() - (r.tellAt || 0) >= (policy.tellEverySecs ?? 180));
    if (!recs.length) return;
    let ps = [];
    try { ps = (await providers()).filter((p) => p.e2b); } catch { return; }
    for (const r of recs) {
      await store.put({ ...r, tellAt: now() });
      for (const p of ps) {
        try {
          const a = await makeReverseCounter(reverseCall(p.ref)).postEvmOffer(r.id, r.evmOffer);
          if (a && a.ok) { await store.put({ ...(await store.get(r.id)), toldBy: p.id, tellAt: now() }); break; }
        } catch { /* another provider, or the next look */ }
      }
    }
  }

  async function view(step) {
    const out = [];
    if (step) await tellRecovered().catch(() => {});
    const waits = (await stores.fwd.list()).some((r) => WAITS.has(r.phase)) || (await Promise.all((await revProviders()).map(async (p) => [...(await stores.swaps(p.id).list().catch(() => [])), ...(await stores.quotes(p.id).list().catch(() => [])).filter((q) => q.swapId && !q.settled)]))).flat().some((r) => !r.phase || WAITS.has(r.phase));
    if (waits) await readTip();
    for (const rec of await stores.fwd.list()) {
      let r = rec;
      if (step && !FWD_END.has(rec.phase)) { try { r = await blFor(rec.provider || null).step(rec); } catch { /* the next pass */ } }
      if (step && r.checking && !r.lastError) { r = { ...r, checking: false }; await stores.fwd.put(r); }
      const slow = FWD_END.has(r.phase) ? null : await watch('b2e', r, step, () => blFor(r.provider || null).step(r));
      out.push(withSlow(describeFwd(r, now, tipSeen), slow));
    }
    for (const p of await revProviders()) {
      // the reverse client words its swaps for TAC, so a pass is taken through it and the swaps are then described here from their own records
      if (step) {
        try { await revFor(p).pump(); } catch { /* a provider that cannot be reached: the next pass tries again */ }
        for (const r of await stores.swaps(p.id).list().catch(() => [])) if (r.checking && !r.lastError) await stores.swaps(p.id).put({ ...r, checking: false });
      }
      try {
        for (const r of await stores.swaps(p.id).list()) {
          const slow = REV_END.has(r.phase) ? null : await watch('e2b', r, step, () => revFor(p).el.poke(r));
          out.push(withSlow(describeRev({ ...r, providerName: p.name }, now, tipSeen), slow));
        }
      } catch { /* a store that cannot be read shows nothing */ }
      try { out.push(...(await asked(p))); } catch { /* none */ }
    }
    return groupBatches(out).sort(newest);
  }
  const records = () => view(false);
  const pump = () => tend(() => view(true), () => view(false));

  // A batch found again from the key: the locks of a transaction that holds several are named by its hint, which carries a short fingerprint of each provider's key and not
  // the key (the OP_RETURN is too small for four keys), so they are matched to the keys this page knows: the providers it lists and has met, and the claimer keys of the
  // swaps it kept. A leg is found only if the output holds exactly the script that key makes. Each leg is kept as a swap to refund (as a lone lock found from the key is):
  // what became of it is read from the chain, and a lock nobody took is returned by its timelock.
  async function candidateKeys() {
    const keys = new Set(), add = (k) => { const h = strip(k || ''); if (/^0[23][0-9a-f]{64}$/.test(h)) keys.add(h); };
    for (const r of await stores.fwd.list().catch(() => [])) add(r.counterClaimPub);
    for (const p of await discover().catch(() => [])) { add(p.ref && p.ref.claimPub); add(p.id); }
    for (const k of Object.keys(OWN_PROVIDERS)) add(k);
    return [...keys];
  }
  async function recoverBatches(pages = 12) {
    if (typeof btc.history !== 'function') return 0;
    const kept = await stores.fwd.list(), known = new Set(kept.map((r) => r.id)), held = new Set(kept.filter((r) => r.lock && r.lock.txid).map((r) => `${r.lock.txid}:${r.lock.vout}`));
    const keys = await candidateKeys(), found = [];
    for (const tx of await btc.history(btc.address, pages)) {
      if (!tx.vin || !tx.vin.length || !tx.status || !tx.status.confirmed) continue;
      const when = Number(tx.status.block_time) > 0 ? Math.min(Number(tx.status.block_time), now()) : now();
      const first = { txid: tx.vin[0].txid, vout: tx.vin[0].vout };
      let b;
      try { b = X.recoverBtcBatch({ prims: btc.prims, seed, first, lockerXonly: btc.wallet.xonly, outputs: tx.vout, claimerKeys: keys }); } catch { continue; }
      if (!b) continue;
      const batch = { id: bytesToHex(X.legSwapId(first.txid, first.vout, 0)), n: b.legs.length + b.unknown.length };
      for (const leg of b.legs) {
        if (known.has(leg.swapId) || held.has(`${tx.txid}:${leg.vout}`)) continue;
        const rec = {
          v: 1, role: 'bl', id: leg.swapId, phase: 'refund-wait', why: 'found from the key', created: when, updated: now(), quoteId: null,
          asset: SATS_ASSET, amount: String(leg.value), evmAsset: ETH, evmAmount: '0', counterClaimPub: leg.claimerPub, csvBlocks: leg.csvBlocks, takeSats: 0,
          lock: { txid: tx.txid, vout: leg.vout, value: Number(tx.vout[leg.vout].value) }, noteInputs: [], feeInputs: tx.vin.map((i) => ({ txid: i.txid, vout: i.vout })),
          recovered: true, batch: { ...batch, k: leg.vout },
        };
        known.add(leg.swapId); found.push({ ...rec, checking: true });
      }
    }
    for (const rec of found) await settle(rec, stores.fwd, (r) => blFor(null).step(r));
    return found.length;
  }

  async function recover() {
    const c = makeFastBridgeClient({ lp: noCounter(), btc, evm, store: stores.fwd, seed, pins: { btcAsset: SATS_ASSET, evmAsset: ETH }, policy, now });
    const known = new Map();
    for (const p of await discover().catch(() => [])) if (p.ref && p.ref.claimPub) known.set(strip(p.ref.claimPub), p.ref);
    const fwd = await c.recover({ providerFor: (k) => known.get(strip(k)) || null });
    // (the client hands back its records in words: the record itself is read from the store). Every one is marked as being checked before the first is
    // stepped, so a page that lists the swaps while they are read never shows one as the client left it ('Returning your BTC') before its step has said otherwise.
    const found = [];
    for (const d of fwd) { const rec = await stores.fwd.get(d.id); if (rec) { const r = { ...rec, checking: true }; await stores.fwd.put(r); found.push(r); } }
    for (const rec of found) await settle(rec, stores.fwd, (r) => blFor(r.provider || null).step(r));
    return fwd.length + (await recoverBatches().catch(() => 0)) + (await recoverRev());
  }
  // A record found again from the key is stepped until the chains have said what became of it (a lock the provider took, a take made from another page,
  // a refund, a claim whose BTC is still to take) before it is listed. A step that cannot read the chains leaves it 'Checking' for the next pass.
  async function settle(rec, store, step) {
    await store.put(rec);
    let r = rec;
    for (let i = 0; i < 6; i++) {
      const before = r.phase;
      try { r = await step(r); } catch { return; }
      if (!r || r.lastError) return;
      if (r.phase === before) break;
    }
    await store.put({ ...r, checking: false });
  }
  // e2b: each pool lock of this key carries a memo sealed to it (dapp/fastbridge-evm.js makeOwnLockFinder): a lock no record here holds is made a record again, and its
  // next step reads what became of it (the provider's claim gives t and the BTC is taken; with no claim by the deadline, the ETH is refunded)
  async function recoverRev() {
    if (typeof evm.findOwnLocks !== 'function') return 0;
    const found = await evm.findOwnLocks();
    const known = new Set();
    for (const p of [...(await revProviders()), RECOVERED]) for (const r of await stores.swaps(p.id).list()) known.add(r.id);
    let n = 0;
    for (const m of found) {
      const id = strip(m.swapId);
      if (known.has(id)) continue;
      const rec = recordFromLockMemo({ memo: m, seed, refundXonly: (await evm.refundKey(id)).xonly, claimerPub: btc.wallet.pub, btcAsset: SATS_ASSET, evmAsset: ETH, lockNullifier: evm.lockNullifier, now: now() });
      if (!rec) continue;
      await settle({ ...rec, checking: true }, stores.swaps(RECOVERED.id), (r) => revFor(RECOVERED).el.step(r));
      known.add(id); n++;
    }
    if (n && !(await stores.index.get(RECOVERED.id))) await stores.index.put(RECOVERED);
    return n;
  }

  // The coins a payment to this address made (`txid`), in a block or not yet, still unspent: for a lock started on a payment that has just been sent
  async function arriving(txid) {
    if (!/^[0-9a-f]{64}$/.test(strip(txid))) return [];
    const tx = await btc.fetchTx(strip(txid)).catch(() => null);
    if (!tx || !Array.isArray(tx.vout)) return [];
    const mine = bytesToHex(btc.prims.p2wpkhScript(btc.wallet.pub)), out = [];
    for (const [vout, o] of tx.vout.entries()) {
      if (strip(o.scriptpubkey || '') !== mine || !(Number(o.value) > 546)) continue;
      const spent = await btc.outspend(strip(txid), vout).catch(() => undefined);
      if (spent === null) out.push({ txid: strip(txid), vout, value: Number(o.value) });
    }
    return out;
  }

  // whether a lock of `amount` pool units can be made now (an exact note needs no cut), for a page that shows it before the start refuses
  const covers = async (amount) => (evm.covers ? evm.covers(BigInt(amount)) : (await balances()).eth >= BigInt(amount));
  // For a page that sends the address's own sats: the coins a swap under way holds ("txid:vout", never to be spent elsewhere), and this key's swap locks on Bitcoin
  // (b2e: the lock transaction its record keeps, as hex with the lock's vout; e2b: the provider's lock script it answers), never to be paid to.
  const holdsCoins = async () => [...(await heldCoins())];
  async function lockOutputs() {
    const out = [];
    for (const r of await stores.fwd.list()) if (r.lock && r.lock.revealHex) out.push({ hex: r.lock.revealHex, vout: Number(r.lock.vout || 0) });
    for (const p of [...(await revProviders()), RECOVERED]) for (const r of await stores.swaps(p.id).list().catch(() => [])) if (r.lockSpk) out.push({ spk: strip(r.lockSpk) });
    return out;
  }
  return { providers, reference, balances, covers, quote, start, prepare, checkAgain, arriving, pump, records, recover, heldCoins: holdsCoins, lockOutputs, address: () => ({ btc: btc.address }), claimPub: claimPubHex };
}
