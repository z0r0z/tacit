// The proof-mining card on /weld/keeper/: the one command that installs tacit-prover for an address (dapp/prove.sh does the work), and what
// mining pays, said from the proof pool's and the points service's own answers (GET /prover/pool, GET /mine). No terms are written here: the
// pay per proof is the pool's points a proof earns times the most one point may be paid, so a change of terms on the service changes the card.

export const PROVE_URL = 'https://tacit.finance/prove.sh';
const RUN = `curl -fsSL ${PROVE_URL} | sh -s --`;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// The address as typed, trimmed, when it is one tacit-prover takes (0x and 40 hex digits); null when it is not.
export const cleanAddress = (text) => {
  const a = String(text ?? '').trim();
  return ADDRESS.test(a) ? a : null;
};

// The command to paste: install for an address (the placeholder until there is one), or the check or removal of what is installed.
export function proveCommand(address, mode = 'install') {
  if (mode === 'status') return `${RUN} --status`;
  if (mode === 'uninstall') return `${RUN} --uninstall`;
  return `${RUN} ${cleanAddress(address) || '0xYourAddress'}`;
}

// Wei as TAC, truncated to `places` and without trailing zeros: 200000000000000000 → "0.2", 6000000000000000000 → "6".
export function tacText(wei, places = 2) {
  const w = BigInt(wei), scale = 10n ** BigInt(places), q = (w * scale) / 10n ** 18n;
  const frac = String(q % scale).padStart(places, '0').replace(/0+$/, '');
  return frac ? `${q / scale}.${frac}` : String(q / scale);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A UTC day as "24 Nov", written without Intl so it reads the same everywhere.
const dayText = (sec) => { const d = new Date(sec * 1000); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };

// What mining pays now, or null when it is not paying: `pool` is GET /prover/pool (terms.pointsPerProof, terms.proofsPerMinerDay) and
// `mine` is GET /mine (enabled, endSec, terms.capWeiPerPoint for today, null or off when none). The service shares a day's amount between
// the day's points and pays no point more than the cap, so a proof pays up to its points times the cap, and less once the provers make
// more proofs between them in a day than the amount covers at that pay.
export function mineTerms(pool, mine, nowSec = Date.now() / 1000) {
  const t = mine?.terms, p = pool?.terms;
  if (!mine?.enabled || !t || t.off || !t.capWeiPerPoint || !(Number(mine.endSec) > nowSec)) return null;
  const points = Number(p?.pointsPerProof), perDay = Number(p?.proofsPerMinerDay);
  if (!(points > 0)) return null;
  const perProofWei = BigInt(points) * BigInt(t.capWeiPerPoint);
  if (perProofWei <= 0n) return null;
  return {
    pointsPerProof: points,
    proofsPerDay: perDay > 0 ? perDay : null,
    perProofWei,
    perDayWei: perDay > 0 ? perProofWei * BigInt(perDay) : null,
    until: dayText(Number(mine.endSec)),
  };
}

// The UTC day number the pool tallies proofs under (GET /prover/pool/credits?day=<n>, public, `over` false while the day runs).
export const utcDay = (nowMs = Date.now()) => Math.floor(nowMs / 86400000);

const count = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

// The card's lines, as text, each null when it cannot be said: what a proof pays; what `address` has made today (`tally` is the pool's tally of
// the day, so a first proof shows within minutes and not when the day is paid); and what the points service has credited for finished days.
export function mineLines(pool, mine, { tally = null, address = null, nowSec = Date.now() / 1000 } = {}) {
  const t = mineTerms(pool, mine, nowSec);
  const pays = !t ? null
    : `Up to ${tacText(t.perProofWei)} TAC a proof${t.proofsPerDay ? `, ${t.proofsPerDay} proofs a day` : ''}, until ${t.until}`;
  const me = cleanAddress(address)?.toLowerCase();
  const row = me && Array.isArray(tally?.miners) ? tally.miners.find((m) => String(m?.miner).toLowerCase() === me) : null;
  const today = !me || !Array.isArray(tally?.miners) ? null
    : row ? `${count(row.proofs, 'proof')}, ${count(row.points, 'point')} today` : 'No proofs yet today';
  const credited = mine?.account?.creditedWei != null ? `${tacText(mine.account.creditedWei)} TAC credited` : null;
  return { pays, today, credited };
}
