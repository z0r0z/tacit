// The "contribute in this browser" path: the work is done by ceremony-phase2/browser (copied to ./browser/), here are only its
// entry point and the wasm/worker plumbing the page needs.
import { runContribution } from '/praxis/browser/flow.js?cb=f08920b6';

export const WINDOW = 'https://tacit-praxis-ceremony.onrender.com/api/c';

// What this browser needs: workers, wasm, and a streaming download. Cores only change how long it takes.
export function capable() {
  return typeof Worker === 'function' && typeof WebAssembly === 'object' && typeof ReadableStream === 'function' && typeof Response === 'function' && !!globalThis.crypto?.getRandomValues;
}
export const cores = () => Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

const spawn = () => {
  const w = new Worker('/praxis/browser/worker.js?cb=e004f754', { type: 'module' });
  return { post: (m, t) => w.postMessage(m, t), onmessage: (f) => { w.onmessage = (e) => f(e.data); }, onerror: (f) => { w.onerror = (e) => f(new Error(e.message || 'the worker failed')); }, terminate: () => w.terminate() };
};

export function contributeHere({ name, handle, onStatus, signal }) {
  return runContribution({ api: WINDOW, name, handle, spawn, workers: cores(), onStatus, signal });
}

// A line for each phase of a run, from the status the flow reports.
export function statusText(s) {
  const mb = (n) => `${Math.round((n || 0) / 1048576).toLocaleString('en-US')} MB`;
  switch (s.phase) {
    case 'queue': return s.ahead > 0 ? `In the queue, ${s.ahead} ahead. Keep this tab open.` : 'Your turn is next. Keep this tab open.';
    case 'prepare': return 'Your turn. Getting ready…';
    case 'work': {
      if (!s.total) return 'Starting…';
      return `Making your contribution: ${Math.floor((100 * s.points) / s.total)}% · ${mb(s.downloaded)} of ${mb(s.size)} read · ${mb(s.sent)} sent`;
    }
    case 'check': return 'Sent. The coordinator is checking it…';
    case 'done': return 'Accepted.';
    default: return '';
  }
}
export const fraction = (s) => (s.phase === 'work' && s.total ? s.points / s.total : s.phase === 'check' || s.phase === 'done' ? 1 : 0);
