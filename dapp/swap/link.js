// Which sides of a swap a link makes private. The card's links are ?from=&to=&amt=&private=to|from|both, and a coin named by its private name needs
// no flag:
//   tETH (cETH in the pool's own naming) and cTAC are only ever the private coin, so they make their side private;
//   cBTC and cUSD are the names of the private notes, but they were also the names of the public tokens now called tacBTC and tacUSD, and a link
//   that names one of them alone still opens on the public token. Beside a coin that is private by name they are the pool's notes: tETH → cBTC is
//   the swap in the tETH/cBTC pool.
// private=to|from|both and a bare `private` decide as they always did; a name that is private only adds to what they say.

const lc = (v) => String(v ?? '').trim().toLowerCase();
const ALIAS = { ceth: 'teth', ctac: 'tac' };
// the name the card looks a coin up by
export const linkName = (v) => { const x = lc(v); return ALIAS[x] || x; };
// 'private': a name that is only ever the private coin. 'note': the name of a private note that the public token once shared. null: any other.
export function nameKind(v, notes) {
  const x = lc(v);
  if (x === 'teth' || x === 'ceth' || x === 'ctac') return 'private';
  return x && notes.has(x) ? 'note' : null;
}
// { inP, outP } for the sides the link says something about (undefined for a side it leaves alone), or null when it says nothing.
// `fromKey` is the From coin as the card resolved it, `isEth` tells ETH from the rest; `notes` is the set of private note names in the token list.
export function linkSides({ pv, fromName, toName, fromKey }, { notes, isEth }) {
  let inP, outP;
  if (pv != null) {
    outP = pv !== 'from';
    inP = pv === 'from' || pv === 'both' || (pv === '' && !!fromKey && !isEth(fromKey));
  }
  const kf = nameKind(fromName, notes), kt = nameKind(toName, notes);
  const pooled = kf === 'private' || kt === 'private';
  if (kf === 'private' || (kf === 'note' && pooled)) inP = true;
  if (kt === 'private' || (kt === 'note' && pooled)) outP = true;
  return inP === undefined && outP === undefined ? null : { inP, outP };
}
