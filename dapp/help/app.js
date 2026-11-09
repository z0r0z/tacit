import { mountHelp } from '/help/ui.js?cb=7603d020';

// The help desk is a service of its own (the community's machines answer, a gateway queues the questions); the page only asks it.
const HELP_API = 'https://tacit-helpdesk.onrender.com';

async function ask(question) {
  let r;
  try {
    r = await fetch(`${HELP_API}/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: question }), credentials: 'omit', signal: AbortSignal.timeout(45000) });
  } catch (e) {
    throw new Error(e?.name === 'TimeoutError' ? 'No answer yet. Try again in a minute.' : 'The help desk could not be reached.');
  }
  let j = null;
  try { j = await r.json(); } catch { /* an error page or an empty body */ }
  if (!r.ok) throw new Error(typeof j?.error === 'string' && j.error ? j.error : 'The help desk is busy. Try again soon.');
  return j;
}

async function health() {
  const r = await fetch(`${HELP_API}/health`, { credentials: 'omit', signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('health');
  return r.json();
}

mountHelp({ root: document.querySelector('main'), ask, health });

// framed by the help panel, which cannot see a key pressed in here: Escape asks it to close
if (window.top !== window.self) addEventListener('keydown', (e) => { if (e.key === 'Escape') parent.postMessage('tacit-help-close', location.origin); });
