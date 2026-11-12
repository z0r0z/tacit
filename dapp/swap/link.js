
const lc = (v) => String(v ?? '').trim().toLowerCase();
const ALIAS = { ceth: 'teth', ctac: 'tac' };
export const linkName = (v) => { const x = lc(v); return ALIAS[x] || x; };
export function nameKind(v, notes) {
  const x = lc(v);
  if (x === 'teth' || x === 'ceth' || x === 'ctac') return 'private';
  return x && notes.has(x) ? 'note' : null;
}
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
