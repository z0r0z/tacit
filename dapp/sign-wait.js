// What a sign-in sheet says while it waits for a wallet, and the way out of it: the step it is on, a Cancel link, a plainer line after 10 seconds
// and a last one after 25. A wallet that has lost its link to the page (an extension that was put to sleep) shows nothing and answers nothing, and
// all a page can do is say so and let the person start again. The front page's own sheet (index.html wireSignIn) says the same words.

export const SAY = { account: 'Reading your wallet…', connect: 'Connect in your wallet.', sign: 'Sign the message in your wallet.', confirm: 'Sign once more to confirm.' };
export const STILL = 'Still waiting. Open your wallet to answer.';
export const LOST = 'Nothing in your wallet? Cancel, then press again. If it keeps happening, reload this page.';
export const STILL_MS = 10e3, LOST_MS = 25e3;

// the words for a step the sign-in reports ({ of: 2 } on a first sign-in, which asks twice)
export const stepWords = (x, info) => (SAY[x] ? `${SAY[x]}${info?.of === 2 ? ` Step ${x === 'confirm' ? 2 : 1} of 2.` : ''}` : null);

// `say(text)` shows a line. text(t) shows one and starts the clock again; step(x, info) shows a step's words; stop() ends it.
export function waitSay(say, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let first = null, second = null, over = false;
  const clear = () => { clearTimer(first); clearTimer(second); };
  const text = (t) => {
    if (over) return;
    clear();
    say(t);
    first = setTimer(() => { say(STILL); second = setTimer(() => say(LOST), LOST_MS - STILL_MS); }, STILL_MS);
  };
  return { text, step: (x, info) => { const w = stepWords(x, info); if (w) text(w); }, stop: () => { over = true; clear(); } };
}

// The line in a sheet: a <p> holding the words and a Cancel link that calls `cancel`. → { text, step, stop, el }
export function waitLine(el, { first = 'Waiting for your wallet…', cancel }) {
  const words = document.createElement('span'), link = document.createElement('button');
  link.type = 'button'; link.className = 'link'; link.textContent = 'Cancel'; link.onclick = () => cancel?.();
  el.replaceChildren(words, ' ', link);
  const w = waitSay((t) => { words.textContent = t; });
  w.text(first);
  return { ...w, el };
}

// A cancel that is real: `run(signal)` is the sign-in; resolves with it, or rejects as soon as `cancel()` is called (the sign-in itself goes on
// in the wallet, and what it does after that is stopped by `signal`).
export function cancellable(run) {
  const ac = new AbortController();
  const stopped = new Promise((_, no) => { ac.signal.addEventListener('abort', () => no(Object.assign(new Error('Cancelled in your wallet.'), { code: 4001, unlockCancelled: true })), { once: true }); });
  stopped.catch(() => {});
  return { signal: ac.signal, cancel: () => ac.abort(), done: Promise.race([run(ac.signal), stopped]) };
}
