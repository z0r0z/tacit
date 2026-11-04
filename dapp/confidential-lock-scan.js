
const SELECTOR_SETTLE = '717fd7f2';
const SELECTOR_RELAY_SETTLE = 'fcccb833';
const SELECTOR_RELAY_SETTLE_SEEDED = 'e2b28725';
const SELECTOR_SETTLE_WITH_TIP = '70b16a7d';

const READ_AHEAD = 6;
const MAINNET_POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const MAINNET_RELAYER = '0x000000009C28617AC88B52Eae5EFaAcdD4aC34c3';

export function makeConfidentialLockScan({ pool }) {
  const strip0x = (h) => String(h == null ? '' : h).replace(/^0x/, '');
  const hexWord = (data, byteOff) => (data.slice(byteOff * 2, byteOff * 2 + 64) || '').padEnd(64, '0');
  const u256At = (data, byteOff) => BigInt('0x' + hexWord(data, byteOff));

  function decodeSettleCalldata(inputHex) {
    const data = strip0x(inputHex).slice(8);
    const readBytes = (byteOff) => {
      const len = Number(u256At(data, byteOff));
      const start = (byteOff + 32) * 2;
      return '0x' + data.slice(start, start + len * 2).padEnd(len * 2, '0');
    };
    const offPv = Number(u256At(data, 0));
    const offProof = Number(u256At(data, 32));
    const offMemos = Number(u256At(data, 64));
    const publicValues = readBytes(offPv);
    const proof = readBytes(offProof);
    const count = Number(u256At(data, offMemos));
    const memos = [];
    for (let i = 0; i < count; i++) {
      const rel = Number(u256At(data, offMemos + 32 + i * 32));
      memos.push(readBytes(offMemos + 32 + rel));
    }
    return { publicValues, proof, memos };
  }

  function decodeSettleTuple(data, byteOff) {
    const local = data.slice(byteOff * 2);
    const readBytes = (o) => {
      const len = Number(u256At(local, o));
      const start = (o + 32) * 2;
      return '0x' + local.slice(start, start + len * 2).padEnd(len * 2, '0');
    };
    const offPv = Number(u256At(local, 0));
    const offProof = Number(u256At(local, 32));
    const offMemos = Number(u256At(local, 64));
    const publicValues = readBytes(offPv);
    const proof = readBytes(offProof);
    const count = Number(u256At(local, offMemos));
    const memos = [];
    for (let i = 0; i < count; i++) {
      const rel = Number(u256At(local, offMemos + 32 + i * 32));
      memos.push(readBytes(offMemos + 32 + rel));
    }
    return { publicValues, proof, memos };
  }

  function decodeSettleCallArray(data, headByteOff) {
    const arrOff = Number(u256At(data, headByteOff));
    const count = Number(u256At(data, arrOff));
    const out = [];
    for (let i = 0; i < count; i++) {
      const elOff = Number(u256At(data, arrOff + 32 + i * 32));
      out.push(decodeSettleTuple(data, arrOff + 32 + elOff));
    }
    return out;
  }

  function decodeRelaySettleCalldata(inputHex) {
    const raw = strip0x(inputHex);
    const selector = raw.slice(0, 8).toLowerCase();
    const data = raw.slice(8);
    if (selector === SELECTOR_RELAY_SETTLE) return decodeSettleCallArray(data, 0);
    if (selector === SELECTOR_RELAY_SETTLE_SEEDED) return decodeSettleCallArray(data, 32);
    throw new Error(`decodeRelaySettleCalldata: unrecognized selector 0x${selector}`);
  }

  function decodeNestedSettles(inputHex) {
    const raw = strip0x(inputHex).toLowerCase();
    const out = [];
    for (let i = raw.indexOf(SELECTOR_SETTLE, 8); i >= 0; i = raw.indexOf(SELECTOR_SETTLE, i + 1)) {
      if (i % 2) continue;
      const data = raw.slice(i + 8);
      const size = BigInt(Math.floor(data.length / 2));
      const fits = (off) => off + 32n <= size && off + 32n + u256At(data, Number(off)) <= size;
      const heads = [0, 32, 64].map((o) => u256At(data, o));
      if (heads.some((h) => h + 32n > size)) continue;
      if (!fits(heads[0]) || !fits(heads[1])) continue;
      const count = u256At(data, Number(heads[2]));
      if (heads[2] + 32n + count * 32n > size) continue;
      let memosFit = true;
      for (let k = 0n; k < count && memosFit; k++) memosFit = fits(heads[2] + 32n + u256At(data, Number(heads[2] + 32n + k * 32n)));
      if (!memosFit) continue;
      try { out.push(decodeSettleCalldata('0x' + raw.slice(i))); } catch { }
    }
    return out;
  }

  function decodeSettleCalls(inputHex) {
    const selector = strip0x(inputHex).slice(0, 8).toLowerCase();
    let calls, direct = true;
    try {
      if (selector === SELECTOR_SETTLE) calls = [decodeSettleCalldata(inputHex)];
      else if (selector === SELECTOR_RELAY_SETTLE || selector === SELECTOR_RELAY_SETTLE_SEEDED) calls = decodeRelaySettleCalldata(inputHex);
      else if (selector === SELECTOR_SETTLE_WITH_TIP) { direct = false; calls = [decodeSettleCalldata(inputHex)]; }
      else { direct = false; calls = decodeNestedSettles(inputHex); }
    } catch { return null; }
    return calls && calls.length ? { calls, direct } : null;
  }

  function readBytes32Array(data, headByteOff) {
    const arrOff = Number(u256At(data, headByteOff));
    const count = Number(u256At(data, arrOff));
    // a count that is larger than the bytes there are is not an array: it is never allocated (public values inside any calldata are read here)
    if (!Number.isSafeInteger(arrOff) || !Number.isSafeInteger(count) || arrOff < 0 || (arrOff + 32 + count * 32) * 2 > data.length) throw new Error('public values: an array does not fit its bytes');
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = '0x' + hexWord(data, arrOff + 32 + i * 32);
    return out;
  }

  function decodePublicValuesLockFields(publicValuesHex) {
    const outer = strip0x(publicValuesHex);
    const structOff = Number(u256At(outer, 0)) * 2;
    const data = outer.slice(structOff);
    const nullifiers = readBytes32Array(data, 3 * 32);
    const leaves = readBytes32Array(data, 4 * 32);
    const lockSetRoot = '0x' + hexWord(data, 16 * 32);
    const lockLeaves = readBytes32Array(data, 17 * 32);
    return { leaves, leavesCount: leaves.length, lockSetRoot, lockLeaves, nullifiers };
  }

  // The adaptor-swap fields of a settle's public values: what a lock appended, what a claim or refund spent, and
  // each claim's completed kernel s (the value the claimed lock's counterparty reads t from).
  function decodePublicValuesAdaptorFields(publicValuesHex) {
    const outer = strip0x(publicValuesHex);
    const data = outer.slice(Number(u256At(outer, 0)) * 2);
    return {
      nullifiers: readBytes32Array(data, 3 * 32),
      leaves: readBytes32Array(data, 4 * 32),
      deadline: Number(u256At(data, 15 * 32)),
      lockSetRoot: '0x' + hexWord(data, 16 * 32),
      lockLeaves: readBytes32Array(data, 17 * 32),
      lockNullifiers: readBytes32Array(data, 18 * 32),
      adaptorClaimS: readBytes32Array(data, 19 * 32),
      refundNotBefore: Number(u256At(data, 20 * 32)),
    };
  }

  async function scanLockLeaves({ events, getTxInput, getTx, getLockState, strict = false, poolAddress = MAINNET_POOL, relayerAddress = MAINNET_RELAYER }) {
    const sameArray = (a, b) => a.length === b.length && a.every((x, i) => String(x).toLowerCase() === String(b[i]).toLowerCase());
    const poolTo = String(poolAddress).toLowerCase();
    const relayerTo = String(relayerAddress).toLowerCase();

    async function callsOf(txHash) {
      let input, to;
      try {
        if (getTx) { const tx = await getTx(txHash); input = tx && tx.input; to = tx && tx.to; }
        else input = await getTxInput(txHash);
      } catch { return null; }
      if (!input) return null;
      const selector = strip0x(input).slice(0, 8).toLowerCase();
      let calls, direct = true;
      if (selector === SELECTOR_SETTLE) {
        try { calls = [decodeSettleCalldata(input)]; } catch { return null; }
      } else if (selector === SELECTOR_RELAY_SETTLE || selector === SELECTOR_RELAY_SETTLE_SEEDED) {
        try { calls = decodeRelaySettleCalldata(input); } catch { return null; }
      } else if (selector === SELECTOR_SETTLE_WITH_TIP) {
        direct = false;
        try { calls = [decodeSettleCalldata(input)]; } catch { return null; }
      } else {
        direct = false;
        calls = decodeNestedSettles(input);
        if (!calls.length) return null;
      }
      const trusted = direct && (!getTx || String(to || '').toLowerCase() === (selector === SELECTOR_SETTLE ? poolTo : relayerTo));
      return { calls, trusted };
    }

    let found;
    if ((events || []).some((e) => e && e.type === 'LockLeavesInserted')) {
      const byFirst = new Map();
      for (const e of events) {
        if (!e || e.type !== 'LockLeavesInserted' || !Array.isArray(e.lockLeaves) || !e.lockLeaves.length) continue;
        const first = Number(e.firstLockIndex);
        const prior = byFirst.get(first);
        if (prior) {
          if (!sameArray(prior.lockLeaves, e.lockLeaves)) throw new Error(`stealth lock stream: two LockLeavesInserted events disagree at lock index ${first}`);
          continue;
        }
        byFirst.set(first, e);
      }
      found = [];
      const cache = new Map();
      const firsts = [...byFirst.keys()].sort((a, b) => a - b);
      if (firsts.every((first, i) => first === (i ? firsts[i - 1] + byFirst.get(firsts[i - 1]).lockLeaves.length : 0))) {
        const queue = [...new Set(firsts.map((first) => byFirst.get(first).txHash).filter(Boolean))];
        await Promise.all(Array.from({ length: Math.min(READ_AHEAD, queue.length) }, async () => {
          for (let h; (h = queue.shift()) !== undefined;) cache.set(h, await callsOf(h));
        }));
      }
      let next = 0;
      for (const first of firsts) {
        const e = byFirst.get(first);
        if (first !== next) throw new Error(`stealth lock stream is not contiguous: expected lock index ${next}, found ${first} (tx ${e.txHash}) — a LockLeavesInserted log was missed`);
        next += e.lockLeaves.length;
        const candidates = e.lockLeaves.map(() => []);
        if (e.txHash) {
          if (!cache.has(e.txHash)) cache.set(e.txHash, await callsOf(e.txHash));
          const info = cache.get(e.txHash);
          for (const decoded of (info && info.calls) || []) {
            let fields;
            try { fields = decodePublicValuesLockFields(decoded.publicValues); } catch { continue; }
            if (!sameArray(fields.lockLeaves, e.lockLeaves) || decoded.memos.length !== fields.leavesCount + fields.lockLeaves.length) continue;
            const tail = decoded.memos.slice(fields.leavesCount);
            e.lockLeaves.forEach((_, i) => {
              const m = tail[i];
              if (m != null && !candidates[i].some((c) => String(c).toLowerCase() === String(m).toLowerCase())) candidates[i].push(m);
            });
          }
        }
        found.push({ txHash: e.txHash, trusted: true, lockLeaves: e.lockLeaves, lockMemos: candidates.map((c) => (c.length ? c[0] : null)), lockMemoCandidates: candidates });
      }
    } else {
      const groups = new Map();
      for (const e of events || []) {
        if (!e || !e.txHash) continue;
        let g = groups.get(e.txHash);
        if (!g) {
          g = { txHash: e.txHash, blockNumber: e.blockNumber, logIndex: e.logIndex, leavesEvents: [], nullifierEvents: [] };
          groups.set(e.txHash, g);
        } else {
          g.blockNumber = Math.min(g.blockNumber, e.blockNumber);
          g.logIndex = Math.min(g.logIndex, e.logIndex);
        }
        if (e.type === 'LeavesInserted') g.leavesEvents.push({ leaves: e.leaves || [], memos: e.memos || [] });
        else if (e.type === 'NullifiersSpent') g.nullifierEvents.push({ nullifiers: e.nullifiers || [] });
      }
      const rows = [...groups.values()].sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex));
      found = [];
      for (const g of rows) {
        const info = await callsOf(g.txHash);
        if (!info) continue;
        const usedLeavesEvent = new Set();
        const usedNullifierEvent = new Set();
        for (const decoded of info.calls) {
          let fields;
          try { fields = decodePublicValuesLockFields(decoded.publicValues); } catch { continue; }
          if (!fields.lockLeaves.length) continue;
          const ordinaryMemos = decoded.memos.slice(0, fields.leavesCount);
          const tail = decoded.memos.slice(fields.leavesCount);
          let landed = false;
          if (fields.leaves.length) {
            for (let i = 0; i < g.leavesEvents.length && !landed; i++) {
              if (usedLeavesEvent.has(i)) continue;
              const ev = g.leavesEvents[i];
              if (sameArray(ev.leaves, fields.leaves) && (sameArray(ev.memos, decoded.memos) || sameArray(ev.memos, ordinaryMemos))) { landed = true; usedLeavesEvent.add(i); }
            }
          } else if (fields.nullifiers.length) {
            for (let i = 0; i < g.nullifierEvents.length && !landed; i++) {
              if (usedNullifierEvent.has(i)) continue;
              if (sameArray(g.nullifierEvents[i].nullifiers, fields.nullifiers)) { landed = true; usedNullifierEvent.add(i); }
            }
          }
          if (!landed) continue;
          const lockMemos = fields.lockLeaves.map((_, i) => (tail[i] != null ? tail[i] : null));
          found.push({ txHash: g.txHash, trusted: info.trusted, lockLeaves: fields.lockLeaves, lockMemos, lockMemoCandidates: lockMemos.map((m) => (m != null ? [m] : [])) });
        }
      }
    }

    const build = (list) => {
      const tree = new pool.Tree();
      for (const c of list) for (const leaf of c.lockLeaves) tree.insert(leaf);
      return {
        tree, lockLeaves: list.flatMap((c) => c.lockLeaves), lockMemos: list.flatMap((c) => c.lockMemos),
        lockMemoCandidates: list.flatMap((c) => c.lockMemoCandidates), lockSetRoot: tree.root(),
      };
    };
    const all = build(found);
    const unverifiable = (reason) => ({ ...all, verified: null, unverifiedReason: reason, excluded: [] });
    if (!getLockState) return unverifiable('no getLockState reader was wired');
    const word32 = (h) => '0x' + strip0x(h).toLowerCase().padStart(64, '0');
    let chain;
    try {
      const s = await getLockState();
      chain = { count: Number(BigInt(s.count)), root: word32(s.root) };
    } catch (e) { return unverifiable(`lockNextLeafIndex/lockRoot read failed: ${String(e && e.message || e).slice(0, 120)}`); }
    const matches = (b) => b.lockLeaves.length === chain.count && word32(b.lockSetRoot) === chain.root;
    if (matches(all)) return { ...all, verified: true, excluded: [] };
    const untrusted = found.filter((c) => !c.trusted);
    if (untrusted.length) {
      const kept = build(found.filter((c) => c.trusted));
      if (matches(kept)) return { ...kept, verified: true, excluded: untrusted.map(({ txHash, lockLeaves }) => ({ txHash, lockLeaves })) };
    }
    if (strict) throw new Error(`stealth lock set does not match the pool: rebuilt ${all.lockLeaves.length} lock leaves, the pool holds ${chain.count} (root ${chain.root}); the event stream is incomplete or the RPC served a different head — retry, or use another RPC`);
    return { ...all, verified: false, excluded: [] };
  }

  return { decodeSettleCalldata, decodeRelaySettleCalldata, decodeNestedSettles, decodeSettleCalls, decodePublicValuesLockFields, decodePublicValuesAdaptorFields, scanLockLeaves };
}
