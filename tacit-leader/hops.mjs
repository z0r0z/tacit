// Hops the leader owes the confidential pool. A block that lands a hop only records it (TacitBlocks.hops); the TAC reaches the pool when anyone calls
// sendHop / sendHops. The leader does, and keeps what it owes in a file until the contract says each one is sent on, so a send that failed (a node a block
// behind refuses the estimate), a restart, a block another leader landed, or a node call that threw in between does not leave one waiting for good.
// Pure but for the calls it is given, so tested: tests/tacit-leader-hops.test.mjs.
import { keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { bytesOf, hexOf, encode } from './abi.mjs';

const HOP_LEN = 96;                                        // a landed hop in a block's list: asset ‖ value ‖ commit
const RETRY_FIRST = 10_000, RETRY_MAX = 10 * 60_000;       // a failed send is tried again after 10 s, doubling to 10 minutes
const SENT_REST = 120_000;                                 // after a send, the contract is asked again no sooner than this (a node may still be a block behind)

/// The hops a block's list holds: [{ value (decimal string), commit }].
export function hopsIn(list) {
  const b = bytesOf(list || '0x'), out = [];
  for (let i = 0; i + HOP_LEN <= b.length; i += HOP_LEN) {
    out.push({ value: BigInt(hexOf(b.subarray(i + 32, i + 64))).toString(), commit: hexOf(b.subarray(i + 64, i + 96)) });
  }
  return out;
}

/// What TacitBlocks.hops(bytes32) is keyed by: keccak256(abi.encode(value, commit)).
export const hopKey = (h) => hexOf(keccak_256(encode(['uint256', 'bytes32'], [BigInt(h.value), h.commit])));

/// What is owed, kept in a file (`read` gives its text or null, `write` replaces it). An item: { key, value, commit, at (the time the leader may first send
/// it), height?, tries?, retryAt?, sent?, refused? }.
export function makeHopLedger({ read, write }) {
  let list = null;
  const items = () => {
    if (!list) {
      try { const j = JSON.parse(read() || '[]'); list = Array.isArray(j) ? j.filter((h) => h && typeof h.key === 'string') : []; } catch { list = []; }
    }
    return list;
  };
  const save = () => { try { write(JSON.stringify(items())); } catch { /* kept in memory; the next change writes it again */ } };
  return {
    items,
    /// Takes the hops not owed already; each may be sent from `at` on. → how many were new.
    owe(hops, { at, height = null }) {
      let n = 0;
      for (const h of hops) {
        const key = hopKey(h);
        if (items().some((x) => x.key === key)) continue;
        items().push({ key, value: String(h.value), commit: h.commit, at, ...(height != null ? { height } : {}) });
        n++;
      }
      if (n) save();
      return n;
    },
    drop(key) { const i = items().findIndex((x) => x.key === key); if (i >= 0) { items().splice(i, 1); save(); } },
    patch(key, p) { const h = items().find((x) => x.key === key); if (h) { Object.assign(h, p); save(); } },
  };
}

const said = (e) => String(e?.message || e).slice(0, 200);

/// One pass over what is owed. `waiting(h)`: how many of that hop the contract still holds (0: it was sent on, by anyone, and is dropped). `sendOn(group)`:
/// sends a group of hops in one transaction and gives the keys of any the pool refused (it takes a commitment once, so one it refused stays with the
/// contract and is never sent again); it throws if the transaction could not be made. A group that throws is tried one by one, and a hop that still
/// fails is tried again after a rest that doubles each time.
export async function sweepHops({ ledger, waiting, sendOn, now = Date.now(), log = () => {}, batch = 16 }) {
  const due = ledger.items().filter((h) => !h.refused && h.at <= now && (h.retryAt || 0) <= now);
  if (!due.length) return { sent: 0, left: 0 };
  const live = [];
  for (const h of due) {
    let n;
    try { n = await waiting(h); } catch (e) { log({ hopUnread: h.commit, error: said(e) }); continue; }
    if (BigInt(n) === 0n) { ledger.drop(h.key); if (h.sent) log({ hopSentOn: h.commit, value: h.value }); } else live.push(h);
  }
  let sent = 0;
  const fail = (h, e) => {
    const tries = (h.tries || 0) + 1;
    ledger.patch(h.key, { tries, retryAt: now + Math.min(RETRY_MAX, RETRY_FIRST * 2 ** (tries - 1)) });
    log({ hopFailed: h.commit, value: h.value, tries, error: said(e) });
  };
  const done = (group, refused) => {
    for (const h of group) {
      if (refused.includes(h.key)) { ledger.patch(h.key, { refused: true }); log({ hopRefused: h.commit, value: h.value }); } else { sent++; ledger.patch(h.key, { sent: now, retryAt: now + SENT_REST }); }
    }
  };
  for (let i = 0; i < live.length; i += batch) {
    const group = live.slice(i, i + batch);
    try { done(group, (await sendOn(group)) || []); } catch (e) {
      if (group.length === 1) { fail(group[0], e); continue; }
      for (const h of group) { try { done([h], (await sendOn([h])) || []); } catch (x) { fail(h, x); } }
    }
  }
  return { sent, left: ledger.items().filter((h) => !h.refused).length };
}
