// What /prove/ shows, from the computer's own tacit-prover (GET /health and GET /mine on 127.0.0.1) and nothing else: no wallet,
// no network. app.js reads and paints; this only turns the answers into words, so a jsdom-free test can check every state.

// The local prover's state: 'none' (nothing answers), 'old' (a tacit-prover from before GET /mine, which the setup line updates),
// 'paused', 'waiting' (on, nothing leased yet) or 'proving' (a pool job under way).
export function localState(health, mine) {
  if (!health?.ok) return 'none';
  if (!mine || typeof mine.on !== 'boolean') return 'old';
  if (!mine.on) return mine.job ? 'proving' : 'paused';
  return mine.job ? 'proving' : 'waiting';
}

const STAGE = { core: 'Proving', shrink: 'Compressing', wrap: 'Wrapping', groth16: 'Sealing' };

const mins = (s) => (s < 90 ? 'about a minute' : `about ${Math.round(s / 60)} min`);

// A pool job as a bar: how far along (0 to 1, null before this computer has timed a whole proof), the stage's name and the time left.
export function jobView(job) {
  if (!job) return null;
  const secs = Number(job.secs) || 0, eta = job.eta == null ? null : Number(job.eta);
  const pct = eta == null ? null : Math.min(0.99, secs / Math.max(1, secs + eta));
  return {
    pct,
    step: Math.max(0, Object.keys(STAGE).indexOf(job.stage)),
    stage: STAGE[job.stage] || 'Proving',
    left: eta == null ? `${Math.floor(secs / 60)} min in` : `${mins(eta)} left`,
  };
}

// The headline and the button for a state; `paused` with a job still running finishes that one proof first.
export function headline(state, mine) {
  switch (state) {
    case 'none': return { title: 'Not set up on this computer', button: null };
    case 'old': return { title: 'Update tacit-prover to start from here', button: null };
    case 'paused': return { title: 'Paused', button: 'Start proving' };
    case 'waiting': return { title: 'Waiting for the next proof', button: 'Pause' };
    case 'proving': return { title: mine?.on ? 'Proving' : 'Pausing after this proof', button: mine?.on ? 'Pause' : 'Start proving' };
    default: return { title: '', button: null };
  }
}

// Proving needs a computer: a phone or tablet is told so instead of being shown a Terminal line.
export const isPhone = (ua = '') => /\b(iPhone|iPad|iPod|Android|Mobile)\b/.test(ua);
