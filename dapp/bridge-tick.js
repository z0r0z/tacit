// The bridges this browser has under way, moved on by whichever page has them open: the front page every minute, the bridge page while it is
// open. Each engine (burndep-ux.js on the way in from Bitcoin, crossout-ux.js on the way out to it) holds a lease on a bridge while it moves
// it, so two tabs never move one at once. The page brings the engines, its key and what to say when a bridge moves; nothing here draws.
//   const { moved } = await stepIn({ ux: t.bridgeUx(), pub, withKey, priv, planOf, alive, on: { burnSent, minted, traced } });
//   const moved = await stepOut({ ux: t.crossoutUx(), pubs, records, keyPub, withKey, priv, rechecked, on: { arrived, fundWait } });

// ── the way in: burndep-ux's stages ──
export const IN_DONE = ['minted', 'reclaimed'], IN_HELD = ['not-recorded', 'stopped', 'recovered'];
export const IN_BURN_SENT = ['burn-submitted', 'burn-mined', 'registered', 'folded', 'minted'];
// a relay wait that ran out (the mint may still land): asked again sooner than a refusal
export const waitRanOut = (e) => /settle timed out|status polling for job/i.test(e?.message || '');

// One pass over a key's bridges in: a mint armed with the relay where it can be, a burn sent where the holder's plan (or a finished history
// check) says to, a ready mint sent when its retry is due, and every other bridge read again from the chains.
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
        after = await withKey(() => ux.advance(pub, rec.id, { walletPriv: priv(), maxFeeRate: planOf(rec)?.burn?.maxRate ?? null }), pub);
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

// ── the way out: crossout-ux's stages ──
// A bridge out moved as far as it goes now: its proof, coverage and credit are read from the chains with no key; only the Bitcoin step
// (from `covered`) is signed, and only under the bridge's own key.
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

// One pass over every journaled key's bridges out (`records(pub)` lists one key's under way). A burn whose claim was not matched to its record
// is rebuilt from its Ethereum transaction, under the open key, at most every ten minutes; a Bitcoin step that keeps failing rests (two minutes
// while it waits for bitcoin to pay its fee, ten otherwise, and for good after six tries that are neither). Returns the bridges that moved.
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
  // Bridges that arrived ready for Ethereum and are not bound yet: bound under the open key (crossout-ux.js bindNow), resting after a
  // failure as the Bitcoin step does. `on.readied` hears each one made ready.
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

// the keys this browser holds a bridge out for, by their journals' names
export function outPubs(storage = localStorage) {
  const own = 'tacit-crossout-bridge-v1:mainnet:', pubs = [];
  try { for (let i = 0; i < storage.length; i++) { const k = storage.key(i) || ''; if (k.startsWith(own) && /^[0-9a-f]{66}$/.test(k.slice(own.length))) pubs.push(k.slice(own.length)); } } catch {}
  return pubs;
}

// ── bridges this browser has no record of ──
// A key whose bridges this browser never saw (a new browser, or one whose data was cleared) is searched once through a longer stretch of its Bitcoin
// history, and the others a little way back each time: a bridge's burn is among the transactions of the key's own Bitcoin address, 25 to a page.
// `memory` is the page's small store ({ get(key), set(key, value) }, JSON): what was tried, and when the long search was done.
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
// how long before the next look: sooner for a key never searched
export const discoverEvery = (deep, tab = false) => (deep ? 2 : tab ? 10 : 60) * 60e3;
