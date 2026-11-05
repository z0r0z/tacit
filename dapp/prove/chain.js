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

// What a block holds, in a few words: "2 notes · 1 spent".
export function opsText(b) {
  const parts = [];
  if (b.notes) parts.push(plural(b.notes, 'note'));
  if (b.spent) parts.push(`${b.spent} spent`);
  if (b.deposits) parts.push(plural(b.deposits, 'deposit'));
  return parts.join(' · ') || 'empty';
}

// Wei as TAC with up to `places` decimals, trailing zeros dropped.
export function tac(wei, places = 2) {
  const w = BigInt(wei || 0), scale = 10n ** BigInt(places), q = (w * scale) / 10n ** 18n;
  const frac = String(q % scale).padStart(places, '0').replace(/0+$/, '');
  return frac ? `${q / scale}.${frac}` : String(q / scale);
}

// A proof's reward: its points times the most a point is paid today (GET /mine terms.capWeiPerPoint), null when nothing is paid.
export function rewardWei(points, capWeiPerPoint) {
  if (!(Number(points) > 0) || !capWeiPerPoint) return null;
  return BigInt(points) * BigInt(capWeiPerPoint);
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
