
export const UNBOND_DUST = 100000n;
export const HARVEST_WORTH = 1000000n;

const units = (pos) => { try { return BigInt(pos?.pendingUnits || 0); } catch { return 0n; } };
export const unharvested = (pos) => units(pos) > UNBOND_DUST;
export const locked = (pos, now = Date.now() / 1000) => Number(pos?.unlockAt || 0) > now;
export const canHarvest = (pos) => units(pos) > 0n;
export const canUnbond = (pos, now) => !locked(pos, now) && !unharvested(pos);

export function exitSaid(lockSeconds, name, { lpOnly = false } = {}) {
  const lock = lockSeconds == null ? NaN : Number(lockSeconds);
  if (!lpOnly && !(lock >= 0 && Number.isFinite(lock))) return null;
  const when = lpOnly || lock === 0 ? 'any time' : `after ${lock >= 86400 ? `${Math.round(lock / 86400)} days` : `${Math.max(1, Math.round(lock / 3600))} h`}`;
  const coins = String(name || '').split(' / ');
  return `${when}, as private ${coins.length === 2 ? `${coins[0]} and ${coins[1]}` : name}`;
}

// A step the relay proves but will not send for free just now (the day's free sends of its kind are used, or it is catching up on its sends)
// goes out from the connected wallet instead: the relay proves it as a prove-only job and the wallet sends it, paying the network fee.
export const ownSend = (e) => e?.code === 'free_budget' || e?.code === 'relay_held';
export const ownWhy = (e) => (e?.code === 'relay_held'
  ? 'The relay is catching up on its sends, so your wallet sends this one: the relay proves it, then you confirm it (a network fee, paid in ETH).'
  : 'Today’s free relay sends for this are used up, so your wallet sends this one: the relay proves it, then you confirm it (a network fee, paid in ETH).');
// → selfSettle for the pool module's steps: the proof sent to the pool from `from` (an address, or a function giving it), after the node
// has estimated it (a step that would not go through is not sent). null without a wallet that sends.
export function walletSettle(t, wallet, from, { confirm = () => {} } = {}) {
  if (!wallet?.sendTx || !wallet?.receipt) return null;
  return async ({ publicValues, proof, memos }) => {
    const who = typeof from === 'function' ? await from() : from;
    if (!who) throw new Error('The relay proved this step for your wallet to send: connect a wallet and press again.');
    const to = t.cfg.pool, data = t.settleCalldata({ publicValues, proof, memos });
    let gas = null;
    try { gas = (BigInt(await t.rpc('eth_estimateGas', [{ from: who, to, data }])) * 13n) / 10n; }
    catch (e) {
      if (e?.revert || /revert/i.test(String(e?.message || e))) throw new Error('This step would not go through as the pool stands now, so nothing was sent. Press again.');
    }
    confirm();
    const hash = await wallet.sendTx({ to, data, from: who, ...(gas ? { gas } : {}) });
    const rc = await wallet.receipt(hash);
    if (rc?.status !== '0x1') throw new Error(`The transaction did not go through (${String(hash).slice(0, 10)}…). Nothing was lost but its network fee: press again.`);
    return { txHash: hash };
  };
}
// The step through the relay; when the relay will prove it but not send it, again with the wallet sending (`onOwn(e)` first, to say so).
export async function relayedOrOwn(step, own, onOwn = () => {}) {
  try { return await step(null); }
  catch (e) {
    if (!own || !ownSend(e)) throw e;
    onOwn(e);
    return step(own);
  }
}
const via = (s) => (s ? { selfSettle: s } : {});

export const harvest = (t, priv, pos, waitOpts, own = null, onOwn) => relayedOrOwn((s) => t.farmHarvest({ walletPriv: priv, position: pos, waitOpts, ...via(s) }), own, onOwn);

export async function unbond(t, priv, pos, waitOpts, again = (p) => p, { forfeit = false, own = null, onOwn } = {}) {
  const go = (p, forfeitPending) => relayedOrOwn((s) => t.farmUnbond({ walletPriv: priv, position: p, forfeitPending, waitOpts, ...via(s) }), own, onOwn);
  if (forfeit) return go(pos, true);
  try { return await go(pos, false); }
  catch (e) {
    const u = /farm-unbond: (\d+) reward units/.exec(String(e?.message || ''));
    if (!u || BigInt(u[1]) > HARVEST_WORTH) throw e;
    return go(again(pos), true);
  }
}

export const WTAC = '0x2018139a8fdd3666855be3315c7683b4d6ab7aef';
const word = (v) => BigInt(v).toString(16).padStart(64, '0'), addr = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
export const wtacWithdrawCall = (amount, to) => ({ to: WTAC, data: '0x00f714ce' + word(amount) + addr(to) });
export const wtacBalanceCall = (who) => ({ to: WTAC, data: '0x70a08231' + addr(who) });
export const rewardNotes = (notes, rewardAsset) => (notes || []).filter((n) => rewardAsset && String(n.asset).toLowerCase() === String(rewardAsset).toLowerCase());
export function relayable(t, note, rewardAsset) {
  try { return (t.quoteUnwrapFee(note.value, t.poolTickerOf(String(rewardAsset).toLowerCase()))?.net ?? 1n) > 0n; } catch { return true; }
}
export function worthHarvesting(t, units, rewardAsset) {
  const v = BigInt(units || 0);
  if (v <= HARVEST_WORTH) return false;
  try { return t.quoteUnwrapFee(v, t.poolTickerOf(String(rewardAsset).toLowerCase())).fee * 2n <= v; } catch { return false; }
}
export const redeem = (t, priv, note, to, waitOpts) => t.farmRedeem({ walletPriv: priv, note, to, wait: true, waitOpts });

export const lpNotes = (notes, pool) => (notes || []).filter((n) => pool?.lpAsset && String(n.asset).toLowerCase() === String(pool.lpAsset).toLowerCase());
export const takeOut = (t, priv, pool, note, waitOpts, own = null, onOwn) => relayedOrOwn((s) => t.lpRemove({ walletPriv: priv, assetA: pool.reserves.assetA, assetB: pool.reserves.assetB, feeBps: Number(pool.feeBps ?? 30), shareNote: note, waitOpts, ...via(s) }), own, onOwn);

export const bFor = (a, res) => (BigInt(a) * BigInt(res.reserveB) + BigInt(res.reserveA) - 1n) / BigInt(res.reserveA);
export const aFor = (b, res) => (BigInt(b) * BigInt(res.reserveA)) / BigInt(res.reserveB);
export async function joinTerms(t, pool) {
  const tk = (id) => t.poolTickerOf(String(id).toLowerCase());
  const [res, feeA, feeB] = await Promise.all([t.poolReserves(pool.poolId), t.quoteOpFee(tk(pool.reserves.assetA), 'transfer').then(BigInt), t.quoteOpFee(tk(pool.reserves.assetB), 'transfer').then(BigInt)]);
  if (!res || !(BigInt(res.totalShares || 0) > 0n)) throw new Error('This pool is not open for liquidity yet.');
  if (String(res.assetA).toLowerCase() !== String(pool.reserves.assetA).toLowerCase()) throw new Error('This pool reads differently from the farm program. Try again in a minute.');
  return { res, feeA, feeB };
}
const byValue = (a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : BigInt(a.value) > BigInt(b.value) ? 1 : 0);
export const notesOf = (notes, asset) => (notes || []).filter((n) => String(n.asset).toLowerCase() === String(asset).toLowerCase());
export const exactOf = (notes, amount) => [...notes].sort(byValue).find((n) => BigInt(n.value) === BigInt(amount)) || null;
export function cutPick(notes, amount, fee) {
  const need = BigInt(amount) + BigInt(fee), up = [...notes].sort(byValue);
  const one = up.find((x) => BigInt(x.value) >= need);
  if (one) return [one];
  const picked = []; let sum = 0n;
  for (const x of [...up].reverse()) { if (sum >= need || picked.length === 16) break; picked.push(x); sum += BigInt(x.value); }
  return sum >= need ? picked : null;
}
export const cut = (t, priv, notes, amount, fee, waitOpts) => t.transfer({ walletPriv: priv, notes, recipientPubHex: t.identity(priv).pubHex, amount: BigInt(amount), fee: BigInt(fee), waitOpts });
export const ladder = (v) => { const x = BigInt(v), d = x.toString().length; if (d <= 2) return x; const s = 10n ** BigInt(d - 2); return ((x + s - 1n) / s) * s; };
export const feeShort = (e) => /fee below the current floor|feeGate|below the marginal cost/i.test(String(e?.message || e || ''));
export async function cutSized(t, priv, notes, amount, fee, wait) {
  const waitOpts = () => (typeof wait === 'function' ? wait() : wait);
  try { return await cut(t, priv, notes, amount, fee, waitOpts()); }
  catch (e0) {
    const up = ladder(BigInt(fee) * 2n), sum = notes.reduce((s, n) => s + BigInt(n.value), 0n);
    if (feeShort(e0) && sum >= BigInt(amount) + up) return cut(t, priv, notes, amount, up, waitOpts());
    throw e0;
  }
}
export function farmManager(t, named) {
  const mine = t.cfg?.farm?.manager;
  if (!mine) throw new Error('There is no farm program on this network.');
  if (named && String(named).toLowerCase() !== String(mine).toLowerCase()) throw new Error('This farm names a manager other than the configured one, so nothing was added.');
  return mine;
}
export const bond = (t, priv, { manager, aNote, bNote, feeBps, waitOpts, own = null, onOwn }) => relayedOrOwn((s) => t.lpBond({ walletPriv: priv, controller: farmManager(t, manager), aNote, bNote, feeBps: Number(feeBps ?? 30), waitOpts, ...via(s) }), own, onOwn);
