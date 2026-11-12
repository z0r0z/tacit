
export const IN_DONE = ['minted', 'reclaimed'], IN_HELD = ['not-recorded', 'stopped', 'recovered'];
export const IN_BURN_SENT = ['burn-submitted', 'burn-mined', 'registered', 'folded', 'minted'];
export const waitRanOut = (e) => /settle timed out|status polling for job/i.test(e?.message || '');
export const WAIT_LOOK_MS = 10 * 60e3;
export function waitLookDue(rec, others = [], now = Date.now()) {
  const w = rec.checkWait?.fund ? rec.checkWait : rec.feeWait;
  if (!w || now - Number(w.at || 0) >= WAIT_LOOK_MS) return true;
  return !!rec.checkWait?.fund && others.some((r) => r.id !== rec.id && IN_BURN_SENT.includes(r.stage) && Number(r.updatedAt || 0) > Number(w.at || 0));
}

export async function stepIn({ ux, pub, withKey, priv, planOf = () => null, alive = () => true, on = {} }) {
  let moved = false;
  for (const rec of ux.list(pub).filter((r) => !IN_DONE.includes(r.stage) && !IN_HELD.includes(r.stage))) {
    if (!alive()) break;
    if (rec.path === 'reflected' && rec.mint && !rec.arm?.ok && Number(rec.arm?.tries || 0) < 6) await withKey(() => ux.armMint(pub, rec.id, { walletPriv: priv() }), pub).catch(() => {});
    const ready = rec.stage === 'folded' || rec.stage === 'rfolded';
    const due = ready && ux.mintRetryDue(rec, { ranOut: waitRanOut(rec.lastError) });
    try {
      let after;
      if (rec.stage === 'traced' && (planOf(rec)?.burn || rec.checkWait?.go) && !rec.lastError) {
        after = waitLookDue(rec, ux.list(pub)) ? await withKey(() => ux.advance(pub, rec.id, { walletPriv: priv(), maxFeeRate: planOf(rec)?.burn?.maxRate ?? null }), pub) : rec;
        if (after.stage === 'burn-signed') after = await ux.advance(pub, rec.id).catch(() => ux.list(pub).find((r) => r.id === rec.id) || after);
        if (IN_BURN_SENT.includes(after.stage)) on.burnSent?.(after);
        else if (after.feeWait && !rec.feeWait) moved = true;
      } else after = due ? await ux.advance(pub, rec.id, { walletPriv: priv() })
        : ready || rec.stage === 'traced' ? await ux.verify(pub, rec.id) : await ux.advance(pub, rec.id);
      if (after?.stage !== rec.stage) moved = true;
      if (after?.stage === 'minted') on.minted?.(after);
      else if (after?.stage === 'traced' && rec.stage !== 'traced') on.traced?.(after);
    } catch { moved = true; }
  }
  return { moved };
}

export const signsNext = (rec) => rec.stage === 'covered';
export async function advanceOut(ux, pub, rec, { withKey, priv, keyPub, allowHighFee = false }) {
  let cur = rec;
  for (let i = 0; i < 4; i++) {
    if (signsNext(cur) && keyPub() !== pub) return cur;
    const next = signsNext(cur) ? await withKey(() => ux.advance(pub, cur.id, { walletPriv: priv(), allowHighFee }), pub) : await ux.advance(pub, cur.id);
    if (next.stage === cur.stage) return next;
    cur = next;
    if (cur.stage === 'mint-submitted' || cur.stage === 'minted') return cur;
  }
  return cur;
}

export async function stepOut({ ux, pubs, records, keyPub, withKey, priv, rechecked = {}, on = {} }) {
  const k = keyPub(), moved = [];
  for (const [pub, listed] of pubs.flatMap((p) => records(p).map((r) => [p, r]))) {
    if (keyPub() !== k) break;
    let rec = listed;
    if (pub === k && rec.stage === 'settled' && rec.settle?.claimIdVerified === false && rec.settle.txHash && Date.now() - Number(rechecked[rec.id] || 0) > 10 * 60e3) {
      rechecked[rec.id] = Date.now();
      try { rec = await ux.recoverFromEthTx('0x' + String(rec.settle.txHash).replace(/^0x/, ''), priv(), { amount: BigInt(rec.source.amount ?? rec.source.value) }); } catch { rec = listed; }
      if (rec.settle?.claimIdVerified !== false) moved.push(rec);
    }
    const sends = signsNext(rec) || rec.stage === 'mint-signed';
    if (rec.lastError && sends && ((!rec.lastError.feeWait && !rec.lastError.fundWait && (Number(rec.errorCount) || 0) >= 6) || Date.now() - Number(rec.lastError.at || 0) < (rec.lastError.fundWait ? 2 : 10) * 60e3)) continue;
    try {
      const after = await advanceOut(ux, pub, rec, { withKey, priv, keyPub });
      if (after?.stage !== rec.stage) moved.push(rec);
      if (after?.stage === 'minted' && (!k || pub === k)) on.arrived?.(after);
    } catch (e) {
      moved.push(rec);
      if (e?.fundWait && !rec.lastError?.fundWait) on.fundWait?.(rec, e);
    }
  }
  if (ux.bindDue && k) {
    for (const rec of ux.list(k).filter((r) => ux.bindDue(r))) {
      if (keyPub() !== k) break;
      const err = rec.bindError;
      if (err && Date.now() - Number(err.at || 0) < (err.fundWait || err.feeWait ? 2 : 10) * 60e3) continue;
      try {
        const after = await withKey(() => ux.bindNow(k, rec.id, { walletPriv: priv() }), k);
        if (after?.bind?.sent) { moved.push(after); on.readied?.(after); }
      } catch (e) { if (e?.fundWait && !err?.fundWait) on.fundWait?.(rec, e); }
    }
  }
  return moved;
}

export function outPubs(storage = localStorage) {
  const own = 'tacit-crossout-bridge-v1:mainnet:', pubs = [];
  try { for (let i = 0; i < storage.length; i++) { const k = storage.key(i) || ''; if (k.startsWith(own) && /^[0-9a-f]{66}$/.test(k.slice(own.length))) pubs.push(k.slice(own.length)); } } catch {}
  return pubs;
}

export const FOUND_KEY = 'tacit-lite-bridge-found-v1', DEEP_KEY = 'tacit-lite-bridge-deep-v1';
export const unsearched = (pub, listed, memory) => !!pub && !listed.length && !memory.get(DEEP_KEY)?.[pub];
export async function discoverIn({ pub, listed, esplora, withKey, priv, memory }) {
  const deep = unsearched(pub, listed, memory);
  const address = await withKey((t) => t.wallet.address(), pub);
  const first = await esplora(`/address/${address}/txs`);
  let txs = Array.isArray(first) ? first : [];
  for (let page = 1, last = txs; page < (deep ? 8 : 2) && last.length >= 25; page++) {
    const more = await esplora(`/address/${address}/txs/chain/${last[last.length - 1].txid}`).catch(() => []);
    last = Array.isArray(more) ? more : [];
    txs = txs.concat(last);
  }
  const seen = new Set(memory.get(FOUND_KEY)?.[pub] || []);
  const { found, tried, left } = await withKey((t) => t.bridgeUx().discover({ walletPriv: priv(), txs, skip: [...seen], limit: deep ? 80 : 20 }), pub);
  if (tried.length) { const m = memory.get(FOUND_KEY) || {}; m[pub] = [...seen, ...tried].slice(-300); memory.set(FOUND_KEY, m); }
  if (deep && !left) { const m = memory.get(DEEP_KEY) || {}; m[pub] = Date.now(); memory.set(DEEP_KEY, m); }
  return { found, deep };
}
export const discoverEvery = (deep, tab = false) => (deep ? 2 : tab ? 10 : 60) * 60e3;
