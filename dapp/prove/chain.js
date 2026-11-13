// The network view on /prove/, as words and shapes: a block from GET /prover/blocks (its height, its transaction, the notes it made,
// the notes it spent, the deposits in it, and the community prover who proved one of its notes, if one did), the proofs a page reads from
// GET /prover/pool/recent, and the reward a proof earns (its points times the most a point is paid). Nothing here reads the network.

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

// A prover's colour, the same on every page and every visit: a hue from the address.
export const hueOf = (a) => (parseInt(String(a).slice(2, 8), 16) || 0) % 360;

// The little squares in a block: a made note filled, a spent one hollow, a deposit orange; nine at most, the rest said in words.
export function cells(b, max = 9) {
  const all = [...Array(b.deposits || 0).fill('dp'), ...Array(b.notes || 0).fill(''), ...Array(b.spent || 0).fill('sp')];
  return { cells: all.slice(0, max), more: Math.max(0, all.length - max) };
}

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

// What a block holds, in a few words: "2 new notes · 1 note spent".
export function opsText(b) {
  const parts = [];
  if (b.notes) parts.push(plural(b.notes, 'new note'));
  if (b.spent) parts.push(`${plural(b.spent, 'note')} spent`);
  if (b.deposits) parts.push(plural(b.deposits, 'deposit'));
  return parts.join(' · ') || 'empty';
}

// Wei as TAC with up to `places` decimals, trailing zeros dropped.
export function tac(wei, places = 2) {
  const w = BigInt(wei || 0), scale = 10n ** BigInt(places), q = (w * scale) / 10n ** 18n;
  const frac = String(q % scale).padStart(places, '0').replace(/0+$/, '');
  return frac ? `${q / scale}.${frac}` : String(q / scale);
}

// A proof's reward: its points times what a point is paid (perPoint in community-prove.js), null when nothing is paid.
export function rewardWei(points, weiPerPoint) {
  if (!(Number(points) > 0) || !weiPerPoint) return null;
  return BigInt(points) * BigInt(weiPerPoint);
}

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const took = (secs) => (secs < 90 ? `${secs} s` : `${Math.round(secs / 60)} min`);

// Blocks to add to the strip: those above the highest already shown, newest first. The first read adds them all without the landing.
export function fresh(blocks, shownTop) {
  return shownTop == null ? blocks : blocks.filter((b) => b.height > shownTop);
}

// How long ago an Ethereum block was, from the newest one: twelve seconds a block.
export function blockAgo(ethBlock, ethHead) {
  if (ethHead == null || ethBlock == null) return null;
  const s = Math.max(0, (ethHead - ethBlock) * 12);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// What a block did, from the notes it made and spent: money arriving (a deposit, a bridge mint), money moving inside (a send, a swap,
// an LP change), money leaving (a withdrawal, a lock), or several operations proved together in one settle (a batch). It is read from
// the pool's logs alone, so it names the shape, not the exact operation.
export function kindOf(b) {
  const made = b.notes || 0, spent = b.spent || 0;
  if (made + spent >= 4) return 'batch';
  if (made && spent) return 'transfer';
  if (made) return 'deposit';
  if (spent) return 'withdrawal';
  return 'other';
}
export const KINDS = Object.freeze({
  deposit: { name: 'Deposit', act: 'Make a private deposit', href: '/' },
  transfer: { name: 'Private transfer', act: 'Send privately', href: '/pay/' },
  withdrawal: { name: 'Withdrawal', act: null, href: null },
  batch: { name: 'Batch', act: null, href: null },
  other: { name: 'Settle', act: null, href: null },
});
export const kindText = (b) => (kindOf(b) === 'batch' ? `Batch · ${(b.notes || 0) + (b.spent || 0)} ops` : KINDS[kindOf(b)].name);

// The middle of a list of seconds, for a prover's usual speed.
export const median = (xs) => { const s = xs.filter((x) => x > 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
// How long a proof takes, as a range: from the quicker quarter of the newest proofs to the slow tenth, since a GPU proves in seconds and a laptop in
// minutes and one figure in the middle would say neither. One figure when they round to the same, null with none.
export function proofSpan(xs) {
  const s = xs.filter((x) => x > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const lo = took(s[Math.floor(s.length / 4)]), hi = took(s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]);
  return lo === hi ? lo : `${lo} to ${hi}`;
}

// How long until a UTC day is over, when its proofs are paid: "5 h 12 min".
export function untilDayEnds(nowMs = Date.now()) {
  const left = Math.max(0, 86400000 - (nowMs % 86400000)), h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
  return h ? `${h} h ${m} min` : `${m} min`;
}

// What the API says, cleaned before anything is drawn: numbers as numbers, addresses and hashes as hex or nothing. A value that is not
// one of those is dropped, so an answer can never carry markup into the page.
const ADDR = /^0x[0-9a-f]{40}$/i, H32 = /^0x[0-9a-f]{64}$/i;
const nat = (x) => (Number.isSafeInteger(Number(x)) && Number(x) >= 0 ? Number(x) : 0);
const addrOr = (a) => (ADDR.test(String(a)) ? String(a).toLowerCase() : null);
export function cleanBlock(b) {
  if (!b || !Number.isSafeInteger(Number(b.height)) || Number(b.height) < 0) return null;
  return { height: Number(b.height), ethBlock: nat(b.ethBlock), notes: nat(b.notes), spent: nat(b.spent), deposits: nat(b.deposits), points: nat(b.points),
    hash: H32.test(String(b.hash)) ? String(b.hash) : '', tx: H32.test(String(b.tx)) ? String(b.tx) : '', prover: addrOr(b.prover) || undefined, house: b.house === true };
}
export const cleanProof = (p) => (p && (p.house === true || addrOr(p.miner)) ? { at: nat(p.at), miner: addrOr(p.miner) || undefined, house: p.house === true, points: nat(p.points), secs: nat(p.secs) } : null);
export const cleanMiner = (m) => (m && addrOr(m.miner) ? { miner: addrOr(m.miner), proofs: nat(m.proofs), points: nat(m.points) } : null);
// Each address's day across the proof pool's tally and the board's (a GPU's batches and blocks), both of which the points service pays:
// lowercased address -> { miner, proofs, points, pool: { proofs, points }, board: { proofs, points } }.
export function dayTotals(poolMiners = [], boardMiners = []) {
  const out = new Map();
  for (const [part, list] of [['pool', poolMiners], ['board', boardMiners]]) {
    for (const m of list || []) {
      if (!m?.miner) continue;
      const k = String(m.miner).toLowerCase();
      const o = out.get(k) || { miner: m.miner, proofs: 0, points: 0, pool: { proofs: 0, points: 0 }, board: { proofs: 0, points: 0 } };
      o.proofs += m.proofs || 0; o.points += m.points || 0; o[part].proofs += m.proofs || 0; o[part].points += m.points || 0;
      out.set(k, o);
    }
  }
  return out;
}
