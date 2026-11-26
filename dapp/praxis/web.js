// The "contribute in this browser" path: the work is done by ceremony-phase2/browser (copied to ./browser/), here are only its
// entry point and the wasm/worker plumbing the page needs.
import { runContribution } from '/praxis/browser/flow.js?cb=56b42e6f';

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

const spawnBeat = () => {
  const w = new Worker('/praxis/browser/beat.js?cb=ed35fc17', { type: 'module' });
  return { post: (m) => w.postMessage(m), onmessage: (f) => { w.onmessage = (e) => f(e.data); }, terminate: () => w.terminate() };
};

export function contributeHere({ name, handle, onStatus, signal }) {
  return runContribution({ api: WINDOW, name, handle, spawn, spawnBeat, workers: cores(), onStatus, signal });
}

// What to tell a person for each phase, in plain words. The time left comes from how fast the work has gone so far.
let workT0 = 0;
export const resetClock = () => { workT0 = 0; };
// the share of the file made so far: a point is 32 bytes of it (the total is only known as the file is read, so it is not the measure)
const done = (s) => Math.min(1, ((s.points || 0) * 32) / (s.size || 1));
export const fraction = (s) => (s.phase === 'work' && s.size ? done(s) : s.phase === 'check' || s.phase === 'done' ? 1 : 0);
const left = (f) => {
  if (!workT0 || f < 0.03) return '';
  const min = Math.max(1, Math.round(((Date.now() - workT0) / f) * (1 - f) / 60000));
  return ` About ${min} min left.`;
};
export function statusText(s) {
  switch (s.phase) {
    case 'queue': return s.ahead > 0 ? `You are in line, ${s.ahead} ahead of you. Keep this tab open: your turn starts by itself.` : 'You are next. Keep this tab open: your turn starts by itself.';
    case 'prepare': return 'Your turn. Starting up…';
    case 'work': {
      if (!s.size || !s.downloaded) return 'Starting…';
      if (!workT0) workT0 = Date.now();
      const f = done(s);
      return `Making your contribution: ${Math.floor(100 * f)}%.${left(f)} Keep this tab open.`;
    }
    case 'check': return 'Sent. The coordinator is checking it, this takes a minute or two…';
    case 'done': return 'Accepted. You are in the chain.';
    default: return '';
  }
}
// which of the four steps is current: in line, making it, checking, done
export const stepOf = (phase) => ['queue', 'work', 'check', 'done'].indexOf(phase === 'prepare' ? 'work' : phase);
