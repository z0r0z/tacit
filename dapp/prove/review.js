// The code-review card on /prove/: what the computer's tacit-prover says of its help desk job (GET 127.0.0.1:47815/helpdesk: on, installed, running,
// answers given, the address it pays, and how far its fetch of the model has got), and what the help desk says of the network (GET /stats: nodes online, each address's recent review record), turned
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
  return { on: d.on, installed: d.installed === true, running: d.model_running === true, busy: !!(d.job && typeof d.job === 'object'), served: count(d.served) ?? 0, miner: HEX40.test(String(d.miner)) ? d.miner.toLowerCase() : null,
    // A prover that fetches the model itself says whether it is fetching (an older one says nothing of it, and is shown the line to paste), how many bytes of
    // how many are here, and what stopped the last try: that last is the prover's own words, kept to plain text of a line's length.
    canFetch: typeof d.fetching === 'boolean', fetching: d.fetching === true, fetched: count(d.fetched) ?? 0, total: count(d.fetch_total) ?? 0,
    fetchError: typeof d.fetch_error === 'string' && d.fetch_error.trim() ? d.fetch_error.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : null };
}
// a size in GB to one place, as the card says it
export const gb = (bytes) => (bytes / 1e9).toFixed(1);
// the help desk's stats, reduced to the nodes online and the review records
export function cleanStats(s) {
  if (!s || typeof s !== 'object') return null;
  const reviewers = Array.isArray(s.swarm?.reviewers) ? s.swarm.reviewers.filter((r) => r && typeof r.miner === 'string').map((r) => ({ miner: r.miner.toLowerCase(), checks: count(r.skeptic?.n) ?? 0, right: count(r.skeptic?.right) ?? 0, scouted: count(r.scout?.n) ?? 0, found: count(r.scout?.found) ?? 0 })) : [];
  return { online: count(s.nodes?.online), reviewers };
}

// What a press of the card's button asks of the prover: off stops a fetch of the model; with no model yet, on (the prover fetches it, then starts);
// with the model, the other of what it is now.
export const pressTurnsOn = (desk) => (desk.fetching ? false : desk.installed ? !desk.on : true);

// -> { state, button (null: no button), cmd (show the fetch line), note (what went wrong, or ''), record (null: none to show), online }
//   proverUp: the computer's tacit-prover answered; desk: cleanDesk(...); stats: cleanStats(...); me: the address in the page's field
export function reviewView({ proverUp, desk, stats, me }) {
  const online = stats?.online == null ? '—' : String(stats.online);
  const mine = stats && (desk?.miner || me) ? stats.reviewers.find((r) => r.miner === shortOf(desk?.miner || me)) : null;
  const record = mine && (mine.checks || mine.scouted) ? [mine.checks ? `${mine.right} of ${mine.checks} checks right` : '', mine.scouted ? `${mine.found} of ${mine.scouted} planted bugs found` : ''].filter(Boolean).join(' · ') : null;
  if (!proverUp) return { state: 'Needs tacit-prover, above', button: null, cmd: false, note: '', record, online };
  if (!desk) return { state: 'Update tacit-prover to turn this on', button: null, cmd: false, note: '', record, online };
  if (!desk.installed) {
    // an older prover cannot fetch the model: the line to paste does
    if (!desk.canFetch) return { state: 'Get the model first', button: null, cmd: true, note: '', record, online };
    const here = desk.total ? `${gb(Math.min(desk.fetched, desk.total))} of ${gb(desk.total)} GB` : '';
    if (desk.fetching) return { state: here ? `Getting the model · ${here}` : 'Getting the model…', button: 'Stop', cmd: false, note: '', record, online };
    if (!desk.miner) return { state: 'Start proving with your address first', button: null, cmd: false, note: '', record, online };
    // a try that stopped says why, and can be tried again (it carries on from what it has); the line to paste is still there for a computer it cannot work on
    if (desk.fetchError) return { state: 'Could not get the model', button: 'Try again', cmd: true, note: desk.fetchError, record, online };
    // a fetch that was stopped keeps what it had, and the next one carries on from there
    if (here && desk.fetched >= 5e7) return { state: `Off · ${here} of the model is here`, button: 'Turn on', cmd: false, note: '', record, online };
    return { state: `Off · turning it on gets ${desk.total ? `a ${gb(desk.total)} GB model` : 'the model'}, once`, button: 'Turn on', cmd: false, note: '', record, online };
  }
  if (!desk.on) return { state: desk.miner ? 'Off' : 'Start proving with your address first', button: desk.miner ? 'Turn on' : null, cmd: false, note: '', record, online };
  const answered = desk.served ? ` · ${desk.served} answered` : '';
  const state = desk.busy ? `Reviewing${answered}` : desk.running ? `Ready${answered}` : `On · when this computer is idle and plugged in${answered}`;
  return { state, button: 'Turn off', cmd: false, note: '', record, online };
}
