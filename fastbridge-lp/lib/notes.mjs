// The provider's private ETH as a lock can use it. A BTC -> ETH lock is one note of the exact amount, cut from up to 16 free notes (dapp/fastbridge-evm.js
// prepare), so what one lock can draw is the largest 16 less the fee of the cut: notes past those, or notes too small to matter, hold ETH that no single swap
// reaches. This reports the usable against the total, and merges the small notes into one (a transfer to the provider's own key, nothing leaves it) when that is
// cheap: the relay's fee at most `maxFeeBps` of what is merged, at most `maxPerDay` merges a day, and only while no BTC -> ETH swap is under way.
//
//   noteReport(notes, { cutFee, dustUnits, maxInputs }) -> { notes, total, usable, dust, dustUnits }
//   planMerge(notes, { fee, cfg }) -> { notes, sum, fee, out } | { skip }

export const MERGE_INPUTS = 16;
export const NOTES_DEFAULTS = Object.freeze({ enabled: true, everySecs: 900, dustEth: '0.002', minNotes: 8, maxFeeBps: 25, maxPerDay: 3 });

const units = (t) => { const [w, f = ''] = String(t).split('.'); return BigInt(w) * 10n ** 8n + BigInt(f.padEnd(8, '0').slice(0, 8)); };
const desc = (a, b) => (BigInt(a.value) > BigInt(b.value) ? -1 : BigInt(a.value) < BigInt(b.value) ? 1 : 0);

export function notesConfig(C = {}, env = process.env) {
  const n = { ...NOTES_DEFAULTS, ...((C && typeof C.notes === 'object' && C.notes) || {}) };
  if (C && C.notes === false) n.enabled = false;
  const sw = env.FB_LP_NOTES_MERGE != null ? String(env.FB_LP_NOTES_MERGE).trim().toLowerCase() : '';
  if (sw) { if (sw !== 'on' && sw !== 'off') throw new Error(`FB_LP_NOTES_MERGE must be on or off (got "${env.FB_LP_NOTES_MERGE}")`); n.enabled = sw === 'on'; }
  if (!/^\d{1,6}(\.\d{1,8})?$/.test(String(n.dustEth))) throw new Error(`notes.dustEth must be an amount of ETH (got "${n.dustEth}")`);
  const int = (k, lo, hi) => { const x = Number(n[k]); if (!Number.isInteger(x) || x < lo || x > hi) throw new Error(`notes.${k} must be a whole number from ${lo} to ${hi} (got "${n[k]}")`); return x; };
  return { enabled: n.enabled !== false, everySecs: int('everySecs', 60, 86400), dustUnits: units(n.dustEth), minNotes: int('minNotes', 2, MERGE_INPUTS), maxFeeBps: int('maxFeeBps', 1, 500), maxPerDay: int('maxPerDay', 0, 48) };
}

export function noteReport(notes, { cutFee = 0n, dustUnits = 0n, maxInputs = MERGE_INPUTS } = {}) {
  const sorted = notes.slice().sort(desc);
  const total = sorted.reduce((s, n) => s + BigInt(n.value), 0n);
  const top = sorted.slice(0, maxInputs).reduce((s, n) => s + BigInt(n.value), 0n);
  const fee = sorted.length > 1 ? BigInt(cutFee) : 0n;
  return { notes: sorted.length, total: String(total), usable: String(top > fee ? top - fee : 0n), dust: sorted.filter((n) => BigInt(n.value) < BigInt(dustUnits)).length, largest: String(sorted.length ? BigInt(sorted[0].value) : 0n) };
}

// The smallest notes, up to 16, merged into one, when there are enough of them (`minNotes`) or some are dust, and the fee is a small share
export function planMerge(notes, { fee = 0n, cfg }) {
  if (!cfg || !cfg.enabled) return { skip: 'off' };
  const small = notes.slice().sort(desc).reverse();
  const dust = small.filter((n) => BigInt(n.value) < cfg.dustUnits).length;
  if (small.length < 2) return { skip: 'one note or none' };
  if (small.length < cfg.minNotes && !(dust > 0 && small.length >= 2)) return { skip: `${small.length} notes, none of them dust` };
  const pick = small.slice(0, MERGE_INPUTS), sum = pick.reduce((s, n) => s + BigInt(n.value), 0n), f = BigInt(fee);
  if (f * 10000n > sum * BigInt(cfg.maxFeeBps)) return { skip: `the relay's fee (${f}) is over ${cfg.maxFeeBps / 100}% of the ${sum} merged` };
  if (sum <= f) return { skip: 'the notes do not cover the fee' };
  return { notes: pick, sum, fee: f, out: sum - f };
}
