// One press from BTC to cUSD: what the Borrow card's four steps (lock, bond, mint, borrow) come to next, from what the chain says about them.
// This is only the decision. The page (index.html, autoTick) runs the step it names through the card's own step functions, reads the lock again
// and asks again, so a closed tab, a reload or a second browser just picks up where the chain is. The one thing kept is the intent (what to lock,
// at what ratio, which lock is its own); every step is also a button on the card, so a lost intent costs nothing but the carrying on.
//
// Rules the decision keeps:
//  - the BTC is never sent for the person: the first press sends it (a wallet asks), and a lock waits for it to confirm
//  - a lock is made once: a lock that is its own (`intent.lock`) is never made again, and a lock the card already knew (`intent.before`) is never taken for its own
//  - the bond is a wallet confirmation, so it runs only inside a press (`gesture`); everything after it needs no wallet (the relay proves, the key signs)
//  - a step that made no progress is tried again after RETRY_MS, three times, then it stops and says what it last saw
export const RETRY_MS = 5 * 60e3, MAX_FAILS = 3, EXPIRE_MS = 7 * 24 * 3600e3;
const U6 = 10n ** 6n;

export function newIntent({ sats, ratio = 200, until = 'cusd', before = [], now = Date.now() }) {
  return { v: 1, sats: String(sats), ratio: Number(ratio), until, before: [...before], lock: null, at: now, fails: 0, failAt: 0, last: '', stop: null };
}

// The loan at `ratio` percent of the lock's value, the card's own suggestion (a cent's grain), and never closer to the engine's floor than five points:
// the price can move before the loan lands. `usd` is the lock's value in cUSD (8 decimals), `floor` the engine's ratio in basis points.
export function debtFor({ usd, floor = 15000n, ratio = 200 }) {
  usd = BigInt(usd || 0);
  if (usd <= 0n) return 0n;
  const debt = usd * 100n / BigInt(Math.max(100, Math.round(Number(ratio)))) / U6 * U6, cap = usd * 10000n / (BigInt(floor) + 500n) / U6 * U6;
  return debt > cap ? cap : debt;
}

// How far the intent's own lock has got: 0 none, 1 locked, 2 bonded, 3 bonded and proven, 4 minted, 5 borrowed.
export function stageOf({ st, intent, idOf }) {
  const rec = st?.rec;
  if (!rec || !intent) return 0;
  const id = idOf(rec);
  if (intent.lock ? id !== intent.lock : intent.before.includes(id)) return 0;
  return st.borrowed ? 5 : st.minted ? 4 : st.bonded ? (st.reflected ? 3 : 2) : 1;
}

const later = (intent, now) => (intent.failAt && now - intent.failAt < RETRY_MS ? { act: 'wait', why: 'retry', at: intent.failAt + RETRY_MS } : null);

// The next step. `st` is the card's lock state (index.html readBorrow), `pad` the BTC the lock's fees need, `listed` the ids of the key's locks,
// `flight` whether a step of the lock is on its way (an Activity item), `gesture` whether this runs inside a press. Returns { act, ... }:
//   none | stopped | done            nothing to do (stopped says why)
//   lock | bond | mint | borrow      the step to run now (borrow carries the `debt`); pick: follow the intent's lock, which the card is not following
//   ask                              a step that needs a press (the bond)
//   wait                             nothing to do yet, `why` says for what
// `adopt` is the id of the lock the intent has just made its own.
export function autoNext({ st, intent, pad = 0n, idOf, listed = new Set(), flight = false, gesture = false, now = Date.now() }) {
  if (!intent) return { act: 'none' };
  if (intent.stop) return { act: 'stopped', why: intent.stop };
  if (now - intent.at > EXPIRE_MS) return { act: 'stopped', why: 'It ran for a week without finishing.' };
  if (intent.fails >= MAX_FAILS) return { act: 'stopped', why: intent.last || 'A step did not go through.' };
  if (!st) return { act: 'wait', why: 'read' };
  const rec = st.rec, id = rec ? idOf(rec) : null;
  const ours = intent.lock ? id === intent.lock : !!rec && !intent.before.includes(id), adopt = !intent.lock && ours ? id : undefined;
  if (!ours) {
    if (intent.lock) return listed.has(intent.lock) ? { act: 'pick', id: intent.lock } : { act: 'wait', why: 'gone' };
    if (st.sats == null) return { act: 'wait', why: 'read' };
    const need = BigInt(intent.sats) + BigInt(pad), ready = BigInt(st.sats) - BigInt(st.pendingSats || 0);
    if (ready >= need) return later(intent, now) || { act: 'lock' };
    if (BigInt(st.sats) >= need) return { act: 'wait', why: 'confirm' };
    return { act: 'wait', why: 'deposit', short: need - BigInt(st.sats) };
  }
  if (flight) return { act: 'wait', why: 'flight', adopt };
  const bonded = !!st.bonded || !!st.minted;
  if (!bonded) return gesture ? (later(intent, now) || { act: 'bond', adopt }) : { act: 'ask', step: 'bond', adopt };
  if (!st.minted) return st.reflected ? (later(intent, now) || { act: 'mint', adopt }) : { act: 'wait', why: st.height ? 'proof' : 'bitcoin', adopt };
  if (intent.until === 'cbtc' || st.borrowed) return { act: 'done', adopt };
  if (!st.cbtc) return { act: 'wait', why: 'note', adopt };
  const debt = debtFor({ usd: st.usd, floor: st.ratio, ratio: intent.ratio });
  if (!(debt > 0n)) return { act: 'wait', why: 'price', adopt };
  return later(intent, now) || { act: 'borrow', debt, adopt };
}

// What a step that was run came to: progress clears the failures, none counts one and keeps what the step last said.
export function afterStep(intent, { before, after, now = Date.now(), say = '' }) {
  return after > before ? { ...intent, fails: 0, failAt: 0, last: '' } : { ...intent, fails: intent.fails + 1, failAt: now, last: String(say || intent.last || '').slice(0, 200) };
}

// The line the card shows for the intent. `fmt` formats BTC amounts (8 decimals).
export function autoLine(next, intent, { fmt = (v) => String(v), now = Date.now() } = {}) {
  const tail = intent?.until === 'cbtc' ? 'mints cBTC' : 'mints cBTC and borrows cUSD';
  switch (next?.act) {
    case 'stopped': return `Autopilot stopped: ${next.why}`;
    case 'lock': return 'Autopilot is locking your BTC…';
    case 'bond': return 'Autopilot is posting the bond…';
    case 'mint': return 'Autopilot is minting your cBTC…';
    case 'borrow': return 'Autopilot is borrowing your cUSD…';
    case 'pick': return 'Autopilot is opening its lock…';
    case 'ask': return 'Autopilot needs you for the bond: one wallet confirmation, then it carries on by itself.';
    case 'done': return 'Autopilot is done.';
    case 'wait':
      return { read: 'Autopilot is reading your lock…', confirm: 'Autopilot is waiting for your BTC to confirm, then it locks it.',
        deposit: `Autopilot is waiting for ${fmt(next.short)} more BTC at your Bitcoin address, then it locks it.`, gone: 'Autopilot cannot see its lock in your list. Stop it and carry on with the steps.',
        flight: 'Autopilot is waiting for a step on its way to land.', bitcoin: 'Autopilot is waiting for your lock to confirm on Bitcoin.',
        proof: `Autopilot is waiting for Bitcoin’s proof to reach your lock, then it ${tail}. Keep this tab open, or come back: it carries on from here.`,
        note: 'Autopilot is waiting for your cBTC to show up.', price: 'Autopilot is waiting for the BTC price.',
        retry: `Autopilot tries again in ${Math.max(1, Math.ceil((next.at - now) / 60e3))} min.` }[next.why] || 'Autopilot is waiting.';
    default: return '';
  }
}
