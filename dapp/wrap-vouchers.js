// Wraps proved ahead of time, kept in this browser until they are sent. A wrap's proof binds only the asset, the amount and the
// note commitment (no root, no deadline, no price), so one proved now deposits and settles in one router transaction whenever it
// is sent: a wrap whose amount the vouchers on hand make up goes out with no proving wait at all. A voucher holds nothing secret
// (its note is the key's, at an index the wrap index hint already moved past, and its memo opens it), so losing one loses only
// the proving time; sent by anyone, it can only fund the key's own note.
//
// A voucher: { ticker, amount (base units, decimal string), index, commit, depositId, leaf, assetId, at, status: 'proving' | 'ready',
// by ('device' | 'relay' | 'pool'), job? (the proving job, to pick up after a reload), publicValues?, proof?, memos? }. Every proof is
// checked to be for its own note (confidential-pool-ux.js wrapProofFits) before it is kept.
//
// A full store must not lose a proof quietly. A write the browser refuses first makes room (the vouchers of other keys, the oldest
// first) and tries again; if it is still refused, the list is kept in memory for as long as the page lives, so a proof that was paid
// for is still found at the press. With no storage at all (a private window) the vouchers live in memory the same way.

const KEY = 'tacit-wrap-vouchers-v1:';

export function makeVouchers({ storage = globalThis.localStorage } = {}) {
  const mem = new Map();   // pub → list, while the browser refuses to hold it
  const read = (pub) => {
    if (mem.has(pub)) return mem.get(pub);
    try { return JSON.parse(storage.getItem(KEY + pub) || '[]') || []; } catch { return []; }
  };
  // Frees the vouchers of the other key that was written to least recently. A key's own are what this page is for, so they stay.
  // → whether anything was freed.
  function makeRoom(pub) {
    try {
      const others = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k || !k.startsWith(KEY) || k === KEY + pub) continue;
        let list = [];
        try { list = JSON.parse(storage.getItem(k) || '[]') || []; } catch { /* unreadable: it goes first */ }
        others.push({ k, at: list.reduce((m, v) => Math.max(m, Number(v?.at) || 0), 0) });
      }
      if (!others.length) return false;
      others.sort((a, b) => a.at - b.at);
      storage.removeItem(others[0].k);
      return true;
    } catch { return false; }   // the storage cannot even be walked
  }
  function write(pub, list) {
    const save = () => { storage.setItem(KEY + pub, JSON.stringify(list)); mem.delete(pub); };
    try { save(); return; } catch { /* full, or refused */ }
    for (let i = 0; i < 4 && makeRoom(pub); i++) { try { save(); return; } catch { /* more room */ } }
    // Still refused: the page keeps the whole list, and the stored copy keeps as much of it as fits, the ones not made yet and the oldest
    // going first (a proof that was paid for, and the newest, is the last to go).
    const order = list.slice().sort((x, y) => (x.status === 'ready') - (y.status === 'ready') || (Number(x.at) || 0) - (Number(y.at) || 0));
    for (let i = 1; i <= order.length; i++) { try { storage.setItem(KEY + pub, JSON.stringify(order.slice(i))); break; } catch { /* fewer */ } }
    mem.set(pub, list);
  }
  const list = (pub, ticker = null, status = null) => read(pub).filter((v) => (!ticker || v.ticker === ticker) && (!status || v.status === status));

  // The ready vouchers that add up to exactly `amount`, fewest first; null when none do. A handful at most, so it is searched whole.
  function pick(pub, ticker, amount) {
    const want = BigInt(amount), ready = list(pub, ticker, 'ready').sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1)).slice(0, 16);
    let best = null;
    const walk = (i, left, taken) => {
      if (left === 0n) { if (!best || taken.length < best.length) best = taken.slice(); return; }
      if (i >= ready.length || left < 0n || (best && taken.length >= best.length - 1)) return;
      const v = BigInt(ready[i].amount);
      if (v <= left) { taken.push(ready[i]); walk(i + 1, left - v, taken); taken.pop(); }
      walk(i + 1, left, taken);
    };
    walk(0, want, []);
    return best;
  }

  return {
    list,
    pick,
    put(pub, v) { write(pub, [...read(pub).filter((x) => x.depositId !== v.depositId), v]); },
    // A wrap proved and then not sent, kept as a ready voucher: { built, proven } as the pool module's proveWrap returns them.
    keep(pub, ticker, { built, proven }) {
      this.put(pub, { ticker, amount: String(built.amount), index: built.index, commit: built.commit, depositId: built.depositId, leaf: built.leaf,
        assetId: built.wrapArgs.assetId, at: Date.now(), status: 'ready', publicValues: proven.publicValues, proof: proven.proof, memos: proven.memos });
    },
    drop(pub, depositId) { write(pub, read(pub).filter((x) => x.depositId !== depositId)); },
    // The proof a voucher carries, as the pool module's wrapSettleCall takes a built wrap and its proof.
    call(v) {
      return {
        built: { amount: v.amount, commit: v.commit, depositId: v.depositId, index: v.index, wrapArgs: { assetId: v.assetId } },
        proven: { publicValues: v.publicValues, proof: v.proof, memos: v.memos },
      };
    },
  };
}
