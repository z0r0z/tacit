// The code-review card on /prove/: what the computer's tacit-prover says of its help desk job (GET 127.0.0.1:47815/helpdesk: on, installed, running,
// answers given, the address it pays), and what the help desk says of the network (GET /stats: nodes online, each address's recent review record), turned
// into what the card shows. Nothing here reaches a network; app.js reads and paints.

export const HELPDESK = 'https://tacit-helpdesk.onrender.com';
export const FETCH_CMD = 'curl -fsSL https://tacit.finance/helpdesk-fetch.sh | bash';

const count = (x) => (Number.isSafeInteger(Number(x)) && Number(x) >= 0 ? Number(x) : null);
const HEX40 = /^0x[0-9a-fA-F]{40}$/;
// the short form the help desk lists an address by: 0x and six more hex digits, an ellipsis, the last four
export const shortOf = (a) => (HEX40.test(String(a)) ? `${a.slice(0, 8)}…${a.slice(-4)}`.toLowerCase() : null);

// the prover's answer, reduced to what the card uses (an older prover has no /helpdesk and answers nothing: null)
export function cleanDesk(d) {
  if (!d || typeof d !== 'object' || typeof d.on !== 'boolean') return null;
  return { on: d.on, installed: d.installed === true, running: d.model_running === true, busy: !!(d.job && typeof d.job === 'object'), served: count(d.served) ?? 0, miner: HEX40.test(String(d.miner)) ? d.miner.toLowerCase() : null };
}
// the help desk's stats, reduced to the nodes online and the review records
export function cleanStats(s) {
  if (!s || typeof s !== 'object') return null;
  const reviewers = Array.isArray(s.swarm?.reviewers) ? s.swarm.reviewers.filter((r) => r && typeof r.miner === 'string').map((r) => ({ miner: r.miner.toLowerCase(), checks: count(r.skeptic?.n) ?? 0, right: count(r.skeptic?.right) ?? 0, scouted: count(r.scout?.n) ?? 0, found: count(r.scout?.found) ?? 0 })) : [];
  return { online: count(s.nodes?.online), reviewers };
}

// -> { state, button (null: no button), cmd (show the fetch line), record (null: none to show), online }
//   proverUp: the computer's tacit-prover answered; desk: cleanDesk(...); stats: cleanStats(...); me: the address in the page's field
export function reviewView({ proverUp, desk, stats, me }) {
  const online = stats?.online == null ? '—' : String(stats.online);
  const mine = stats && (desk?.miner || me) ? stats.reviewers.find((r) => r.miner === shortOf(desk?.miner || me)) : null;
  const record = mine && (mine.checks || mine.scouted) ? [mine.checks ? `${mine.right} of ${mine.checks} checks right` : '', mine.scouted ? `${mine.found} of ${mine.scouted} planted bugs found` : ''].filter(Boolean).join(' · ') : null;
  if (!proverUp) return { state: 'Needs tacit-prover, above', button: null, cmd: false, record, online };
  if (!desk) return { state: 'Update tacit-prover to turn this on', button: null, cmd: false, record, online };
  if (!desk.installed) return { state: 'Get the model first', button: null, cmd: true, record, online };
  if (!desk.on) return { state: desk.miner ? 'Off' : 'Start proving with your address first', button: desk.miner ? 'Turn on' : null, cmd: false, record, online };
  const answered = desk.served ? ` · ${desk.served} answered` : '';
  const state = desk.busy ? `Reviewing${answered}` : desk.running ? `Ready${answered}` : `On · when this computer is idle and plugged in${answered}`;
  return { state, button: 'Turn off', cmd: false, record, online };
}
