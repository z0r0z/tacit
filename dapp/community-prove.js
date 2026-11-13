// What /prove/ says about mining: the one command that installs tacit-prover for an address (dapp/prove.sh does the work), and what
// mining pays, said from the proof pool's and the points service's own answers (GET /prover/pool, GET /mine). No terms are written here: the
// pay per proof is the pool's points a proof earns times what a point is paid today (perPoint), so a change of terms on the service changes the card.

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


// The most a point is paid today (GET /mine terms.capWeiPerPoint), or null while mining does not pay: off, no terms, or past the campaign's end.
export const capOf = (mine, nowSec = Date.now() / 1000) => (mine?.enabled && mine.terms && !mine.terms.off && mine.terms.capWeiPerPoint && Number(mine.endSec) > nowSec ? mine.terms.capWeiPerPoint : null);

// What a point earned today is paid so far, in wei: the points service shares the day's amount (GET /mine terms.dailyWei) between the
// day's points and pays no point more than the cap, so it is the cap while the day's points fit the amount and the amount over the points
// once they do not. `dayPoints` is what today's proofs earned (the proof pool's tally and the board's): the salts share only what the
// proofs leave of the day, so they never take it past the amount. It only falls as the day goes on; the day's last rate is what is paid.
// null while mining does not pay or the day's points are not known; the cap from a service that does not say its daily amount.
export function perPoint(mine, dayPoints, nowSec = Date.now() / 1000) {
  const cap = capOf(mine, nowSec);
  if (!cap) return null;
  const c = BigInt(cap), daily = /^\d+$/.test(String(mine.terms.dailyWei ?? '')) ? BigInt(mine.terms.dailyWei) : 0n;
  if (!daily) return c;
  const pts = Number(dayPoints);
  if (dayPoints == null || !Number.isSafeInteger(pts) || pts < 0) return null;
  const share = pts > 0 ? daily / BigInt(pts) : c;
  return share < c ? share : c;
}

// What mining pays now, or null when it is not paying: `pool` is GET /prover/pool (terms.pointsPerProof, terms.proofsPerMinerDay) and
// `mine` is GET /mine (enabled, endSec, terms.capWeiPerPoint for today, null or off when none). The service shares a day's amount between
// the day's points and pays no point more than the cap, so a proof pays up to its points times the cap, and less once the provers make
// more proofs between them in a day than the amount covers at that pay.
export function mineTerms(pool, mine, nowSec = Date.now() / 1000) {
  const cap = capOf(mine, nowSec), p = pool?.terms;
  if (!cap) return null;
  const points = Number(p?.pointsPerProof), perDay = Number(p?.proofsPerMinerDay);
  if (!(points > 0)) return null;
  const perProofWei = BigInt(points) * BigInt(cap);
  if (perProofWei <= 0n) return null;
  return {
    pointsPerProof: points,
    proofsPerDay: perDay > 0 ? perDay : null,
    perProofWei,
    perDayWei: perDay > 0 ? perProofWei * BigInt(perDay) : null,
  };
}

// The UTC day number the pool tallies proofs under (GET /prover/pool/credits?day=<n>, public, `over` false while the day runs).
export const utcDay = (nowMs = Date.now()) => Math.floor(nowMs / 86400000);

const count = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

// The card's lines, as text, each null when it cannot be said: what a proof pays (today's so far once the day's points, `dayPoints`, are
// more than the amount covers at the cap); what `address` has made today (`tally` is the pool's tally of the day, so a first proof shows
// within minutes and not when the day is paid); and what the points service has credited for finished days.
export function mineLines(pool, mine, { tally = null, address = null, dayPoints = null, nowSec = Date.now() / 1000 } = {}) {
  const t = mineTerms(pool, mine, nowSec), rate = t ? perPoint(mine, dayPoints, nowSec) : null;
  const now = rate != null && rate < BigInt(capOf(mine, nowSec)) ? BigInt(t.pointsPerProof) * rate : null;
  const most = t?.proofsPerDay ? `, up to ${t.proofsPerDay} a day` : '';
  const pays = !t ? null
    : now != null ? `${tacText(now)} TAC a proof today (up to ${tacText(t.perProofWei)})${most}`
    : `Up to ${tacText(t.perProofWei)} TAC a proof${most}`;
  const me = cleanAddress(address)?.toLowerCase();
  const row = me && Array.isArray(tally?.miners) ? tally.miners.find((m) => String(m?.miner).toLowerCase() === me) : null;
  const today = !me || !Array.isArray(tally?.miners) ? null
    : row ? `${count(row.proofs, 'proof')}, ${count(row.points, 'point')} today` : 'No proofs yet today';
  const credited = mine?.account?.creditedWei != null ? `${tacText(mine.account.creditedWei)} TAC credited` : null;
  return { pays, today, credited };
}
