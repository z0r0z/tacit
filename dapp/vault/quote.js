// How much an amount of TAC could borrow from each vault now (TAC Dollar and TAC Ether), for the small Borrow boxes on other pages (the trade page,
// the rewards page). One Multicall3 read of the few figures a borrow is tested against, and the vault page's own arithmetic (math.js): the figure is
// the most the vault would lend for that TAC (with the account's own vault, when one is named), rounded down, so the Borrow box it links to accepts
// it. When a vault cannot lend now (no recorded price, no room, an auction on the account's vault) it gives no figure, only why.
import { DEPLOYMENTS } from '/vault/deployments.js?cb=4af96594';
import * as M from '/vault/math.js?cb=ac1ed53e';
import { makeRpc, RPCS, makeReader, staticCalls, dynamicCalls, parseDynamic, wordAt } from '/vault/chain.js?cb=c20b4576';

export const KINDS = { usd: { sym: 'TACD', dp: 2 }, eth: { sym: 'TACE', dp: 4 } };
const ZERO = '0x0000000000000000000000000000000000000000';
const STATIC = ['mint', 'minDebt'], DYNAMIC = ['totalDebt', 'debtCeiling', 'depthCeiling', 'feeBps', 'pB', 'vault'];

// The calls for one vault: the two terms and the vault's own views (taken from the vault page's lists by name, so they cannot drift from them).
export function callsFor(vault, account = null) {
  const V = { addr: vault, tac: ZERO, synth: ZERO, oracle: ZERO, feed: ZERO };
  return [...staticCalls(vault).filter(([k]) => STATIC.includes(k)), ...dynamicCalls(V, account).filter(([k]) => DYNAMIC.includes(k))];
}
// The answers to callsFor, as figures (null where a view gave none: a vault with no price to give refuses pB and the depth).
export function figuresOf(vault, account, res) {
  const list = callsFor(vault, account), at = (k) => res[list.findIndex(([n]) => n === k)];
  const full = dynamicCalls({ addr: vault, tac: ZERO, synth: ZERO, oracle: ZERO, feed: ZERO }, account), dyn = full.map(([k]) => (DYNAMIC.includes(k) ? at(k) ?? null : null));
  const d = parseDynamic({ addr: vault }, account, dyn), U = (x) => (x == null ? null : wordAt(x, 0));
  return { mint: U(at('mint')), minDebt: U(at('minDebt')), totalDebt: d.totalDebt, debtCeiling: d.debtCeiling, depthCeiling: d.depthCeiling, feeBps: d.feeBps, pB: d.pB, me: d.me || null };
}

// One vault's answer for `tac` (wei) put in it: { key, sym, state, amount, text, href, min, vault } (`vault`: the account's vault already holds TAC or owes).
//   open:    `amount` (rounded down to the token's places, as a number for the box in `text`) can be borrowed now; `href` opens the Borrow box with it
//   small:   the vault lends, but this TAC is under what its smallest loan (`min`) needs
//   closed:  the vault has no room to lend now (all of it is borrowed, or the owner has switched lending off)
//   unknown: no figure can be given now (the vault has no recorded price to lend at, the read failed, or an auction runs on the account's vault): link only
export function limitOf(key, f, tac, me = null) {
  const k = KINDS[key], base = { key, sym: k.sym, amount: null, text: '', href: `/vault/${key === 'usd' ? '' : '#v=eth'}`, min: f?.minDebt ?? null };
  if (!f || f.mint == null || f.minDebt == null || f.pB == null || f.feeBps == null || f.totalDebt == null || f.debtCeiling == null || f.depthCeiling == null) return { ...base, state: 'unknown' };
  const mine = me || { collateral: 0n, debt: 0n, auctionStart: 0 };
  if (mine.auctionStart) return { ...base, state: 'unknown' };
  const room = M.sharedRoom({ debtCeiling: f.debtCeiling, depthCeiling: f.depthCeiling, totalDebt: f.totalDebt });
  if (room < f.minDebt || room === 0n) return { ...base, state: 'closed' };
  const lim = M.borrowLimit({ collateral: mine.collateral + (tac > 0n ? tac : 0n), debt: mine.debt, pB: f.pB, mint: f.mint, feeBps: f.feeBps, room, minDebt: f.minDebt });
  const amount = M.floorTo(lim.amount, k.dp);
  // Rounding down can leave the debt just under the smallest one: then this TAC is too little, as when there is no figure at all.
  if (amount <= 0n || mine.debt + amount + M.feeOf(amount, f.feeBps) < f.minDebt) return { ...base, state: 'small' };
  const text = M.plain(amount);
  return { ...base, state: 'open', amount, text, vault: mine.collateral > 0n || mine.debt > 0n, href: `/vault/#${key === 'usd' ? 'v=usd' : 'v=eth'}&amt=${text}` };
}

// Both vaults for `tac` (wei; with `account`, the TAC is added to that account's vault as the vault page's Borrow box does). `rpc` is the page's own
// (method, params) function, or `batch` its Multicall3 reader; without either, the vault page's nodes are asked. Throws when the read fails.
export async function quoteBorrow({ tac = 0n, account = null, rpc = null, batch = null, vaults = DEPLOYMENTS.vaults } = {}) {
  const list = vaults.filter((v) => KINDS[v.key] && /^0x[0-9a-fA-F]{40}$/.test(v.vault));
  const read = batch || makeReader(rpc || makeRpc(RPCS)).batch, who = /^0x[0-9a-fA-F]{40}$/.test(account || '') ? account : null;
  const per = list.map((v) => callsFor(v.vault, who)), res = await read(per.flat());
  let i = 0;
  const out = {};
  list.forEach((v, n) => { const r = res.slice(i, i + per[n].length); i += per[n].length; const f = figuresOf(v.vault, who, r); out[v.key] = limitOf(v.key, f, BigInt(tac || 0), who ? f.me : null); });
  return out;
}
