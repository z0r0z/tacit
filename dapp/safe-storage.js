// A Storage that never throws into the page and never lets a full origin stop what it is doing. Storage is a convenience: a write that fails (the origin's quota,
// a blocked or private window) is kept in memory for this visit, after the caches that can be made again were cleared to make room; a read that fails is a miss.
//
//   const store = guardedStorage(localStorage, { regenerable: ['tacit-pair-market-v1', 'tacit-market-last-v1', 'tacit-pool-rpc-'] })
//
// `regenerable`: key prefixes of what the page can read again (prices, node health, scan caches). Only these are ever cleared, biggest first; nothing else (swap records,
// keys, wallet state) is touched. No imports: a page and a test take it alike.

export function guardedStorage(base, { regenerable = [] } = {}) {
  const mem = new Map();
  const live = () => { try { return base && typeof base.getItem === 'function' ? base : null; } catch { return null; } };
  // an entry of `regenerable` is a key prefix, or a function (key, value) -> whether that entry can be made again (it reads the value: a quote not yet started can, one a swap record names cannot)
  const isRegen = (k, v) => regenerable.some((p) => (typeof p === 'function' ? !!p(String(k), v) : String(k).startsWith(p)));
  const keys = () => { const b = live(), out = []; try { for (let i = 0; b && i < b.length; i++) out.push(b.key(i)); } catch { /* none */ } return out.filter((k) => k != null); };
  // clear the biggest regenerable entries until `need` characters are free (or none are left), and say whether any went
  const evict = (need) => {
    const b = live(); if (!b) return false;
    const all = keys().map((k) => { let v = ''; try { v = b.getItem(k) || ''; } catch { /* unread */ } return [k, v.length, v]; }).filter(([k, , v]) => { try { return isRegen(k, v); } catch { return false; } }).sort((x, y) => y[1] - x[1]);
    let freed = 0;
    for (const [k, n] of all) { try { b.removeItem(k); freed += n; } catch { /* stays */ } if (freed >= need) break; }
    return freed > 0;
  };
  return {
    getItem(k) { try { const b = live(); const v = b ? b.getItem(k) : null; return v != null ? v : (mem.has(k) ? mem.get(k) : null); } catch { return mem.has(k) ? mem.get(k) : null; } },
    setItem(k, v) {
      const s = String(v), b = live();
      if (b) {
        for (let tries = 0; tries < 2; tries++) {
          try { b.setItem(k, s); mem.delete(k); return; } catch { if (tries === 0 && !evict(s.length)) break; }
        }
      }
      mem.set(k, s);                                    // (this visit only)
    },
    removeItem(k) { mem.delete(k); try { const b = live(); if (b) b.removeItem(k); } catch { /* stays */ } },
    key(i) { const all = [...new Set([...keys(), ...mem.keys()])]; return i < all.length ? all[i] : null; },
    get length() { return new Set([...keys(), ...mem.keys()]).size; },
    clear() { mem.clear(); try { const b = live(); if (b) b.clear(); } catch { /* stays */ } },
  };
}
