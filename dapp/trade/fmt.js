const NF = {}, fixed = [], sigs = [];
let dayF = null, zoneF = null;
const intF = () => (NF.int ||= new Intl.NumberFormat('en-US')), oneF = () => (NF.one ||= new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }));
export function warm() { intF(); oneF(); grp(0, 2); grp(0, 0); grp(0, 4); sig(0.5); day(0); }
export const group = (n) => intF().format(n);
export const grp = (n, max = 2) => (fixed[max] ||= new Intl.NumberFormat('en-US', { maximumFractionDigits: max })).format(Number(n));
export const sig = (x, n = 3) => (x >= 1 ? grp(x, x >= 100 ? 0 : 2) : (sigs[n] ||= new Intl.NumberFormat('en-US', { maximumSignificantDigits: n, maximumFractionDigits: 20 })).format(x));
export const satsFmt = (n) => (n >= 100 ? intF().format(Math.round(n)) : oneF().format(Number(n)));
export const day = (t) => (dayF ||= new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })).format(new Date(t * 1000));
export const zone = (d) => { try { return (zoneF ||= new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' })).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value || ''; } catch { return ''; } };
