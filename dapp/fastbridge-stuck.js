// Pricing and policy for TAC the regular bridge cannot carry home ("stuck TAC"): a note that left the
// Bitcoin shielded pool, or one with more transfers behind it than the burn proof folds (255). A provider
// that takes such a note over the fast bridge cannot lend that value again on Ethereum; today it either
// refuses every note the proof cannot follow (policy.screen, fastbridge-el.js) or takes any TAC at the
// same fee as clean TAC and eats the loss. This module is the middle way of the stuck TAC bounty
// (docs/STUCK-TAC-BOUNTY.md, entry C): class a lock's notes by what the proof cannot follow, and take a
// stuck class only at a fee that covers its expected haircut. No imports, like fastbridge-price.js, so a
// page, a test and the daemon's image take it alike. Everything here is a pure function of the lineage
// verdicts (burndep-ux.js `lineage`) and the provider's own policy: nothing is read from the chain here,
// and nothing here moves funds.

// The classes a lock can fall in. 'unread' is not a class: it is the absence of one, and is never priced.
export const STUCK_CLASSES = ['clean', 'long', 'pool-exit', 'other'];

// The class of one note from its lineage verdict:
//   { state: 'tracked' }                        the reflection tracks it: it bridges home
//   { state: 'traced', hops }                   the proof follows its history to the etch
//   { state: 'long', hops, max }                more transfers than the proof folds: it cannot go home,
//                                               but it is ordinary TAC on Bitcoin and trades there
//   { state: 'unprovable', through }            the proof cannot follow it at all. `through` names what
//                                               stopped it: 'shielded' (a spend out of the shielded pool,
//                                               opcode 0x6c/0x6d), 'pool' (a swap, LP, harvest or farm
//                                               trade), 'arrived' (minted by a cross-out from Ethereum),
//                                               'other', or null when the trace could not name it
//   { state: 'unread' }                         the history could not be read just now
// A verdict of any other shape is read as 'unread': a class is never guessed.
export function classOfVerdict(v) {
  if (!v || typeof v.state !== 'string') return 'unread';
  switch (v.state) {
    case 'tracked':
    case 'traced': return 'clean';
    case 'long': return 'long';
    case 'unprovable': return v.through === 'shielded' ? 'pool-exit' : 'other';
    default: return 'unread';
  }
}

// A provider's policy for stuck TAC. Every field is the provider's own, read from its own config, and a
// policy that names nothing takes nothing stuck (see addBpsForClass): the defaults below are the entry's
// suggested starting point, not a price anyone is given.
//
//   haircutBps   the expected haircut of a class, in hundredths of a percent of face value: what the
//                provider expects to lose turning that TAC back into value — the discount on a sale on
//                the Bitcoin order book, the wait while it sells, and the chance it does not sell at
//                all, in one number. The suggested values are assumptions, stated as such in the
//                write-up: stuck TAC still trades on Bitcoin, so the haircut is a liquidity discount,
//                not a write-off; a provider sets its own from its own book.
//   maxAddBps    a class whose break-even add-on would pass this is refused, not priced: past it the
//                fee would eat the bridge (a bridger's page flags a fee over 5% as high and accepts at
//                most 90%, fastbridge-client.js), and a provider may set its own ceiling lower.
//   refuse       classes refused at any price. A provider that wants today's screen for one class and
//                pricing for the rest names the one here.
export const DEFAULT_STUCK_POLICY = {
  haircutBps: { clean: 0, long: 500, 'pool-exit': 1000, other: 1500 },
  maxAddBps: 2000,
  refuse: [],
};

// The class of a whole lock, from the verdicts of the notes it spends (an array of verdicts, or a Map of
// them as `lineage` returns). A lock is taken whole or not at all, and its payout is one amount, so the
// lock is priced by its worst note: the class with the largest haircut under the policy. One note that
// could not be read makes the whole lock 'unread' — a lock priced on a guess costs the same as one
// priced wrong, so it is not priced at all. An empty lock is 'clean' (it spends nothing).
export function classOfLock(verdicts, policy = DEFAULT_STUCK_POLICY) {
  const list = verdicts instanceof Map ? [...verdicts.values()] : [...(verdicts || [])];
  let worst = 'clean';
  for (const v of list) {
    const c = classOfVerdict(v);
    if (c === 'unread') return 'unread';
    if ((policy.haircutBps[c] ?? 0) > (policy.haircutBps[worst] ?? 0)) worst = c;
  }
  return worst;
}

// The add-on fee, in bps of the amount, at which taking a class breaks even in expectation. The provider
// receives the lock's amount of stuck TAC and pays out the amount less its fee in pool TAC, so what it
// keeps must cover what the stuck TAC is expected to lose: fee >= haircut, in the same units, with no
// grossing up. (The base fee is the provider's pay for the bridge itself and is not counted here: the
// add-on must carry the haircut alone, or a busy provider subsidises stuck TAC out of its clean margin.)
// Returns null when the class is not taken at any price this policy allows: it is named in `refuse`, the
// policy names no haircut for it, or its break-even add-on passes `maxAddBps`. Null is a refusal, never
// a zero: a class the policy does not name is not silently taken free.
export function addBpsForClass(policy, cls) {
  if (!policy || !STUCK_CLASSES.includes(cls)) return null;
  if ((policy.refuse || []).includes(cls)) return null;
  const h = policy.haircutBps ? policy.haircutBps[cls] : undefined;
  if (!Number.isInteger(h) || h < 0 || h >= 10000) return null;
  if (h > (policy.maxAddBps ?? 0)) return null;
  return h;
}

// The terms a lock of a class is quoted at: the provider's own terms with the class's add-on on the
// rate. The flat part is not raised — it pays for the take, which a stuck note costs no more of than a
// clean one. Null when the class is not taken (addBpsForClass), so a caller that cannot price a lock
// refuses it with the reason below instead of quoting it at the base fee. Terms without a stuck policy
// anywhere in them are untouched by this: a provider that does not set one is never given adjusted terms.
export function termsForClass(terms, policy, cls) {
  const add = addBpsForClass(policy, cls);
  if (add === null) return null;
  return { ...terms, feeBps: (terms.feeBps ?? 0) + add };
}

// Why a lock is not taken, in the shape a provider's `policy.screen` returns ({ why, retry } to refuse a
// lock, null to go on, as lineageScreen in fast/wire.js builds it) — from verdicts alone, so the page's
// provider, the daemon and a test all judge a lock the same way. An unread note is a retry, as in the
// screen today; a class the policy will not price is a refusal that says which class and why.
export function screenVerdicts(verdicts, policy = DEFAULT_STUCK_POLICY) {
  const cls = classOfLock(verdicts, policy);
  if (cls === 'unread') return { why: 'the history of a note could not be read just now', retry: true };
  if (addBpsForClass(policy, cls) === null) {
    return { why: `this provider does not take ${cls} TAC at a fee that covers its expected loss` };
  }
  return null;
}

// The price of a lock, whole: its class, the add-on, and the terms it is quoted at. One result for the
// three questions a provider asks of a lock — what is it, what does it cost, and is it taken at all — so
// the quote, the screen and the panel cannot disagree. { ok: false, why, retry? } when it is not taken.
export function priceLock(verdicts, policy, terms) {
  const refused = screenVerdicts(verdicts, policy);
  if (refused) return { ok: false, ...refused };
  const cls = classOfLock(verdicts, policy);
  return { ok: true, cls, addBps: addBpsForClass(policy, cls), terms: termsForClass(terms, policy, cls) };
}
