// The user's side of the reverse direction (Ethereum -> Bitcoin): the user sends TAC it holds in the pool and takes TAC on Bitcoin. The user is the
// ETHEREUM locker (dapp/fastbridge-el.js): the provider locks a Bitcoin note first (dapp/fastbridge-reverse-provider.js), the user checks that lock on the
// chain, locks a pool note once it has the confirmations the USER wants (a lock reorganised away after the user has locked would cost the user), and
// opens the Bitcoin lock when the provider's claim shows it t. Nothing the user locks is at risk before the provider's lock is confirmed and checked.
//
// The provider never calls the user, so this side keeps asking: `pump()` fetches the provider's lock offer, hands it to the machine, steps every swap,
// and the machine's publish of its pool offer is a POST. Run it while the page is open (as the forward side does), once a pass every few seconds.
//
//   const rc = makeReverseClient({ lp, btc, evm, store, quoteStore, seed, pins, policy, now })
//   lp = makeReverseCounter(call)                     over a transport (method, path, body) -> { status, body}: HTTP, or a board's mailbox
//   rc.quote(amount)       -> the provider's quote for `amount` of the user's private TAC, checked before it is shown
//   rc.start({ quote, coming }) -> asks the provider to lock; { swapId }      coming: a mined deposit still landing (coversWith)
//   rc.pump()              -> one pass: fetch offers, step the swaps; the records, in words
//   rc.records()  rc.describe(rec)
//
//   btc   the user's Bitcoin chain (its wallet is where the Bitcoin note arrives) as the provider side's el needs it: reads of notes, locks, a take
//   evm   the user's pool side: lockOp, refundOp, refundKey, available, findClaim, lockPosition, submit, jobStatus, now, prepare
//   store the swaps (el records, by swap id); quoteStore the quotes the user was given (by quote id): kept apart, since both are listed

import { makeEthereumLocker } from './fastbridge-el.js';
import { SATS_ASSET } from './adaptor-xswap.js';
import { bytesToHex } from './vendor/tacit-deps.min.js';

const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const isHex = (h, n) => new RegExp(`^[0-9a-f]{${n}}$`).test(strip(h));
const big = (v, what) => { try { const b = BigInt(v); if (b < 0n) throw 0; return b; } catch { throw new Error(`the provider's ${what} is not a number`); } };
const TERMINAL = new Set(['done', 'refunded', 'aborted', 'lost']);

export const REVERSE_POLICY = {
  minCsv: 72, maxCsv: 288, maxTakeSats: 30000, quoteMarginSecs: 120, warnFeeBps: 500, maxFeeBps: 9000,
  // the swap as the Ethereum locker keeps it
  evmWindowSecs: 4 * 3600, roundSecs: 600, minClaimSecs: 3600, claimSlackSecs: 7200, refundMarginSecs: 600, maxOfferAgeSecs: 2 * 3600, maxLockFailures: 3,
  // how long the user keeps asking for a lock offer after it asked the provider to lock, and how long a quote stays usable for the swap it started
  offerWaitSecs: 2 * 3600, startGraceSecs: 6 * 3600,
};
// Confirmations the user wants on the provider's lock before it locks its own: more for a larger amount (TAC has 8 places)
export const confsFor = (value) => (BigInt(value) >= 10_000n * 10n ** 8n ? 3 : BigInt(value) >= 1_000n * 10n ** 8n ? 2 : 1);

// ── the transport: the provider's reverse routes over any call(method, path, body) -> { status, body } ──

export function makeReverseCounter(call) {
  const fail = (r, what) => Object.assign(new Error(`${what}: ${r.status}${r.body && (r.body.error || r.body.why) ? ' ' + (r.body.error || r.body.why) : ''}`), { status: r.status });
  const answered = (r, what) => {
    if (r.status === 200 && r.body && typeof r.body.ok === 'boolean') return r.body;
    if (r.status === 429) return { ok: false, retry: true, why: 'the provider is busy' };
    if (r.status === 404 || r.status === 408 || r.status === 425) return { ok: false, retry: true, why: `the provider did not answer (${r.status})` };
    if (r.status >= 400 && r.status < 500 && r.body && (r.body.error || r.body.why)) return { ok: false, retry: !!r.body.retry, why: r.body.error || r.body.why };
    throw fail(r, what);
  };
  return {
    async info() { const r = await call('GET', '/reverse/info'); if (r.status !== 200 || !r.body) throw fail(r, 'the provider did not give its terms'); return r.body; },
    async quote({ amount, claimPub }) {
      const r = await call('POST', '/reverse/quote', { amount: String(amount), claimPub });
      if (r.status === 200 && r.body && r.body.id) return r.body;
      if (r.body && (r.body.error || r.body.why)) throw Object.assign(new Error(String(r.body.error || r.body.why)), { status: r.status, retry: !!r.body.retry });
      throw fail(r, 'no quote');
    },
    async start({ quoteId }) { return answered(await call('POST', '/reverse/start', { quoteId }), 'the provider did not answer the start'); },
    async getOffer(swapId) {
      const r = await call('GET', `/reverse/swap/${swapId}/offer`);
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.body) throw fail(r, 'the provider\'s lock offer could not be read');
      return r.body;
    },
    // the lock offer as soon as the lock is sent (a provider that does not give it early answers 404, and the offer is read once the lock is confirmed)
    async getEarlyOffer(swapId) {
      const r = await call('GET', `/reverse/swap/${swapId}/early-offer`);
      if (r.status !== 200 || !r.body || typeof r.body !== 'object') return null;
      return r.body;
    },
    async postEvmOffer(swapId, evmOffer) { return answered(await call('POST', `/reverse/swap/${swapId}/evm-offer`, { evmOffer }), 'the pool offer was not answered'); },
    async swapStatus(swapId) {
      const r = await call('GET', `/reverse/swap/${swapId}`);
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.body) throw fail(r, 'the swap could not be read');
      return r.body;
    },
  };
}

// A transport over HTTP, for a provider that serves it (the mailbox's is makeMailboxCall in fastbridge-mailbox.js)
export function makeHttpCall({ base, fetchImpl = (...a) => fetch(...a), timeoutMs = 15000 }) {
  const root = () => String(typeof base === 'function' ? base() : base).replace(/\/$/, '');
  return async (method, path, body) => {
    const r = await fetchImpl(root() + path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    let json = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, body: json };
  };
}

// ── the words ──

const STEPS = ['Provider locks Bitcoin', 'Lock your TAC', 'Provider claims', 'Take your Bitcoin'];
const SAYS = {
  accepted: [0, 'Waiting for the Bitcoin lock', 'The provider’s lock is on Bitcoin and needs its confirmations before your TAC is locked.'],
  locking: [1, 'Locking your TAC in the pool', 'Your private TAC is being locked in the pool for the provider.'],
  locked: [1, 'Telling the provider', 'Your TAC is locked. The provider is being told.'],
  offered: [2, 'Waiting for the provider to claim', 'The provider is claiming the TAC you locked. When it does, your Bitcoin is yours to take.'],
  taking: [3, 'Taking your Bitcoin', 'Your TAC on Bitcoin is being taken from the lock.'],
  done: [4, 'Done', 'The TAC is at your Bitcoin address.'],
  refunding: [2, 'Taking your TAC back', 'The provider did not claim in time, so the TAC you locked is coming back to your private balance.'],
  refunded: [4, 'Returned', 'Your TAC came back to your private balance.'],
  aborted: [0, 'Stopped', 'This swap was stopped before anything was lost.'],
  lost: [0, 'Needs a look', 'The provider claimed with a signature that does not give your Bitcoin. Do not close this page.'],
};
export function describe(rec, nowSecs = Math.floor(Date.now() / 1000)) {
  const [at, title, said] = SAYS[rec.phase] || [0, rec.phase, ''];
  const ended = TERMINAL.has(rec.phase);
  // (a swap that has waited ten minutes or more on Ethereum nodes that do not agree says so)
  const detail = !ended && rec.nodesSince != null && nowSecs - rec.nodesSince >= 600 ? `${said} The Ethereum nodes this page reads have not agreed on this swap for a while, so it is read again until two of them do. Nothing is decided on one node’s word, and a refund still goes out at its time.` : said;
  return {
    id: rec.id, phase: rec.phase, title, detail: rec.phase === 'aborted' && rec.why ? `${detail} ${String(rec.why).replace(/\.$/, '')}.` : detail, at, steps: STEPS, ended,
    returned: rec.phase === 'refunded', amount: rec.offer ? String(rec.offer.evm.amount) : '0', receive: rec.offer ? String(rec.offer.btc.value) : '0', created: rec.created,
    lockTxid: rec.lockTxid || null, takeTxid: rec.take ? rec.take.txid : null, error: rec.lastError || null, direction: 'out',
  };
}

// Whether the user's private balance covers a lock of `amount`: a note of exactly that amount is locked as it is, with nothing kept back for a cut (`covers`, where
// the pool side has it), else what is available. `coming` is a deposit of the user's that is mined and is being settled into a note of exactly that many units:
// it covers a lock of exactly its amount, or adds to what is available.
export async function coversWith(evm, amount, coming = null) {
  const a = BigInt(amount);
  if (evm.covers ? await evm.covers(a) : (await evm.available()) >= a) return true;
  const c = coming == null ? 0n : BigInt(coming);
  if (c <= 0n) return false;
  return c === a || (await evm.available()) + c >= a;
}

// ── the user's side as a whole ──

// `confsOf(value)`: the confirmations the user wants on the provider's lock, by its value (default: TAC's). `valueCheck({ evmAmount, btcValue })`: for a pair whose two
// sides are not the same unit (the provider pays sats for pool ETH), the judgement of the amounts that replaces the same-unit one: it throws a reason the page can show, or
// returns { fee (in the user's units), highFee }. Both default to the TAC bridge's own rules, byte for byte.
// `admit({ id, offer })`: a reason not to answer a lock offer from what the page keeps beyond this provider's store (dapp/fastbridge-pair.js: a Bitcoin lock another swap answers), or null
export function makeReverseClient({ lp, btc, evm, store, quoteStore, seed, pins = {}, policy: policyIn = {}, now = () => Math.floor(Date.now() / 1000), confsOf = confsFor, valueCheck = null, admit = null, takePresig = null }) {
  const policy = { ...REVERSE_POLICY, ...policyIn };
  const claimPub = () => bytesToHex(btc.wallet.pub);
  const pinned = (a) => (pins[a] ? strip(pins[a]) : null);
  const asQuote = (r) => ({ ...r, btcValue: BigInt(r.btcValue), evmAmount: BigInt(r.evmAmount), fee: BigInt(r.evmAmount) - BigInt(r.btcValue) });

  // The machine looks its quote up by id; a quote that started a swap stays good for the swap (the lock it waits on takes longer than a quote lasts)
  const quotes = { get: async (id) => { const r = await quoteStore.get(id); return r ? { ...r, validUntil: r.startedAt ? Math.max(r.validUntil, r.startedAt + policy.startGraceSecs) : r.validUntil } : null; } };
  const el = makeEthereumLocker({
    seed, now, store, quotes, btc, evm, admit, requireChecked: true, ...(takePresig ? { takePresig } : {}),
    counter: { publishEvmOffer: async (id, offer) => { const r = await lp.postEvmOffer(id, offer); if (r && r.ok === false) throw new Error(`the provider did not take the pool offer: ${r.why}`); } },
    policy: { minCsv: policy.minCsv, minConfsFor: confsOf, evmWindowSecs: policy.evmWindowSecs, roundSecs: policy.roundSecs, minClaimSecs: policy.minClaimSecs, claimSlackSecs: policy.claimSlackSecs, refundMarginSecs: policy.refundMarginSecs, maxOfferAgeSecs: policy.maxOfferAgeSecs, minAmount: 1n, maxAmount: 10n ** 18n, maxLockFailures: policy.maxLockFailures,
      early: policy.early, preWindowSecs: policy.preWindowSecs, preMinLeftSecs: policy.preMinLeftSecs, preMaxLeftSecs: policy.preMaxLeftSecs, preProveWaitSecs: policy.preProveWaitSecs },
  });

  // The provider's quote for sending `amount` of the user's private TAC, checked before the user sees it: for this key and these assets, the amounts, the
  // timelock, the fee, the fee of the take, and that it does not run out at once.
  async function quote(amount) {
    const want = BigInt(amount);
    const r = await lp.quote({ amount: want, claimPub: claimPub() });
    if (!r || typeof r.id !== 'string' || !isHex(r.btcAsset, 64) || !isHex(r.evmAsset, 64) || !isHex(r.lockerXonly, 64)) throw new Error('the provider\'s quote is not readable');
    for (const k of ['btcAsset', 'evmAsset']) if (pinned(k) && pinned(k) !== strip(r[k])) throw new Error('the provider\'s asset is not the one this page expects');
    if (pinned('lockerPub') && pinned('lockerPub') !== strip(r.lockerPub || '')) throw new Error('the provider\'s key is not the one this page expects');
    if (strip(r.claimPub || '') !== claimPub()) throw new Error('the quote is for another key');
    const evmAmount = big(r.evmAmount, 'amount'), btcValue = big(r.btcValue, 'payout');
    if (evmAmount !== want) throw new Error('the quote is for a different amount');
    const csvBlocks = Number(r.csvBlocks);
    let fee, highFee;
    if (valueCheck) {
      if (btcValue <= 0n) throw new Error('the quote\'s payout is out of range');
      if (!Number.isInteger(csvBlocks) || csvBlocks < policy.minCsv || csvBlocks > policy.maxCsv) throw new Error('the quote\'s timelock is out of range');
      ({ fee, highFee } = valueCheck({ evmAmount, btcValue }));
    } else {
      if (btcValue <= 0n || btcValue > evmAmount) throw new Error('the quote\'s payout is out of range');
      if (!Number.isInteger(csvBlocks) || csvBlocks < policy.minCsv || csvBlocks > policy.maxCsv) throw new Error('the quote\'s timelock is out of range');
      fee = evmAmount - btcValue;
      if (fee * 10000n > evmAmount * BigInt(policy.maxFeeBps)) throw new Error('the quote\'s fee is above the limit this page accepts');
      highFee = fee * 10000n > evmAmount * BigInt(policy.warnFeeBps);
    }
    if (!(Number(r.validUntil) > now() + policy.quoteMarginSecs)) throw new Error('the quote expires too soon to use');
    const takeSats = Number(r.takeSats ?? 0);
    if (!Number.isInteger(takeSats) || (takeSats !== 0 && (takeSats < 546 || takeSats > policy.maxTakeSats))) throw new Error('the quote\'s Bitcoin fee is out of range');
    await quoteStore.put({ ...r, id: r.id, btcAsset: strip(r.btcAsset), evmAsset: strip(r.evmAsset), claimPub: claimPub(), takeSats });
    return { ...asQuote(r), fee, btcAsset: strip(r.btcAsset), evmAsset: strip(r.evmAsset), csvBlocks, takeSats, highFee };
  }

  // The user asks the provider to lock. The user's private TAC covers the amount first (a user who cannot lock would only tie up the provider's note), or will
  // once a deposit already mined lands (`coming`, in the pool's units: see coversWith)
  async function start({ quote: qt, coming = null }) {
    const rec = await quoteStore.get(qt.id);
    if (!rec) throw new Error('unknown quote');
    if (rec.swapId) return { swapId: rec.swapId };
    if (!(Number(rec.validUntil) > now() + policy.quoteMarginSecs)) throw new Error('the quote expired');
    if (!(await coversWith(evm, BigInt(rec.evmAmount), coming))) throw new Error('your private TAC does not cover that amount');
    const a = await lp.start({ quoteId: rec.id });
    if (!a || a.ok === false) throw Object.assign(new Error(`the provider cannot lock that amount${a && a.why ? `: ${a.why}` : ''}`), { retry: !!(a && a.retry) });
    await quoteStore.put({ ...rec, swapId: a.swapId, startedAt: now() });
    return { swapId: a.swapId };
  }

  // While the provider's lock waits for its block (the offer comes after it), what the page can say of it: the lock's txid as the provider gives it (a provider
  // that does not say leaves it unsaid) and its confirmations as the explorers read them, asked at most every `watchEverySecs`. Words only: nothing is decided
  // on it, and the offer is checked on the chain as before.
  async function watchLock(rec) {
    if (rec.watchAt && now() - rec.watchAt < (policy.watchEverySecs ?? 30)) return;
    const patch = { watchAt: now() };
    try {
      if (!rec.lockTxid && lp.swapStatus) { const s = await lp.swapStatus(rec.swapId); if (s && isHex(s.lockTxid || '', 64)) patch.lockTxid = strip(s.lockTxid); }
      const txid = patch.lockTxid || rec.lockTxid;
      if (txid && btc.status) { const st = await btc.status(txid); if (st && Number.isInteger(st.confirmations)) { patch.lockConfs = st.confirmations; if (rec.lockSeenAt == null) patch.lockSeenAt = now(); } }
    } catch { /* said again at the next look */ }
    await quoteStore.put({ ...rec, ...patch });
  }

  // The provider's lock offer while its lock waits for the block (a lock of plain sats, from a provider that gives it early): taken as an early offer, checked
  // against the transaction as the explorers' mempool shows it, so the pool lock is built and proved during the wait (fastbridge-el.js preStep). Nothing is locked
  // before the confirmations. An early offer that is not taken changes nothing: the offer is read once the lock is confirmed, as it always was.
  async function takeEarly(rec) {
    if (policy.early === false || !lp.getEarlyOffer || rec.earlyOff || !pins.btcAsset || strip(rec.btcAsset || '') !== strip(pins.btcAsset) || strip(pins.btcAsset) !== SATS_ASSET) return false;
    if (rec.earlyAt && now() - rec.earlyAt < (policy.earlyEverySecs ?? 15)) return false;
    await quoteStore.put({ ...rec, earlyAt: now() });
    let offer = null;
    try { offer = await lp.getEarlyOffer(rec.swapId); } catch { return false; }
    if (!offer || !offer.btc || strip(offer.btc.lockerXonly || '') !== strip(rec.lockerXonly) || strip(offer.swapId || '') !== strip(rec.swapId)) return false;
    const got = await el.receive({ quoteId: rec.id, offer, early: true });
    if (got.ok) { await quoteStore.put({ ...rec, earlyAt: now(), settled: true }); return true; }
    if (!got.retry) await quoteStore.put({ ...rec, earlyAt: now(), earlyOff: String(got.why || 'not taken').slice(0, 160) });
    return false;
  }

  // One pass: a swap the provider has locked for is handed its lock offer once the provider has one; every swap is stepped.
  async function pump() {
    for (const rec of await quoteStore.list()) {
      if (!rec.swapId || rec.settled) continue;
      if (await store.get(rec.swapId)) { await quoteStore.put({ ...rec, settled: true }); continue; }
      let offer;
      try { offer = await lp.getOffer(rec.swapId); } catch { continue; }
      if (!offer) {
        // no lock offer after all this time: nothing was locked by the user, so there is nothing to take back
        if (now() - rec.startedAt > policy.offerWaitSecs) { await quoteStore.put({ ...rec, settled: true, gaveUp: 'the provider never locked' }); continue; }
        if (await takeEarly(rec)) continue;
        await watchLock(rec);
        continue;
      }
      if (!offer.btc || strip(offer.btc.lockerXonly || '') !== strip(rec.lockerXonly)) { await quoteStore.put({ ...rec, settled: true, gaveUp: 'the lock is not by the provider\'s key' }); continue; }
      const got = await el.receive({ quoteId: rec.id, offer });
      if (got.ok) await quoteStore.put({ ...rec, settled: true });
      else if (!got.retry) await quoteStore.put({ ...rec, settled: true, gaveUp: got.why });
    }
    const out = [];
    for (const rec of await store.list()) out.push(TERMINAL.has(rec.phase) ? rec : await el.step(rec));
    return out.sort((a, b) => b.created - a.created).map((r) => describe(r));
  }

  const records = async () => (await store.list()).sort((a, b) => b.created - a.created).map((r) => describe(r));
  return { quote, start, pump, records, describe, el };
}
